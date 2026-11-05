"""Intake drafts and explicit adoptions on the existing SQLite connection."""
import hashlib
import json
from app.store import now
from .errors import Conflict, Missing
from .storage import dumps, loads, uid


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def profile_version(client):
    return fingerprint({'name': client['name'], 'profile': client['profile']})


class IntakeRepository:
    def __init__(self, store):
        self.store = store
        with store.conn() as c:
            c.executescript('''
                CREATE TABLE IF NOT EXISTS wb_client_intakes(
                    id TEXT PRIMARY KEY,client_id TEXT NOT NULL,reuse_key TEXT NOT NULL,
                    status TEXT NOT NULL,frozen TEXT NOT NULL,result TEXT NOT NULL DEFAULT '{}',
                    raw_response TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',
                    attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
                    UNIQUE(client_id,reuse_key));
                CREATE TABLE IF NOT EXISTS wb_client_intake_adoptions(
                    id TEXT PRIMARY KEY,intake_id TEXT NOT NULL,client_id TEXT NOT NULL,
                    base_version TEXT NOT NULL,profile TEXT NOT NULL,editorial TEXT NOT NULL,created_at TEXT NOT NULL);
            ''')
            c.execute("UPDATE wb_client_intakes SET status='interrupted',error='整理服务已中断，可明确重新整理',updated_at=? WHERE status='running'", (now(),))

    @staticmethod
    def decode(row):
        value = dict(row)
        for key in ('frozen', 'result'):
            value[key] = loads(value[key], {})
        return value

    def get(self, cid, ident):
        with self.store.conn() as c:
            row = c.execute('SELECT * FROM wb_client_intakes WHERE id=? AND client_id=?', (ident, cid)).fetchone()
        if not row:
            raise Missing('整理结果不属于当前客户')
        return self.decode(row)

    def latest(self, cid):
        with self.store.conn() as c:
            row = c.execute('SELECT * FROM wb_client_intakes WHERE client_id=? ORDER BY rowid DESC LIMIT 1', (cid,)).fetchone()
        return self.decode(row) if row else None

    def reserve(self, cid, key, frozen, retry=False):
        with self.store.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            old = c.execute('SELECT * FROM wb_client_intakes WHERE client_id=? AND reuse_key=?', (cid, key)).fetchone()
            if old and not (retry and old['status'] in ('error', 'interrupted')):
                return self.decode(old), True
            if old:
                ident = old['id']
                c.execute("UPDATE wb_client_intakes SET status='running',frozen=?,error='',updated_at=? WHERE id=?", (dumps(frozen), now(), ident))
            else:
                ident = uid()
                c.execute('INSERT INTO wb_client_intakes(id,client_id,reuse_key,status,frozen,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                          (ident, cid, key, 'running', dumps(frozen), now(), now()))
        return self.get(cid, ident), False

    def called(self, ident):
        with self.store.conn() as c:
            c.execute('UPDATE wb_client_intakes SET attempts=attempts+1 WHERE id=?', (ident,))

    def finish(self, ident, result=None, raw='', error=''):
        with self.store.conn() as c:
            c.execute('UPDATE wb_client_intakes SET status=?,result=?,raw_response=?,error=?,updated_at=? WHERE id=?',
                      ('error' if error else 'ready', dumps(result or {}), raw, error, now(), ident))

    def adopt(self, cid, ident, expected, profile, editorial, expected_adoption):
        with self.store.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            row = c.execute('SELECT * FROM wb_client_intakes WHERE id=? AND client_id=?', (ident, cid)).fetchone()
            if not row:
                raise Missing('整理结果不属于当前客户')
            if row['status'] != 'ready':
                raise Conflict('资料整理尚未完成')
            current = c.execute('SELECT name,profile FROM wb_clients WHERE id=?', (cid,)).fetchone()
            if not current or profile_version({'name': current['name'], 'profile': loads(current['profile'], {})}) != expected:
                raise Conflict('客户档案已更新，请重新读取整理结果后合并修改')
            last = c.execute('SELECT id FROM wb_client_intake_adoptions WHERE intake_id=? ORDER BY rowid DESC LIMIT 1', (ident,)).fetchone()
            if (last[0] if last else None) != expected_adoption:
                raise Conflict('整理采用记录已更新，请重新打开后保存')
            for doc in loads(row['frozen'])['documents']:
                actual = c.execute('SELECT current_document_id FROM wb_document_groups WHERE id=? AND client_id=?', (doc['group_id'], cid)).fetchone()
                if not actual or actual[0] != doc['id']:
                    raise Conflict('资料已有新修订，请用当前资料重新整理')
            aid = uid()
            c.execute('UPDATE wb_clients SET name=?,profile=? WHERE id=?', (profile['name'], dumps(profile['profile']), cid))
            c.execute('INSERT INTO wb_client_intake_adoptions VALUES(?,?,?,?,?,?,?)',
                      (aid, ident, cid, expected, dumps(profile), dumps(editorial), now()))
        return aid

    def adoption(self, cid, ident):
        with self.store.conn() as c:
            row = c.execute('SELECT * FROM wb_client_intake_adoptions WHERE client_id=? AND intake_id=? ORDER BY rowid DESC LIMIT 1', (cid, ident)).fetchone()
        if not row:
            return None
        return {**dict(row), 'profile': loads(row['profile']), 'editorial': loads(row['editorial'])}
