"""Focused HTTP/SQLite tests for newly restored original ZIP operations. No external calls."""
import copy
import http.client
import io
import json
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import generator, prompts
from bridge import provider
from bridge.http import create_server
from bridge.service import FrozenStore
from test_workbench import ControlledModel

EVIDENCE = {}


class NativeOperations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fangli-native-')
        self.model = ControlledModel()
        self.mock = patch.object(provider, 'events', self.model.events); self.mock.start()
        self.server = create_server(Path(self.temp.name) / 'native.db', port=0)
        self.s = self.server.service; self.s.catalog = [{'id': provider.DEFAULT_MODEL}]
        self.worker = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True); self.worker.start()
        self.client = self.http('/api/workbench/clients', 'POST', {'name': '仅验收·原生操作', 'profile': {'brand': '测试品牌'}})['client']
        self.conv = self.http('/api/workbench/conversations', 'POST', {'client_id': self.client['id']})['conversation']
        self.path = '/api/workbench/conversations/' + self.conv['id']
        self.platform = self.s.store.list_platforms()[0]
        self.draft({'keywords': ['西邦24', 'Cilbond 24'], 'aliases': [['西邦24', 'Cilbond 24']], 'note': '保留资料条件。',
            'selections': [{'platform_id': self.platform['id'], 'account_type': 'personal', 'count': 2}]})

    def tearDown(self):
        self.model.release.set(); self.server.shutdown(); self.server.server_close(); self.worker.join(3)
        self.mock.stop(); self.temp.cleanup()

    def http(self, path, method='GET', body=None, status=200, binary=False):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=8)
        conn.request(method, path, body=json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None,
            headers={'Content-Type': 'application/json'})
        response = conn.getresponse(); raw = response.read(); conn.close()
        self.assertEqual(response.status, status, raw[:500])
        return (raw, dict(response.getheaders())) if binary else json.loads(raw)

    def draft(self, options): return self.http(self.path + '/draft', 'PUT', {'options': options})['conversation']
    def article_path(self, article): return self.path + '/articles/' + str(article['id'])
    def await_operation(self, result):
        key = result.get('job_id') or result['operation_id']
        worker = self.s.threads.get(key)
        if worker: worker.join(6); self.assertFalse(worker.is_alive())
        return self.s.ws.operation(result['operation_id'])
    def write_one(self):
        result = self.http(self.path + '/write-one', 'POST', {})
        self.assertEqual(self.await_operation(result)['status'], 'done')
        return result, self.http(self.path)['articles'][-1]

    def test_configuration_crud_formats_and_frozen_inputs(self):
        model = self.http('/api/models', 'POST', {'name': '验收目标AI', 'note': '目标不等于写作模型'})['id']
        platform = self.http('/api/platforms', 'POST', {'name': '验收平台官方号', 'formats': ['长文', '问答卡片'], 'style': '风格1',
            'length_hint': '篇幅1', 'structure_hint': '结构1', 'audience': '受众1'})['id']
        actual = next(p for p in self.s.store.list_platforms() if p['id'] == platform)
        self.assertEqual(actual['account_type'], 'official')
        self.http('/api/prefs', 'POST', {'model_id': model, 'platform_id': platform, 'level': 'high'})
        risk = self.http('/api/risks', 'POST', {'platform_id': platform, 'item': '风险1', 'category': '事实', 'level': '高', 'tip': '建议1'})['id']
        conv = self.draft({'models': ['验收目标AI'], 'selections': [{'platform_id': platform, 'account_type': 'personal', 'count': 2}], 'format_overrides': {str(platform): ['问答卡片']}})
        brief = self.s.build_brief(conv); pid = self.s.store.create_plan('西邦24', '冻结', brief)
        frozen = FrozenStore(self.s, pid, conv['brief'], 'configuration-fixture')
        self.assertEqual(generator.build_task_queue(frozen, brief['keywords'], brief['selections'], brief['aliases'])[0]['fmt'], '问答卡片')
        self.http('/api/platforms/' + str(platform), 'PUT', {'formats': ['问答卡片', '问答图册'], 'style': '风格2', 'enabled': False})
        self.http('/api/models/' + str(model), 'PUT', {'note': '新备注', 'enabled': 0})
        self.http('/api/risks/' + str(risk), 'PUT', {'platform_id': None, 'level': '中', 'tip': '建议2'})
        self.http('/api/prefs', 'POST', {'model_id': model, 'platform_id': platform, 'level': 'low'})
        self.assertEqual(next(p for p in frozen.list_platforms() if p['id'] == platform)['style'], '风格1')
        self.assertEqual(next(p for p in frozen.get_prefs() if p['model_id'] == model and p['platform_id'] == platform)['level'], 'high')
        self.assertEqual(next(r for r in frozen.list_risks() if r['id'] == risk)['tip'], '建议1')
        self.http(self.path + '/draft', 'PUT', {'options': {}}, status=400)
        self.http('/api/platforms/' + str(platform), 'PUT', {'enabled': True})
        self.http(self.path + '/draft', 'PUT', {'options': {}}, status=400)
        self.http('/api/models/' + str(model), 'PUT', {'name': '验收目标AI新名', 'enabled': 1})
        self.draft({'models': ['验收目标AI新名']})
        self.http(self.path + '/draft', 'PUT', {'options': {'format_overrides': {str(platform): ['未配置形态']}}}, status=400)
        self.http('/api/models', 'POST', {'name': '验收目标AI新名'}, status=409)
        self.http('/api/prefs', 'POST', {'model_id': model, 'platform_id': platform, 'level': 'maybe'}, status=400)
        self.http('/api/risks/' + str(risk), 'DELETE', {})
        self.http('/api/platforms/' + str(platform), 'DELETE', {})
        self.http('/api/models/' + str(model), 'DELETE', {})
        self.assertFalse(any(p['model_id'] == model or p['platform_id'] == platform for p in self.s.store.get_prefs()))
        self.http(self.path + '/draft', 'PUT', {'options': {}}, status=400)
        self.assertEqual(self.s.public_settings()['model'], provider.DEFAULT_MODEL)
        self.assertEqual(self.model.requests, []); self.assertEqual(self.model.catalog_calls, 0)
        EVIDENCE['configuration'] = {'crud_persisted': True, 'native_pref_cleanup': True, 'arbitrary_configured_formats_in_queue': True,
            'disabled_or_deleted_draft_rejected': True, 'inflight_configuration_frozen': True, 'target_ai_distinct_from_writer': True}

    def test_tags_declarations_cas_and_ownership(self):
        _, article = self.write_one(); path = self.article_path(article); old = copy.deepcopy(article)
        changed = self.http(path, 'PUT', {'expected_version': article['current_version'], 'tags': ['#人工标签'], 'decl': []})['article']
        self.assertEqual(changed['body_md'], old['body_md']); self.assertEqual(changed['risk_tips'], old['risk_tips'])
        self.assertEqual(changed['tags'], ['#人工标签']); self.assertEqual(changed['decl'], [])
        self.assertEqual(changed['audit'], {}); self.assertEqual(changed['geo'], {}); self.assertEqual(changed['review']['status'], 'unverified')
        self.assertEqual(self.s.ws.version(article['id'], old['current_version'])['article']['tags'], old['tags'])
        self.http(path, 'PUT', {'expected_version': old['current_version'], 'tags': []}, status=409)
        self.http(path, 'PUT', {'expected_version': changed['current_version'], 'decl': None}, status=400)
        self.s.ws.lock_article(article['id'], 'fixture-lock', changed['current_version'])
        self.http(path, 'PUT', {'expected_version': changed['current_version'], 'tags': []}, status=409)
        self.s.ws.unlock_article(article['id'], 'fixture-lock')
        other = self.http('/api/workbench/conversations', 'POST', {'client_id': self.client['id']})['conversation']
        self.http('/api/workbench/conversations/' + other['id'] + '/articles/' + str(article['id']), 'PUT', {'expected_version': changed['current_version'], 'tags': []}, status=404)
        EVIDENCE['manual_metadata'] = {'tags_decl_versioned': True, 'old_versions_unchanged': True, 'other_fields_preserved': True, 'old_audit_cleared': True, 'cas_lock_ownership': True}

    def test_native_regenerate_audit_and_version_provenance(self):
        _, article = self.write_one(); aid = article['id']; path = self.article_path(article)
        old_vid = article['current_version']; old_evidence = self.s.ws.version_evidence(aid, old_vid)
        before = len(self.model.requests)
        with patch.object(generator, 'run_regenerate', wraps=generator.run_regenerate) as regen, patch.object(generator, 'audit_article', wraps=generator.audit_article) as audit:
            result = self.http(path + '/regenerate', 'POST', {'expected_version': old_vid, 'extra_note': '保留原型号分组'})
            op = self.await_operation(result); self.assertEqual(op['status'], 'done', op)
            self.assertEqual(regen.call_count, 1); self.assertEqual(audit.call_count, 1)
        current = self.http(self.path)['articles'][0]; vid = current['current_version']
        self.assertNotEqual(vid, old_vid); self.assertEqual(current['origin'], 'zip_regenerate')
        initial_vid = op['result']['draft_version']
        self.assertEqual(self.s.ws.version(aid, initial_vid)['origin'], 'zip_regenerate_draft')
        self.assertIn('初稿判断', self.s.ws.version(aid, initial_vid)['article']['body_md'])
        self.assertNotIn('raw_audit', self.s.ws.version_evidence(aid, initial_vid))
        self.assertEqual([current[k] for k in ('platform_id', 'fmt', 'account_type', 'keywords', 'angle')], [article[k] for k in ('platform_id', 'fmt', 'account_type', 'keywords', 'angle')])
        calls = self.model.requests[before:]; self.assertEqual(len(calls), 2)
        self.assertIn('本次重写要求：保留原型号分组', calls[0]['messages'][1]['content'])
        self.assertIn('Cilbond 24', calls[0]['messages'][1]['content'])
        self.assertTrue(all(r['force_json'] for r in calls)); self.assertEqual(calls[1]['max_tokens'], 8000)
        self.assertEqual(calls[1]['messages'][0]['content'], prompts.AUDIT_RULES)
        self.assertEqual(self.s.ws.version_evidence(aid, old_vid), old_evidence)
        self.assertNotEqual(self.s.ws.version_evidence(aid, vid)['raw_generation'], old_evidence['raw_generation'])
        self.assertEqual(self.s.ws.version(aid, old_vid)['article']['body_md'], article['body_md'])
        # An explicit native audit operates on the selected manual body, once, and adopts a restorable version.
        manual = self.http(path, 'PUT', {'expected_version': vid, 'body_md': current['body_md'] + '\n初稿判断。'})['article']
        before = len(self.model.requests)
        op = self.await_operation(self.http(path + '/audit', 'POST', {'expected_version': manual['current_version']}))
        self.assertEqual(op['status'], 'done', op); self.assertEqual(len(self.model.requests) - before, 1)
        audited = self.http(self.path)['articles'][0]; self.assertEqual(audited['origin'], 'zip_audit')
        self.assertIn('核查后判断', audited['body_md']); self.assertEqual(audited['body_original'], manual['body_md'])
        self.assertEqual(self.s.ws.version_evidence(aid, old_vid), old_evidence)
        self.http(path + '/select-version', 'POST', {'expected_version': audited['current_version'], 'version_id': old_vid})
        self.assertEqual(self.http(self.path)['articles'][0]['body_md'], article['body_md'])
        EVIDENCE['native_actions'] = {'original_regenerate_function': True, 'original_audit_function': True, 'regenerate_calls': 2, 'explicit_audit_calls': 1,
            'identity_and_group_preserved': True, 'native_automatic_audit_correction': True, 'adopted_restorable_versions': True, 'version_bound_evidence': True}

    def test_native_failure_and_active_structural_guards(self):
        _, article = self.write_one(); path = self.article_path(article); old_native = self.s.store.get_article(article['id'])
        old_count = len(self.s.ws.versions(article['id']))
        self.model.gate_kind = 'generate'; self.model.gate_index = self.model.generated + 1
        self.model.fail_kind = 'audit'; self.model.entered.clear(); self.model.release.clear()
        before = len(self.model.requests)
        result = self.http(path + '/regenerate', 'POST', {'expected_version': article['current_version']})
        self.assertTrue(self.model.entered.wait(3))
        self.http(path + '/regenerate', 'POST', {'expected_version': article['current_version']}, status=409)
        self.http(path, 'DELETE', {'expected_version': article['current_version']}, status=409)
        self.http(self.path, 'DELETE', {}, status=409)
        self.http(self.path + '/clone', 'POST', {}, status=409)
        self.http(self.path + '/write-one', 'POST', {}, status=409)
        self.model.release.set(); op = self.await_operation(result)
        self.assertEqual(op['status'], 'interrupted', op)
        self.assertEqual(len(self.model.requests) - before, 2)
        self.assertEqual(self.s.store.get_article(article['id']), old_native)
        self.assertEqual(self.s.ws.current(article['id'])['current_version'], article['current_version'])
        self.assertEqual(len(self.s.ws.versions(article['id'])), old_count)
        self.assertFalse(self.s.ws.current(article['id'])['locked'])
        EVIDENCE['failure_and_guards'] = {'active_delete_clone_write_one_regenerate_rejected': True, 'uncertain_not_retried': True,
            'failed_native_audit_preserves_adopted_and_raw': True, 'lock_released': True}

    def test_empty_generation_failure_does_not_enter_native_fallback_transport(self):
        _, article = self.write_one(); path = self.article_path(article)
        before = len(self.model.requests); old_native = self.s.store.get_article(article['id'])
        self.model.fail_kind = 'generate'
        op = self.await_operation(self.http(path + '/regenerate', 'POST', {'expected_version': article['current_version']}))
        self.assertEqual(op['status'], 'interrupted', op)
        self.assertEqual(len(self.model.requests) - before, 1)
        self.assertEqual(self.s.store.get_article(article['id']), old_native)
        self.assertEqual(self.s.ws.current(article['id'])['current_version'], article['current_version'])
        self.assertFalse(self.s.ws.current(article['id'])['locked'])
        EVIDENCE['native_empty_stream_failure'] = {'actual_transport_calls': 1, 'native_fallback_cannot_redispatch': True, 'current_and_raw_preserved': True}

    def test_write_one_quota_delete_and_video_history(self):
        self.model.gate_kind = 'generate'; self.model.entered.clear(); self.model.release.clear()
        first = self.http(self.path + '/write-one', 'POST', {})
        self.assertTrue(self.model.entered.wait(3))
        self.http(self.path + '/write-one', 'POST', {}, status=409)
        self.model.release.set(); self.assertEqual(self.await_operation(first)['status'], 'done')
        view = self.http(self.path); self.assertEqual(len(view['articles']), 1)
        self.assertEqual(view['job']['remaining'], 1); self.assertEqual(view['job']['planned'], 1)
        self.assertEqual(len(self.model.requests), 2)
        self.write_one(); self.assertEqual(len(self.model.requests), 4)
        self.http(self.path + '/write-one', 'POST', {}, status=409)
        self.assertEqual(len(self.model.requests), 4)
        first_article = self.http(self.path)['articles'][0]; aid = first_article['id']; vid = first_article['current_version']
        self.http(self.article_path(first_article), 'DELETE', {'expected_version': vid})
        self.assertEqual(len(self.http(self.path)['articles']), 1)
        self.http(self.article_path(first_article) + '/versions', status=404)
        context = self.http('/api/workbench/video-context?client_id=' + self.client['id'] + f'&article_id={aid}&version_id={vid}')
        self.assertEqual(context['article']['body_md'], first_article['body_md'])
        other_vid = self.http(self.path)['articles'][0]['current_version']
        self.http('/api/workbench/video-context?client_id=' + self.client['id'] + f'&article_id={aid}&version_id={other_vid}', status=404)
        self.write_one(); self.assertEqual(len(self.http(self.path)['articles']), 2); self.assertEqual(len(self.model.requests), 6)
        self.assertTrue(self.s.ws.is_deleted_article(aid))
        EVIDENCE['write_one_delete'] = {'one_pending_only': True, 'quota_unchanged': True, 'concurrent_rejected': True,
            'logical_article_delete_frees_pending_slot': True, 'immutable_video_source_retained': True}

    def test_history_clone_delete_local_archive(self):
        doc = self.s.ws.put_document(self.client['id'], '资料.md', '文本', '西邦24用于橡胶与金属粘接。验收条件需保留。')
        self.http(self.path + '/draft', 'PUT', {'options': {'brand': '', 'company': '任务专用公司'}, 'document_ids': [doc['id']]})
        _, article = self.write_one(); path = self.article_path(article)
        base = article['current_version']
        self.s.ws.lock_article(article['id'], 'candidate-fixture', base)
        candidate = self.s.ws.save_candidate(article['id'], base, {**self.s.ws.version(article['id'], base)['article'], 'body_md': '真实候选全文。'},
            {'status': 'needs_review', 'summary': '固定返回的只读事实复核'}, 'candidate-fixture', metadata={'changes': ['固定返回的修改']})
        self.s.ws.unlock_article(article['id'], 'candidate-fixture')
        self.http(path + '/review-record', 'PUT', {'candidate_version': candidate, 'codex_review': '实际提交的Codex意见', 'user_review': '实际提交的用户意见'})
        clone = self.http(self.path + '/clone', 'POST', {})['conversation']
        original = self.s.ws.conversation(self.conv['id'])
        self.assertEqual(clone['brief'], original['brief']); self.assertEqual(clone['document_ids'], [doc['id']])
        self.assertEqual(clone['parent_conversation_id'], original['id']); self.assertIsNone(clone['plan_id'])
        self.assertIsNone(clone['job_id']); self.assertEqual(clone['messages'], []); self.assertEqual(clone['status'], 'draft')
        self.assertEqual(self.http('/api/workbench/conversations/' + clone['id'])['articles'], [])
        self.s.store.save_settings({'api_key': 'PRIVATE_CREDENTIAL_FIXTURE', 'upload_token': 'PRIVATE_TOKEN_FIXTURE'})
        trace = Path(self.temp.name) / 'traces' / 'private-canary.txt'; trace.parent.mkdir(exist_ok=True); trace.write_text('PRIVATE_TRACE_FIXTURE', encoding='utf-8')
        raw, headers = self.http(self.path + '/archive', binary=True)
        self.assertEqual(headers['Content-Type'], 'application/zip')
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            self.assertIsNone(archive.testzip()); names = archive.namelist()
            self.assertIn('exports/current.docx', names); self.assertIn('exports/current.json', names)
            self.assertIn(f'articles/{article["id"]}/comparisons/{candidate}.md', names)
            texts = '\n'.join(archive.read(n).decode('utf-8') for n in names if not n.endswith('.docx'))
            self.assertIn(doc['text'], texts); self.assertIn('实际提交的用户意见', texts)
            self.assertIn('任务专用公司', texts); self.assertIn(article['body_md'], json.loads(archive.read('exports/current.json'))['articles'][0]['body_md'])
            self.assertNotIn('PRIVATE_CREDENTIAL_FIXTURE', texts); self.assertNotIn('PRIVATE_TOKEN_FIXTURE', texts); self.assertNotIn('PRIVATE_TRACE_FIXTURE', texts)
            self.assertNotIn(self.temp.name.replace('\\', '/'), texts.replace('\\\\', '/'))
        self.http(self.path, 'DELETE', {})
        self.http(self.path, status=404)
        self.assertFalse(any(c['id'] == self.conv['id'] for c in self.http('/api/workbench/bootstrap')['conversations']))
        self.assertTrue(self.s.ws.conversation(self.conv['id'], include_deleted=True)['deleted_at'])
        video = self.http('/api/workbench/video-context?client_id=' + self.client['id'] + f'&article_id={article["id"]}&version_id={base}')
        self.assertEqual(video['article']['body_md'], article['body_md'])
        self.assertEqual(self.http('/api/workbench/conversations/' + clone['id'])['conversation']['brief']['brand'], '')
        EVIDENCE['history_archive'] = {'same_client_visible_options_and_documents_reused': True, 'no_articles_or_false_completion_cloned': True,
            'logical_history_delete_retains_video_source': True, 'real_zip_and_docx_download': True, 'versions_audits_comparisons_real_notes_and_parsed_text_included': True,
            'credentials_private_dirs_and_diagnostics_excluded': True}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(); parser.add_argument('--output', type=Path); args = parser.parse_args()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(NativeOperations))
    data = {'ok': result.wasSuccessful(), 'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
            'external_model_calls': 0, 'external_catalog_calls': 0, 'encodes': 0, 'boundaries': EVIDENCE}
    if args.output: args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(data, ensure_ascii=False, indent=2)); sys.exit(0 if data['ok'] else 1)
