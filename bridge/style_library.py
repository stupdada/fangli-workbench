"""Post-generation references only; the de-ai-taste signal library has one owner."""
import json
from pathlib import Path

CONFIG = Path(__file__).resolve().parent.parent / 'config/style-library.json'


def references(article, client_id):
    config = json.loads(CONFIG.read_text(encoding='utf-8'))
    root = Path(config['root'])
    if not root.is_absolute():
        root = CONFIG.parent.parent / root
    if not root.is_dir(): return {'profiles': [], 'expressions': [], 'status': 'unavailable'}
    profiles = json.loads((root / 'profiles.json').read_text(encoding='utf-8'))['profiles']
    account = 'enterprise' if article.get('account_type') == 'official' else 'personal'
    form = 'video' if article.get('fmt') == '短视频' else 'images' if article.get('platform_name') == '抖音' else 'article'
    selected = [p for p in profiles if p.get('platform') == article.get('platform_name') and
                p.get('account_type') == account and form in p.get('forms', [])]
    # Editorial signals in the style library duplicate de-ai-taste. Do not load them again.
    relevant = [{k: p[k] for k in ('id', 'intent', 'voice', 'entry_options', 'organization', 'evidence') if k in p} for p in selected]
    binding = config.get('client_bindings', {}).get(client_id, {})
    expressions = []
    refs = json.loads((root / 'expression-references.json').read_text(encoding='utf-8')).get('references', [])
    for item in refs:
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
    return {'profiles': relevant, 'expressions': expressions,
            'use': '只供生成后审阅参考；篇幅和结构不作为强制改写门槛；表达例句不得提供本次事实。'}
