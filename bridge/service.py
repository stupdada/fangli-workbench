"""Same ZIP writing engine, frozen runs, shared drafts and working versions."""
import copy
import inspect
import json
import re
import threading
import time
from pathlib import Path
from app import generator, llm, prompts
from . import local_api, provider
from .accepted_expressions import AcceptedExpressions
from .errors import Problem, Conflict, Missing
from .storage import Workspace, PROFILE_FIELDS, dumps, integer, text_value, uid

ROOT = Path(__file__).resolve().parent.parent
OPTION_FIELDS = set(PROFILE_FIELDS) | {'client', 'keywords', 'keyword_links', 'selections', 'models', 'rivals', 'aliases',
    'note', 'length_hint', 'format_overrides', 'platform_types', 'keyword_brands', 'topic', 'points', 'extra'}
SETTING_FIELDS = {'model', 'temperature', 'max_tokens', 'title_prefix', 'disable_thinking', 'brand'}


class FrozenStore:
    """A run owns all its input; native records alone feed subsequent titles/FAQ/angles."""
    def __init__(self, service, pid, brief, sid, snapshot=None):
        self.service, self.raw, self.pid, self.sid = service, service.store, pid, sid
        self.jid, self.active = None, None
        source = snapshot or {}
        self.creation_context = copy.deepcopy(source.get('creation_context', {}))
        self.settings = copy.deepcopy(source.get('settings', self.raw.get_settings()))
        self.platforms = copy.deepcopy(source.get('platforms', self.raw.list_platforms()))
        for platform in self.platforms:
            override = brief.get('format_overrides', {}).get(str(platform['id']))
            if override:
                platform['formats'] = copy.deepcopy(override)
        self.materials = copy.deepcopy(source.get('documents', self.raw.list_materials(pid)))
        self.models = copy.deepcopy(source.get('models', self.raw.list_models()))
        self.risks = copy.deepcopy(source.get('risks', self.raw.list_risks()))
        self.prefs = copy.deepcopy(source.get('prefs', self.raw.get_prefs()))
        self.reference_articles = copy.deepcopy(source.get('reference_articles', []))
        self.topic_offset = source.get('topic_offset', len(self.reference_articles))
        self.plan = copy.deepcopy(self.raw.get_plan(pid))
        self.plan['articles'] = service.ws.visible_articles(pid)
        self.articles = {a['id']: a for a in self.plan['articles']}
        self.arranged_articles = source.get('arranged_articles')
        self.arranged_positions = set()
        self.active_arrangement = None
        if self.arranged_articles is not None:
            with self.raw.conn() as conn:
                slots = conn.execute('''SELECT s.article_id,s.position FROM wb_batch_article_outputs s
                    JOIN articles a ON a.id=s.article_id WHERE a.plan_id=?''', (pid,))
                self.arranged_positions = {row['position'] for row in slots if row['article_id'] in self.articles}

    def get_settings(self): return copy.deepcopy(self.settings)
    def list_platforms(self): return copy.deepcopy(self.platforms)
    def list_models(self): return copy.deepcopy(self.models)
    def list_risks(self): return copy.deepcopy(self.risks)
    def get_prefs(self): return copy.deepcopy(self.prefs)
    def list_materials(self, pid): return copy.deepcopy(self.materials) if pid == self.pid else []
    def list_articles(self, pid): return copy.deepcopy(list(self.articles.values())) if pid == self.pid else []
    def get_article(self, aid): return copy.deepcopy(self.articles.get(aid))
    def get_plan(self, pid):
        if pid != self.pid: return None
        return {**copy.deepcopy(self.plan), 'articles': self.list_articles(pid), 'materials': self.list_materials(pid)}

    def update_plan(self, pid, **values):
        self.raw.update_plan(pid, **values)
        self.plan.update(copy.deepcopy(values))

    def add_article(self, pid, **values):
        # Serialize publication of the native row and lock with workspace views.
        with self.service.guard:
            if self.active_arrangement is not None:
                position = self.active_arrangement['position']
                aid = self.raw.add_arranged_article(pid, position, self.jid, self.sid, values)
                self.active = aid
                self.arranged_positions.add(position)
            else:
                aid = self.raw.add_article(pid, **values)
                self.active = aid
                self.service.ws.lock_article(aid, self.jid)
                self.service.ws.bind_source(aid, self.sid)
            self.articles[aid] = self.raw.get_article(aid)
            evidence = {'zip_data': copy.deepcopy(values['data'])} if isinstance(values.get('data'), dict) else {}
            exchange = getattr(provider.local, 'last_exchange', {})
            if exchange.get('response', {}).get('text'):
                evidence['raw_generation'] = exchange['response']['text']
            if evidence: self.service.ws.save_generation_evidence(aid, **evidence)
            self.service.ws.capture_zip(aid, 'ZIP 初稿', select=False)
        return aid

    def next_arranged_task(self, skipped):
        for index, row in enumerate(self.arranged_articles):
            if row['position'] in self.arranged_positions or row['id'] in skipped:
                continue
            self.active_arrangement = row
            platform = next(p for p in self.platforms if p['id'] == row['platform_id'])
            keywords = row['keywords']
            return {'key': row['id'], 'platform': platform, 'account_type': row['account_type'],
                    'fmt': row['format'], 'group': keywords, 'keyword': keywords[0], 'extras': keywords[1:],
                    'angle': row['angle'], 'sub': row['sub'], 'qi': index, 'index': index + 1,
                    'count': len(self.arranged_articles),
                    'avoid': [a['title'] for a in self.articles.values()
                              if a['platform_id'] == row['platform_id'] and a.get('title')]}
        return None

    def update_article(self, aid, **values):
        if 'geo' in values:
            from .checks import article_checks
            from .creation_context import key
            article = {**self.articles[aid], **values}
            variant = self.creation_context.get('style', {}).get('variants', {}).get(key(article['platform_id'], article['account_type'], article['fmt']))
            values['geo'] = article_checks(article, values['geo'], variant)
        self.raw.update_article(aid, **values)
        self.articles[aid] = self.raw.get_article(aid)

    def finish_article(self):
        if self.active:
            with self.service.guard:
                aid = self.active
                try:
                    exchange = getattr(provider.local, 'last_exchange', {})
                    messages = exchange.get('request', {}).get('messages') or []
                    if messages and messages[0].get('content') == prompts.AUDIT_RULES and exchange.get('response', {}).get('text'):
                        self.service.ws.save_generation_evidence(aid, raw_audit=exchange['response']['text'])
                    audit = (generator.get_job(self.jid) or {}).get('audit', {})
                    review = None
                    if not audit.get('ok') or audit.get('verdict') == 'unverified':
                        review = {'status': 'unverified', 'summary': audit.get('reason') or 'ZIP 原生核查未确认完成', 'native': audit}
                    self.service.ws.capture_zip(aid, review=review)
                finally:
                    self.service.ws.unlock_article(aid, self.jid)
                    self.active = None


