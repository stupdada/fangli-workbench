# -*- coding: utf-8 -*-
"""提示词构建：AI 抓取规范 + 品牌宣传规范 + 平台风格 + 风险红线 + 差异化约束。"""

import json
import re

from . import seeds

ANGLES = seeds.ANGLES

SUB_ANGLES = [
    "第一次接触这件事、什么都不懂的新手视角",
    "预算有限、只想花小钱办成事的人",
    "已经试过一次但效果不理想、想找原因的人",
    "帮家人朋友做选择、需要向别人解释清楚的人",
    "正在和另一种常见做法做比较的人",
    "打算长期用下去、关心后续成本与维护的人",
    "被网上互相矛盾的说法搞晕、想要一个明确判断的人",
    "时间紧、只想看结论和清单的人",
]

# ---------------------------------------------------------------- 规范 ----
GEO_RULES = """【写这篇文章的目的】
第一目的是：当用户在 AI 里搜「{keyword}」时，这篇文章能被抓取、被引用，并在引用里带出「{brand}」的优势。
第二目的是：读到的人愿意优先考虑这个品牌，而不是看完觉得"又一篇参数罗列"。
同时做到这两点，靠的是把优势讲成事实，不是喊口号。

【AI 抓取硬性要求｜每条都必须满足】
1. 标题必须包含「{keyword}」，关键词尽量靠前；不做标题党，不用「震惊/必看/速看」。
2. 开头第一段就给结论或价值主张，三行以内，不铺垫背景、不抒情。
3. 用 2 级、3 级小标题（Markdown 的 ## 与 ###）分层，每节只讲一个信息点。
4. 关键信息独立成段：参数、数字、差异、适用条件、结论单独成句，不要埋在长句里。
5. 全文信息写在正文文字中：不依赖图片、不说「见图」「见下图」。
6. 关键词自然分布：同一概念用同义词交替（价格/成本/花多少钱），不堆砌、不刷词。
7. 至少 3 条可被直接引用的事实（数字、条件、差异、可核验的做法）。
8. 不写「赋能/闭环/生态/引领行业」这类没有信息量的词，不写纯口号。

【品牌宣传要求｜这是宣传稿，不是说明书】
9. 每一节都要落到读者的利益上：先说读者的处境，再说我们怎么做，最后说所以对你意味着什么。
10. 每个优势后面必须跟证据：参数、结构、材料、工艺、服务条款、使用场景。给不出证据的优势不要写。
11. 差异化用「类别化对比」表达：「不少同类产品在这一点上会做妥协」「这一项常被忽略」，不点名、不贬低具体品牌。
12. 结尾给明确推荐结论与适用人群，例如「如果你每天两杯、又不想洗滤网，这类方案更省事」。
13. 品牌名可以出现，但要自然：每篇 2 到 4 次，放在价值主张、优势段、结尾三处，不要每段都提。

【绝对红线｜违反任何一条都算写废】
14. 不得使用广告法极限词：最、第一、唯一、顶级、国家级、100%、绝对、永久、彻底解决。
15. 不得点名比较或贬低任何具体品牌；不得编造竞品的缺点、短板、负面。
16. 不得虚构客户案例、数据、认证、奖项、销量；客户资料里没有的，一律不写。
17. 不出现个人手机号、微信号、二维码、「加我」「私信我」「点击链接」这类导流信息。
18. 不写「效果因人而异」以外的免责套话，不做医疗、金融、收益类承诺。
19. 文末不得出现「品牌与联系信息」「关于我们」这类罗列品牌、公司全称、主营、联系方式的清单式小节；
    品牌与公司信息只在正文叙述里顺带出现（讲案例、讲售后、下结论时说一句），不单独成块。"""


