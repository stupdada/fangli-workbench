"""Use the workbench read-only context contract, with no client mirror database."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

spec = importlib.util.spec_from_file_location('delivered_video_store', Path(__file__).parent / 'upstream/video-store.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class WorkspaceStore(native.VideoStore):
    def __init__(self, root, unused_workspace):
        origin = os.environ.get('FANGLI_WORKSPACE_BASE', '')
        parsed = urllib.parse.urlsplit(origin)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
            raise native.StoreError('STORE_UNAVAILABLE', 503)
        self.origin = origin.rstrip('/')
        super().__init__(root, Path(root) / '.unused-workspace')
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS workspace_asset_removals(
            id TEXT PRIMARY KEY REFERENCES assets(id), removed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workspace_job_archives(
            batch TEXT NOT NULL, job TEXT NOT NULL, archived_at TEXT NOT NULL,
            PRIMARY KEY(batch,job), FOREIGN KEY(batch,job) REFERENCES jobs(batch,id));
        """)

    def context(self, client, source=None):
        if not isinstance(client, str) or not client.strip() or len(client) > 100:
            raise native.StoreError('CLIENT_INVALID')
        query = {'client_id': client}
        if source is not None:
            if not all(type(source.get(k)) is int and source[k] > 0 for k in ('article_id', 'version_id')):
                raise native.StoreError('INVALID_INPUT')
            query.update({k: source[k] for k in ('article_id', 'version_id')})
        url = self.origin + '/api/workbench/video-context?' + urllib.parse.urlencode(query)
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs): return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(url, timeout=5) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024: raise ValueError('size')
                value = json.loads(raw)
        except urllib.error.HTTPError as error:
            codes = {400: 'INVALID_INPUT', 404: 'NOT_FOUND', 409: 'CONTENT_VERSION_CONFLICT'}
            raise native.StoreError(codes.get(error.code, 'STORE_UNAVAILABLE'), error.code if error.code in codes else 503) from None
        except Exception:
            raise native.StoreError('STORE_UNAVAILABLE', 503) from None
        if value.get('ok') is False or value.get('client', {}).get('id') != client or not isinstance(value.get('documents'), list):
            raise native.StoreError('NOT_FOUND', 404)
        if source is not None:
            art = value.get('article', {})
            if any(art.get(k) != source[k] for k in ('article_id', 'version_id')) or not isinstance(art.get('body_md'), str) or not isinstance(art.get('title'), str):
                raise native.StoreError('CONTENT_VERSION_CONFLICT', 409)
        return value

    def client(self, client):
        self.context(client)
        return client

    def source(self, client, source):
        if source is None: return
        article = self.context(client, source)['article']
        snapshot = {k: article[k] for k in ('article_id', 'version_id', 'title', 'body_md')}
        def first(*keys):
            return next((article[k] for k in keys if article.get(k) is not None), None)
        snapshot['provenance'] = {'structured': first('zip_data', 'structured', 'data'),
                                  'nativeAudit': first('native_audit', 'audit'),
                                  'bodyOriginal': first('body_original'),
                                  'rawGeneration': first('raw_generation'), 'rawAudit': first('raw_audit')}
        identity = {k: snapshot[k] for k in ('article_id', 'version_id', 'title', 'body_md')}
        digest = hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
        if any(source.get(k) != snapshot[k] for k in snapshot) or source.get('digest') != digest:
            raise native.StoreError('CONTENT_VERSION_CONFLICT', 409)

    def batch(self, ident, client=None):
        record = super().batch(ident, client)
        archived = dict(self.db.execute('SELECT job,archived_at FROM workspace_job_archives WHERE batch=?', (ident,)).fetchall())
        for job in record['jobs']:
            job['archived_at'] = archived.get(job['id'])
        return record

    def _execute(self, op, data):
        if op == 'asset.list':
            client = self.client(data.get('clientId'))
            condition = 'IS NOT NULL' if data.get('removed') is True else 'IS NULL'
            rows = self.db.execute(f"""SELECT a.id,a.name,a.type,a.size,r.removed_at FROM assets a
                LEFT JOIN workspace_asset_removals r ON r.id=a.id WHERE a.client=? AND r.id {condition}
                ORDER BY a.created DESC,a.id""", (client,))
            return [{k: row[k] for k in row.keys() if row[k] is not None} for row in rows]
        if op == 'asset.get':
            row = super()._execute(op, data)
            state = self.db.execute('SELECT removed_at FROM workspace_asset_removals WHERE id=?', (row['id'],)).fetchone()
            row['removed_at'] = state[0] if state else None
            return row
        if op == 'asset.lifecycle':
            row = super()._execute('asset.get', data)
            if data['removed']:
                self.db.execute('INSERT OR IGNORE INTO workspace_asset_removals VALUES (?,?)', (row['id'], native.now()))
            else:
                self.db.execute('DELETE FROM workspace_asset_removals WHERE id=?', (row['id'],))
            return self._execute('asset.get', data)
        if op == 'job.lifecycle':
            record = self.batch(data['id'], data['clientId'])
            job = next((j for j in record['jobs'] if j['id'] == data['jobId']), None)
            if not job:
                raise native.StoreError('NOT_FOUND', 404)
            key = (record['id'], job['id'])
            if data['archived']:
                if job['state'] != 'completed':
                    raise native.StoreError('WORK_ARCHIVE_BUSY', 409)
                self.db.execute('INSERT OR IGNORE INTO workspace_job_archives VALUES (?,?,?)', (*key, native.now()))
            else:
                self.db.execute('DELETE FROM workspace_job_archives WHERE batch=? AND job=?', key)
            return self.batch(record['id'], data['clientId'])
        if op == 'batch.list' and 'archived' in data:
            client = self.client(data['clientId'])
            condition = 'IS NOT NULL' if data['archived'] else 'IS NULL'
            rows = self.db.execute(f"""SELECT b.id FROM batches b WHERE b.client=? AND EXISTS(
                SELECT 1 FROM jobs j LEFT JOIN workspace_job_archives a ON a.batch=j.batch AND a.job=j.id
                WHERE j.batch=b.id AND a.job {condition}) ORDER BY b.rowid DESC LIMIT 100""", (client,)).fetchall()
            return [self.batch(row[0], client) for row in rows]
        if op == 'batch.create':
            spec = data['spec']
            if not self.db.execute('SELECT 1 FROM batches WHERE client=? AND digest=?', (spec['clientId'], data['digest'])).fetchone():
                for asset in spec.get('assetDigests', {}):
                    if self.db.execute('SELECT 1 FROM workspace_asset_removals WHERE id=?', (asset,)).fetchone():
                        raise native.StoreError('ASSET_REMOVED', 409)
        if op == 'content.sources':
            context = self.context(data['clientId'])
            documents = context['documents']
            selected = data.get('sourceIds')
            if selected is not None:
                if any(ident not in {d['id'] for d in documents} for ident in selected):
                    raise native.StoreError('ASSET_INVALID')
                documents = [d for d in documents if d['id'] in selected]
            if not documents or len(documents) > 30 or sum(len(d['text']) for d in documents) > 80000:
                raise native.StoreError('CONTENT_SOURCES_MISSING')
            docs = [dict(id=d['id'], name=d['filename'], content=d['text'], digest=d['digest'], role=d['kind'],
                         contentDigest=hashlib.sha256(d['text'].encode('utf-8')).hexdigest(),
                         readStart=0, readEnd=len(d['text']), offsetUnit='unicode_codepoint') for d in documents]
            return {'clientId': data['clientId'], 'name': context['client']['name'],
                    'profile': context['client']['profile'], 'documents': docs}
        return super()._execute(op, data)


native.VideoStore = WorkspaceStore
if __name__ == '__main__':
    sys.exit(native.serve())
