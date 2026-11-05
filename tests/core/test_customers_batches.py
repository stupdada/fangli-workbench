"""Owned-file, customer and queue trust boundaries over real local HTTP."""
import base64
import copy
import hashlib
import http.client
import io
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import zipfile
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bridge import provider
from bridge.http import create_server
from bridge.checks import article_checks
from app import render, prompts, seeds
from test_workbench import ControlledModel


class CustomersAndBatches(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fangli-customers-')
        self.db = Path(self.temp.name) / 'workbench.db'
        self.model = ControlledModel()
        self.mock = patch.object(provider, 'events', self.model.events)
        self.mock.start()
        self.open_server()
        self.cid = self.customer('长期客户')['id']
        self.base = '/api/workbench/clients/' + self.cid
        self.platform = self.s.store.list_platforms()[0]

    def open_server(self):
        self.server = create_server(self.db, port=0)
        self.s = self.server.service
        self.s.catalog = [{'id': provider.DEFAULT_MODEL}]
        self.http_thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        self.http_thread.start()

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.http_thread.join(3)

    def tearDown(self):
        self.model.release.set()
        self.close_server()
        self.mock.stop()
        self.temp.cleanup()

    def http(self, path, method='GET', body=None, expected=200, raw=False):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        conn.request(method, path, json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None,
                     {'Content-Type': 'application/json'})
        response = conn.getresponse()
        data = response.read()
        conn.close()
        self.assertEqual(response.status, expected, data[:800])
        return data if raw else json.loads(data)

    def customer(self, name):
        return self.http('/api/workbench/clients', 'POST', {'name': name, 'profile': {'brand': '西邦', 'company': '旧公司', 'website': 'fixture.example'}})['client']

    def document(self, name='资料.txt', text='西邦24用于资料指定场景。', **extra):
        body = {'filename': name, 'content_b64': base64.b64encode(text.encode('utf-8')).decode(), **extra}
        return self.http(self.base + '/documents', 'POST', body)

    def plan(self, cid=None, ids=None, count=1):
        return self.http('/api/workbench/clients/' + (cid or self.cid) + '/generation-plan', 'PUT',
                         {'options': {'keywords': ['西邦24', '材料选型'],
                                      'selections': [{'platform_id': self.platform['id'], 'account_type': 'official', 'count': count}],
                                      'note': '长期要求。'},
                          'document_ids': ids or []})

    def submit(self, key, items=None):
        return self.http('/api/workbench/batches', 'POST', {'request_key': key, 'items': items or [{'client_id': self.cid}]})['batch']

    def test_hash_alias_update_and_old_task_preserved(self):
        old = self.document()['document']
        duplicate = self.document('资料（1）.txt')
        self.assertEqual(duplicate['outcome'], 'duplicate')
        self.assertEqual(duplicate['document']['id'], old['id'])
        self.assertEqual(self.http(old['original_url'], raw=True), '西邦24用于资料指定场景。'.encode())
        sha = old['raw_sha256']
        check = self.http(self.base + '/documents/check', 'POST', {'filename': '其他名称.txt', 'sha256': sha})
        self.assertEqual(check['duplicate']['id'], old['id'])
        self.plan(ids=[old['id']])
        conv = self.http('/api/workbench/conversations', 'POST', {'client_id': self.cid})['conversation']
        needs = self.document('资料（1）.txt', '更新后的西邦24资料。')
        self.assertEqual(needs['outcome'], 'needs_resolution')
        self.assertEqual(needs['candidates'][0]['id'], old['id'])
        newer = self.document('资料（1）.txt', '更新后的西邦24资料。', update_document_id=old['id'])['document']
        self.assertEqual(newer['revision'], 2)
        self.assertEqual(newer['group_id'], old['group_id'])
        self.assertEqual(self.s.ws.selected_documents(conv)[0]['text'], old['text'])
        current_plan = self.http(self.base + '/generation-plan')['plan']
        self.assertEqual(current_plan['document_ids'], [newer['id']])
        next_conv = self.http('/api/workbench/conversations', 'POST', {'client_id': self.cid})['conversation']
        self.assertEqual(next_conv['document_ids'], [newer['id']])
        profile = copy.deepcopy(self.s.ws.client(self.cid)['profile'])
        profile['company'] = '新公司'
        self.http(self.base, 'PUT', {'name': '客户改名', 'profile': profile})
        self.assertEqual(self.s.ws.conversation(conv['id'])['brief']['company'], '旧公司')
        self.assertEqual(self.http('/api/workbench/conversations', 'POST', {'client_id': self.cid})['conversation']['brief']['company'], '新公司')
        self.assertEqual(len(self.http(self.base + '/documents/' + old['id'] + '/revisions')['documents']), 2)
        self.http(self.base + '/generation-plan', 'PUT', {'options': current_plan['options'], 'document_ids': [newer['id']], 'expected_revision': 0}, expected=409)

    def test_binary_same_text_pending_and_customer_isolation(self):
        def docx(meta):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as z:
                z.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>这是一份正文相同但原文件元数据不同的客户资料。</w:t></w:r></w:p></w:body></w:document>')
                z.writestr('metadata.txt', meta)
            return base64.b64encode(buffer.getvalue()).decode()
        old = self.http(self.base + '/documents', 'POST', {'filename': '档案.docx', 'content_b64': docx('a')})['document']
        result = self.http(self.base + '/documents', 'POST', {'filename': '完全不同名称.docx', 'content_b64': docx('b')})
        self.assertEqual(result['outcome'], 'needs_resolution')
        self.assertEqual(result['text_matches'][0]['id'], old['id'])
        updated = self.http(self.base + '/documents', 'POST', {'filename': '档案(1).docx', 'content_b64': docx('b'), 'update_document_id': old['id']})['document']
        self.assertNotEqual(old['raw_sha256'], updated['raw_sha256'])
        self.assertEqual(old['digest'], updated['digest'])
        pending = self.document('档案.bin', '不支持的格式', update_document_id=updated['id'])['document']
        self.assertEqual(pending['status'], 'pending')
        self.assertTrue(pending['has_original'])
        self.assertTrue(next(d for d in self.http(self.base + '/documents')['documents'] if d['id'] == updated['id'])['is_current'])
        self.http(self.base + '/generation-plan', 'PUT', {'options': {}, 'document_ids': [pending['id']]}, expected=400)
        other = self.customer('其他客户')['id']
        self.http('/api/workbench/clients/' + other + '/documents/' + old['id'] + '/original', expected=404)
        self.http(self.base + '/documents', 'POST', {'filename': '../逃逸.txt', 'text': '文字'}, expected=400)

    def test_task_override_is_not_customer_update_and_persistence(self):
        doc = self.document()['document']
        self.plan(ids=[doc['id']])
        conv = self.s.create_conversation(self.cid)
        profile = copy.deepcopy(self.s.ws.client(self.cid)['profile'])
        profile['company'] = '仅本次公司'
        self.http('/api/workbench/conversations/' + conv['id'] + '/profile', 'PUT', {'name': '本次名称', 'profile': profile})
        self.assertEqual(self.s.ws.client(self.cid)['profile']['company'], '旧公司')
        self.close_server()
        self.open_server()
        self.assertEqual(self.http(doc['original_url'], raw=True), '西邦24用于资料指定场景。'.encode())
        self.assertEqual(self.http(self.base + '/generation-plan')['plan']['document_ids'], [doc['id']])
        self.assertEqual(self.s.ws.conversation(conv['id'])['brief']['company'], '仅本次公司')
        with self.s.store.conn() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM wb_document_groups').fetchone()[0], 1)

    def test_batch_preflight_idempotency_multiple_runs_and_frozen_input(self):
        doc = self.document()['document']
        self.plan(ids=[doc['id']])
        other = self.customer('客户二')['id']
        self.plan(cid=other)
        before = len(self.s.ws.conversations())
        preflight = self.http('/api/workbench/batches/preflight', 'POST', {'items': [{'client_id': 'missing'}, {'client_id': self.cid, 'options': {'keywords': []}}]})
        self.assertFalse(preflight['ready'])
        self.assertEqual(len(preflight['issues']), 2)
        self.assertEqual(len(self.s.ws.conversations()), before)
        self.model.gate_kind = 'generate'
        items = [{'client_id': self.cid}, {'client_id': other}]
        first = self.submit('first-click', items)
        self.assertTrue(self.model.entered.wait(4))
        self.assertEqual(self.submit('first-click', items)['id'], first['id'])
        self.http('/api/workbench/batches', 'POST', {'request_key': 'first-click', 'items': [{'client_id': self.cid}]}, expected=409)
        profile = copy.deepcopy(self.s.ws.client(other)['profile'])
        profile['company'] = '后来更改公司'
        self.http('/api/workbench/clients/' + other, 'PUT', {'name': '客户二', 'profile': profile})
        self.http('/api/workbench/settings', 'POST', {'temperature': 1.1, 'max_tokens': 4000})
        newer = self.document(text='第二版正文，保留已确认的完整客户信息。', update_document_id=doc['id'])['document']
        second = self.submit('second-click')
        self.assertNotEqual(first['id'], second['id'])
        self.model.release.set()
        self.assertTrue(self.s.batches.idle.wait(10))
        self.assertEqual(self.http('/api/workbench/batches/' + first['id'])['batch']['status'], 'done')
        self.assertEqual(self.http('/api/workbench/batches/' + second['id'])['batch']['status'], 'done')
        self.assertEqual(self.model.generated, 3)
        requests = [r for r in self.model.requests if r['messages'][0]['content'] != prompts.AUDIT_RULES]
        self.assertNotIn('后来更改公司', json.dumps(requests[1]['messages'], ensure_ascii=False))
        self.assertNotEqual(requests[0]['temperature'], requests[2]['temperature'])
        self.assertIn('第二版正文', requests[2]['messages'][1]['content'])
        audits = [r for r in self.model.requests if '事实核查员' in r['messages'][0]['content']]
        self.assertIn('fixture.example', audits[0]['messages'][1]['content'])
        history = self.http(self.base + '/history')
        self.assertEqual(len(history['batches']), 2)
        self.assertEqual(self.http(self.base + '/generation-plan')['plan']['options']['note'], '长期要求。')
        self.assertEqual(self.model.catalog_calls, 0)

    def test_interrupted_requires_explicit_resume_and_completed_not_repeated(self):
        self.plan(count=2)
        self.model.gate_kind, self.model.gate_index = 'generate', 2
        batch = self.submit('interrupted-click')
        self.assertTrue(self.model.entered.wait(4))
        self.model.fail_kind = 'generate'
        self.model.release.set()
        self.assertTrue(self.s.batches.idle.wait(8))
        self.assertEqual(self.http('/api/workbench/batches/' + batch['id'])['batch']['status'], 'interrupted')
        self.assertEqual(self.s.batches.get(batch['id'])['completed'], 1)
        self.http('/api/workbench/batches/' + batch['id'] + '/resume', 'POST', {}, expected=409)
        self.model.fail_kind = None
        self.http('/api/workbench/batches/' + batch['id'] + '/resume', 'POST', {'acknowledge_uncertain': True})
        self.assertTrue(self.s.batches.idle.wait(8))
        self.assertEqual(self.s.batches.get(batch['id'])['status'], 'done')
        self.assertEqual(self.s.batches.get(batch['id'])['completed'], 2)
        self.assertEqual(self.model.generated, 3)

    def test_stopped_queue_preserves_completed_article(self):
        self.plan()
        other = self.customer('排队客户')['id']
        self.plan(cid=other)
        self.model.gate_kind = 'generate'
        batch = self.submit('stop-click', [{'client_id': self.cid}, {'client_id': other}])
        self.assertTrue(self.model.entered.wait(4))
        self.http('/api/workbench/batches/' + batch['id'] + '/stop', 'POST', {})
        self.model.release.set()
        self.assertTrue(self.s.batches.idle.wait(8))
        self.assertEqual(self.s.batches.get(batch['id'])['completed'], 1)
        self.http('/api/workbench/batches/' + batch['id'] + '/resume', 'POST', {})
        self.assertTrue(self.s.batches.idle.wait(8))
        self.assertEqual(self.s.batches.get(batch['id'])['status'], 'done')
        self.assertEqual(self.model.generated, 2)

    def test_restart_marks_inflight_uncertain_without_model_replay(self):
        self.plan()
        with patch.object(self.s.batches, 'wake'):
            batch = self.submit('crash-fixture')
        with self.s.store.conn() as c:
            c.execute("UPDATE wb_batch_items SET status='running' WHERE batch_id=?", (batch['id'],))
            c.execute("UPDATE wb_batches SET status='running' WHERE id=?", (batch['id'],))
        self.close_server()
        self.open_server()
        self.assertEqual(self.s.batches.get(batch['id'])['status'], 'interrupted')
        self.assertEqual(self.model.generated, 0)
        self.assertEqual(self.model.catalog_calls, 0)
        self.http('/api/workbench/batches/' + batch['id'] + '/resume', 'POST', {}, expected=409)
        self.http('/api/workbench/batches/' + batch['id'] + '/resume', 'POST', {'acknowledge_uncertain': True})
        self.assertTrue(self.s.batches.idle.wait(8))
        self.assertEqual(self.s.batches.get(batch['id'])['status'], 'done')

    def test_failed_storage_cleans_copies_and_pending_pdf_can_be_fixed(self):
        with self.s.store.conn() as c:
            c.execute("CREATE TRIGGER reject_asset BEFORE INSERT ON wb_document_assets BEGIN SELECT RAISE(ABORT,'fixture'); END")
        self.http(self.base + '/documents', 'POST', {'filename': '回滚资料.txt', 'text': '用于验证数据库失败时副本会被清理。'}, expected=500)
        self.assertEqual(self.s.ws.documents(self.cid), [])
        self.assertEqual(list((Path(self.temp.name) / 'clients').rglob('parsed.txt')), [])
        with self.s.store.conn() as c:
            c.execute('DROP TRIGGER reject_asset')
        old = self.document()['document']
        raw = base64.b64encode(b'%PDF-1.7\nfixture').decode()
        pending = self.http(self.base + '/documents', 'POST', {'filename': '资料.pdf', 'content_b64': raw, 'update_document_id': old['id']})['document']
        self.assertEqual(pending['status'], 'pending')
        fixed = self.http(self.base + '/documents', 'POST', {'filename': '资料.pdf', 'content_b64': raw, 'text': '本机读取并核对后的新版PDF资料正文。', 'update_document_id': pending['id']})['document']
        self.assertEqual(fixed['status'], 'ready')
        self.assertTrue(fixed['is_current'])
        self.assertEqual(fixed['group_id'], old['group_id'])
        self.http(self.base + '/documents', 'POST', {'filename': '资料.pdf', 'content_b64': raw,
            'text': '另一次已过期的PDF文字修改。', 'update_document_id': pending['id']}, expected=409)

    def test_legacy_text_database_migrates_without_inventing_originals(self):
        old = self.s.ws.put_document(self.cid, '历史资料.txt', '文本', '历史数据库中已存在的客户资料正文。')
        conv = self.s.create_conversation(self.cid)
        self.s.ws.update_conversation(conv['id'], document_ids=[old['id']])
        self.close_server()
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute('DROP TABLE wb_document_assets')
            c.execute('DROP TABLE wb_document_groups')
            c.execute('CREATE TABLE legacy_docs(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,filename TEXT NOT NULL,kind TEXT,text TEXT NOT NULL,digest TEXT NOT NULL,created_at TEXT,UNIQUE(client_id,digest,filename))')
            c.execute('INSERT INTO legacy_docs SELECT * FROM wb_documents')
            c.execute('DROP TABLE wb_documents')
            c.execute('ALTER TABLE legacy_docs RENAME TO wb_documents')
        self.open_server()
        legacy = self.http(self.base + '/documents')['documents'][0]
        self.assertFalse(legacy['has_original'])
        self.assertEqual(legacy['id'], old['id'])
        self.assertEqual(self.s.ws.selected_documents(self.s.ws.conversation(conv['id']))[0]['text'], old['text'])
        self.http(self.base + '/documents/' + old['id'] + '/original', expected=404)
        restored = self.document('历史资料.txt', old['text'], update_document_id=old['id'])['document']
        self.assertTrue(restored['has_original'])
        self.assertEqual(restored['group_id'], legacy['group_id'])

    def test_checks_follow_platform_headings_and_do_not_claim_quality(self):
        platform = next(p for p in seeds.PLATFORMS if p['name'] == '知乎')
        body = render.render_md({'title': '西邦24资料', 'key_facts': ['条件一', '条件二', '条件三']},
                                '知乎', '图文', '', prompts.layout_for(platform, '图文'))
        article = {'title': '西邦24资料', 'body_md': body, 'platform_name': '知乎', 'fmt': '图文'}
        checked = article_checks(article, render.geo_check(article, '西邦24'))
        self.assertTrue(next(c for c in checked['checks'] if c['name'] == '关键信息独立成段')['ok'])
        self.assertNotIn('篇幅达标', [c['name'] for c in checked['checks']])
        self.assertNotIn('开篇直接给结论', [c['name'] for c in checked['checks']])
        self.assertEqual(checked['score_kind'], 'legacy_rule_ratio')

    def test_concurrent_resubmission_and_atomic_preflight(self):
        self.plan()
        count = len(self.s.ws.conversations())
        self.http('/api/workbench/batches', 'POST', {'request_key': 'malformed-click', 'items': [
            {'client_id': 123}]}, expected=400)
        self.http(self.base + '/documents', 'POST', {'filename': '无效资料.txt', 'text': '文字', 'update_document_id': []}, expected=400)
        self.http('/api/workbench/batches', 'POST', {'request_key': 'invalid-click', 'items': [
            {'client_id': self.cid}, {'client_id': 'missing-customer'}]}, expected=400)
        self.assertEqual(len(self.s.ws.conversations()), count)
        with patch.object(self.s.batches, 'wake'):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: self.submit('concurrent-click'), range(2)))
        self.assertEqual(results[0]['id'], results[1]['id'])
        self.assertEqual(len(self.s.ws.conversations()), count + 1)
        conv_id = results[0]['items'][0]['conversation_id']
        context = self.http('/api/workbench/conversations/' + conv_id)['batch']
        self.assertEqual(context['id'], results[0]['id'])
        self.assertTrue(context['frozen'])
        self.assertEqual(context['item_status'], 'queued')
        self.http('/api/workbench/conversations/' + conv_id, 'DELETE', {}, expected=409)
        self.http('/api/workbench/conversations/' + conv_id + '/draft', 'PUT', {'options': {'note': '改动冻结安排'}}, expected=409)
        self.http('/api/workbench/batches/' + results[0]['id'] + '/stop', 'POST', {})


if __name__ == '__main__':
    unittest.main(verbosity=2)
