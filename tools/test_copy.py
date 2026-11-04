# -*- coding: utf-8 -*-
"""文案层测试：宣传写法、竞品规避、品牌露出、卖点结构。

这组测试不调用模型，直接验证提示词与自检逻辑是否符合「宣传型 GEO」的要求。

用法：python tools/test_copy.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import prompts, render  # noqa: E402

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append((name, detail))
    print(("  [通过] " if ok else "  [失败] ") + name + (("  -> " + detail) if detail and not ok else ""))


def get_check(geo, name):
    return next((c for c in geo["checks"] if c["name"] == name), None)


PLATFORM = {"id": 1, "name": "知乎个人号", "style": "第一人称", "length_hint": "1200-2000 字",
            "structure_hint": "先判断后理由", "audience": "带问题来找答案的人",
            "formats": ["图文"]}

RISKS = [{"level": "高", "category": "广告法极限词", "item": "最、第一、唯一", "tip": "替换成条件化描述"}]

BRIEF = {
    "brand": "某某电器",
    "company": "某某电器有限公司",
    "keywords": ["小型咖啡机怎么选", "胶囊咖啡机好用吗"],
    "rivals": ["德龙", "飞利浦", "九阳", "雀巢多趣酷思", "小米", "某某电器", "某某电器有限公司"],
    "tone": "平实",
    "industry": "家电",
}


def body_with(title="小型咖啡机怎么选：先看三个变量", extra=""):
    return f"""# {title}

**某某电器的小型咖啡机支持胶囊与咖啡粉双模式，同价位里少见的配置。**

## 小型咖啡机怎么选的三个关键变量

判断这件事，看使用频率、可用空间和后续维护成本。

- 每周用 5 次以上，优先看耐用度与清洁成本
- 预算 1000-3000 元，可选范围最集中

## 为什么双模式更省事

不少同类产品在这一点上会做妥协，只能二选一。某某电器 X1 两者都支持，换胶囊不用换机器。

## 关键信息速览

- 水箱 1.2L
- 整机 4.5kg
- 质保两年

## 适合谁

如果你每天两杯又不想洗滤网，这类方案更省事。{extra}

#小型咖啡机怎么选 #选购指南 #避坑 #使用体验 #新手入门

