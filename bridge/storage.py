"""Client files and working versions, isolated from ZIP generation references."""
import copy
import hashlib
import json
import sqlite3
import uuid
from contextlib import contextmanager
from app.store import now
from .errors import Problem, Missing, Conflict
from .migrations import client_name_key, migrate


def dumps(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def loads(value, default=None):
    return json.loads(value) if value else default


def uid():
    return str(uuid.uuid4())


def validate_creation_id(value):
    try:
        key = uuid.UUID(value)
        if key.version != 4 or str(key) != value:
            raise ValueError
    except (AttributeError, TypeError, ValueError):
        raise Problem('创建编号不正确') from None


PROFILE_FIELDS = ('industry', 'brand', 'company', 'products', 'website', 'phone', 'address')


def text_value(value, name, maximum=20000, empty=True):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        raise Problem(f'{name}需为有效文字，最多{maximum}字')
    return value


def integer(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise Problem(f'{name}需为正整数')
    return value


def identifier(value, name):
    if not isinstance(value, str) or not value or len(value) > 120:
        raise Problem(f'{name}需为有效字符串ID')
    return value


@contextmanager
def client_name_write():
    try:
        yield
    except sqlite3.IntegrityError as exc:
        if str(exc) != 'wb_active_client_name':
            raise
        raise Conflict('已有同名的活动客户，请修改名称或选择已有客户') from None


def update_client_profile(db, cid, name, profile):
    with client_name_write():
        db.execute('UPDATE wb_clients SET name=?,name_key=?,profile=? WHERE id=?',
                   (name, client_name_key(name), dumps(profile), cid))


class Workspace:
    def __init__(self, store):
        self.zip = store
        with store.conn() as c:
            c.executescript('''
            CREATE TABLE IF NOT EXISTS wb_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,profile TEXT NOT NULL,created_at TEXT);
            CREATE TABLE IF NOT EXISTS wb_documents(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,filename TEXT NOT NULL,kind TEXT,text TEXT NOT NULL,digest TEXT NOT NULL,created_at TEXT,UNIQUE(client_id,digest,filename));
            CREATE TABLE IF NOT EXISTS wb_conversations(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,title TEXT,plan_id INTEGER,messages TEXT NOT NULL,brief TEXT NOT NULL,document_ids TEXT NOT NULL,job_id TEXT,status TEXT,created_at TEXT,updated_at TEXT,mode TEXT NOT NULL DEFAULT 'chat',followup INTEGER NOT NULL DEFAULT 1,needs_confirmation INTEGER NOT NULL DEFAULT 0,draft_revision INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS wb_versions(id INTEGER PRIMARY KEY AUTOINCREMENT,article_id INTEGER NOT NULL,origin TEXT NOT NULL,label TEXT,parent_id INTEGER,article TEXT NOT NULL,review TEXT NOT NULL,created_at TEXT,metadata TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS wb_current(article_id INTEGER PRIMARY KEY,version_id INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS wb_article_locks(article_id INTEGER PRIMARY KEY,owner TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS wb_operations(id TEXT PRIMARY KEY,kind TEXT,conversation_id TEXT,article_id INTEGER,status TEXT,result TEXT,error TEXT,created_at TEXT,updated_at TEXT);
            CREATE TABLE IF NOT EXISTS wb_review_records(id TEXT PRIMARY KEY,article_id INTEGER NOT NULL,base_version INTEGER NOT NULL,candidate_version INTEGER,codex_review TEXT NOT NULL,user_review TEXT NOT NULL,created_at TEXT);
            CREATE TABLE IF NOT EXISTS wb_snapshots(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT);
            CREATE TABLE IF NOT EXISTS wb_article_sources(article_id INTEGER PRIMARY KEY,snapshot_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS wb_adoptions(article_id INTEGER NOT NULL,version_id INTEGER NOT NULL,adopted_at TEXT,PRIMARY KEY(article_id,version_id));
            CREATE TABLE IF NOT EXISTS wb_zip_evidence(article_id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS wb_version_evidence(version_id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS wb_version_sources(version_id INTEGER PRIMARY KEY,snapshot_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS wb_deleted_articles(article_id INTEGER PRIMARY KEY,version_id INTEGER NOT NULL,deleted_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS wb_operations_conversation ON wb_operations(conversation_id,status);
            CREATE INDEX IF NOT EXISTS wb_versions_article ON wb_versions(article_id,id);
            ''')
            columns = {r['name'] for r in c.execute('PRAGMA table_info(wb_conversations)')}
            for name, spec in [('mode', "TEXT NOT NULL DEFAULT 'chat'"), ('followup', 'INTEGER NOT NULL DEFAULT 1'),
                               ('needs_confirmation', 'INTEGER NOT NULL DEFAULT 0'), ('draft_revision', 'INTEGER NOT NULL DEFAULT 0'),
                               ('deleted_at', 'TEXT'), ('parent_conversation_id', 'TEXT')]:
                if name not in columns:
                    c.execute(f'ALTER TABLE wb_conversations ADD COLUMN {name} {spec}')
            if 'metadata' not in {r['name'] for r in c.execute('PRAGMA table_info(wb_versions)')}:
                c.execute("ALTER TABLE wb_versions ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'")
            c.execute('INSERT OR IGNORE INTO wb_adoptions SELECT article_id,version_id,? FROM wb_current', (now(),))
            c.execute('INSERT OR IGNORE INTO wb_version_sources SELECT v.id,s.snapshot_id FROM wb_versions v JOIN wb_article_sources s ON s.article_id=v.article_id')
            if not c.execute("SELECT 1 FROM meta WHERE k='wb_effective_brief_v1'").fetchone():
                # Legacy profile dialogs displayed the client archive. Remove invisible task overrides once.
                rows = c.execute('SELECT v.id,v.brief,k.name,k.profile FROM wb_conversations v JOIN wb_clients k ON k.id=v.client_id').fetchall()
                for row in rows:
                    brief = {**loads(row['brief'], {}), **loads(row['profile'], {}), 'client': row['name']}
                    c.execute('UPDATE wb_conversations SET brief=? WHERE id=?', (dumps(brief), row['id']))
                c.execute("INSERT INTO meta(k,v) VALUES('wb_effective_brief_v1','1')")
            # Freeze legacy provenance once per version before any explicit native rewrite.
            for row in c.execute('SELECT v.id,v.article,e.payload FROM wb_versions v LEFT JOIN wb_zip_evidence e ON e.article_id=v.article_id LEFT JOIN wb_version_evidence p ON p.version_id=v.id WHERE p.version_id IS NULL').fetchall():
                article = loads(row['article'], {})
                payload = loads(row['payload'], {})
                for key, source in (('native_audit', 'audit'), ('body_original', 'body_original')):
                    if article.get(source): payload[key] = article[source]
                c.execute('INSERT INTO wb_version_evidence VALUES(?,?)', (row['id'], dumps(payload)))
        from .documents import Documents
        self.files = Documents(self)
        migrate(store)

    def recover(self):
        with self.zip.conn() as c:
            locked = [r[0] for r in c.execute('SELECT article_id FROM wb_article_locks')]
            c.execute("UPDATE wb_operations SET status='interrupted',error='上次服务已中断，请明确决定是否重试',updated_at=? WHERE status='running'", (now(),))
            c.execute("UPDATE wb_conversations SET status='interrupted',needs_confirmation=1 WHERE status='running'")
            c.execute('DELETE FROM wb_article_locks')
        for aid in locked:
            if self.zip.get_article(aid):
                self.capture_zip(aid, 'ZIP 中断保留稿', review={'status': 'unverified', 'summary': '服务中断，核查未确认完成'})

    def clients(self, *, archived=False):
        with self.zip.conn() as c:
            condition = 'IS NOT NULL' if archived else 'IS NULL'
            rows = [dict(r) for r in c.execute(f'''SELECT id,name,profile,created_at,archived_at,
                COUNT(*) OVER (PARTITION BY name_key)>1 AS name_conflict
                FROM wb_clients WHERE archived_at {condition} AND import_draft=0 ORDER BY created_at,id''')]
        for row in rows:
            row['profile'] = loads(row['profile'], {})
            row['name_conflict'] = bool(row['name_conflict'])
        return rows

    def client(self, cid):
        identifier(cid, '客户ID')
        with self.zip.conn() as c:
            row = c.execute('SELECT id,name,profile,created_at,archived_at,import_draft FROM wb_clients WHERE id=?', (cid,)).fetchone()
        if not row:
            raise Missing('客户不存在')
        row = dict(row)
        row['profile'] = loads(row['profile'], {})
        return row

    def active_client(self, cid, *, include_import=False):
        client = self.client(cid)
        if client['archived_at']:
            raise Conflict('此客户已归档，请选择活动客户')
        if client['import_draft'] and not include_import:
            raise Conflict('请先确认导入草稿')
        return client

    def archive_client(self, cid):
        if self.client(cid)['import_draft']:
            raise Conflict('导入草稿尚未成为客户档案')
        with self.zip.conn() as c:
            c.execute('UPDATE wb_clients SET archived_at=? WHERE id=? AND archived_at IS NULL', (now(), cid))
        return self.client(cid)

    def restore_client(self, cid):
        if self.client(cid)['import_draft']:
            raise Conflict('请先确认导入草稿')
        with self.zip.conn() as c, client_name_write():
            c.execute('UPDATE wb_clients SET archived_at=NULL WHERE id=? AND archived_at IS NOT NULL', (cid,))
        return self.client(cid)

    def import_drafts(self):
        with self.zip.conn() as c:
            return [dict(row) for row in c.execute('''SELECT c.id,c.name,c.created_at,
                (SELECT COUNT(*) FROM wb_document_groups g WHERE g.client_id=c.id AND g.removed_at IS NULL) AS document_count
                FROM wb_clients c WHERE c.import_draft=1 ORDER BY c.rowid DESC''')]

    def start_import(self, ident, name):
        validate_creation_id(ident)
        name = text_value(name, '客户名称', 100).strip()
        profile = {field: '' for field in PROFILE_FIELDS}
        with self.zip.conn() as c:
            c.execute('''INSERT OR IGNORE INTO wb_clients(id,name,profile,created_at,name_key,import_draft)
                VALUES(?,?,?,?,?,1)''', (ident, name, dumps(profile), now(), client_name_key(name)))
        return self.client(ident)

    def save_client(self, name, profile=None, cid=None, *, creation_id=None):
        name = text_value(name, '客户名称', 100, empty=False).strip()
        if profile is None:
            profile = self.client(cid)['profile'] if cid else {}
        if not isinstance(profile, dict) or set(profile) - set(PROFILE_FIELDS):
            raise Problem('客户资料格式或字段不正确')
        old = self.client(cid)['profile'] if cid else {}
        profile = {k: text_value(profile.get(k, old.get(k, '')), k, 4000).strip() for k in PROFILE_FIELDS}
        if creation_id is not None:
            validate_creation_id(creation_id)
        with self.zip.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            if cid:
                update_client_profile(c, cid, name, profile)
            else:
                cid = creation_id or uid()
                row = c.execute('SELECT name,profile,import_draft FROM wb_clients WHERE id=?', (cid,)).fetchone()
                if row:
                    if row['import_draft']:
                        raise Conflict('请先确认导入草稿')
                    if row['name'] != name or loads(row['profile']) != profile:
                        raise Conflict('客户档案已创建并有变更，请在客户页继续')
                else:
                    with client_name_write():
                        c.execute('INSERT INTO wb_clients(id,name,profile,created_at,name_key) VALUES(?,?,?,?,?)',
                                  (cid, name, dumps(profile), now(), client_name_key(name)))
        return self.client(cid)

    def documents(self, cid):
        return self.files.list(cid)

    def put_document(self, cid, name, kind, text):
        result = self.files.import_document(cid, {'filename': name, 'kind': kind, 'text': text, 'as_new': True})
        return result['document']

    def create_conversation(self, cid, defaults=None, *, document_ids=(), creation_id=None):
        client = self.client(cid)
        defaults = {**(defaults or {}), **client['profile'], 'client': client['name']}
        ident, t = creation_id or uid(), now()
        with self.zip.conn() as c:
            c.execute('INSERT INTO wb_conversations(id,client_id,title,messages,brief,document_ids,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
                      (ident, cid, '新建内容', '[]', dumps(defaults), dumps(list(document_ids)), 'draft', t, t))
        return self.conversation(ident)

    def conversation(self, ident, include_deleted=False):
        identifier(ident, '任务ID')
        with self.zip.conn() as c:
            row = c.execute('''SELECT t.*, l.pinned_at, l.archived_at FROM wb_conversations t
                LEFT JOIN wb_task_lifecycle l ON l.conversation_id=t.id WHERE t.id=?''', (ident,)).fetchone()
        if not row or row['deleted_at'] and not include_deleted:
            raise Missing('内容任务不存在')
        row = dict(row)
        for key in ('messages', 'brief', 'document_ids'):
            row[key] = loads(row[key], {} if key == 'brief' else [])
        for key in ('followup', 'needs_confirmation'):
            row[key] = bool(row[key])
        return row

    def conversations(self, cid=None, include_deleted=False):
        with self.zip.conn() as c:
            conditions = (['client_id=?'] if cid else []) + ([] if include_deleted else ['deleted_at IS NULL'])
            rows = c.execute('SELECT id FROM wb_conversations ' + ('WHERE ' + ' AND '.join(conditions) + ' ' if conditions else '') + 'ORDER BY updated_at DESC,rowid DESC', (cid,) if cid else ()).fetchall()
        return [self.conversation(row['id'], include_deleted) for row in rows]

    def visible_articles(self, pid):
        with self.zip.conn() as c:
            deleted = {r[0] for r in c.execute('SELECT article_id FROM wb_deleted_articles')}
        return [a for a in self.zip.list_articles(pid) if a['id'] not in deleted]

    def is_deleted_article(self, aid):
        with self.zip.conn() as c:
            return c.execute('SELECT 1 FROM wb_deleted_articles WHERE article_id=?', (aid,)).fetchone() is not None

    def clone_conversation(self, ident):
        source = self.conversation(ident)
        self.active_client(source['client_id'])
        document_ids = [doc['id'] for doc in self.selected_documents(source) if not doc.get('removed_at')]
        new_id, t = uid(), now()
        with self.zip.conn() as c:
            c.execute('INSERT INTO wb_conversations(id,client_id,title,messages,brief,document_ids,status,created_at,updated_at,mode,followup,parent_conversation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                      (new_id, source['client_id'], source['title'] + ' · 复用', '[]', dumps(source['brief']), dumps(document_ids), 'draft', t, t, source['mode'], int(source['followup']), ident))
        return self.conversation(new_id)

    def delete_conversation(self, ident):
        with self.zip.conn() as c:
            c.execute('UPDATE wb_conversations SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL', (now(), now(), ident))

    def set_task_state(self, ident, field, enabled):
        with self.zip.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            row = c.execute('SELECT pinned_at,archived_at FROM wb_task_lifecycle WHERE conversation_id=?', (ident,)).fetchone()
            pinned, archived = tuple(row) if row else (None, None)
            if field == 'pinned':
                if enabled and archived:
                    raise Conflict('请先恢复任务，再置顶')
                pinned = (pinned or now()) if enabled else None
            else:
                archived = (archived or now()) if enabled else None
                if enabled:
                    pinned = None
            c.execute('''INSERT INTO wb_task_lifecycle VALUES(?,?,?) ON CONFLICT(conversation_id)
                         DO UPDATE SET pinned_at=excluded.pinned_at,archived_at=excluded.archived_at''',
                      (ident, pinned, archived))
        return {'id': ident, 'pinned_at': pinned, 'archived_at': archived}

    def delete_article(self, aid, expected):
        with self.zip.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            self._check_current(c, aid, expected)
            c.execute('INSERT INTO wb_deleted_articles VALUES(?,?,?)', (aid, expected, now()))

    def update_conversation(self, ident, **values):
        self.conversation(ident)
        columns, params = [], []
        allowed = ('title', 'plan_id', 'messages', 'brief', 'document_ids', 'job_id', 'status', 'mode', 'followup', 'needs_confirmation', 'draft_revision')
        for key in allowed:
            if key in values:
                columns.append(key + '=?')
                params.append(dumps(values[key]) if key in ('messages', 'brief', 'document_ids') else values[key])
        if columns:
            with self.zip.conn() as c:
                c.execute('UPDATE wb_conversations SET ' + ','.join(columns) + ',updated_at=? WHERE id=?', params + [now(), ident])
        return self.conversation(ident)

    def selected_documents(self, conv, ids=None, *, active_only=False):
        ids = conv['document_ids'] if ids is None else ids
        if not isinstance(ids, list) or len(ids) > 100 or any(not isinstance(i, str) for i in ids) or len(set(ids)) != len(ids):
            raise Problem('资料选择不正确')
        try:
            library = {ident: self.files.public(self.files.row(conv['client_id'], ident)) for ident in ids}
        except Missing:
            raise Problem('选定资料不属于当前客户') from None
        if any(library[i]['status'] != 'ready' for i in ids):
            raise Problem('选定资料尚未解析成功，请更新资料选择')
        retained_ids = set() if active_only else set(conv.get('document_ids', []))
        if any(doc.get('removed_at') and ident not in retained_ids for ident, doc in library.items()):
            raise Problem('选定资料已移出资料库，请更新资料选择')
        return [library[i] for i in ids]

    def save_snapshot(self, conv, payload):
        ident = uid()
        with self.zip.conn() as c:
            c.execute('INSERT INTO wb_snapshots VALUES(?,?,?,?)', (ident, conv, dumps(payload), now()))
        return ident

    def article_source(self, aid):
        with self.zip.conn() as c:
            row = c.execute('SELECT s.payload FROM wb_snapshots s JOIN wb_article_sources a ON a.snapshot_id=s.id WHERE a.article_id=?', (aid,)).fetchone()
        return loads(row[0], {}) if row else {}

    def version_source(self, aid, vid):
        self.version(aid, vid)
        with self.zip.conn() as c:
            row = c.execute('SELECT s.payload FROM wb_version_sources v JOIN wb_snapshots s ON s.id=v.snapshot_id WHERE v.version_id=?', (vid,)).fetchone()
        return loads(row[0], {}) if row else self.article_source(aid)

    def bind_source(self, aid, sid):
        with self.zip.conn() as c:
            c.execute('INSERT INTO wb_article_sources VALUES(?,?)', (aid, sid))

    def generation_evidence(self, aid):
        with self.zip.conn() as c:
            row = c.execute('SELECT payload FROM wb_zip_evidence WHERE article_id=?', (aid,)).fetchone()
        return loads(row[0], {}) if row else {}

    def version_evidence(self, aid, vid):
        self.version(aid, vid)
        with self.zip.conn() as c:
            row = c.execute('SELECT payload FROM wb_version_evidence WHERE version_id=?', (vid,)).fetchone()
        return loads(row[0], {}) if row else {}

    @staticmethod
    def _inherit_evidence(c, parent, vid):
        c.execute('INSERT INTO wb_version_evidence SELECT ?,payload FROM wb_version_evidence WHERE version_id=?', (vid, parent))
        c.execute('INSERT INTO wb_version_sources SELECT ?,snapshot_id FROM wb_version_sources WHERE version_id=?', (vid, parent))

    def save_generation_evidence(self, aid, **values):
        allowed = {'zip_data', 'raw_generation', 'raw_audit'}
        if set(values) - allowed: raise ValueError('unsupported ZIP evidence field')
        with self.zip.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            old = c.execute('SELECT payload FROM wb_zip_evidence WHERE article_id=?', (aid,)).fetchone()
            payload = {**(loads(old[0], {}) if old else {}), **values}
            c.execute('INSERT INTO wb_zip_evidence VALUES(?,?) ON CONFLICT(article_id) DO UPDATE SET payload=excluded.payload', (aid, dumps(payload)))

    def save_task_profile(self, ident, brief, needs_confirmation=False, save_as_default=False):
        """One transaction: reusable client defaults and the visible current task values."""
        profile = {k: brief[k] for k in PROFILE_FIELDS}
        with self.zip.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            row = c.execute('SELECT client_id FROM wb_conversations WHERE id=?', (ident,)).fetchone()
            if not row: raise Missing('内容任务不存在')
            if save_as_default:
                update_client_profile(c, row['client_id'], brief['client'], profile)
            c.execute('UPDATE wb_conversations SET brief=?,draft_revision=draft_revision+1,needs_confirmation=MAX(needs_confirmation,?),updated_at=? WHERE id=?',
                      (dumps(brief), int(needs_confirmation), now(), ident))
        conv = self.conversation(ident)
        return {'conversation': conv, 'client': self.client(conv['client_id'])}

    def capture_zip(self, aid, label='ZIP 成稿', select=True, review=None):
        article = self.zip.get_article(aid)
        if not article:
            raise Missing('稿件不存在')
        with self.zip.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            previous = c.execute("SELECT id,article,review FROM wb_versions WHERE article_id=? AND origin='zip' ORDER BY id DESC LIMIT 1", (aid,)).fetchone()
            encoded = dumps(article)
            checked = dumps((article.get('audit') or {}) if review is None else review)
            if previous and previous['article'] == encoded and previous['review'] == checked:
                vid = previous['id']
                c.execute('UPDATE wb_versions SET label=? WHERE id=?', (label, vid))
            else:
                vid = c.execute('INSERT INTO wb_versions(article_id,origin,label,parent_id,article,review,created_at) VALUES(?,?,?,?,?,?,?)',
                                (aid, 'zip', label, previous['id'] if previous else None, encoded, checked, now())).lastrowid
            if select:
                c.execute('INSERT OR IGNORE INTO wb_current VALUES(?,?)', (aid, vid))
                c.execute('INSERT OR IGNORE INTO wb_adoptions VALUES(?,?,?)', (aid, vid, now()))
            evidence = self.generation_evidence(aid)
            if article.get('audit'): evidence['native_audit'] = article['audit']
            if article.get('body_original'): evidence['body_original'] = article['body_original']
            c.execute('INSERT OR IGNORE INTO wb_version_evidence VALUES(?,?)', (vid, dumps(evidence)))
            c.execute('INSERT OR IGNORE INTO wb_version_sources SELECT ?,snapshot_id FROM wb_article_sources WHERE article_id=?', (vid, aid))
        return vid

    def _decode_version(self, row):
        row = dict(row)
        for key in ('article', 'review', 'metadata'):
            row[key] = loads(row[key], {})
        return row

    def version(self, aid, vid):
        integer(vid, '版本ID')
        with self.zip.conn() as c:
            row = c.execute('SELECT * FROM wb_versions WHERE article_id=? AND id=?', (aid, vid)).fetchone()
        if not row:
            raise Missing('版本不属于当前稿件')
        return self._decode_version(row)

    def versions(self, aid):
        with self.zip.conn() as c:
            rows = c.execute('SELECT * FROM wb_versions WHERE article_id=? ORDER BY id DESC', (aid,)).fetchall()
        return [self._decode_version(row) for row in rows]

    def current(self, aid):
        with self.zip.conn() as c:
            row = c.execute('SELECT v.* FROM wb_current w JOIN wb_versions v ON v.id=w.version_id WHERE w.article_id=?', (aid,)).fetchone()
            locked = c.execute('SELECT 1 FROM wb_article_locks WHERE article_id=?', (aid,)).fetchone() is not None
        if row:
            version = self._decode_version(row)
        else:
            article = self.zip.get_article(aid)
            if not article:
                raise Missing('稿件不存在')
            version = {'id': None, 'article': article, 'origin': 'zip', 'label': 'ZIP 正在处理', 'review': {}}
        article = copy.deepcopy(version['article'])
        article.update(current_version=version['id'], version_label=version['label'], origin=version['origin'], review=version['review'], locked=locked)
        return article

    @staticmethod
    def _check_current(c, aid, expected, owner=None):
        integer(expected, 'expected_version')
        lock = c.execute('SELECT owner FROM wb_article_locks WHERE article_id=?', (aid,)).fetchone()
        if lock and lock['owner'] != owner:
            raise Conflict('当前稿件正在处理，结束后才能编辑、采用或启动其他操作')
        row = c.execute('SELECT version_id FROM wb_current WHERE article_id=?', (aid,)).fetchone()
        if not row or row[0] != expected:
            raise Conflict('当前正文版本已经变化，请重新打开后操作')

    def lock_article(self, aid, owner, expected=None):
        with self.zip.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            if expected is not None:
                self._check_current(c, aid, expected)
            elif c.execute('SELECT 1 FROM wb_article_locks WHERE article_id=?', (aid,)).fetchone():
                raise Conflict('当前稿件正在处理')
            c.execute('INSERT INTO wb_article_locks VALUES(?,?)', (aid, owner))

    def unlock_article(self, aid, owner):
        with self.zip.conn() as c:
            c.execute('DELETE FROM wb_article_locks WHERE article_id=? AND owner=?', (aid, owner))

    def edit(self, aid, expected, body=None, title=None, tags=None, decl=None):
        if body is not None: text_value(body, '正文', 200000, empty=False)
        if title is not None:
            text_value(title, '标题', 1000, empty=False)
        for name, values in (('tags', tags), ('decl', decl)):
            if values is not None and (not isinstance(values, list) or len(values) > 100 or any(not isinstance(v, str) or len(v) > 4000 for v in values)):
                raise Problem(f'{name}需为最多100项的文字列表')
        with self.zip.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            self._check_current(c, aid, expected)
            article = loads(c.execute('SELECT article FROM wb_versions WHERE id=? AND article_id=?', (expected, aid)).fetchone()[0], {})
            patch = {k: v for k, v in {'body_md': body, 'title': title, 'tags': tags, 'decl': decl}.items() if v is not None}
            if all(article.get(k) == v for k, v in patch.items()):
                return expected
            article.update(**patch, audit={}, geo={}, body_original='')
            vid = c.execute('INSERT INTO wb_versions(article_id,origin,label,parent_id,article,review,created_at) VALUES(?,?,?,?,?,?,?)',
                            (aid, 'manual', '人工修改', expected, dumps(article), dumps({'status': 'unverified', 'summary': '本版本尚未核查'}), now())).lastrowid
            self._inherit_evidence(c, expected, vid)
            c.execute('UPDATE wb_current SET version_id=? WHERE article_id=?', (vid, aid))
            c.execute('INSERT OR IGNORE INTO wb_adoptions VALUES(?,?,?)', (aid, vid, now()))
        return vid

    def save_candidate(self, aid, parent, article, review, owner, origin='style', label='去 AI 味候选稿', metadata=None):
        with self.zip.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            self._check_current(c, aid, parent, owner)
            vid = c.execute('INSERT INTO wb_versions(article_id,origin,label,parent_id,article,review,created_at,metadata) VALUES(?,?,?,?,?,?,?,?)',
                            (aid, origin, label, parent, dumps(article), dumps(review), now(), dumps(metadata or {}))).lastrowid
            self._inherit_evidence(c, parent, vid)
            c.execute('INSERT INTO wb_review_records VALUES(?,?,?,?,?,?,?)', (uid(), aid, parent, vid, '', '', now()))
        return vid

    def save_native_version(self, aid, expected, article, owner, origin, evidence, source, initial=None):
        """Commit native reference, adopted version, and provenance under one CAS transaction."""
        with self.zip.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            self._check_current(c, aid, expected, owner)
            parent = expected
            sid = uid()
            conv = c.execute('SELECT id FROM wb_conversations WHERE plan_id=? AND deleted_at IS NULL', (article['plan_id'],)).fetchone()
            c.execute('INSERT INTO wb_snapshots VALUES(?,?,?,?)', (sid, conv['id'], dumps(source), now()))
            if initial is not None:
                parent = c.execute('INSERT INTO wb_versions(article_id,origin,label,parent_id,article,review,created_at) VALUES(?,?,?,?,?,?,?)',
                    (aid, 'zip_regenerate_draft', 'ZIP 重写初稿（核查前）', expected, dumps(initial), dumps({'status': 'unverified', 'summary': '原生重写的核查前版本'}), now())).lastrowid
                initial_evidence = {k: evidence[k] for k in ('zip_data', 'raw_generation') if k in evidence}
                c.execute('INSERT INTO wb_version_evidence VALUES(?,?)', (parent, dumps(initial_evidence)))
                c.execute('INSERT INTO wb_version_sources VALUES(?,?)', (parent, sid))
            fields = ('title', 'body_md', 'tags', 'decl', 'risk_tips', 'geo', 'audit', 'body_original')
            values = [dumps(article.get(k, [] if k in ('tags', 'decl', 'risk_tips') else {})) if k in ('tags', 'decl', 'risk_tips', 'geo', 'audit') else article.get(k, '') for k in fields]
            c.execute('UPDATE articles SET ' + ','.join(k + '=?' for k in fields) + ',updated_at=? WHERE id=?', values + [now(), aid])
            label = 'ZIP 原生重写并核查' if origin == 'zip_regenerate' else 'ZIP 原生再次核查'
            vid = c.execute('INSERT INTO wb_versions(article_id,origin,label,parent_id,article,review,created_at) VALUES(?,?,?,?,?,?,?)',
                            (aid, origin, label, parent, dumps(article), dumps(article.get('audit', {})), now())).lastrowid
            c.execute('INSERT INTO wb_version_evidence VALUES(?,?)', (vid, dumps(evidence)))
            c.execute('INSERT INTO wb_version_sources VALUES(?,?)', (vid, sid))
            c.execute('INSERT INTO wb_zip_evidence VALUES(?,?) ON CONFLICT(article_id) DO UPDATE SET payload=excluded.payload',
                      (aid, dumps({k: evidence[k] for k in ('zip_data', 'raw_generation', 'raw_audit') if k in evidence})))
            c.execute('UPDATE wb_current SET version_id=? WHERE article_id=?', (vid, aid))
            c.execute('INSERT INTO wb_adoptions VALUES(?,?,?)', (aid, vid, now()))
        return vid

    def select_version(self, aid, vid, expected):
        integer(vid, 'version_id')
        with self.zip.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            self._check_current(c, aid, expected)
            version = c.execute('SELECT * FROM wb_versions WHERE article_id=? AND id=?', (aid, vid)).fetchone()
            if not version:
                raise Missing('版本不属于当前稿件')
            if vid != expected and version['origin'] in ('style', 'revision') and version['parent_id'] != expected:
                raise Conflict('候选稿依据的正文已变化，请先回到对应原稿再采用')
            c.execute('UPDATE wb_current SET version_id=? WHERE article_id=?', (vid, aid))
            c.execute('INSERT OR IGNORE INTO wb_adoptions VALUES(?,?,?)', (aid, vid, now()))

    def was_adopted(self, aid, vid):
        with self.zip.conn() as c:
            return c.execute('SELECT 1 FROM wb_adoptions WHERE article_id=? AND version_id=?', (aid, vid)).fetchone() is not None

    def update_candidate_review(self, aid, vid, expected, owner, review, metadata):
        with self.zip.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            self._check_current(c, aid, expected, owner)
            c.execute('UPDATE wb_versions SET review=?,metadata=? WHERE id=? AND article_id=? AND parent_id=?',
                      (dumps(review), dumps(metadata), vid, aid, expected))

    def save_review_notes(self, aid, vid, codex_review=None, user_review=None):
        self.version(aid, vid)
        for value in (codex_review, user_review):
            if value is not None:
                text_value(value, '评语', 20000)
        with self.zip.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            row = c.execute('SELECT * FROM wb_review_records WHERE article_id=? AND candidate_version=?', (aid, vid)).fetchone()
            if not row:
                raise Problem('请选择一个去味或修改候选稿')
            c.execute('UPDATE wb_review_records SET codex_review=?,user_review=? WHERE id=?',
                      (codex_review if codex_review is not None else row['codex_review'], user_review if user_review is not None else row['user_review'], row['id']))

    def review_records(self, aid):
        with self.zip.conn() as c:
            return [dict(r) for r in c.execute('SELECT * FROM wb_review_records WHERE article_id=? ORDER BY created_at DESC,rowid DESC', (aid,))]

    def operation(self, ident):
        identifier(ident, '操作ID')
        with self.zip.conn() as c:
            row = c.execute('SELECT * FROM wb_operations WHERE id=?', (ident,)).fetchone()
        if not row:
            raise Missing('操作不存在')
        row = dict(row)
        row['result'] = loads(row['result'], {})
        return row

    def operations_for(self, conv):
        with self.zip.conn() as c:
            rows = c.execute('SELECT * FROM wb_operations WHERE conversation_id=? ORDER BY rowid DESC LIMIT 100', (conv,)).fetchall()
        results = []
        for row in rows:
            value = dict(row)
            value['result'] = loads(value['result'], {})
            results.append(value)
        return results

    def create_operation(self, kind, conv, aid=None):
        ident, t = uid(), now()
        with self.zip.conn() as c:
            c.execute('INSERT INTO wb_operations VALUES(?,?,?,?,?,?,?,?,?)', (ident, kind, conv, aid, 'running', '{}', '', t, t))
        return ident

    def update_operation_reply(self, ident, text, complete):
        result = {'understanding': text[:4000], 'reply_complete': bool(complete), 'partial': True}
        with self.zip.conn() as c:
            c.execute("UPDATE wb_operations SET result=?,updated_at=? WHERE id=? AND kind='interview' AND status='running'",
                      (dumps(result), now(), ident))

    def finish_operation(self, ident, result=None, error='', status=None):
        status = status or ('error' if error else 'done')
        if status not in ('done', 'error', 'stopped', 'interrupted'):
            raise ValueError('invalid operation terminal status')
        with self.zip.conn() as c:
            c.execute('UPDATE wb_operations SET status=?,result=?,error=?,updated_at=? WHERE id=?', (status, dumps(result or {}), str(error)[:500], now(), ident))
