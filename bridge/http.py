"""Loopback-only same-origin HTTP surface. Native mutation routes are not mounted."""
import base64
import http.client
import json
import mimetypes
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from app import generator, parsers, grouping
from . import provider, exports, configuration
from .errors import Problem, Missing, Conflict, Forbidden
from .native import LocalStore
from .service import Service, ROOT
from .storage import integer
from .video_process import VideoProcess
from .zip_evidence import article_metadata

MAX_BODY = 12 * 1024 * 1024
MAX_VIDEO_TRANSFER = 64 * 1024 * 1024
WEB = ROOT / 'web'


class DatabaseLease:
    """A second process must not recover locks belonging to a live service."""
    def __init__(self, path):
        path = Path(path).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        self.file = open(str(path) + '.service.lock', 'a+b')
        if self.file.tell() == 0:
            self.file.write(b'0')
            self.file.flush()
        self.file.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise Conflict('此数据目录已有工作台服务，请复用原窗口或指定新的数据目录') from None

    def close(self):
        if not self.file.closed:
            self.file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            self.file.close()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, db_path, video_base=None):
        if address[0] != '127.0.0.1': raise Problem('主服务只允许监听127.0.0.1')
        self.video_base = None
        if video_base:
            raise Problem('视频现由主服务托管，请移除手填的--video-base')
        self.lease = DatabaseLease(db_path)
        try:
            self.service = Service(LocalStore(db_path))
            super().__init__(address, Handler)
            private = Path(db_path).resolve().parent
            self.video = VideoProcess(f'http://127.0.0.1:{self.server_port}', private / 'video', private / 'logs')
        except Exception:
            self.lease.close()
            raise

    def server_close(self):
        if hasattr(self, 'video'): self.video.stop()
        finished = self.service.close()
        super().server_close()
        if finished: self.lease.close()


def create_server(db_path=None, port=8770, video_base=None):
    path = Path(db_path or ROOT / 'data/workbench/workbench.db').resolve()
    # A local data directory is never a static asset directory.
    if path.is_relative_to(WEB.resolve()): raise Problem('数据目录必须位于静态资源目录之外')
    return Server(('127.0.0.1', port), path, video_base)