def install_lifecycle():
    if getattr(generator._write_one_core, '_workbench_hook', False):
        return
    original = generator._write_one_core

    def with_lifecycle(store, *args, **kwargs):
        try:
            return original(store, *args, **kwargs)
        finally:
            if isinstance(store, FrozenStore):
                store.finish_article()
    with_lifecycle._workbench_hook = True
    with_lifecycle._zip_original = original
    generator._write_one_core = with_lifecycle


def install_context():
    """Keep ZIP source intact; enrich only workspace-owned facts and references."""
    if not getattr(generator.audit_article, '_workspace_context', False):
        audit = generator.audit_article
        def audit_with_profile(store, settings, article_id, brief=None):
            if isinstance(store, FrozenStore) or hasattr(store, 'source'):
                effective = copy.deepcopy(brief or store.get_plan(store.get_article(article_id)['plan_id'])['brief'])
                profile = {k: effective.get(k, '') for k in ('client', *PROFILE_FIELDS)}
                effective['note'] = (effective.get('note') or '') + '\n【本任务已确认的客户档案】\n' + dumps(profile)
                brief = effective
            return audit(store, settings, article_id, brief)
        audit_with_profile._workspace_context = True
        generator.audit_article = audit_with_profile
    if not getattr(generator.build_messages, '_workspace_context', False):
        build = generator.build_messages
        signature = inspect.signature(build)
        def messages_with_history(*args, **kwargs):
            values = signature.bind(*args, **kwargs)
            values.apply_defaults()
            store = values.arguments['store']
            arrangement = getattr(store, 'active_arrangement', None)
            if arrangement:
                values.arguments['brief'] = {**values.arguments['brief'], 'topic': arrangement['topic']}
            brief = values.arguments['brief']
            primary = values.arguments['keyword'] or brief.get('keyword', '')
            related = [target for source, target in brief.get('keyword_links', []) if source == primary]
            if related:
                values.arguments['extra_note'] += ('\n\n【本篇关联词】' + dumps(related) +
                    '。仅在所选资料支持主关键词与关联词的实际关系时自然提及，并说明关系和适用条件。')
            context = getattr(store, 'creation_context', None)
            if context:
                from .creation_context import for_article
                values.arguments['creation_context'] = for_article(context, values.arguments['platform'],
                    values.arguments['account_type'] or generator.account_type_of(values.arguments['platform'], values.arguments['brief']), values.arguments['fmt'])
            if isinstance(store, FrozenStore) and (store.reference_articles or store.topic_offset):
                platform = values.arguments['platform']['id']
                history = [a for a in store.reference_articles if a.get('platform_id') == platform]
                titles = [a['title'] for a in history if a.get('title')]
                values.arguments['avoid_titles'] = list(dict.fromkeys((values.arguments['avoid_titles'] or []) + titles[-8:]))
                faqs = [q.strip() for a in history for q in re.findall(r'(?m)^###\s*(.+)$', a.get('body_md') or '')]
                values.arguments['avoid_faqs'] = list(dict.fromkeys((values.arguments['avoid_faqs'] or []) + faqs[-20:]))
            return build(*values.args, **values.kwargs)
        messages_with_history._workspace_context = True
        generator.build_messages = messages_with_history
    if not getattr(generator.next_task, '_workspace_context', False):
        next_task = generator.next_task
        def task_with_history(store, plan_id, brief, skip_keys=None):
            if isinstance(store, FrozenStore) and store.arranged_articles is not None:
                return store.next_arranged_task(set(skip_keys or ()))
            task = next_task(store, plan_id, brief, skip_keys)
            if task and isinstance(store, FrozenStore) and store.topic_offset:
                index = store.topic_offset + len(store.articles)
                task['angle'] = prompts.ANGLES[index % len(prompts.ANGLES)]
                task['sub'] = prompts.SUB_ANGLES[(index * 5) % len(prompts.SUB_ANGLES)]
            return task
        task_with_history._workspace_context = True
        generator.next_task = task_with_history
    if not getattr(generator.pending_tasks, '_workspace_context', False):
        pending_tasks = generator.pending_tasks
        def pending_with_arrangement(store, *args, **kwargs):
            if isinstance(store, FrozenStore) and store.arranged_articles is not None:
                tasks = store.arranged_articles
                done = {i for i, row in enumerate(tasks) if row['position'] in store.arranged_positions}
                return tasks, done, [i for i in range(len(tasks)) if i not in done]
            return pending_tasks(store, *args, **kwargs)
        pending_with_arrangement._workspace_context = True
        generator.pending_tasks = pending_with_arrangement


