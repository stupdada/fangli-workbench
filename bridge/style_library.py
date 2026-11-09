"""Applicable writing references; customer facts are never supplied by this library."""
import hashlib
import json
from pathlib import Path

CONFIG = Path(__file__).resolve().parent.parent / 'config/style-library.json'


def load():
    config_bytes = CONFIG.read_bytes()
    config = json.loads(config_bytes)
    root = Path(config['root'])
    if not root.is_absolute():
        root = CONFIG.parent.parent / root
    if not root.is_dir(): return None
    profile_bytes = (root / 'profiles.json').read_bytes()
    expression_bytes = (root / 'expression-references.json').read_bytes()
    return (config, json.loads(profile_bytes), json.loads(expression_bytes),
            {'profiles.json': hashlib.sha256(profile_bytes).hexdigest(),
             'expression-references.json': hashlib.sha256(expression_bytes).hexdigest(),
             'config/style-library.json': hashlib.sha256(config_bytes).hexdigest()})


def _form(article):
    return {'短视频': 'video', '问答': 'answer', '回答': 'answer'}.get(
        article.get('fmt'), 'images' if article.get('platform_name') == '抖音' else 'article')


def _select(bundle, article, client_id):
    config, library, reference_library, _ = bundle
    account = 'enterprise' if article.get('account_type') == 'official' else 'personal'
    platform = article.get('platform_name')
    platform = {'头条': '今日头条'}.get(platform, platform)
    form = _form(article)
    selected = [p for p in library['profiles'] if p.get('platform') == platform and
                p.get('account_type') == account and form in p.get('forms', [])]
    binding = config.get('client_bindings', {}).get(client_id, {})
    expressions = []
    for item in reference_library.get('references', []):
        if item.get('approval', {}).get('status') != 'accepted': continue
        scope = item.get('scope') or {}
        if scope.get('forms') and form not in scope['forms']: continue
        if scope.get('profileIds') and not any(p['id'] in scope['profileIds'] for p in selected): continue
        if scope.get('clientPolicyIds') and binding.get('client_policy_id') not in scope['clientPolicyIds']: continue
        if scope.get('productIds') and not set(binding.get('product_ids', [])) & set(scope['productIds']): continue
        if scope.get('audienceModes') and binding.get('audience_mode') not in scope['audienceModes']: continue
        if scope.get('lengths') and binding.get('length') not in scope['lengths']: continue
        if scope.get('readers') and binding.get('reader') not in scope['readers']: continue
        if scope.get('publisherRoles') and binding.get('publisher_role') not in scope['publisherRoles']: continue
        expressions.append({k: item[k] for k in ('id', 'lesson', 'after', 'text', 'applicationNote') if k in item})
    return selected, expressions


def references(article, client_id):
    bundle = load()
    if not bundle: return {'profiles': [], 'expressions': [], 'status': 'unavailable'}
    selected, expressions = _select(bundle, article, client_id)
    # Editorial signals in the style library duplicate de-ai-taste. Do not load them again.
    relevant = [{k: p[k] for k in ('id', 'intent', 'voice', 'entry_options', 'organization', 'evidence') if k in p} for p in selected]
    return {'profiles': relevant, 'expressions': expressions,
            'use': '只供生成后审阅参考；篇幅和结构不作为强制改写门槛；表达例句不得提供本次事实。'}


def generation_references(bundle, article, client_id):
    """Freeze exact applicable rules and provenance for the first writing call."""
    if not bundle: return {'profiles': [], 'expressions': [], 'status': 'unavailable'}
    selected, expressions = _select(bundle, article, client_id)
    form = _form(article)
    selected = [{**profile, **profile.get('form_overrides', {}).get(form, {})} for profile in selected]
    return {'profiles': selected, 'expressions': expressions, 'version': bundle[1].get('version'),
            'sources': bundle[3],
            'use': '平台规则与认可表达用于写法；事实依据来自当前客户的本次资料和已确认档案。'}
