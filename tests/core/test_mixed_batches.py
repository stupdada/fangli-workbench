"""Production Handler and worker against a local HTTP short-video substitute."""
from collections import Counter
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlencode, urlsplit
from uuid import uuid4
import zipfile

from bridge import provider
from bridge.batch_video import ASSETS, BASE, BatchVideoClient
from bridge.http import create_server
from test_workbench import ControlledModel

BATCHES = '/api/workbench/batches'


class VideoDouble:
    def __init__(self, context):
        self.context = context
        self.calls = []
        self.operations = {}
        self.productions = {}
        self.keys = {}
        self.lose_reply = set()
        self.fail_render = set()
        self.missing_asset = False
        model = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass

            def output(self, status, data, mime='application/json'):
                body = json.dumps(data).encode() if isinstance(data, dict) else data
                self.send_response(status)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                if self.headers.get('Origin') != 'http://' + self.headers.get('Host', ''):
                    self.output(403, {'error': 'only same-origin requests'}); return
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                self.assert_key(data)
                key = data['request_key']
                model.calls.append((self.path, data))
                if key in model.keys:
                    path, original, op = model.keys[key]
                    self.output(202 if (path, original) == (self.path, data) else 409, op)
                    return
                op = {'id': str(uuid4()), 'status': 'completed'}
                if self.path == BASE + '/productions':
                    cid, production_id = data['clientId'], str(uuid4())
                    source = data['source'] if 'source' in data else {'conversation_id': data['conversation_id']}
                    query = {'client_id': cid, **source}
                    snapshot = model.context(query)
                    model.productions[production_id] = {'id': production_id, 'client': snapshot['client'],
                        'source': snapshot['source_article'], 'topic': data['topic'], 'version': 1, 'renders': [], 'context': snapshot}
                    op.update(client_id=cid, production_id=production_id)
                else:
                    production_id = self.path.split('/')[-2]
                    p = model.productions[production_id]
                    if data['expected_version'] != 1:
                        self.output(409, {'error': 'wrong revision'}); return
                    op.update(client_id=p['client']['id'], production_id=production_id, version=1)
                    if p['topic'] in model.fail_render:
                        model.fail_render.remove(p['topic'])
                        op.update(status='failed', error='fixture render rejected')
                    else:
                        rid = str(uuid4())
                        p['renders'].append({'id': rid, 'version': 1})
                        op['render_id'] = rid
                model.keys[key] = (self.path, data, op)
                model.operations[op['id']] = op
                if data.get('topic') in model.lose_reply:
                    model.lose_reply.remove(data['topic'])
                    return
                self.output(202, {**op, 'status': 'running'})

            def assert_key(self, data):
                assert data['request_key'].startswith('batch-video-')

            def do_GET(self):
                url = urlsplit(self.path)
                if '/operations/' in url.path:
                    assert url.query == 'wait=1'
                    self.output(200, model.operations[url.path.split('/')[-1]])
                elif '/renders/' in url.path:
                    name = url.path.split('/')[-1]
                    if model.missing_asset and name == 'cover.png':
                        self.output(404, {'error': 'missing asset'})
                    else:
                        self.output(200, name.encode(), ASSETS[name])
                else:
                    self.output(200, model.productions[url.path.split('/')[-1]])

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.thread.join(3)
        self.server.server_close()


