"""Owned client files, immutable revisions and content-based import decisions."""
import base64
import hashlib
import os
import re
import threading
import unicodedata
from pathlib import Path
from app import parsers
from app.store import now
from .errors import Problem, Missing, Conflict
from .storage import dumps, identifier, loads, text_value, uid


def digest(data):
    return hashlib.sha256(data).hexdigest()


def normalized_name(name):
    name = unicodedata.normalize('NFKC', Path(name).stem).strip().casefold()
    previous = None
    while previous != name:
        previous = name
        name = re.sub(r'\s*(?:\(\d+\)|[-_ ]*副本|[-_ ]+copy(?:\s*\(\d+\))?)\s*$', '', name).strip()
    return name


class Documents:
    def __init__(self, ws):
        self.ws, self.store = ws, ws.zip
        self.root = Path(self.store.db_path).resolve().parent / 'clients'
        self.lock = threading.RLock()
        with self.store.conn() as c:
            # The old text/name UNIQUE prevents storing changed binary files whose
            # extracted text is unchanged. Preserve every id in one transaction.
            if any(r['unique'] for r in c.execute('PRAGMA index_list(wb_documents)') if r['origin'] == 'u'):
                c.execute('BEGIN IMMEDIATE')
                c.execute('CREATE TABLE wb_documents_new(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,filename TEXT NOT NULL,kind TEXT,text TEXT NOT NULL,digest TEXT NOT NULL,created_at TEXT)')
                c.execute('INSERT INTO wb_documents_new SELECT * FROM wb_documents')
                c.execute('DROP TABLE wb_documents')
                c.execute('ALTER TABLE wb_documents_new RENAME TO wb_documents')
                c.commit()
            c.executescript('''
                CREATE TABLE IF NOT EXISTS wb_document_groups(
                    id TEXT PRIMARY KEY,client_id TEXT NOT NULL,current_document_id TEXT);
                CREATE TABLE IF NOT EXISTS wb_document_assets(
                    document_id TEXT PRIMARY KEY,group_id TEXT NOT NULL,revision INTEGER NOT NULL,
                    status TEXT NOT NULL,raw_sha256 TEXT NOT NULL DEFAULT '',
                    original_path TEXT NOT NULL DEFAULT '',parsed_path TEXT NOT NULL DEFAULT '',
                    original_name TEXT NOT NULL,normalized_name TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',
                    UNIQUE(group_id,revision));
                CREATE INDEX IF NOT EXISTS wb_assets_hash ON wb_document_assets(raw_sha256);
                CREATE INDEX IF NOT EXISTS wb_documents_client ON wb_documents(client_id);
            ''')
            c.execute('''INSERT OR IGNORE INTO wb_document_groups(id,client_id,current_document_id) SELECT d.id,d.client_id,d.id
                FROM wb_documents d LEFT JOIN wb_document_assets a ON a.document_id=d.id WHERE a.document_id IS NULL''')
            rows = c.execute('SELECT d.id,d.filename FROM wb_documents d LEFT JOIN wb_document_assets a ON a.document_id=d.id WHERE a.document_id IS NULL').fetchall()
            for row in rows:
                # Historical extracted text is not represented as an original file.
                c.execute("INSERT INTO wb_document_assets(document_id,group_id,revision,status,original_name,normalized_name) VALUES(?,?,1,'ready',?,?)",
                          (row['id'], row['id'], row['filename'], normalized_name(row['filename'])))

    def _path(self, relative):
        path = (self.root / relative).resolve()
        if not relative or not path.is_relative_to(self.root.resolve()):
            raise Missing('资料文件不存在')
        return path

    @staticmethod
    def filename(value):
        value = text_value(value, '资料名称', 255, empty=False).strip()
        if any(ord(ch) < 32 for ch in value) or any(ch in value for ch in ('/', '\\', ':')) or value in ('.', '..'):
            raise Problem('资料名称不能包含路径或控制字符')
        return value

    def row(self, cid, did):
        self.ws.client(cid)
        identifier(did, '资料ID')
        with self.store.conn() as c:
            row = c.execute('''SELECT d.*,a.group_id,a.revision,a.status,a.raw_sha256,
                a.original_path,a.parsed_path,a.original_name,a.normalized_name,a.error,
                g.current_document_id,g.removed_at,g.default_excluded FROM wb_documents d JOIN wb_document_assets a ON a.document_id=d.id
                JOIN wb_document_groups g ON g.id=a.group_id AND g.client_id=d.client_id
                WHERE d.id=? AND d.client_id=?''', (did, cid)).fetchone()
        if not row:
            raise Missing('资料不属于当前客户')
        return dict(row)

    def public(self, row):
        row = dict(row)
        base = '/api/workbench/clients/' + row['client_id'] + '/documents/' + row['id']
        removed = {'removed_at': row['removed_at']} if row['removed_at'] else {}
        return {k: row[k] for k in ('id', 'client_id', 'filename', 'kind', 'text', 'digest', 'created_at',
                                    'group_id', 'revision', 'status', 'raw_sha256', 'error')} | removed | {
            'has_original': bool(row['original_path']), 'is_current': row['id'] == row['current_document_id'],
            'default_excluded': bool(row['default_excluded']),
            'original_url': base + '/original' if row['original_path'] else None, 'text_url': base + '/text'}

    def list(self, cid, all_revisions=False, *, removed=False):
        self.ws.client(cid)
        with self.store.conn() as c:
            rows = c.execute('''SELECT d.*,a.*,g.current_document_id,g.removed_at,g.default_excluded FROM wb_documents d
                JOIN wb_document_assets a ON a.document_id=d.id
                JOIN wb_document_groups g ON g.id=a.group_id AND g.client_id=d.client_id WHERE d.client_id=?
                AND (g.removed_at IS NOT NULL)=?
                ''' + ('' if all_revisions else "AND (d.id=g.current_document_id OR a.status='pending')") +
                ' ORDER BY d.created_at,d.rowid', (cid, int(removed))).fetchall()
        return [self.public(row) for row in rows]

    def revisions(self, cid, did):
        row = self.row(cid, did)
        return [d for d in self.list(cid, True, removed=bool(row['removed_at'])) if d['group_id'] == row['group_id']]

    def remove(self, cid, did):
        with self.lock:
            self.ws.active_client(cid, include_import=True)
            group = self.row(cid, did)['group_id']
            timestamp = now()
            with self.store.conn() as c:
                c.execute('BEGIN IMMEDIATE')
                removed = c.execute('''UPDATE wb_document_groups SET removed_at=?
                    WHERE id=? AND client_id=? AND removed_at IS NULL''', (timestamp, group, cid))
                if removed.rowcount:
                    plan = c.execute('SELECT document_groups FROM wb_customer_plans WHERE client_id=?', (cid,)).fetchone()
                    groups = loads(plan[0], []) if plan else []
                    if group in groups:
                        groups = [value for value in groups if value != group]
                        c.execute('''UPDATE wb_customer_plans SET document_groups=?,revision=revision+1,updated_at=?
                            WHERE client_id=?''', (dumps(groups), timestamp, cid))
        return self.public(self.row(cid, did))

    def restore(self, cid, did, add_to_defaults=False):
        with self.lock:
            self.ws.active_client(cid)
            row = self.row(cid, did)
            if add_to_defaults and not row['current_document_id']:
                raise Conflict('资料没有有效修订，恢复后请先完成解析')
            group = row['group_id']
            with self.store.conn() as c:
                c.execute('BEGIN IMMEDIATE')
                c.execute('''UPDATE wb_document_groups SET removed_at=NULL,default_excluded=?
                    WHERE id=? AND client_id=? AND (removed_at IS NOT NULL OR ?=1)''',
                    (int(not add_to_defaults), group, cid, int(add_to_defaults)))
                if add_to_defaults:
                    plan = c.execute('SELECT document_groups FROM wb_customer_plans WHERE client_id=?', (cid,)).fetchone()
                    if plan:
                        groups = loads(plan[0], [])
                        if group not in groups:
                            c.execute('''UPDATE wb_customer_plans SET document_groups=?,revision=revision+1,updated_at=?
                                         WHERE client_id=?''', (dumps([*groups, group]), now(), cid))
            return self.public(self.row(cid, row['current_document_id'] or did))

    def retry_import(self, cid, did, body):
        if set(body) - {'text'}:
            raise Problem('解析重试仅接受校对后的正文')
        with self.lock:
            self.ws.active_client(cid, include_import=True)
            row = self.row(cid, did)
            if row['removed_at'] or row['status'] != 'pending':
                raise Conflict('请选择待解析的资料')
            if row['current_document_id']:
                current = self.row(cid, row['current_document_id'])
                if current['revision'] > row['revision']:
                    return {'outcome': 'duplicate', 'document': self.public(current)}
            name, kind = row['filename'], row['kind']
            if 'text' in body:
                text = text_value(body['text'], '校对正文', 200000, empty=False)
                if name.lower().endswith('.pdf'):
                    kind = 'PDF 文档'
            else:
                raw, _, _ = self.download(cid, did, original=True)
                try:
                    parsed = parsers.parse_file(name, raw)
                    text = text_value(parsed.get('text'), '资料正文', 200000, empty=False)
                    kind = parsed.get('kind', kind)
                except (parsers.Unsupported, parsers.ParseError, Problem) as exc:
                    return {'outcome': 'pending', 'document': self.public({**row, 'error': str(exc)})}
            return self.import_document(cid, {'filename': name, 'kind': kind, 'text': text, 'update_document_id': did})

    def draft_current(self, cid):
        latest = {}
        for doc in self.list(cid):
            group = doc['group_id']
            if group not in latest or doc['revision'] > latest[group]['revision']:
                latest[group] = doc
        return list(latest.values())

    def check(self, cid, name, raw_sha='', text_digest=''):
        self.ws.active_client(cid, include_import=True)
        name = self.filename(name)
        for value in (raw_sha, text_digest):
            if not isinstance(value, str) or value and not re.fullmatch('[0-9a-fA-F]{64}', value):
                raise Problem('SHA-256格式不正确')
        values = self.list(cid, True)
        duplicate = next((d for d in reversed(values) if raw_sha and d['raw_sha256'] == raw_sha.lower()), None)
        candidates = [d for d in values if d['is_current'] and normalized_name(d['filename']) == normalized_name(name)]
        text_matches = [d for d in values if d['is_current'] and text_digest and d['digest'] == text_digest.lower()]
        return {'duplicate': duplicate, 'candidates': candidates, 'text_matches': text_matches}

    def _write(self, relative, data):
        path = self._path(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        # A crash can leave an unreferenced UUID directory, never an active partial file.
        temp = path.with_suffix(path.suffix + '.tmp')
        try:
            with temp.open('xb') as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            with temp.open('rb') as inp:
                actual = hashlib.file_digest(inp, 'sha256').hexdigest()
            if actual != digest(data):
                raise Problem('资料副本校验失败，未启用')
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)
        return relative

    def import_document(self, cid, body):
        if set(body) - {'filename', 'kind', 'text', 'content_b64', 'update_document_id', 'as_new'}:
            raise Problem('资料导入包含未知字段')
        with self.lock:
            self.ws.active_client(cid, include_import=True)
            name = self.filename(body.get('filename'))
            kind = text_value(body.get('kind') or '文本', '资料类型', 50)
            text = body.get('text')
            if text is not None:
                text_value(text, '资料正文', 200000)
            if 'as_new' in body and not isinstance(body['as_new'], bool):
                raise Problem('as_new需为布尔值')
            if body.get('as_new') and body.get('update_document_id'):
                raise Problem('更新资料与另存新资料不能同时选择')
            if 'update_document_id' in body:
                identifier(body['update_document_id'], '资料ID')
            target = self.row(cid, body['update_document_id']) if 'update_document_id' in body else None
            if target and target['removed_at']:
                raise Conflict('此资料已移出资料库，请作为新资料导入')
            if target and target['status'] == 'ready' and target['current_document_id'] not in (None, target['id']):
                raise Conflict('资料已有新修订，请重新打开当前版本')
            if target and target['status'] == 'pending' and target['current_document_id']:
                current = self.row(cid, target['current_document_id'])
                if current['revision'] > target['revision']:
                    raise Conflict('待处理资料之后已有新修订，请从当前有效版更新')
            binary = body.get('content_b64')
            raw = None
            if binary is not None:
                if not isinstance(binary, str):
                    raise Problem('文件内容需为Base64文字')
                try:
                    raw = base64.b64decode(binary, validate=True)
                except ValueError:
                    raise Problem('文件内容读取失败') from None
                if not raw or len(raw) > parsers.MAX_BYTES:
                    raise Problem('原文件不能为空且不得超过8MB')
            elif text is None or not text.strip():
                raise Problem('请提供原文件或有效文字')
            raw_sha = digest(raw) if raw is not None else ''
            check = self.check(cid, name, raw_sha)
            duplicate = check['duplicate']
            if duplicate and not (target and duplicate['group_id'] == target['group_id'] and duplicate['status'] == 'pending'):
                return {'outcome': 'duplicate', 'document': duplicate}
            error = ''
            if raw is not None:
                try:
                    if name.lower().endswith('.pdf'):
                        if text is None or not text.strip():
                            raise parsers.ParseError('PDF需同时提供经本机读取的文字，扫描件请先OCR')
                        kind = 'PDF 文档'
                    else:
                        parsed = parsers.parse_file(name, raw)
                        text, kind = parsed.get('text', ''), parsed.get('kind', kind)
                    text_value(text, '资料正文', 200000, empty=False)
                    if not text.strip():
                        raise parsers.ParseError('未解析到正文')
                except (parsers.Unsupported, parsers.ParseError, Problem) as exc:
                    error, text = str(exc), ''
            text = (text or '').strip()
            text_hash = digest(text.encode('utf-8'))
            check = self.check(cid, name, raw_sha, text_hash)
            # Pasted text is also owned and deduplicated; don't invent a binary original.
            if raw is None and not target:
                same = next((d for d in check['text_matches'] if not d['has_original']), None)
                if same:
                    return {'outcome': 'duplicate', 'document': same}
            if not target and not body.get('as_new') and (check['candidates'] or check['text_matches']):
                return {'outcome': 'needs_resolution', 'candidates': check['candidates'], 'text_matches': check['text_matches']}
            group_id, did = target['group_id'] if target else uid(), uid()
            with self.store.conn() as c:
                revision = c.execute('SELECT COALESCE(MAX(revision),0)+1 FROM wb_document_assets WHERE group_id=?', (group_id,)).fetchone()[0]
            directory = f'{cid}/documents/{group_id}/{did}'
            created = []
            try:
                original = ''
                if raw is not None:
                    original = self._write(directory + '/original' + Path(name).suffix.lower(), raw)
                    created.append(original)
                elif target:
                    original, raw_sha = target['original_path'], target['raw_sha256']
                parsed_path = self._write(directory + '/parsed.txt', text.encode('utf-8'))
                created.append(parsed_path)
                status = 'pending' if error else 'ready'
                with self.store.conn() as c:
                    c.execute('BEGIN IMMEDIATE')
                    if target:
                        current = c.execute('SELECT current_document_id FROM wb_document_groups WHERE id=?', (group_id,)).fetchone()[0]
                        if current != target['current_document_id']:
                            raise Conflict('资料版本已变化，未切换有效版')
                    else:
                        c.execute('INSERT INTO wb_document_groups(id,client_id) VALUES(?,?)', (group_id, cid))
                    c.execute('INSERT INTO wb_documents VALUES(?,?,?,?,?,?,?)', (did, cid, name, kind, text, text_hash, now()))
                    c.execute('INSERT INTO wb_document_assets VALUES(?,?,?,?,?,?,?,?,?,?)',
                              (did, group_id, revision, status, raw_sha, original, parsed_path, name, normalized_name(name), error))
                    if not error:
                        c.execute('UPDATE wb_document_groups SET current_document_id=? WHERE id=?', (did, group_id))
            except BaseException:
                for relative in created:
                    self._path(relative).unlink(missing_ok=True)
                raise
            return {'outcome': 'pending' if error else 'updated' if target else 'created', 'document': self.public(self.row(cid, did))}

    def download(self, cid, did, original=False):
        row = self.row(cid, did)
        if original:
            path = self._path(row['original_path'])
            if not path.is_file():
                raise Missing('这份历史资料未保存原件，请重新导入原文件')
            raw = path.read_bytes()
            if digest(raw) != row['raw_sha256']:
                raise Conflict('原件校验不一致，请检查客户资料')
            return raw, 'application/octet-stream', row['original_name']
        return row['text'].encode('utf-8'), 'text/plain; charset=utf-8', Path(row['filename']).stem + '.txt'