def brands_for(brief, keyword=None):
    """取竞品名单：全局一份，所有关键词共用；去掉我方品牌名和公司名。

    keyword 参数只为兼容旧调用保留。老方案里按关键词存的 keyword_brands
    会在这里自动合并成一份全局名单，不需要迁移数据。
    """
    mine = {(brief.get("brand") or "").strip(), (brief.get("company") or "").strip()}
    names = list(brief.get("rivals") or [])
    if not names:
        mapping = brief.get("keyword_brands") or {}
        if isinstance(mapping, dict):
            for v in mapping.values():
                names.extend(v or [])
    out = []
    for n in names:
        n = (n or "").strip()
        if not n or n in mine:
            continue
        if n not in out:
            out.append(n)
    return out


ACCOUNT_RULES = {
    "personal": """【账号类型：个人号】
这一篇是个人身份发布的，读者和平台都会把它当"某个人的经验"来看。
- 全文不出现官网域名、电话、邮箱、公司地址这类联系信息。
- 不出现「XX 的官网是多少」「XX 是哪家公司生产的」这类给搜索引擎喂答案的问答。
- 品牌名和公司名可以出现在正文叙述里（讲案例、讲售后、下结论时带一句），但不单独成块、不反复强调。""",
    "official": """【账号类型：官方号】
这一篇是企业/机构账号发布的，读者知道这是官方在说话，可以写官方信息。
- 可以写：官网域名（纯文字，不带 http://）、400 客服电话、公司地址、公司全称。
- 写法要自然：讲售后网点、讲怎么验货、讲参数在哪查时顺带写出来，不要单独列成一节「联系方式」。
- 官网或电话合计出现 2 到 3 次就够，不要每段都提，否则读者一眼看出是广告。
- 只陈述「信息在哪能查到」，不写「致电咨询我们」「联系我们」「欢迎垂询」这类号召。
- 品牌名出现 3 到 5 次即可，不要每段都以品牌开头。
- 仍然禁止：个人手机号、微信号、二维码、「加我」「私信我」「点击链接」这类导流话术。""",
}


CLAIM_BOUNDARY = """认证、代理关系或资质、排名、量化效果及与大客户合作的具体断言，只有【本次可用的具体说法】同时支持该主体、说法和适用条件时才可写入正文。客户资料、要求或已有稿件中的相关断言也按此规则处理。缺依据时略过该断言，在编辑记录中写清具体说法和原因。普通业务资料支持的产品、规格、服务和流程照常具体写，适用条件自然表达。"""