声明：内容仅为个人观点；含AI生成内容"""


print("\n[1] 系统提示词包含宣传要求")
sys_prompt = prompts.build_system(PLATFORM, RISKS, "high", "小型咖啡机怎么选", "某某电器")
check("写明第一目的是被 AI 抓取引用", "被抓取、被引用" in sys_prompt)
check("写明第二目的是让人愿意优先考虑", "愿意优先考虑" in sys_prompt)
check("要求优势必须跟证据", "每个优势后面必须跟证据" in sys_prompt)
check("要求类别化对比而非点名", "类别化对比" in sys_prompt)
check("禁止编造竞品缺点", "不得编造竞品的缺点" in sys_prompt)
check("禁止点名比较具体品牌", "不得点名比较或贬低任何具体品牌" in sys_prompt)
check("要求品牌名出现 2 到 4 次", "2 到 4 次" in sys_prompt or "2 到 4" in sys_prompt)
check("带上要宣传的品牌名", "某某电器" in sys_prompt)
check("输出结构含 selling_points", "selling_points" in sys_prompt)
check("selling_points 要求三要素", all(k in sys_prompt for k in ("point", "evidence", "value")))

print("\n[2] 单篇提示词带上该词的竞品名单")
user = prompts.build_user(BRIEF, PLATFORM, prompts.ANGLES[0], "图文", [], "新手视角", 1, 2,
                          keyword="小型咖啡机怎么选", materials_text="### 资料1\nX1 支持胶囊与咖啡粉。")
check("列出全局品牌名单", all(n in user for n in ("德龙", "飞利浦", "九阳", "雀巢", "小米")))
check("明确禁止写进正文", "绝对不能写进正文" in user)
check("禁止编造这些品牌缺点", "禁止编造或描述这些品牌的具体缺点" in user)
check("第一段就写明这些名字不得进正文", "绝对不能写进正文" in user)
check("带上了客户资料", "X1 支持胶囊与咖啡粉" in user)
check("带上我方品牌", "某某电器" in user)

user2 = prompts.build_user(BRIEF, PLATFORM, prompts.ANGLES[0], "图文", [], "新手视角", 1, 2,
                           keyword="胶囊咖啡机好用吗")
check("换一个关键词仍是同一份名单（全局共用）",
      all(n in user2 for n in ("德龙", "雀巢")), user2[:0])
check("换词后标题关键词也跟着换", "胶囊咖啡机好用吗" in user2 and "小型咖啡机怎么选" not in user2.split("【客户的其他关键词】")[0])

print("\n[2b] 摘要里的换行要压平（否则 Word 里会露出 ** ）")
md_nl = render.render_md({"title": "t", "summary": "第一行\n第二行",
                          "sections": [], "tags": [], "declarations": []},
                         "知乎个人号", "图文", "疑问型")
check("摘要只占一行", "**第一行 第二行**" in md_nl, md_nl[:60])
check("不再出现孤立星号行", "\n**\n" not in md_nl)

md_star = render.render_md({"title": "t", "summary": "**模型自己带了星号**",
                            "sections": [], "tags": [], "declarations": []},
                           "知乎个人号", "图文", "疑问型")
check("摘要自带星号只保留一层", "****" not in md_star, md_star[:50])
check("摘要内容没丢", "模型自己带了星号" in md_star)

print("\n[3] 竞品名单要排除我方品牌")
rivals = prompts.brands_for(BRIEF)
check("我方品牌不重复计入竞品", "某某电器" not in rivals, str(rivals))
check("其他品牌保留", set(rivals) == {"德龙", "飞利浦", "九阳", "雀巢多趣酷思", "小米"}, str(rivals))
check("任何关键词都返回同一份名单",
      prompts.brands_for(BRIEF, "不存在的词") == prompts.brands_for(BRIEF, "小型咖啡机怎么选"))
check("传不传 keyword 都一样", prompts.brands_for(BRIEF) == prompts.brands_for(BRIEF, "胶囊咖啡机好用吗"))
check("我方公司名也不计入竞品", "某某电器有限公司" not in rivals, str(rivals))
check("完全没有配置时不报错", prompts.brands_for({"brand": "A"}, "x") == [])

print("\n[3c] 老方案（按关键词存）自动合并成全局")
legacy = {"brand": "某某电器",
          "keyword_brands": {"词A": ["德龙", "飞利浦"], "词B": ["九阳", "德龙"], "词C": []}}
merged = prompts.brands_for(legacy)
check("多个词的名单合并去重", merged == ["德龙", "飞利浦", "九阳"], str(merged))
check("合并后各词一致", prompts.brands_for(legacy, "词B") == merged)

print("\n[3b] 公司全称进入提示词")
sys2 = prompts.build_system(PLATFORM, RISKS, "high", "小型咖啡机怎么选", "某某电器", "某某电器有限公司")
check("系统提示词带公司全称", "某某电器有限公司" in sys2)
user3 = prompts.build_user(BRIEF, PLATFORM, prompts.ANGLES[0], "图文", [], "新手视角", 1, 1,
                           keyword="小型咖啡机怎么选")
check("单篇提示词带公司全称", "某某电器有限公司" in user3)

print("\n[4] 自检能拦住竞品名")
geo = render.geo_check({"title": "小型咖啡机怎么选", "body_md": body_with(), "tags": ["#a"] * 5,
                        "decl": ["含AI生成内容"]}, "小型咖啡机怎么选", "某某电器", rivals)
c = get_check(geo, "未出现竞品名")
check("干净正文判定通过", c and c["ok"], c["hint"] if c else "缺检查项")

geo2 = render.geo_check({"title": "小型咖啡机怎么选",
                         "body_md": body_with(extra="\n德龙的同价位机型只有单模式。"), "tags": ["#a"] * 5,
                         "decl": ["含AI生成内容"]}, "小型咖啡机怎么选", "某某电器", rivals)
c = get_check(geo2, "未出现竞品名")
check("出现竞品名判定失败", c and not c["ok"])
check("提示里点名了是哪个品牌", c and "德龙" in c["hint"], c["hint"] if c else "")
check("失败后分数下降", geo2["score"] < geo["score"], f"{geo2['score']} vs {geo['score']}")

print("\n[5] 自检要求品牌露出")
geo3 = render.geo_check({"title": "小型咖啡机怎么选",
                         "body_md": body_with().replace("某某电器", "这类产品"), "tags": ["#a"] * 5,
                         "decl": ["含AI生成内容"]}, "小型咖啡机怎么选", "某某电器", rivals)
c = get_check(geo3, "品牌露出适度")
check("没提品牌判定失败", c and not c["ok"])
check("提示说明宣传效果为零", c and "宣传效果为零" in c["hint"], c["hint"] if c else "")

geo4 = render.geo_check({"title": "小型咖啡机怎么选",
                         "body_md": body_with().replace("某某电器", "某某电器某某电器某某电器某某电器某某电器某某电器某某电器"),
                         "tags": ["#a"] * 5, "decl": ["含AI生成内容"]},
                        "小型咖啡机怎么选", "某某电器", rivals)
c = get_check(geo4, "品牌露出适度")
check("品牌刷屏判定失败（太像硬广）", c and not c["ok"])

check("未填品牌时不检查品牌露出", get_check(
    render.geo_check({"title": "小型咖啡机怎么选", "body_md": body_with(), "tags": ["#a"] * 5,
                      "decl": ["含AI生成内容"]}, "小型咖啡机怎么选", "", rivals), "品牌露出适度") is None)

print("\n[6] 卖点结构渲染成可抓取的小节")
md = render.render_md({
    "title": "小型咖啡机怎么选",
    "summary": "双模式是这一价位少见的配置。",
    "sections": [{"heading": "判断标准", "paragraphs": ["看三项。"], "bullets": []}],
    "selling_points": [{"point": "双模式", "evidence": "支持胶囊与咖啡粉", "value": "不用为两种口味买两台机器"}],
    "key_facts": ["水箱 1.2L"],
    "tags": ["#小型咖啡机怎么选"],
    "declarations": ["含AI生成内容"],
}, "知乎个人号", "图文", "疑问型")
check("生成核心优势小节", "## 核心优势" in md)
check("卖点+证据+意义连成一句", "**双模式**：支持胶囊与咖啡粉。不用为两种口味买两台机器" in md)
check("卖点排在关键信息之前", md.index("## 核心优势") < md.index("## 关键信息速览"))

print("\n[7] 老稿件（无 selling_points）不报错")
md2 = render.render_md({"title": "t", "sections": [{"heading": "h", "paragraphs": ["p"], "bullets": []}],
                        "tags": [], "declarations": []}, "知乎个人号", "图文", "疑问型")
check("没有卖点时不出现空小节", "## 核心优势" not in md2)

print("\n[8] 新稿件不再生成硬广式信息块")
FB = {"brand": "西邦", "company": "某某新材料有限公司", "products": "工业结构胶",
      "website": "cilbond.cn"}
md = render.render_md({
    "title": "西邦 24 怎么选", "summary": "看三点。",
    "sections": [{"heading": "判断标准", "paragraphs": ["看三项。"], "bullets": []}],
    "key_facts": ["固化 24 小时"],
    "faq": [{"q": "西邦 24 适合什么场景？", "a": "需要承受振动的金属橡胶件。"}],
    "tags": ["#西邦24"], "declarations": ["含AI生成内容"],
}, "知乎个人号", "图文", "疑问型")
check("没有「品牌与联系信息」小节", "品牌与联系信息" not in md)
check("没有品牌/公司/主营的条目罗列", "- 品牌：" not in md and "- 公司全称：" not in md)
check("没有官网域名", "cilbond.cn" not in md)
check("正常的品牌问答保留", "西邦 24 适合什么场景" in md)
check("render_md 不再接受 brand_block 参数",
      "brand_block" not in render.render_md.__code__.co_varnames)
check("模块里已没有拼装函数",
      not hasattr(render, "build_brand_block") and not hasattr(render, "ensure_contact_faq"))

print("\n[9] 旧稿清理：去掉信息块与导流问答")
legacy = """# 西邦 24 怎么选

