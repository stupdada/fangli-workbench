"""Customer intake persistence and trust boundaries without provider calls."""
import base64
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

from bridge import client_intake, provider
from bridge.claim_search_provider import BailianClaimSearch, SearchUnavailable, candidates
from bridge.errors import Conflict, Missing, Problem
from bridge.native import LocalStore
from bridge.service import Service
from bridge.storage import PROFILE_FIELDS
from bridge.topic_suggestions import recommendation_input


def model_result(ref):
    suggestion = {'name': '资料客户', **dict.fromkeys(PROFILE_FIELDS, '')}
    suggestion.update(company='资料公司', brand='资料品牌', products='资料产品')
    return {'profile_suggestion': suggestion, 'profile_sources': {k: [ref] if v else [] for k,v in suggestion.items()},
            'keywords': [{'text': '资料产品', 'source_refs': [ref]}],
            'overview': {'text': '资料客户供应资料产品。', 'source_refs': [ref]},
            'important_claims': [{'text': '本地供货', 'source_refs': [ref], 'public_check_status': 'verified'}],
            'conflicts': [{'topic': '供货说法', 'detail': '一处写仅本地，另一处写全国配送。', 'source_refs': [ref]}]}


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.s = Service(LocalStore(Path(self.tmp.name) / 'intake.db'))
        self.s.catalog = [{'id': provider.DEFAULT_MODEL}]
        self.release = threading.Event()
        self.release.set()
        self.calls = []
        self.intake = client_intake.ClientIntake(self.s, self.chat)
        self.cid = self.s.ws.save_client('自填客户', {'company':'人工公司'})['id']
        self.doc = self.upload(self.cid)

    def tearDown(self):
        self.release.set()
        self.s.close()
        self.tmp.cleanup()

    def chat(self, messages, settings, **kwargs):
        doc = json.loads(messages[1]['content'])['documents'][0]
        self.calls.append((doc['filename'], settings['model'], kwargs))
        self.release.wait(3)
        return json.dumps(model_result(next(iter(doc['passages']))), ensure_ascii=False)

    def upload(self, cid, text='资料公司经营资料品牌的资料产品。一处写仅本地，一处写全国配送。', **kwargs):
        return self.s.ws.files.import_document(cid, {'filename': '测试资料.md',
            'content_b64': base64.b64encode(text.encode()).decode(), **kwargs})['document']

    def ready(self, docs=None):
        outcome = self.intake.start(self.cid, {'document_ids': docs or [self.doc['id']]})
        ident = outcome['intake']['id']
        thread = self.s.threads.get(ident)
        if thread: thread.join(3)
        record = self.intake.get(self.cid, ident)
        self.assertEqual(record['status'], 'ready', record['error'])
        return record

    def body(self, record):
        return {**record['proposed_client'], 'editorial': record['result'],
                'expected_profile_version': record['expected_profile_version'], 'expected_adoption_id':record['expected_adoption_id']}

    def test_import_resumes_after_restart_and_promotes_only_on_confirmation(self):
        ident = str(uuid.uuid4())
        self.assertEqual(self.s.ws.start_import(ident, '')['id'], ident)
        good = self.upload(ident)
        bad_bytes = b'not a supported document'
        bad = self.s.ws.files.import_document(ident, {'filename':'待补录.pdf',
            'content_b64':base64.b64encode(bad_bytes).decode()})['document']
        self.assertEqual(bad['status'], 'pending')
        self.assertNotIn(ident, {c['id'] for c in self.s.ws.clients()})
        with self.assertRaises(Conflict):
            self.s.create_conversation(ident)
        with self.assertRaises(Conflict):
            self.intake.start(ident, {'document_ids':[good['id']]})
        self.s.close()
        self.s = Service(LocalStore(Path(self.tmp.name) / 'intake.db'))
        self.s.catalog = [{'id':provider.DEFAULT_MODEL}]
        self.intake = client_intake.ClientIntake(self.s, self.chat)
        self.assertEqual(self.s.ws.import_drafts()[0]['document_count'], 2)
        self.assertEqual(self.s.ws.files.retry_import(ident, bad['id'], {})['outcome'], 'pending')
        repaired = self.s.ws.files.retry_import(ident, bad['id'], {'text':'校对后的原件说明。'})['document']
        self.assertEqual(repaired['group_id'], bad['group_id'])
        self.assertEqual(self.s.ws.files.download(ident, repaired['id'], original=True)[0], bad_bytes)
        self.assertEqual({d['id'] for d in self.s.ws.files.draft_current(ident)}, {good['id'],repaired['id']})
        self.cid = ident
        record = self.ready([good['id'],repaired['id']])
        self.assertEqual(record['proposed_client']['name'], '资料客户')
        self.assertNotIn(ident, {c['id'] for c in self.s.ws.clients()})
        collision = self.s.ws.save_client('资料客户', {})['id']
        with self.assertRaises(Conflict):
            self.intake.adopt(ident, record['id'], self.body(record))
        self.assertEqual(self.s.ws.import_drafts()[0]['id'], ident)
        self.s.ws.archive_client(collision)
        saved = self.intake.adopt(ident, record['id'], self.body(record))
        self.assertEqual(saved['client']['id'], ident)
        self.assertFalse(self.s.ws.import_drafts())
        self.assertEqual(self.intake.repo.adopted_keywords(ident), ['资料产品'])
        self.assertEqual(self.intake.adopt(ident, record['id'], self.body(record))['client']['id'], ident)

    def test_concurrent_reuse_explicit_adoption_and_isolation(self):
        self.release.clear()
        start = self.intake.start(self.cid, {'document_ids':[self.doc['id']]})
        repeat = self.intake.start(self.cid, {'document_ids':[self.doc['id']]})
        self.assertTrue(repeat['reused'])
        self.assertEqual(start['intake']['id'], repeat['intake']['id'])
        self.release.set()
        record = self.ready()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.s.ws.client(self.cid)['profile']['brand'], '')
        self.assertEqual(record['proposed_client']['profile']['company'], '人工公司')
        self.assertEqual({c['field'] for c in record['profile_conflicts']}, {'name','company'})
        self.assertEqual(record['result']['important_claims'][0]['public_check_status'], 'not_checked')
        self.assertEqual(record['result']['conflicts'][0]['source_refs'][0]['revision'], self.doc['revision'])
        self.assertEqual(self.s.customers.plan(self.cid)['available_keywords'], [])
        body = self.body(record)
        body['profile']['brand'] = '人工校订品牌'
        body['editorial']['overview']['text'] = '人工确认的业务概览。'
        saved = self.intake.adopt(self.cid, record['id'], body)
        self.assertEqual(saved['client']['profile']['brand'], '人工校订品牌')
        self.assertEqual(saved['intake']['adoption']['editorial']['overview']['text'], '人工确认的业务概览。')
        keywords = [item['text'] for item in body['editorial']['keywords']]
        self.assertEqual(self.s.customers.plan(self.cid)['available_keywords'], keywords)
        task = self.s.create_conversation(self.cid)
        self.assertEqual(task['brief']['keywords'], keywords)
        self.assertEqual(task['document_ids'], [self.doc['id']])
        source = {'brief': task['brief'], 'documents': self.s.ws.selected_documents(task), 'platforms': []}
        slots = [{'id': '1', 'kind': 'article'}]
        payload = recommendation_input(self.s.freeze_creation_context(self.cid, source), slots)
        self.assertEqual(payload['overview'], '人工确认的业务概览。')
        self.assertNotIn('documents', payload)
        dialogue_payload = recommendation_input(self.s.freeze_creation_context(self.cid, source), slots, dialogue=True)
        self.assertEqual(dialogue_payload['overview'], payload['overview'])
        self.assertEqual(dialogue_payload['client'], {'name': task['brief']['client']})
        self.assertNotIn('documents', dialogue_payload)
        self.assertNotIn('verified_facts', dialogue_payload)
        reused = self.ready()
        self.assertEqual(reused['proposed_client']['profile']['brand'], '人工校订品牌')
        self.assertEqual(len(self.calls), 1)
        other = self.s.ws.save_client('另一客户')['id']
        with self.assertRaises(Missing): self.intake.get(other,record['id'])
        with self.assertRaises(Missing): self.intake.adopt(other,record['id'],body)
        with self.assertRaises(Problem): self.intake.start(other,{'document_ids':[self.doc['id']]})
        self.assertEqual(len(self.calls),1)
        new = self.upload(self.cid, '开头 ' * 1000 + '资料产品新版说明。', update_document_id=self.doc['id'])
        source['documents'] = self.s.ws.selected_documents(task, [new['id']])
        payload = recommendation_input(self.s.freeze_creation_context(self.cid, source), slots)
        self.assertNotIn('overview', payload)
        self.assertIn('资料产品新版说明', payload['documents'][0]['excerpt'])
        self.assertLessEqual(len(payload['documents'][0]['excerpt']), 350)

    def test_concurrent_profile_and_source_revision_reject_adoption(self):
        old = self.ready()
        self.s.ws.save_client('外部人工更新', {'products':'手填产品'}, self.cid)
        with self.assertRaisesRegex(Conflict, '档案已更新'):
            self.intake.adopt(self.cid,old['id'],self.body(old))
        rebased = self.intake.get(self.cid,old['id'])
        self.assertEqual(rebased['proposed_client']['profile']['products'], '手填产品')
        newer = self.upload(self.cid,'资料公司经营资料品牌的资料产品，新版调整描述。',update_document_id=self.doc['id'])
        with self.assertRaisesRegex(Conflict, '资料已有新修订'):
            self.intake.adopt(self.cid,old['id'],self.body(rebased))
        updated = self.ready([newer['id']])
        self.assertNotEqual(old['id'],updated['id'])
        with patch.object(client_intake,'RULE_VERSION','next-rule'):
            new_rule = self.ready([newer['id']])
        self.assertNotEqual(updated['id'],new_rule['id'])
        self.assertEqual(len(self.calls),3)

    def test_reject_fabricated_excerpt_and_second_adoption_of_same_base(self):
        record = self.ready()
        body = self.body(record)
        body['editorial']['overview']['source_refs'][0]['quote'] = '这句并不存在。'
        with self.assertRaisesRegex(Problem,'原文不一致'):
            self.intake.adopt(self.cid,record['id'],body)
        record = self.intake.get(self.cid,record['id'])
        # Do not alter the official profile so the editorial version guard is tested independently.
        body = self.body(record) | {k:record['current_client'][k] for k in ('name','profile')}
        self.intake.adopt(self.cid,record['id'],body)
        with self.assertRaisesRegex(Conflict,'采用记录已更新'):
            self.intake.adopt(self.cid,record['id'],body)

    def test_model_citation_resolves_to_exact_multiline_source(self):
        quote = '资料公司  供应资料产品。\n仅限本地配送（周一至周五）。'
        doc = self.upload(self.cid, quote + '\n\n' + '文' * 400, update_document_id=self.doc['id'])
        record = self.ready([doc['id']])
        self.assertEqual(record['result']['overview']['source_refs'], [{
            'document_id': doc['id'], 'quote': quote, 'filename': doc['filename'],
            'revision': doc['revision'], 'digest': doc['digest'],
        }])
        self.intake.adopt(self.cid, record['id'], self.body(record))

    def test_model_citation_must_exist_in_this_request(self):
        self.intake.chat = lambda *args, **kwargs: json.dumps(model_result('S999999'))
        start = self.intake.start(self.cid, {'document_ids': [self.doc['id']]})
        ident = start['intake']['id']
        thread = self.s.threads.get(ident)
        if thread:
            thread.join(3)
        record = self.intake.get(self.cid, ident)
        self.assertEqual(record['status'], 'error')
        self.assertIn('无法定位的资料段落', record['error'])
        self.assertEqual(record['result'], {})

    def test_reports_live_stages_until_result_is_ready(self):
        progress = []

        def observe():
            progress.append(self.intake.latest(self.cid)['intake']['progress'])

        def chat(*args, **kwargs):
            observe()
            return self.chat(*args, **kwargs)

        def validate(*args, **kwargs):
            observe()
            return original_validate(*args, **kwargs)

        original_validate = client_intake.validate_result
        self.intake.chat = chat
        with patch.object(self.s, 'ensure_model', side_effect=lambda settings: observe()), \
                patch.object(client_intake, 'validate_result', side_effect=validate):
            record = self.ready()
        self.assertEqual([step['stage'] for step in progress], ['prepare', 'organize', 'verify'])
        elapsed = [step['elapsed_seconds'] for step in progress]
        self.assertEqual(elapsed, sorted(elapsed))
        self.assertGreaterEqual(elapsed[0], 0)
        self.assertIsNone(record['progress'])

    def test_public_claim_search_reuses_exact_revision_and_editor_keeps_evidence(self):
        url = 'https://issuer.example/certificate'
        calls = []

        def search(query):
            calls.append(query)
            return [{'url':url,'title':'原始证书','snippet':'提供者的搜索摘要'}] if len(calls) == 1 else []

        self.intake.claim_checks.search_provider = search
        search.configured = lambda: True
        record = self.ready()
        claim = record['result']['important_claims'][0]
        key = claim['claim_key']
        with self.assertRaises(Problem):
            self.intake.search_claim(self.cid,record['id'],key,{'query':'公开证书','source_refs':claim['source_refs']})
        found = self.intake.search_claim(self.cid,record['id'],key,{'query':'资料产品 发证机构'})
        self.assertEqual(found['check']['status'],'candidates')
        self.assertIsNone(found['check']['evidence'])
        other = self.s.ws.save_client('另一客户')['id']
        with self.assertRaises(Missing):
            self.intake.search_claim(other,record['id'],key,{'query':'资料产品'})
        review = {'url':url,'status':'conflict','source_type':'issuer','quote':'证书不包括该型号。',
                  'subject':'资料产品','conditions':'仅适用 X 型号','expected_revision':1}
        with self.assertRaisesRegex(Problem,'本次搜索'):
            self.intake.review_claim(self.cid,record['id'],key,{**review,'url':'https://unseen.example'})
        direct = self.intake.review_claim(self.cid,record['id'],key,review)['check']
        self.assertEqual(direct['evidence']['url'],url)
        self.assertEqual(direct['evidence']['candidate_url'],url)
        follow = {**review,'expected_revision':direct['revision'],
                  'source_url':'https://issuer.example/product-sheet.pdf','source_title':'产品原始资料'}
        for fields, message in [({'source_title':''},'同时填写'),
                                ({'source_url':'javascript:alert(1)'},'HTTP 或 HTTPS'),
                                ({'source_url':'https://name:password@issuer.example/file'},'HTTP 或 HTTPS'),
                                ({'url':'https://unseen.example'},'本次搜索')]:
            with self.subTest(fields=fields), self.assertRaisesRegex(Problem,message):
                self.intake.review_claim(self.cid,record['id'],key,{**follow,**fields})
        checked = self.intake.review_claim(self.cid,record['id'],key,follow)['check']
        self.assertEqual(checked['status'],'conflict')
        self.assertEqual(checked['evidence']['quote'],review['quote'])
        self.assertEqual(checked['evidence']['url'],follow['source_url'])
        self.assertEqual(checked['evidence']['title'],follow['source_title'])
        self.assertEqual(checked['evidence']['candidate_url'],url)
        self.assertEqual(checked['evidence']['candidate_title'],'原始证书')
        self.assertEqual(checked['evidence']['reviewed_by'],'editor')
        self.assertTrue(checked['evidence']['checked_at'])
        with self.assertRaises(Conflict):
            self.intake.review_claim(self.cid,record['id'],key,follow)
        # Adoption and reopen preserve independently recorded evidence without a second search.
        self.intake.adopt(self.cid,record['id'],self.body(record))
        self.intake = client_intake.ClientIntake(self.s,self.chat,search)
        reused = self.intake.search_claim(self.cid,record['id'],key,{'query':'资料产品 发证机构'})
        self.assertTrue(reused['reused'])
        self.assertEqual(reused['intake']['adoption']['editorial']['important_claims'][0]['public_check'],checked)
        self.assertEqual(calls,['资料产品 发证机构'])
        doc = self.upload(self.cid,'新版资料明确资料产品仅用于指定场景。',update_document_id=self.doc['id'])
        updated = self.ready([doc['id']])
        current = updated['result']['important_claims'][0]
        self.assertNotEqual(current['claim_key'],key)
        self.assertEqual(current['public_check_status'],'not_checked')
        empty = self.intake.search_claim(self.cid,updated['id'],current['claim_key'],{'query':'资料产品 发证机构'})
        self.assertEqual(empty['check']['status'],'no_result')
        self.assertEqual(len(calls),2)


