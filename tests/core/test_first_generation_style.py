from http.client import HTTPConnection
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from app import prompts
from bridge import provider
from bridge.http import create_server


class FirstGenerationStyleTest(unittest.TestCase):
    def test_first_call_and_fixed_video_context_use_the_same_customer_snapshot(self):
        with tempfile.TemporaryDirectory(prefix='fangli-first-style-') as temp:
            server = create_server(Path(temp) / 'workbench.db', port=0)
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
            thread.start()
            try:
                self.verify(server)
            finally:
                server.shutdown(); thread.join(3); server.server_close()

    def verify(self, server):
        s = server.service
        s.catalog = [{'id': provider.DEFAULT_MODEL}]

        def http(path, method='GET', body=None, expected=200):
            conn = HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            try:
                conn.request(method, '/api/workbench' + path,
                             json.dumps(body, ensure_ascii=False).encode() if body is not None else None,
                             headers={'Content-Type': 'application/json'})
                resp = conn.getresponse()
                value = json.loads(resp.read())
                self.assertEqual(resp.status, expected, value)
                return value
            finally:
                conn.close()

        company = http('/clients', 'POST', {'name': '甲客户', 'profile': {'company': '甲公司', 'brand': '甲品牌', 'products': '型号A'}})['client']
        other = http('/clients', 'POST', {'name': '乙客户', 'profile': {'brand': '其他客户绝不引用标记'}})['client']
        cid = company['id']
        docs_path = f'/clients/{cid}/documents'
        doc = http(docs_path, 'POST', {'filename': '所选.md', 'kind': '文本', 'text': '型号A适用于钢件。\n\n先确认工件用途与涂布条件。'})['document']
        other_doc = http(f'/clients/{other["id"]}/documents', 'POST', {'filename': '乙.md', 'kind': '文本', 'text': '其他客户绝不引用标记'})['document']
        platform = next(p for p in s.store.list_platforms() if p['name'] == '知乎')
        selection = [{'platform_id': platform['id'], 'account_type': 'personal', 'count': 1}]
        http(f'/clients/{cid}/generation-plan', 'PUT', {'options': {'keywords': ['型号A'], 'selections': selection, 'note': '平时正文1100字'}, 'document_ids': [doc['id']]})
        conv = http('/conversations', 'POST', {'client_id': cid})['conversation']
        path = f'/conversations/{conv["id"]}'
        http(path + '/draft', 'PUT', {'options': {'note': '说明选型与试用', 'length_hint': '正文500—650字'}, 'document_ids': [doc['id']]})
        calls = []

        def events(payload):
            calls.append(payload)
            if payload['messages'][0]['content'] == prompts.AUDIT_RULES:
                value = {'findings': [{'quote': '初稿没有这句', 'kind': '争议'}],
                         'revised_body': '# 型号A的试用步骤\n\n' + '不应采用的替换正文。' * 10,
                         'verdict': 'revised'}
            else:
                value = {'title': '型号A的试用步骤', 'summary': '确认钢件用途，再安排试用。', 'sections': [{'heading': '试用准备', 'paragraphs': ['先确认工件用途和涂布条件。']}],
                         'key_facts': ['重复信息专属标记'], 'faq': [{'q': '重复问题专属标记', 'a': '同一结论'}], 'risk_notes': ['编辑备注专属标记']}
            yield {'type': 'delta', 'text': json.dumps(value, ensure_ascii=False)}
            yield {'type': 'done', 'finish_reason': 'stop'}

        with patch.object(provider, 'events', events):
            started = http(path + '/write-one', 'POST', {})
            worker = s.threads.get(started['job_id'])
            if worker: worker.join(8)
        self.assertEqual(s.ws.operation(started['operation_id'])['status'], 'done')
        self.assertEqual(len(calls), 2)
        item = http(path)['articles'][0]
        aid, vid = item['id'], item['current_version']
        vc = f'/video-context?client_id={cid}'
        fixed = vc + f'&article_id={aid}&version_id={vid}'
        context = http(fixed)
        system, user = [m['content'] for m in calls[0]['messages']]
        self.assertIn(context['style']['applied']['profiles'][0]['voice'], system)
        self.assertIn('正文500—650字', system)
        self.assertIn('sections 恰好2节', system)
        self.assertIn('核对事实的力度与条件', calls[1]['messages'][1]['content'])
        self.assertNotIn('1200-2000', system + user)
        self.assertNotIn('1100字', system + user)
        self.assertIn('先确认工件用途与涂布条件', user)
        self.assertNotIn('其他客户绝不引用标记', system + user)
        self.assertNotIn('编辑备注专属标记', context['source_article']['body_md'])
        self.assertNotIn('重复信息专属标记', context['source_article']['body_md'])
        self.assertNotIn('重复问题专属标记', context['source_article']['body_md'])
        self.assertNotIn('官网或电话合计出现', system)
        self.assertNotIn('不应采用的替换正文', context['source_article']['body_md'])
        self.assertEqual(context['editorial']['article_review']['status'], 'unverified')
        self.assertEqual(context['article']['native_audit']['unmatched_quotes'], 1)
        self.assertEqual(context['editorial']['length']['actual'], len('确认钢件用途，再安排试用。试用准备先确认工件用途和涂布条件。'))
        self.assertEqual(context['source_article']['body_md'], item['body_md'])
        self.assertEqual(context['request']['length']['source'], 'request')
        self.assertEqual([d['id'] for d in context['documents']], [doc['id']])
        self.assertEqual(context['documents'][0]['digest'], doc['digest'])
        self.assertEqual(context['documents'][0]['revision'], doc['revision'])

        http(docs_path, 'POST', {'filename': '新资料.md', 'kind': '文本', 'text': '改版后另选资料。'})
        http(f'/clients/{cid}', 'PUT', {'name': '新名称', 'profile': {**company['profile'], 'brand': '新品牌'}})
        s.store.update_platform(platform['id'], length_hint='最新配置200字')
        newer = http(path + f'/articles/{aid}', 'PUT', {'expected_version': vid, 'body_md': '# 人工稿\n\n确认样件。'})['article']
        self.assertNotEqual(newer['current_version'], vid)
        self.assertEqual(http(fixed), context)
        self.assertEqual(http(vc + f'&conversation_id={conv["id"]}')['documents'][0]['id'], doc['id'])
        self.assertIsNone(http(vc + f'&document_ids={doc["id"]}')['source_article'])
        http(vc + f'&document_ids={other_doc["id"]}', expected=400)
        http(fixed.replace(cid, other['id']), expected=404)
