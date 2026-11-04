# -*- coding: utf-8 -*-
"""结构化稿件 → Markdown 渲染、GEO 自检、导出打包。"""

import re
import time

BANNED = [
    (r"最(好|佳|优|低|便宜|先进|专业|大)", "广告法极限词"),
    (r"第一(品牌|名|选择)|唯一|独家|顶级|国家级|世界级", "广告法极限词"),
    (r"100%|百分百|绝对|永久|彻底(解决|根除)", "绝对化表述"),
    (r"根治|包治|治疗|降三高|抗癌|增强免疫力", "医疗功效"),
    (r"稳赚|保本|零风险|翻倍|必涨", "金融收益承诺"),
]
DOMAIN_RE = re.compile(r"[a-z0-9][a-z0-9\-]{0,30}\.(?:com|cn|net|com\.cn|org|top)", re.I)
OFFICE_PHONE_RE = re.compile(r"400[\-\s]?\d{3}[\-\s]?\d{4}")
CONTACT = [
    (r"微信|wx[:：]|vx|加\s*[Vv]|二维码|扫码", "疑似站外导流"),
    (r"https?://|www\.", "外链"),
    (r"1[3-9]\d{9}", "手机号"),
    (r"私信我|加我|联系我|点击链接", "导流话术"),
]

# 标题前缀：【抖音官方号】/【知乎个人号】。只在开头匹配，正文里的【】不动。
TITLE_PREFIX_RE = re.compile(r"^【[^】]{1,24}】\s*")


def title_prefix(platform_name, account_type):
    who = "官方号" if account_type == "official" else "个人号"
    return "【%s%s】" % ((platform_name or "").strip(), who)


def strip_title_prefix(title):
    return TITLE_PREFIX_RE.sub("", (title or "").strip())


def apply_title_prefix(title, platform_name, account_type):
    """加前缀前先剥一遍，避免重写时出现【抖音官方号】【抖音官方号】标题。"""
    core = strip_title_prefix(title)
    if not core:
        return core
    return title_prefix(platform_name, account_type) + core


def strip_ad_block(body):
    """清掉旧稿件里像硬广的部分：文末「品牌与联系信息」小节 + 官网/生产商类问答。

    只删结构化块，不碰正文本体。新稿件不会再生成这些内容，这个函数用于清理历史稿件。
    """
    if not body:
        return body
    text = body

    # ① 去除文末「品牌与联系信息」小节（标题行 + 紧跟的条目行）
    lines = text.split("\n")
    out, i = [], 0
    while i < len(lines):
        if re.match(r"^#{2,3}\s*品牌与联系信息\s*$", lines[i].strip()):
            i += 1
            # 跳掉紧随其后的空行与「- 条目」行
            while i < len(lines) and (not lines[i].strip() or lines[i].lstrip().startswith("- ")):
                i += 1
            # 去掉因为删除多出来的空行
            while out and not out[-1].strip():
                out.pop()
            out.append("")
            continue
        out.append(lines[i])
        i += 1
    text = "\n".join(out)

    # ② 去掉导流性质的问答：问官网/渠道/联系方式的，或答案里带域名的
    ASK = re.compile(r"官网|网站|网址|域名|联系方式|联系电话|客服电话|电话|微信|二维码|"
                     r"哪里买|哪里可以买|在哪买|怎么买|购买渠道|官方渠道|经销商|代理商|"
                     r"哪家公司|哪家厂|生产厂家|厂家是哪")
    DOMAIN = re.compile(r"[a-z0-9][a-z0-9\-]{0,30}\.(?:com|cn|net|com\.cn|org|top)", re.I)

    def _drop_faq(m):
        q, whole = m.group(1), m.group(0)
        # 只删「这条问答本身」，边界停在下一个 ### / ## / 文末，不能连带后面内容
        return "" if (ASK.search(q) or DOMAIN.search(whole)) else whole

    text = re.sub(r"(?ms)^###\s*([^\n]*)\n.*?(?=^#|^声明[:：]|\Z)", _drop_faq, text)

    # ③ 清掉被删空的小节（例如「## 常见问题」下面一条都不剩）
    secs = re.split(r"(?m)^(?=##\s)", text)
    cleaned = []
    for sec in secs:
        if re.match(r"^##\s", sec):
            body_part = sec.split("\n", 1)[1] if "\n" in sec else ""
            if not body_part.strip():
                continue
        cleaned.append(sec)
    text = "".join(cleaned)

    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n" if text.strip() else ""