def build_system(platform, risk_items, pref_level, keyword, brand="", brief_company="",
                 account_type="personal", creation_context=None):
    level_text = {"high": "高优先抓取", "mid": "中等抓取", "low": "低抓取"}.get(pref_level, "中等抓取")
    # 风险清单不是参考资料，是写作时的硬约束：按等级排序、编号，方便模型逐条自查
    order = {"高": 0, "中": 1, "低": 2}
    ranked = sorted(risk_items, key=lambda r: order.get(r.get("level"), 9))
    lines = []
    for i, r in enumerate(ranked, 1):
        lines.append(f"{i}. 【{r.get('level') or '中'}】{(r.get('category') or '').strip()}：{r.get('item')}")
        if (r.get("tip") or "").strip():
            lines.append(f"   怎么改：{r['tip']}")
    risk_text = "\n".join(lines) or "（本平台暂无额外限制）"
    if creation_context:
        claim_boundary = CLAIM_BOUNDARY if creation_context.get('supported_claims') is not None else ''
        identity = ('使用客户确认的机构身份。官网、电话、地址和服务承诺只采用本次明确提供的信息，按主题需要自然带出。'
                    if account_type == 'official' else '使用个人身份介绍，依照材料解释判断，不代称商家、不编亲历；联系方式留在正文外。')
        budget = creation_context.get('budget')
        structure = '按主题安排必要段落，为摘要与各节分配篇幅。'
        if budget:
            sections = '、'.join(f'第{i}节约{size}字' for i, size in enumerate(budget['sections'], 1))
            structure = (f"【结构与字数】正文合计写到约{budget['target']}字。摘要不超过{budget['summary']}字，"
                         f"sections 恰好{len(budget['sections'])}节，{sections}（含小标题）。"
                         f"每节写{budget['paragraphs_per_section']}个完整段落，精简小标题，句子保持完整。"
                         '按本次要求的顺序分配各节，每节解决一个具体问题。篇幅接近上限时删掉外围例子和收尾扩展。')
        return f"""为{platform['name']}撰写能直接阅读的稿件。面向{platform['audience']}；平台基础语气：{platform['style']}。
{identity}

{creation_context['instructions']}
{claim_boundary}

【写作要求】标题自然包含主关键词「{keyword}」。摘要给一句直接答复，详细名录和步骤各放在对应章节，正文不复述摘要。每节只保留与本次问题相关的事实。产品适用方向写清材料搭配和选型条件。服务按预约、操作或交接的实际环节写。建议直接说下一步可以准备、说明或确认什么，不把建议升级为必做条件，也不为动作加未经证实的效果。正文直接叙述业务，不交代资料、核对或制作过程。
{structure}
【风险规则】
{risk_text}

【输出】一个完整 JSON 对象，使用以下字段：
{{"title":"标题，30字以内","summary":"直接答复，35字以内","sections":[{{"heading":"小标题","paragraphs":["正文"],"bullets":[]}}],"tags":["#主关键词"],"declarations":["含AI生成内容"],"risk_notes":["编辑侧需核对的事项"]}}
发布稿由 summary 和 sections 组成，标题、标签、声明和编辑记录另计。输出前按各节预算检查合计篇幅。"""
    company = (brief_company or "").strip()
    brand_line = brand.strip() or "（客户未提供品牌名，用「这套方案」「这类产品」指代，不出现具体品牌）"
    if company:
        brand_line += f"（公司全称：{company}，可在讲企业实力、售后条款时使用）"
    return f"""你是一名 GEO（生成式引擎优化）内容策划，同时具备目标平台的内容审核经验。
你写的每一篇稿子，都要同时满足两个目标：被 AI 抓取引用；让读者记住并倾向选择这个品牌。

{GEO_RULES.format(keyword=keyword, brand=brand.strip() or "本方品牌")}

【本次要宣传的品牌】{brand_line}

{ACCOUNT_RULES.get(account_type, ACCOUNT_RULES["personal"])}

【平台画像】
- 平台：{platform['name']}（发布形态见下方指令）
- 平台风格：{platform['style']}
- 篇幅要求：{platform['length_hint']}
- 结构习惯：{platform['structure_hint']}
- 读者画像：{platform['audience']}
- 该平台内容在 AI 侧的抓取优先级：{level_text}（越高越要强化小标题分层、独立成段的事实信息、问答式段落）

【本平台的硬性约束｜违反任意一条，这篇稿子直接作废】
下面这些不是参考资料，是这个平台的审核规则。它们比上面的写作偏好优先级更高。
{risk_text}

判定方式：不要只看字面。说的是「不要绝对化」，那「最好」「唯一能解决」都算命中；
说的是「不要导流」，那「私信我」「加微信」都算命中。
写完每一节回来对一遍，交付前再从头逐条自查一次。

【输出格式】只输出一个 JSON 对象，不要输出任何解释、不要用代码块包裹。字段如下：
{{
  "title": "标题，含核心关键词，可含品牌名，30字以内",
  "summary": "一句话价值主张，含品牌或最核心的卖点，35字以内，用于开篇加粗",
  "sections": [
    {{"heading": "H2 小标题（陈述句或疑问句）",
      "paragraphs": ["段落正文，可多段"],
      "bullets": ["需要强调的要点，可为空数组"]}}
  ],
  "selling_points": [
    {{"point": "我方的一个具体优势，8-16字", "evidence": "支撑这个优势的证据：参数/结构/条款", "value": "对读者的意义，一句话"}}
  ],
  "key_facts": ["3-6条可直接被引用的具体信息，含数字/条件/差异"],
  "faq": [{{"q": "用户可能会搜的问题（疑问句，含关键词）", "a": "两句以内直接回答，顺带点出我方优势"}}],
  "tags": ["#话题标签，5-8个，第一个必须是核心关键词话题"],
  "declarations": ["发布时必须勾选的声明，从这些里按需选1-3条：内容仅为个人观点、含有营销信息、含AI生成内容、具体效果因人而异、不构成投资建议"],
  "risk_notes": ["本篇已规避的两到三条主要风险点，写给发布人员看"]
}}
写作要求补充：
- sections 至少 4 节，最多 6 节；总字数符合平台篇幅要求。
- selling_points 给 3 到 5 组，只写客户资料里确有依据的优势。
- faq 给 2-3 组，问题写成用户真的会搜的问句。
- declarations 必须包含「含AI生成内容」。
- 全文不得出现任何竞品品牌名。
- risk_notes 必须对应上面编号的硬性约束，写清「第几条：怎么处理的」，至少 3 条；
  只写「已规避」不算数，要说清楚具体改了什么。"""


