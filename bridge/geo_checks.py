"""Customer-scoped GEO observations and immutable test plans."""
import hashlib
import json
import os
import re
import threading
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from app.store import now
from .errors import Conflict, Missing, Problem
from .geo_metrics import canonicalize_url, contains_brand_alias
from .storage import dumps, loads, uid, validate_creation_id

ENTRY = '豆包 · 方舟联网内容插件'
SEARCH_SOURCES = ('search_engine', 'toutiao', 'douyin')
SEARCH_INSTRUCTIONS = '请先联网搜索，再回答用户的问题。回答时标注实际使用的来源。'
MODELS = {
    'doubao-seed-2-1-lite-260915': 'Doubao Seed 2.1 Lite',
    'doubao-seed-2-1-turbo-260628': 'Doubao Seed 2.1 Turbo',
    'doubao-seed-2-1-pro-260915': 'Doubao Seed 2.1 Pro',
    'doubao-seed-evolving': 'Doubao Seed Evolving',
}
DEFAULT_MODEL = 'doubao-seed-2-1-lite-260915'
MODEL_ALIASES = {re.sub(r'[^a-z0-9]', '', label.casefold()): ident for ident, label in MODELS.items()}
MAX_CALLS = 16
MAX_OUTPUT = 4096
PROTOCOL = 'ark-responses/online-content/v1'


def signature(data):
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True, allow_nan=False).encode('utf-8')).hexdigest()


