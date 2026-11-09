"""Explicit native regenerate/audit, isolated until an adopted-version CAS commit."""
import copy
import json
import sqlite3
from app import generator, llm, prompts
from . import provider
from .errors import Problem, Conflict
from .storage import text_value, uid


class RevisionStore:
    """Native SQL reads see the selected working article; all writes stay in memory."""
    def __init__(self, source, article):
        self.source = copy.deepcopy(source)
        self.article = copy.deepcopy(article)
        self.article.update(audit={}, body_original='')
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute('CREATE TABLE articles(id INTEGER PRIMARY KEY,plan_id INTEGER,platform_id INTEGER,keyword TEXT,keywords TEXT,angle TEXT,fmt TEXT)')
        self.db.execute('INSERT INTO articles VALUES(?,?,?,?,?,?,?)',
                        (article['id'], article['plan_id'], article['platform_id'], article['keyword'], json.dumps(article['keywords'], ensure_ascii=False), article['angle'], article['fmt']))
        self.db.execute('CREATE TABLE plans(id INTEGER PRIMARY KEY,keyword TEXT,brief TEXT)')
        self.db.execute('INSERT INTO plans VALUES(?,?,?)', (article['plan_id'], source['brief']['keyword'], json.dumps(source['brief'], ensure_ascii=False)))
        self.db.commit()

    def conn(self): return self.db
    def get_settings(self): return copy.deepcopy(self.source['settings'])
    def list_platforms(self): return copy.deepcopy(self.source['platforms'])
    def list_models(self): return copy.deepcopy(self.source['models'])
    def get_prefs(self): return copy.deepcopy(self.source['prefs'])
    def list_risks(self): return copy.deepcopy(self.source['risks'])
    def list_materials(self, _): return copy.deepcopy(self.source['documents'])
    def list_articles(self, _):
        return [copy.deepcopy(self.article if a['id'] == self.article['id'] else a) for a in self.source['articles']]
    def get_article(self, aid): return copy.deepcopy(self.article) if aid == self.article['id'] else None
    def get_plan(self, _): return {'brief': copy.deepcopy(self.source['brief']), 'articles': self.list_articles(None)}
    def update_article(self, aid, **values):
        if aid != self.article['id']: raise ValueError('wrong native action article')
        if 'geo' in values:
            from .checks import article_checks
            values['geo'] = article_checks({**self.article, **values}, values['geo'])
        self.article.update(copy.deepcopy(values))


def last_response():
    return getattr(provider.local, 'last_exchange', {}).get('response', {}).get('text', '')


def perform(service, ident, aid, expected, action, note=''):
    if action not in ('regenerate', 'audit'): raise Problem('未知原生稿件操作')
    text_value(note, '重写要求', 20000)
    with service.guard:
        conv = service.require_stopped(ident)
        _, selected = service.article_context(ident, aid)
        if selected['current_version'] != expected: raise Conflict('当前正文已变化，请重新打开后操作')
        brief = service.build_brief(conv)
        platform = next((p for p in service.store.list_platforms() if p['id'] == selected['platform_id'] and p['enabled']), None)
        if not platform: raise Problem('稿件原平台已删除或停用，无法执行原生操作')
        if selected['fmt'] not in platform['formats']: raise Problem('稿件原形态已从平台移除，请先恢复该形态配置')
        # Keep this article's original grouping, angle, format and account identity.
        brief['keyword'] = selected['keyword']
        brief['platform_types'] = {**brief.get('platform_types', {}), str(platform['id']): selected['account_type']}
        source = {'brief': brief, 'documents': service.ws.selected_documents(conv),
                  'platforms': service.store.list_platforms(), 'models': service.store.list_models(),
                  'prefs': service.store.get_prefs(), 'risks': service.store.list_risks(),
                  'settings': service.public_settings(), 'articles': service.ws.visible_articles(conv['plan_id'])}
        article = {k: copy.deepcopy(v) for k, v in selected.items() if k not in ('current_version', 'version_label', 'origin', 'review', 'locked')}
        evidence = service.ws.version_evidence(aid, expected)

        def run(op, _settings):
            adapter = RevisionStore(source, article)
            try:
                initial = None
                audit_brief = brief
                if action == 'regenerate':
                    jid = generator.new_job(article['plan_id'], 1, kind='regenerate')
                    with generator._jobs_lock:
                        job = generator._jobs.pop(jid)
                        jid += '_' + uid()[:8]; job['id'] = jid; generator._jobs[jid] = job
                    generator.run_regenerate(adapter, aid, jid, note)
                    job = generator.get_job(jid)
                    if job['status'] != 'done':
                        failed = getattr(provider.local, 'failure', None)
                        if failed: raise llm.LLMError(failed['message'], failed['kind'], failed.get('status'))
                        raise Problem(job.get('error') or '原生重写未完成，当前稿保留')
                    raw = last_response()
                    data = llm.parse_json(raw)
                    if not isinstance(data, dict) or not data.get('title'): raise Problem('原生重写没有完整来源，当前稿保留')
                    angle = next(a for a in prompts.ANGLES if a['name'] == article['angle'])
                    original_brief = copy.deepcopy(brief)
                    if note: original_brief['note'] = (brief.get('note') or '').strip() + '；本次重写要求：' + note
                    audit_brief = original_brief
                    finalized = generator._finalize(data, original_brief, platform, angle, article['fmt'], source['settings'], article['keyword'],
                        [w for w in article['keywords'] if w != article['keyword']], layout=prompts.layout_for(platform, article['fmt']))
                    evidence.clear()
                    evidence.update(zip_data=finalized['data'], raw_generation=raw)
                    initial = copy.deepcopy(adapter.article)
                # Same original native audit, including its one-pass auto-correction safety gate.
                audit = generator.audit_article(adapter, source['settings'], aid, audit_brief)
                if not audit.get('ok'): raise Problem(audit.get('error') or '原生核查未完成，当前稿保留')
                if getattr(provider.local, 'failure', None) or provider.local.cancel.is_set():
                    raise Problem('模型处理未完整结束，当前稿保留')
                evidence.update(raw_audit=last_response(), native_audit=audit)
                evidence.pop('body_original', None)
                if adapter.article.get('body_original'): evidence['body_original'] = adapter.article['body_original']
                with service.guard:
                    frozen_input = {k: v for k, v in source.items() if k not in ('articles', 'settings')}
                    frozen_input['brief'] = audit_brief
                    frozen_input['settings'] = source['settings']
                    vid = service.ws.save_native_version(aid, expected, adapter.article, op,
                        'zip_regenerate' if action == 'regenerate' else 'zip_audit', evidence, frozen_input, initial)
                result = {'article_id': aid, 'adopted_version': vid, 'base_version': expected, 'audit': audit}
                if initial is not None: result['draft_version'] = service.ws.version(aid, vid)['parent_id']
                return result
            finally:
                adapter.db.close()
        return service.background('zip_regenerate' if action == 'regenerate' else 'zip_audit', ident, run, aid, expected)