class MixedBatches(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / 'workbench.db'
        self.model = ControlledModel()
        self.patched = patch.object(provider, 'events', self.model.events)
        self.patched.start()
        self.video = VideoDouble(lambda query: self.http('/api/workbench/video-context?' + urlencode(query)))
        self.open_server()
        self.cid = self.http('/api/workbench/clients', 'POST', {'name': '首版客户', 'profile': {'brand': '首版品牌'}})['client']['id']
        self.client_path = '/api/workbench/clients/' + self.cid
        self.doc = self.http(self.client_path + '/documents', 'POST', {'filename': '资料.txt', 'text': '首版资料。'})['document']
        self.platform = self.s.store.list_platforms()[0]

    def open_server(self):
        self.server = create_server(self.db, port=0)
        self.s = self.server.service
        self.s.catalog = [{'id': provider.DEFAULT_MODEL}]
        self.s.batches.videos.client = BatchVideoClient(lambda: self.video.server.server_address)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        self.thread.start()

    def close_server(self):
        self.server.shutdown()
        self.thread.join(3)
        self.server.server_close()

    def tearDown(self):
        self.model.release.set()
        self.close_server()
        self.video.close()
        self.patched.stop()
        self.temp.cleanup()

    def http(self, path, method='GET', body=None, status=200, raw=False):
        conn = HTTPConnection('127.0.0.1', self.server.server_port, timeout=8)
        try:
            conn.request(method, path, json.dumps(body).encode() if body is not None else None,
                         {'Content-Type': 'application/json'})
            response = conn.getresponse()
            data = response.read()
            self.assertEqual(response.status, status, data[:500])
            return data if raw else json.loads(data)
        finally:
            conn.close()

    def batch(self, path):
        self.assertTrue(self.s.batches.idle.wait(8))
        return self.http(path)['batch']

    def selection(self, count):
        return {'keywords': ['试用'], 'selections': [{'platform_id': self.platform['id'], 'account_type': 'official', 'count': count}]}

    def test_three_videos_resume_per_stage_and_download_only_owned_assets(self):
        self.video.lose_reply.add('资料直出，提交已接收')
        self.video.fail_render.add('文章版，成片失败')
        item = {'client_id': self.cid, 'document_ids': [self.doc['id']], 'options': self.selection(1), 'videos': [
            {'topic': '文章版，成片失败', 'source': 'article', 'article_index': 1},
            {'topic': '资料直出，提交已接收', 'source': 'documents', 'narration': False},
            {'topic': '资料直出，正常完成', 'source': 'documents'}]}
        preflight = self.http(BATCHES + '/preflight', 'POST', {'items': [item]})
        self.assertEqual((preflight['ready'], preflight['total'], preflight['video_total']), (True, 1, 3))
        with patch.object(self.s.batches, 'wake'):
            response = self.http(BATCHES, 'POST', {'request_key': 'mixed', 'items': [item]})['batch']
        path = BATCHES + '/' + response['id']
        profile = {**self.s.ws.client(self.cid)['profile'], 'brand': '新档案品牌'}
        self.http(self.client_path, 'PUT', {'name': '新档案客户', 'profile': profile})
        self.http(self.client_path + '/documents', 'POST', {'filename': '资料.txt', 'text': '第二版资料。', 'update_document_id': self.doc['id']})
        self.s.batches.wake()
        first = self.batch(path)
        article, lost, completed = first['items'][0]['videos']
        self.assertEqual((first['completed'], first['video_completed'], first['status']), (1, 1, 'interrupted'))
        self.assertEqual((article['status'], article['stage'], lost['status'], completed['status']), ('error', 'render', 'interrupted', 'done'))
        self.assertEqual(self.model.generated, 1)
        article_production = article['production_id']
        for production in self.video.productions.values():
            self.assertEqual(production['context']['client']['profile']['brand'], '首版品牌')
            self.assertEqual(production['context']['documents'][0]['text'], '首版资料。')
        tid = first['items'][0]['conversation_id']
        self.http(f"/api/workbench/conversations/{tid}/articles/{article['article_id']}", 'PUT', {
            'expected_version': article['version_id'], 'body_md': '# 后来的采用版\n\n保留原视频来源。'})

        # Simulate an interruption between claiming the item and updating the parent status.
        with self.s.store.conn() as conn:
            journal = conn.execute('SELECT script_request_key,script_operation_id FROM wb_batch_videos WHERE id=?', (lost['id'],)).fetchone()
            self.assertIn(journal['script_request_key'], self.video.keys)
            self.assertIsNone(journal['script_operation_id'])
            conn.execute("UPDATE wb_batches SET status='queued' WHERE id=?", (first['id'],))
            conn.execute("UPDATE wb_batch_items SET status='running' WHERE batch_id=?", (first['id'],))
            conn.execute("UPDATE wb_batch_videos SET status='running' WHERE id=?", (lost['id'],))
        self.close_server()
        self.open_server()
        self.assertEqual(self.http(path)['batch']['status'], 'interrupted')
        retry = lambda row: path + f"/videos/{row['id']}/retry"
        self.http(retry(lost), 'POST', {}, status=409)
        self.http(retry(lost), 'POST', {'acknowledge_uncertain': True})
        second = self.batch(path)
        self.assertEqual((second['status'], second['video_completed']), ('partial', 2))
        self.http(retry(article), 'POST', {})
        final = self.batch(path)
        self.assertEqual((final['status'], final['completed'], final['video_completed']), ('done', 1, 3))
        final_videos = final['items'][0]['videos']
        self.assertEqual(final_videos[0]['production_id'], article_production)
        self.assertEqual(final_videos[0]['version_id'], article['version_id'])
        self.assertEqual(final_videos[2]['render_id'], completed['render_id'])
        self.assertEqual(self.model.generated, 1)
        self.http(retry(completed), 'POST', {}, status=409)
        self.http(BATCHES + '/wrong/videos/' + completed['id'] + '/retry', 'POST', {}, status=404)
        keys = Counter(body['request_key'] for _, body in self.video.calls)
        self.assertEqual(len(keys), 7)  # three scripts, four accepted render attempts
        self.assertEqual([value for value in keys.values() if value > 1], [2])
        self.assertTrue(any(key.endswith('-render-2') for key in keys))
        archive = self.http(path + '/video-download', raw=True)
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            self.assertEqual(len(zipped.namelist()), 9)
            for name in zipped.namelist():
                self.assertEqual(zipped.read(name), name.rsplit('/', 1)[1].encode())
        self.video.missing_asset = True
        self.http(path + '/video-download', status=409)

    def test_invalid_indexes_and_video_only_without_plan(self):
        item = {'client_id': self.cid, 'document_ids': [self.doc['id']], 'videos': [{'topic': '无文章的平台', 'source': 'article', 'article_index': 1}]}
        result = self.http(BATCHES + '/preflight', 'POST', {'items': [item]})
        self.assertFalse(result['ready'])
        self.assertIn('文章序号', result['issues'][0]['error'])
        item['videos'] = [{'topic': '直接资料', 'source': 'documents', 'narration': False}]
        self.http(BATCHES, 'POST', {'request_key': 'missing-docs', 'items': [{**item, 'document_ids': []}]}, status=400)
        result = self.http(BATCHES, 'POST', {'request_key': 'video-only', 'items': [item]})['batch']
        batch = self.batch(BATCHES + '/' + result['id'])
        self.assertEqual((batch['total'], batch['completed'], batch['video_completed'], batch['status']), (0, 0, 1, 'done'))
        self.assertEqual(self.model.generated, 0)
        render = next(body for path, body in self.video.calls if path.endswith('/renders'))
        self.assertIs(render['narration'], False)

    def test_missing_article_does_not_hold_direct_video(self):
        item = {'client_id': self.cid, 'document_ids': [self.doc['id']], 'options': self.selection(1), 'videos': [
            {'topic': '等待文章', 'source': 'article', 'article_index': 1}, {'topic': '独立资料', 'source': 'documents'}]}
        with patch.object(self.s, 'start', side_effect=ValueError('fixture article failed')):
            result = self.http(BATCHES, 'POST', {'request_key': 'missing-article', 'items': [item]})['batch']
            path = BATCHES + '/' + result['id']
            batch = self.batch(path)
        waiting, direct = batch['items'][0]['videos']
        self.assertEqual((batch['status'], waiting['stage'], waiting['status'], direct['status']), ('partial', 'waiting_article', 'error', 'done'))
        self.http(path + '/videos/' + waiting['id'] + '/retry', 'POST', {}, status=409)
        self.http(path + '/resume', 'POST', {})
        final = self.batch(path)
        self.assertEqual((final['status'], final['completed'], final['video_completed']), ('done', 1, 2))
        self.assertEqual(final['items'][0]['videos'][1]['render_id'], direct['render_id'])
