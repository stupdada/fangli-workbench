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

    def _execute(self, op, data):
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
