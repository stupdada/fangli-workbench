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

    def test_recommended_mixed_batch_completes_video_while_article_is_waiting(self):
        item = {'client_id': self.cid, 'document_ids': [self.doc['id']], 'options': self.selection(1),
                'videos': [{'source': 'documents'}]}
        result = self.http(BATCHES + '/preflight', 'POST', {'items': [item]})
        self.assertTrue(result['ready'], result['issues'])
        plan = result['items'][0]['preview']
        topics = {'article:1': ['文章选题一', '文章选题二', '文章选题三'],
                  'video:1': ['视频选题一', '视频选题二', '视频选题三']}
        body = {'item': item, 'revision': plan['revision'], 'rows': list(topics), 'seen': [], 'count': 3}
        with patch.object(provider, 'chat', return_value=json.dumps({'topics': topics})) as model:
            self.assertEqual(self.http(BATCHES + '/topics', 'POST', body)['topics'], topics)
            payload = json.loads(model.call_args.args[0][1]['content'])
            self.assertEqual(payload['documents'][0]['excerpt'], '首版资料。')
            self.assertIn('重复', self.http(BATCHES + '/topics', 'POST',
                {**body, 'seen': ['视频选题一？']}, status=400)['error'])
        alternates = {'video:1': ['视频选题四', '视频选题五']}
        with patch.object(provider, 'chat', return_value=json.dumps({'topics': alternates})):
            self.assertEqual(self.http(BATCHES + '/topics', 'POST',
                {**body, 'rows': ['video:1'], 'count': 2, 'seen': topics['video:1']})['topics'], alternates)
        self.assertEqual(self.http(BATCHES)['batches'], [])
        self.http(BATCHES, 'POST', {'request_key': 'unset-video', 'items': [item]}, status=400)
        confirmed = {**item, 'preview': {'revision': plan['revision'],
                     'rows': [{'id': 'article:1', 'topic': topics['article:1'][0]},
                              {'id': 'video:1', 'topic': alternates['video:1'][0]}]}}
        video_done = threading.Event()
        process = self.s.batches.videos.process

        def record_video(item, row):
            process(item, row)
            video_done.set()

        self.model.gate_kind = 'generate'
        with patch.object(self.s.batches.videos, 'process', side_effect=record_video):
            started = self.http(BATCHES, 'POST', {'request_key': 'recommended', 'items': [confirmed]})['batch']
            try:
                self.assertTrue(self.model.entered.wait(4))
                self.assertTrue(video_done.wait(4))
                batch = self.s.batches.get(started['id'])
                self.assertEqual((batch['completed'], batch['video_completed'], batch['status']), (0, 1, 'running'))
                self.assertEqual(batch['items'][0]['videos'][0]['topic'], '视频选题四')
            finally:
                self.model.release.set()
            final = self.batch(BATCHES + '/' + started['id'])
        self.assertEqual((final['completed'], final['video_completed'], final['status']), (1, 1, 'done'))
        self.assertTrue(any('【主题】文章选题一' in msg['content']
                            for request in self.model.requests for msg in request.get('messages', [])))

    def test_single_creation_recommendations_use_task_and_video_sources(self):
        conversation = self.s.create_conversation(self.cid, document_ids=[self.doc['id']])
        self.s.save_draft(conversation['id'], self.selection(1), mode='zip')
        topics = {'1': '建议选题一'}
        with patch.object(provider, 'chat', return_value=json.dumps({'topics': topics})) as model:
            article_path = f"/api/workbench/conversations/{conversation['id']}/topics"
            self.assertEqual(self.http(article_path, 'POST', {'seen': []})['topics'], topics)
            article_input = json.loads(model.call_args.args[0][1]['content'])
            self.assertEqual(article_input['slots'][0]['kind'], 'article')
            self.assertEqual(article_input['slots'][0]['platforms'], [self.platform['name']])
            source = {'client_id': self.cid, 'document_ids': self.doc['id']}
            self.assertEqual(self.http('/api/workbench/video-topics', 'POST',
                {'source': source, 'template': 'qa', 'seen': []})['topics'], topics)
            video_input = json.loads(model.call_args.args[0][1]['content'])
            self.assertEqual(video_input['slots'][0]['template'], 'qa')
            self.assertEqual(video_input['documents'][0]['excerpt'], '首版资料。')

    def test_conversation_topics_work_before_keywords_and_platform_arrangement(self):
        conversation = self.s.create_conversation(self.cid, document_ids=[self.doc['id']])
        cid = conversation['id']
        scope = '写作背景与表达要求。' * 60 + '\n仅面向研究生申请者，排除本科课程。'
        self.s.save_draft(cid, {'note': scope, 'topic': '旧批次主题'})
        self.s.ws.update_conversation(cid, messages=[{'role': 'user', 'content': '旧对话原文'}])
        topic_path = f"/api/workbench/conversations/{cid}/topics"
        topics = {'1': ['建议选题一', '建议选题二', '建议选题三']}
        with patch.object(provider, 'chat', return_value=json.dumps({'topics': topics})) as model:
            result = self.http(topic_path, 'POST', {'seen': [], 'count': 3, 'direction': '未整理的输入框草稿'})
            self.assertEqual(result['topics'], topics)
            system, user = model.call_args.args[0]
            payload = json.loads(user['content'])
            self.assertIn('每条候选都必须同时满足所有明确限定', system['content'])
            self.assertEqual(payload['request'], {'note': scope, 'keywords': []})
            self.assertNotIn('documents', payload)
            self.assertNotIn('旧对话原文', user['content'])
            self.assertNotIn('未整理的输入框草稿', user['content'])
            self.assertEqual(payload['client']['name'], conversation['brief']['client'])
        self.assertEqual(self.s.ws.conversation(cid)['brief']['note'], scope)

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

    def test_preview_confirms_fixed_slots_and_retries_only_missing_articles(self):
        options = {**self.selection(3), 'keywords': ['工艺甲', '工艺乙', '工艺丙']}
        item = {'client_id': self.cid, 'options': options, 'document_ids': [self.doc['id']], 'videos': [
            {'topic': '随第一篇取消', 'source': 'article', 'article_index': 1},
            {'topic': '依赖第三篇', 'source': 'article', 'article_index': 3}]}
        preflight = self.http(BATCHES + '/preflight', 'POST', {'items': [item]})
        plan = preflight['items'][0]['preview']
        one, two, three, cancelled, video = plan['rows']
        self.assertEqual([r['id'] for r in plan['rows']], ['article:1', 'article:2', 'article:3', 'video:1', 'video:2'])
        self.assertEqual(one['platform_name'], self.platform['name'])
        self.assertIn(one['format'], self.platform['formats'])
        self.assertEqual(video['depends_on'], three['id'])
        self.assertEqual(plan['documents'], [{k: self.doc[k] for k in ('id', 'filename', 'revision')}])
        self.assertEqual(self.model.requests, [])
        choices = [{'id': two['id'], 'topic': '材料乙适用条件'}, {'id': three['id'], 'topic': '工序丙检查步骤'},
                   {'id': video['id'], 'topic': '工序丙现场口播'}]
        confirmed = {**item, 'preview': {'revision': plan['revision'], 'rows': choices}}
        rejected = {**confirmed, 'preview': {**confirmed['preview'], 'rows': choices + [{'id': cancelled['id']}]}}
        invalid = self.http(BATCHES, 'POST', {'request_key': 'invalid-dependency', 'items': [rejected]}, status=400)
        self.assertIn('视频所引用的文章', invalid['error'])
        self.assertEqual(self.http(BATCHES)['batches'], [])

        respond = self.model.response

        def fail_first_article(payload):
            kind, value = respond(payload)
            return (kind, {}) if kind == 'generate' and self.model.generated == 1 else (kind, value)

        self.model.response = fail_first_article
        zip_snapshot = self.s.zip_snapshot
        with patch.object(self.s.batches, 'wake'), patch.object(self.s, 'zip_snapshot',
                side_effect=lambda brief: {**zip_snapshot(brief), 'created_at': '2099-01-01'}):
            result = self.http(BATCHES, 'POST', {'request_key': 'confirmed', 'items': [confirmed]})['batch']
        path = BATCHES + '/' + result['id']
        self.http(self.client_path + '/documents', 'POST', {'filename': '资料.txt', 'text': '第二版资料。', 'update_document_id': self.doc['id']})
        self.s.batches.wake()
        first = self.batch(path)
        self.assertEqual((first['total'], first['completed'], first['video_total'], first['video_completed'], first['status']),
                         (2, 1, 1, 1, 'partial'))
        pinned = first['items'][0]['videos'][0]
        production = self.video.productions[pinned['production_id']]
        self.assertEqual(production['topic'], choices[-1]['topic'])
        self.assertEqual(production['context']['documents'][0]['text'], '首版资料。')
        self.assertIn('西邦24使用说明2', production['source']['title'])

        self.close_server()
        self.open_server()
        self.http(path + '/resume', 'POST', {})
        final = self.batch(path)
        self.assertEqual((final['completed'], final['video_completed'], final['status']), (2, 1, 'done'))
        self.assertEqual(final['items'][0]['videos'][0], pinned)
        prompts = [r['messages'][1]['content'] for r in self.model.requests if '【主关键词】' in r['messages'][1]['content']]
        self.assertEqual(len(prompts), 3)
        for prompt, row, choice in zip(prompts, (two, three, two), (choices[0], choices[1], choices[0])):
            self.assertIn(f"【主题】{choice['topic']}\n", prompt)
            self.assertIn(f"【主关键词】{row['keywords'][0]}。", prompt)
            self.assertIn('首版资料。', prompt)
            self.assertNotIn('第二版资料。', prompt)

    def test_preview_rejects_changed_document_revision_for_one_customer(self):
        other = self.http('/api/workbench/clients', 'POST', {'name': '另一客户'})['client']['id']
        items = [{'client_id': cid, 'options': self.selection(1)} for cid in (self.cid, other)]

        def preview():
            result = self.http(BATCHES + '/preflight', 'POST', {'items': items})
            self.assertTrue(result['ready'], result['issues'])
            return [row['preview'] for row in result['items']]

        original = preview()
        updated = self.http(self.client_path + '/documents', 'POST', {
            'filename': '资料.txt', 'text': '第二版资料。', 'update_document_id': self.doc['id']})['document']
        confirmed = [{**item, 'preview': {'revision': plan['revision'], 'rows': [{'id': plan['rows'][0]['id']}]}}
                     for item, plan in zip(items, original)]
        rejected = self.http(BATCHES, 'POST', {'request_key': 'stale', 'items': confirmed}, status=400)
        self.assertIn('预览依据已更新', rejected['error'])
        self.assertEqual(self.http(BATCHES)['batches'], [])
        current = preview()
        self.assertNotEqual(current[0]['revision'], original[0]['revision'])
        self.assertEqual(current[0]['documents'][0]['revision'], updated['revision'])
        self.assertEqual(current[1]['revision'], original[1]['revision'])

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
