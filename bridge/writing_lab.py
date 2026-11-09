"""Isolated, reproducible prompt comparisons using the production first-draft path."""
import copy
import hashlib
import html
import random
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

from app import generator, llm, prompts, render
from app.store import now
from . import provider
from .creation_context import build
from .errors import Conflict, Missing, Problem
from .storage import PROFILE_FIELDS, dumps, loads, text_value, uid


VARIANTS = {
    'baseline': ('方立基准', ''),
    'marketing': ('减少营销感', '本篇先把读者的问题答完整。只有当某个品牌、产品或服务能补充资料支持的具体选择理由、服务条件或差异时才写它。个人号以读者判断为主，官方号可以说明自己的业务及适用范围。避免无关卖点、隐形推广、虚构体验和导流。'),
    'quality': ('减少模板感', '首段给读者一个能用的判断。逐节补充不同的判断依据、适用条件或实际动作。检查正文、清单和问答，同一个判断只讲一次；删掉换个说法重述前文的段落。关键细节只能来自本次资料或清楚标为一般建议。'),
    'geo': ('便于准确引用', '围绕本篇主题对应的搜索问题写。把可核对的结论和适用条件写在同一段，指代明确。若资料支持品牌、型号、地点或服务边界，用明确名称说明它具体解决什么；引用可公开核验的依据时标清来源。不要为了结构补造事实、链接或数据。'),
}
QUESTIONS = {
    'marketing': '哪版更像在帮读者判断，品牌出现得更自然？',
    'quality': '哪版提供的判断更具体，读起来更自然？',
    'geo': '哪版可以被准确引用，且保留了对象和适用条件？',
    'proposal': '哪版更好地回答了读者的问题，且保留了具体条件？',
}
FULL_QUESTION = '哪篇更值得发布？一起看信息量、营销感、事实与可引用性。'
CHOICES = ('left', 'right', 'tie', 'neither', 'feedback', 'skip')
MAX_TOPICS = 40
WORKERS = 4


class PromptInputs:
    def __init__(self, source, context):
        self.source, self.creation_context = source, context

    def list_risks(self): return self.source['risks']
    def list_models(self): return self.source['models']
    def get_prefs(self): return self.source['prefs']


def excerpt(article, dimension, brand, keyword):
    body = re.split(r'(?m)^声明[:：]', article['body_md'], maxsplit=1)[0]
    blocks = [block.strip() for block in re.split(r'\n\s*\n', body) if block.strip()]
    prose = [block for block in blocks if not block.startswith('#')]
    if dimension == 'marketing':
        found = next((i for i, part in enumerate(prose) if brand and brand in part), None)
        return '\n\n'.join(prose[max(0, found - 1):found + 2] if found is not None else prose[-2:])
    if dimension in ('geo', 'proposal'):
        sections = re.split(r'(?m)(?=^##\s)', body)
        return next((section.strip() for section in sections[1:] if keyword in section),
                    sections[1].strip() if len(sections) > 1 else '\n\n'.join(prose[:2]))
    return '\n\n'.join(blocks[1:4])


def comparable_text(value):
    value = re.sub(r'!?\[([^\]]+)\]\([^\n]+?\)', r'\1', html.unescape(value))
    return re.sub(r'[\s#*_`~\\>|-]+', '', value)


def detailed_feedback(value, row):
    if not isinstance(value, dict) or set(value) - {'note', 'rewrite', 'marks', 'publish'}:
        raise Problem('细评格式不正确')
    result = {}
    for key, label, limit in [('note', '自由评语', 1000), ('rewrite', '你的写法', 1800)]:
        if key in value and (text := text_value(value[key], label, limit).strip()):
            result[key] = text
    publish = value.get('publish', {})
    if (not isinstance(publish, dict) or set(publish) - {'left', 'right'} or
            any(rating not in ('ready', 'revise', 'rewrite') for rating in publish.values())):
        raise Problem('请选择有效的交付判断')
    if publish:
        if row['kind'] != 'full': raise Problem('请在全文盲选判断稿件是否可交付')
        result['publish'] = publish
    marks = value.get('marks', [])
    if not isinstance(marks, list) or len(marks) > 8: raise Problem('每题最多保存 8 处选段')
    sources = {}
    for mark in marks:
        if (not isinstance(mark, dict) or set(mark) != {'side', 'kind', 'text'} or
                mark['side'] not in ('left', 'right') or mark['kind'] not in ('like', 'issue')):
            raise Problem('选段格式不正确')
        text = text_value(mark['text'], '原文选段', 500, empty=False).strip()
        side = mark['side']
        if side not in sources:
            sources[side] = comparable_text(loads(row[side + '_article'])['body_md'])
        if not comparable_text(text) or comparable_text(text) not in sources[side]:
            raise Problem('选段需来自所标记的稿件，可直接选中该稿的正文')
        result.setdefault('marks', []).append({**mark, 'text': text})
    return result


