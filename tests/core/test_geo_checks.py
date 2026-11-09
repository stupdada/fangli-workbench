"""Focused integration coverage for GEO routes and their measurement boundary."""
import io
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from bridge.geo_checks import ArkGeo, DEFAULT_MODEL, ENTRY, PROTOCOL, ark_rejection, normalize_ark
from bridge.http import create_server
from bridge.storage import uid


URL = 'https://example.com/article?id=10'


def fixture(query, model='test-model'):
    return {'status': 'completed', 'model': model, 'output': [
        {'type': 'web_search_call', 'status': 'completed'},
        {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text',
          'text': f'{query}\n样本品牌可供参考。' + '详细内容。' * 100,
          'annotations': [{'type': 'url_citation', 'url': URL, 'title': '公开参考'}]}]}]}


class FakeArk:
    def __init__(self):
        self.calls = []
        self.fail_at = 0
        self.gate = None
        self.entered = threading.Event()

    def settings(self):
        return 'fixture-key', 'test-model'

    def info(self):
        return {'ready': True, 'model': 'test-model', 'entry': ENTRY, 'config': PROTOCOL, 'max_calls': 16}

    def fetch(self, query, model, key):
        self.calls.append(query)
        self.entered.set()
        if self.gate:
            assert self.gate.wait(4)
        if len(self.calls) == self.fail_at:
            raise TimeoutError()
        return fixture(query, model)


class GeoHttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.server = create_server(Path(self.directory.name) / 'workbench.db', port=0)
        self.s = self.server.service
        self.fake = self.s.geo.provider = FakeArk()
        self.customer = self.s.ws.save_client('样本客户', {'brand': '样本品牌', 'products': '宠物洗护'})['id']
        self.other = self.s.ws.save_client('另一客户', {'brand': '另一个品牌', 'products': '工艺设备'})['id']
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.path = f'/api/workbench/clients/{self.customer}/geo'

    def tearDown(self):
        if self.fake.gate:
            self.fake.gate.set()
        self.server.shutdown()
        self.thread.join(timeout=3)
        self.server.server_close()
        self.directory.cleanup()

    def call(self, path, body=None, method=None):
        data = json.dumps(body).encode() if body is not None else None
        request = Request(self.base + path, data=data, headers={'Content-Type': 'application/json'} if data else {}, method=method)
        with urlopen(request, timeout=10) as response:
            return json.load(response)

    def plan(self):
        plan = self.call(self.path)['plan']
        self.assertEqual(8, len(plan['questions']))
        self.assertEqual('宠物洗护', plan['topic'])
        self.assertNotIn('样本品牌', plan['questions'][0]['text'])
        plan['questions'] = plan['questions'][:3]
        plan['repeat'] = 1
        return plan

    def finish(self, rid):
        self.s.geo.worker.join(timeout=5)
        self.assertFalse(self.s.geo.worker.is_alive())
        return self.call(self.path + '/runs/' + rid)['run']

    def test_default_plan_same_submission_full_evidence_and_scope(self):
        plan = self.plan()
        self.assertEqual([], self.fake.calls)
        body = {'request_key': uid(), 'plan': plan}
        rid = self.call(self.path + '/runs', body)['run_id']
        self.assertEqual(rid, self.call(self.path + '/runs', body)['run_id'])
        run = self.finish(rid)
        self.assertEqual(3, len(self.fake.calls))
        self.assertEqual({'hits': 3, 'eligible': 3}, run['summary']['discovery']['mentioned'])
        self.assertEqual(1, run['revision'])
        self.assertGreater(len(run['items'][0]['answer']), 300)
        self.assertEqual(URL, run['items'][0]['citations'][0]['url'])
        self.assertIsNone(run['items'][0]['article_hit'])
        with self.assertRaises(HTTPError) as scope:
            self.call(self.path.replace(self.customer, self.other) + '/runs/' + rid)
        self.assertEqual(404, scope.exception.code)
        with self.assertRaises(HTTPError) as conflict:
            self.call(self.path + '/runs', {**body, 'plan': {**plan, 'topic': '不同词'}})
        self.assertEqual(409, conflict.exception.code)
        with self.s.store.conn() as db:
            raw = json.loads(db.execute('SELECT raw FROM wb_geo_items WHERE run_id=? AND ordinal=1', (rid,)).fetchone()[0])
        self.assertEqual('completed', raw['status'])
        newer = self.call(self.path + '/runs', {'request_key': uid(), 'repeat_run_id': rid})['run_id']
        repeat = self.finish(newer)
        self.assertEqual(run['revision'], repeat['revision'])
        self.assertEqual(rid, repeat['comparable'][0]['id'])

    def test_uncertain_request_stops_dispatch_and_stays_out_of_denominator(self):
        self.fake.fail_at = 2
        rid = self.call(self.path + '/runs', {'request_key': uid(), 'plan': self.plan()})['run_id']
        run = self.finish(rid)
        self.assertEqual('interrupted', run['state'])
        self.assertEqual(['complete', 'unknown', 'skipped'], [item['state'] for item in run['items']])
        self.assertEqual({'hits': 1, 'eligible': 1}, run['summary']['discovery']['mentioned'])
        self.assertEqual(2, len(self.fake.calls))

    def test_stop_prevents_remaining_calls(self):
        self.fake.gate = threading.Event()
        rid = self.call(self.path + '/runs', {'request_key': uid(), 'plan': self.plan()})['run_id']
        self.assertTrue(self.fake.entered.wait(3))
        self.assertEqual('stopping', self.call(self.path + '/runs/' + rid + '/stop', {})['run']['state'])
        self.fake.gate.set()
        run = self.finish(rid)
        self.assertEqual('stopped', run['state'])
        self.assertEqual(['complete', 'skipped', 'skipped'], [item['state'] for item in run['items']])

    def test_discovery_cannot_contain_brand(self):
        plan = self.plan()
        plan['questions'][0]['text'] = '样本品牌怎么样？'
        with self.assertRaises(HTTPError) as failure:
            self.call(self.path + '/runs', {'request_key': uid(), 'plan': plan})
        self.assertEqual(400, failure.exception.code)
        self.assertEqual([], self.fake.calls)

    def test_save_edited_questions_without_running_and_repeat_keeps_current_plan(self):
        original = self.plan()
        old_id = self.call(self.path + '/runs', {'request_key': uid(), 'plan': original})['run_id']
        old = self.finish(old_id)
        edited = {**original, 'questions': [{'kind': 'discovery', 'text': '附近的宠物洗护怎么预约？'}]}
        saved = self.call(self.path + '/plan', edited, method='PUT')
        self.assertGreater(saved['revision'], old['revision'])
        self.assertEqual(edited['questions'], self.call(self.path)['plan']['questions'])
        self.assertEqual(3, len(self.fake.calls))
        replay_id = self.call(self.path + '/runs', {'request_key': uid(), 'repeat_run_id': old_id})['run_id']
        self.assertEqual(old['revision'], self.finish(replay_id)['revision'])
        self.assertEqual(saved['revision'], self.call(self.path)['revision'])

    def test_public_link_requires_same_customer_and_adopted_version(self):
        plan_id = self.s.store.create_plan('宠物洗护', '样本任务', {})
        task = self.s.create_conversation(self.customer)
        self.s.ws.update_conversation(task['id'], plan_id=plan_id)
        aid = self.s.store.add_article(plan_id, title='样本稿件', body_md='已采用的稿件正文')
        adopted = self.s.ws.capture_zip(aid)
        self.s.store.update_article(aid, body_md='未采用的候选正文')
        candidate = self.s.ws.capture_zip(aid, select=False)
        choices = self.call(self.path + '/articles')['articles']
        self.assertEqual([{'article_id': aid, 'version_id': adopted, 'title': '样本稿件'}], choices)
        spec = {**self.plan(), 'article_id': aid, 'version_id': adopted, 'urls': [URL]}
        with self.assertRaises(HTTPError) as foreign:
            self.call(self.path.replace(self.customer, self.other) + '/plan', spec, method='PUT')
        self.assertEqual(404, foreign.exception.code)
        with self.assertRaises(HTTPError) as not_adopted:
            self.call(self.path + '/plan', {**spec, 'version_id': candidate}, method='PUT')
        self.assertEqual(409, not_adopted.exception.code)
        rid = self.call(self.path + '/runs', {'request_key': uid(), 'plan': spec})['run_id']
        run = self.finish(rid)
        self.assertEqual({'hits': 3, 'eligible': 3}, run['summary']['discovery']['article_hit'])
        self.assertEqual(adopted, run['spec']['version_id'])


