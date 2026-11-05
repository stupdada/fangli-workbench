"""Customer-scoped public evidence for exact claims and source revisions."""
from datetime import datetime, timezone
import threading

from .claim_search_provider import BailianClaimSearch, public_url
from .errors import Conflict, Missing, Problem
from .intake_repository import fingerprint
from .storage import dumps, loads, text_value

RULE = 'public-claim-v1'


def claim_key(claim):
    sources = sorted((r['document_id'], r['revision'], r['digest'], r['quote']) for r in claim['source_refs'])
    return fingerprint({'rule':RULE, 'claim':claim['text'], 'sources':sources})


def checked_at():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


class PublicClaimChecks:
    def __init__(self, store, provider=None):
        self.store, self.search_provider = store, provider or BailianClaimSearch()
        self.lock = threading.Lock()
        self.inflight = set()
        with store.conn() as c:
            c.execute('''CREATE TABLE IF NOT EXISTS wb_public_claim_checks(
                client_id TEXT NOT NULL, claim_key TEXT NOT NULL, record TEXT NOT NULL,
                PRIMARY KEY(client_id, claim_key))''')

    def configured(self):
        return self.search_provider.configured()

    @staticmethod
    def _find(c, cid, key):
        row = c.execute('SELECT record FROM wb_public_claim_checks WHERE client_id=? AND claim_key=?', (cid,key)).fetchone()
        return loads(row['record']) if row else None

    def enrich(self, cid, editorial):
        if 'important_claims' not in editorial:
            return editorial
        with self.store.conn() as c:
            claims = []
            for claim in editorial['important_claims']:
                key = claim_key(claim)
                check = self._find(c, cid, key)
                claims.append({**claim, 'claim_key':key, 'public_check_status':check['status'] if check else 'not_checked',
                               'public_check':check})
        return {**editorial, 'important_claims':claims}

    def search(self, cid, key, query):
        query = text_value(query, '公开检索词', 120, empty=False).strip()
        if not query.isprintable():
            raise Problem('请用一行公开检索词')
        with self.lock:
            with self.store.conn() as c:
                old = self._find(c, cid, key)
            if old:
                return old, True
            if (cid,key) in self.inflight:
                raise Conflict('此说法正在搜索，请稍后查看')
            self.inflight.add((cid,key))
        try:
            results = self.search_provider(query)
            check = {'revision':1,'status':'candidates' if results else 'no_result','searched_at':checked_at(),
                     'provider':'bailian_web_search','query':query,'candidates':results,'evidence':None}
            with self.store.conn() as c:
                c.execute('INSERT INTO wb_public_claim_checks VALUES(?,?,?)', (cid,key,dumps(check)))
            return check, False
        finally:
            with self.lock:
                self.inflight.discard((cid,key))

    def review(self, cid, key, body):
        status = body.get('status')
        if status not in ('supported','conflict'):
            raise Problem('请选择核对结论')
        if body.get('source_type') not in ('manufacturer','issuer','original'):
            raise Problem('请选择原厂、发证机构或原始资料')
        quote = text_value(body.get('quote'), '来源原文摘录', 2000, empty=False).strip()
        subject = text_value(body.get('subject'), '适用主体', 200, empty=False).strip()
        conditions = text_value(body.get('conditions'), '适用条件', 600, empty=False).strip()
        source_url = text_value(body.get('source_url',''), '原始出处网址', 2000).strip()
        source_title = text_value(body.get('source_title',''), '原始出处标题', 300).strip()
        if bool(source_url) != bool(source_title):
            raise Problem('请同时填写原始出处网址和标题')
        if source_url and not public_url(source_url):
            raise Problem('原始出处需要有效的公开 HTTP 或 HTTPS 网址')
        version = body.get('expected_revision')
        if type(version) is not int:
            raise Problem('核对记录版本不正确')
        with self.store.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            check = self._find(c, cid, key)
            if not check:
                raise Missing('此说法没有已保存的搜索结果')
            if check['revision'] != version:
                raise Conflict('核对记录已更新，请重新打开后保存')
            candidate = next((item for item in check['candidates'] if item['url'] == body.get('url')), None)
            if not candidate:
                raise Problem('请选择本次搜索返回的出处')
            evidence = {'url':source_url or candidate['url'],'title':source_title or candidate['title'],
                        'candidate_url':candidate['url'],'candidate_title':candidate['title'],'source_type':body['source_type'],
                        'quote':quote,'subject':subject,'conditions':conditions,'checked_at':checked_at(),'reviewed_by':'editor'}
            updated = {**check, 'revision':version+1,'status':status,'evidence':evidence}
            c.execute('UPDATE wb_public_claim_checks SET record=? WHERE client_id=? AND claim_key=?', (dumps(updated),cid,key))
        return updated