class Service:
    def __init__(self, store, *, boot_batches=True):
        self.store, self.ws = store, Workspace(store)
        self.accepted_expressions = AcceptedExpressions(store)
        self.guard = threading.RLock()
        self.operation_changes = threading.Condition(self.guard)
        self.catalog, self.threads, self.cancellations = None, {}, {}
        self.closed = False
        self.ws.recover()
        if not store.get_meta('wb_initialized'):
            store.save_settings({'model': provider.DEFAULT_MODEL})
            store.set_meta('wb_initialized', '1')
        provider.install()
        install_lifecycle()
        install_context()
        from .customers import Customers
        from .batches import Batches
        from .client_intake import ClientIntake
        from .geo_checks import GeoChecks
        from .writing_lab import WritingLab
        self.customers = Customers(self)
        self.intake = ClientIntake(self)
        self.batches = Batches(self)
        self.geo = GeoChecks(self)
        self.writing_lab = WritingLab(self)
        if boot_batches:
            self.batches.boot()

    def public_settings(self):
        settings = self.store.get_settings()
        return {**{k: settings[k] for k in SETTING_FIELDS}, 'transport': settings.get('transport', provider.WORKBUDDY)}

    def save_settings(self, patch):
        if not isinstance(patch, dict) or set(patch) - (SETTING_FIELDS | {'transport'}):
            raise Problem('设置只接受模型来源、模型 ID、采样参数及原生写作选项')
        patch = dict(patch)
        if 'model' in patch:
            patch['model'] = text_value(patch['model'], '模型ID', 120, empty=False).strip()
        if 'temperature' in patch and (type(patch['temperature']) not in (float, int) or not 0 <= patch['temperature'] <= 1.5):
            raise Problem('temperature需在0至1.5之间')
        if 'max_tokens' in patch and (type(patch['max_tokens']) is not int or not 800 <= patch['max_tokens'] <= 8000):
            raise Problem('max_tokens需为800至8000之间的整数')
        for key in ('title_prefix', 'disable_thinking'):
            if key in patch and not isinstance(patch[key], bool): raise Problem(f'{key}需为布尔值')
        if 'brand' in patch: patch['brand'] = text_value(patch['brand'], '默认品牌', 4000).strip()
        with self.guard:
            settings = self.store.get_settings()
            current = settings.get('transport', provider.WORKBUDDY)
            if 'transport' in patch or 'model' in patch:
                transport = patch.get('transport', current)
                self.check_transport(transport)
                if transport != current and 'model' not in patch:
                    raise Problem('切换模型来源时请选择该来源的模型 ID')
            self.store.set_meta('settings', dumps({**settings, **patch}))
            return self.public_settings()

    @staticmethod
    def check_transport(transport):
        if transport == provider.WORKBUDDY:
            return
        if not isinstance(transport, str) or transport not in local_api.PROVIDERS:
            raise Problem('请选择有效的写作模型来源')
        if not local_api.connection(transport):
            raise Problem(f'{provider.name(transport)} 的本机配置缺失或无效，请检查环境变量')

    def ensure_model(self, settings=None):
        settings = settings if settings is not None else self.public_settings()
        transport = settings.get('transport', provider.WORKBUDDY)
        self.check_transport(transport)
        if transport != provider.WORKBUDDY:
            text_value(settings.get('model'), '模型ID', 120, empty=False)
            return
        with self.guard:
            if self.catalog is None:
                self.catalog = provider.models()
            chosen = settings.get('model')
            if not any(m.get('id') == chosen for m in self.catalog):
                raise Problem('所选 WorkBuddy 模型目录中不可用；请明确选择，系统不会自动换模型')

    def refresh_models(self):
        with self.guard:
            previous = getattr(provider.local, 'trace', None)
            trace = self._trace('catalog-' + uid())
            provider.local.trace = trace
            trace('request', {'operation': 'models', 'timeout': 30})
            try:
                self.catalog = provider.models()
                trace('response', {'models': self.catalog})
                return copy.deepcopy(self.catalog)
            except Exception as exc:
                trace('response', {'error': provider.public_error(exc), 'kind': getattr(exc, 'kind', None), 'status': getattr(exc, 'status', None)})
                raise
            finally:
                if previous is None:
                    provider.local.__dict__.pop('trace', None)
                else:
                    provider.local.trace = previous

    def zip_config(self):
        return {'platforms': self.store.list_platforms(), 'target_models': self.store.list_models(),
                'models': self.store.list_models(), 'prefs': self.store.get_prefs(),
                'risks': self.store.list_risks(), 'settings': self.public_settings()}

    def bootstrap(self):
        return {**self.zip_config(), 'clients': self.ws.clients(), 'conversations': self.ws.conversations(),
                'provider_models': copy.deepcopy(self.catalog or []),
                'local_api_sources': local_api.sources(),
                'setting_limits': {'temperature': {'min': 0, 'max': 1.5}, 'max_tokens': {'min': 800, 'max': 8000}}}

    def create_conversation(self, cid, *, document_ids=None, creation_id=None, mode='chat'):
        if mode not in ('chat', 'zip'):
            raise Problem('创作模式需为chat或zip')
        with self.guard:
            return self.customers.new_task(cid, document_ids=document_ids, creation_id=creation_id, mode=mode)

    def save_task_profile(self, ident, name, profile, save_as_default=False):
        text_value(name, '客户名称', 100, empty=False)
        if not isinstance(profile, dict) or set(profile) != set(PROFILE_FIELDS):
            raise Problem('资料保存需包含全部七项档案字段；清空请明确传空字符串')
        patch = {'client': name.strip(), **{k: text_value(profile[k], k, 4000).strip() for k in PROFILE_FIELDS}}
        with self.guard:
            conv = self.ws.conversation(ident)
            if self.batches.managed(ident):
                raise Conflict('批次已冻结客户信息，请在客户管理修改后用于新批次')
            brief = self.normalize_options(patch, conv['brief'])
            changed = brief != conv['brief']
            job = self.running_job(conv)
            running = bool(changed and job and job['status'] == 'running')
            if type(save_as_default) is not bool: raise Problem('save_as_default需为布尔值')
            result = self.ws.save_task_profile(ident, brief, running, save_as_default)
            if running: generator.cancel_job(job['id'])
            return result

    def running_job(self, conv):
        return generator.get_job(conv.get('job_id')) if conv.get('job_id') else None

    def view(self, ident):
        with self.guard:
            conv = self.ws.conversation(ident)
            articles = [self.ws.current(a['id']) for a in self.ws.visible_articles(conv['plan_id'])] if conv['plan_id'] else []
            job = self.running_job(conv)
            if not job and conv.get('job_id'):
                job = {'id': conv['job_id'], 'status': 'interrupted', 'message': '服务重启，已有稿件已保留，请明确决定是否续写'}
            batch = self.batches.context(ident)
            keywords = conv['brief'].get('keywords', []) if batch else self.customers.keyword_choices(conv['client_id'])
            return {'conversation': conv, 'articles': articles, 'documents': self.ws.selected_documents(conv),
                    'available_keywords': keywords, 'job': job, 'operations': self.ws.operations_for(ident), 'batch': batch}

    def normalize_options(self, patch, base=None):
        if not isinstance(patch, dict) or set(patch) - OPTION_FIELDS - {'document_ids'}:
            raise Problem('写作选项包含未知字段')
        value = {**copy.deepcopy(base or {}), **copy.deepcopy(patch)}
        value.pop('document_ids', None)
        for key in set(PROFILE_FIELDS) | {'note', 'length_hint', 'client', 'topic', 'points', 'extra'}:
            if key in value: text_value(value[key], key, 20000 if key == 'note' else 4000)
        if 'client' in value: text_value(value['client'], '客户名称', 100, empty=False)
        for key in ('keywords', 'rivals', 'models'):
            if key in value:
                items = value[key]
                if not isinstance(items, list) or len(items) > 200 or any(not isinstance(i, str) or not i.strip() or len(i) > 500 for i in items):
                    raise Problem(f'{key}需为文字列表')
                value[key] = list(dict.fromkeys(i.strip() for i in items))
        aliases = value.get('aliases', [])
        if not isinstance(aliases, list) or len(aliases) > 200 or any(not isinstance(g, list) or not g or any(not isinstance(s, str) or len(s) > 500 for s in g) for g in aliases):
            raise Problem('同义词需为词组列表')
        if 'keyword_links' in value:
            links = value['keyword_links']
            if not isinstance(links, list) or len(links) > 200:
                raise Problem('串联关键词最多 200 组')
            normalized = []
            for pair in links:
                if not isinstance(pair, list) or len(pair) != 2:
                    raise Problem('每组串联关键词需填写搜索词 A 和关联词 B')
                source, target = (text_value(word, '串联关键词', 500, empty=False).strip() for word in pair)
                if source == target or any(char in source + target for char in ('\n', '\r', '\0', '→')):
                    raise Problem('串联关键词需为两个不同的单行词组')
                normalized.append((source, target))
            value['keyword_links'] = [list(pair) for pair in dict.fromkeys(normalized)]
        selections = value.get('selections', [])
        if not isinstance(selections, list) or len(selections) > 100:
            raise Problem('平台选择不正确')
        platforms = {p['id']: p for p in self.store.list_platforms()}
        for selection in selections:
            if not isinstance(selection, dict) or type(selection.get('platform_id')) is not int or selection['platform_id'] not in platforms:
                raise Problem('平台ID不正确')
            if selection.get('account_type') not in generator.ACCOUNT_TYPES or type(selection.get('count')) is not int or not 0 <= selection['count'] <= generator.MAX_PER_GROUP:
                raise Problem('平台需选择官方号/个人号并设置0至20篇')
            if selection['count'] and not platforms[selection['platform_id']]['enabled']:
                raise Problem('选中的平台已停用，请重新选择')
        value['selections'] = generator.normalize_selections(selections)
        names = {m['name'] for m in self.store.list_models() if m['enabled']}
        if any(m not in names for m in value.get('models', [])):
            raise Problem('选定目标AI已删除或停用，请重新选择')
        overrides = value.get('format_overrides', {})
        if not isinstance(overrides, dict): raise Problem('发布形态需为对象')
        for key, formats in overrides.items():
            if not isinstance(key, str) or not key.isdigit() or int(key) not in platforms or not isinstance(formats, list) or not formats or any(f not in platforms[int(key)]['formats'] for f in formats):
                raise Problem('发布形态需从当前平台已配置的形态中选择')
        if 'platform_types' in value:
            types = value['platform_types']
            if not isinstance(types, dict) or any(not k.isdigit() or int(k) not in platforms or v not in generator.ACCOUNT_TYPES for k, v in types.items()):
                raise Problem('平台账号默认值不正确')
        if 'keyword_brands' in value:
            mapping = value['keyword_brands']
            if not isinstance(mapping, dict) or any(not isinstance(v, list) or any(not isinstance(s, str) for s in v) for v in mapping.values()):
                raise Problem('品牌搜索结果不正确')
        return value

    def save_draft(self, ident, options=None, document_ids=None, mode=None, followup=None):
        with self.guard:
            conv = self.ws.conversation(ident)
            patch = {} if options is None else options
            value = self.normalize_options(patch, conv['brief'])
            docs = self.ws.selected_documents(conv, document_ids if document_ids is not None else patch.get('document_ids'))
            if mode is not None and mode not in ('chat', 'zip'): raise Problem('创作模式需为chat或zip')
            if followup is not None and not isinstance(followup, bool): raise Problem('followup需为布尔值')
            changed = value != conv['brief'] or [d['id'] for d in docs] != conv['document_ids']
            if changed and self.batches.managed(ident):
                raise Conflict('批次安排已经提交，请复用为新任务或创建新批次调整')
            job = self.running_job(conv)
            values = {'brief': value, 'document_ids': [d['id'] for d in docs], 'draft_revision': conv['draft_revision'] + int(changed)}
            if mode is not None: values['mode'] = mode
            if followup is not None: values['followup'] = followup
            if changed and job and job['status'] == 'running':
                generator.cancel_job(job['id'])
                values['needs_confirmation'] = True
            return self.ws.update_conversation(ident, **values)

    def _trace(self, op):
        folder = Path(self.store.db_path).resolve().parent / 'traces' / op
        folder.mkdir(parents=True, exist_ok=True)
        counter = [0]
        last_request = [None]
        def save(kind, value):
            if kind == 'request':
                counter[0] += 1
                last_request[0] = copy.deepcopy(value)
            if kind == 'response':
                provider.local.last_exchange = {'request': last_request[0], 'response': copy.deepcopy(value)}
            (folder / f'{counter[0]:03d}-{kind}.json').write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        return save

    def publish_reply(self, ident, text, complete):
        with self.operation_changes:
            current = self.ws.operation(ident)
            if current['status'] != 'running' or self.cancellations[ident].is_set():
                raise provider.failure('cancelled')
            previous = current['result']
            if previous.get('understanding') == text and previous.get('reply_complete') == complete: return
            self.ws.update_operation_reply(ident, text, complete)
            self.operation_changes.notify_all()

    def background(self, kind, ident, fn, aid=None, expected=None):
        with self.guard:
            if self.closed: raise Conflict('服务正在退出')
            if any(o['status'] == 'running' and o['kind'] != 'writing' for o in self.ws.operations_for(ident)):
                raise Conflict('当前对话已有模型处理，请完成或停止后操作')
            op = self.ws.create_operation(kind, ident, aid)
            cancel = threading.Event()
            self.cancellations[op] = cancel
            if aid:
                try: self.ws.lock_article(aid, op, expected)
                except Exception:
                    self.ws.finish_operation(op, error='稿件版本或处理状态已变化')
                    self.cancellations.pop(op, None)
                    raise
            settings = self.public_settings()
            def run():
                provider.local.usage, provider.local.cancel = [], cancel
                result, error, status = {}, '', 'done'
                try:
                    provider.local.trace = self._trace(op)
                    if cancel.is_set(): raise provider.failure('cancelled')
                    self.ensure_model(settings)
                    result = fn(op, settings) or {}
                    result['usage'] = provider.local.usage
                    if cancel.is_set() and kind != 'interview': status = 'stopped'
                except Exception as exc:
                    error = provider.public_error(exc)
                    if isinstance(exc, Problem):
                        result = {'error_status': exc.status}
                    status = 'stopped' if cancel.is_set() else 'interrupted' if getattr(exc, 'kind', '') == 'uncertain' else 'error'
                finally:
                    with self.guard:
                        if kind == 'interview' and status != 'done':
                            partial = self.ws.operation(op)['result']
                            if partial.get('partial'): result = {**partial, **result}
                        if aid: self.ws.unlock_article(aid, op)
                        self.ws.finish_operation(op, result, error, status)
                        self.operation_changes.notify_all()
                        self.cancellations.pop(op, None)
                        self.threads.pop(op, None)
                    provider.local.__dict__.clear()
            thread = threading.Thread(target=run, name='wb-' + kind + '-' + op[:8], daemon=True)
            self.threads[op] = thread
            thread.start()
        return op

    def cancel_operation(self, ident):
        with self.guard:
            op = self.ws.operation(ident)
            if op['kind'] == 'writing': return self.stop(op['conversation_id'])
            cancel = self.cancellations.get(ident)
            if op['status'] == 'running' and cancel: cancel.set()
        return {'message': '已请求停止本地处理；不能确认云端已停止，稿件将在本地收尾后解锁'}

    def chat(self, ident, text, document_ids=None, followup=None, options=None):
        from .interview import conduct
        with self.guard:
            text = text_value(text, '写作要求', 20000, empty=False).strip()
            conv = self.ws.conversation(ident)
            if any(o['status'] == 'running' and o['kind'] != 'writing' for o in self.ws.operations_for(ident)):
                raise Conflict('当前需求整理尚未完成，请完成或停止后补充')
            conv = self.save_draft(ident, options, document_ids, followup=followup)
            job = self.running_job(conv)
            if job and job['status'] == 'running': generator.cancel_job(job['id'])
            messages = conv['messages'] + [{'role': 'user', 'content': text}]
            conv = self.ws.update_conversation(ident, messages=messages, draft_revision=conv['draft_revision'] + 1,
                needs_confirmation=conv['needs_confirmation'] or bool(job and job['status'] == 'running'),
                status=conv['status'] if job and job['status'] == 'running' else 'discussing')
            return self.background('interview', ident, lambda op, settings: conduct(self, conv, op, settings))

    def build_brief(self, conv):
        options = self.normalize_options({}, conv['brief'])
        if any(k not in options for k in (*PROFILE_FIELDS, 'client')):
            raise Problem('当前任务客户字段不完整，请在资料入口保存后开始')
        brief = {k: v for k, v in options.items() if k != 'format_overrides'}
        selections = [s for s in options.get('selections', []) if s['count'] > 0]
        keywords = options.get('keywords', [])
        issues = []
        if not keywords: issues.append('请填写至少一个目标搜索关键词')
        if not selections: issues.append('请给至少一个平台设置篇数')
        enabled = {p['id']: p for p in self.store.list_platforms() if p['enabled']}
        if any(s['platform_id'] not in enabled for s in selections): issues.append('选中的平台已停用')
        if issues: raise Problem('；'.join(issues))
        brief.update(keyword=keywords[0], selections=selections,
                     platforms=list(dict.fromkeys(enabled[s['platform_id']]['name'] for s in selections)))
        # The editable visible arrangement is the single source. Messages remain an audit trail.
        brief['note'] = options.get('note', '')
        return brief

    def zip_snapshot(self, brief):
        """The ZIP server's exported preference matrix and risk snapshot shape."""
        models = [m for m in self.store.list_models() if m['enabled'] and (not brief.get('models') or m['name'] in brief['models'])]
        platforms = [p for p in self.store.list_platforms() if p['enabled'] and (not brief.get('platforms') or p['name'] in brief['platforms'])]
        prefs, risks = self.store.get_prefs(), self.store.list_risks()
        matrix = [{'model': m['name'], 'cells': [{'platform': p['name'], 'level': next((v['level'] for v in prefs
            if v['model_id'] == m['id'] and v['platform_id'] == p['id']), 'mid')} for p in platforms]} for m in models]
        return {'matrix': matrix, 'risks': [{'platform': p['name'], 'items': [{k: r[k] for k in ('category', 'item', 'level', 'tip')}
            for r in risks if r['platform_id'] is None or r['platform_id'] == p['id']]} for p in platforms],
            'levels': {'high': '高优先抓取', 'mid': '中等抓取', 'low': '低抓取'}, 'created_at': time.strftime('%Y-%m-%d %H:%M:%S')}

    def adopted_intake_editorial(self, cid, documents):
        if not documents:
            return {}
        selected = {(doc['id'], doc['revision'], doc['digest']) for doc in documents}
        with self.store.conn() as conn:
            rows = conn.execute('''
                SELECT a.id, a.intake_id, a.editorial, i.frozen
                FROM wb_client_intake_adoptions a
                JOIN wb_client_intakes i ON i.id=a.intake_id AND i.client_id=a.client_id
                WHERE a.client_id=? AND i.status='ready'
                  AND json_array_length(i.frozen, '$.documents')=?
                ORDER BY a.rowid DESC
            ''', (cid, len(documents)))
            for row in rows:
                docs = json.loads(row['frozen'])['documents']
                if selected == {(doc['id'], doc['revision'], doc['digest']) for doc in docs}:
                    adopted = self.intake.enrich_editorial(cid, json.loads(row['editorial']))
                    return {**{key: adopted[key] for key in ('overview', 'keywords', 'important_claims', 'conflicts')},
                            'intake_id': row['intake_id'], 'adoption_id': row['id']}
        return {}

    def freeze_creation_context(self, cid, source):
        from .creation_context import build, digest, supported_claims
        brief = {**source['brief'], 'format_overrides': source.get('format_overrides', source['brief'].get('format_overrides', {}))}
        client = {'id': cid, 'name': brief.get('client', ''), 'profile': {k: brief.get(k, '') for k in PROFILE_FIELDS}}
        context = build(client, source['documents'], brief, source['platforms'],
                        self.customers.plan(cid)['plan']['options'], self.accepted_expressions,
                        models=source.get('models', ()), prefs=source.get('prefs', ()))
        editorial = self.adopted_intake_editorial(cid, context['documents'])
        context['editorial'].update(editorial)
        context['editorial']['supported_claims'] = supported_claims(context['documents'], editorial.get('important_claims', []))
        context['digest'] = digest(context)
        return context

    def start(self, ident, options=None, one=False, _frozen=None, _batch=False):
        with self.guard:
            if self.closed: raise Conflict('服务正在退出')
            if self.batches.managed(ident) and not _batch:
                raise Conflict('请从批次入口继续任务，或复用为新任务')
            conv = self.ws.conversation(ident)
            old = self.running_job(conv)
            if old and old['status'] == 'running': raise Conflict('本批仍在运行，请等待当前篇收尾后确认续写')
            if any(o['status'] == 'running' for o in self.ws.operations_for(ident)): raise Conflict('当前模型处理尚未结束')
            conv = conv if _frozen else self.save_draft(ident, options)
            brief = copy.deepcopy(_frozen['brief']) if _frozen else self.build_brief(conv)
            docs = copy.deepcopy(_frozen['documents']) if _frozen else self.ws.selected_documents(conv)
            brief['snapshot'] = copy.deepcopy(_frozen.get('zip_snapshot', {})) if _frozen else self.zip_snapshot(brief)
            source = copy.deepcopy(_frozen) if _frozen else {'brief': brief, 'documents': docs, 'settings': self.public_settings(),
                'platforms': self.store.list_platforms(), 'models': self.store.list_models(), 'prefs': self.store.get_prefs(),
                'risks': self.store.list_risks(), 'format_overrides': conv['brief'].get('format_overrides', {}),
                'reference_articles': self.customers.reference_articles(conv['client_id'], ident)}
            source.update(brief=brief, documents=docs)
            if not _frozen:
                source['creation_context'] = self.freeze_creation_context(conv['client_id'], source)
            # Synchronous validation performs no generation; failure leaves a saved draft.
            self.ensure_model(source['settings'])
            pid = conv['plan_id']
            if not pid:
                pid = self.store.create_plan(brief['keyword'], brief['client'] + ' · ' + brief['keyword'], brief)
            self.store.update_plan(pid, brief=brief, keyword=brief['keyword'], title=brief['client'] + ' · ' + brief['keyword'], status='generating')
            self.store.replace_materials(pid, [{'filename': d['filename'], 'kind': d['kind'], 'text': d['text']} for d in docs])
            sid = self.ws.save_snapshot(ident, source)
            view = FrozenStore(self, pid, source, sid, snapshot=source)
            # Format overrides live alongside the executable brief in the snapshot.
            for platform in view.platforms:
                formats = source.get('format_overrides', {}).get(str(platform['id']))
                if formats: platform['formats'] = copy.deepcopy(formats)
            tasks, _, pending = generator.pending_tasks(view, pid, brief['keywords'], brief['selections'], brief.get('aliases'), brief.get('platform_types'))
            if not pending:
                self.store.update_plan(pid, status='generated')
                raise Conflict('当前目标篇数已完成；增加篇数后可继续补写')
            jid = generator.new_job(pid, 1 if one else len(pending), kind='write_one' if one else 'auto')
            # Native millisecond IDs can collide on an immediate resume.
            with generator._jobs_lock:
                job = generator._jobs.pop(jid)
                jid += '_' + uid()[:8]
                job['id'] = jid
                generator._jobs[jid] = job
            view.jid = jid
            title = brief['client'] + ' · ' + (brief.get('topic', '').strip() or brief['keyword'])
            self.ws.update_conversation(ident, plan_id=pid, job_id=jid, status='running', needs_confirmation=False,
                title=title)
            op = self.ws.create_operation('writing', ident)
            cancel = threading.Event()
            self.cancellations[op] = cancel
            def run():
                provider.local.halt = lambda: generator.cancel_job(jid)
                provider.local.usage, provider.local.cancel = [], cancel
                error, status = '', 'done'
                try:
                    provider.local.trace = self._trace(op)
                    (generator.run_write_one if one else generator.run_auto)(view, pid, copy.deepcopy(brief), jid)
                    if one:
                        _, _, left = generator.pending_tasks(view, pid, brief['keywords'], brief['selections'], brief.get('aliases'), brief.get('platform_types'))
                        generator._patch(jid, planned=1, total_all=len(tasks), remaining=len(left))
                        view.update_plan(pid, status='generated')
                    job = generator.get_job(jid)
                    failure = getattr(provider.local, 'failure', None)
                    if failure:
                        error = failure['message']
                        status = 'interrupted' if failure['kind'] == 'uncertain' else 'error'
                        generator._patch(jid, status='error', error=error, message=error)
                    elif job['status'] == 'error':
                        status, error = 'error', job.get('error') or '本批写作未完成'
                    elif job['status'] == 'paused': status = 'stopped'
                except Exception as exc:
                    status, error = 'error', provider.public_error(exc)
                    generator._patch(jid, status='error', error=error, message=error)
                finally:
                    view.finish_article()
                    with self.guard:
                        job = generator.get_job(jid) or {}
                        self.ws.update_conversation(ident, status=job.get('status', 'interrupted'))
                        self.ws.finish_operation(op, {'job_id': jid, 'status': job.get('status'), 'usage': provider.local.usage}, error, status)
                        self.cancellations.pop(op, None)
                        self.threads.pop(jid, None)
                    provider.local.__dict__.clear()
            thread = threading.Thread(target=run, name='zip-' + jid, daemon=True)
            self.threads[jid] = thread
            thread.start()
            return {'job_id': jid, 'operation_id': op, 'planned': 1 if one else len(pending), 'total': len(tasks), 'title': title}

    def stop(self, ident):
        with self.guard:
            conv = self.ws.conversation(ident)
            if conv['job_id']: generator.cancel_job(conv['job_id'])
        return {'message': '已暂停后续写作；当前篇按 ZIP 原生流程完成后停下'}

    def article_context(self, ident, aid):
        integer(aid, '稿件ID')
        conv = self.ws.conversation(ident)
        native = self.store.get_article(aid)
        if not native or native['plan_id'] != conv['plan_id'] or self.ws.is_deleted_article(aid): raise Missing('稿件不属于当前内容任务')
        return conv, self.ws.current(aid)

    def save_accepted_expression(self, ident, aid, body):
        if set(body) - {'expected_version', 'selection', 'excerpt', 'purpose', 'medium'}:
            raise Problem('认可表达含未知字段')
        expected = integer(body.get('expected_version'), 'expected_version')
        with self.guard:
            conv, article = self.article_context(ident, aid)
            if article['locked'] or article['current_version'] != expected or not self.ws.was_adopted(aid, expected):
                raise Conflict('请在当前已采用的正文版本上保存认可表达')
            return self.accepted_expressions.save(conv['client_id'], article, body.get('selection'),
                                                  body.get('excerpt'), body.get('purpose'), body.get('medium'))

    def article_editorial(self, ident, aid, vid):
        from .checks import article_length
        from .creation_context import key
        from .editing import version_fact_issues
        with self.guard:
            self.article_context(ident, aid)
            version = self.ws.version(aid, vid)
            source = self.ws.version_source(aid, vid)
            context = source.get('creation_context') or {}
            editorial = context.get('editorial') or {}
            article = version['article']
            review = version.get('review') or article.get('audit') or {}
            documents = context.get('documents', source.get('documents', []))
            brief = source.get('brief', {})
            variant = context.get('style', {}).get('variants', {}).get(key(article.get('platform_id'), article.get('account_type'), article.get('fmt')))
            measured = article_length(article.get('body_md') or '', variant['length']) if variant else (article.get('geo') or {}).get('length')
            status = review.get('status') or ('unverified' if review.get('verdict') == 'unverified' else
                'checked' if review.get('ok') else 'failed' if review else 'unchecked')
            return {'version_id': vid, 'documents': documents,
                    'generation_context': {'client': context.get('client', {'name': brief.get('client', '')}),
                        'request': context.get('request', {'note': brief.get('note', '')}),
                        'documents': [{'filename': doc['filename'], 'revision': doc.get('revision')} for doc in documents],
                        'style': {'applied': variant} if variant else {},
                        'editorial': {'length': measured}},
                    'important_claims': editorial.get('important_claims', []), 'conflicts': editorial.get('conflicts', []),
                    'fact_issues': version_fact_issues(version), 'fact_repairs': version.get('metadata', {}).get('fact_repairs', []),
                    'fact_status': status, 'fact_scope': review.get('scope'),
                    'fact_summary': review.get('summary') or review.get('reason') or review.get('error') or '',
                    'risk_tips': version['article'].get('risk_tips') or [],
                    'risk_tips_inherited': version['origin'] in ('manual', 'style', 'revision')}

    def repair_facts(self, ident, aid, expected, selected):
        from .editing import repair_facts
        return repair_facts(self, ident, aid, expected, selected)

    def require_stopped(self, ident):
        conv = self.ws.conversation(ident)
        if self.batches.managed(ident) in ('queued', 'running'):
            raise Conflict('本任务属于排队或运行的批次，请先从批次入口停止并等待收尾')
        job = self.running_job(conv)
        if job and job.get('status') == 'running' or any(o['status'] == 'running' for o in self.ws.operations_for(ident)):
            raise Conflict('请先停止并等待当前任务收尾，再执行此操作')
        return conv

    def clone_conversation(self, ident):
        with self.guard:
            self.require_stopped(ident)
            return self.ws.clone_conversation(ident)

    def delete_conversation(self, ident):
        with self.guard:
            self.require_stopped(ident)
            self.ws.delete_conversation(ident)
            return {'deleted_id': ident}

    def set_task_state(self, ident, body):
        if len(body) != 1 or set(body) - {'pinned', 'archived'} or type(next(iter(body.values()))) is not bool:
            raise Problem('请选择置顶或归档状态')
        field, enabled = next(iter(body.items()))
        with self.guard:
            if field == 'archived' and enabled:
                self.require_stopped(ident)
            else:
                self.ws.conversation(ident)
            return self.ws.set_task_state(ident, field, enabled)

    def delete_article(self, ident, aid, expected):
        with self.guard:
            self.require_stopped(ident)
            self.article_context(ident, aid)
            self.ws.delete_article(aid, expected)
            return {'deleted_id': aid}

    def native_action(self, ident, aid, expected, action, note=''):
        from .native_actions import perform
        return perform(self, ident, aid, expected, action, note)

    def style_review(self, ident, aid, expected):
        from .editing import style_review
        return style_review(self, ident, aid, expected)

    def rewrite(self, ident, aid, expected, review_id, selected, mode='full', material='', conservative=None):
        from .editing import style_rewrite
        return style_rewrite(self, ident, aid, expected, review_id, selected, mode, material, conservative)

    def revise(self, ident, aid, expected, instruction):
        from .editing import revise
        return revise(self, ident, aid, expected, instruction)

    def close(self):
        with self.guard:
            self.closed = True
            self.operation_changes.notify_all()
            self.batches.close()
            for conv in self.ws.conversations():
                if conv.get('job_id'): generator.cancel_job(conv['job_id'])
            for cancel in self.cancellations.values(): cancel.set()
            threads = list(self.threads.values())
        deadline = time.monotonic() + 8
        for thread in threads: thread.join(timeout=max(0, deadline - time.monotonic()))
        if self.batches.worker:
            self.batches.worker.join(timeout=max(0, deadline - time.monotonic()))
        lab_closed = self.writing_lab.close()
        return self.geo.close() and lab_closed and not any(thread.is_alive() for thread in threads) and not (self.batches.worker and self.batches.worker.is_alive())