正文第一段，讲清楚判断标准。

## 常见问题

### 西邦 24 适合什么场景？

需要承受振动的金属橡胶件。

### 西邦cilbond是哪家公司生产的？

西邦cilbond由某某新材料有限公司研发生产。

### 西邦cilbond的官网是多少？

官方网站是 sanyang-adhesive.com。

## 品牌与联系信息

- 品牌：西邦cilbond
- 公司全称：某某新材料有限公司
- 主营产品：橡胶、聚氨酯
- 官方网站：sanyang-adhesive.com

#西邦24

声明：含AI生成内容
"""
clean = render.strip_ad_block(legacy)
check("信息块已删除", "品牌与联系信息" not in clean)
check("公司罗列条目已删除", "- 公司全称：" not in clean)
check("「哪家公司生产的」问答已删除", "哪家公司生产" not in clean)
check("「官网是多少」问答已删除", "官网是多少" not in clean)
check("域名彻底消失", "sanyang-adhesive.com" not in clean, clean[-120:])
check("正文保留", "正文第一段，讲清楚判断标准。" in clean)
check("有用问答保留", "西邦 24 适合什么场景" in clean)
check("标签保留", "#西邦24" in clean)
check("声明保留", "声明：含AI生成内容" in clean)
check("没有连续三个空行", "\n\n\n" not in clean)

print("\n[10] 清理的边界情况")
only_ad = """# 标题