def render_md(data, platform_name, fmt, angle_name, layout=None):
    lines = []
    lines.append(f"# {data.get('title', '').strip()}")
    lines.append("")
    if data.get("summary"):
        # 模型有时把摘要写成两行，会把 ** 拆断，这里压成一行
        summary = re.sub(r"\s*\n\s*", " ", str(data["summary"])).strip()
        # 模型常自己带 ** 强调，外层再加一层会变成 ****文字****，先剥掉
        summary = summary.strip("*").strip()
        lines.append(f"**{summary}**")
        lines.append("")
    for sec in data.get("sections", []):
        h = (sec.get("heading") or "").strip()
        if h:
            lines.append(f"## {h}")
            lines.append("")
        for p in sec.get("paragraphs", []):
            p = (p or "").strip()
            if p:
                lines.append(p)
                lines.append("")
        for b in sec.get("bullets", []) or []:
            b = (b or "").strip()
            if b:
                lines.append(f"- {b}")
        if sec.get("bullets"):
            lines.append("")
    facts = [f for f in (data.get("key_facts") or []) if (f or "").strip()]
    layout = layout or {}
    used_heads = {(sec.get("heading") or "").strip() for sec in data.get("sections", [])}

    def _taken(title):
        """模型自己在 sections 里写过同名小节，就不再追加一遍。"""
        return title in used_heads

    sps = [s for s in (data.get("selling_points") or []) if s.get("point")]
    sp_title = layout.get("sp_title") or "核心优势"
    if sps and layout.get("sp", True) and not _taken(sp_title):
        lines.append("## " + sp_title)
        lines.append("")
        for s in sps:
            p = s.get("point", "").strip()
            e = (s.get("evidence") or "").strip()
            v = (s.get("value") or "").strip()
            line = f"- **{p}**"
            if e:
                line += f"：{e}"
            if v:
                line += f"。{v}"
            lines.append(line)
        lines.append("")
    facts_title = layout.get("facts_title") or "关键信息速览"
    if facts and layout.get("facts", True) and not _taken(facts_title):
        lines.append("## " + facts_title)
        lines.append("")
        for f in facts:
            lines.append(f"- {f.strip()}")
        lines.append("")
    faq = [f for f in (data.get("faq") or []) if f.get("q")]
    faq_title = layout.get("faq_title") or "常见问题"
    if faq and layout.get("faq", True) and not _taken(faq_title):
        lines.append("## " + faq_title)
        lines.append("")
        for f in faq:
            lines.append(f"### {f['q'].strip()}")
            lines.append("")
            lines.append((f.get("a") or "").strip())
            lines.append("")
    tags = data.get("tags") or []
    if tags:
        lines.append(" ".join(tags))
        lines.append("")
    decl = data.get("declarations") or []
    if decl:
        lines.append("声明：" + "；".join(decl))
    return "\n".join(lines).strip() + "\n"


def _plain(body):
    t = re.sub(r"^#+\s*", "", body, flags=re.M)
    t = re.sub(r"\*\*|__", "", t)
    return t


