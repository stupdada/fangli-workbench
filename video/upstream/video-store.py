"""Video-only SQLite RPC service. Owns an OS lock for its entire lifetime.

The content workspace is opened read-only solely for customer/source ownership.
No cloud or rendering code is imported here. Protocol: UTF-8 JSON lines.
"""
import json
import math
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path


class StoreError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status


def now():
    return datetime.now(timezone.utc).isoformat()


class VideoStore:
    def __init__(self, root, workspace):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.workspace = Path(workspace).resolve()
        self.lock = open(self.root / 'service.lock', 'a+b')
        try:
            self.lock.seek(0)
            if os.name == 'nt':
                import msvcrt
                if not self.lock.read(1):
                    self.lock.write(b'0')
                    self.lock.flush()
                self.lock.seek(0)
                msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, IOError):
            self.lock.close()
            raise StoreError('STORE_LOCKED', 409)
        self.db = sqlite3.connect(self.root / 'video.sqlite3', timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS batches(
          id TEXT PRIMARY KEY,client TEXT NOT NULL,digest TEXT NOT NULL,spec TEXT NOT NULL,
          version TEXT NOT NULL,state TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,
          error_code TEXT,attempt INTEGER NOT NULL DEFAULT 0,UNIQUE(client,digest));
        CREATE TABLE IF NOT EXISTS jobs(
          batch TEXT NOT NULL REFERENCES batches(id),id TEXT NOT NULL,position INTEGER NOT NULL,
          spec TEXT NOT NULL,version TEXT NOT NULL,state TEXT NOT NULL,phase TEXT,
          completed INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL,error_code TEXT,
          PRIMARY KEY(batch,id));
        CREATE TABLE IF NOT EXISTS assets(
          id TEXT PRIMARY KEY,client TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,
          size INTEGER NOT NULL,file TEXT NOT NULL,created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS previews(
          id TEXT PRIMARY KEY,client TEXT NOT NULL,spec TEXT NOT NULL,state TEXT NOT NULL,
          duration REAL,cache_hit INTEGER,error_code TEXT,created TEXT NOT NULL,updated TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runtime(id INTEGER PRIMARY KEY CHECK(id=1),kind TEXT,item TEXT);
        CREATE TABLE IF NOT EXISTS content_generations(
          id TEXT PRIMARY KEY,client TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,
          state TEXT NOT NULL,data TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,UNIQUE(client,request_id));
        INSERT OR IGNORE INTO runtime(id) VALUES(1);
        ''')
        # Additive migration leaves historical specifications and output untouched.
        for table, column, declaration in [('batches', 'mode', 'TEXT'), ('batches', 'layout', 'TEXT'), ('jobs', 'result', 'TEXT'), ('assets', 'sha256', 'TEXT')]:
            if column not in {row[1] for row in self.db.execute('PRAGMA table_info(' + table + ')')}:
                self.db.execute('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + declaration)
        # Recovery is possible only after the exclusive OS lock has been acquired.
        with self.db:
            self.db.execute("UPDATE batches SET state='interrupted',error_code='INTERRUPTED',updated=? WHERE state IN ('queued','running','stopping')", (now(),))
            self.db.execute("UPDATE jobs SET state='interrupted',error_code='INTERRUPTED' WHERE state IN ('queued','running','stopping')")
            self.db.execute("UPDATE previews SET state='interrupted',error_code='INTERRUPTED',updated=? WHERE state='running'", (now(),))
            self.db.execute('UPDATE runtime SET kind=NULL,item=NULL WHERE id=1')
            self.db.execute("UPDATE content_generations SET state='interrupted',updated=? WHERE state='running'", (now(),))

    def close(self):
        self.db.close()
        self.lock.close()

    def client(self, client):
        if not isinstance(client, str) or not client:
            raise StoreError('CLIENT_INVALID')
        try:
            with sqlite3.connect(self.workspace.as_uri() + '?mode=ro', uri=True) as db:
                if not db.execute('SELECT 1 FROM clients WHERE id=?', (client,)).fetchone():
                    raise StoreError('CLIENT_INVALID')
        except sqlite3.Error:
            raise StoreError('CLIENT_INVALID')
        return client

    def source(self, client, source):
        if source is None:
            return
        try:
            with sqlite3.connect(self.workspace.as_uri() + '?mode=ro', uri=True) as db:
                row = db.execute('SELECT snapshot FROM runs WHERE id=? AND client=?', (source['runId'], client)).fetchone()
                if not row:
                    raise StoreError('NOT_FOUND', 404)
                artifact = json.loads(row[0]).get('session', {}).get('artifacts', {}).get(source['artifactId'])
                if not artifact or artifact.get('contentVersion') != source['contentVersion']:
                    raise StoreError('INVALID_INPUT')
        except (sqlite3.Error, KeyError, TypeError, ValueError):
            raise StoreError('INVALID_INPUT')

    def batch(self, ident, client=None):
        row = self.db.execute('SELECT * FROM batches WHERE id=?', (ident,)).fetchone()
        if not row or client is not None and row['client'] != client:
            raise StoreError('NOT_FOUND', 404)
        self.client(row['client'])
        result = dict(row)
        result['spec'] = json.loads(result['spec'])
        result['jobs'] = []
        for item in self.db.execute('SELECT * FROM jobs WHERE batch=? ORDER BY position', (ident,)):
            item = dict(item)
            item['spec'] = json.loads(item['spec'])
            item['result'] = json.loads(item['result']) if item['result'] else None
            result['jobs'].append(item)
        return result

    def execute(self, op, data):
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            return self._execute(op, data)

    def _execute(self, op, data):
        if op == 'content.sources':
            client = self.client(data['clientId'])
            with sqlite3.connect(self.workspace.as_uri() + '?mode=ro', uri=True) as source:
                source.row_factory = sqlite3.Row
                customer = dict(source.execute('SELECT * FROM clients WHERE id=?', (client,)).fetchone())
                selected = data.get('sourceIds')
                docs = [dict(row) for row in source.execute('SELECT id,name,content,digest,role FROM documents WHERE client=? ORDER BY created DESC', (client,))]
                if selected:
                    if any(ident not in {doc['id'] for doc in docs} for ident in selected):
                        raise StoreError('ASSET_INVALID')
                    docs = [doc for doc in docs if doc['id'] in selected]
                docs = [doc for doc in docs if doc['role'] in ('customer_statement', 'technical_source', 'unclassified')]
                if not docs or len(docs) > 30 or sum(len(doc['content']) for doc in docs) > 80000:
                    raise StoreError('CONTENT_SOURCES_MISSING')
                import hashlib
                for doc in docs:
                    doc['contentDigest'] = hashlib.sha256(doc['content'].encode('utf-8')).hexdigest()
                    doc['readStart'], doc['readEnd'], doc['offsetUnit'] = 0, len(doc['content']), 'unicode_codepoint'
                return {'clientId': client, 'name': customer['name'], 'identity': customer.get('identity', ''), 'profile': json.loads(customer.get('client_profile', '{}')), 'documents': docs}
        if op == 'content.begin':
            self.client(data['clientId'])
            old = self.db.execute('SELECT * FROM content_generations WHERE client=? AND request_id=?', (data['clientId'], data['requestId'])).fetchone()
            if old:
                if old['input_hash'] != data['inputHash']:
                    raise StoreError('CONTENT_VERSION_CONFLICT', 409)
                return {'created': False, 'id': old['id'], 'state': old['state'], 'data': json.loads(old['data']) if old['data'] else None}
            if self.db.execute("SELECT 1 FROM content_generations WHERE state='running'").fetchone():
                raise StoreError('CONTENT_BUSY', 409)
            stamp = now()
            self.db.execute('INSERT INTO content_generations VALUES(?,?,?,?,?,?,?,?)', (data['id'], data['clientId'], data['requestId'], data['inputHash'], 'running', json.dumps(data['input'], ensure_ascii=False), stamp, stamp))
            return {'created': True, 'id': data['id']}
        if op == 'content.finish':
            self.db.execute('UPDATE content_generations SET state=?,data=?,updated=? WHERE id=? AND client=?', (data['state'], json.dumps(data['data'], ensure_ascii=False), now(), data['id'], data['clientId']))
            return True
        if op == 'content.get':
            self.client(data['clientId'])
            row = self.db.execute('SELECT * FROM content_generations WHERE id=? AND client=?', (data['id'], data['clientId'])).fetchone()
            if not row:
                raise StoreError('NOT_FOUND', 404)
            return {'id': row['id'], 'clientId': row['client'], 'state': row['state'], 'data': json.loads(row['data']) if row['data'] else None}
        if op == 'client.check':
            return {'valid': bool(self.client(data.get('clientId')))}
        if op == 'asset.put':
            self.client(data['clientId'])
            self.db.execute('INSERT INTO assets(id,client,name,type,size,file,created,sha256) VALUES(?,?,?,?,?,?,?,?)', (data['id'], data['clientId'], data['name'], data['type'], data['size'], data['file'], now(), data.get('sha256')))
            return {'saved': True}
        if op == 'asset.get':
            self.client(data['clientId'])
            row = self.db.execute('SELECT * FROM assets WHERE id=? AND client=?', (data['id'], data['clientId'])).fetchone()
            if not row:
                raise StoreError('ASSET_INVALID')
            return dict(row)
        if op == 'batch.create':
            spec, ident, stamp = data['spec'], data['id'], now()
            if spec.get('mode') != 'silent':
                raise StoreError('MODE_UNSUPPORTED')
            client = self.client(spec['clientId'])
            old = self.db.execute('SELECT id FROM batches WHERE client=? AND digest=?', (client, data['digest'])).fetchone()
            if old:
                return {'created': False, 'record': self.batch(old['id'], client)}
            for job in spec['jobs']:
                self.source(client, job.get('source'))
                if job.get('contentGenerationId'):
                    generated = self.db.execute("SELECT 1 FROM content_generations WHERE id=? AND client=? AND state='completed'", (job['contentGenerationId'], client)).fetchone()
                    if not generated:
                        raise StoreError('NOT_FOUND', 404)
                for segment in job['segments']:
                    self._execute('asset.get', {'clientId': client, 'id': segment['media']})
            self.db.execute('INSERT INTO batches(id,client,digest,spec,version,state,created,updated,mode,layout) VALUES(?,?,?,?,?,?,?,?,?,?)',
                            (ident, client, data['digest'], json.dumps(spec, ensure_ascii=False), data['digest'], 'queued', stamp, stamp, 'silent', 'compact'))
            for index, job in enumerate(spec['jobs']):
                self.db.execute('INSERT INTO jobs(batch,id,position,spec,version,state,total) VALUES(?,?,?,?,?,?,?)',
                                (ident, job['id'], index, json.dumps(job, ensure_ascii=False), data['jobVersions'][job['id']], 'queued', len(job['segments'])))
            return {'created': True, 'record': self.batch(ident, client)}
        if op == 'batch.get':
            return self.batch(data['id'], data.get('clientId'))
        if op == 'batch.list':
            client = self.client(data['clientId'])
            return [self.batch(r[0], client) for r in self.db.execute('SELECT id FROM batches WHERE client=? ORDER BY rowid DESC LIMIT 100', (client,)).fetchall()]
        if op == 'batch.claim':
            if self.db.execute('SELECT kind FROM runtime WHERE id=1').fetchone()[0]:
                return None
            row = self.db.execute("SELECT id FROM batches WHERE state='queued' AND mode='silent' ORDER BY rowid LIMIT 1").fetchone()
            if not row:
                return None
            self.db.execute("UPDATE batches SET state='running',attempt=attempt+1,updated=? WHERE id=? AND state='queued'", (now(), row[0]))
            self.db.execute("UPDATE runtime SET kind='batch',item=? WHERE id=1", (row[0],))
            return self.batch(row[0])
        if op == 'job.start':
            record = self.batch(data['id'])
            if record['state'] != 'running' or record['mode'] != 'silent' or record['spec'].get('mode') != 'silent':
                return False
            result = self.db.execute("UPDATE jobs SET state='running',phase='render',error_code=NULL WHERE batch=? AND id=? AND state='queued'", (data['id'], data['jobId']))
            return result.rowcount == 1
        if op == 'job.progress':
            if data['phase'] not in ('render', 'concat'):
                raise StoreError('ADAPTER_PROTOCOL')
            self.db.execute("UPDATE jobs SET phase=?,completed=MAX(completed,MIN(total,?)) WHERE batch=? AND id=? AND state='running' AND EXISTS(SELECT 1 FROM batches WHERE id=? AND state='running')",
                            (data['phase'], data['completed'], data['id'], data['jobId'], data['id']))
            self.db.execute('UPDATE batches SET updated=? WHERE id=?', (now(), data['id']))
            return True
        if op == 'job.finish':
            record = self.batch(data['id'])
            if record['state'] == 'stopping':
                return False
            result = data.get('result')
            if data['state'] == 'completed':
                if record['mode'] != 'silent' or record['spec'].get('mode') != 'silent' or not isinstance(result, dict) or result.get('mode') != 'silent' or type(result.get('audioTrackCount')) != int or result['audioTrackCount'] != 0 or type(result.get('durationSeconds')) not in (float, int) or not math.isfinite(result['durationSeconds']) or result['durationSeconds'] <= 0:
                    raise StoreError('ADAPTER_PROTOCOL')
                result = {key: result[key] for key in ('mode', 'audioTrackCount', 'durationSeconds', 'reusedSegments') if key in result}
            else:
                result = None
            self.db.execute("UPDATE jobs SET state=?,error_code=?,completed=CASE WHEN ?='completed' THEN total ELSE completed END,result=? WHERE batch=? AND id=? AND state='running'",
                            (data['state'], data.get('errorCode'), data['state'], json.dumps(result) if result else None, data['id'], data['jobId']))
            return True
        if op == 'batch.stop':
            record = self.batch(data['id'], data.get('clientId'))
            if record['state'] == 'queued':
                self.db.execute("UPDATE batches SET state='cancelled',error_code='CANCELLED',updated=? WHERE id=?", (now(), data['id']))
                self.db.execute("UPDATE jobs SET state='cancelled',error_code='CANCELLED' WHERE batch=? AND state='queued'", (data['id'],))
            elif record['state'] in ('running', 'stopping'):
                self.db.execute("UPDATE batches SET state='stopping',error_code='CANCELLED',updated=? WHERE id=?", (now(), data['id']))
                self.db.execute("UPDATE jobs SET state=CASE WHEN state='running' THEN 'stopping' ELSE 'cancelled' END,error_code='CANCELLED' WHERE batch=? AND state IN ('queued','running')", (data['id'],))
            return self.batch(data['id'])
        if op == 'batch.finish':
            record = self.batch(data['id'])
            if record['state'] == 'stopping' or data.get('cancelled'):
                state, code = 'cancelled', 'CANCELLED'
                self.db.execute("UPDATE jobs SET state='cancelled',error_code='CANCELLED' WHERE batch=? AND state IN ('queued','running','stopping')", (data['id'],))
            elif data.get('fatalCode'):
                state, code = 'failed', data['fatalCode']
                self.db.execute("UPDATE jobs SET state='interrupted',error_code=? WHERE batch=? AND state IN ('queued','running','stopping')", (code, data['id']))
            else:
                states = [j['state'] for j in record['jobs']]
                state, code = ('completed', None) if all(s == 'completed' for s in states) else ('failed', None)
                self.db.execute("UPDATE jobs SET state='failed',error_code='ADAPTER_PROTOCOL' WHERE batch=? AND state IN ('queued','running')", (data['id'],))
            self.db.execute('UPDATE batches SET state=?,error_code=?,updated=? WHERE id=?', (state, code, now(), data['id']))
            self.db.execute("UPDATE runtime SET kind=NULL,item=NULL WHERE id=1 AND kind='batch' AND item=?", (data['id'],))
            return self.batch(data['id'])
        if op == 'batch.retry':
            record = self.batch(data['id'], data.get('clientId'))
            if record['mode'] != 'silent' or record['spec'].get('mode') != 'silent':
                raise StoreError('MODE_UNSUPPORTED', 409)
            if record['state'] not in ('cancelled', 'interrupted', 'failed') or all(j['state'] == 'completed' for j in record['jobs']):
                raise StoreError('RETRY_UNAVAILABLE', 409)
            self.db.execute("UPDATE batches SET state='queued',error_code=NULL,updated=? WHERE id=?", (now(), data['id']))
            self.db.execute("UPDATE jobs SET state='queued',error_code=NULL,result=NULL WHERE batch=? AND state!='completed'", (data['id'],))
            return self.batch(data['id'])
        if op == 'preview.start':
            raise StoreError('PREVIEW_DISABLED', 409)
        if op == 'preview.finish':
            self.db.execute('UPDATE previews SET state=?,duration=?,cache_hit=?,error_code=?,updated=? WHERE id=?', (data['state'], data.get('durationSeconds'), int(bool(data.get('cacheHit'))), data.get('errorCode'), now(), data['id']))
            self.db.execute("UPDATE runtime SET kind=NULL,item=NULL WHERE id=1 AND kind='preview' AND item=?", (data['id'],))
            return True
        if op == 'preview.get':
            row = self.db.execute('SELECT * FROM previews WHERE id=?', (data['id'],)).fetchone()
            if not row or data.get('clientId') is not None and data['clientId'] != row['client']:
                raise StoreError('NOT_FOUND', 404)
            self.client(row['client'])
            return dict(row)
        raise StoreError('INVALID_INPUT')


def serve():
    root = os.environ.get('FANGLI_VIDEO_DATA_DIR') or str(Path(os.environ.get('FANGLI_DATA_DIR', Path(__file__).parent / '.data')) / 'video')
    workspace = str(Path(os.environ.get('FANGLI_DATA_DIR', Path(__file__).parent / '.data')) / 'workspace.sqlite3')
    try:
        store = VideoStore(root, workspace)
    except StoreError as error:
        print(json.dumps({'ready': False, 'code': error.code, 'status': error.status}), flush=True)
        return 1
    print(json.dumps({'ready': True}), flush=True)
    try:
        for line in sys.stdin:
            request = {}
            try:
                request = json.loads(line)
                if request['op'] == 'shutdown':
                    print(json.dumps({'id': request['id'], 'ok': True, 'data': True}), flush=True)
                    break
                result = store.execute(request['op'], request.get('data', {}))
                reply = {'id': request['id'], 'ok': True, 'data': result}
            except StoreError as error:
                reply = {'id': request.get('id'), 'ok': False, 'code': error.code, 'status': error.status}
            except Exception:
                # Never send local paths, SQL, raw provider text or tracebacks to HTTP.
                reply = {'id': request.get('id'), 'ok': False, 'code': 'STORE_UNAVAILABLE', 'status': 503}
            print(json.dumps(reply, ensure_ascii=False), flush=True)
    finally:
        store.close()
    return 0


if __name__ == '__main__':
    sys.exit(serve())
