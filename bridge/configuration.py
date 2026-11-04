"""Validated native configuration writes; generation snapshots remain independent."""
import re
from app import seeds
from .errors import Problem, Missing, Conflict
from .storage import integer, text_value


def write(service, method, path, body):
    match = re.fullmatch(r'/api/(models|platforms|risks|prefs)(?:/(\d+))?', path)
    if not match: return None
    kind, raw_id = match.groups()
    ident = int(raw_id) if raw_id else None
    store = service.store
    with service.guard:
        rows = {'models': store.list_models, 'platforms': store.list_platforms,
                'risks': store.list_risks, 'prefs': store.get_prefs}[kind]()
        if kind == 'prefs':
            if method != 'POST' or ident is not None: raise Problem('抓取偏好使用POST保存')
            if set(body) - {'model_id', 'platform_id', 'level'}: raise Problem('抓取偏好含未知字段')
            mid, pid = integer(body.get('model_id'), 'model_id'), integer(body.get('platform_id'), 'platform_id')
            if not any(r['id'] == mid for r in store.list_models()) or not any(r['id'] == pid for r in store.list_platforms()):
                raise Missing('目标AI或平台不存在')
            level = body.get('level', 'mid')
            if level not in ('high', 'mid', 'low'): raise Problem('抓取偏好需为high/mid/low')
            store.set_pref(mid, pid, level)
            return {'prefs': store.get_prefs()}
        old = next((r for r in rows if r['id'] == ident), None) if ident else None
        if ident is not None and not old: raise Missing('配置项不存在')
        if method == 'DELETE' and ident:
            if body: raise Problem('删除配置无需额外字段')
            {'models': store.delete_model, 'platforms': store.delete_platform, 'risks': store.delete_risk}[kind](ident)
            return {'deleted_id': ident}
        if not (method == 'POST' and ident is None or method == 'PUT' and ident is not None): raise Problem('配置写入方法不正确')
        allowed = {'models': {'name', 'note', 'enabled'},
                   'platforms': {'name', 'formats', 'style', 'length_hint', 'structure_hint', 'audience', 'account_type', 'enabled'},
                   'risks': {'platform_id', 'category', 'item', 'level', 'tip'}}[kind]
        if set(body) - allowed: raise Problem('配置包含未知字段')
        patch = dict(body)
        if 'enabled' in patch and (type(patch['enabled']) not in (bool, int) or patch['enabled'] not in (True, False, 0, 1)):
            raise Problem('enabled需为布尔值或0/1')
        for key in allowed - {'enabled', 'formats', 'platform_id'}:
            if key in patch: patch[key] = text_value(patch[key], key, 10000, empty=key not in ('name', 'item')).strip()
        if kind in ('models', 'platforms'):
            if not old and 'name' not in patch: raise Problem('名称不能为空')
            if kind == 'platforms' and 'name' in patch:
                raw = patch['name']
                patch['name'], hinted = seeds.split_platform_name(raw)
                if not patch['name']: raise Problem('平台名称不能为空')
                if 'account_type' not in patch and (hinted or not old):
                    patch['account_type'] = hinted or seeds.guess_account_type(raw)
            if 'name' in patch and any(r['name'] == patch['name'] and r['id'] != ident for r in rows): raise Conflict('这个名称已经存在')
        if kind == 'models':
            if old: store.update_model(ident, **patch)
            else:
                if 'enabled' in patch: raise Problem('新配置默认启用，请创建后再设置启用状态')
                ident = store.add_model(**patch)
        elif kind == 'platforms':
            if 'account_type' in patch and patch['account_type'] not in ('official', 'personal'): raise Problem('默认账号类型需为official/personal')
            if 'formats' in patch:
                formats = patch['formats']
                if not isinstance(formats, list) or not formats or len(formats) > 30 or any(not isinstance(v, str) or not v.strip() or len(v) > 100 for v in formats):
                    raise Problem('形态需为非空文字列表')
                patch['formats'] = list(dict.fromkeys(v.strip() for v in formats))
            if old: store.update_platform(ident, **patch)
            else:
                if 'enabled' in patch: raise Problem('新配置默认启用，请创建后再设置启用状态')
                ident = store.add_platform(**patch)
        else:
            pid = patch.get('platform_id', (old or {}).get('platform_id'))
            if pid is not None and (type(pid) is not int or not any(r['id'] == pid for r in store.list_platforms())): raise Problem('适用平台不存在')
            if patch.get('level', (old or {}).get('level', '中')) not in ('高', '中', '低'): raise Problem('风险等级需为高/中/低')
            if old:
                # Native editable fields plus the visible applicable-platform field.
                if patch:
                    with store.conn() as conn:
                        conn.execute('UPDATE risks SET ' + ','.join(k + '=?' for k in patch) + ' WHERE id=?', [*patch.values(), ident])
            else:
                if 'item' not in patch: raise Problem('风险内容不能为空')
                ident = store.add_risk(**patch)
        return {'id': ident, kind: {'models': store.list_models, 'platforms': store.list_platforms, 'risks': store.list_risks}[kind]()}
