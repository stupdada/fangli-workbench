# -*- coding: utf-8 -*-
"""批量差异化生成引擎：按 平台 × 篇数 自动轮换角度、切口与发布形态。"""

import json
import re
import threading
import time
import traceback

from . import grouping, llm, prompts, render

LEVEL_ORDER = {"high": 3, "mid": 2, "low": 1}

_jobs = {}
_jobs_lock = threading.Lock()


def new_job(plan_id, total, kind="generate"):
    jid = f"job_{int(time.time() * 1000)}_{plan_id}"
    with _jobs_lock:
        _jobs[jid] = {
            "id": jid, "plan_id": plan_id, "kind": kind, "status": "running",
            "total": total, "planned": total, "done": 0, "message": "准备中…", "items": [],
            "error": "", "started_at": time.time(), "cancel": False,
            "seg": 0, "index": 0, "count": 0, "platform": "", "account_type": "",
            "words": [], "partial": "", "chars": 0, "title": "", "score": None,
            "article_id": None, "audit": {}, "phase": "",
        }
    return jid


def cancel_job(jid):
    """请求暂停：当前这篇写完后停手，不打断正在生成的文字。"""
    with _jobs_lock:
        j = _jobs.get(jid)
        if not j:
            return False
        j["cancel"] = True
        return True


def _canceled(jid):
    with _jobs_lock:
        return bool((_jobs.get(jid) or {}).get("cancel"))


def get_job(jid):
    with _jobs_lock:
        j = _jobs.get(jid)
        return dict(j) if j else None


def _patch(jid, **kw):
    with _jobs_lock:
        if jid in _jobs:
            _jobs[jid].update(kw)


def _add_item(jid, item):
    with _jobs_lock:
        if jid in _jobs:
            _jobs[jid]["items"].append(item)


def _set_item(jid, idx, **kw):
    with _jobs_lock:
        if jid in _jobs and 0 <= idx < len(_jobs[jid]["items"]):
            _jobs[jid]["items"][idx].update(kw)


def _get(jid, key, default=None):
    with _jobs_lock:
        return (_jobs.get(jid) or {}).get(key, default)


def pref_level(store, platform_id, model_names):
    models = {m["name"]: m["id"] for m in store.list_models()}
    best = "low"
    found = False
    for name in model_names or []:
        mid = models.get(name)
        if not mid:
            continue
        for p in store.get_prefs():
            if p["model_id"] == mid and p["platform_id"] == platform_id:
                found = True
                if LEVEL_ORDER.get(p["level"], 0) > LEVEL_ORDER.get(best, 0):
                    best = p["level"]
    return best if found else "mid"


def risks_for(store, platform_id):
    rows = store.list_risks()
    items = [r for r in rows if r["platform_id"] is None] + \
            [r for r in rows if r["platform_id"] == platform_id]
    return items


def account_type_of(platform, brief=None):
    """取本次该平台用官方号还是个人号：方案里选了就用方案，否则用平台默认。"""
    pid = platform.get("id")
    chosen = ((brief or {}).get("platform_types") or {}).get(str(pid)) or \
             ((brief or {}).get("platform_types") or {}).get(pid)
    if chosen in ("official", "personal"):
        return chosen
    return platform.get("account_type") or "personal"


def used_faqs(store, plan_id):
    """已经用过的问题，生成下一篇时要求换新的，避免每篇都是同样几个问答。"""
    out = []
    for a in store.list_articles(plan_id):
        for q in re.findall(r"(?m)^###\s*(.+)$", a.get("body_md") or ""):
            q = q.strip()
            if q and q not in out:
                out.append(q)
    return out[:40]


def build_messages(store, brief, platform, angle, sub_angle, fmt,
                   level, avoid_titles, index, total, keyword="", materials_text="",
                   extra_keywords=None, account_type=None, extra_note="",
                   avoid_faqs=None, layout=None):
    """拼系统提示与单篇提示。批量生成和流式单篇共用这一份，避免两边漂移。"""
    risk_items = risks_for(store, platform["id"])
    account_type = account_type or account_type_of(platform, brief)
    system = prompts.build_system(platform, risk_items, level,
                                  keyword or brief.get("keyword", ""),
                                  (brief.get("brand") or "").strip(),
                                  (brief.get("company") or "").strip(),
                                  account_type=account_type)
    user = prompts.build_user(brief, platform, angle, fmt, avoid_titles, sub_angle,
                              index, total, keyword=keyword, materials_text=materials_text,
                              extra_keywords=extra_keywords or [],
                              account_type=account_type,
                              layout=layout or prompts.layout_for(platform, fmt),
                              avoid_faqs=avoid_faqs)
    return [{"role": "system", "content": system},
            {"role": "user", "content": user + extra_note}]


