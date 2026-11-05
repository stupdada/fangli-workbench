"""Only the new visible-input / transaction / frozen-boundary regressions."""
import copy
import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from app import generator
from bridge import provider
from bridge.http import create_server
from bridge.service import FrozenStore

EVIDENCE = {}


class EffectiveInputTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fangli-input-')
        self.server = create_server(Path(self.temp.name) / 'input.db', port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        self.thread.start(); self.s = self.server.service
        self.s.catalog = [{'id': provider.DEFAULT_MODEL}]
        self.client = self.http('/api/workbench/clients', 'POST', {'name': '仅验收·档案名称', 'profile': {'brand': '档案品牌', 'company': '档案公司', 'products': '档案产品'}})['client']
        self.conv = self.http('/api/workbench/conversations', 'POST', {'client_id': self.client['id']})['conversation']
        self.path = '/api/workbench/conversations/' + self.conv['id']

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(2); self.temp.cleanup()

    def http(self, path, method='GET', body=None, status=200):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request(method, path, body=json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None, headers={'Content-Type': 'application/json'})
        response = conn.getresponse(); raw = response.read(); conn.close()
        self.assertEqual(response.status, status, raw.decode('utf-8'))
        return json.loads(raw)

    def draft(self, patch):
        return self.http(self.path + '/draft', 'PUT', {'options': patch})['conversation']

    def executable(self, patch=None):
        p = self.s.store.list_platforms()[0]
        return self.draft({'keywords': ['产品说明'], 'selections': [{'platform_id': p['id'], 'account_type': 'official', 'count': 1}], **(patch or {})})

    def test_confirmation_empty_patch_preserves_current_brief(self):
        base = '保留工序条件；已经撤销价格要求；两平台使用官方身份。'
        before = self.executable({'note': base})['brief']
        self.s.ws.update_conversation(self.conv['id'], messages=[{'role': 'assistant', 'content': {
            'understanding': '确认身份', 'questions': [{'text': '账号身份？', 'options': ['官方', '个人']}], 'options': before}}])
        calls = []
        def events(payload):
            calls.append(payload)
            yield {'type': 'delta', 'text': json.dumps({'understanding': '确认摘要不能替代有效要求', 'options': {}, 'questions': [], 'ready': True}, ensure_ascii=False)}
            yield {'type': 'done', 'finish_reason': 'stop'}
        with patch.object(provider, 'events', events):
            result = self.http(self.path + '/chat', 'POST', {'text': '官方'})
            worker = self.s.threads.get(result['operation_id'])
            if worker: worker.join(3)
        op = self.s.ws.operation(result['operation_id'])
        self.assertEqual(op['status'], 'done')
        current = self.http(self.path)['conversation']
        self.assertEqual(current['brief'], before)
        self.assertEqual(current['messages'][-1]['content']['options']['note'], base)
        self.assertEqual(len(calls), 1)

    def test_missing_note_on_new_instruction_is_validation_and_keeps_input(self):
        base = '保留工序条件；当前有效说明。'
        self.executable({'note': base})
        self.s.ws.update_conversation(self.conv['id'], messages=[{'role': 'assistant', 'content': {
            'questions': [{'text': '账号身份？', 'options': ['官方', '个人']}]}}])
        calls = []
        def events(payload):
            calls.append(payload)
            yield {'type': 'delta', 'text': json.dumps({'understanding': '新要求摘要', 'options': {}, 'questions': [], 'ready': True})}
            yield {'type': 'done', 'finish_reason': 'stop'}
        with patch.object(provider, 'events', events):
            result = self.http(self.path + '/chat', 'POST', {'text': '改为工程师读者，并删除价格说明'})
            worker = self.s.threads.get(result['operation_id'])
            if worker: worker.join(3)
        op = self.s.ws.operation(result['operation_id'])
        self.assertEqual(op['status'], 'error')
        self.assertEqual(op['result']['error_status'], 400)
        current = self.http(self.path)['conversation']
        self.assertEqual(current['brief']['note'], base)
        self.assertEqual(current['messages'][-1]['content'], '改为工程师读者，并删除价格说明')
        self.assertEqual(len(calls), 1)

    def test_visible_note_replaces_history_and_interview_compiles_current_values(self):
        self.assertEqual(self.conv['brief']['selections'], [])
        self.assertEqual(self.conv['brief']['models'], [m['name'] for m in self.s.store.list_models() if m['enabled']])
        self.executable({'note': '面向消费者的选购建议；保留储存条件。'})
        self.s.ws.update_conversation(self.conv['id'], messages=[{'role': 'user', 'content': '面向消费者的选购建议；保留储存条件。'}])
        final_note = '面向工程师的产品介绍；保留储存条件。'
        captured = []
        def fake_events(payload):
            self.assertNotEqual(payload.get('operation'), 'models')
            request = json.loads(payload['messages'][1]['content']); captured.append(request)
            value = {'understanding': '仅编辑侧理解，不进入写作说明', 'options': {'note': final_note,
                'brand': '访谈品牌', 'company': '访谈公司', 'products': '访谈产品'}, 'questions': [], 'ready': True}
            yield {'type': 'delta', 'text': json.dumps(value, ensure_ascii=False)}
            yield {'type': 'done', 'finish_reason': 'stop'}
        with patch.object(provider, 'events', fake_events):
            result = self.http(self.path + '/chat', 'POST', {'text': '改为面向工程师的产品介绍，储存条件继续保留', 'followup': False})
            worker = self.s.threads.get(result['operation_id'])
            if worker: worker.join(3)
        op = self.http('/api/workbench/operations/' + result['operation_id'])['operation']
        self.assertEqual(op['status'], 'done')
        current = self.http(self.path)['conversation']; brief = self.s.build_brief(current)
        self.assertEqual(brief['note'], current['brief']['note']); self.assertEqual(brief['note'], final_note)
        self.assertNotIn('消费者', brief['note']); self.assertNotIn('仅编辑侧理解', brief['note'])
        self.assertIn('消费者', current['messages'][0]['content'])
        self.assertEqual(brief['brand'], '访谈品牌')
        self.assertEqual(captured[0]['client']['profile']['brand'], '档案品牌')
        self.draft({'brand': '', 'company': '', 'products': '', 'note': ''})
        empty = self.s.build_brief(self.http(self.path)['conversation'])
        self.assertEqual([empty[k] for k in ('brand', 'company', 'products', 'note')], ['', '', '', ''])
        EVIDENCE['note_and_interview'] = {'visible_note_only': True, 'history_preserved': True, 'untouched_condition_retained': True,
            'replaced_reader_removed': True, 'interview_updates_task_fields': True, 'explicit_empty_no_fallback': True,
            'local_fixture_calls': len(captured), 'external_model_calls': 0}

    def test_profile_transaction_and_frozen_inputs(self):
        self.executable({'note': '当前可见说明', 'brand': '明确任务品牌'})
        before = self.s.ws.conversation(self.conv['id']); old_brief = self.s.build_brief(before)
        pid = self.s.store.create_plan(old_brief['keyword'], '冻结验收', old_brief)
        sid = self.s.ws.save_snapshot(self.conv['id'], {'brief': copy.deepcopy(old_brief), 'documents': []})
        aid = self.s.store.add_article(pid, title='已有成稿', body_md='已有成稿保持不变。')
        self.s.ws.bind_source(aid, sid); self.s.ws.capture_zip(aid)
        frozen = FrozenStore(self.s, pid, before['brief'], sid)
        job = generator.new_job(pid, 1, kind='auto'); frozen.jid = job
        self.s.ws.update_conversation(self.conv['id'], plan_id=pid, job_id=job, status='running')
        profile = {k: '' for k in self.client['profile']}
        profile.update(brand='新品牌', company='新公司', products='新产品')
        result = self.http(self.path + '/profile', 'PUT', {'name': '仅验收·新名称', 'profile': profile, 'save_as_default': True})
        self.assertEqual(result['client']['profile'], profile)
        self.assertEqual(result['conversation']['brief']['brand'], '新品牌')
        self.assertEqual(result['conversation']['brief']['client'], result['client']['name'])
        self.assertTrue(result['conversation']['needs_confirmation']); self.assertTrue(generator.get_job(job)['cancel'])
        self.assertEqual(frozen.get_plan(pid)['brief'], old_brief)
        self.assertEqual(self.s.ws.article_source(aid)['brief'], old_brief)
        self.assertEqual(self.s.store.get_article(aid)['body_md'], '已有成稿保持不变。')
        with self.s.store.conn() as conn:
            conn.execute("CREATE TRIGGER reject_profile_fixture BEFORE UPDATE OF brief ON wb_conversations BEGIN SELECT RAISE(ABORT,'protocol-fixture'); END")
        rejected = {**profile, 'brand': '不应单独写入的品牌'}
        self.http(self.path + '/profile', 'PUT', {'name': '不应单独写入的名称', 'profile': rejected, 'save_as_default': True}, status=500)
        self.assertEqual(self.s.ws.client(self.client['id'])['profile'], profile)
        self.assertEqual(self.s.ws.conversation(self.conv['id'])['brief']['brand'], '新品牌')
        with self.s.store.conn() as conn: conn.execute('DROP TRIGGER reject_profile_fixture')
        profile.update(brand='', company='', products='')
        cleared = self.http(self.path + '/profile', 'PUT', {'name': '仅验收·新名称', 'profile': profile, 'save_as_default': True})
        self.assertEqual(cleared['client']['profile']['brand'], '')
        self.assertEqual(cleared['conversation']['brief']['brand'], '')
        generator._patch(job, status='paused')
        self.assertEqual(self.s.build_brief(cleared['conversation'])['brand'], '')
        self.http('/api/workbench/clients', 'POST', {'id': self.client['id'], 'name': '无任务写入'}, status=400)
        next_task = self.http('/api/workbench/conversations', 'POST', {'client_id': self.client['id']})['conversation']
        self.assertEqual(next_task['brief']['brand'], '')
        self.assertEqual(next_task['brief']['selections'], [])
        EVIDENCE['profile_transaction'] = {'one_http_write': True, 'archive_and_task_committed_together': True,
            'forced_sqlite_failure_rolled_both_back': True, 'explicit_empty_preserved': True,
            'running_following_paused': True, 'frozen_snapshot_and_completed_article_unchanged': True,
            'new_task_empty_platforms': True, 'new_task_uses_archive_defaults': True}

    def test_pending_message_compiles_once_then_enters_frozen_generation(self):
        from test_workbench import ControlledModel
        model = ControlledModel()
        base = '面向工艺人员介绍；保留储存条件。'
        message = '这次重点解释金属表面准备，写得简短一些。'
        compiled = '面向工艺人员介绍；保留储存条件；本次重点解释金属表面准备，表达简短。'
        self.executable({'note': base})
        interviews = []
        def events(payload):
            if payload.get('messages') and '需求访谈助手' in payload['messages'][0]['content']:
                request = json.loads(payload['messages'][1]['content'])
                interviews.append(request)
                value = {'understanding': '安排已整理', 'options': {'note': compiled},
                         'questions': [], 'ready': True}
                yield {'type': 'delta', 'text': json.dumps(value, ensure_ascii=False)}
                yield {'type': 'done', 'finish_reason': 'stop'}
            else:
                yield from model.events(payload)
        with patch.object(provider, 'events', events):
            result = self.http(self.path + '/chat', 'POST', {'text': message, 'followup': False})
            worker = self.s.threads.get(result['operation_id'])
            if worker: worker.join(3)
            self.assertEqual(self.s.ws.operation(result['operation_id'])['status'], 'done')
            self.assertEqual(len(interviews), 1)
            self.assertEqual(interviews[0]['options']['note'], base)
            self.assertEqual(interviews[0]['messages'][-1]['content'], message)
            self.assertFalse(interviews[0]['followup'])
            self.assertEqual(model.generated, 0)
            result = self.http(self.path + '/start', 'POST', {})
            worker = self.s.threads.get(result['job_id'])
            if worker: worker.join(5)
        self.assertEqual(self.s.ws.operation(result['operation_id'])['status'], 'done')
        article = self.http(self.path)['articles'][0]
        self.assertEqual(self.s.ws.article_source(article['id'])['brief']['note'], compiled)
        self.assertIn(compiled, model.requests[0]['messages'][1]['content'])
        self.assertEqual(self.s.ws.client(self.client['id'])['profile']['brand'], '档案品牌')
        self.assertEqual(len(interviews), 1)
        EVIDENCE['message_before_start'] = {'compiler_calls': 1, 'pending_message_delivered': True,
            'long_term_condition_preserved': True, 'frozen_note_equals_compiled': True,
            'client_archive_unchanged': True, 'external_model_calls': 0}

    def test_confirmed_aliases_flow_through_draft_brief_pending(self):
        words = ['西邦24', '西邦12E', '西邦80ET', '橡胶金属胶', 'Cilbond24', 'Cilbond12E', 'Cilbond80ET', '单涂体系']
        found = self.http('/api/aliases', 'POST', {'keywords': words})['aliases']
        confirmed = [['西邦24', 'Cilbond24'], ['西邦12E', 'Cilbond12E'], ['西邦80ET', 'Cilbond80ET']]
        p = self.s.store.list_platforms()[0]
        conv = self.executable({'keywords': words, 'aliases': confirmed,
            'selections': [{'platform_id': p['id'], 'account_type': 'personal', 'count': 4}]})
        brief = self.s.build_brief(conv)
        self.assertEqual(brief['aliases'], confirmed)
        pid = self.s.store.create_plan(words[0], '别名验收', brief)
        grouped, _, pending = generator.pending_tasks(self.s.store, pid, words, brief['selections'], brief['aliases'], brief.get('platform_types'))
        plain, _, _ = generator.pending_tasks(self.s.store, pid, words, brief['selections'], [])
        self.assertEqual(len(pending), 4)
        for pair in confirmed:
            self.assertTrue(any(set(pair) <= set(task['group']) for task in grouped))
        self.assertNotEqual([t['group'] for t in grouped], [t['group'] for t in plain])
        EVIDENCE['alias_groups'] = {'found_local': found, 'confirmed': confirmed, 'draft_equals_brief': True,
            'with_aliases': [t['group'] for t in grouped], 'without_aliases': [t['group'] for t in plain],
            'pending': len(pending), 'external_model_calls': 0, 'native_grouping_unchanged': True}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(); parser.add_argument('--output', type=Path); args = parser.parse_args()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(EffectiveInputTest))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({'ok': result.wasSuccessful(), 'tests': result.testsRun, 'evidence': EVIDENCE,
            'external_model_calls': 0, 'external_catalog_calls': 0}, ensure_ascii=False, indent=2), encoding='utf-8')
    raise SystemExit(0 if result.wasSuccessful() else 1)