class GeoProtocolTests(unittest.TestCase):
    def test_connection_reuses_saved_key_and_normalizes_old_model_label(self):
        env = {'FANGLI_GEO_ARK_API_KEY': '', 'ARK_API_KEY': '', 'FANGLI_GEO_ARK_MODEL': ''}
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, env):
            provider = ArkGeo(directory)
            provider.path.write_text(json.dumps({'key': 'fixture-local-key', 'model': 'Doubao-Seed-2.1-lite'}), encoding='utf-8')
            self.assertEqual(('fixture-local-key', DEFAULT_MODEL), provider.settings())
            public = provider.info()
            self.assertEqual('local', public['key_source'])
            self.assertNotIn('fixture-local-key', json.dumps(public))
            selected = 'doubao-seed-2-1-turbo-260628'
            result = provider.configure({'key': '', 'model': selected})
            self.assertEqual(selected, result['model'])
            self.assertEqual(('fixture-local-key', selected), ArkGeo(directory).settings())
            provider.configure({'model': DEFAULT_MODEL})
            self.assertEqual(('fixture-local-key', DEFAULT_MODEL), ArkGeo(directory).settings())

    def test_ark_rejection_extracts_action_without_returning_provider_message(self):
        for status, code in [(403, 'AccessDenied'), (404, 'ToolNotOpen')]:
            with self.subTest(code=code):
                response = {'error': {'code': code, 'message': 'Access denied for web search. private fixture text'}}
                error = HTTPError('https://ark.cn-beijing.volces.com/api/v3/responses', status, '', {},
                                  io.BytesIO(json.dumps(response).encode()))
                issue = ark_rejection(error)
                self.assertEqual(code, issue['provider_code'])
                self.assertIn('开通联网内容插件', issue['reason'])
                self.assertNotIn('private fixture text', json.dumps(issue))

    def test_request_uses_content_plugin_and_limits_search_usage(self):
        with patch('bridge.geo_checks.build_opener') as opener:
            connection = opener.return_value.open
            connection.return_value.__enter__.return_value.read.return_value = b'{}'
            ArkGeo('.').fetch('公开问题', DEFAULT_MODEL, 'fixture-key')
        payload = json.loads(connection.call_args.args[0].data)
        self.assertEqual([{'type': 'web_search', 'sources': ['search_engine', 'toutiao', 'douyin'], 'max_keyword': 1}],
                         payload['tools'])
        self.assertEqual(1, payload['max_tool_calls'])
        self.assertEqual({'role': 'user', 'content': '公开问题'}, payload['input'][-1])

    def test_only_structured_article_citations_count_and_missing_is_unknown(self):
        spec = {'urls': [URL + '&utm_source=feed'], 'aliases': ['样本品牌']}
        response = fixture('问题')
        self.assertIs(normalize_ark(response, spec)['article_hit'], True)
        block = response['output'][1]['content'][0]
        block['text'] = '写在正文里的链接 ' + URL
        block['annotations'] = []
        self.assertIs(normalize_ark(response, spec)['article_hit'], False)
        del block['annotations']
        self.assertIsNone(normalize_ark(response, spec)['article_hit'])
        response['status'] = 'incomplete'
        self.assertIsNone(normalize_ark(response, spec)['mentioned'])


if __name__ == '__main__':
    unittest.main()