def _generate_one(store, settings, brief, platform, angle, sub_angle, fmt,
                  level, avoid_titles, index, total, keyword="", materials_text="",
                  extra_keywords=None, on_wait=None, account_type=None):
    account_type = account_type or account_type_of(platform, brief)
    system_user = build_messages(store, brief, platform, angle, sub_angle, fmt, level,
                                 avoid_titles, index, total, keyword, materials_text,
                                 extra_keywords, account_type,
                                 avoid_faqs=used_faqs(store, brief.get("_plan_id") or 0))
    system, user = system_user[0]["content"], system_user[1]["content"]

    data = None
    last_err = ""
    base_tokens = int(settings.get("max_tokens", 4000) or 4000)
    # 依次尝试：正常上限 → 放宽上限（应对被截断）→ 去掉 JSON 强约束（应对格式不支持）
    plan = [(base_tokens, True), (min(8000, int(base_tokens * 1.6)), True),
            (min(8000, int(base_tokens * 1.6)), False)]
    for attempt, (tokens, force_json) in enumerate(plan):
        extra = ""
        if attempt == 1:
            extra = "\n注意：上一次输出被长度截断，请压缩篇幅，确保 JSON 结构完整闭合。"
        elif attempt == 2:
            extra = "\n注意：请严格只输出 JSON 对象本身，不要任何前后缀文字。"
        try:
            txt = llm.chat_with_retry(
                [{"role": "system", "content": system},
                 {"role": "user", "content": user + extra}],
                settings, force_json=force_json, max_tokens=tokens, on_wait=on_wait)
        except llm.LLMError as e:
            last_err = str(e)
            if e.kind in ("auth", "network", "bad_request"):
                raise               # 这类错误重试无意义，直接把原因交给上层
            if e.kind == "truncated":
                continue            # 换更大的上限再试
            continue
        data = llm.parse_json(txt)
        if isinstance(data, dict) and data.get("title"):
            break
        last_err = (txt or "")[:200]
        data = None
    if not data:
        raise llm.LLMError(f"模型没有返回可用的结构化稿件：{last_err}")

    return _finalize(data, brief, platform, angle, fmt, settings, keyword, extra_keywords,
                     account_type=account_type)


def _finalize(data, brief, platform, angle, fmt, settings, keyword, extra_keywords=None,
              layout=None, account_type=None):
    """结构化数据 → 稿件字段。批量生成和流式单篇共用。"""
    data.setdefault("sections", [])
    if not data.get("summary"):
        data["summary"] = ""
    if not data.get("tags"):
        data["tags"] = ["#" + (brief.get("keyword") or "话题")]
    decl = data.get("declarations") or []
    if not any("AI" in str(d) for d in decl):
        decl.append("含AI生成内容")
    data["declarations"] = decl

    at = account_type or account_type_of(platform, brief)
    if settings.get("title_prefix", True):
        # 正文首行 H1 和标题字段都要带前缀，导出 Word 时才一致
        data["title"] = render.apply_title_prefix(data.get("title"), platform["name"], at)
    body = render.render_md(data, platform["name"], fmt, angle["name"],
                            layout=layout or prompts.layout_for(platform, fmt))
    title = (data.get("title") or "").strip()
    return {
        "platform_id": platform["id"],
        "platform_name": platform["name"],
        "fmt": fmt,
        "model_name": settings.get("model", ""),
        "angle": angle["name"],
        "account_type": at,
        "keyword": keyword,
        "keywords": [keyword] + list(extra_keywords or []),
        "title": title,
        "body_md": body,
        "tags": data.get("tags") or [],
        "decl": decl,
        "risk_tips": data.get("risk_notes") or [],
        "geo": {},
        "data": data,
    }


MAX_PER_GROUP = 20        # 单个「平台 + 官方号/个人号」最多排 20 篇
ACCOUNT_TYPES = ("official", "personal")


def normalize_selections(selections, platform_types=None):
    """把各种来源的选择统一成 [{platform_id, account_type, count}]。

    - count 收在 0..20，0 表示这个平台的这个号不写
    - 老数据只有 platform_id + count，账号类型从 platform_types 补，缺省个人号
    - 同一平台同一账号类型出现多次时合并，避免重复排任务
    """
    ptypes = platform_types or {}
    out = []
    for sel in selections or []:
        if not isinstance(sel, dict):
            continue
        try:
            pid = int(sel.get("platform_id") or 0)
        except (TypeError, ValueError):
            continue
        if not pid:
            continue
        try:
            count = int(sel.get("count") or 0)
        except (TypeError, ValueError):
            count = 0
        count = max(0, min(MAX_PER_GROUP, count))
        at = sel.get("account_type")
        if at not in ACCOUNT_TYPES:
            at = ptypes.get(str(pid)) or ptypes.get(pid)
        if at not in ACCOUNT_TYPES:
            at = "personal"
        hit = next((x for x in out if x["platform_id"] == pid and x["account_type"] == at), None)
        if hit:
            hit["count"] = min(MAX_PER_GROUP, hit["count"] + count)
        else:
            out.append({"platform_id": pid, "account_type": at, "count": count})
    return out


def selection_total(selections, platform_types=None):
    """本次一共要写多少篇。平台没配上的不算。"""
    return sum(s["count"] for s in normalize_selections(selections, platform_types))