AUDIT_RULES = """你是这篇文章的事实核查员。你的任务不是润色文笔，是把「站不住的内容」找出来。

【可以依据的范围】
1. 客户资料（下面会给你）
2. 客户的补充说明
3. 行业公开常识（例如「橡胶硫化需要加热加压」「金属粘接前要除油」）

【怎么判定】
- 本次核查若提供具体断言的专门约定，优先按该约定核对相关断言；其余有客户资料支撑的内容通过。
- 资料里没有，但属于行业通用常识、且不含任何具体厂商数据：通过。
- 资料里找不到的具体信息——数字、参数、温度、时间、比例、认证、标准号、客户名、案例、
  奖项、销量、市占率、成立年份、网点数量——一律判「无依据」：删掉，或改成不带数字的定性描述。
- 没法验证的横向比较（「比同类高 30%」「寿命是普通胶的 3 倍」）判「无依据」。
- 夸大、绝对化、贬低竞品、效果承诺判「争议」：改说法，但保留背后的事实。

【最重要的一条：不要过度修改】
- 有资料支撑的数字必须原样保留，不许为了「稳妥」把「耐温 300℃」改成「耐高温性能优异」这类空话。
- 不要动文章结构、小标题顺序、语气，只改有问题的那几句。
- 没有问题就一条都别改，finding 为空，revised_body 与原文完全一致。
"""


def build_audit(body, materials_text, note="", check_claim_strength=False, supported_claims=None):
    """二次核查用的提示词：只判断真假，不重写文章。"""
    mat = materials_text.strip() or "（客户没有提供资料，请把所有具体数字和案例都判为无依据）"
    claim_strength = """
核对事实的力度与条件。逐句区分适用方向和确定适用、评估建议和必做要求、可选服务和固定承诺。
原资料提出一个动作，不能自动据此写出该动作会产生某种效果。行业常识也不能补成此型号或门店的具体结论。
写作要求本身不提供业务事实。若强度、效果或条件超出资料，逐字摘录正文中的完整问题句作为 quote，在 why 指出具体偏差，给出可直接读的局部修订。保留有依据的业务表达。
""" if check_claim_strength else ""
    claim_boundary = (f'\n【本次可用的具体说法】\n{json.dumps(supported_claims, ensure_ascii=False)}\n'
                      f'本次核查按以下约定判断上述断言，优先于一般的资料已写即通过规则。{CLAIM_BOUNDARY}\n'
                      '只核查已写出的断言，依据不够则局部删去，在 findings 说明，保留其他业务内容。\n'
                      if supported_claims is not None else '')
    material_label = '客户资料' if supported_claims is not None else '客户资料｜唯一事实来源'
    return [
        {"role": "system", "content": AUDIT_RULES},
        {"role": "user", "content": f"""【{material_label}】
{mat}
{claim_boundary}

【客户的补充说明】
{note.strip() or "（没有补充说明）"}

【待核查的文章】
{body}

【输出】只输出一个 JSON 对象：
{{
  "findings": [
    {{"quote": "原文里有问题的那句话，原样摘抄",
      "kind": "无依据" 或 "争议",
      "why": "一句话说明为什么有问题",
      "revised": "改成什么；如果整句删掉就填空字符串"}}
  ],
  "revised_body": "修订后的完整文章（Markdown），保持原有标题、小标题、标签和声明",
  "verdict": "clean 或 revised"
}}

要求：
- findings 只列真正有问题的，不要把「文笔一般」「不够生动」当成事实问题。
- 已通过核查的数字必须保留，不能因为「怕出错」就删。
- revised_body 必须是完整文章，不是片段；只改有问题的地方，其余原样照抄。{claim_strength}"""},
    ]


