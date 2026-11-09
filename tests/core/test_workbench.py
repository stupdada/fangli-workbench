"""Offline integration: real HTTP + SQLite + unchanged ZIP engine + controlled SDK boundary."""
import base64
import copy
import hashlib
import http.client
import importlib.util
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT))
from app import generator, prompts, render, parsers
from bridge import provider
from bridge.http import create_server
from bridge.native import ClosingConnection
from bridge.errors import Conflict

EVIDENCE = {}


def encoded(value): return json.dumps(value, ensure_ascii=False)


def wire(messages, settings, temperature=None, max_tokens=None, force_json=False, timeout=300):
    value = {'model': settings['model'], 'messages': messages,
        'temperature': settings.get('temperature', .8) if temperature is None else temperature,
        'max_tokens': max_tokens or settings.get('max_tokens', 4000), 'force_json': force_json, 'timeout': timeout}
    return value


class ControlledModel:
    def __init__(self):
        self.requests, self.catalog_calls, self.generated = [], 0, 0
        self.gate_kind, self.gate_index = None, 1
        self.entered, self.release = threading.Event(), threading.Event()
        self.questions = True
        self.fail_kind = None
        self.catalog = [{'id': provider.DEFAULT_MODEL, 'name': 'DS 精确目录ID'}]

    def response(self, payload):
        system, user = payload['messages'][0]['content'], payload['messages'][1]['content']
        if '需求访谈助手' in system:
            request = json.loads(user)
            questions = [{'text': '这次给谁看？', 'recommended': '采购人员', 'reason': '便于安排重点', 'options': ['采购人员', '技术人员']}] if self.questions else []
            return 'interview', {'understanding': '助手防御性说明绝不能进入写作', 'options': {'keywords': request['options'].get('keywords') or ['西邦24'], 'note': request['options'].get('note', '')}, 'questions': questions, 'ready': not questions}
        if '本次只执行完整通读、逐段扫描' in system:
            return 'style_review', {'assessment': '轻微；个别冗余，具体工序写得清楚',
                'suggestions': [{'id': '1', 'tier': 1, 'signal': '正确废话', 'quote': '核查后判断', 'problem': '重复结论',
                    'proposal': '收紧该句', 'scope': '句', 'requires_material': False},
                    {'id': '2', 'tier': 3, 'signal': '结构', 'quote': '步骤', 'problem': '有整齐感', 'proposal': '拆分', 'scope': '段', 'requires_material': False}],
                'observations': [{'id': 'O1', 'quote': '说明', 'reason': '未达密度门槛', 'proposal': '默认保留'}]}
        if '现在执行用户明确选中的建议' in system:
            value = json.loads(user)
            return 'style_rewrite', {'title': value['title'], 'body_md': value['original'] + '\n候选待核事实\n', 'changes': ['收紧选中句'], 'skipped': []}
        if '本次只读事实复核' in system:
            return 'fact', {'status': 'needs_review', 'findings': [{'quote': '候选待核事实', 'why': '资料未含该具体说法'}],
                'summary': '请人工判断', 'revised_body': '此内容绝不能自动写回候选'}
        if '只修改给定的当前正文' in system:
            value = json.loads(user)
            return 'revision', {'title': value['title'], 'body_md': value['current'] + '\n局部修改候选。\n', 'changes': ['只改指定段']}
        if system == prompts.AUDIT_RULES:
            body = user.split('【待核查的文章】\n', 1)[1]
            # build_audit's exact trailing text is deliberately part of the ZIP fixture.
            body = body.split('\n\n【输出】', 1)[0].strip()
            return 'audit', {'findings': [{'quote': '初稿判断', 'why': '用词待调整'}],
                'verdict': 'revised', 'revised_body': body.replace('初稿判断', '核查后判断')}
        self.generated += 1
        n = self.generated
        return 'generate', {'title': f'西邦24使用说明{n}', 'summary': '西邦24的工序说明。',
            'sections': [{'heading': f'步骤{n}', 'paragraphs': ['西邦24用于橡胶与金属粘接。初稿判断。', '施涂按资料条件进行。']},
                {'heading': '资料条件', 'paragraphs': ['原文中的有效条件继续保留。']}],
            'key_facts': ['西邦24：单涂体系', '客户：测试客户', '条件：按产品资料执行'],
            'faq': [{'q': f'西邦24问题{n}？', 'a': '按客户资料安排工序。'}],
            'tags': ['#西邦24', '#胶粘剂', '#橡胶', '#金属', '#工艺'], 'declarations': ['含AI生成内容'],
            'risk_notes': ['1：不编造数值', '2：无导流', '3：保留条件']}

    def events(self, payload):
        if payload.get('operation') == 'models':
            self.catalog_calls += 1
            yield {'type': 'models', 'models': self.catalog}
            return
        self.requests.append(copy.deepcopy(payload))
        kind, value = self.response(payload)
        if self.gate_kind == kind and (kind != 'generate' or self.generated == self.gate_index):
            self.entered.set()
            if not self.release.wait(8): raise AssertionError('fixture gate was not released')
        if self.fail_kind == kind: raise provider.failure('uncertain')
        text = encoded(value)
        for i in range(0, len(text), 50): yield {'type': 'delta', 'text': text[i:i+50]}
        yield {'type': 'usage', 'usage': {'total_tokens': 10}}
        yield {'type': 'done', 'finish_reason': 'stop'}


class WorkbenchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fangli-core-')
        self.model = ControlledModel()
        self.provider_patch = patch.object(provider, 'events', self.model.events)
        self.provider_patch.start()
        self.server = create_server(Path(self.temp.name) / '工作台.db', port=0)
        self.service = self.server.service
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.model.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.provider_patch.stop()
        self.temp.cleanup()  # Must actually delete SQLite on Windows; no gc.collect workaround.

    def request(self, path, method='GET', body=None, status=200, headers=None, raw=False):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        encoded_body = encoded(body).encode('utf-8') if body is not None else None
        connection.request(method, path, body=encoded_body, headers={'Content-Type': 'application/json', **(headers or {})})
        response = connection.getresponse()
        data = response.read()
        connection.close()
        self.assertEqual(response.status, status, data.decode('utf-8', 'replace')[:800])
        return data if raw else json.loads(data)

    def setup_task(self, count=1):
        client = self.request('/api/workbench/clients', 'POST', {'name': '中文测试客户', 'profile': {'brand': '西邦', 'company': '测试公司', 'products': '西邦24'}})['client']
        document = self.request('/api/workbench/clients/' + client['id'] + '/documents', 'POST', {'filename': '中文资料.md', 'text': '西邦24用于橡胶与金属粘接。\n\n单涂体系，按产品资料安排施涂。', 'kind': 'Markdown'})['document']
        conv = self.request('/api/workbench/conversations', 'POST', {'client_id': client['id']})['conversation']
        pid = self.service.store.list_platforms()[0]['id']
        self.path = '/api/workbench/conversations/' + conv['id']
        options = {**conv['brief'], 'keywords': ['西邦24'], 'selections': [{'platform_id': pid, 'account_type': 'personal', 'count': count}], 'note': '以产品资料为准，保留工序条件。'}
        self.request(self.path + '/draft', 'PUT', {'options': options, 'document_ids': [document['id']], 'mode': 'chat'})
        return client, document, conv, options

    def finished(self, result):
        key = result.get('job_id') or result['operation_id']
        thread = self.service.threads.get(key)
        if thread: thread.join(8)
        self.assertFalse(thread and thread.is_alive(), 'operation did not finish')
        operation = self.request('/api/workbench/operations/' + result['operation_id'])['operation']
        return operation

    def write_task(self, count=1):
        client, doc, conv, options = self.setup_task(count)
        started = self.request(self.path + '/start', 'POST', {})
        self.assertEqual(self.finished(started)['status'], 'done')
        return client, doc, conv, options, self.request(self.path)['articles']

    def test_empty_seed_shared_draft_parse_and_boundaries(self):
        boot = self.request('/api/workbench/bootstrap')
        self.assertEqual(boot['clients'], [])
        self.assertEqual(boot['conversations'], [])
        self.assertEqual(self.service.store.list_plans(), [])
        self.assertTrue(boot['platforms'] and boot['target_models'])
        self.assertEqual(boot['settings']['model'], provider.DEFAULT_MODEL)
        self.assertEqual(self.model.catalog_calls, 0)
        client, doc, conv, options = self.setup_task()
        before = len(self.model.requests)
        changed = self.request(self.path + '/draft', 'PUT', {'mode': 'zip'})['conversation']
        self.assertEqual(changed['id'], conv['id'])
        self.assertEqual(changed['brief'], options)
        self.assertEqual(changed['document_ids'], [doc['id']])
        self.assertEqual(len(self.model.requests), before)
        self.assertEqual(self.model.catalog_calls, 0)
        for path in ('/', '/workbench', '/workbench/zip'):
            self.assertIn(b'<!', self.request(path, raw=True)[:80])
        for path in ('/config/workbuddy.json', '/bridge/service.py', '/data/workbench.db', '/vendor/workbuddy-sdk.js'):
            self.request(path, status=404)
        self.request('/%2e%2e/config/workbuddy.json', status=403)
        self.request('/api/workbench/bootstrap', status=403, headers={'Origin': 'https://foreign.invalid'})
        self.request('/api/workbench/bootstrap', status=403, headers={'Host': 'foreign.invalid'})
        self.request('/api/plans', 'POST', {}, status=403)
        self.request('/api/articles/1', 'PUT', {}, status=403)
        self.request('/api/materials/bulk', 'POST', {}, status=403)
        self.request('/api/workbench/settings', 'POST', {'api_key': 'not-for-http'}, status=400)
        self.assertNotIn('publishableKey', encoded(boot))
        self.assertNotIn('api_key', encoded(boot))
        original_docx = ROOT / '导出示例_方案19.docx'
        sample = original_docx.read_bytes()
        expected = parsers.parse_file('资料.docx', sample)
        actual = self.request('/api/parse', 'POST', {'filename': '资料.docx', 'content_b64': base64.b64encode(sample).decode()})
        self.assertEqual(actual['text'], expected['text'])
        self.request('/api/parse', 'POST', {'filename': '资料.pdf', 'content_b64': base64.b64encode(b'%PDF').decode()}, status=400)
        other = self.request('/api/workbench/clients', 'POST', {'name': '另一客户'})['client']
        self.request(self.path + '/draft', 'PUT', {'document_ids': ['no-such-document']}, status=400)
        self.assertEqual(self.request('/api/workbench/clients/' + other['id'] + '/documents')['documents'], [])
        with self.assertRaises(Conflict): create_server(self.service.store.db_path, port=0)
        EVIDENCE['http_boundaries'] = {'passed': True, 'utf8_readback': True, 'private_files_blocked': True, 'original_parse': 'docx text exact', 'boot_network_calls': 0}

    def test_zip_request_and_export_replay_equivalence(self):
        _, doc, conv, _ = self.setup_task(2)
        brief = self.service.build_brief(self.service.ws.conversation(conv['id']))
        archive = ROOT.parent / 'GEO内容工作台-源码交接包_20261104.zip'
        with zipfile.ZipFile(archive) as z:
            names = [n for n in z.namelist() if n.replace('\\', '/').endswith('/app/generator.py') or n == 'app/generator.py']
            self.assertEqual(len(names), 1)
            prefix = names[0].rsplit('app/generator.py', 1)[0]
            package = Path(self.temp.name) / 'baseline/zipcore'
            package.mkdir(parents=True)
            hashes = {}
            for name in z.namelist():
                rel = name[len(prefix):] if name.startswith(prefix) else ''
                if rel.startswith('app/') and rel.endswith('.py'):
                    raw = z.read(name)
                    filename = rel.removeprefix('app/')
                    (package / filename).write_bytes(raw)
                    hashes[filename] = hashlib.sha256(raw).hexdigest()
                    self.assertEqual((ROOT / rel).read_bytes(), raw)
        manifest = json.loads((ROOT / 'tests/zip-core.sha256.json').read_text(encoding='utf-8'))
        self.assertEqual(hashes, manifest)
        spec = importlib.util.spec_from_file_location('zipcore', package / '__init__.py', submodule_search_locations=[str(package)])
        module = importlib.util.module_from_spec(spec); sys.modules['zipcore'] = module; spec.loader.exec_module(module)
        import zipcore.generator as native
        import zipcore.store as native_store
        import zipcore.render as native_render
        import sqlite3
        class BaselineStore(native_store.Store):
            def conn(self):
                conn = sqlite3.connect(self.db_path, factory=ClosingConnection)
                conn.row_factory = sqlite3.Row
                conn.execute('PRAGMA journal_mode=WAL')
                return conn
        baseline_store = BaselineStore(Path(self.temp.name) / 'baseline.sqlite')
        baseline_store.save_settings({'model': provider.DEFAULT_MODEL})
        pid = baseline_store.create_plan(brief['keyword'], '中文测试客户 · ' + brief['keyword'], brief)
        baseline_store.replace_materials(pid, [doc])
        native_brief = {**brief, 'snapshot': self.service.zip_snapshot(brief)}
        baseline_store.update_plan(pid, brief=native_brief)
        native_model, native_requests = ControlledModel(), []
        def native_chat(messages, settings, temperature=None, max_tokens=None, force_json=False, timeout=300, **kwargs):
            payload = wire(messages, settings, temperature, max_tokens, force_json, timeout)
            native_requests.append(payload)
            _, value = native_model.response(payload)
            return encoded(value)
        def native_stream(*args, **kwargs): yield native_chat(*args, **kwargs)
        native.llm.chat_with_retry, native.llm.stream_with_retry = native_chat, native_stream
        native.run_auto(baseline_store, pid, copy.deepcopy(brief), native.new_job(pid, 2, kind='auto'))
        started = self.request(self.path + '/start', 'POST', {})
        self.assertEqual(self.finished(started)['status'], 'done')
        articles = self.request(self.path)['articles']
        baseline = baseline_store.list_articles(pid)
        self.assertEqual(len(articles), 2)
        self.assertEqual(native_requests, self.model.requests)
        for expected, actual in zip(baseline, articles):
            for key in ('body_md', 'body_original', 'title', 'tags', 'decl', 'risk_tips', 'geo', 'keywords', 'angle', 'fmt', 'account_type'):
                self.assertEqual(expected[key], actual[key], key)
            self.assertNotIn('【输出】', actual['body_md'])
            self.assertIn('核查后判断', actual['body_md'])
            self.assertIn('初稿判断', actual['body_original'])
        native_plan = native_render.ensure_plan_prefix(baseline_store.get_plan(pid))
        xml = lambda data: zipfile.ZipFile(io.BytesIO(data)).read('word/document.xml')
        actual_docx = self.request(self.path + '/export?fmt=docx', raw=True)
        self.assertEqual(xml(actual_docx), xml(native_render.export_plan_docx(native_plan)))
        actual_json = json.loads(self.request(self.path + '/export?fmt=json', raw=True))
        self.assertEqual(actual_json, json.loads(native_render.export_plan_json(native_plan)))
        self.assertEqual(self.request(self.path + '/export?fmt=md', raw=True).decode('utf-8'), native_render.export_plan_md(native_plan))
        self.assertEqual(self.request(self.path + '/export?fmt=txt', raw=True).decode('utf-8'), native_render.export_plan_txt(native_plan))
        self.assertEqual(len(self.service.ws.versions(articles[0]['id'])), 2)
        request_hashes = [hashlib.sha256(encoded(r).encode()).hexdigest() for r in native_requests]
        EVIDENCE['zip_replay'] = {'core_files': len(hashes), 'sha256_exact': True, 'requests_equal': len(native_requests),
            'generation_and_audit_messages_equal': True, 'native_final_and_original_bodies_equal': True, 'docx_document_xml_equal': True,
            'md_txt_json_full_export_equal': True,
            'request_sha256': hashlib.sha256(encoded(native_requests).encode()).hexdigest(), 'per_request_sha256': request_hashes,
            'final_body_sha256': [hashlib.sha256(a['body_md'].encode()).hexdigest() for a in articles]}

    def test_processing_locks_completed_edits_frozen_following_reference(self):
        self.setup_task(2)
        self.model.gate_kind, self.model.gate_index = 'generate', 2
        started = self.request(self.path + '/start', 'POST', {})
        self.assertTrue(self.model.entered.wait(5))
        first = self.request(self.path)['articles'][0]
        aid, original = first['id'], first['body_md']
        self.request(self.path + '/start', 'POST', {}, status=409)
        manual = self.request(self.path + f'/articles/{aid}', 'PUT', {'expected_version': first['current_version'],
            'body_md': '# 人工标题污染\n\n### 人工FAQ污染\n正文人工编辑。', 'title': '人工标题污染'})['article']
        self.assertEqual(manual['origin'], 'manual')
        self.assertEqual(manual['audit'], {})
        self.assertEqual(manual['review']['status'], 'unverified')
        self.request('/api/workbench/settings', 'POST', {'temperature': .3, 'max_tokens': 2000, 'title_prefix': False})
        platform = self.service.store.list_platforms()[0]
        self.service.store.update_platform(platform['id'], style='在途不得读取的新配置')
        self.model.release.set()
        self.assertEqual(self.finished(started)['status'], 'done')
        generated = [r for r in self.model.requests if r['messages'][0]['content'] != prompts.AUDIT_RULES]
        self.assertEqual(len(generated), 2)
        for request in generated:
            self.assertEqual(request['temperature'], .8)
            self.assertEqual(request['max_tokens'], 4000)
            self.assertNotIn('在途不得读取的新配置', encoded(request))
            self.assertNotIn('人工标题污染', encoded(request))
            self.assertNotIn('人工FAQ污染', encoded(request))
        self.assertIn(first['title'], generated[1]['messages'][1]['content'])
        self.assertEqual(self.service.store.get_article(aid)['body_md'], original)
        # Block an actual saved article in its native audit phase, then test all mutation gates.
        self.model.gate_kind = 'audit'; self.model.entered.clear(); self.model.release.clear()
        self.request(self.path + '/draft', 'PUT', {'options': {'selections': [{'platform_id': platform['id'], 'account_type': 'personal', 'count': 3}]}})
        more = self.request(self.path + '/start', 'POST', {})
        self.assertTrue(self.model.entered.wait(5))
        active = self.request(self.path)['articles'][-1]
        self.assertTrue(active['locked'])
        active_path = self.path + '/articles/' + str(active['id'])
        self.request(active_path, 'PUT', {'expected_version': 1, 'body_md': '不能改'}, status=409)
        self.request(active_path + '/select-version', 'POST', {'expected_version': 1, 'version_id': 1}, status=409)
        self.request(active_path + '/style-review', 'POST', {'expected_version': 1}, status=409)
        self.model.release.set(); self.finished(more)
        EVIDENCE['locks_and_frozen_reference'] = {'completed_edit_allowed': True, 'processing_mutations_409': True,
            'duplicate_start_409': True, 'following_title_faq_unpolluted': True, 'inflight_config_frozen': True}

    def test_task_title_is_stable_in_chat_and_uses_topic_at_start(self):
        customer, _, task, _ = self.setup_task()
        for message in ('写给第一次使用的读者', '加入施工前的准备步骤'):
            self.finished(self.request(self.path + '/chat', 'POST', {'text': message, 'followup': False}))
            self.assertEqual(self.request(self.path)['conversation']['title'], task['title'])

        topic = '施工前要检查哪些条件'
        started = self.request(self.path + '/start', 'POST', {'options': {'topic': topic}})
        self.assertEqual(started['title'], customer['name'] + ' · ' + topic)
        self.finished(started)
        self.assertEqual(self.request(self.path)['conversation']['title'], started['title'])

    def test_interview_toggle_rounds_and_new_requirements_pause(self):
        _, doc, conv, options = self.setup_task(3)
        for index in range(5):
            result = self.request(self.path + '/chat', 'POST', {'text': '明确输入第' + str(index) + '轮', 'followup': True, 'document_ids': [doc['id']]})
            self.assertTrue(self.finished(result)['result']['questions'])
        result = self.request(self.path + '/chat', 'POST', {'text': '按当前可见配置开始', 'followup': False})
        self.assertEqual(self.finished(result)['result']['questions'], [])
        self.assertFalse(self.request(self.path)['conversation']['followup'])
        self.model.gate_kind = 'audit'; self.model.entered.clear(); self.model.release.clear()
        started = self.request(self.path + '/start', 'POST', {})
        self.assertTrue(self.model.entered.wait(5))
        before = self.model.generated
        sse_result, sse_live = [], threading.Event()
        def consume():
            connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=8)
            connection.request('GET', '/api/jobs/' + started['job_id'] + '/stream')
            response = connection.getresponse()
            while True:
                line = response.readline()
                if not line: break
                if line.startswith(b'data: '):
                    event = json.loads(line[6:])
                    sse_result.append(event)
                    if event['type'] == 'status' and event.get('phase') == 'audit': sse_live.set()
            connection.close()
        consumer = threading.Thread(target=consume, daemon=True); consumer.start()
        self.assertTrue(sse_live.wait(3), 'SSE must deliver before the gated native audit completes')
        changed = self.request(self.path + '/draft', 'PUT', {'options': {'note': '新增明确要求：关注工序顺序。'}, 'mode': 'zip'})['conversation']
        self.assertTrue(changed['needs_confirmation'])
        self.request(self.path + '/start', 'POST', {}, status=409)
        self.model.release.set()
        self.assertEqual(self.finished(started)['status'], 'stopped')
        consumer.join(3)
        self.assertFalse(consumer.is_alive())
        self.assertEqual({e['type'] for e in sse_result}, {'next', 'chunk', 'status', 'end'})
        self.assertEqual(sse_result[-1]['status'], 'paused')
        self.assertEqual(self.model.generated, before)
        self.assertEqual(len(self.request(self.path)['articles']), 1)
        # /start is the explicit continuation decision, using the saved changed draft.
        self.model.gate_kind = None
        resumed = self.request(self.path + '/start', 'POST', {})
        self.assertEqual(self.finished(resumed)['status'], 'done')
        self.assertEqual(len(self.request(self.path)['articles']), 3)
        generation = [r for r in self.model.requests if r['messages'][0]['content'].startswith('你是一名 GEO')]
        self.assertIn('新增明确要求：关注工序顺序。', generation[-1]['messages'][1]['content'])
        self.assertNotIn('助手防御性说明', encoded(generation))
        EVIDENCE['interview_pause_resume'] = {'rounds': 6, 'disabled_questions_empty': True, 'new_input_saved': True,
            'current_article_finished': True, 'following_paused_until_start': True, 'assistant_text_not_in_zip': True,
            'native_sse_live_types': sorted({e['type'] for e in sse_result})}

    def test_failed_fact_check_retains_candidate_and_native_delivery(self):
        _, _, _, _, articles = self.write_task()
        a = articles[0]; path = self.path + '/articles/' + str(a['id'])
        review = self.finished(self.request(path + '/style-review', 'POST', {'expected_version': a['current_version']}))
        self.model.fail_kind = 'fact'
        result = self.finished(self.request(path + '/style-rewrite', 'POST', {'expected_version': a['current_version'],
            'review_id': review['id'], 'selected': ['1'], 'mode': 'full'}))
        self.assertEqual(result['status'], 'done')
        self.assertEqual(result['result']['fact_check']['status'], 'unverified')
        self.assertEqual(result['result']['fact_check']['attempts'], 1)
        self.assertTrue(self.service.ws.version(a['id'], result['result']['candidate_version']))
        self.assertEqual(self.request(self.path)['articles'][0]['current_version'], a['current_version'])
        self.assertIn(a['body_md'], self.request(self.path + '/export?fmt=md', raw=True).decode())
        self.assertEqual(len([r for r in self.model.requests if '本次只读事实复核' in r['messages'][0]['content']]), 1)
        EVIDENCE['fact_failure'] = {'candidate_retained': True, 'native_export_available': True, 'attempts': 1, 'automatic_retries': 0}

    def test_fact_repair_only_changes_selected_sentence_until_adopted(self):
        original_response = self.model.response
        quote, second = '初稿判断', '原文中的有效条件继续保留。'
        fixed = '依据资料限定适用范围'

        def response(payload):
            if '仅修正所选事实问题的原句' in payload['messages'][0]['content']:
                request = json.loads(payload['messages'][1]['content'])
                self.assertEqual([item['quote'] for item in request['issues']], [quote])
                self.assertIn('橡胶与金属粘接', request['documents'][0]['text'])
                return 'repair', {'replacements': [{'id': 1, 'text': fixed}]}
            if '本次只读事实复核' in payload['messages'][0]['content']:
                self.assertEqual(json.loads(payload['messages'][1]['content'])['body'], fixed)
                return 'fact', {'status': 'pass', 'summary': '已检查修订句', 'findings': []}
            kind, value = original_response(payload)
            if kind == 'audit':
                return kind, {'findings': [{'quote': quote, 'why': '应补条件'}, {'quote': second, 'why': '应核对来源'}]}
            return kind, value

        self.model.response = response
        _, _, _, _, articles = self.write_task()
        article = articles[0]
        base = article['current_version']
        path = self.path + '/articles/' + str(article['id'])
        editorial = self.request(path + f'/editorial?version_id={base}')
        self.assertEqual([i['id'] for i in editorial['fact_issues'] if i['repairable']], [1, 2])
        self.request(path + '/repair-facts', 'POST', {'expected_version': base, 'selected': [5]}, status=400)
        operation = self.finished(self.request(path + '/repair-facts', 'POST', {'expected_version': base, 'selected': [1]}))
        self.assertEqual(operation['status'], 'done', operation)
        vid = operation['result']['candidate_version']
        self.assertEqual(self.request(self.path)['articles'][0]['current_version'], base)
        comparison = self.request(path + f'/compare?candidate_version={vid}')
        self.assertEqual(comparison['candidate']['article']['body_md'], article['body_md'].replace(quote, fixed, 1))
        self.request(path + '/select-version', 'POST', {'expected_version': base, 'version_id': vid})
        adopted = self.request(path + f'/editorial?version_id={vid}')
        self.assertEqual(adopted['fact_scope'], 'repaired_sentences')
        self.assertEqual([issue['quote'] for issue in adopted['fact_issues']], [second])
        self.assertEqual(adopted['fact_repairs'][0]['revised'], fixed)
        self.assertEqual(self.request(path + f'/editorial?version_id={base}')['fact_issues'], editorial['fact_issues'])
        self.request(path + '/repair-facts', 'POST', {'expected_version': base, 'selected': [1]}, status=409)

    def test_style_candidate_readonly_check_notes_export_and_video_pin(self):
        client, _, _, _, articles = self.write_task()
        a = articles[0]; aid = a['id']; path = self.path + f'/articles/{aid}'
        reviewed = self.request(path + '/style-review', 'POST', {'expected_version': a['current_version']})
        review = self.finished(reviewed)
        self.assertEqual(review['status'], 'done')
        self.assertEqual(review['result']['recommended'], ['1'])
        rewritten = self.request(path + '/style-rewrite', 'POST', {'expected_version': a['current_version'],
            'review_id': review['id'], 'selected': ['1']})
        rewrite = self.finished(rewritten)
        self.assertEqual(rewrite['status'], 'done')
        self.assertEqual(rewrite['result']['fact_check']['attempts'], 1)
        vid = rewrite['result']['candidate_version']
        self.assertEqual(self.request(self.path)['articles'][0]['current_version'], a['current_version'])
        candidate = self.service.ws.version(aid, vid)
        self.assertIn('候选待核事实', candidate['article']['body_md'])
        self.assertNotIn('此内容绝不能自动写回', candidate['article']['body_md'])
        self.assertEqual(candidate['review']['status'], 'needs_review')
        fact_requests = [r for r in self.model.requests if '本次只读事实复核' in r['messages'][0]['content']]
        self.assertEqual(len(fact_requests), 1)
        self.assertIn(a['body_md'], self.request(self.path + '/export?fmt=md', raw=True).decode('utf-8'))
        context = f'/api/workbench/video-context?client_id={client["id"]}&article_id={aid}&version_id='
        self.request(context + str(vid), status=409)
        self.request(path + '/review-record', 'PUT', {'candidate_version': vid, 'codex_review': '真实Codex评语：该句需资料支持。', 'user_review': '用户意见：暂留候选。'})
        comparison = self.request(path + '/compare?candidate_version=' + str(vid))
        self.assertIn('真实Codex评语', comparison['review_records'][0]['codex_review'])
        self.assertIn('候选待核事实', comparison['diff'])
        exported = self.request(path + '/compare?candidate_version=' + str(vid) + '&fmt=md', raw=True).decode('utf-8')
        self.assertIn('用户意见', exported)
        self.assertIn(a['body_md'], exported)
        self.request(path + '/select-version', 'POST', {'expected_version': a['current_version'], 'version_id': vid})
        fixed = self.request(context + str(vid))['article']
        self.request(path, 'PUT', {'expected_version': vid, 'body_md': '# 人工新版\n正文修改。'})
        self.assertEqual(self.request(context + str(vid))['article'], fixed)
        self.request(path + '/select-version', 'POST', {'expected_version': self.service.ws.current(aid)['current_version'], 'version_id': vid}, status=409)
        other = self.request('/api/workbench/clients', 'POST', {'name': '其他客户'})['client']
        self.request(context.replace(client['id'], other['id']) + str(vid), status=404)
        current = self.service.ws.current(aid)
        revised = self.request(path + '/revise', 'POST', {'expected_version': current['current_version'], 'instruction': '仅修改最后一段。'})
        self.assertEqual(self.finished(revised)['status'], 'done')
        self.assertEqual(len([r for r in self.model.requests if '本次只读事实复核' in r['messages'][0]['content']]), 1)
        EVIDENCE['style_versions'] = {'candidate_default_unselected': True, 'one_readonly_check': True, 'no_fact_rewrite': True,
            'codex_and_user_notes_exported': True, 'manual_new_review_unverified': True, 'video_adopted_version_pin': True}

    def test_uncertain_failure_no_repeat_and_restart_recovery(self):
        self.setup_task(3)
        self.model.fail_kind = 'generate'
        started = self.request(self.path + '/start', 'POST', {})
        operation = self.finished(started)
        self.assertEqual(operation['status'], 'interrupted')
        self.assertEqual(len(self.model.requests), 1)
        self.assertEqual(self.model.generated, 1)
        self.model.fail_kind = None
        retry = self.request(self.path + '/start', 'POST', {})
        self.assertEqual(self.finished(retry)['status'], 'done')
        self.assertEqual(len(self.request(self.path)['articles']), 3)
        # Simulate persisted process loss, not a second live service.
        conv = self.service.ws.conversation(self.path.rsplit('/', 1)[-1])
        interrupted = self.service.ws.create_operation('style_review', conv['id'])
        aid = self.service.store.list_articles(conv['plan_id'])[0]['id']
        self.service.ws.lock_article(aid, interrupted)
        self.service.ws.update_conversation(conv['id'], status='running')
        self.service.ws.recover()
        self.assertEqual(self.service.ws.operation(interrupted)['status'], 'interrupted')
        self.assertFalse(self.service.ws.current(aid)['locked'])
        self.assertTrue(self.service.ws.conversation(conv['id'])['needs_confirmation'])
        EVIDENCE['error_recovery'] = {'uncertain_requests': 1, 'following_stopped': True, 'explicit_retry_completed': True,
            'persisted_running_operation_recovered': True, 'locks_released': True, 'sqlite_cleanup_windows': 'required by every tearDown'}


if __name__ == '__main__': unittest.main(verbosity=2)