def selections_of(store, brief):
    """取本次的篇数设置；老方案只存了平台名时，按每个平台 1 篇补出来。"""
    sel = (brief or {}).get("selections") or []
    if sel:
        return sel
    plats = {p["name"]: p for p in store.list_platforms()}
    out = []
    for name in (brief.get("platforms") or []):
        p = plats.get(name)
        if p:
            out.append({"platform_id": p["id"],
                        "account_type": account_type_of(p, brief), "count": 1})
    if out:
        return out
    for p in store.list_platforms():
        if p.get("enabled", 1):
            return [{"platform_id": p["id"],
                     "account_type": account_type_of(p, brief), "count": 1}]
    return []


def build_task_queue(store, keywords, selections, aliases=None, platform_types=None):
    """把「平台 × 账号类型 × 篇数 × 关键词」摊平成一条固定顺序的任务队列。

    每条任务描述「哪个平台、用哪种号、这一组的第几篇、覆盖哪几个词」。
    固定顺序保证：暂停、关掉重开、改篇数，都能按同样的算法接着算，不会串。

    关键词分组是「全方案一次性摊分」：先算出这一轮总共要写几篇，再把全部关键词
    切成与篇数相当的几组，按全局序号分配给各篇文章。这样不同文章覆盖不同的词，
    标题主词自然不一样。

    早期版本在「平台 × 账号类型」这一层各自独立分组，当每个 selection 的篇数都是
    1 时（最常见：每平台官方号+个人号各 1 篇），每组永远只取第一组，结果所有文章
    撞到同一个主词、标题开头千篇一律——这个 bug 在这里修掉。
    """
    platforms = {p["id"]: p for p in store.list_platforms()}
    keywords = [str(k).strip() for k in (keywords or []) if str(k).strip()]
    if not keywords:
        return []
    # 先摊平出所有任务，才能知道全方案一共要写几篇、关键词该切几组
    flat = []
    seq = 0
    for sel in normalize_selections(selections, platform_types):
        platform = platforms.get(sel["platform_id"])
        if not platform or sel["count"] <= 0:
            continue
        count = sel["count"]
        formats = platform.get("formats") or ["图文"]
        for i in range(count):
            flat.append({
                "platform_id": platform["id"],
                "platform_name": platform["name"],
                "account_type": sel["account_type"],
                "index": i,
                "count": count,
                "level_platform": platform,
                "angle_i": seq,
                "sub_i": seq,
                "fmt": formats[i % len(formats)],
                "seq": seq,
                "key": f"{platform['id']}|{sel['account_type']}|{i}",
            })
            seq += 1
    if not flat:
        return []
    total = len(flat)
    # 每篇最多带 4 个词：词比「4 × 总篇数」还多时，先按 4 个一组切，多余的下轮再写，
    # 免得一篇文章硬塞七八个词、写成关键词堆砌
    k = total
    if -(-len(keywords) // total) > 4:
        k = -(-len(keywords) // 4)
    groups = grouping.split_keywords(keywords, k, aliases=aliases) or [keywords[:1]]
    # 全局轮转分配：第 g 篇文章拿第 g 组，保证不同文章拿到不同的词
    for g, t in enumerate(flat):
        t["group"] = groups[g % len(groups)]
    return flat


def plan_signature(keywords, selections):
    return json.dumps({"k": keywords, "s": selections}, ensure_ascii=False, sort_keys=True)


def pending_tasks(store, plan_id, keywords, selections, aliases=None, platform_types=None):
    """算出还没写的任务（按队列下标返回）。

    每个「平台 + 账号类型」组按已写篇数往后取：已写 2 篇就是该组第 3 篇还没写。
    这样既不会重复生成，也不会因为删过稿就整组停工。
    """
    tasks = build_task_queue(store, keywords, selections, aliases=aliases,
                             platform_types=platform_types)
    written = _written_by_group(store, plan_id)
    pending = []
    for i, t in enumerate(tasks):
        if written.get((t["platform_id"], t["account_type"]), 0) <= t["index"]:
            pending.append(i)
    done_idx = set(range(len(tasks))) - set(pending)
    return tasks, done_idx, pending


def _written_by_group(store, plan_id):
    """每个「平台 + 账号类型」已经写了多少篇。"""
    out = {}
    for a in store.list_articles(plan_id):
        key = (a.get("platform_id"), a.get("account_type") or "personal")
        out[key] = out.get(key, 0) + 1
    return out


_write_busy = {}
_write_busy_lock = threading.Lock()


def acquire_write(plan_id):
    """同一方案同时只允许一个写任务。并发会读到同样的状态，写出重复的稿子。"""
    with _write_busy_lock:
        if plan_id in _write_busy:
            return False
        _write_busy[plan_id] = True
        return True


def release_write(plan_id):
    with _write_busy_lock:
        _write_busy.pop(plan_id, None)


def selected_platforms(store, brief):
    """本次要发的平台：优先按方案里勾选的名字，其次按 selections 的 id。"""
    active = [p for p in store.list_platforms() if p.get("enabled", 1)]
    names = [n for n in (brief.get("platforms") or []) if n]
    if names:
        picked = [p for p in active if p["name"] in names]
        if picked:
            return picked
    ids = []
    for sel in brief.get("selections") or []:
        try:
            ids.append(int(sel.get("platform_id")))
        except Exception:
            pass
    picked = [p for p in active if p["id"] in ids]
    return picked or active[:1]


def next_task(store, plan_id, brief, skip_keys=None):
    """算出下一篇写什么。

    做法：先按「平台 × 账号类型 × 篇数」排出完整队列，再看每组的已写篇数，
    挑「写得最少、还没到配额」的那一组的下一篇。于是：
    - 各平台自然轮转，不会一个平台连写到底
    - 某个号写够篇数就自动跳过，不会超配额
    - 中途暂停、关掉重开、改篇数，都从当前稿件重新算，接得上
    """
    keywords = [str(k).strip() for k in (brief.get("keywords") or []) if str(k).strip()]
    if not keywords:
        return None
    tasks = build_task_queue(store, keywords, selections_of(store, brief),
                             aliases=brief.get("aliases"),
                             platform_types=brief.get("platform_types"))
    if not tasks:
        return None

    arts = store.list_articles(plan_id)
    written = _written_by_group(store, plan_id)
    skip = set(skip_keys or ())

    groups, order = {}, []
    for t in tasks:
        key = (t["platform_id"], t["account_type"])
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(t)

    cand = []
    for key in order:
        rows = groups[key]
        n = written.get(key, 0)
        if n >= len(rows):
            continue                       # 这组的篇数已经写满
        rest = [x for x in rows if x["index"] >= n and x["key"] not in skip]
        if not rest:
            continue                       # 剩下的都写不出来，整组先跳过
        cand.append((n, rest[0]))
    if not cand:
        return None

    # 写得最少的那组先写；一样多时按队列顺序（各平台轮流开工）
    cand.sort(key=lambda x: (x[0], x[1]["seq"]))
    n, task = cand[0]
    platform = task["level_platform"]
    mine = [a for a in arts if a.get("platform_id") == platform["id"]]

    covered = set()
    for a in arts:
        covered |= set(a.get("keywords") or ([a["keyword"]] if a.get("keyword") else []))
    n_all = len(arts)

    return {
        "platform": platform,
        "group": task["group"],
        "keyword": task["group"][0],
        "extras": task["group"][1:],
        "account_type": task["account_type"],
        # 角度按「本方案已写第几篇」轮换：篇与篇之间不会连着用同一个角度
        "angle": prompts.ANGLES[n_all % len(prompts.ANGLES)],
        "sub": prompts.SUB_ANGLES[(n_all * 5) % len(prompts.SUB_ANGLES)],
        "fmt": task["fmt"],
        "avoid": [a["title"] for a in mine if a.get("title")],
        "index": n + 1,
        "count": task["count"],
        "round": n // max(1, task["count"]) + 1,
        "covered": len(covered & set(keywords)),
        "total_words": len(keywords),
        "key": task["key"],
        "qi": task["seq"],
    }


def audit_article(store, settings, article_id, brief=None):
    """二次核查：拿客户资料把文章里站不住的内容挑出来，能改的当场改。

    返回核查摘要。核查失败不影响已经写好的文章，只记一条失败原因。
    """
    art = store.get_article(article_id)
    if not art:
        return {"ok": False, "error": "稿件不存在"}
    plan = store.get_plan(art["plan_id"]) or {}
    brief = dict(brief or plan.get("brief") or {})
    body = (art.get("body_md") or "").strip()
    if not body:
        return {"ok": False, "error": "正文是空的，没什么可核的"}

    materials = store.list_materials(art["plan_id"])
    materials_text = prompts.build_materials_text(materials, budget=20000, per_file=8000)
    msgs = prompts.build_audit(body, materials_text, brief.get("note") or "")

    txt = llm.chat_with_retry(msgs, settings, force_json=True, max_tokens=8000)
    data = llm.parse_json(txt)
    if not isinstance(data, dict):
        return {"ok": False, "error": "核查结果不是合法 JSON"}

    findings = [f for f in (data.get("findings") or []) if isinstance(f, dict) and f.get("quote")]
    revised = (data.get("revised_body") or "").strip()

    result = {
        "ok": True,
        "findings": findings[:30],
        "count": len(findings),
        "verdict": data.get("verdict") or ("clean" if not findings else "revised"),
        "at": time.strftime("%Y-%m-%d %H:%M"),
        "original_chars": len(body),
        "applied": False,
    }

    # 安全阀：模型大幅删减、或返回的根本不是正文，都不替换，只留问题清单
    if not revised:
        result["reason"] = "模型没给修订版，只保留了问题清单"
    elif len(revised) < len(body) * 0.6:
        result["reason"] = "修订版比原文少了三成以上，先不替换，请你手动看"
        result["revised_preview"] = revised[:500]
    elif revised.strip() == body:
        result["reason"] = "无需修改"
    else:
        store.update_article(article_id, body_original=body, body_md=revised)
        result.update(applied=True, revised_chars=len(revised), reason="已按核查结果修改")
        saved = store.get_article(article_id)
        platforms = {p["id"]: p for p in store.list_platforms()}
        platform = platforms.get(saved.get("platform_id")) or {}
        extras = [w for w in (saved.get("keywords") or []) if w != saved.get("keyword")]
        geo = render.geo_check(
            saved, saved.get("keyword") or "", (brief.get("brand") or "").strip(),
            prompts.brands_for(brief), extras,
            company=(brief.get("company") or "").strip(),
            account_type=account_type_of(platform, brief), require_risk_notes=True)
        store.update_article(article_id, geo=geo)
        result["score"] = geo.get("score")

    store.update_article(article_id, audit=result)
    return result


def run_write_one(store, plan_id, brief, jid):
    """一次写一篇，边写边把原文塞进任务，前端可以实时看到文字在出。"""
    if not acquire_write(plan_id):
        _patch(jid, status="error",
               message="这篇还在写，等它写完再点「再写一篇」",
               error="同一方案不能同时写两篇，否则会生成两篇一模一样的稿子")
        return
    try:
        _run_write_one(store, plan_id, brief, jid)
    finally:
        release_write(plan_id)


def _prepare_brief(store, plan_id, brief):
    """补齐关键词等必备信息；连续写、单篇写、批量写共用。"""
    plan = store.get_plan(plan_id) or {}
    stored = plan.get("brief") or {}
    brief = dict(brief or {})
    if not brief.get("keywords"):
        brief["keywords"] = stored.get("keywords") or (
            [plan["keyword"]] if plan.get("keyword") else [])
    if not brief.get("keywords"):
        return None
    brief["_plan_id"] = plan_id
    if not brief.get("selections"):
        brief["selections"] = selections_of(store, brief)
    if not brief.get("platform_types"):
        brief["platform_types"] = stored.get("platform_types") or {}
    return brief


def _write_one_core(store, plan_id, brief, jid, task=None):
    """真正写一篇并落库。成功返回 (article_id, article, geo)，失败抛异常。

    task 为空时自己算下一篇；连续生成会先算好再传进来，好让外圈知道是哪一条失败。
    """
    settings = store.get_settings()
    task = task or next_task(store, plan_id, brief)
    if not task:
        raise llm.LLMError("没有可写的任务了：检查平台与篇数设置")

    platform = task["platform"]
    account_type = task.get("account_type") or account_type_of(platform, brief)
    _patch(jid, status="running", platform=platform["name"],
           account_type=account_type, seg_name=f"{platform['name']}·{account_type}",
           words=task["group"], index=task["index"], count=task.get("count"),
           partial="", chars=0, title="", score=None, audit={}, article_id=None,
           seg=int(_get(jid, "seg", 0) or 0) + 1,
           message=f"正在写：{platform['name']} 第 {task['index']} 篇（{task['keyword']}）")

    materials = store.list_materials(plan_id)
    materials_text = prompts.build_materials_text(materials, focus=task["group"])
    level = pref_level(store, platform["id"], brief.get("models") or [])
    msgs = build_messages(store, brief, platform, task["angle"], task["sub"], task["fmt"],
                          level, task["avoid"], task["index"], task.get("count") or 0,
                          task["keyword"], materials_text, task["extras"],
                          account_type=account_type,
                          avoid_faqs=used_faqs(store, plan_id))

    partial = ""
    try:
        for piece in llm.stream_with_retry(
                msgs, settings, force_json=True,
                on_wait=lambda sec, err: _patch(
                    jid, message=f"接口限流，等 {sec} 秒后重试")):
            partial += piece
            _patch(jid, partial=partial, chars=len(partial))
    except llm.LLMError as e:
        # 有些接口不支持流式或流式下不认 json 模式，退回普通调用，保证还能出稿
        if e.kind in ("bad_request", "unknown", "network") and not partial:
            partial = llm.chat_with_retry(msgs, settings, force_json=False)
            _patch(jid, partial=partial, chars=len(partial))
        else:
            raise

    data = llm.parse_json(partial)
    if not isinstance(data, dict) or not data.get("title"):
        raise llm.LLMError("模型没有返回可用的结构化稿件：" + (partial or "")[:160])

    art = _finalize(data, brief, platform, task["angle"], task["fmt"], settings,
                    task["keyword"], task["extras"],
                    layout=prompts.layout_for(platform, task["fmt"]),
                    account_type=account_type)
    aid = store.add_article(plan_id, **art)
    saved = [a for a in store.list_articles(plan_id) if a["id"] == aid][0]
    saved["geo"] = render.geo_check(
        saved, task["keyword"], (brief.get("brand") or "").strip(),
        prompts.brands_for(brief), task["extras"],
        company=(brief.get("company") or "").strip(),
        account_type=account_type, require_risk_notes=True)
    store.update_article(aid, geo=saved["geo"])
    store.update_plan(plan_id, status="generated")

    _patch(jid, article_id=aid, title=art["title"], words=task["group"],
           score=saved["geo"]["score"], phase="audit",
           message="写好了，正在对照客户资料核查事实…")

    # 二次核查：拿资料把站不住的内容挑出来改掉，失败也不影响已经写好的稿子
    try:
        result = audit_article(store, settings, aid, brief)
        _patch(jid, audit=result)
        after = store.get_article(aid) or saved
        body_now = after.get("body_md") or partial
        _patch(jid, chars=len(body_now), score=(after.get("geo") or {}).get("score"),
               message=(f"核查完成：改了 {result.get('count', 0)} 处"
                        if result.get("applied") else
                        f"核查完成：{result.get('count', 0)} 处存疑，未改动正文"))
    except Exception as e:                       # noqa: BLE001
        _patch(jid, audit={"ok": False, "error": str(e)[:200]},
               message="核查没做成，稿子不受影响：" + str(e)[:80])

    after = store.get_article(aid) or saved
    return aid, after, after.get("geo") or {}


def _run_write_one(store, plan_id, brief, jid):
    brief = _prepare_brief(store, plan_id, brief)
    if not brief:
        _patch(jid, status="error", message="方案里没有目标关键词", error="方案里没有目标关键词")
        return
    task = next_task(store, plan_id, brief)
    if not task:
        _patch(jid, status="error", error="没有可写的任务了",
               message="没有可写的任务了：可能所有平台的篇数都已经写满，回第二步加篇数再来")
        return
    try:
        _write_one_core(store, plan_id, brief, jid, task)
    except Exception as e:                       # noqa: BLE001
        _patch(jid, status="error", error=str(e),
               message="这篇没写成：" + str(e)[:100])
        return
    _patch(jid, status="done", done=1, phase="")


def start_write_thread(store, plan_id, brief, jid):
    t = threading.Thread(target=_guard, kwargs=dict(
        fn=run_write_one, store=store, plan_id=plan_id, brief=brief, jid=jid), daemon=True)
    t.start()
    return t


def _auto_progress_text(done, left, total, failed):
    txt = f"已写完 {done}/{total} 篇"
    if left > 0:
        txt += f"，还有 {left} 篇"
    if failed:
        txt += f"（{failed} 篇没写成）"
    return txt


def run_auto(store, plan_id, brief, jid):
    """一口气一篇接一篇地写，直到计划篇数写完、或用户点了暂停。"""
    if not acquire_write(plan_id):
        _patch(jid, status="error",
               message="这个方案正在写，等它写完再开始",
               error="同一方案不能同时跑两个写稿任务，否则会生成重复的稿子")
        return
    try:
        _run_auto(store, plan_id, brief, jid)
    finally:
        release_write(plan_id)


def _run_auto(store, plan_id, brief, jid):
    brief = _prepare_brief(store, plan_id, brief)
    if not brief:
        _patch(jid, status="error", message="方案里没有目标关键词", error="方案里没有目标关键词")
        return

    tasks, _done_idx, pending = pending_tasks(
        store, plan_id, brief["keywords"], brief["selections"], brief.get("aliases"),
        brief.get("platform_types"))
    total_all = len(tasks)
    left = len(pending)
    if not total_all:
        _patch(jid, status="error", message="没有可写的任务：每个平台的篇数都是 0",
               error="没有可写的任务，请回第二步给平台设置篇数")
        return
    if left == 0:
        _patch(jid, status="done", done=0, total=0, planned=0, total_all=total_all,
               message="这份方案已经全部写完了，要再写就回第二步加篇数")
        return

    articles_n = len(store.list_articles(plan_id))
    planned = left
    _patch(jid, total=left, planned=left, total_all=total_all, done=0,
           cursor=min(articles_n, total_all), remaining=left,
           message=f"开始写：这次要写 {left} 篇")

    ok_count = 0
    fail_count = 0
    skip = set()

    while left > 0:
        if _canceled(jid):
            _patch(jid, status="paused", done=ok_count, remaining=left,
                   message=(f"已暂停：写完 {ok_count} 篇，还剩 {left} 篇"
                            + (f"，{fail_count} 篇没写成" if fail_count else "")))
            return
        task = next_task(store, plan_id, brief, skip)
        if not task:
            break
        try:
            aid, art, geo = _write_one_core(store, plan_id, brief, jid, task)
            _add_item(jid, {
                "platform": task["platform"]["name"],
                "account_type": task.get("account_type") or "personal",
                "index": task["index"], "words": task["group"],
                "angle": task["angle"]["name"], "fmt": task["fmt"],
                "title": art["title"], "article_id": aid,
                "score": (geo or {}).get("score"), "state": "done", "error": "",
            })
            ok_count += 1
            left -= 1
        except Exception as e:                   # noqa: BLE001
            fail_count += 1
            skip.add(task.get("key"))
            _add_item(jid, {
                "platform": task["platform"]["name"],
                "account_type": task.get("account_type") or "personal",
                "index": task["index"], "words": task["group"],
                "angle": task["angle"]["name"], "fmt": task["fmt"],
                "title": "", "article_id": None, "score": None,
                "state": "error", "error": str(e)[:300],
            })
            # 一篇都写不出来就停，别在坏配置上耗一整轮
            if ok_count == 0 and fail_count >= 3:
                _patch(jid, status="error", done=ok_count, remaining=left,
                       error=str(e), failed=fail_count,
                       message=f"连写 {fail_count} 篇都失败，先停下：" + str(e)[:100])
                return
        _patch(jid, done=ok_count, remaining=left, failed=fail_count,
               message=_auto_progress_text(ok_count, left, planned, fail_count))

    store.update_plan(plan_id, status="generated")
    if _canceled(jid):
        _patch(jid, status="paused", done=ok_count, remaining=left,
               message=f"已暂停：写完 {ok_count} 篇，还剩 {left} 篇")
    elif left == 0:
        _patch(jid, status="done", done=ok_count, remaining=0, failed=fail_count,
               message=(f"全部写完了，共 {ok_count} 篇"
                        + (f"（{fail_count} 篇没写成，可以再点继续补）" if fail_count else "")))
    else:
        _patch(jid, status="done", done=ok_count, remaining=left, failed=fail_count,
               message=_auto_progress_text(ok_count, left, planned, fail_count))


def start_auto_thread(store, plan_id, brief, jid):
    t = threading.Thread(target=_guard, kwargs=dict(
        fn=run_auto, store=store, plan_id=plan_id, brief=brief, jid=jid), daemon=True)
    t.start()
    return t


def run_generate(store, plan_id, brief, selections, jid, batch_size=3):
    """按批生成：一次只跑 batch_size 篇，进度落库，下次接着跑。

    每篇都走 _write_one_core，和「一次写一篇」「自动连写」是同一条路径，
    免得三处逻辑各写一遍、慢慢漂移。
    """
    brief = _prepare_brief(store, plan_id, dict(brief or {}))
    if not brief:
        _patch(jid, status="error", error="方案里没有目标关键词")
        return
    if selections:
        brief["selections"] = selections
    keywords = brief["keywords"]

    tasks, done_idx, pending = pending_tasks(
        store, plan_id, keywords, brief["selections"], brief.get("aliases"),
        brief.get("platform_types"))
    total_all = len(tasks)
    if not total_all:
        _patch(jid, status="error", error="没有可执行的任务，请检查平台与篇数设置")
        return

    signature = plan_signature(keywords, brief["selections"])
    prog = store.get_progress(plan_id, signature)
    failed_all = list(prog.get("failed") or [])
    # 口径统一：已写 = 稿件数，剩余 = 目标篇数 - 稿件数，跟界面上看到的数字一致
    articles_n = len(store.list_articles(plan_id))
    done_count = min(articles_n, total_all)
    to_write = len(pending)

    if not pending:
        _patch(jid, status="done", done=0, total=0, total_all=total_all, cursor=done_count,
               remaining=0, message="这份方案已经全部写完了")
        return

    batch_n = min(max(1, batch_size), to_write)
    _patch(jid, total=batch_n, total_all=total_all, cursor=done_count,
           remaining=to_write, batch_size=batch_size)

    ok_count = 0
    fail_count = 0
    first_error = ""
    skip = set()

    try:
        for _ in range(batch_n):
            task = next_task(store, plan_id, brief, skip)
            if not task:
                break
            platform = task["platform"]
            group = task["group"]
            keyword = task["keyword"]
            cover = f"（另覆盖 {len(group) - 1} 词）" if len(group) > 1 else ""
            _add_item(jid, {"platform": platform["name"], "index": task["index"],
                            "account_type": task.get("account_type") or "personal",
                            "angle": task["angle"]["name"], "fmt": task["fmt"], "state": "running",
                            "title": "", "keyword": keyword, "words": group,
                            "label": f"{platform['name']}·{keyword}{cover}"})
            idx = len(get_job(jid)["items"]) - 1

            try:
                aid, art, geo = _write_one_core(store, plan_id, brief, jid, task)
                _set_item(jid, idx, state="done", title=art["title"], article_id=aid,
                          score=(geo or {}).get("score"))
                done_idx.add(task.get("qi", -1))
                ok_count += 1
            except Exception as e:                # noqa: BLE001
                fail_count += 1
                if not first_error:
                    first_error = str(e)
                skip.add(task.get("key"))
                failed_all.append({"keyword": keyword, "platform": platform["name"],
                                   "error": str(e)[:300]})
                _set_item(jid, idx, state="error", error=str(e))

            done_now = ok_count + fail_count
            _patch(jid, done=done_now,
                   message=f"本批 {done_now}/{batch_n} 篇（成功 {ok_count}，失败 {fail_count}）")

        store.save_progress(plan_id, len(done_idx), total_all, signature,
                            failed_all[-50:], sorted(done_idx))
        if any(store.list_articles(plan_id)):
            store.update_plan(plan_id, status="generated")

        remaining = max(0, total_all - len(store.list_articles(plan_id)))
        new_cursor = total_all - remaining
        if ok_count == 0:
            _patch(jid, status="error", done=batch_n, cursor=new_cursor, remaining=remaining,
                   failed=fail_count, error=first_error,
                   message=f"本批 {batch_n} 篇全部失败：{first_error[:120]}")
        else:
            msg = f"本批完成 {ok_count}/{batch_n} 篇"
            if fail_count:
                msg += f"，{fail_count} 篇失败"
            msg += f"；累计 {new_cursor}/{total_all}"
            msg += "，已全部写完" if remaining == 0 else f"，还有 {remaining} 篇"
            _patch(jid, status="done", done=batch_n, cursor=new_cursor, remaining=remaining,
                   failed=fail_count, error=first_error if fail_count else "",
                   message=msg)
    except Exception as e:
        store.save_progress(plan_id, len(done_idx), total_all, signature,
                            failed_all[-50:], sorted(done_idx))
        _patch(jid, status="error", error=str(e) + "\n" + traceback.format_exc(limit=2)[-300:],
               message="生成中断：" + str(e)[:100])


def run_regenerate(store, article_id, jid, extra_note=""):
    settings = store.get_settings()
    with store.conn() as c:
        row = c.execute("SELECT * FROM articles WHERE id=?", (article_id,)).fetchone()
        if not row:
            _patch(jid, status="error", error="稿件不存在")
            return
        art = dict(row)
        plan = c.execute("SELECT * FROM plans WHERE id=?", (art["plan_id"],)).fetchone()
        plan = dict(plan)
    brief = plan["brief"]
    brief = json.loads(brief) if isinstance(brief, str) else dict(brief)
    brief["keyword"] = plan.get("keyword") or brief.get("keyword", "")
    keyword = (art.get("keyword") or brief["keyword"] or "").strip()
    try:
        words = json.loads(art.get("keywords") or "[]")
    except Exception:
        words = []
    extras = [w for w in words if w and w != keyword]
    materials_text = prompts.build_materials_text(store.list_materials(art["plan_id"]))
    platforms = {p["id"]: p for p in store.list_platforms()}
    platform = platforms.get(art["platform_id"]) or store.list_platforms()[0]
    angle = next((a for a in prompts.ANGLES if a["name"] == art["angle"]), prompts.ANGLES[0])
    sub = prompts.SUB_ANGLES[(article_id % len(prompts.SUB_ANGLES))]
    level = pref_level(store, platform["id"], brief.get("models") or [])
    others = [a["title"] for a in store.list_articles(art["plan_id"]) if a["id"] != article_id]
    if extra_note:
        brief = dict(brief)
        brief["note"] = (brief.get("note") or "").strip() + "；本次重写要求：" + extra_note
    _add_item(jid, {"platform": platform["name"], "index": 1, "angle": angle["name"],
                    "fmt": art["fmt"], "state": "running", "title": ""})
    try:
        # 走流式，前端能和"写新的一篇"共用同一个实时面板
        partial = ""
        try:
            msgs = build_messages(store, brief, platform, angle, sub, art["fmt"], level,
                                  others, 1, 0, keyword, materials_text, extras,
                                  avoid_faqs=used_faqs(store, art["plan_id"]))
            for piece in llm.stream_with_retry(
                    msgs, settings, force_json=True,
                    on_wait=lambda sec, err: _patch(
                        jid, message=f"接口限流，等 {sec} 秒后重试")):
                partial += piece
                _patch(jid, partial=partial, chars=len(partial))
            data = llm.parse_json(partial)
            if not isinstance(data, dict) or not data.get("title"):
                raise llm.LLMError("模型没有返回可用的结构化稿件")
            new = _finalize(data, brief, platform, angle, art["fmt"], settings, keyword, extras,
                            layout=prompts.layout_for(platform, art["fmt"]))
        except llm.LLMError:
            if partial:
                raise
            # 流式不被支持时退回普通调用
            new = _generate_one(store, settings, brief, platform, angle, sub, art["fmt"],
                                level, others, 1, 1, keyword=keyword,
                                materials_text=materials_text, extra_keywords=extras)
        store.update_article(article_id, title=new["title"], body_md=new["body_md"],
                             tags=new["tags"], decl=new["decl"], risk_tips=new["risk_tips"])
        saved = [a for a in store.list_articles(art["plan_id"]) if a["id"] == article_id][0]
        geo = render.geo_check(saved, keyword, (brief.get("brand") or "").strip(),
                               prompts.brands_for(brief), extras,
                               company=(brief.get("company") or "").strip(),
                               account_type=account_type_of(platform, brief),
                               require_risk_notes=True)
        store.update_article(article_id, geo=geo)
        _set_item(jid, 0, state="done", title=new["title"], score=geo["score"])
        _patch(jid, status="done", done=1, message="已重写并保存")
    except Exception as e:
        _set_item(jid, 0, state="error", error=str(e))
        _patch(jid, status="error", error=str(e), message="重写失败：" + str(e)[:100])


def _guard(fn, **kwargs):
    """线程入口兜底：任何异常都要把任务标成失败，不能让界面一直转圈。"""
    try:
        fn(**kwargs)
    except Exception as e:                       # noqa: BLE001
        try:
            _patch(kwargs.get("jid"), status="error",
                   message="生成中断：" + str(e)[:100],
                   error=str(e) + "\n" + traceback.format_exc(limit=3)[-400:])
        except Exception:
            pass


def start_generate_thread(store, plan_id, brief, selections, jid, batch_size=3):
    t = threading.Thread(target=_guard, kwargs=dict(
        fn=run_generate, store=store, plan_id=plan_id, brief=brief,
        selections=selections, jid=jid, batch_size=batch_size), daemon=True)
    t.start()
    return t


def start_regenerate_thread(store, article_id, jid, extra_note=""):
    t = threading.Thread(target=_guard, kwargs=dict(
        fn=run_regenerate, store=store, article_id=article_id, jid=jid,
        extra_note=extra_note), daemon=True)
    t.start()
    return t


ANGLES = prompts.ANGLES