class ClaimSearchProviderTests(unittest.TestCase):
    def test_mcp_transport_sends_only_query_and_preserves_unconfirmed_links(self):
        from email.message import Message
        import io

        payloads = []

        class Response(io.BytesIO):
            def __init__(self, body, content_type):
                super().__init__(body)
                self.headers = Message()
                self.headers['Content-Type'] = content_type
                self.headers['Mcp-Session-Id'] = 'test-session'

        class Opener:
            def __init__(self, protocol):
                self.protocol = protocol

            def open(self, req, timeout):
                self_outer.assertEqual(req.full_url,'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp')
                message = json.loads(req.data)
                payloads.append(message)
                if message['method'] == 'initialize':
                    self_outer.assertEqual(message['params']['protocolVersion'], '2025-03-26')
                    reply = {'id':1,'result':{'protocolVersion':self.protocol}}
                    return Response(json.dumps(reply).encode(), 'application/json')
                self_outer.assertEqual(req.get_header('Mcp-session-id'),'test-session')
                self_outer.assertEqual(req.get_header('Mcp-protocol-version'),self.protocol)
                if message['method'] == 'notifications/initialized':
                    return Response(b'','application/json')
                result = {'id':2,'result':{'content':[{'type':'text','text':json.dumps([
                    {'title':'Issuer','url':'https://issuer.example/source','snippet':'Search snippet'}])}]}}
                return Response(f'data: {json.dumps(result)}\n\n'.encode(),'text/event-stream')

        self_outer = self
        with patch.dict('os.environ',{'DASHSCOPE_API_KEY':'test-key'}):
            for protocol in ('2025-03-26', '2024-11-05'):
                with self.subTest(protocol=protocol), patch('bridge.claim_search_provider.request.build_opener',return_value=Opener(protocol)):
                    payloads.clear()
                    leads = BailianClaimSearch()('issuer certificate 123')
                    self.assertEqual([p['method'] for p in payloads],['initialize','notifications/initialized','tools/call'])
                    self.assertEqual(payloads[-1]['params'],{'name':'bailian_web_search','arguments':{'query':'issuer certificate 123','count':8}})
                    self.assertEqual(leads,[{'title':'Issuer','url':'https://issuer.example/source','snippet':'Search snippet'}])
            with patch('bridge.claim_search_provider.request.build_opener',return_value=Opener('2022-01-01')):
                payloads.clear()
                with self.assertRaisesRegex(SearchUnavailable,'协议版本不受支持'):
                    BailianClaimSearch()('issuer certificate 123')
                self.assertEqual([p['method'] for p in payloads],['initialize'])

    def test_unusable_provider_output_does_not_become_no_result(self):
        self.assertEqual(candidates({'structuredContent':{'results':[]}}),[])
        with self.assertRaises(SearchUnavailable):
            candidates({'isError':True,'content':[]})
        with self.assertRaises(SearchUnavailable):
            candidates({'content':[{'type':'text','text':'Unknown response'}]})

    def test_bailian_pages_preserve_candidates_and_require_success_status(self):
        page = {'title':'Manufacturer','url':'https://maker.example/product','snippet':'Provider preview',
                'hostname':'maker.example','hostlogo':''}

        def envelope(pages, status):
            payload = {'pages':pages,'request_id':'sample','tools':[],'status':status}
            return {'isError':False,'content':[{'type':'text','text':json.dumps(payload)}]}

        self.assertEqual(candidates(envelope([page],0)),[{k:page[k] for k in ('title','url','snippet')}])
        self.assertEqual(candidates(envelope([],0)),[])
        with self.assertRaises(SearchUnavailable):
            candidates(envelope([],1))