class Handler(BaseHTTPRequestHandler):
    server_version = 'FangliWorkbench/1.0'
    sys_version = ''

    @property
    def service(self): return self.server.service

    def log_message(self, *_): pass

    def _send(self, status, body=b'', ctype='application/json; charset=utf-8', extra=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'")
        for key, value in (extra or {}).items(): self.send_header(key, value)
        self.end_headers()
        if self.command != 'HEAD':
            try: self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, OSError): pass

    def _json(self, data, status=200):
        self._send(status, json.dumps({'ok': True, **data}, ensure_ascii=False, allow_nan=False).encode('utf-8'))

    def deliver(self, body, ctype, name):
        """Write a finished file into the configured folder, or fall back to a browser download.

        A rejected folder must not lose the export: the same bytes still stream to the page,
        and the page explains why the chosen folder was not used.
        """
        try:
            target = self.service.downloads.write(name, body)
        except Problem as exc:
            return self._send(200, body, ctype, {
                'Content-Disposition': "attachment; filename*=UTF-8''" + urllib.parse.quote(name),
                'X-Download-Error': urllib.parse.quote(str(exc))})
        return self._json({'path': str(target), 'name': target.name})

    def _boundary(self):
        host = self.headers.get('Host', '')
        allowed = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        if host not in allowed: raise Forbidden('仅允许通过本机服务地址访问')
        origin = self.headers.get('Origin')
        if origin is not None and origin != 'http://' + host: raise Forbidden('仅允许同源访问')
        if self.headers.get('Sec-Fetch-Site') == 'cross-site': raise Forbidden('仅允许同源访问')
        if self.headers.get('Transfer-Encoding'): raise Problem('不接受分块请求体')
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) > 1 or lengths and not lengths[0].isdigit(): raise Problem('请求长度不正确')

    def _raw_body(self):
        try: length = int(self.headers.get('Content-Length') or 0)
        except ValueError: raise Problem('请求长度不正确') from None
        if length < 0 or length > MAX_BODY: raise Problem('请求内容过大，单文件最多8MB')
        self.connection.settimeout(30)
        raw = self.rfile.read(length)
        if len(raw) != length: raise Problem('请求体未完整收到')
        return raw

    def _body(self):
        if self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
            raise Problem('请求需使用application/json')
        try: value = json.loads(self._raw_body().decode('utf-8'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (UnicodeError, ValueError): raise Problem('JSON需为完整的UTF-8内容') from None
        if not isinstance(value, dict): raise Problem('JSON请求体需为对象')
        return value

    def _dispatch(self):
        try:
            self._boundary()
            parsed = urllib.parse.urlsplit(self.path)
            path = urllib.parse.unquote(parsed.path)
            if '\\' in path or '\x00' in path or any(s in ('.', '..') for s in path.split('/')):
                raise Forbidden('路径不正确')
            query = urllib.parse.parse_qs(parsed.query)
            if path == '/video':
                return self._send(302, b'', 'text/plain; charset=utf-8', {'Location': '/video/' + ('?' + parsed.query if parsed.query else '')})
            if path.startswith('/video/') or path == '/api/video' or path.startswith('/api/video/'):
                return self._proxy(self.path)
            if self.command in ('GET', 'HEAD'):
                if path.startswith('/api/'): return self.route_get(path, query)
                return self.static(path)
            if path.startswith(('/api/articles', '/api/plans', '/api/materials')):
                raise Forbidden('请通过工作台稿件与版本接口修改内容')
            return self.route_write(self.command, path, self._body())
        except Problem as exc:
            self._send(exc.status, json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False).encode('utf-8'))
        except llm_errors() as exc:
            self._send(502, json.dumps({'ok': False, 'error': provider.public_error(exc)}, ensure_ascii=False).encode('utf-8'))
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            self._send(500, json.dumps({'ok': False, 'error': '本地服务请求未完成，已有输入保留'}, ensure_ascii=False).encode('utf-8'))
        except Exception:
            self._send(500, json.dumps({'ok': False, 'error': '本地处理未完成，已有输入保留；请查看服务状态'}, ensure_ascii=False).encode('utf-8'))

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_OPTIONS = _dispatch

    def static(self, path):
        if path in ('/', '/index.html'): relative = 'index.html'
        elif path in ('/workbench', '/workbench/'): relative = 'workbench/index.html'
        elif path in ('/workbench/zip', '/workbench/zip/'): relative = 'workbench/zip/index.html'
        else: relative = path.removeprefix('/static/').lstrip('/')
        file = (WEB / relative).resolve()
        if not file.is_relative_to(WEB.resolve()) or any(s.startswith('.') for s in Path(relative).parts): raise Forbidden('路径不正确')
        if not file.is_file(): raise Missing('页面不存在')
        ctype = {'.mjs': 'application/javascript', '.js': 'application/javascript'}.get(file.suffix) or mimetypes.guess_type(str(file))[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype == 'application/javascript': ctype += '; charset=utf-8'
        self._send(200, file.read_bytes(), ctype)

    @staticmethod
    def query_int(query, key, required=True):
        value = (query.get(key) or [''])[0]
        if not value and not required: return None
        if not value.isdigit() or int(value) < 1: raise Problem(f'{key}需为正整数')
        return int(value)

    def route_get(self, path, query):
        s, ws = self.service, self.service.ws
        if path == '/api/workbench/runtime':
            return self._json({'main': {'pid': os.getpid(), 'port': self.server.server_port}, 'video': self.server.video.snapshot()})
        if path in ('/api/workbench/bootstrap', '/api/bootstrap'): return self._json(s.bootstrap())
        if path == '/api/workbench/zip-config': return self._json(s.zip_config())
        if path == '/api/workbench/clients': return self._json({'clients': ws.clients()})
        if path == '/api/workbench/batches': return self._json({'batches': s.batches.list()})
        match = re.fullmatch(r'/api/workbench/batches/([^/]+)', path)
        if match: return self._json({'batch': s.batches.get(match[1])})
        match = re.fullmatch(r'/api/workbench/clients/([^/]+)(?:/(generation-plan|history))?', path)
        if match:
            cid, action = match.groups()
            if action == 'generation-plan': return self._json(s.customers.plan(cid))
            if action == 'history': return self._json(s.customers.history(cid))
            return self._json({'client': ws.client(cid), **s.customers.plan(cid)})
        match = re.fullmatch(r'/api/workbench/clients/([^/]+)/documents/([^/]+)/(original|text|revisions)', path)
        if match:
            cid, did, action = match.groups()
            if action == 'revisions': return self._json({'documents': ws.files.revisions(cid, did)})
            body, ctype, name = ws.files.download(cid, did, action == 'original')
            return self._send(200, body, ctype, {'Content-Disposition': "attachment; filename*=UTF-8''" + urllib.parse.quote(name)})
        if path == '/api/workbench/provider-models': return self._json({'provider_models': s.refresh_models()})
        if path in ('/api/models', '/api/platforms', '/api/risks', '/api/prefs'):
            key = path.rsplit('/', 1)[-1]
            return self._json({key: {'models': s.store.list_models, 'platforms': s.store.list_platforms, 'risks': s.store.list_risks, 'prefs': s.store.get_prefs}[key]()})
        match = re.fullmatch(r'/api/workbench/clients/([^/]+)/documents', path)
        if match: return self._json({'documents': ws.documents(match[1])})
        match = re.fullmatch(r'/api/workbench/conversations/([^/]+)', path)
        if match: return self._json(s.view(match[1]))
        match = re.fullmatch(r'/api/workbench/operations/([^/]+)', path)
        if match: return self._json({'operation': ws.operation(match[1])})
        match = re.fullmatch(r'/api/jobs/([^/]+)(/stream)?', path)
        if match:
            job = generator.get_job(match[1])
            if not job or not any(c['job_id'] == match[1] for c in ws.conversations()): raise Missing('任务不存在')
            return self.sse(match[1]) if match[2] else self._json({'job': job})
        match = re.fullmatch(r'/api/workbench/conversations/([^/]+)/articles/(\d+)/(versions|compare)', path)
        if match:
            ident, aid, action = match[1], int(match[2]), match[3]
            with s.guard:
                _, article = s.article_context(ident, aid)
                if action == 'versions': return self._json({'current_version': article['current_version'], 'versions': ws.versions(aid), 'review_records': ws.review_records(aid)})
                data = exports.compare(s, ident, aid, self.query_int(query, 'candidate_version'))
            fmt = (query.get('fmt') or [''])[0]
            if fmt == 'md': return self._send(200, exports.compare_markdown(data).encode('utf-8'), 'text/markdown; charset=utf-8', {'Content-Disposition': 'attachment; filename="comparison.md"'})
            return self._json(data)
        match = re.fullmatch(r'/api/workbench/conversations/([^/]+)/export', path)
        if match:
            raw = (query.get('ids') or [''])[0]
            ids = None
            if 'ids' in query:
                if not raw or any(not v.strip().isdigit() for v in raw.split(',')): raise Problem('导出稿件ID不正确')
                ids = [int(v.strip()) for v in raw.split(',')]
            body, ctype, name = exports.export(s, match[1], (query.get('fmt') or ['docx'])[0], ids)
            if (query.get('save') or [''])[0] == '1': return self.deliver(body, ctype, name)
            return self._send(200, body, ctype, {'Content-Disposition': "attachment; filename*=UTF-8''" + urllib.parse.quote(name)})
        match = re.fullmatch(r'/api/workbench/conversations/([^/]+)/archive', path)
        if match:
            body, ctype, name = exports.archive(s, match[1])
            if (query.get('save') or [''])[0] == '1': return self.deliver(body, ctype, name)
            return self._send(200, body, ctype, {'Content-Disposition': "attachment; filename*=UTF-8''" + urllib.parse.quote(name)})
        if path == '/api/workbench/video-context': return self._json(self.video_context(query))
        raise Missing('接口不存在')

    def route_write(self, method, path, body):
        s, ws = self.service, self.service.ws
        configured = configuration.write(s, method, path, body)
        if configured is not None: return self._json(configured)
        if path == '/api/workbench/video-service/restart' and method == 'POST':
            return self._json({'video': self.server.video.restart()})
        if path == '/api/workbench/shutdown' and method == 'POST':
            self._json({'message': '正在关闭本工作台及其拥有的视频子服务'})
            threading.Thread(target=self.server.shutdown, name='workbench-stop', daemon=True).start()
            return
        if path in ('/api/workbench/settings', '/api/settings') and method == 'POST': return self._json({'settings': s.save_settings(body)})
        if path == '/api/workbench/downloads/pick' and method == 'POST':
            if body: raise Problem('选择下载路径无需额外字段')
            return self._json(s.downloads.pick())
        if path == '/api/workbench/clients' and method == 'POST':
            if body.get('id') is not None: raise Problem('已有客户请使用客户独立更新接口')
            return self._json({'client': ws.save_client(body.get('name'), body.get('profile'))})
        match = re.fullmatch(r'/api/workbench/clients/([^/]+)(?:/(generation-plan))?', path)
        if match and method == 'PUT':
            cid, action = match.groups()
            return self._json(s.customers.save_plan(cid, body) if action else {'client': s.customers.update(cid, body)})
        match = re.fullmatch(r'/api/workbench/clients/([^/]+)/documents/check', path)
        if match and method == 'POST':
            if set(body) - {'filename', 'sha256', 'text_digest'}: raise Problem('资料检查含未知字段')
            return self._json(ws.files.check(match[1], body.get('filename'), body.get('sha256', ''), body.get('text_digest', '')))
        match = re.fullmatch(r'/api/workbench/clients/([^/]+)/documents', path)
        if match and method == 'POST':
            with s.guard:
                return self._json(ws.files.import_document(match[1], body))
        if path == '/api/workbench/batches/preflight' and method == 'POST':
            if set(body) != {'items'}: raise Problem('预检需包含items')
            return self._json(s.batches.preflight(body['items']))
        if path == '/api/workbench/batches' and method == 'POST': return self._json({'batch': s.batches.submit(body)})
        match = re.fullmatch(r'/api/workbench/batches/([^/]+)/(stop|resume)', path)
        if match and method == 'POST':
            if match[2] == 'stop':
                if body: raise Problem('停止批次无需额外字段')
                return self._json({'batch': s.batches.stop(match[1])})
            return self._json({'batch': s.batches.resume(match[1], body)})
        if path == '/api/workbench/conversations' and method == 'POST': return self._json({'conversation': s.create_conversation(body.get('client_id'))})
        match = re.fullmatch(r'/api/workbench/conversations/([^/]+)(/clone)?', path)
        if match:
            if match[2] and method == 'POST': return self._json({'conversation': s.clone_conversation(match[1])})
            if not match[2] and method == 'DELETE': return self._json(s.delete_conversation(match[1]))
        match = re.fullmatch(r'/api/workbench/conversations/([^/]+)/profile', path)
        if match and method == 'PUT':
            if set(body) - {'name', 'profile', 'save_as_default'}: raise Problem('客户字段保存含未知选项')
            return self._json(s.save_task_profile(match[1], body.get('name'), body.get('profile'), body.get('save_as_default', False)))
        if path == '/api/parse' and method == 'POST':
            name = body.get('filename')
            if not isinstance(name, str) or not name.strip() or len(name) > 255: raise Problem('缺少有效资料文件名')
            try: raw = base64.b64decode(body.get('content_b64') or '', validate=True)
            except (ValueError, TypeError): raise Problem('文件内容读取失败，请重新选择') from None
            try: value = parsers.parse_file(name, raw)
            except (parsers.Unsupported, parsers.ParseError) as exc: raise Problem(str(exc)) from None
            return self._json({**value, 'filename': name})
        if path == '/api/aliases' and method == 'POST': return self._json({'aliases': grouping.find_aliases(body.get('keywords') or [])})
        match = re.fullmatch(r'/api/workbench/conversations/([^/]+)/(draft|chat|start|stop|write-one)', path)
        if match:
            ident, action = match[1], match[2]
            if action == 'draft' and method == 'PUT': return self._json({'conversation': s.save_draft(ident, body.get('options'), body.get('document_ids'), body.get('mode'), body.get('followup'))})
            if action == 'chat' and method == 'POST': return self._json({'operation_id': s.chat(ident, body.get('text'), body.get('document_ids'), body.get('followup'), body.get('options'))})
            if action == 'start' and method == 'POST': return self._json(s.start(ident, body.get('options')))
            if action == 'write-one' and method == 'POST': return self._json(s.start(ident, body.get('options'), one=True))
            if action == 'stop' and method == 'POST': return self._json(s.stop(ident))
        match = re.fullmatch(r'/api/workbench/operations/([^/]+)/stop', path)
        if match and method == 'POST': return self._json(s.cancel_operation(match[1]))
        match = re.fullmatch(r'/api/workbench/conversations/([^/]+)/articles/(\d+)(?:/(select-version|style-review|style-rewrite|revise|review-record|regenerate|audit))?', path)
        if match:
            ident, aid, action = match[1], int(match[2]), match[3]
            with s.guard:
                s.article_context(ident, aid)
                if action is None and method == 'PUT':
                    if set(body) - {'expected_version', 'body_md', 'title', 'tags', 'decl'}: raise Problem('稿件保存含未知字段')
                    if any(k in body and body[k] is None for k in ('body_md', 'title', 'tags', 'decl')): raise Problem('清空标签或声明请传空列表，文字不能为null')
                    ws.edit(aid, body.get('expected_version'), body.get('body_md'), body.get('title'), body.get('tags'), body.get('decl'))
                    return self._json({'article': ws.current(aid)})
                if action is None and method == 'DELETE': return self._json(s.delete_article(ident, aid, body.get('expected_version')))
                if action in ('regenerate', 'audit') and method == 'POST': return self._json({'operation_id': s.native_action(ident, aid, body.get('expected_version'), action, body.get('extra_note', ''))})
                if action == 'select-version' and method == 'POST':
                    ws.select_version(aid, body.get('version_id'), body.get('expected_version'))
                    return self._json({'article': ws.current(aid)})
                if action == 'style-review' and method == 'POST': return self._json({'operation_id': s.style_review(ident, aid, body.get('expected_version'))})
                if action == 'style-rewrite' and method == 'POST': return self._json({'operation_id': s.rewrite(ident, aid, body.get('expected_version'), body.get('review_id'), body.get('selected'), body.get('mode', 'full'), body.get('material', ''), body.get('conservative'))})
                if action == 'revise' and method == 'POST': return self._json({'operation_id': s.revise(ident, aid, body.get('expected_version'), body.get('instruction'))})
                if action == 'review-record' and method == 'PUT':
                    ws.save_review_notes(aid, body.get('candidate_version'), body.get('codex_review'), body.get('user_review'))
                    return self._json({'review_records': ws.review_records(aid)})
        # No generic fallback to app.server: native article/plan/upload routes could bypass locks.
        raise Missing('接口不存在')

    def video_context(self, query):
        ws, s = self.service.ws, self.service
        cid = (query.get('client_id') or [''])[0]
        if not cid:
            if 'article_id' in query or 'version_id' in query: raise Problem('请求稿件版本时需明确client_id')
            return {'clients': ws.clients()}
        client = ws.client(cid)
        result = {'client': {k: client[k] for k in ('id', 'name', 'profile')},
            'documents': [{k: d[k] for k in ('id', 'filename', 'kind', 'text', 'digest')} for d in ws.documents(cid)]}
        aid = self.query_int(query, 'article_id', False)
        vid = self.query_int(query, 'version_id', False)
        if bool(vid) != bool(aid): raise Problem('文章来源需同时指定article_id和version_id')
        if aid:
            with s.guard:
                native = s.store.get_article(aid)
                if not native or not any(c['plan_id'] == native['plan_id'] for c in ws.conversations(cid, include_deleted=True)): raise Missing('稿件不属于所选客户')
                version = ws.version(aid, vid)
                if not vid or not ws.was_adopted(aid, vid): raise Conflict('视频来源需为明确采用过的稿件版本')
                article = version['article']
                result['article'] = {'article_id': aid, 'version_id': vid,
                    **{k: article.get(k, '') for k in ('title', 'body_md', 'platform_name', 'account_type')},
                    **article_metadata(ws, aid, vid)}
        return result

    def sse(self, jid):
        """Original ZIP next/chunk/status/end event shape and segment semantics."""
        if self.command == 'HEAD': return self._send(200, b'', 'text/event-stream; charset=utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()
        def emit(value):
            self.wfile.write(('data: ' + json.dumps(value, ensure_ascii=False) + '\n\n').encode('utf-8'))
            self.wfile.flush()
        sent, seg, last_msg, heartbeat = 0, 0, '', time.monotonic()
        try:
            while not self.service.closed:
                job = generator.get_job(jid) or {}
                current = int(job.get('seg') or 0)
                if current != seg:
                    seg, sent = current, 0
                    items = job.get('items') or []
                    emit({'type': 'next', 'seg': current, 'platform': job.get('platform') or '', 'account_type': job.get('account_type') or '',
                        'words': job.get('words') or [], 'index': job.get('index') or 0, 'count': job.get('count') or 0,
                        'done': job.get('done') or 0, 'planned': job.get('planned') or 0, 'total_all': job.get('total_all') or 0, 'prev': items[-1] if items else None})
                text = job.get('partial') or ''
                if len(text) > sent:
                    emit({'type': 'chunk', 'text': text[sent:], 'chars': len(text)})
                    sent = len(text)
                message = job.get('message') or ''
                if message != last_msg:
                    last_msg = message
                    emit({'type': 'status', 'message': message, 'phase': job.get('phase') or '', 'done': job.get('done') or 0, 'planned': job.get('planned') or 0})
                if job.get('status') in ('done', 'error', 'paused'):
                    emit({'type': 'end', 'status': job.get('status'), 'title': job.get('title') or '', 'message': message,
                        'article_id': job.get('article_id'), 'score': job.get('score'), 'error': job.get('error') or '',
                        'platform': job.get('platform') or '', 'account_type': job.get('account_type') or '', 'words': job.get('words') or [],
                        'chars': job.get('chars') or len(text), 'audit': job.get('audit') or {}, 'items': job.get('items') or [],
                        'done': job.get('done') or 0, 'planned': job.get('planned') or 0, 'remaining': job.get('remaining') or 0,
                        'total_all': job.get('total_all') or 0, 'canceled': bool(job.get('cancel'))})
                    break
                if time.monotonic() - heartbeat > 20:
                    self.wfile.write(b': ping\n\n'); self.wfile.flush(); heartbeat = time.monotonic()
                time.sleep(.12)
        except (BrokenPipeError, ConnectionResetError, OSError): pass

    def _proxy(self, path):
        endpoint = self.server.video.endpoint()
        if not endpoint:
            return self._send(503, json.dumps({'ok': False, 'error': '视频子服务未就绪，请查看运行状态后明确重启'}, ensure_ascii=False).encode('utf-8'))
        writing = self.command in ('POST', 'PUT', 'PATCH', 'DELETE')
        if writing and self.headers.get('Content-Length') is None:
            return self._send(411, b'{"ok":false,"error":"Content-Length required"}')
        length = int(self.headers.get('Content-Length') or 0)
        if length > MAX_VIDEO_TRANSFER:
            return self._send(413, json.dumps({'ok': False, 'error': '传输体超过64MiB边界'}, ensure_ascii=False).encode('utf-8'))
        conn = http.client.HTTPConnection(*endpoint, timeout=60)
        sent_headers = False
        self.close_connection = True
        try:
            conn.putrequest(self.command, path, skip_host=True, skip_accept_encoding=True)
            for key in ('Host', 'Origin', 'Sec-Fetch-Site', 'Content-Type', 'Content-Length', 'Content-Disposition',
                        'Range', 'If-Range', 'If-None-Match', 'If-Modified-Since', 'Accept'):
                if self.headers.get(key) is not None: conn.putheader(key, self.headers[key])
            conn.putheader('Connection', 'close')
            conn.endheaders()
            self.connection.settimeout(45)
            deadline = time.monotonic() + 180
            remaining = length
            send_error = None
            while remaining:
                if time.monotonic() > deadline: raise TimeoutError('bounded upload expired')
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk: raise ConnectionError('incomplete upload')
                remaining -= len(chunk)
                try: conn.send(chunk)
                except OSError as exc:
                    send_error = exc
                    break
            try: response = conn.getresponse()
            except (OSError, http.client.HTTPException):
                if send_error: raise send_error
                raise
            with response:
                self.send_response(response.status)
                for key in ('Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Disposition',
                            'Cache-Control', 'ETag', 'Last-Modified', 'Content-Encoding', 'Location', 'X-Content-Type-Options'):
                    if response.getheader(key) is not None: self.send_header(key, response.getheader(key))
                # http.client decodes upstream chunk framing; HTTP/1.0 close delimits unknown lengths.
                self.send_header('Connection', 'close')
                self.end_headers()
                sent_headers = True
                if self.command != 'HEAD':
                    while True:
                        chunk = response.read(65536)
                        if not chunk: break
                        self.wfile.write(chunk)
        except (OSError, http.client.HTTPException):
            if not sent_headers:
                self._send(503, json.dumps({'ok': False, 'error': '视频子服务传输未完成；未自动重复请求'}, ensure_ascii=False).encode('utf-8'))
        finally:
            conn.close()


def llm_errors():
    from app.llm import LLMError
    return LLMError
