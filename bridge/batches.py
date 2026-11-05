"""Durable, explicit multi-customer submissions; one event-driven worker."""
import copy
import hashlib
import json
import threading
from app import generator
from app.store import now
from .errors import Problem, Conflict, Missing
from .storage import dumps, loads, uid, text_value


class Batches:
    def __init__(self, service):
        self.s, self.store, self.ws = service, service.store, service.ws
        self.signal, self.idle = threading.Event(), threading.Event()
        self.idle.set()
        self.closing = False
        self.worker = None
        with self.store.conn() as c:
            c.executescript('''
                CREATE TABLE IF NOT EXISTS wb_batches(
                    id TEXT PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,payload_digest TEXT NOT NULL,
                    status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS wb_batch_items(
                    id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,client_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,snapshot TEXT NOT NULL,
                    operation_id TEXT,error TEXT NOT NULL DEFAULT '',sequence INTEGER NOT NULL,planned INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS wb_batch_queue ON wb_batch_items(status,batch_id,sequence);
            ''')
            c.execute("UPDATE wb_batch_items SET status='interrupted',error='上次服务中断，执行结果需确认后再继续' WHERE status='running'")
            batch_ids = [r[0] for r in c.execute("SELECT id FROM wb_batches WHERE status='running'")]
        for bid in batch_ids:
            self.recompute(bid)

    def boot(self):
        with self.store.conn() as c:
            queued = c.execute("SELECT 1 FROM wb_batch_items WHERE status='queued' LIMIT 1").fetchone()
        if queued:
            self.wake()

    def prepare(self, items):
        if not isinstance(items, list) or not items or len(items) > 100:
            raise Problem('请勾选1至100个客户')
        prepared, issues, seen, frozen_chars = [], [], set(), 0
        for item in items:
            cid = item.get('client_id') if isinstance(item, dict) else None
            try:
                if not isinstance(item, dict) or set(item) - {'client_id', 'options', 'document_ids'}:
                    raise Problem('批次客户项格式不正确')
                if not isinstance(cid, str) or cid in seen:
                    raise Problem('客户ID无效或重复')
                seen.add(cid)
                brief, documents, revision = self.s.customers.effective(cid, item.get('options'), item.get('document_ids'))
                frozen_chars += sum(len(d['text']) for d in documents)
                if frozen_chars > 8000000:
                    raise Problem('本批资料文字超过800万字，请分批提交')
                count = sum(selection['count'] for selection in brief['selections'])
                options = {k: copy.deepcopy(v) for k, v in brief.items() if k not in ('keyword', 'platforms', 'snapshot')}
                plan = self.s.customers.plan(cid)['plan']['options']
                overrides = item.get('options') or {}
                options['format_overrides'] = copy.deepcopy(overrides.get('format_overrides', plan.get('format_overrides', {})))
                history = self.s.customers.reference_articles(cid)
                with self.store.conn() as c:
                    reserved = c.execute("SELECT COALESCE(SUM(planned),0) FROM wb_batch_items WHERE client_id=? AND status IN ('queued','running','interrupted')", (cid,)).fetchone()[0]
                offset = len(history) + reserved
                if len(brief['keywords']) > 1:
                    pos = offset % len(brief['keywords'])
                    brief['keywords'] = brief['keywords'][pos:] + brief['keywords'][:pos]
                    brief['keyword'] = brief['keywords'][0]
                    options['keywords'] = list(brief['keywords'])
                snapshot = {'brief': brief, 'options': options, 'documents': documents, 'settings': self.s.public_settings(),
                            'platforms': self.store.list_platforms(), 'models': self.store.list_models(),
                            'prefs': self.store.get_prefs(), 'risks': self.store.list_risks(),
                            'format_overrides': options['format_overrides'], 'customer_plan_revision': revision,
                            'reference_articles': history, 'topic_offset': offset}
                snapshot['zip_snapshot'] = self.s.zip_snapshot(brief)
                prepared.append({'client_id': cid, 'name': brief['client'], 'planned': count, 'snapshot': snapshot})
            except Problem as exc:
                issues.append({'client_id': cid, 'error': str(exc)})
        return prepared, issues

    @staticmethod
    def preflight_result(prepared, issues):
        return {'ready': not issues, 'issues': issues, 'total': sum(i['planned'] for i in prepared),
                'items': [{'client_id': i['client_id'], 'name': i['name'], 'planned': i['planned'],
                           'options': i['snapshot']['options'], 'document_ids': [d['id'] for d in i['snapshot']['documents']]}
                          for i in prepared]}

    def preflight(self, items):
        with self.s.guard:
            return self.preflight_result(*self.prepare(items))

    def submit(self, body):
        if set(body) != {'request_key', 'items'}:
            raise Problem('批次提交需包含request_key和items')
        key = text_value(body['request_key'], '本次提交标识', 120, empty=False)
        encoded = json.dumps(body['items'], ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
        request_digest = hashlib.sha256(encoded.encode('utf-8')).hexdigest()
        with self.s.guard:
            if self.s.closed:
                raise Conflict('服务正在退出，请稍后明确提交')
            with self.store.conn() as c:
                existing = c.execute('SELECT id,payload_digest FROM wb_batches WHERE request_key=?', (key,)).fetchone()
            if existing:
                if existing['payload_digest'] != request_digest:
                    raise Conflict('同次提交标识对应的内容不同，请重新确认')
                return self.get(existing['id'])
            prepared, issues = self.prepare(body['items'])
            if issues:
                raise Problem('；'.join(str(i['client_id'] or '客户') + '：' + i['error'] for i in issues))
            bid, stamp = uid(), now()
            with self.store.conn() as c:
                c.execute('BEGIN IMMEDIATE')
                c.execute('INSERT INTO wb_batches VALUES(?,?,?,?,?,?)', (bid, key, request_digest, 'queued', stamp, stamp))
                for seq, item in enumerate(prepared):
                    conv_id, snapshot = uid(), item['snapshot']
                    c.execute('''INSERT INTO wb_conversations(id,client_id,title,messages,brief,document_ids,status,created_at,updated_at)
                        VALUES(?,?,?,'[]',?,?,'queued',?,?)''',
                        (conv_id, item['client_id'], item['name'] + ' · 批量生成', dumps(snapshot['options']),
                         dumps([d['id'] for d in snapshot['documents']]), stamp, stamp))
                    c.execute('INSERT INTO wb_batch_items VALUES(?,?,?,?,?,?,NULL,?,?,?)',
                              (uid(), bid, item['client_id'], conv_id, 'queued', dumps(snapshot), '', seq, item['planned']))
            self.wake()
            return self.get(bid)

    def completed(self, conv_id):
        conv = self.ws.conversation(conv_id, include_deleted=True)
        if not conv['plan_id']:
            return 0
        with self.store.conn() as c:
            return c.execute('''SELECT COUNT(*) FROM articles a
                JOIN wb_current w ON w.article_id=a.id
                LEFT JOIN wb_deleted_articles d ON d.article_id=a.id
                LEFT JOIN wb_article_locks l ON l.article_id=a.id
                WHERE a.plan_id=? AND d.article_id IS NULL AND l.article_id IS NULL''', (conv['plan_id'],)).fetchone()[0]

    def get(self, bid):
        with self.store.conn() as c:
            row = c.execute('SELECT * FROM wb_batches WHERE id=?', (bid,)).fetchone()
            items = [dict(r) for r in c.execute('SELECT * FROM wb_batch_items WHERE batch_id=? ORDER BY sequence', (bid,))]
        if not row:
            raise Missing('生成批次不存在')
        public = []
        for item in items:
            snapshot = loads(item['snapshot'], {})
            public.append({k: item[k] for k in ('id', 'client_id', 'conversation_id', 'status', 'planned', 'error')} |
                          {'name': snapshot['brief']['client'], 'completed': self.completed(item['conversation_id'])})
        return {k: row[k] for k in ('id', 'status', 'created_at', 'updated_at')} | {
            'items': public, 'total': sum(i['planned'] for i in public), 'completed': sum(i['completed'] for i in public)}

    def list(self):
        with self.store.conn() as c:
            ids = [r[0] for r in c.execute('SELECT id FROM wb_batches ORDER BY rowid DESC LIMIT 100')]
        return [self.get(bid) for bid in ids]

    def managed(self, ident):
        context = self.context(ident)
        return context['item_status'] if context else None

    def context(self, ident):
        with self.store.conn() as c:
            row = c.execute('''SELECT b.id,b.status,i.id AS item_id,i.status AS item_status
                FROM wb_batch_items i JOIN wb_batches b ON b.id=i.batch_id WHERE i.conversation_id=?''', (ident,)).fetchone()
        return {**dict(row), 'frozen': True} if row else None

    def recompute(self, bid):
        with self.store.conn() as c:
            statuses = [r[0] for r in c.execute('SELECT status FROM wb_batch_items WHERE batch_id=?', (bid,))]
            if not statuses:
                raise Missing('生成批次不存在')
            if 'running' in statuses:
                status = 'running'
            elif 'queued' in statuses:
                status = 'queued'
            elif all(s == 'done' for s in statuses):
                status = 'done'
            elif 'interrupted' in statuses:
                status = 'interrupted'
            elif 'done' in statuses:
                status = 'partial'
            elif all(s == 'stopped' for s in statuses):
                status = 'stopped'
            else:
                status = 'error'
            c.execute('UPDATE wb_batches SET status=?,updated_at=? WHERE id=?', (status, now(), bid))

    def stop(self, bid):
        with self.s.guard:
            self.get(bid)
            with self.store.conn() as c:
                active = [r[0] for r in c.execute("SELECT conversation_id FROM wb_batch_items WHERE batch_id=? AND status='running'", (bid,))]
                c.execute("UPDATE wb_batch_items SET status='stopped' WHERE batch_id=? AND status='queued'", (bid,))
            for ident in active:
                self.s.stop(ident)
            self.recompute(bid)
            return self.get(bid)

    def resume(self, bid, body):
        if set(body) - {'acknowledge_uncertain'} or 'acknowledge_uncertain' in body and type(body['acknowledge_uncertain']) is not bool:
            raise Problem('恢复参数不正确')
        with self.s.guard:
            if self.s.closed:
                raise Conflict('服务正在退出，请稍后明确继续')
            batch = self.get(bid)
            if any(i['status'] in ('running', 'queued') for i in batch['items']):
                raise Conflict('本批次仍在执行或排队')
            if any(i['status'] == 'interrupted' for i in batch['items']) and not body.get('acknowledge_uncertain'):
                raise Conflict('存在执行结果不确定的任务，请确认已有稿件后明确继续')
            with self.store.conn() as c:
                c.execute("UPDATE wb_batch_items SET status='queued',error='' WHERE batch_id=? AND status!='done'", (bid,))
            self.recompute(bid)
            self.wake()
            return self.get(bid)

    def wake(self):
        self.idle.clear()
        self.signal.set()
        if self.worker is None or not self.worker.is_alive():
            self.worker = threading.Thread(target=self.run, name='customer-batch-queue', daemon=True)
            self.worker.start()

    def run(self):
        while not self.closing:
            self.signal.wait()
            self.signal.clear()
            while not self.closing:
                with self.s.guard:
                    with self.store.conn() as c:
                        item = c.execute("""SELECT i.* FROM wb_batch_items i JOIN wb_batches b ON b.id=i.batch_id
                            WHERE i.status='queued' ORDER BY b.rowid,i.sequence LIMIT 1""").fetchone()
                        if item:
                            c.execute("UPDATE wb_batch_items SET status='running' WHERE id=? AND status='queued'", (item['id'],))
                    if not item:
                        self.idle.set()
                        break
                    self.recompute(item['batch_id'])
                self.process(dict(item))

    def process(self, item):
        error, status = '', 'done'
        try:
            snapshot = loads(item['snapshot'], {})
            if self.completed(item['conversation_id']) < item['planned']:
                result = self.s.start(item['conversation_id'], _frozen=snapshot, _batch=True)
                with self.s.guard:
                    worker = self.s.threads.get(result['job_id'])
                    with self.store.conn() as c:
                        c.execute('UPDATE wb_batch_items SET operation_id=? WHERE id=?', (result['operation_id'], item['id']))
                if worker:
                    worker.join()
                operation = self.ws.operation(result['operation_id'])
                status, error = operation['status'], operation.get('error', '')
                if status == 'done' and self.completed(item['conversation_id']) < item['planned']:
                    status, error = 'error', '部分稿件未完成，已有稿件已保留'
        except Exception as exc:
            from . import provider
            error = provider.public_error(exc)
            status = 'interrupted' if getattr(exc, 'kind', '') == 'uncertain' else 'error'
        with self.s.guard:
            with self.store.conn() as c:
                c.execute('UPDATE wb_batch_items SET status=?,error=? WHERE id=?', (status, error, item['id']))
            self.recompute(item['batch_id'])

    def close(self):
        self.closing = True
        self.signal.set()
