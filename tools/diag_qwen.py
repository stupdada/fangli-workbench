# -*- coding: utf-8 -*-
"""诊断：真实提示词下，千问的耗时 / 是否截断 / 思考模式影响。只读，不写库。"""
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import prompts, store as st  # noqa: E402

LOG = Path("/tmp/qwen_diag.log")
LOG.parent.mkdir(parents=True, exist_ok=True)


def log(*a):
    line = " ".join(str(x) for x in a)
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


S = st.Store("data/geo.db")
plan = S.get_plan(12)
brief = dict(plan["brief"]); brief["keyword"] = plan["keyword"]
kws = brief.get("keywords") or []
mats = S.list_materials(12)
pname = (brief.get("platforms") or ["知乎个人号"])[0]
plat = [p for p in S.list_platforms() if p["name"] == pname][0]
risks = [r for r in S.list_risks() if r["platform_id"] in (None, plat["id"])]
g = kws[:3]
system = prompts.build_system(plat, risks, "high", g[0], brief.get("brand", ""), brief.get("company", ""))
user = prompts.build_user(brief, plat, prompts.ANGLES[0], "图文", [], "新手视角", 1, 1,
                          keyword=g[0], extra_keywords=g[1:],
                          materials_text=prompts.build_materials_text(mats, focus=g))
cfg = S.get_settings()
if LOG.exists():
    LOG.unlink()
log("提示词合计字数:", len(system) + len(user))


def call(extra, label, max_tokens=4000, timeout=420):
    body = {"model": cfg["model"],
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": cfg.get("temperature", 0.8),
            "max_tokens": max_tokens, "stream": False,
            "response_format": {"type": "json_object"}}
    body.update(extra)
    req = urllib.request.Request(cfg["api_base"].rstrip("/") + "/chat/completions",
                                 data=json.dumps(body, ensure_ascii=False).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + cfg["api_key"])
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "ignore")
        dt = time.time() - t0
        o = json.loads(raw); ch = o["choices"][0]; m = ch["message"]; u = o.get("usage", {})
        txt = m.get("content") or ""
        ok = False
        try:
            json.loads(txt)
            ok = True
        except Exception:
            pass
        log(f"[{label}] 耗时 {dt:.1f}s | finish={ch.get('finish_reason')} | "
            f"completion={u.get('completion_tokens')} reasoning="
            f"{(u.get('completion_tokens_details') or {}).get('reasoning_tokens')} "
            f"| content={len(txt)}字 | JSON可用={ok}")
        return dt, ok
    except urllib.error.HTTPError as e:
        log(f"[{label}] HTTP {e.code} 耗时 {time.time()-t0:.1f}s: "
            + e.read().decode("utf-8", "ignore")[:200])
    except Exception as e:
        log(f"[{label}] 失败 耗时 {time.time()-t0:.1f}s: {type(e).__name__} {str(e)[:120]}")
    return None, False


log("=== A. 关闭思考模式（enable_thinking=false） ===")
call({"enable_thinking": False}, "关思考", 4000)
log("=== B. 关闭思考 + 放宽 max_tokens 8000 ===")
call({"enable_thinking": False}, "关思考+8k", 8000)
log("=== C. 默认（开着思考）===")
call({}, "默认思考", 4000)
log("完成")