def geo_check(article, keyword, brand="", banned_brands=None, extra_keywords=None,
              company="", account_type="personal", require_risk_notes=False):
    body = article.get("body_md") or ""
    title = article.get("title") or ""
    tags = article.get("tags") or []
    decl = article.get("decl") or []
    brand = (brand or "").strip()
    banned_brands = [b for b in (banned_brands or []) if b and b != brand]
    extras = [k for k in (extra_keywords or []) if k and k != keyword]
    plain = _plain(body)
    paras = [p.strip() for p in re.split(r"\n\s*\n", plain) if p.strip()]
    body_paras = [p for p in paras if not p.startswith(("#", "-", "声明", "#"))]
    first = ""
    for p in body_paras:
        if not p.startswith("#") and not p.startswith("声明"):
            first = p
            break
    h2 = len(re.findall(r"^##\s+", body, flags=re.M))
    h3 = len(re.findall(r"^###\s+", body, flags=re.M))
    facts_block = ""
    m = re.search(r"##\s*关键信息速览([\s\S]*?)(?=\n##\s|\Z)", body)
    if m:
        facts_block = m.group(1)
    fact_count = len([l for l in facts_block.splitlines() if l.strip().startswith("-")])
    chars = len(re.sub(r"\s", "", plain))

    checks = []

    def add(name, ok, hint):
        checks.append({"name": name, "ok": bool(ok), "hint": hint})

    add("标题含核心关键词", keyword and keyword in title, "标题里要出现「%s」，越靠前越好" % keyword)
    add("开篇直接给结论", 0 < len(first) <= 160, "第一段控制在 160 字以内，直接说结论，不要铺垫")
    add("小标题分层", h2 >= 3, "至少 3 个二级小标题，方便大模型解析结构")
    add("关键信息独立成段", fact_count >= 3, "把数字、参数、对比差异单独列出来，至少 3 条")
    add("篇幅达标", chars >= 500, "正文过短，信息量不足，建议 700 字以上")
    add("关键词自然分布", plain.count(keyword) >= 3, "关键词出现次数偏少，可在小标题和正文里自然补 1-2 次")
    if extras:
        missing = [k for k in extras if k not in plain]
        add("辅助词都有覆盖", not missing,
            "这几个词正文里一次都没出现：" + "、".join(missing) + "，可加到小标题或 FAQ 里")
    add("话题标签", len(tags) >= 5, "标签至少 5 个，第一个放核心关键词话题")
    add("AI 声明", any("AI" in d for d in decl), "发布声明里必须勾选「含AI生成内容」")

    hits = []
    for pat, label in BANNED:
        if re.search(pat, plain):
            hits.append(label)
    add("无广告法风险词", not hits, "命中风险词：" + "、".join(sorted(set(hits))) if hits else "")
    contact = []
    for pat, label in CONTACT:
        if re.search(pat, plain):
            contact.append(label)
    add("无导流信息", not contact, "命中：" + "、".join(sorted(set(contact))) if contact else "")

    if require_risk_notes:
        notes = [x for x in (article.get("risk_tips") or []) if str(x).strip()]
        add("风险自查已回传", len(notes) >= 3,
            "只回传了 %d 条风险自查。硬约束是逐条编号给的，应该一条一条说明怎么处理的"
            % len(notes))

    is_official = account_type == "official"
    domains = DOMAIN_RE.findall(plain)
    office_phones = OFFICE_PHONE_RE.findall(plain)
    if is_official:
        seen = len(domains) + len(office_phones)
        add("官方信息已带出", seen >= 1,
            "官方号建议至少写一次官网或 400 电话，否则和 personal 号没区别")
    else:
        hits = []
        if domains:
            hits.append("官网域名")
        if office_phones:
            hits.append("客服电话")
        add("未出现官方联系方式", not hits,
            "个人号不能出现" + "、".join(hits) + "，这类信息只允许官方号写")

    if banned_brands:
        hit_brands = [b for b in banned_brands if b in plain]
        add("未出现竞品名", not hit_brands,
            "正文出现了竞品名：" + "、".join(hit_brands) + "，请替换成「不少同类产品」这类表述")

    if brand:
        # 公司全称里包含品牌名，统计露出次数时要先剔掉，否则会被重复计数
        scan = plain.replace(company, "") if company else plain
        cnt = scan.count(brand)
        cap = 8 if is_official else 6
        add("品牌露出适度", 1 <= cnt <= cap,
            "正文提到品牌 %d 次。" % cnt + ("没有提到品牌，宣传效果为零，建议在价值主张和结尾各提一次"
                                        if cnt == 0 else "提得太频繁会像硬广" +
                                        ("，建议压到 3-5 次" if is_official else "，建议压到 2-4 次")))

    score = round(100 * sum(1 for c in checks if c["ok"]) / len(checks))
    return {"checks": checks, "score": score, "chars": chars, "h2": h2, "h3": h3}


def article_head(a):
    words = a.get("keywords") or ([a["keyword"]] if a.get("keyword") else [])
    cover = ""
    if len(words) > 1:
        cover = f"覆盖关键词：{'、'.join(words)}\n"
    return (f"### {a['platform_name']}｜{a['angle']}｜{a['fmt']}\n"
            f"**{a['title']}**\n" + (cover + "\n" if cover else "\n"))


def ensure_plan_prefix(plan):
    """导出前按平台/号种补齐标题前缀。开关打开时用，历史稿件不用重写也能带上。"""
    p = dict(plan)
    arts = []
    for a in plan.get("articles") or []:
        b = dict(a)
        name, at = b.get("platform_name"), b.get("account_type") or "personal"
        b["title"] = apply_title_prefix(b.get("title"), name, at)
        body = b.get("body_md") or ""
        lines = body.split("\n")
        if lines and lines[0].startswith("# "):
            lines[0] = "# " + apply_title_prefix(lines[0][2:], name, at)
            b["body_md"] = "\n".join(lines)
        arts.append(b)
    p["articles"] = arts
    return p


def strip_plan_prefix(plan):
    """导出前去掉标题前缀（设置里把「标题前加平台/号种」关掉时用）。
    标题字段和正文首行 H1 一起处理，导出的文件里不会留下【抖音官方号】。"""
    p = dict(plan)
    arts = []
    for a in plan.get("articles") or []:
        b = dict(a)
        b["title"] = strip_title_prefix(b.get("title"))
        body = b.get("body_md") or ""
        lines = body.split("\n")
        if lines and lines[0].startswith("# "):
            lines[0] = "# " + strip_title_prefix(lines[0][2:])
            b["body_md"] = "\n".join(lines)
        arts.append(b)
    p["articles"] = arts
    return p