def text(value, limit, label):
    if not isinstance(value, str) or len(value.strip()) > limit:
        raise Problem(f'{label}最多 {limit} 字')
    return value.strip()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ArkGeo:
    def __init__(self, directory):
        self.path = Path(directory) / 'geo-ark.json'
        self.guard = threading.Lock()

    def saved(self):
        try:
            value = json.loads(self.path.read_text(encoding='utf-8-sig'))
        except (OSError, ValueError):
            return {}
        return {k: value[k] for k in ('key', 'model') if isinstance(value.get(k), str)} if isinstance(value, dict) else {}

    @staticmethod
    def environment_key():
        return os.getenv('FANGLI_GEO_ARK_API_KEY') or os.getenv('ARK_API_KEY') or ''

    @staticmethod
    def effective_model(value):
        value = (value or DEFAULT_MODEL).strip()
        return MODEL_ALIASES.get(re.sub(r'[^a-z0-9]', '', value.casefold()), value)

    def settings(self):
        saved = self.saved()
        return (self.environment_key() or saved.get('key', ''),
                self.effective_model(os.getenv('FANGLI_GEO_ARK_MODEL') or saved.get('model')))

    def info(self):
        key, model = self.settings()
        options = [{'id': ident, 'label': label} for ident, label in MODELS.items()]
        if model not in MODELS:
            options.append({'id': model, 'label': model})
        return {'ready': bool(key), 'model': model, 'models': options, 'entry': ENTRY, 'config': PROTOCOL,
                'max_calls': MAX_CALLS,
                'key_source': 'environment' if self.environment_key() else 'local' if key else 'none',
                'model_locked': bool(os.getenv('FANGLI_GEO_ARK_MODEL'))}

    def configure(self, body):
        if set(body) - {'key', 'model'}:
            raise Problem('连接设置只接受 API Key 和检测模型')
        new_key = text(body.get('key', ''), 300, 'API Key')
        if any(ch.isspace() for ch in new_key):
            raise Problem('API Key 中不能包含空白字符')
        with self.guard:
            saved = self.saved()
            env_key = self.environment_key()
            env_model = os.getenv('FANGLI_GEO_ARK_MODEL')
            current_model = self.effective_model(env_model or saved.get('model'))
            selected = text(body.get('model', ''), 120, '检测模型')
            model = self.effective_model(selected) if selected else current_model
            if model not in MODELS and model != current_model:
                raise Problem('请从列表中选择检测模型')
            if env_model and model != current_model:
                raise Conflict('检测模型由启动环境指定，请在启动环境中修改')
            if env_key and new_key:
                raise Conflict('API Key 由启动环境提供，请在启动环境中更换')
            if not (new_key or saved.get('key') or env_key):
                raise Problem('首次连接请填写火山方舟 API Key')
            if new_key:
                saved['key'] = new_key
            if not env_model:
                saved['model'] = model
            pending = self.path.with_name(f'.geo-ark-{uid()}.tmp')
            try:
                with os.fdopen(os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8') as f:
                    f.write(dumps(saved))
                pending.replace(self.path)
            finally:
                pending.unlink(missing_ok=True)
            return self.info()

    def fetch(self, query, model, key):
        request = Request('https://ark.cn-beijing.volces.com/api/v3/responses',
                          data=dumps({'model': model, 'store': False,
                                      'input': [{'role': 'system', 'content': SEARCH_INSTRUCTIONS},
                                                {'role': 'user', 'content': query}],
                                      'tools': [{'type': 'web_search', 'sources': SEARCH_SOURCES, 'max_keyword': 1}],
                                      'max_tool_calls': 1, 'max_output_tokens': MAX_OUTPUT}).encode('utf-8'),
                          headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
        with build_opener(NoRedirect()).open(request, timeout=60) as response:
            payload = response.read(2_000_001)
        if len(payload) > 2_000_000:
            raise ValueError('response too large')
        return json.loads(payload)


def ark_rejection(error):
    try:
        payload = json.loads(error.read(32_768))
    except (OSError, ValueError, AttributeError):
        payload = {}
    detail = payload.get('error') if isinstance(payload, dict) else None
    detail = detail if isinstance(detail, dict) else {}
    code = detail.get('code', '')
    code = code if isinstance(code, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,99}', code) else ''
    message = detail.get('message')
    message = message.casefold() if isinstance(message, str) else ''
    search_denied = code == 'AccessDenied' and any(term in message for term in ('web search', 'web_search', '联网', 'search tool'))
    if code == 'ToolNotOpen' or search_denied:
        reason = '方舟拒绝了联网搜索。请到「应用组件库 → 应用组件」开通联网内容插件，并确认当前 Key 有权限。'
    elif code in ('ModelNotOpen', 'OperationDenied.ServiceNotOpen'):
        reason = '所选模型服务不可用，请到方舟「开通管理」检查该模型。'
    elif code in ('AccountOverdueError', 'OperationDenied.ServiceOverdue'):
        reason = '火山引擎账号欠费，请到费用中心查看。'
    elif error.code == 401:
        reason = '方舟未通过 API Key 验证，请在「连接设置」中核对或更换 Key。'
    elif error.code == 403:
        reason = '方舟拒绝访问。请检查所选模型、联网内容插件的开通状态，以及当前 Key 的权限。'
    elif error.code == 404:
        reason = '方舟找不到所选模型，或当前 Key 无权调用。请在「连接设置」重新选择模型，并核对方舟的开通状态。'
    elif error.code == 429:
        reason = '方舟限制了本次调用。请检查控制台的用量上限、免费额度或请求频率。'
    else:
        reason = f'方舟拒绝请求（HTTP {error.code}）。'
    return {'state': 'failed', 'reason': reason, 'http_status': error.code, 'provider_code': code}


def normalize_ark(raw, spec):
    """Use structured answer annotations; preserve missing search/citation evidence."""
    if not isinstance(raw, dict) or not isinstance(raw.get('output'), list):
        return {'state': 'incomplete', 'reason': '接口没有返回可识别的完整回答'}
    answer, citations, channels = [], [], []
    search, search_issue, complete = None, False, raw.get('status') == 'completed'
    for item in raw['output']:
        if not isinstance(item, dict):
            complete = False
        elif item.get('type') == 'web_search_call':
            if item.get('status') == 'completed':
                search = True
            else:
                search_issue = True
        elif item.get('type') == 'message' and item.get('role', 'assistant') == 'assistant':
            if item.get('status') not in (None, 'completed') or not isinstance(item.get('content'), list):
                complete = False
                continue
            for block in item['content']:
                if not isinstance(block, dict) or block.get('type') != 'output_text' or not isinstance(block.get('text'), str):
                    complete = False
                    continue
                answer.append(block['text'])
                annotations = block.get('annotations')
                valid = isinstance(annotations, list)
                for entry in annotations if valid else []:
                    url = entry.get('url') if isinstance(entry, dict) and entry.get('type') == 'url_citation' else None
                    if not isinstance(url, str) or not canonicalize_url(url):
                        valid = False
                        continue
                    title = entry.get('title')
                    citations.append({'url': url, 'title': title if isinstance(title, str) else ''})
                channels.append(valid)
        elif item.get('type') not in ('reasoning', 'compaction'):
            complete = False
    reply = '\n'.join(answer)
    complete = complete and bool(reply.strip()) and not search_issue
    observable = bool(channels) and all(channels)
    targets = {canonicalize_url(url) for url in spec['urls']}
    hit = any(canonicalize_url(c['url']) in targets for c in citations)
    matched = (hit if complete and search is True and targets and (observable or hit) else None)
    return {'state': 'complete' if complete else 'incomplete', 'answer': reply, 'citations': citations,
            'search': search, 'citations_observable': observable, 'resolved_model': raw.get('model') if isinstance(raw.get('model'), str) else '',
            'mentioned': contains_brand_alias(reply, spec['aliases']) if complete else None, 'article_hit': matched,
            'reason': '' if complete else '回答或搜索过程未完整结束'}


def summaries(items):
    result = {}
    for kind in ('discovery', 'branded'):
        group = [item for item in items if item['kind'] == kind]
        part = {'planned': len(group), 'answered': sum(item['state'] == 'complete' for item in group)}
        for metric in ('mentioned', 'article_hit'):
            values = [item.get(metric) for item in group]
            part[metric] = {'hits': sum(v is True for v in values), 'eligible': sum(isinstance(v, bool) for v in values)}
        result[kind] = part
    return result


class GeoChecks:
    def __init__(self, service):
        self.s, self.store, self.ws = service, service.store, service.ws
        self.provider = ArkGeo(Path(self.store.db_path).parent)
        self.guard = threading.Lock()
        self.worker = None
        self.closed = False
        with self.store.conn() as db:
            db.execute("UPDATE wb_geo_items SET state='unknown', result=? WHERE state='running'",
                       (dumps({'reason': '工作台上次退出时，请求结果未确认'}),))
            db.execute("UPDATE wb_geo_items SET state='skipped' WHERE state='queued'")
            db.execute("UPDATE wb_geo_runs SET state='interrupted', finished_at=? WHERE state IN ('running','stopping')", (now(),))

    def default_plan(self, customer):
        profile = customer['profile']
        plan = self.s.customers.plan(customer['id'])['plan']['options']
        brand = (profile.get('brand') or customer['name']).strip()
        names = [brand]
        for group in plan.get('aliases', []):
            if brand in group:
                names.extend(name for name in group if isinstance(name, str) and name.strip())
        aliases = list(dict.fromkeys(name.strip() for name in names))
        choices = [*plan.get('keywords', []), profile.get('products', ''), profile.get('industry', '')]
        topics = [p.strip() for v in choices if isinstance(v, str) for p in re.split(r'[、，,；;\r\n]', v)]
        topic = next((v for v in topics if v and len(v) <= 60 and not contains_brand_alias(v, aliases)), '')
        return {'aliases': aliases, 'topic': topic, 'questions': self.questions(brand, topic), 'repeat': 2,
                'urls': [], 'article_id': None, 'version_id': None}

    @staticmethod
    def questions(brand, topic):
        discovery = [f'{topic}{tail}' for tail in ('有哪些值得了解的品牌或商家？', '怎么选？', '有哪些常见选择，各自适合什么情况？',
                                                   '有哪些评价较好的选择？', '预算有限时有哪些选择？', '第一次了解时应该考虑哪些选择？')] if topic else []
        return [{'kind': kind, 'text': value} for kind, values in
                [('discovery', discovery), ('branded', [f'{brand}主要提供什么产品或服务？', f'在哪里能查到{brand}的官方资料？'])]
                for value in values]

    def home(self, cid):
        customer = self.ws.client(cid)
        with self.store.conn() as db:
            current = db.execute('''SELECT p.spec,p.revision FROM wb_geo_current_plans a
                                    JOIN wb_geo_plans p ON p.id=a.plan_id WHERE a.client_id=?''', (cid,)).fetchone()
            rows = db.execute('''SELECT r.id,r.state,r.created_at,p.revision,p.spec
                                 FROM wb_geo_runs r JOIN wb_geo_plans p ON p.id=r.plan_id
                                 WHERE r.client_id=? ORDER BY r.rowid DESC LIMIT 30''', (cid,)).fetchall()
        latest = loads(current['spec']) if current else self.default_plan(customer)
        return {'plan': latest, 'revision': current['revision'] if current else None, 'provider': self.provider.info(),
                'runs': [{'id': r['id'], 'state': r['state'], 'created_at': r['created_at'], 'revision': r['revision'],
                          'model': loads(r['spec'])['model']} for r in rows]}

    def articles(self, cid):
        self.ws.client(cid)
        result = []
        for conversation in self.ws.conversations(cid):
            if not conversation['plan_id']:
                continue
            for article in self.ws.visible_articles(conversation['plan_id']):
                aid = article['id']
                current = self.ws.current(aid)
                vid = current.get('current_version')
                if vid and self.ws.was_adopted(aid, vid):
                    result.append({'article_id': aid, 'version_id': vid, 'title': current.get('title') or '未命名稿件'})
        return {'articles': result}

    def validate_plan(self, cid, raw):
        if not isinstance(raw, dict):
            raise Problem('请先确认检测题目')
        aliases = raw.get('aliases')
        if not isinstance(aliases, list) or not 1 <= len(aliases) <= 12:
            raise Problem('请填写品牌名称，可补充别名')
        aliases = list(dict.fromkeys(text(value, 100, '品牌名称') for value in aliases))
        if not all(aliases):
            raise Problem('品牌名称不能为空')
        questions = raw.get('questions')
        repeat = raw.get('repeat')
        if type(repeat) is not int or repeat not in (1, 2) or not isinstance(questions, list) or not 1 <= len(questions) * repeat <= MAX_CALLS:
            raise Problem(f'请选择题目，每轮最多检测 {MAX_CALLS} 次')
        clean = []
        for q in questions:
            if not isinstance(q, dict) or q.get('kind') not in ('discovery', 'branded'):
                raise Problem('题目类型不正确')
            value = text(q.get('text'), 240, '问题')
            if not value or any(item['text'] == value for item in clean):
                raise Problem('请删除空题或重复题目')
            if q['kind'] == 'discovery' and contains_brand_alias(value, aliases):
                raise Problem('非品牌题不能含品牌名或别名，请移到品牌核验题')
            clean.append({'kind': q['kind'], 'text': value})
        if not any(q['kind'] == 'discovery' for q in clean):
            raise Problem('至少保留一道非品牌题')
        urls = raw.get('urls', [])
        if not isinstance(urls, list) or len(urls) > 10:
            raise Problem('最多登记 10 个公开链接')
        urls = list(dict.fromkeys(text(url, 2000, '公开链接') for url in urls))
        if any(not canonicalize_url(url) for url in urls):
            raise Problem('公开链接需为有效的 HTTP 或 HTTPS 文章地址')
        aid, vid = raw.get('article_id'), raw.get('version_id')
        if aid is not None or vid is not None or urls:
            if not urls or any(type(value) is not int or value < 1 for value in (aid, vid)):
                raise Problem('追踪稿件需要同时选择已采用的版本并填写公开链接')
            article = self.store.get_article(aid)
            if not article or not any(c['plan_id'] == article['plan_id'] for c in self.ws.conversations(cid, include_deleted=True)):
                raise Missing('稿件不属于所选客户')
            if not self.ws.was_adopted(aid, vid):
                raise Conflict('请选择明确采用过的稿件版本')
        return {'aliases': aliases, 'topic': text(raw.get('topic', ''), 60, '业务关键词'),
                'questions': clean, 'repeat': repeat, 'urls': urls, 'article_id': aid, 'version_id': vid}

    @staticmethod
    def store_plan(db, cid, spec, *, select):
        plan_hash = signature(spec)
        row = db.execute('SELECT id,revision FROM wb_geo_plans WHERE client_id=? AND spec_hash=?', (cid, plan_hash)).fetchone()
        if row:
            plan_id, revision = row['id'], row['revision']
        else:
            plan_id = uid()
            revision = db.execute('SELECT COALESCE(MAX(revision),0)+1 FROM wb_geo_plans WHERE client_id=?', (cid,)).fetchone()[0]
            db.execute('INSERT INTO wb_geo_plans VALUES(?,?,?,?,?,?)', (plan_id, cid, revision, plan_hash, dumps(spec), now()))
        if select:
            db.execute('''INSERT INTO wb_geo_current_plans VALUES(?,?)
                          ON CONFLICT(client_id) DO UPDATE SET plan_id=excluded.plan_id''', (cid, plan_id))
        return plan_id, revision

    def save_plan(self, cid, body):
        with self.guard, self.store.conn() as db:
            db.execute('BEGIN IMMEDIATE')
            self.ws.active_client(cid)
            _, model = self.provider.settings()
            spec = self.validate_plan(cid, body)
            spec.update({'model': model, 'entry': ENTRY, 'config': PROTOCOL})
            _, revision = self.store_plan(db, cid, spec, select=True)
        return {'plan': spec, 'revision': revision}

    def start(self, cid, body):
        if set(body) not in ({'request_key', 'plan'}, {'request_key', 'repeat_run_id'}):
            raise Problem('请选择检测题目或一轮历史检测')
        request_key = body.get('request_key')
        validate_creation_id(request_key)
        digest = signature(body)
        with self.guard:
            if self.closed:
                raise Conflict('工作台正在关闭')
            with self.store.conn() as db:
                db.execute('BEGIN IMMEDIATE')
                existing = db.execute('SELECT id,request_hash FROM wb_geo_runs WHERE client_id=? AND request_key=?', (cid, request_key)).fetchone()
                if existing:
                    if existing['request_hash'] != digest:
                        raise Conflict('同一提交编号已用于不同的检测')
                    return {'run_id': existing['id']}
                if self.worker is not None and self.worker.is_alive():
                    raise Conflict('已有检测正在运行，请等这轮完成后再开始')
                self.ws.active_client(cid)
                key, model = self.provider.settings()
                if not key:
                    raise Conflict('请先连接豆包')
                if 'repeat_run_id' in body:
                    validate_creation_id(body['repeat_run_id'])
                    old = db.execute('''SELECT p.spec FROM wb_geo_runs r JOIN wb_geo_plans p ON p.id=r.plan_id
                                        WHERE r.client_id=? AND r.id=?''', (cid, body['repeat_run_id'])).fetchone()
                    if not old:
                        raise Missing('检测记录不存在')
                    previous = loads(old['spec'])
                    if previous['model'] != model or previous['config'] != PROTOCOL:
                        raise Conflict('检测配置已变更，请用当前配置开始新检测')
                    spec = self.validate_plan(cid, previous)
                else:
                    spec = self.validate_plan(cid, body.get('plan'))
                spec.update({'model': model, 'entry': ENTRY, 'config': PROTOCOL})
                plan_id, _ = self.store_plan(db, cid, spec, select='plan' in body)
                run_id = uid()
                db.execute('INSERT INTO wb_geo_runs VALUES(?,?,?,?,?,?,?,?)',
                           (run_id, cid, plan_id, request_key, digest, 'running', now(), None))
                db.executemany('INSERT INTO wb_geo_items(run_id,ordinal,kind,question,sample,state) VALUES(?,?,?,?,?,?)',
                               ((run_id, i * spec['repeat'] + sample, q['kind'], q['text'], sample, 'queued')
                                for i, q in enumerate(spec['questions']) for sample in range(1, spec['repeat'] + 1)))
            self.worker = threading.Thread(target=self.execute, args=(run_id, spec, key), name='geo-observation', daemon=True)
            try:
                self.worker.start()
            except RuntimeError:
                with self.store.conn() as db:
                    db.execute("UPDATE wb_geo_items SET state='skipped' WHERE run_id=?", (run_id,))
                    db.execute("UPDATE wb_geo_runs SET state='interrupted',finished_at=? WHERE id=?", (now(), run_id))
        return {'run_id': run_id}

    def execute(self, run_id, spec, key):
        run_state = 'done'
        try:
            with self.store.conn() as db:
                rows = db.execute('SELECT ordinal,question FROM wb_geo_items WHERE run_id=? ORDER BY ordinal', (run_id,)).fetchall()
            for row in rows:
                with self.guard, self.store.conn() as db:
                    pending = db.execute("SELECT 1 FROM wb_geo_items WHERE run_id=? AND ordinal=? AND state='queued'",
                                         (run_id, row['ordinal'])).fetchone()
                    if self.closed or not pending:
                        run_state = 'stopped'
                        break
                    db.execute("UPDATE wb_geo_items SET state='running' WHERE run_id=? AND ordinal=?", (run_id, row['ordinal']))
                raw = None
                try:
                    raw = self.provider.fetch(row['question'], spec['model'], key)
                    result = normalize_ark(raw, spec)
                except HTTPError as error:
                    result = ark_rejection(error)
                    run_state = 'interrupted'
                except (URLError, TimeoutError, OSError, ValueError):
                    result = {'state': 'unknown', 'reason': '请求未确认，请核对服务商调用记录'}
                    run_state = 'interrupted'
                with self.store.conn() as db:
                    db.execute('UPDATE wb_geo_items SET state=?,result=?,raw=? WHERE run_id=? AND ordinal=?',
                               (result['state'], dumps(result), dumps(raw) if raw is not None else None, run_id, row['ordinal']))
                if run_state == 'interrupted':
                    break
        finally:
            with self.store.conn() as db:
                active = db.execute("UPDATE wb_geo_items SET state='unknown',result=? WHERE run_id=? AND state='running'",
                                    (dumps({'reason': '执行中断，请核对服务商调用记录'}), run_id)).rowcount
                skipped = db.execute("UPDATE wb_geo_items SET state='skipped' WHERE run_id=? AND state='queued'", (run_id,)).rowcount
                if active or (skipped and run_state == 'done'):
                    run_state = 'interrupted'
                db.execute('UPDATE wb_geo_runs SET state=?,finished_at=? WHERE id=?', (run_state, now(), run_id))

    def stop(self, cid, run_id):
        with self.guard, self.store.conn() as db:
            row = db.execute('SELECT state FROM wb_geo_runs WHERE id=? AND client_id=?', (run_id, cid)).fetchone()
            if not row:
                raise Missing('检测记录不存在')
            if row['state'] == 'running':
                changed = db.execute("UPDATE wb_geo_items SET state='skipped' WHERE run_id=? AND state='queued'", (run_id,)).rowcount
                if changed:
                    db.execute("UPDATE wb_geo_runs SET state='stopping' WHERE id=?", (run_id,))
        return self.report(cid, run_id)

    def report(self, cid, run_id):
        self.ws.client(cid)
        with self.store.conn() as db:
            run = db.execute('''SELECT r.rowid AS sequence,r.id,r.state,r.created_at,r.finished_at,p.revision,p.spec
                                FROM wb_geo_runs r JOIN wb_geo_plans p ON p.id=r.plan_id WHERE r.client_id=? AND r.id=?''',
                             (cid, run_id)).fetchone()
            if not run:
                raise Missing('检测记录不存在')
            rows = db.execute('SELECT ordinal,kind,question,sample,state,result FROM wb_geo_items WHERE run_id=? ORDER BY ordinal',
                              (run_id,)).fetchall()
            matching = db.execute('''SELECT r.id,r.created_at,r.plan_id FROM wb_geo_runs r
                                     JOIN wb_geo_runs current ON r.plan_id=current.plan_id
                                     WHERE current.id=? AND r.rowid<? AND r.state='done' ORDER BY r.rowid DESC LIMIT 10''',
                                  (run_id, run['sequence'])).fetchall()
            history = []
            for old in matching:
                result = [dict(item) | loads(item['result'], {}) for item in db.execute(
                    'SELECT kind,state,result FROM wb_geo_items WHERE run_id=?', (old['id'],))]
                history.append({'id': old['id'], 'date': old['created_at'], 'summary': summaries(result),
                                'models': self.resolved_models(result)})
        items = [dict(row) | loads(row['result'], {}) for row in rows]
        for item in items:
            item.pop('result', None)
        models = self.resolved_models(items)
        comparable = [old for old in history if run['state'] == 'done' and len(models) == 1 and old['models'] == models]
        public = {key: run[key] for key in run.keys() if key != 'sequence'}
        return {'run': public | {'spec': loads(run['spec']), 'items': items, 'summary': summaries(items),
                                    'resolved_models': models, 'comparable': comparable}}

    @staticmethod
    def resolved_models(items):
        models = {item.get('resolved_model', '') for item in items if item['state'] == 'complete'}
        return sorted(models) if '' not in models else []

    def close(self):
        with self.guard:
            self.closed = True
            worker = self.worker
        if worker:
            worker.join(timeout=1)
        return not worker or not worker.is_alive()