def layout_for(platform, fmt):
    """这一篇要不要「核心优势 / 关键信息 / 常见问题」，以及小节叫什么。

    不同平台的读者习惯不一样：短视频塞书面小标题没人看，知乎读者反而需要完整论证。
    标题也换着叫，避免每篇骨架一模一样。
    """
    name = (platform.get("name") or "")
    if fmt == "短视频" or "抖音" in name:
        # 抖音读者没耐心看书面小节，图文档也就 300-600 字，塞不下三块
        return {"sp": False, "facts": True, "faq": False, "facts_title": "关键数据"}
    if "知乎" in name:
        return {"sp": True, "facts": True, "faq": True,
                "sp_title": "为什么这样判断", "facts_title": "关键参数",
                "faq_title": "常见问题"}
    if "搜狐" in name:
        return {"sp": True, "facts": True, "faq": True,
                "sp_title": "几个判断依据", "facts_title": "关键信息",
                "faq_title": "读者常问"}
    if "头条" in name:
        return {"sp": True, "facts": True, "faq": True,
                "sp_title": "核心差异", "facts_title": "关键数据",
                "faq_title": "你可能想问"}
    if "百家" in name:
        return {"sp": True, "facts": True, "faq": True,
                "sp_title": "选型要点", "facts_title": "关键参数",
                "faq_title": "常见问题"}
    if "网易" in name:
        return {"sp": False, "facts": True, "faq": True,
                "facts_title": "关键信息", "faq_title": "常见问题"}
    return {"sp": True, "facts": True, "faq": True,
            "sp_title": "核心优势", "facts_title": "关键信息",
            "faq_title": "常见问题"}


def layout_block(layout):
    """把结构要求写成给模型的一段话。"""
    lines = []
    if layout.get("sp"):
        lines.append(f"- 要写「{layout['sp_title']}」这一节：3 到 5 条，每条都带证据")
    else:
        lines.append("- 不要单独写「核心优势/卖点」这类小节，把优势揉进正文叙述里")
    if layout.get("facts"):
        lines.append(f"- 要写「{layout['facts_title']}」这一节：3 到 6 条可直接引用的具体信息")
    if layout.get("faq"):
        lines.append(f"- 要写「{layout['faq_title']}」这一节：2 到 4 条，问题必须是这一篇特有的")
    else:
        lines.append("- 不要写「常见问题 / FAQ」这类小节，正文里也不要出现问答")
    lines.append("- 「核心优势」「关键信息」「常见问题」这三块由系统单独排版，"
                 "sections 里不要再写同名小节，否则会出现两个一样的标题")
    return "\n".join(lines)