class WritingLab:
    def __init__(self, service):
        self.service = service
        self.path = Path(service.store.db_path).with_name('writing-lab.sqlite3')
        self.changed = threading.Condition()
        self.revision = 0
        self.stop = threading.Event()
        self.worker = None
        with self.connection() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS lab_batches (
                    id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
                    name TEXT NOT NULL, settings TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL,
                    error TEXT NOT NULL DEFAULT '');
                CREATE TABLE IF NOT EXISTS lab_cases (
                    batch TEXT NOT NULL REFERENCES lab_batches(id), position INTEGER NOT NULL, spec TEXT NOT NULL,
                    PRIMARY KEY(batch, position));
                CREATE TABLE IF NOT EXISTS lab_drafts (
                    batch TEXT NOT NULL, position INTEGER NOT NULL, variant TEXT NOT NULL, status TEXT NOT NULL,
                    raw TEXT NOT NULL DEFAULT '', article TEXT, usage TEXT, error TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY(batch, position, variant),
                    FOREIGN KEY(batch, position) REFERENCES lab_cases(batch, position));
                CREATE TABLE IF NOT EXISTS lab_pairs (
                    id TEXT PRIMARY KEY, batch TEXT NOT NULL, position INTEGER NOT NULL,
                    kind TEXT NOT NULL, dimension TEXT NOT NULL, left_variant TEXT NOT NULL, right_variant TEXT NOT NULL,
                    sequence INTEGER NOT NULL, vote TEXT, reason TEXT NOT NULL DEFAULT '', voted_at INTEGER,
                    feedback TEXT NOT NULL DEFAULT '{}',
                    FOREIGN KEY(batch, position) REFERENCES lab_cases(batch, position));
                CREATE INDEX IF NOT EXISTS lab_pair_queue ON lab_pairs(batch, kind, sequence);
                UPDATE lab_drafts SET status='error',error='服务中断，调用结果待确认' WHERE status='running';
                UPDATE lab_batches SET status='paused',error='上次运行中断，可继续尚未调用的任务' WHERE status='running';
            ''')
            if 'feedback' not in {row['name'] for row in db.execute('PRAGMA table_info(lab_pairs)')}:
                db.execute("ALTER TABLE lab_pairs ADD COLUMN feedback TEXT NOT NULL DEFAULT '{}'")
        from .writing_lab_analysis import RoundAnalysis
        self.analysis = RoundAnalysis(self)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            with db:
                yield db
        finally:
            db.close()

    def _prepare(self, groups, variants):
        if not isinstance(groups, list) or not 1 <= len(groups) <= MAX_TOPICS:
            raise Problem('请填写至少一组客户与选题')
        service = self.service
        source = {'models': service.store.list_models(), 'prefs': service.store.get_prefs(),
                  'risks': service.store.list_risks()}
        platforms = {p['id']: p for p in service.store.list_platforms() if p['enabled'] and '图文' in p['formats']}
        enabled = [m['name'] for m in source['models'] if m['enabled']]
        cases, seen = [], set()
        for group in groups:
            if not isinstance(group, dict) or set(group) - {'client_id', 'source', 'platform_id', 'account_type', 'topics'}:
                raise Problem('客户与选题组格式不正确')
            cid, inline = group.get('client_id'), group.get('source')
            platform_id, account = group.get('platform_id'), group.get('account_type')
            if type(platform_id) is not int or platform_id not in platforms or account not in generator.ACCOUNT_TYPES:
                raise Problem('请选择启用的图文平台及账号身份')
            topics = group.get('topics')
            if not isinstance(topics, list) or not topics or len(cases) + len(topics) > MAX_TOPICS:
                raise Problem(f'每批支持 1–{MAX_TOPICS} 道选题')
            platform = platforms[platform_id]
            options = {'selections': [{'platform_id': platform_id, 'account_type': account, 'count': 1}],
                       'format_overrides': {str(platform_id): ['图文']}}
            if cid and not inline:
                service.ws.active_client(cid)
                template, documents, _ = service.customers.effective(cid, {**options, 'keywords': ['训练选题']})
                history = [a for a in service.customers.reference_articles(cid) if a['platform_id'] == platform_id]
                context = service.freeze_creation_context(cid, {**source, 'brief': template, 'documents': documents,
                                                                 'platforms': [platform], 'format_overrides': options['format_overrides']})
                label = template['client']
            elif inline and not cid and isinstance(inline, dict) and set(inline) == {'name', 'text'}:
                label = text_value(inline['name'], '样本主体', 100, empty=False).strip()
                material = text_value(inline['text'], '样本资料', 40000, empty=False).strip()
                digest = hashlib.sha256(material.encode('utf-8')).hexdigest()
                documents = [{'id': digest, 'digest': digest, 'revision': 1, 'filename': label + '资料.md',
                              'kind': '文本', 'text': material}]
                profile = {field: '' for field in PROFILE_FIELDS}
                profile['brand'] = label
                template = {**profile, **options, 'client': label, 'platforms': [platform['name']], 'models': enabled}
                context = build({'id': 'lab-' + digest, 'name': label, 'profile': profile}, documents, template, [platform],
                                models=source['models'], prefs=source['prefs'])
                history = []
            else:
                raise Problem('每组需选择方立客户或提供一份独立资料')
            if not documents:
                raise Problem(f'{label}需要可用的写作资料')
            view = PromptInputs(source, context)
            level = generator.pref_level(view, platform_id, template.get('models', []))
            avoid_titles = [row['title'] for row in history if row.get('title')][-8:]
            avoid_faqs = [question for row in history for question in re.findall(r'(?m)^###\s+(.+)$', row.get('body_md') or '')][-20:]
            for item in topics:
                if not isinstance(item, dict) or set(item) != {'topic', 'keyword'}:
                    raise Problem('每道选题需要标题和搜索词')
                topic = text_value(item['topic'], '题目', 240, empty=False).strip()
                keyword = text_value(item['keyword'], '搜索词', 160, empty=False).strip()
                identity = (label, platform_id, account, topic)
                if identity in seen: raise Problem(f'选题重复：{topic}')
                seen.add(identity)
                brief = {**template, 'topic': topic, 'keyword': keyword, 'keywords': [keyword]}
                i = len(cases)
                angle, sub = prompts.ANGLES[i % len(prompts.ANGLES)], prompts.SUB_ANGLES[(i * 5) % len(prompts.SUB_ANGLES)]
                materials = prompts.build_materials_text(documents, focus=[keyword], prefer_complete=True)
                messages = generator.build_messages(view, brief, platform, angle, sub, '图文', level, avoid_titles,
                                                    1, 1, keyword, materials, account_type=account, avoid_faqs=avoid_faqs)
                cases.append({'topic': topic, 'keyword': keyword, 'brand': brief.get('brand') or label, 'client': label,
                              'brief': brief, 'platform': platform, 'account': account, 'angle': angle, 'messages': messages,
                              'rules': {ident: rule for ident, (_, rule) in variants.items()},
                              'variant_names': {ident: label for ident, (label, _) in variants.items()},
                              'sources': [{k: d.get(k) for k in ('id', 'revision', 'digest', 'filename')} for d in documents]})
        return cases

    def _batch(self, db, batch):
        row = db.execute('SELECT * FROM lab_batches WHERE id=?', (batch,)).fetchone()
        if row is None: raise Missing('训练批次不存在')
        return row

    def start(self, body):
        required = {'name', 'request_key', 'groups'}
        if not required <= set(body) <= required | {'analysis_id'}:
            raise Problem('请填写批次名称、客户与选题')
        name = text_value(body['name'], '批次名称', 100, empty=False).strip()
        token = text_value(body['request_key'], '提交编号', 100, empty=False)
        digest = hashlib.sha256(dumps(body).encode('utf-8')).hexdigest()
        with self.changed:
            with self.connection() as db:
                previous = db.execute('SELECT id,digest FROM lab_batches WHERE request_key=?', (token,)).fetchone()
                if previous:
                    if previous['digest'] != digest: raise Conflict('提交内容已变化，请重新提交')
                    return {'id': previous['id']}
            if self.worker and self.worker.is_alive(): raise Conflict('已有训练批次正在出稿')
            variants = VARIANTS
            previous_topics = set()
            if 'analysis_id' in body:
                proposal, previous_topics = self.analysis.proposal(body['analysis_id'])
                variants = {'baseline': VARIANTS['baseline'], 'proposal': (proposal['title'], proposal['rule'])}
            cases = self._prepare(body['groups'], variants)
            if any(case['topic'] in previous_topics for case in cases):
                raise Problem('请用没参加过该轮训练的新题验证建议')
            settings = self.service.public_settings()
            self.service.ensure_model(settings)
            batch = uid()
            with self.connection() as db:
                db.execute('INSERT INTO lab_batches VALUES(?,?,?,?,?,?,?,?)',
                           (batch, token, digest, name, dumps(settings), 'running', now(), ''))
                for position, spec in enumerate(cases):
                    db.execute('INSERT INTO lab_cases VALUES(?,?,?)', (batch, position, dumps(spec)))
                    db.executemany('INSERT INTO lab_drafts(batch,position,variant,status) VALUES(?,?,?,?)',
                                   [(batch, position, variant, 'queued') for variant in variants])
                self._pairs(db, batch, len(cases), list(variants)[1:])
            self._launch(batch)
            return {'id': batch}

    def _pairs(self, db, batch, count, dimensions):
        rng = random.Random(batch)
        pool = [(position, dimension) for position in range(count) for dimension in dimensions]
        full = rng.sample(pool, min(16, len(pool)))
        for kind, pairs in [('fragment', pool), ('full', full)]:
            rng.shuffle(pairs)
            for sequence, (position, dimension) in enumerate(pairs):
                sides = ['baseline', dimension]
                rng.shuffle(sides)
                db.execute('''INSERT INTO lab_pairs(id,batch,position,kind,dimension,left_variant,right_variant,sequence)
                              VALUES(?,?,?,?,?,?,?,?)''', (uid(), batch, position, kind, dimension, *sides, sequence))

    def _launch(self, batch):
        self.stop.clear()
        self.worker = threading.Thread(target=self._run, args=(batch,), daemon=True, name='writing-lab')
        self.worker.start()
        self._notify()

    def resume(self, batch):
        with self.changed, self.connection() as db:
            row = self._batch(db, batch)
            if self.worker and self.worker.is_alive(): raise Conflict('已有训练批次正在出稿')
            if row['status'] != 'paused' or not db.execute('SELECT 1 FROM lab_drafts WHERE batch=? AND status=?',
                                                           (batch, 'queued')).fetchone():
                raise Conflict('本批没有可以继续的出稿任务')
            self.service.ensure_model(loads(row['settings']))
            db.execute("UPDATE lab_batches SET status='running',error='' WHERE id=?", (batch,))
            db.commit()
            self._launch(batch)
        return {'id': batch}

    def pause(self, batch):
        with self.changed, self.connection() as db:
            if self._batch(db, batch)['status'] != 'running': raise Conflict('本批当前没有在出稿')
            self.stop.set()
        return {'id': batch}

    def close(self):
        self.stop.set()
        self._notify()
        if self.worker:
            self.worker.join(timeout=8)
        analysis_closed = self.analysis.close()
        return analysis_closed and (not self.worker or not self.worker.is_alive())

    def _notify(self):
        with self.changed:
            self.revision += 1
            self.changed.notify_all()

    def _run(self, batch):
        error = ''
        try:
            with self.connection() as db:
                settings = loads(self._batch(db, batch)['settings'])
                tasks = list(db.execute('''SELECT d.position,d.variant,c.spec FROM lab_drafts d JOIN lab_cases c
                    USING(batch,position) WHERE d.batch=? AND d.status='queued' ORDER BY d.position,d.rowid''', (batch,)))
            with ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix='lab-draft') as pool:
                for offset in range(0, len(tasks), WORKERS):
                    if self.stop.is_set(): break
                    for failure in pool.map(lambda task: self._write(batch, task, settings), tasks[offset:offset + WORKERS]):
                        if failure and not error: error = failure
                    if error: break
        except Exception as exc:
            error = provider.public_error(exc)
        with self.connection() as db:
            pending = db.execute("SELECT COUNT(*) FROM lab_drafts WHERE batch=? AND status='queued'", (batch,)).fetchone()[0]
            db.execute('UPDATE lab_batches SET status=?,error=? WHERE id=?', ('paused' if pending else 'done', error, batch))
        if not pending:
            self.analysis.maybe_final(batch)
        self._notify()

    def _write(self, batch, task, settings):
        position, variant = task['position'], task['variant']
        with self.connection() as db:
            db.execute("UPDATE lab_drafts SET status='running' WHERE batch=? AND position=? AND variant=?", (batch, position, variant))
        raw, article, error, pause, response = '', None, '', '', {}
        provider.local.failure, provider.local.usage = None, []
        def capture(kind, value):
            if kind == 'response': response.update(value)
        provider.local.trace = capture
        try:
            spec = loads(task['spec'])
            messages = copy.deepcopy(spec['messages'])
            if rule := spec['rules'][variant]:
                messages[0]['content'] += '\n\n【本次写法】\n' + rule
            raw = llm.chat_with_retry(messages, settings, force_json=True)
            try:
                data = llm.parse_json(raw)
                if not isinstance(data, dict) or not isinstance(data.get('title'), str) or not data['title'].strip() or not data.get('sections'):
                    raise ValueError('missing title or sections')
                article = generator._finalize(data, spec['brief'], spec['platform'], spec['angle'], '图文', settings,
                                              spec['keyword'], layout={'sp': False, 'facts': False, 'faq': False},
                                              account_type=spec['account'])
            except (llm.LLMError, ValueError, AttributeError, TypeError, KeyError):
                error = '模型返回无法渲染为完整文章'
        except llm.LLMError as exc:
            error = provider.public_error(exc)
            if exc.kind != 'truncated': pause = error
        except Exception as exc:
            pause = error = provider.public_error(exc)
        finally:
            with self.connection() as db:
                db.execute('''UPDATE lab_drafts SET status=?,raw=?,article=?,usage=?,error=?
                              WHERE batch=? AND position=? AND variant=?''',
                           ('ready' if article else 'error', raw or response.get('text', ''),
                            dumps(article) if article else None, dumps(provider.local.usage), error, batch, position, variant))
            self._notify()
        return pause

    _READY = '''FROM lab_pairs p JOIN lab_drafts l ON (p.batch,p.position,p.left_variant)=(l.batch,l.position,l.variant)
                 JOIN lab_drafts r ON (p.batch,p.position,p.right_variant)=(r.batch,r.position,r.variant)
                 WHERE p.batch=? AND l.status='ready' AND r.status='ready' '''

    def summary(self, batch):
        with self.connection() as db:
            row = self._batch(db, batch)
            drafts = dict(db.execute('SELECT status,COUNT(*) FROM lab_drafts WHERE batch=? GROUP BY status', (batch,)))
            pairs = {kind: {'ready': 0, 'voted': 0, 'total': total} for kind, total in db.execute(
                'SELECT kind,COUNT(*) FROM lab_pairs WHERE batch=? GROUP BY kind', (batch,))}
            for kind, ready, voted in db.execute('SELECT p.kind,COUNT(*),COUNT(p.vote) ' + self._READY + 'GROUP BY p.kind', (batch,)):
                pairs[kind].update(ready=ready, voted=voted)
            return {**{k: row[k] for k in ('id', 'name', 'status', 'created', 'error')},
                    'model': loads(row['settings'])['model'], 'drafts': drafts, 'pairs': pairs,
                    'analysis': self.analysis.status(db, batch)}

    def batches(self):
        with self.connection() as db:
            ids = [row[0] for row in db.execute('SELECT id FROM lab_batches ORDER BY rowid DESC')]
        return [self.summary(batch) for batch in ids]

    def next_pair(self, batch, kind, prefer=None):
        if kind not in ('fragment', 'full'): raise Problem('题目类型不正确')
        with self.connection() as db:
            self._batch(db, batch)
            pair = db.execute('SELECT p.*,l.article AS left_article,r.article AS right_article ' + self._READY +
                              'AND p.kind=? AND p.vote IS NULL ORDER BY (p.id=?) DESC,p.sequence LIMIT 1', (batch, kind, prefer)).fetchone()
            if pair is None: return None
            spec = loads(db.execute('SELECT spec FROM lab_cases WHERE batch=? AND position=?', (batch, pair['position'])).fetchone()[0])
        def copy_for(field):
            article = loads(pair[field])
            return {'title': render.strip_title_prefix(article['title']), 'body': article['body_md'],
                    'excerpt': excerpt(article, pair['dimension'], spec['brand'], spec['keyword']) if kind == 'fragment' else ''}
        return {'id': pair['id'], 'topic': spec['topic'], 'keyword': spec['keyword'], 'platform': spec['platform']['name'],
                'account': spec['account'], 'question': FULL_QUESTION if kind == 'full' else QUESTIONS[pair['dimension']],
                'left': copy_for('left_article'), 'right': copy_for('right_article'),
                'reason': pair['reason'], 'feedback': loads(pair['feedback'])}

    def vote(self, batch, pair, body):
        if set(body) - {'choice', 'reason', 'feedback'} or body.get('choice') not in CHOICES:
            raise Problem('请选择有效的盲选结果')
        reason = text_value(body.get('reason', ''), '理由', 280).strip()
        with self.connection() as db:
            row = db.execute('SELECT p.kind,p.vote,p.reason,p.feedback,l.article AS left_article,r.article AS right_article '
                             + self._READY + 'AND p.id=?', (batch, pair)).fetchone()
            if row is None: raise Missing('题目不存在或稿件未齐')
            choice = body['choice']
            feedback = detailed_feedback(body.get('feedback', {}), row)
            if choice == 'feedback' and not (feedback or reason): raise Problem('请先留一条具体反馈')
            if row['vote'] == choice and row['reason'] == reason and loads(row['feedback']) == feedback: return
            updated = db.execute('UPDATE lab_pairs SET vote=?,reason=?,feedback=?,voted_at=? WHERE batch=? AND id=? AND vote IS NULL',
                                 (choice, reason, dumps(feedback), time.time_ns(), batch, pair))
            if not updated.rowcount: raise Conflict('本题已有选择，请先撤回')
        self.analysis.maybe_final(batch)
        self._notify()

    def undo(self, batch, kind):
        if kind not in ('fragment', 'full'): raise Problem('题目类型不正确')
        with self.connection() as db:
            self._batch(db, batch)
            row = db.execute('''UPDATE lab_pairs SET vote=NULL,voted_at=NULL WHERE id=(
                SELECT id FROM lab_pairs WHERE batch=? AND kind=? AND vote IS NOT NULL ORDER BY voted_at DESC LIMIT 1)
                RETURNING id''', (batch, kind)).fetchone()
            if row is None: raise Conflict('没有可撤回的选择')
        self._notify()
        return row['id']

    def report(self, batch):
        result = {}
        with self.connection() as db:
            self._batch(db, batch)
            rows = db.execute('SELECT p.kind,p.dimension,p.left_variant,p.right_variant,p.vote,p.position ' + self._READY +
                              'AND p.vote IS NOT NULL', (batch,))
            cases = {row['position']: loads(row['spec']) for row in db.execute('SELECT position,spec FROM lab_cases WHERE batch=?', (batch,))}
            for kind, dimension, left, right, vote, position in rows:
                label = cases[position].get('variant_names', {}).get(dimension) or VARIANTS[dimension][0]
                bucket = result.setdefault((kind, label), dict(baseline=0, challenger=0, tie=0, neither=0, feedback=0, skip=0))
                outcome = ('baseline' if (left if vote == 'left' else right) == 'baseline' else 'challenger') if vote in ('left', 'right') else vote
                bucket[outcome] += 1
        return [{'kind': kind, 'variant': label, **values} for (kind, label), values in result.items()]
