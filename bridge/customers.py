"""Independent customer archives and one explicit reusable generation plan."""
import copy
from app.store import now
from .errors import Problem, Conflict, Missing
from .storage import PROFILE_FIELDS, dumps, loads, integer

PLAN_FIELDS = {'keywords', 'selections', 'format_overrides', 'note', 'rivals', 'aliases', 'models'}


class Customers:
    def __init__(self, service):
        self.service, self.ws, self.store = service, service.ws, service.store
        with self.store.conn() as c:
            c.execute('''CREATE TABLE IF NOT EXISTS wb_customer_plans(
                client_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,options TEXT NOT NULL,
                document_groups TEXT NOT NULL,updated_at TEXT NOT NULL)''')

    def defaults(self, cid):
        customer = self.ws.client(cid)
        return {'keywords': [], 'selections': [],
                'models': [m['name'] for m in self.store.list_models() if m['enabled']],
                'aliases': [], 'rivals': [], 'note': '', 'format_overrides': {},
                **customer['profile'], 'client': customer['name']}

    def update(self, cid, body):
        if set(body) != {'name', 'profile'}:
            raise Problem('客户保存需包含name和profile')
        if not isinstance(body['profile'], dict) or set(body['profile']) != set(PROFILE_FIELDS):
            raise Problem('客户保存需包含全部七项档案字段，清空请传空字符串')
        with self.service.guard:
            return self.ws.save_client(body['name'], body['profile'], cid)

    def _stored_plan(self, cid):
        self.ws.client(cid)
        with self.store.conn() as c:
            row = c.execute('SELECT * FROM wb_customer_plans WHERE client_id=?', (cid,)).fetchone()
        return dict(row) if row else None

    def resolve_groups(self, cid, groups):
        ids = []
        with self.store.conn() as c:
            for group in groups:
                row = c.execute('SELECT current_document_id FROM wb_document_groups WHERE id=? AND client_id=?', (group, cid)).fetchone()
                if not row or not row[0]:
                    raise Problem('常用资料尚无有效修订，请更新客户方案')
                ids.append(row[0])
        return ids

    def plan(self, cid):
        row = self._stored_plan(cid)
        options = loads(row['options'], {}) if row else {k: v for k, v in self.defaults(cid).items() if k in PLAN_FIELDS}
        ids, issues = [], []
        try:
            ids = self.resolve_groups(cid, loads(row['document_groups'], [])) if row else []
            self.check(cid, options, ids)
        except Problem as exc:
            issues.append(str(exc))
        return {'plan': {'revision': row['revision'] if row else 0, 'options': options, 'document_ids': ids,
                         'updated_at': row['updated_at'] if row else None}, 'ready': not issues, 'issues': issues}

    def save_plan(self, cid, body):
        if set(body) - {'options', 'document_ids', 'expected_revision'} or 'options' not in body or 'document_ids' not in body:
            raise Problem('生成方案需包含options和document_ids')
        if not isinstance(body['options'], dict) or set(body['options']) - PLAN_FIELDS:
            raise Problem('常用方案含未知选项')
        with self.service.guard:
            options = self.service.normalize_options(body['options'], self.defaults(cid))
            docs = self.ws.selected_documents({'client_id': cid, 'document_ids': []}, body['document_ids'])
            groups = list(dict.fromkeys(d['group_id'] for d in docs))
            if len(groups) != len(docs):
                raise Problem('同一资料请只选择一个修订')
            with self.store.conn() as c:
                c.execute('BEGIN IMMEDIATE')
                old = c.execute('SELECT revision FROM wb_customer_plans WHERE client_id=?', (cid,)).fetchone()
                revision = old[0] if old else 0
                if 'expected_revision' in body and (type(body['expected_revision']) is not int or body['expected_revision'] != revision):
                    raise Conflict('客户常用方案已更新，请重新打开后保存')
                saved = {k: options[k] for k in PLAN_FIELDS if k in options}
                c.execute('INSERT INTO wb_customer_plans VALUES(?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET revision=excluded.revision,options=excluded.options,document_groups=excluded.document_groups,updated_at=excluded.updated_at',
                          (cid, revision + 1, dumps(saved), dumps(groups), now()))
            return self.plan(cid)

    def check(self, cid, options, document_ids):
        value = self.service.normalize_options(options, self.defaults(cid))
        documents = self.ws.selected_documents({'client_id': cid, 'document_ids': []}, document_ids)
        # Use the exact existing start preconditions, without creating a task.
        brief = self.service.build_brief({'brief': value})
        return brief, documents

    def effective(self, cid, overrides=None, document_ids=None):
        row = self._stored_plan(cid)
        if row is None:
            raise Problem('请先为客户保存一套常用生成方案')
        if overrides is not None and (not isinstance(overrides, dict) or set(overrides) - PLAN_FIELDS):
            raise Problem('本次调整仅接受生成方案字段')
        options = {**loads(row['options'], {}), **copy.deepcopy(overrides or {})}
        ids = self.resolve_groups(cid, loads(row['document_groups'], [])) if document_ids is None else document_ids
        brief, docs = self.check(cid, options, ids)
        return brief, docs, row['revision']

    def new_task(self, cid):
        row = self._stored_plan(cid)
        options = self.defaults(cid)
        ids = []
        if row:
            options = self.service.normalize_options(loads(row['options'], {}), options)
            ids = self.resolve_groups(cid, loads(row['document_groups'], []))
        conv = self.ws.create_conversation(cid, options)
        if ids:
            conv = self.ws.update_conversation(conv['id'], document_ids=ids)
        return conv

    def history(self, cid):
        self.ws.client(cid)
        conversations = self.ws.conversations(cid)
        with self.store.conn() as c:
            batches = [dict(r) for r in c.execute('''SELECT DISTINCT b.id,b.status,b.created_at,b.updated_at
                FROM wb_batches b JOIN wb_batch_items i ON i.batch_id=b.id WHERE i.client_id=?
                ORDER BY b.rowid DESC''', (cid,))]
        return {'conversations': conversations, 'batches': batches}

    def reference_articles(self, cid, exclude_conversation=None):
        references = []
        for conv in self.ws.conversations(cid):
            if conv['id'] == exclude_conversation or not conv['plan_id']:
                continue
            for article in self.ws.visible_articles(conv['plan_id']):
                references.append({k: article.get(k) for k in ('title', 'body_md', 'platform_id', 'keyword')})
        return references[-100:]