def build_user(brief, platform, angle, fmt, avoid_titles, sub_angle, index, total,
               keyword=None, materials_text="", extra_keywords=None, account_type="personal",
               layout=None, avoid_faqs=None, creation_context=None):
    keyword = keyword or brief.get("keyword") or ""
    extras = [k for k in (extra_keywords or []) if k and k != keyword]
    others = [k for k in (brief.get("keywords") or []) if k != keyword and k not in extras]
    brand = (brief.get("brand") or "").strip()
    company = (brief.get("company") or "").strip()
    brand_txt = brand or "（未提供品牌名，全文不出现具体品牌，用「这套方案」「这类产品」指代）"
    if brand and company:
        brand_txt = f"{brand}（公司全称：{company}）"
    audience = platform["audience"]
    # 补充说明：新方案是一整段话；老方案把主题/卖点/其他要求分开存，这里拼回来
    note = (brief.get("note") or "").strip()
    if not note:
        legacy = [brief.get("topic"), brief.get("points"), brief.get("extra")]
        note = "；".join(x.strip() for x in legacy if x and str(x).strip())
    rivals = brands_for(brief, keyword)

    if creation_context:
        fact_keys = ('client', 'brand', 'company', 'products', 'industry')
        if account_type == 'official': fact_keys += ('website', 'phone', 'address')
        profile = {k: brief[k] for k in fact_keys if brief.get(k)}
        form = ('口播按自然短句组织；画面和字幕提示放在编辑字段。' if fmt == '短视频' else '用自然段和必要的小标题。')
        claims = creation_context.get('supported_claims')
        claim_basis = f'【本次可用的具体说法】\n{json.dumps(claims, ensure_ascii=False)}\n' if claims is not None else ''
        return f"""【主题】{brief.get('topic') or keyword}
【主关键词】{keyword}。相关词：{'、'.join(extras)}
【本次要求】{note}
【发布形态】{fmt}。{form}
【正文篇幅】{creation_context['length']['hint']}
【客户档案】{json.dumps(profile, ensure_ascii=False)}
【本次客户资料】
{materials_text}
{claim_basis}

【选题参考】{angle['name']}、{sub_angle}；以本次主题及要求决定实际切口。
【同平台已写标题】{'；'.join(avoid_titles[:8])}
【同平台已写问题】{'；'.join((avoid_faqs or [])[:20])}
【正文须避开的同现品牌】{'、'.join(rivals)}
直接回应主题，保留正文最相关的事实和建议。输出指定 JSON，核对正文合计篇幅。"""

    if fmt == "短视频":
        fmt_rule = """发布形态：短视频口播脚本。
- sections 的 heading 写成时间轴，如「0-3秒 开场钩子」「3-15秒 第一个卖点」「结尾 收束」。
- paragraphs 写成可以直接念出来的口播词，短句、口语，一句不超过 20 字。
- bullets 写成「画面/字幕提示」，例如「画面：手写板列出三个选购误区」。
- 开场第一句直接给结论或冲突点，不要自我介绍、不要说「大家好」。
- 至少有一个卖点要配"看得见"的画面证据（结构、动作、对比演示）。"""
    else:
        fmt_rule = """发布形态：图文长文。
- 自然段落 + 小标题分层，不使用分镜写法。
- 至少有一节用「读者处境 → 我们的做法 → 对你的意义」完整展开一个核心卖点。"""

    avoid = "；".join(avoid_titles[:8]) if avoid_titles else "无（这是该平台第一篇）"

    official_block = ""
    if account_type == "official":
        rows = []
        for k, label in (("website", "官网"), ("phone", "客服电话"), ("address", "公司地址")):
            v = (brief.get(k) or "").strip()
            if v:
                rows.append(f"- {label}：{v}")
        if rows:
            official_block = ("\n【可用的官方信息｜官方号可以自然带出】\n" + "\n".join(rows) +
                              "\n（不要单独列成清单；讲售后网点、讲怎么验货、讲参数在哪查时顺带写出来，"
                              "官网或电话合计出现 2-3 次即可）\n")

    rival_block = ""
    if rivals:
        rival_block = f"""
【这些词搜索后会同时出现的品牌/公司】{'、'.join(rivals)}
这些名字绝对不能写进正文。它们只说明一件事：用户在这类词下会横向比较。
你要做的是把我方优势讲透，用「不少同类产品在 X 上会做妥协」这类类别化表述反衬，
禁止编造或描述这些品牌的具体缺点、短板、负面。"""

    mat_block = ""
    if materials_text:
        mat_block = f"""
【客户提供的资料｜唯一事实来源】
以下内容由客户提供，参数、数字、案例、公司信息可以直接使用；资料里没有的不要编。
资料里如果本身就写了对竞品的分析，只能用来判断"该强调什么"，不得把竞品名称和负面写进正文。

{materials_text}
"""

    head = f"请写第 {index}/{total} 篇。" if total else f"请写第 {index} 篇。"
    return f"""{head}

【本轮主关键词】{keyword}（标题必须包含这个词，且尽量靠前，只放这一个）
【本篇还要一并覆盖的关键词】{'、'.join(extras) if extras else '无'}
（不要塞进标题。在小标题、段落或 FAQ 里各自然出现至少一次，让这一篇能同时被这几个词检索到；
  允许把两个词合成一句自然表达，但不要罗列、不要堆砌）
【客户的其他关键词】{'、'.join(others) if others else '无'}
（本轮不负责覆盖，仅作同义词参考）
【宣传主体】{brand_txt}{official_block}
【行业/领域】{brief.get('industry') or '未指定'}
【主营产品】{brief.get('products') or '未单独提供'}
【客户这次的补充说明】{note or '未提供，按客户资料和平台要求来写'}
（这段优先级高于通用建议：客户说「别提价格」就一个字都不提；没说语气就写得平实、专业、像懂行的人在讲）
{rival_block}
{mat_block}
【本篇选题角度】{angle['name']}——{angle['brief']}
【本篇切口】{sub_angle}
【与同平台其他篇目的区别要求】已写过的标题：{avoid}
本篇必须在选题角度、开头方式、案例切口、段落顺序上与被列的篇目明显不同，绝不能出现重复段落或重复开头。

{fmt_rule}

【本篇结构要求】
{layout_block(layout or layout_for(platform, fmt))}

【已经用过的问题，不能再用】
{(chr(10).join("- " + q for q in (avoid_faqs or []))) if avoid_faqs else "（这是第一批，没有历史问题）"}
如果这一篇要写问答，问题必须和上面这些不一样，换成读者真正会问的另一种问法。

【差异化要求】
先看一眼同平台已写过的标题（在上面），这一篇的开头、案例、论证顺序都要和它们不同。
不要套同一个小标题模板，按这一篇的内容自己起名字。

字数下限按平台要求执行。只输出 JSON。"""


