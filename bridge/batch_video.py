"""Durable short-video stages over the workbench-owned loopback service."""
from contextlib import contextmanager
import http.client
import json
import re
import tempfile
import time
import zipfile
from urllib.parse import urlencode

from app.render import safe_name
from .errors import Conflict, Missing, Problem
from .storage import text_value, uid

BASE = '/api/video/narrated'
ASSETS = {'video.mp4': 'video/mp4', 'captions.srt': 'application/x-subrip', 'cover.png': 'image/png'}
UUID = re.compile(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}')


class VideoInterrupted(Problem):
    status = 503


class VideoStopped(Conflict):
    pass


def identity(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise VideoInterrupted('视频服务未返回完整标识，请核对状态后继续')
    return value


class BatchVideoClient:
    def __init__(self, endpoint):
        self.endpoint = endpoint

    @contextmanager
    def response(self, method, path, payload=None):
        address = self.endpoint()
        if not address or address[0] != '127.0.0.1':
            raise VideoInterrupted('本次工作台的视频服务暂不可用')
        conn = http.client.HTTPConnection(*address, timeout=35)
        try:
            headers = {'Content-Type': 'application/json'}
            if method not in ('GET', 'HEAD'):
                headers['Origin'] = f'http://{address[0]}:{address[1]}'
            conn.request(method, BASE + path, json.dumps(payload, ensure_ascii=False).encode('utf-8') if payload is not None else None,
                         headers)
            response = conn.getresponse()
            if response.status == 404:
                raise Missing('视频制作记录或文件不存在')
            if response.status == 409:
                raise Conflict('视频服务正忙或制作版本已变化，请核对后重试')
            if 400 <= response.status < 500:
                raise Problem('视频服务未接受本次请求，请核对来源与参数')
            if not 200 <= response.status < 300:
                raise VideoInterrupted('视频服务结果未确认，请按原请求继续确认')
            yield response
        except (OSError, http.client.HTTPException):
            raise VideoInterrupted('视频服务连接中断，请按原请求继续确认') from None
        finally:
            conn.close()

    def request(self, method, path, payload=None):
        with self.response(method, path, payload) as response:
            data = response.read(2 * 1024 * 1024 + 1)
        try:
            result = json.loads(data) if len(data) <= 2 * 1024 * 1024 else None
        except (ValueError, UnicodeError):
            result = None
        if not isinstance(result, dict) or result.get('ok') is False:
            raise VideoInterrupted('视频服务未返回完整状态，请按原请求继续确认')
        return result

    def generate(self, payload):
        return self.request('POST', '/productions', payload)

    def production(self, production_id):
        return self.request('GET', '/productions/' + identity(production_id))

    def render(self, production_id, payload):
        return self.request('POST', f'/productions/{identity(production_id)}/renders', payload)

    def wait(self, operation_id):
        return self.request('GET', f'/operations/{identity(operation_id)}?wait=1')

    def asset(self, production_id, render_id, name, target):
        if name not in ASSETS:
            raise Missing('导出文件不在成片清单内')
        path = f'/productions/{identity(production_id)}/renders/{identity(render_id)}/{name}'
        with self.response('GET', path) as response:
            mime = response.getheader('Content-Type', '').split(';', 1)[0]
            if mime != ASSETS[name]:
                raise Conflict('成片文件格式与制作记录不一致')
            length, total = response.length, 0
            for chunk in iter(lambda: response.read(256 * 1024), b''):
                target.write(chunk)
                total += len(chunk)
            if not total or length is not None and length != total:
                raise Conflict('成片文件不完整')


def video_specs(value, *, allow_unset=False):
    if not isinstance(value, list) or len(value) > 3:
        raise Problem('每批最多安排三条视频')
    result = []
    for video in value:
        if not isinstance(video, dict) or set(video) - {'topic', 'source', 'article_index', 'narration'}:
            raise Problem('视频安排字段不正确')
        source, narration = video.get('source'), video.get('narration', True)
        topic = '' if allow_unset and source == 'documents' and 'topic' not in video else text_value(
            video.get('topic'), '视频主题', 500, empty=False).strip()
        if source not in ('documents', 'article') or type(narration) is not bool or '\x00' in topic:
            raise Problem('视频来源、主题或配音设置不正确')
        if source == 'article':
            if type(video.get('article_index')) is not int or video['article_index'] < 1:
                raise Problem('文章来源序号从1开始')
        elif 'article_index' in video:
            raise Problem('资料直出无需文章序号')
        result.append({**video, 'topic': topic, 'narration': narration})
    return result


class BatchVideos:
    def __init__(self, batches):
        self.batches, self.store = batches, batches.store
        self.client = BatchVideoClient(lambda: None)
        with self.store.conn() as conn:
            conn.executescript('''
                CREATE TABLE IF NOT EXISTS wb_batch_videos(
                    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                    topic TEXT NOT NULL, source TEXT NOT NULL, article_index INTEGER, narration INTEGER NOT NULL,
                    status TEXT NOT NULL, stage TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
                    article_id INTEGER, version_id INTEGER, production_id TEXT, render_id TEXT,
                    script_attempt INTEGER NOT NULL DEFAULT 1, render_attempt INTEGER NOT NULL DEFAULT 1,
                    script_request_key TEXT, render_request_key TEXT,
                    script_operation_id TEXT, render_operation_id TEXT, terminal INTEGER NOT NULL DEFAULT 0);
                CREATE INDEX IF NOT EXISTS wb_batch_video_items ON wb_batch_videos(item_id,sequence);
            ''')
            conn.execute("UPDATE wb_batch_videos SET status='interrupted', error='上次视频处理已中断，请确认已有结果后继续' WHERE status='running'")

    def insert(self, conn, item_id, videos):
        for index, video in enumerate(videos):
            stage = 'waiting_article' if video['source'] == 'article' else 'script'
            conn.execute('''INSERT INTO wb_batch_videos(id,item_id,sequence,topic,source,article_index,narration,status,stage)
                VALUES(?,?,?,?,?,?,?,'queued',?)''', (uid(), item_id, index, video['topic'], video['source'],
                                                     video.get('article_index'), video['narration'], stage))

    def rows(self, conn, item_id):
        return [dict(row) for row in conn.execute('SELECT * FROM wb_batch_videos WHERE item_id=? ORDER BY sequence', (item_id,))]

    def public(self, row, cid):
        result = {k: row[k] for k in ('id', 'topic', 'source', 'status', 'stage', 'error')}
        for name in ('article_index', 'article_id', 'version_id', 'production_id', 'render_id'):
            if row[name] is not None:
                result[name] = row[name]
        if row['production_id']:
            result['preview_url'] = '/video/narrated/?' + urlencode({'client_id': cid, 'production_id': row['production_id']})
        return {**result, 'narration': bool(row['narration'])}

    def update(self, row, **values):
        with self.store.conn() as conn:
            conn.execute('UPDATE wb_batch_videos SET ' + ','.join(f'{key}=?' for key in values) + ' WHERE id=?',
                         (*values.values(), row['id']))
        row.update(values)

    @staticmethod
    def requeue(conn, row):
        stage = row['stage']
        if row['terminal'] and stage in ('script', 'render'):
            conn.execute(f'''UPDATE wb_batch_videos SET {stage}_attempt={stage}_attempt+1,
                {stage}_request_key=NULL,{stage}_operation_id=NULL WHERE id=?''', (row['id'],))
        conn.execute("UPDATE wb_batch_videos SET status='queued',error='',terminal=0 WHERE id=?", (row['id'],))

    def guard(self, item):
        if self.batches.closing:
            raise VideoInterrupted('工作台已停止等待视频，请确认已有结果后继续')
        if item['id'] in self.batches.stopping:
            raise VideoStopped('视频批次已暂停，已提交的操作可在继续时确认')

    def operation(self, item, row, stage, start):
        operation_field = stage + '_operation_id'
        operation_id = row[operation_field]
        if not operation_id:
            key_field = stage + '_request_key'
            request_key = row[key_field]
            if not request_key:
                request_key = f"batch-video-{row['id']}-{stage}-{row[stage + '_attempt']}"
                self.update(row, **{key_field: request_key})
            operation_id = identity(start(request_key).get('id'))
            self.update(row, **{operation_field: operation_id})
        deadline = time.monotonic() + 15 * 60
        while time.monotonic() < deadline:
            self.guard(item)
            try:
                result = self.client.wait(operation_id)
            except Missing:
                raise VideoInterrupted('暂未找到已提交的操作，请核对视频服务状态') from None
            if result.get('id') != operation_id or result.get('client_id') != item['client_id']:
                raise VideoInterrupted('视频操作归属无法确认')
            status = result.get('status')
            if status == 'completed':
                return result
            if status in ('failed', 'interrupted'):
                self.update(row, terminal=1)
                phase = '脚本' if stage == 'script' else '成片'
                if status == 'interrupted':
                    raise VideoInterrupted(f'{phase}操作已中断，请确认后重试此阶段')
                detail = result.get('error')
                if stage == 'script' and isinstance(detail, str) and re.fullmatch(
                    r'第[1-6](?:页口播|屏字幕)最多[0-9]{1,2}个有效字符|口播共[0-9]{1,4}字，请调整为100—160字', detail
                ):
                    raise Problem(f'脚本校验失败，{detail}。可单独重试视频。')
                raise Problem(f'{phase}制作未完成，请检查视频工作区后重试')
            if status != 'running':
                break
        raise VideoInterrupted('视频操作结果尚未确认，请继续确认原操作')

    def verify_production(self, cid, row):
        value = self.client.production(row['production_id'])
        source, client = value.get('source'), value.get('client')
        expected_source = (row['article_id'], row['version_id']) if row['source'] == 'article' else None
        actual_source = (source.get('article_id'), source.get('version_id')) if isinstance(source, dict) else None
        if (value.get('id') != row['production_id'] or not isinstance(client, dict) or client.get('id') != cid
                or actual_source != expected_source or (source is not None and not isinstance(source, dict))):
            raise Conflict('视频制作记录不属于本批来源')
        return value

    def process(self, item, row):
        try:
            with self.batches.s.guard:
                self.guard(item)
                if row['stage'] == 'waiting_article':
                    raise Problem(f"第{row['article_index']}篇文章尚未完成，请先继续文章任务")
                self.update(row, status='running', error='')
            if row['stage'] == 'script':
                payload = {'clientId': item['client_id'], 'topic': row['topic']}
                if row['source'] == 'article':
                    payload['source'] = {'article_id': row['article_id'], 'version_id': row['version_id']}
                else:
                    payload['conversation_id'] = item['conversation_id']
                result = self.operation(item, row, 'script', lambda key: self.client.generate({**payload, 'request_key': key}))
                self.update(row, production_id=identity(result.get('production_id')), stage='render')
            self.guard(item)
            self.verify_production(item['client_id'], row)
            payload = {'expected_version': 1, 'narration': bool(row['narration'])}
            result = self.operation(item, row, 'render', lambda key: self.client.render(row['production_id'], {**payload, 'request_key': key}))
            if result.get('production_id') != row['production_id'] or result.get('version') != 1:
                raise VideoInterrupted('视频成片与本批制作版本不一致')
            self.update(row, status='done', stage='done', render_id=identity(result.get('render_id')))
        except Problem as exc:
            status = 'interrupted' if isinstance(exc, VideoInterrupted) else 'stopped' if isinstance(exc, VideoStopped) else 'error'
            self.update(row, status=status, error=str(exc))

    def download(self, rows):
        if not rows:
            raise Conflict('本批尚无已完成视频可下载')
        buffer = tempfile.TemporaryFile(mode='w+b')
        try:
            with zipfile.ZipFile(buffer, 'w') as archive:
                for sequence, row in enumerate(rows, 1):
                    try:
                        production = self.verify_production(row['client_id'], row)
                        renders = production.get('renders')
                        if not isinstance(renders, list) or not any(isinstance(r, dict) and r.get('id') == row['render_id']
                                                                    and r.get('version') == 1 for r in renders):
                            raise Missing('成片记录不存在')
                        topic = re.sub(r'[\x00-\x1f\x7f]', '_', safe_name(row['topic']))
                        folder = f'{sequence:02d}-{topic}'
                        for name in ASSETS:
                            with archive.open(f'{folder}/{name}', 'w', force_zip64=True) as target:
                                self.client.asset(row['production_id'], row['render_id'], name, target)
                    except Missing:
                        raise Conflict(f"《{row['topic']}》的成片文件缺失，请在视频工作区核对") from None
            size = buffer.tell()
            buffer.seek(0)
            return buffer, size
        except BaseException:
            buffer.close()
            raise