def pick_articles(plan, ids=None):
    """挑出要导出的稿件。ids 为 None 表示全导；给了 ids 就只导这几篇。"""
    arts = list(plan.get("articles") or [])
    if ids is None:
        return arts
    want = set()
    for x in ids:
        try:
            want.add(int(x))
        except (TypeError, ValueError):
            continue
    if not want:
        return []
    return [a for a in arts if int(a.get("id") or 0) in want]


def export_plan_md(plan, ids=None):
    b = plan.get("brief", {}) or {}
    articles = pick_articles(plan, ids)
    out = []
    out.append(f"# {plan.get('title') or plan.get('keyword')}\n")
    out.append(f"- 核心关键词：{plan.get('keyword')}")
    kws = b.get("keywords") or []
    if len(kws) > 1:
        out.append(f"- 本轮目标搜索关键词（{len(kws)} 个）：{'、'.join(kws)}")
    rivals = list(b.get("rivals") or [])
    if not rivals and isinstance(b.get("keyword_brands"), dict):
        for v in b["keyword_brands"].values():
            rivals.extend(v or [])
    rivals = [x for x in dict.fromkeys(rivals) if x]
    if rivals:
        out.append(f"- 搜索后同时出现的品牌/公司（仅内部参考，正文不得出现）：{'、'.join(rivals)}")
    mats = plan.get("materials") or []
    if mats:
        out.append(f"- 客户资料：{len(mats)} 份 —— " +
                   "；".join(f"{m['filename']}（{m.get('kind','')}，{m.get('chars',0)}字）" for m in mats))
    out.append(f"- 生成时间：{plan.get('created_at')}")
    out.append(f"- 稿件数量：{len(articles)}" + ("（本次勾选导出）" if ids is not None else ""))
    out.append(f"- 目标大模型：{'、'.join(b.get('models') or []) or '未选'}")
    out.append(f"- 分发平台：{'、'.join(b.get('platforms') or []) or '未选'}\n")

    snap = b.get("snapshot") or {}
    if snap.get("matrix"):
        out.append("## 一、大模型-内容平台抓取偏好对照表\n")
        levels = snap.get("levels", {})
        plats = [c["platform"] for c in snap["matrix"][0]["cells"]]
        out.append("| 目标大模型 | " + " | ".join(plats) + " |")
        out.append("|" + "---|" * (len(plats) + 1))
        for row in snap["matrix"]:
            cells = " | ".join(levels.get(c["level"], c["level"]) for c in row["cells"])
            out.append(f"| {row['model']} | {cells} |")
        out.append("")
    if snap.get("risks"):
        out.append("## 二、各分发平台违规/限流/驳回风险点清单\n")
        for r in snap["risks"]:
            out.append(f"### {r['platform']}\n")
            out.append("| 风险等级 | 类型 | 风险点 | 规避建议 |")
            out.append("|---|---|---|---|")
            for it in r["items"]:
                out.append(f"| {it['level']} | {it['category']} | {it['item']} | {it['tip']} |")
            out.append("")
    out.append("## 三、稿件正文\n")
    for a in articles:
        out.append(article_head(a))
        out.append(a.get("body_md", ""))
        out.append("\n---\n")
    return "\n".join(out)


def export_bodies_md(plan, ids=None):
    """只拼稿件正文，不带方案头、抓取偏好表、风险清单、平台标注。
    篇与篇之间用换页符分开，方便直接交付或打印。"""
    parts = []
    for a in pick_articles(plan, ids):
        body = (a.get("body_md") or "").strip()
        if body:
            parts.append(body)
    return "\n\n\f\n\n".join(parts)


def export_plan_docx(plan, ids=None):
    """导出成 Word（.docx）：只有稿件正文，标题层级与表格照旧排版。"""
    from .docx_writer import build_docx
    md = export_bodies_md(plan, ids)
    return build_docx(md, plan.get("title") or plan.get("keyword") or "内容方案")


def export_plan_txt(plan, ids=None):
    return export_plan_md(plan, ids)


def export_plan_json(plan, ids=None):
    import json
    data = dict(plan)
    data["articles"] = pick_articles(plan, ids)
    return json.dumps(data, ensure_ascii=False, indent=2)


def safe_name(s):
    return re.sub(r"[\\/:*?\"<>|\s]+", "_", s or "export")[:60]


def stamp():
    return time.strftime("%Y%m%d_%H%M%S")