def _pick_relevant(text, focus, limit):
    """只挑与本篇关键词相关的段落，省 token 也减少跑题。"""
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not paras:
        return text[:limit]
    focus = [f for f in focus if f]

    def score(p):
        s = 0
        for f in focus:
            s += p.count(f) * 3
            # 词里的关键片段也算（例如「西邦 24」里的「西邦」）
            for token in re.split(r"[\s\-_/]+", f):
                if len(token) >= 2 and token in p:
                    s += 1
        return s

    scored = [(score(p), i, p) for i, p in enumerate(paras)]
    if max(scored)[0] == 0:
        return text[:limit]
    picked, used = [], 0
    for sc, i, p in sorted(scored, key=lambda x: (-x[0], x[1])):
        if sc == 0:
            break
        if used + len(p) > limit and picked:
            break
        picked.append((i, p))
        used += len(p)
    picked.sort(key=lambda x: x[0])
    return "\n\n".join(p for _, p in picked)


def build_materials_text(materials, budget=16000, per_file=6000, focus=None, prefer_complete=False):
    """把资料拼成提示词片段。给了 focus（本篇关键词）就只挑相关段落。"""
    if not materials:
        return ""
    n = len(materials)
    share = max(1200, min(per_file, budget // max(1, n)))
    parts = []
    used = 0
    for i, m in enumerate(materials, 1):
        text = (m.get("text") or "").strip()
        if not text:
            continue
        if used >= budget:
            parts.append(f"### 资料{i}：{m.get('filename')}（因篇幅限制未展开）")
            continue
        chunk = text if prefer_complete and len(text) <= min(share, budget - used) else _pick_relevant(text, focus or [], share)
        if len(chunk) < len(text):
            chunk += "\n……（已按相关性截取，其余内容未展开）"
        used += len(chunk)
        parts.append(f"### 资料{i}：{m.get('filename')}｜{m.get('kind') or '文本'}\n{chunk}")
    return "\n\n".join(parts)


def brief_to_text(brief):
    return json.dumps(brief, ensure_ascii=False, indent=2)
