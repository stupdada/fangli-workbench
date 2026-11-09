"""One frozen semantic input for article writing and downstream video authoring."""
import copy
import hashlib
import json
import re
from . import style_library
from .accepted_expressions import VIDEO_FORM, VIDEO_PLATFORM

SCHEMA = 'creation-context/v1'
ARTICLE_PROMPT_VERSION = 'first-generation/5'
PREFERENCE_LEVELS = ('low', 'mid', 'high')
PREFERENCE_INSTRUCTIONS = {
    'high': '优先用读者会搜索的具体问题组织相关小节，小标题后直接回答。关键事实独立成段，带齐主体、数字和条件。确有互补问题且篇幅允许时，可在正文小节内加入简短问答，已有答案不重复。',
    'mid': '沿用平台的基本段落结构。把核心结论、支撑事实和适用条件放在易于单独阅读的同一段，方便读者定位。',
    'low': '按适用平台写法自然组织篇章，按内容需要使用小标题和分段。问答按发布形态和主题需要安排。',
}
DOCUMENT_FIELDS = ('id', 'client_id', 'group_id', 'revision', 'filename', 'kind', 'text', 'digest', 'raw_sha256')


def digest(value):
    return hashlib.sha256(json.dumps({k: v for k, v in value.items() if k != 'digest'}, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()


def key(platform_id, account_type, fmt):
    return f'{platform_id}:{account_type}:{fmt}'


def fact_findings(version):
    return ((version.get('review') or {}).get('findings') or
            (version['article'].get('audit') or {}).get('findings') or [])


def supported_claims(documents, claims):
    selected = {(d['id'], d['revision'], d['digest']): d['text'] for d in documents}
    facts = []
    for claim in claims:
        check = claim.get('public_check') or {}
        if check.get('status') != 'supported':
            continue
        refs = claim.get('source_refs') or []
        if not refs or not all(ref['quote'] and ref['quote'] in selected.get(
                (ref['document_id'], ref['revision'], ref['digest']), '') for ref in refs):
            continue
        evidence = check.get('evidence') or {}
        fact = {'claim': claim['text'], **{field: evidence.get(field) for field in ('quote', 'subject', 'conditions')}}
        if all(isinstance(value, str) and value.strip() for value in fact.values()):
            facts.append(fact)
    return facts


def length_in(text):
    """Recognize explicit character budgets; leave other requirements verbatim."""
    text = text or ''
    pattern = (r'(?:全文|正文|篇幅|字数|口播)?\s*(?:控制在\s*)?'
               r'(?:不得超过|不超过|不低于|最多|至少|大约|约)?\s*'
               r'(?<!\d)\d{1,5}\s*(?:[—–\-~～至到]\s*\d{1,5}\s*)?字(?:左右|以内|以上|以下)?')
    matches = list(re.finditer(pattern, text))
    return matches[-1].group().strip() if matches else ''


def resolve_length(request, customer, platform, fmt=''):
    hint = platform.get('length_hint', '')
    clauses = re.split('[；;]', hint)
    if len(clauses) > 1 and fmt:
        hint = next((clause.strip() for clause in clauses if clause.strip().startswith(fmt)), hint)
    explicit = (request.get('length_hint') or '').strip() or length_in(request.get('note'))
    if explicit in ('短篇', '长篇'):
        numbers = [int(value) for value in re.findall(r'\d+', length_in(hint))]
        if len(numbers) == 2 and 0 < numbers[0] < numbers[1]:
            low, high = numbers
            middle = (low + high) // 2
            explicit = f'正文 {low}—{middle} 字' if explicit == '短篇' else f'正文 {middle + 1}—{high} 字'
        elif hint:
            explicit = f'{explicit}，遵循平台建议：{hint}'
    if explicit: return {'hint': explicit, 'source': 'request', 'metric': 'nonWhitespace'}
    preferred = (customer.get('length_hint') or '').strip() or length_in(customer.get('note'))
    if preferred: return {'hint': preferred, 'source': 'customer_preference', 'metric': 'nonWhitespace'}
    return {'hint': hint, 'source': 'platform_default', 'metric': 'nonWhitespace'}


def section_budget(length):
    if length['source'] != 'request':
        return None
    hint = length_in(length['hint'])
    numbers = [int(value) for value in re.findall(r'\d+', hint)]
    if len(numbers) == 2 and 0 < numbers[0] <= numbers[1]:
        low, high = numbers
        target = low + (high - low) * 35 // 100
    elif len(numbers) == 1 and numbers[0] > 0:
        lower, upper = length_bounds(hint)
        if lower is not None:
            return None
        target = max(1, upper * 85 // 100) if upper is not None else numbers[0]
    else:
        return None
    summary = min(32, max(1, target // 12), target - 1)
    count = 1 if target < 220 else 2 if target < 1000 else 3 if target < 1600 else 4
    size, extra = divmod(target - summary, count)
    return {'target': target, 'summary': summary, 'sections': [size + (index < extra) for index in range(count)],
            'paragraphs_per_section': 2 if size >= 240 else 1}


def length_bounds(text):
    hint = length_in(text)
    numbers = [int(value) for value in re.findall(r'\d+', hint)]
    if len(numbers) == 2 and 0 < numbers[0] <= numbers[1] and not re.search(r'约|左右', hint):
        return numbers[0], numbers[1]
    if len(numbers) == 1 and numbers[0] > 0:
        if re.search(r'不得超过|不超过|最多|以内|以下', hint):
            return None, numbers[0]
        if re.search(r'不低于|至少|以上', hint):
            return numbers[0], None
    return None, None


def platform_preference(platform_id, selected, models, prefs):
    target_ids = {model['name']: model['id'] for model in models if model['enabled']}
    cells = {pref['model_id']: pref['level'] for pref in prefs if pref['platform_id'] == platform_id}
    targets = [{'name': name, 'level': cells.get(target_ids[name], 'mid')}
               for name in dict.fromkeys(selected) if name in target_ids]
    level = max((target['level'] for target in targets), key=PREFERENCE_LEVELS.index, default='mid')
    return {'level': level, 'targets': targets}


def video_style(accepted, client_id):
    expressions = accepted.references(client_id, 'video', VIDEO_PLATFORM, VIDEO_FORM)
    if expressions:
        return {'platform': VIDEO_PLATFORM, 'form': VIDEO_FORM, 'expressions': expressions,
                'use': '仅在本次视频的发布平台和形式匹配时借鉴写法。例句不提供本次事实。'}
    return None


def video_projection(context):
    """Article-specific samples stay with the article snapshot, outside video authoring."""
    style = copy.deepcopy(context['style'])
    variants = list(style.get('variants', {}).values())
    if style.get('applied'):
        variants.append(style['applied'])
    for variant in variants:
        if 'expressions' in variant:
            variant['expressions'] = [entry for entry in variant['expressions'] if entry.get('medium') != 'article']
    editorial = context['editorial']
    claims = [{k: v for k, v in claim.items() if k not in ('claim_key', 'public_check', 'public_check_status')}
              for claim in editorial.get('important_claims', [])]
    projected = {**context, 'style': style,
                 'editorial': {**editorial, 'important_claims': claims} if 'important_claims' in editorial else editorial}
    projected['digest'] = digest(projected)
    return projected


def build(client, documents, request, platforms, customer_options=None, accepted=None, *, models=(), prefs=()):
    request = copy.deepcopy(request or {})
    customer = copy.deepcopy(customer_options or {})
    variants = {}
    selected = request.get('selections') or []
    bundle = style_library.load() if selected else None
    for platform in platforms:
        accounts = list(dict.fromkeys(s['account_type'] for s in selected if s['platform_id'] == platform['id'] and s['count']))
        if not accounts:
            continue
        preference = platform_preference(platform['id'], request.get('models', []), models, prefs)
        for account in accounts:
            formats = request.get('format_overrides', {}).get(str(platform['id'])) or platform['formats']
            for fmt in formats:
                variant = style_library.generation_references(bundle, {'platform_name': platform['name'], 'account_type': account, 'fmt': fmt}, client['id'])
                if accepted:
                    variant['expressions'] += accepted.references(client['id'], 'article', platform['id'], fmt)
                length = resolve_length(request, customer, platform, fmt)
                prompt_version = 'first-generation/3' if fmt == '短视频' else ARTICLE_PROMPT_VERSION
                variant.update(platform_id=platform['id'], platform_name=platform['name'], account_type=account, fmt=fmt,
                               length=length, budget=section_budget(length), prompt_version=prompt_version, layout='sections')
                if fmt != '短视频':
                    variant['retrieval_preference'] = preference
                variants[key(platform['id'], account, fmt)] = variant
    value = {'schema_version': SCHEMA, 'client': copy.deepcopy(client),
             'documents': [{k: copy.deepcopy(d[k]) for k in DOCUMENT_FIELDS if k in d} for d in documents],
             'request': {k: request[k] for k in ('topic', 'keywords', 'keyword_links', 'note', 'length_hint', 'selections', 'format_overrides', 'models') if k in request},
             'style': {'variants': variants, 'customer_preference': {k: customer[k] for k in ('note', 'length_hint') if k in customer}},
             'source_article': None, 'editorial': {'conflicts': [], 'important_claims': [], 'fact_issues': []}}
    if accepted and (video := video_style(accepted, client['id'])):
        value['style']['video'] = video
    value['digest'] = digest(value)
    return value


def for_article(context, platform, account, fmt):
    variant = copy.deepcopy(context.get('style', {}).get('variants', {}).get(key(platform['id'], account, fmt), {}))
    if not variant: return None
    article_structure = variant.get('prompt_version') in ('first-generation/4', ARTICLE_PROMPT_VERSION)
    preference = variant.get('retrieval_preference')
    section_titles = ('小标题按内容自然命名。表格和问答计入本次篇幅。\n'
                      if preference else
                      '读者会跳着找答案的地方，用他实际会问的具体问题做小标题，紧接着直接回答。其余小节按内容自然命名。\n')
    organization = (
        '【正文组织】读者需要跟着做或逐项核对时，在相关小节的 bullets 中按顺序列出有资料依据的动作，每项写清做什么。'
        '清单承担步骤说明，段落用来解释适用条件、操作判断或记录用途。对比表和 FAQ 只用于补充读者还需要的信息。\n'
        f'{section_titles}'
        '关键段落单独阅读时也要说清对象、结论和适用条件。写规格或时间时，把产品型号、数值与限定词放在一起。\n'
    ) if article_structure else ''
    preference_rules = ''
    if preference:
        level = preference['level']
        label = {'high': '高', 'mid': '中', 'low': '低'}[level]
        preference_rules = (f'【目标 AI 抓取偏好】{label}档。{PREFERENCE_INSTRUCTIONS[level]}\n'
                            '本次要求里出现其他篇幅描述时，以【有效篇幅】为准。\n'
                            '压缩篇幅时先删重复、铺垫和外围例子。保留型号、数字、适用条件和承诺范围。\n')
    # Source hashes and editorial records stay in the snapshot.
    rules = [{k: p[k] for k in ('id', 'intent', 'voice', 'entry_options', 'organization') if k in p} for p in variant.get('profiles', [])]
    expressions = [{k: e[k] for k in ('id', 'lesson', 'applicationNote', 'sample', 'sample_truncated') if k in e}
                   for e in variant.get('expressions', [])]
    instructions = ('【本次有效创作约定】\n'
        '开头直接回应主题，按读者需要具体介绍产品、服务、步骤和建议；适用条件放进相应叙述。\n'
        '普通业务资料与已确认档案作为本次事实依据；行业通用建议按建议表达。资料中的创作要求用于安排内容。\n'
        '来源处理、资料缺项、待核对问题和审核记录写在risk_notes等编辑字段。因资料冲突或依据不足舍弃具体说法时，在risk_notes记下原说法和原因。交付正文保持正常业务表达。\n'
        '写法优先级：本次明确要求、客户偏好、适用平台规则。篇幅采用下列已选定目标；结构围绕主题展开，每节提供新信息。\n'
        '风格与认可表达只借鉴写法，例句中的公司、产品、经历和数据不属于本次事实。\n'
        f'{organization}'
        f'{preference_rules}'
        f"【有效篇幅】{variant['length']['hint']}（计数为交付正文的非空白字符，含小标题，不含标签、声明和编辑记录）\n"
        '【适用平台写法】' + json.dumps(rules, ensure_ascii=False) + '\n'
        '【认可表达的写法要点】' + json.dumps(expressions, ensure_ascii=False))
    return {'length': variant['length'], 'instructions': instructions, 'budget': variant.get('budget'),
            'article_structure': article_structure,
            'supported_claims': context.get('editorial', {}).get('supported_claims')}
