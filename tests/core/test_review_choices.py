"""Explicit review handling, frozen facts and opt-in observations over HTTP."""
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
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bridge.http import create_server
from bridge import provider
from test_workbench import ControlledModel


class ReviewChoices(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fangli-review-choices-')
        self.model = ControlledModel()
        original = self.model.response
        def response(payload):
            kind, data = original(payload)
            if kind == 'style_review':
                data['suggestions'][1].update(tier=2, requires_material=True, proposal='补充常客到店的具体经历。')
            return kind, data
        self.model.response = response
        self.mock = patch.object(provider, 'events', self.model.events)
        self.mock.start()
        self.server = create_server(Path(self.temp.name) / 'workbench.db', 0)
        self.s = self.server.service
        self.s.catalog = [{'id': provider.DEFAULT_MODEL}]
        self.worker = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        self.worker.start()
        customer = self.http('/api/workbench/clients', 'POST', {'name': '青栈', 'profile': {'brand': '青栈'}})['client']
        self.cid = customer['id']
        doc = self.http(f'/api/workbench/clients/{self.cid}/documents', 'POST',
                        {'filename': '产品资料.txt', 'text': '初始资料：门店早间供应面包，保留这份材料的事实。'})['document']
        conv = self.http('/api/workbench/conversations', 'POST', {'client_id': self.cid})['conversation']
        self.path = '/api/workbench/conversations/' + conv['id']
        self.ident = conv['id']
        platform = self.s.store.list_platforms()[0]
        self.http(self.path + '/draft', 'PUT', {'document_ids': [doc['id']], 'options': {
            'keywords': ['西邦24'], 'selections': [{'platform_id': platform['id'], 'account_type': 'official', 'count': 1}]}})
        self.await_operation(self.http(self.path + '/start', 'POST', {}))
        self.article = self.http(self.path)['articles'][0]
        self.article_path = self.path + '/articles/' + str(self.article['id'])
        self.doc = doc

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(3)
        self.mock.stop()
        self.temp.cleanup()

    def http(self, path, method='GET', body=None, expected=200):
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=8)
        c.request(method, path, json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None,
                  {'Content-Type': 'application/json'})
        r = c.getresponse()
        data = r.read()
        c.close()
        self.assertEqual(r.status, expected, data[:500])
        return json.loads(data)

    def await_operation(self, result):
        worker = self.s.threads.get(result.get('job_id') or result['operation_id'])
        if worker:
            worker.join(5)
            self.assertFalse(worker.is_alive())
        op = self.s.ws.operation(result['operation_id'])
        self.assertEqual(op['status'], 'done', op.get('error'))
        return op

    def review(self):
        return self.await_operation(self.http(self.article_path + '/style-review', 'POST',
            {'expected_version': self.article['current_version']}))

    def payload(self, review, **extra):
        return {'expected_version': self.article['current_version'], 'review_id': review['id'],
                'selected': ['1', '2', 'O1'], 'mode': 'standard', **extra}

    def test_material_missing_is_preflight_and_conservative_is_explicit(self):
        review = self.review()
        original = copy.deepcopy(review['result'])
        requests = len(self.model.requests)
        rejected = self.http(self.article_path + '/style-rewrite', 'POST', self.payload(review), expected=400)
        self.assertIn('建议2', rejected['error'])
        self.http(self.article_path + '/style-rewrite', 'POST', self.payload(review, conservative=['missing']), expected=400)
        self.http(self.article_path + '/style-rewrite', 'POST', self.payload(review, conservative=['1']), expected=400)
        self.assertEqual(len(self.model.requests), requests)
        op = self.await_operation(self.http(self.article_path + '/style-rewrite', 'POST',
            self.payload(review, conservative=['2'])))
        result = op['result']
        self.assertFalse(result['adopted'])
        self.assertEqual(self.s.ws.current(self.article['id'])['current_version'], self.article['current_version'])
        sent = next(json.loads(p['messages'][1]['content']) for p in self.model.requests
                    if '现在执行用户明确选中的建议' in p['messages'][0]['content'])
        self.assertEqual([i['id'] for i in sent['selected']], ['1', '2', 'O1'])
        chosen = next(i for i in sent['selected'] if i['id'] == '2')
        self.assertEqual(chosen['handling'], 'conservative')
        self.assertFalse(chosen['requires_material'])
        self.assertNotIn('original_proposal', chosen)
        self.assertIn('不补写', chosen['proposal'])
        self.assertEqual(self.s.ws.operation(review['id'])['result'], original)
        candidate = self.s.ws.version(self.article['id'], result['candidate_version'])
        self.assertEqual(candidate['metadata']['conservative'], ['2'])
        self.assertTrue(result['fact_check']['readonly'])
        self.assertEqual(result['fact_check']['attempts'], 1)

    def test_provided_material_and_observation_use_frozen_documents(self):
        self.http(f'/api/workbench/clients/{self.cid}/documents', 'POST', {
            'filename': self.doc['filename'], 'text': '后来资料：改为午后点心，这段不能替换已有文章的依据。',
            'update_document_id': self.doc['id']})
        review = self.review()
        review_request = next(json.loads(p['messages'][1]['content']) for p in self.model.requests
                              if '本次只执行完整通读、逐段扫描' in p['messages'][0]['content'])
        self.assertEqual(review_request['documents'][0]['text'], self.doc['text'])
        material = '一位常客在工作日八点到店，选择盐面包和美式。'
        op = self.await_operation(self.http(self.article_path + '/style-rewrite', 'POST', self.payload(review, material=material)))
        sent = next(json.loads(p['messages'][1]['content']) for p in self.model.requests
                    if '现在执行用户明确选中的建议' in p['messages'][0]['content'])
        self.assertEqual(sent['material'], material)
        self.assertEqual(sent['documents'][0]['text'], self.doc['text'])
        self.assertEqual(set(sent['documents'][0]), {'filename', 'kind', 'text'})
        self.assertTrue(next(i for i in sent['selected'] if i['id'] == '2')['requires_material'])
        self.assertFalse(op['result']['adopted'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
