"""Bounded real-HTTP acceptance driver. Each model action is explicit, never retried."""
import argparse
import hashlib
import http.client
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from app import render
LIVE = ROOT.parent / 'output/geo-merge-20261104/core/live'
DATA = LIVE / 'data'
STATE = LIVE / 'acceptance.json'


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def read(path): return json.loads(path.read_text(encoding='utf-8'))
def digest(value): return hashlib.sha256(value).hexdigest()


class Acceptance:
    def __init__(self):
        self.state = read(STATE) if STATE.exists() else {'dispatch_id': 'core-002', 'fixture_only': True, 'http': [], 'results': {}}
        self.service = read(LIVE / 'service.json')
        self.url = urlsplit(self.service['url'])

    def save(self):
        self.state['calls'] = self.calls()
        write(STATE, self.state)

    def calls(self):
        values = []
        for path in sorted((DATA / 'traces').glob('*/*-request.json')):
            payload = read(path)
            values.append({'path': str(path.relative_to(LIVE)), 'operation': payload.get('operation', 'content'),
                'model': payload.get('model'), 'temperature': payload.get('temperature'), 'max_tokens': payload.get('max_tokens'),
                'force_json': payload.get('force_json'), 'sha256': digest(path.read_bytes())})
        return {'content': sum(v['operation'] == 'content' for v in values), 'catalog': sum(v['operation'] == 'models' for v in values), 'requests': values}

    def budget(self, content=0, catalog=0):
        count = self.calls()
        if count['content'] + content > 8 or count['catalog'] + catalog > 1:
            raise RuntimeError('Authorized live-call budget would be exceeded')
        if self.state.get('external_failure') and (content or catalog):
            raise RuntimeError('External failure already recorded; further real calls are disabled for this dispatch')

    def http(self, path, method='GET', body=None, expected=200, label='http', raw=False):
        conn = http.client.HTTPConnection(self.url.hostname, self.url.port, timeout=45)
        request = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
        try:
            conn.request(method, path, body=request, headers={'Content-Type': 'application/json'})
            response = conn.getresponse(); data = response.read(); status = response.status
        finally:
            conn.close()
        sequence = len(self.state['http']) + 1
        record = {'index': sequence, 'method': method, 'path': path, 'status': status,
            'body': body, 'response_sha256': digest(data), 'response_bytes': len(data)}
        if not raw:
            record['response'] = json.loads(data)
        self.state['http'].append(record)
        write(LIVE / 'http' / f'{sequence:03d}-{label}.json', record)
        self.save()
        if status != expected:
            if status == 502:
                self.state['external_failure'] = {'phase': label, 'http_status': status, 'response': record.get('response')}
                self.save()
            raise RuntimeError(f'{label}: HTTP {status}, expected {expected}; preserved in HTTP evidence')
        return data if raw else record['response']

    def wait(self, operation_id, label):
        # The current HTTP contract has operation GET only. Bounded 15s reads while running.
        deadline = time.monotonic() + 480
        while True:
            time.sleep(15)
            value = self.http('/api/workbench/operations/' + operation_id, label=label + '-status')['operation']
            if value['status'] != 'running':
                write(LIVE / label / 'operation.json', value)
                self.state['results'][label] = {'operation_id': operation_id, 'status': value['status'], 'error': value['error']}
                if value['status'] != 'done':
                    self.state['external_failure'] = {'phase': label, 'operation_id': operation_id,
                        'status': value['status'], 'error': value['error'], 'note': 'No automatic retry; inspect private trace diagnostics.'}
                self.save()
                print(json.dumps({'phase': label, 'status': value['status'], 'calls': {k: self.calls()[k] for k in ('content', 'catalog')}}, ensure_ascii=False), flush=True)
                if value['status'] != 'done': raise RuntimeError('Live operation did not complete; raw evidence retained')
                return value
            if time.monotonic() > deadline:
                self.state['external_failure'] = {'phase': label, 'operation_id': operation_id, 'status': 'uncertain',
                    'note': 'Acceptance wait exceeded; operation not submitted again.'}
                self.save()
                raise RuntimeError('Operation completion uncertain; no repeated call')

    def convpath(self, kind): return '/api/workbench/conversations/' + self.state['fixtures'][kind]['conversation_id']

    def prepare(self):
        if self.state.get('fixtures'): raise RuntimeError('Fixture preparation already completed; do not duplicate')
        boot = self.http('/api/workbench/bootstrap', label='bootstrap')
        if boot['clients'] or boot['conversations'] or boot['provider_models']: raise RuntimeError('Acceptance needs a fresh, uncached workspace')
        if boot['settings']['model'] != 'deepseek-v4.1-flash': raise RuntimeError('Unexpected model; no model switch is permitted')
        write(LIVE / 'bootstrap.json', boot)
        fixtures = {
          'industry': {
            'name': '仅验收·澄匠工业材料', 'profile': {'industry': '工业粘接材料服务', 'brand': '澄匠',
              'company': '澄匠工业材料服务（验收夹具）', 'products': 'CX-24单涂型橡胶与金属热硫化胶粘剂', 'website': '', 'phone': '', 'address': ''},
            'keyword': 'CX-24单涂胶粘剂', 'preferred_platform': '知乎', 'account': 'official',
            'text': '''# 合成验收材料：澄匠与CX-24
本文件仅用于方立软件验收。下列品牌、公司和产品为合成夹具，不代表真实商家或实际性能认证；此说明属于编辑侧来源标识。

## 品牌、公司与角色
品牌为澄匠，公司为澄匠工业材料服务（验收夹具）。公司提供工业粘接材料选型信息与工艺资料服务。本文产品为CX-24单涂型橡胶与金属热硫化胶粘剂。不得将服务商写成该产品生产工厂，也没有独家代理、认证或进口关系资料。

## 产品体系与用途
CX-24在本夹具中采用单涂体系：使用同一种胶粘剂形成粘接层，不另外配独立底涂产品。单涂指所用材料体系，不等于每个工件只能刷一遍，也不意味着可以跳过表面处理。介绍场景是橡胶与金属件在热硫化过程中的粘接，可围绕材料准备、表面处理、施涂与硫化衔接来说明。

## 工序信息
金属件在施胶前应保持表面清洁、干燥，按工艺要求处理影响粘接的油污及疏松附着物。胶粘剂使用前充分混匀，施涂时尽量保持涂层均匀。涂层按工艺安排干燥后，再进入与橡胶的硫化粘接环节。施涂方式与生产节拍应根据工件形状和现有产线安排；更换材料或工艺时可先用实际基材做小样确认。

## 可用的比较角度
介绍单涂体系时，可以讨论备料、工位安排和独立底涂工序的变化。不能把工序减少直接等同于固定比例的降本、提速或强度提升。本夹具没有具体温度、压力、用量、粘接强度、保存期限、第三方检测、客户案例或服务承诺数据。一般工序解释和普通选型建议可以使用，具体参数不能自行补写。''',
            'note': '面向橡胶与金属件企业的工艺人员，介绍CX-24单涂体系及工序衔接，写一篇完整的官方说明文章。允许一般性概括与普通建议，保留有效工艺条件。不要编造具体参数、检测、客户经历和服务承诺。验收来源标识留编辑侧，不写进读者正文。'},
          'shop': {
            'name': '仅验收·巷里焙舍', 'profile': {'industry': '社区面包咖啡店', 'brand': '巷里焙舍',
              'company': '巷里焙舍餐饮服务（验收夹具）', 'products': '面包、咖啡、堂食与外带', 'website': '', 'phone': '', 'address': ''},
            'keyword': '巷里焙舍面包咖啡', 'preferred_platform': '今日头条', 'account': 'personal',
            'text': '''# 合成验收材料：巷里焙舍
本文件仅用于方立软件验收。巷里焙舍和下列公司为合成夹具，不对应真实门店或真实消费者经历；此说明属于编辑侧来源标识。

## 基本定位
品牌为巷里焙舍，运营公司为巷里焙舍餐饮服务（验收夹具）。定位是服务周边居民与通勤人群的社区面包咖啡店，可堂食，也可外带。可介绍日常买面包、带一杯咖啡，或坐下来慢慢吃的选择。

## 菜单与选择
夹具菜单包含吐司、恰巴塔和贝果；咖啡包含美式和拿铁。可以围绕面包形态、咖啡选择和搭配思路给普通建议，不把个人口味写成人人一致的结论。具体供应以当日菜单为准，没有限量抢购、固定套餐、优惠或预订承诺。

## 读者场景
赶时间的通勤者可以考虑方便携带的选择；愿意在店内停留的人可以把面包和咖啡放在一起慢慢吃。门店提供堂食和外带这两种方式，但没有座位数量、无线网络、安静程度、营业时间或具体地址资料。文章可写一般性场景，不写成作者亲自到店的经历。

## 信息边界
没有价格、开业年份、烘焙出炉频率、食材产地、销量、评分、健康功效、消费者评价或服务保证。不要虚构店员对话、试吃感受或个人探店故事。允许普通介绍、一般宣传和概括性表达；缺少非核心细节时不需要把正文变成资料核验清单。''',
            'note': '本次验收选择“工作日早餐与通勤外带”方向，面向周边居民和上班族介绍巷里焙舍的面包、咖啡与搭配思路，采用个人号的自然介绍语气。不要冒充亲自探店，不编造价格、口感实测或消费者评价。可以有一般宣传和概括，验收及取材说明留编辑侧，不写入正文。'}
        }
        records = {}
        for kind, fixture in fixtures.items():
            client = self.http('/api/workbench/clients', 'POST', {'name': fixture['name'], 'profile': fixture['profile']}, label=kind + '-client')['client']
            doc = self.http('/api/workbench/clients/' + client['id'] + '/documents', 'POST',
                {'filename': kind + '-合成验收材料.md', 'kind': 'Markdown', 'text': fixture['text']}, label=kind + '-document')['document']
            conv = self.http('/api/workbench/conversations', 'POST', {'client_id': client['id']}, label=kind + '-conversation')['conversation']
            candidates = [p for p in boot['platforms'] if p['enabled'] and p['name'] == fixture['preferred_platform']]
            platform = candidates[0] if candidates else next(p for p in boot['platforms'] if p['enabled'])
            options = {**conv['brief'], 'keywords': [fixture['keyword']], 'selections': [{'platform_id': platform['id'], 'account_type': fixture['account'], 'count': 1}],
                'note': fixture['note'] if kind == 'industry' else ''}
            self.http('/api/workbench/conversations/' + conv['id'] + '/draft', 'PUT',
                {'options': options, 'document_ids': [doc['id']], 'mode': 'chat'}, label=kind + '-draft')
            records[kind] = {'client_id': client['id'], 'document_id': doc['id'], 'conversation_id': conv['id'],
                'platform': platform['name'], 'account_type': fixture['account'], 'final_note': fixture['note']}
            write(LIVE / 'fixtures' / (kind + '.json'), fixture)
        self.state['fixtures'] = records; self.save()
        print(json.dumps({'prepared': records, 'calls': self.calls()}, ensure_ascii=False), flush=True)

    def catalog(self):
        self.budget(catalog=1)
        data = self.http('/api/workbench/provider-models', label='catalog')
        write(LIVE / 'catalog.json', data)
        exact = any(v['id'] == 'deepseek-v4.1-flash' for v in data['provider_models'])
        self.state['results']['catalog'] = {'exact_model_available': exact, 'model_count': len(data['provider_models'])}; self.save()
        if not exact: raise RuntimeError('Exact selected model is unavailable; no model switch')
        print(json.dumps({'exact_model_available': exact, 'models': len(data['provider_models']), 'calls': {k: self.calls()[k] for k in ('content', 'catalog')}}, ensure_ascii=False), flush=True)

    def interview(self):
        self.budget(content=1)
        body = {'text': '我想介绍店里这些面包和咖啡，还没有决定偏工作日早餐和通勤外带，还是周末到店慢慢坐。先帮我把内容方向理清，问一个会明显改变这篇内容重点的问题，并给建议。', 'followup': True}
        started = self.http(self.convpath('shop') + '/chat', 'POST', body, label='interview-start')
        result = self.wait(started['operation_id'], 'interview')
        self.state['results']['interview']['question_count'] = len(result['result'].get('questions', [])); self.save()
        # This is the acceptance operator's explicit fixture decision, not a fabricated human review.
        self.http(self.convpath('shop') + '/draft', 'PUT', {'options': {'note': self.state['fixtures']['shop']['final_note']}}, label='shop-direction-choice')

    def snapshot(self, kind, label):
        view = self.http(self.convpath(kind), label=label + '-view')
        write(LIVE / label / 'conversation.json', view)
        if view['articles']:
            article = view['articles'][0]
            versions = self.http(self.convpath(kind) + '/articles/' + str(article['id']) + '/versions', label=label + '-versions')
            write(LIVE / label / 'versions.json', versions)
            for version in versions['versions']:
                path = LIVE / label / f"version-{version['id']}-{version['origin']}.md"
                path.write_text(version['article']['body_md'], encoding='utf-8')
            self.state['fixtures'][kind]['article_id'] = article['id']
            for fmt in ('md', 'json', 'docx'):
                data = self.http(self.convpath(kind) + '/export?fmt=' + fmt, label=label + '-export-' + fmt, raw=True)
                (LIVE / label / ('adopted.' + fmt)).write_bytes(data)
            self.save()
        return view

    def generate(self, kind):
        self.budget(content=2)
        started = self.http(self.convpath(kind) + '/start', 'POST', {}, label=kind + '-generation-start')
        operation = self.wait(started['operation_id'], kind + '-generation')
        view = self.snapshot(kind, kind + '-native')
        if len(view['articles']) != 1: raise RuntimeError('Native writing did not preserve exactly one article')
        article = view['articles'][0]
        self.state['results'][kind + '-generation'].update(article_id=article['id'], version_id=article['current_version'],
            native_audit=article.get('audit', {}), native_default_adopted=article['origin'] == 'zip',
            chars=len(article['body_md']))
        self.save()
        print(json.dumps({'kind': kind, 'title': article['title'], 'chars': len(article['body_md']),
            'audit_ok': article.get('audit', {}).get('ok'), 'audit_applied': article.get('audit', {}).get('applied')}, ensure_ascii=False), flush=True)

    def style_review(self, kind):
        self.budget(content=1)
        view = self.http(self.convpath(kind), label='style-base')
        article = view['articles'][0]
        self.state['style'] = {'kind': kind, 'article_id': article['id'], 'base_version': article['current_version']}; self.save()
        path = self.convpath(kind) + '/articles/' + str(article['id'])
        started = self.http(path + '/style-review', 'POST', {'expected_version': article['current_version']}, label='style-review-start')
        operation = self.wait(started['operation_id'], 'style-review')
        self.state['style']['review_id'] = operation['id']; self.save()
        print(json.dumps(operation['result'], ensure_ascii=False, indent=2), flush=True)

    def rewrite(self, selected):
        self.budget(content=2)
        style = self.state['style']; kind = style['kind']
        body = {'expected_version': style['base_version'], 'review_id': style['review_id'], 'selected': selected, 'mode': 'full'}
        started = self.http(self.convpath(kind) + '/articles/' + str(style['article_id']) + '/style-rewrite', 'POST', body, label='style-rewrite-start')
        operation = self.wait(started['operation_id'], 'style-rewrite')
        style['candidate_version'] = operation['result']['candidate_version']; self.save()
        self.snapshot(kind, 'style-candidate')
        compare = self.http(self.convpath(kind) + '/articles/' + str(style['article_id']) + '/compare?candidate_version=' + str(style['candidate_version']), label='candidate-compare')
        write(LIVE / 'style-candidate' / 'compare.json', compare)
        print(json.dumps({'candidate_version': style['candidate_version'], 'fact_check': operation['result']['fact_check'],
            'current_version': self.state['style']['base_version'], 'adopted': False}, ensure_ascii=False, indent=2), flush=True)

    def adopt_edit(self, review_file):
        style = self.state['style']; kind = style['kind']; base = style['base_version']; candidate = style['candidate_version']
        path = self.convpath(kind) + '/articles/' + str(style['article_id'])
        before = self.http(self.convpath(kind), label='before-adoption')['articles'][0]
        assert before['current_version'] == base and before['origin'] == 'zip'
        original = (LIVE / (kind + '-native') / 'adopted.md').read_bytes()
        default_export = self.http(self.convpath(kind) + '/export?fmt=md', label='default-after-candidate', raw=True)
        assert default_export == original
        notes = self.http(path + '/review-record', 'PUT', {'candidate_version': candidate,
            'codex_review': review_file.read_text(encoding='utf-8')}, label='real-codex-review')
        assert all(record['user_review'] == '' for record in notes['review_records'])
        adopted = self.http(path + '/select-version', 'POST', {'expected_version': base, 'version_id': candidate}, label='explicit-adopt')['article']
        assert adopted['current_version'] == candidate
        adopted_export = json.loads(self.http(self.convpath(kind) + '/export?fmt=json', label='candidate-adopted-export', raw=True))
        prefix = read(LIVE / 'bootstrap.json')['settings']['title_prefix']
        projection = render.ensure_plan_prefix if prefix else render.strip_plan_prefix
        assert adopted_export['articles'][0]['body_md'] == projection({'articles': [adopted]})['articles'][0]['body_md']
        manual_body = adopted['body_md'] + '\n\n验收编辑标记（仅用于工作版本边界检查）。\n'
        manual = self.http(path, 'PUT', {'expected_version': candidate, 'body_md': manual_body}, label='explicit-manual-edit')['article']
        assert manual['origin'] == 'manual' and manual['review']['status'] == 'unverified' and not manual['audit']
        manual_export = json.loads(self.http(self.convpath(kind) + '/export?fmt=json', label='manual-adopted-export', raw=True))
        assert manual_export['articles'][0]['body_md'] == projection({'articles': [manual]})['articles'][0]['body_md']
        self.http(path, 'PUT', {'expected_version': candidate, 'body_md': 'stale request must not replace'}, expected=409, label='stale-edit-409')
        self.http(path + '/select-version', 'POST', {'expected_version': manual['current_version'], 'version_id': candidate}, expected=409, label='stale-candidate-409')
        restored = self.http(path + '/select-version', 'POST', {'expected_version': manual['current_version'], 'version_id': base}, label='restore-native-default')['article']
        assert restored['current_version'] == base
        final = self.http(self.convpath(kind) + '/export?fmt=md', label='restored-native-export', raw=True)
        assert final == original
        compare_md = self.http(path + '/compare?candidate_version=' + str(candidate) + '&fmt=md', label='real-review-comparison-export', raw=True)
        (LIVE / 'style-candidate' / 'comparison-reviewed.md').write_bytes(compare_md)
        self.snapshot(kind, 'final-restored')
        self.state['results']['live_version_boundaries'] = {'native_default_after_candidate': True, 'readonly_check_attempts': 1,
            'explicit_adoption_export': True, 'manual_edit_export': True, 'manual_version_unverified': True,
            'stale_edit_409': True, 'candidate_parent_mismatch_409': True, 'original_default_restored': True,
            'codex_review_actual': True, 'user_review': 'unreviewed', 'native_md_sha256': digest(final)}
        self.save(); print(json.dumps(self.state['results']['live_version_boundaries'], ensure_ascii=False, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'catalog', 'interview', 'generate', 'style-review', 'rewrite', 'adopt-edit', 'summary'])
    parser.add_argument('--kind', choices=['industry', 'shop'], default='industry')
    parser.add_argument('--selected', default='')
    parser.add_argument('--review-file', type=Path)
    args = parser.parse_args(); driver = Acceptance()
    try:
        if args.action == 'prepare': driver.prepare()
        elif args.action == 'catalog': driver.catalog()
        elif args.action == 'interview': driver.interview()
        elif args.action == 'generate': driver.generate(args.kind)
        elif args.action == 'style-review': driver.style_review(args.kind)
        elif args.action == 'rewrite': driver.rewrite([s for s in args.selected.split(',') if s])
        elif args.action == 'adopt-edit': driver.adopt_edit(args.review_file)
        else: driver.save(); print(json.dumps(driver.state, ensure_ascii=False, indent=2))
    except Exception as error:
        driver.state['last_acceptance_error'] = {'action': args.action, 'message': str(error)}; driver.save()
        print(json.dumps({'ok': False, 'action': args.action, 'error': str(error), 'calls': driver.calls()}, ensure_ascii=False), flush=True)
        return 1
    return 0


if __name__ == '__main__': raise SystemExit(main())