正文。

## 品牌与联系信息

- 品牌：A
- 官方网站：a.com
"""
check("整块删完不留空标题", "品牌与联系信息" not in render.strip_ad_block(only_ad))
check("正文还在", "正文。" in render.strip_ad_block(only_ad))

empty_faq = "# 标题\n\n正文。\n\n## 常见问题\n\n### 官网是多少？\n\na.com\n"
check("问答题全删后不留空小节", "## 常见问题" not in render.strip_ad_block(empty_faq))

normal = "# 标题\n\n正文。\n\n## 小节\n\n内容。\n"
check("没有该内容时原样返回", render.strip_ad_block(normal).strip() == normal.strip())
check("空字符串不报错", render.strip_ad_block("") == "")
check("只有域名也算导流", "a.com" not in render.strip_ad_block(
    "# t\n\n## 常见问题\n\n### 参数在哪看？\n\n可以去 a.com 看参数表。\n"))

print("\n[11] 自检不再检查信息块")
art = {"title": "西邦 24 怎么选", "body_md": md, "tags": ["#a"] * 5, "decl": ["含AI生成内容"]}
names = {c["name"] for c in render.geo_check(art, "西邦 24", "西邦", [], [])["checks"]}
check("检查项里没有「品牌信息块完整」", "品牌信息块完整" not in names, str(names))
check("geo_check 不再收 require_brand_block",
      "require_brand_block" not in render.geo_check.__code__.co_varnames)

print("\n[12] 补充说明合并成一段话")
N1 = dict(BRIEF, note="重点讲清洗方便，别提价格；语气平实一点，别喊口号")
u1 = prompts.build_user(N1, PLATFORM, prompts.ANGLES[0], "图文", [], "新手视角", 1, 1,
                        keyword="小型咖啡机怎么选")
check("补充说明进了提示词", "重点讲清洗方便，别提价格" in u1)
check("没有再拆成主题/语气/卖点/其他要求四段",
      all(k not in u1 for k in ("【主题范围】", "【语气】", "【其他要求】", "【要强调的卖点/参数】")))
check("说明这段话优先级更高", "优先级高于通用建议" in u1)

N2 = dict(BRIEF, note="")
u2 = prompts.build_user(N2, PLATFORM, prompts.ANGLES[0], "图文", [], "新手视角", 1, 1,
                        keyword="小型咖啡机怎么选")
check("没填时给默认写法", "未提供，按客户资料和平台要求来写" in u2)

print("\n[13] 老方案的分段字段自动拼回一段")
legacy_brief = dict(BRIEF)
legacy_brief.pop("note", None)
legacy_brief.update({"topic": "家用咖啡设备选购", "points": "3 秒出热咖啡", "extra": "不要提价格"})
u3 = prompts.build_user(legacy_brief, PLATFORM, prompts.ANGLES[0], "图文", [], "新手视角", 1, 1,
                        keyword="小型咖啡机怎么选")
check("主题拼进去了", "家用咖啡设备选购" in u3, u3[:60])
check("卖点拼进去了", "3 秒出热咖啡" in u3)
check("其他要求拼进去了", "不要提价格" in u3)
check("老方案也不会出现旧字段名", "【语气】" not in u3)

print("\n[14] 风险清单作为硬约束交给模型")
RISKS = [
    {"level": "中", "category": "导流", "item": "不得出现联系方式", "tip": "删掉电话"},
    {"level": "高", "category": "广告法", "item": "不得使用极限词", "tip": "改成相对表述"},
    {"level": "低", "category": "排版", "item": "不要整段加粗", "tip": ""},
]
sys_r = prompts.build_system(PLATFORM, RISKS, "high", "小型咖啡机怎么选", "西邦", "某公司")
check("用硬约束口径而不是参考资料", "硬性约束" in sys_r and "直接作废" in sys_r)
check("优先级高于写作偏好", "比上面的写作偏好优先级更高" in sys_r)
check("按高 → 中 → 低排序",
      sys_r.index("【高】") < sys_r.index("【中】") < sys_r.index("【低】"))
check("每条带编号", "1. 【高】" in sys_r and "2. 【中】" in sys_r and "3. 【低】" in sys_r)
check("带上规避建议", "怎么改：改成相对表述" in sys_r)
check("没有建议的不硬凑", "怎么改：\n" not in sys_r)
check("给出判定方式（看意思不看字面）", "不要只看字面" in sys_r)
check("要求写完逐条自查", "交付前再从头逐条自查一次" in sys_r)
check("要求按编号回传", "第几条：怎么处理的" in sys_r)
check("清单为空时给兜底",
      "暂无额外限制" in prompts.build_system(PLATFORM, [], "high", "k", "西邦", ""))

print("\n[15] 自检会核对风险自查是否回传")
art_r = {"title": "小型咖啡机怎么选", "body_md": "# 小型咖啡机怎么选\n\n正文。\n\n#a #b #c #d #e\n\n声明：x",
         "tags": ["#a"] * 5, "decl": ["x"]}
g_none = {c["name"]: c for c in render.geo_check(
    dict(art_r, risk_tips=[]), "小型咖啡机怎么选", "西邦", [], [],
    require_risk_notes=True)["checks"]}
check("没回传时判定失败", g_none.get("风险自查已回传") and not g_none["风险自查已回传"]["ok"])
check("提示说明要按编号", "逐条编号" in g_none["风险自查已回传"]["hint"])
g_ok = {c["name"]: c for c in render.geo_check(
    dict(art_r, risk_tips=["第1条：删掉了绝对化表述", "第2条：去掉了联系方式", "第3条：没有大段加粗"]),
    "小型咖啡机怎么选", "西邦", [], [], require_risk_notes=True)["checks"]}
check("回传 3 条判定通过", g_ok.get("风险自查已回传") and g_ok["风险自查已回传"]["ok"])
g_off = {c["name"] for c in render.geo_check(
    art_r, "小型咖啡机怎么选", "西邦", [], [])["checks"]}
check("不要求时不检查这一项", "风险自查已回传" not in g_off)

print("\n[16] 结构按平台差别化")
L_SHORT = prompts.layout_for({"name": "抖音企业号"}, "短视频")
L_ZH = prompts.layout_for({"name": "知乎个人号"}, "图文")
L_SOHU = prompts.layout_for({"name": "搜狐个人号"}, "图文")
L_WY = prompts.layout_for({"name": "网易个人号"}, "图文")
check("短视频不出「核心优势」", L_SHORT["sp"] is False)
check("短视频不出 FAQ", L_SHORT["faq"] is False)
L_DY = prompts.layout_for({"name": "抖音企业号"}, "图文")
check("抖音图文也不出核心优势和 FAQ",
      L_DY["sp"] is False and L_DY["faq"] is False, str(L_DY))
check("知乎三节都要", L_ZH["sp"] and L_ZH["facts"] and L_ZH["faq"])
check("知乎小节名换了", L_ZH["sp_title"] == "为什么这样判断", L_ZH["sp_title"])
check("搜狐有自己的叫法", L_SOHU["faq_title"] == "读者常问", L_SOHU["faq_title"])
check("网易不出「核心优势」", L_WY["sp"] is False)
check("各平台小节名不雷同",
      len({L_ZH["sp_title"], L_SOHU["sp_title"], L_SHORT.get("sp_title", "")}) == 3)

SAMPLE = {"title": "小标题测试", "summary": "一句话。",
          "sections": [{"heading": "正文小节", "paragraphs": ["正文。"], "bullets": []}],
          "selling_points": [{"point": "卖点一", "evidence": "证据", "value": "意义"}],
          "key_facts": ["事实 1", "事实 2"],
          "faq": [{"q": "问题一？", "a": "答案。"}],
          "tags": ["#标签"], "declarations": ["含AI生成内容"]}
md_short = render.render_md(dict(SAMPLE), "抖音企业号", "短视频", "疑问型", layout=L_SHORT)
md_zh = render.render_md(dict(SAMPLE), "知乎个人号", "图文", "疑问型", layout=L_ZH)
check("短视频正文没有「核心优势」", "## 核心优势" not in md_short)
check("短视频正文没有「常见问题」", "## 常见问题" not in md_short)
check("知乎正文有「为什么这样判断」", "## 为什么这样判断" in md_zh)
check("知乎正文有「常见问题」", "## 常见问题" in md_zh)
dup = dict(SAMPLE)
# 搜狐的小节名叫「几个判断依据」，模型自己写了同名小节时不能再追加一遍
dup["sections"] = [{"heading": "几个判断依据", "paragraphs": ["模型自己写的"], "bullets": []}]
md_dup = render.render_md(dup, "搜狐个人号", "图文", "疑问型", layout=L_SOHU)
check("模型写过同名小节时不再追加",
      md_dup.count("## 几个判断依据") == 1,
      str([x for x in md_dup.split(chr(10)) if x.startswith("## ")]))

check("两篇小节结构确实不同",
      [x for x in md_short.split("\n") if x.startswith("## ")] !=
      [x for x in md_zh.split("\n") if x.startswith("## ")],
      f"{md_short.count(chr(35)+chr(35)+' ')} vs {md_zh.count(chr(35)+chr(35)+' ')}")

print("\n[17] 提示词里写明本篇结构、并要求换问题")
u_l = prompts.build_user(BRIEF, PLATFORM, prompts.ANGLES[0], "图文", [], "新手视角", 1, 1,
                         keyword="小型咖啡机怎么选")
check("带「本篇结构要求」", "【本篇结构要求】" in u_l)
check("带「已经用过的问题」", "【已经用过的问题，不能再用】" in u_l)
check("第一批说明没有历史问题", "没有历史问题" in u_l)
u_dup = prompts.build_user(BRIEF, PLATFORM, prompts.ANGLES[0], "图文", [], "新手视角", 1, 1,
                           keyword="小型咖啡机怎么选",
                           avoid_faqs=["旧问题一？", "旧问题二？"])
check("旧问题进了提示词", "旧问题一？" in u_dup and "旧问题二？" in u_dup)
check("要求换不同问法", "必须和上面这些不一样" in u_dup)
check("带差异化要求", "【差异化要求】" in u_dup)

print("\n" + "=" * 46)
print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
if failed:
    for n, d in failed:
        print("  失败：" + n + ("  " + d if d else ""))
    print("结果：不通过")
    sys.exit(1)
print("结果：全部通过")
