# -*- coding: utf-8 -*-
"""GEO 内容智能体｜本地服务（纯标准库，无第三方依赖）。"""

import json
import mimetypes
import os
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import generator, grouping, llm, parsers, prompts, render, seeds   # noqa: E402
from app.store import Store, get_upload_adapter     # noqa: E402

BASE = Path(__file__).resolve().parent.parent
WEB = BASE / "web"
STORE = Store()
LOCK = threading.Lock()
# 页面要显示"现在连的是哪个进程"。端口被旧窗口占着时，新进程会顺延到 8771，
# 浏览器旧标签还在 8770，看起来就像"改了代码没生效"。
SERVER_INFO = {"port": 0, "started_at": time.strftime("%Y-%m-%d %H:%M:%S")}


def mask_settings(s):
    out = dict(s)
    key = out.pop("api_key", "") or ""
    out["api_key_set"] = bool(key)
    out["api_key_hint"] = ("已保存（尾号 " + key[-4:] + "）") if len(key) > 8 else ("已保存" if key else "未填写")
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "GEOAgent/1.0"

    def log_message(self, fmt, *args):
        pass

    # ---------------------------------------------------------- 工具 ----
    def _send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _err(self, msg, code=400):
        self._json({"ok": False, "error": str(msg)}, code)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        raw = self.rfile.read(n).decode("utf-8", "ignore")
        try:
            return json.loads(raw) if raw.strip() else {}
        except Exception:
            return {}

    # ---------------------------------------------------------- 路由 ----
    def do_GET(self):
        try:
            u = urllib.parse.urlparse(self.path)
            p, q = u.path, urllib.parse.parse_qs(u.query)
            if p.startswith("/api/"):
                return self.route_get(p, q)
            return self.serve_static(p)
        except Exception as e:
            traceback.print_exc()
            self._err("服务器错误：" + str(e), 500)

    def do_POST(self):
        try:
            u = urllib.parse.urlparse(self.path)
            return self.route_write("POST", u.path, self._body())
        except Exception as e:
            traceback.print_exc()
            self._err("服务器错误：" + str(e), 500)

    def do_PUT(self):
        try:
            u = urllib.parse.urlparse(self.path)
            return self.route_write("PUT", u.path, self._body())
        except Exception as e:
            traceback.print_exc()
            self._err("服务器错误：" + str(e), 500)

    def do_DELETE(self):
        try:
            u = urllib.parse.urlparse(self.path)
            return self.route_write("DELETE", u.path, {})
        except Exception as e:
            traceback.print_exc()
            self._err("服务器错误：" + str(e), 500)

    def serve_static(self, p):
        if p in ("/", "/index.html"):
            f = WEB / "index.html"
        else:
            rel = p.lstrip("/")
            if rel.startswith("static/"):
                rel = rel[len("static/"):]
            f = (WEB / rel).resolve()
            if not str(f).startswith(str(WEB.resolve())):
                return self._err("非法路径", 403)
        if not f.exists() or f.is_dir():
            return self._err("页面不存在", 404)
        ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self._send(200, f.read_bytes(), ctype)

    # ---------------------------------------------------------- 流式 ----
    def _sse_send(self, obj):
        payload = json.dumps(obj, ensure_ascii=False)
        self.wfile.write(("data: " + payload + "\n\n").encode("utf-8"))
        self.wfile.flush()

    def _sse_stream(self, jid):
        """把生成中的原文增量推给前端。写到下一篇时会推一条 next，写完发一条 end。"""
        job = generator.get_job(jid)
        if not job:
            return self._err("任务不存在", 404)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        sent, idle, last_msg, seg = 0, 0, "", 0
        try:
            while True:
                j = generator.get_job(jid) or {}
                cur = int(j.get("seg") or 0)
                if cur != seg:
                    # 换到下一篇了：前端把上篇收进列表，面板清空重来
                    seg = cur
                    sent = 0
                    items = j.get("items") or []
                    self._sse_send({
                        "type": "next", "seg": cur,
                        "platform": j.get("platform") or "",
                        "account_type": j.get("account_type") or "",
                        "words": j.get("words") or [], "index": j.get("index") or 0,
                        "count": j.get("count") or 0,
                        "done": j.get("done") or 0, "planned": j.get("planned") or 0,
                        "total_all": j.get("total_all") or 0,
                        "prev": items[-1] if items else None,
                    })
                text = j.get("partial") or ""
                if len(text) > sent:
                    self._sse_send({"type": "chunk", "text": text[sent:], "chars": len(text)})
                    sent = len(text)
                    idle = 0
                else:
                    idle += 1
                # 阶段变化（比如进入核查）也推给前端，让用户知道还在干活
                msg = j.get("message") or ""
                if msg != last_msg:
                    last_msg = msg
                    self._sse_send({"type": "status", "message": msg,
                                    "phase": j.get("phase") or "",
                                    "done": j.get("done") or 0,
                                    "planned": j.get("planned") or 0})
                if j.get("status") in ("done", "error", "paused"):
                    self._sse_send({
                        "type": "end", "status": j.get("status"),
                        "title": j.get("title") or "", "message": j.get("message") or "",
                        "article_id": j.get("article_id"), "score": j.get("score"),
                        "error": j.get("error") or "", "platform": j.get("platform") or "",
                        "account_type": j.get("account_type") or "",
                        "words": j.get("words") or [],
                        "chars": j.get("chars") or len(text),
                        "audit": j.get("audit") or {},
                        "items": j.get("items") or [],
                        "done": j.get("done") or 0, "planned": j.get("planned") or 0,
                        "remaining": j.get("remaining") or 0,
                        "total_all": j.get("total_all") or 0,
                        "canceled": bool(j.get("cancel")),
                    })
                    break
                if idle >= 150:                      # 约 20 秒没新内容，发个心跳保活
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    idle = 0
                time.sleep(0.12)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass                            # 前端关掉页面了，安静收场

    # ------------------------------------------------------- GET 分支 ----
    def route_get(self, p, q):
        if p == "/api/bootstrap":
            return self._json({
                "ok": True,
                "models": STORE.list_models(),
                "platforms": STORE.list_platforms(),
                "prefs": STORE.get_prefs(),
                "risks": STORE.list_risks(),
                "settings": mask_settings(STORE.get_settings()),
                "levels": {"high": "高优先抓取", "mid": "中等抓取", "low": "低抓取"},
                "plans": STORE.list_plans()[:50],
                "server": dict(SERVER_INFO),
            })
        if p == "/api/risks":
            return self._json({"ok": True, "risks": STORE.list_risks()})
        if p == "/api/plans":
            return self._json({"ok": True, "plans": STORE.list_plans()})
        if p.startswith("/api/jobs/") and p.endswith("/stream"):
            seg = [x for x in p.strip("/").split("/") if x]
            return self._sse_stream(seg[2] if len(seg) > 2 else "")
        if p.startswith("/api/jobs/"):
            jid = p.rsplit("/", 1)[-1]
            j = generator.get_job(jid)
            if not j:
                return self._err("任务不存在", 404)
            return self._json({"ok": True, "job": j})
        if p.startswith("/api/plans/"):
            parts = p.strip("/").split("/")
            pid = int(parts[2])
            plan = STORE.get_plan(pid)
            if not plan:
                return self._err("方案不存在", 404)
            if len(parts) >= 4 and parts[3] == "next-task":
                brief = plan.get("brief") or {}
                task = generator.next_task(STORE, pid, brief)
                if not task:
                    return self._json({"ok": True, "task": None})
                return self._json({"ok": True, "task": {
                    "platform": task["platform"]["name"],
                    "words": task["group"], "keyword": task["keyword"],
                    "angle": task["angle"]["name"], "fmt": task["fmt"],
                    "account_type": task.get("account_type") or "personal",
                    "index": task["index"], "count": task.get("count"),
                    "round": task["round"],
                    "covered": task["covered"], "total_words": task["total_words"],
                }})

            if len(parts) >= 4 and parts[3] == "progress":
                brief = plan.get("brief") or {}
                kws = [k for k in (brief.get("keywords") or []) if k]
                sel = brief.get("selections") or []
                if kws and sel:
                    tasks, done_idx, pending = generator.pending_tasks(
                        STORE, pid, kws, sel, aliases=brief.get("aliases"),
                        platform_types=brief.get("platform_types"))
                    articles_n = len(STORE.list_articles(pid))
                    done_count = min(articles_n, len(tasks))
                    return self._json({"ok": True, "progress": {
                        "total": len(tasks), "done": sorted(done_idx),
                        "cursor": done_count, "done_count": done_count,
                        "articles": articles_n, "pending": len(pending),
                        "remaining": max(0, len(tasks) - articles_n)}})
                return self._json({"ok": True, "progress": STORE.get_progress(pid)})
            if len(parts) >= 4 and parts[3] == "export":
                fmt = (q.get("fmt") or ["md"])[0]
                if STORE.get_settings().get("title_prefix", True):
                    # 开关打开：所有稿件（含旧稿）统一补齐【平台·号种】前缀
                    plan = render.ensure_plan_prefix(plan)
                else:
                    plan = render.strip_plan_prefix(plan)
                raw_ids = (q.get("ids") or [""])[0].strip()
                ids = None
                if raw_ids:
                    ids = [x for x in raw_ids.split(",") if x.strip()]
                articles = render.pick_articles(plan, ids)
                if not articles:
                    return self._err("没有选中任何稿件，先在清单里勾几篇再导出")
                if fmt == "docx":
                    body_bytes = render.export_plan_docx(plan, ids)
                    fn = f"{render.safe_name(plan['title'] or plan['keyword'])}_{render.stamp()}.docx"
                    fn_enc = urllib.parse.quote(fn)
                    return self._send(
                        200, body_bytes,
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        {"Content-Disposition": f"attachment; filename*=UTF-8''{fn_enc}"})
                if fmt == "json":
                    text, ctype, ext = render.export_plan_json(plan, ids), "application/json; charset=utf-8", "json"
                elif fmt == "txt":
                    text, ctype, ext = render.export_plan_txt(plan, ids), "text/plain; charset=utf-8", "txt"
                else:
                    text, ctype, ext = render.export_plan_md(plan, ids), "text/markdown; charset=utf-8", "md"
                fn = f"{render.safe_name(plan['title'] or plan['keyword'])}_{render.stamp()}.{ext}"
                fn_enc = urllib.parse.quote(fn)
                return self._send(200, text.encode("utf-8"), ctype,
                                  {"Content-Disposition": f"attachment; filename*=UTF-8''{fn_enc}"})
            return self._json({"ok": True, "plan": plan})
        return self._err("接口不存在：" + p, 404)

    # ------------------------------------------------------- 写分支 ----
    def route_write(self, method, p, body):
        parts = [x for x in p.strip("/").split("/") if x]
        if parts and parts[0] == "api":
            parts = parts[1:]

        # 任务：暂停
        if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "stop" and method == "POST":
            ok = generator.cancel_job(parts[1])
            return self._json({"ok": ok,
                               "message": "好的，这一篇写完后停下" if ok else "任务不存在或已结束"})

        # 设置
        if p == "/api/settings" and method == "POST":
            patch = dict(body or {})
            if not patch.get("api_key"):
                patch.pop("api_key", None)
            s = STORE.save_settings(patch)
            return self._json({"ok": True, "settings": mask_settings(s)})
        if p == "/api/settings/test" and method == "POST":
            s = STORE.get_settings()
            try:
                return self._json({"ok": True, "msg": "连接成功，模型回复：" + llm.ping(s)})
            except Exception as e:
                return self._err(str(e))

        # 目标大模型
        if p == "/api/models":
            if method == "POST":
                name = (body.get("name") or "").strip()
                if not name:
                    return self._err("模型名称不能为空")
                if any(m["name"] == name for m in STORE.list_models()):
                    return self._err("这个模型已经存在了")
                STORE.add_model(name, body.get("note") or "")
                return self._json({"ok": True})
            return self._err("方法不支持", 405)
        if len(parts) == 2 and parts[0] == "models":
            mid = int(parts[1])
            if method == "PUT":
                name = (body.get("name") or "").strip()
                if name and any(m["name"] == name and m["id"] != mid
                                for m in STORE.list_models()):
                    return self._err("这个模型已经存在了")
                STORE.update_model(mid, body.get("name"), body.get("note"), body.get("enabled"))
                return self._json({"ok": True})
            if method == "DELETE":
                STORE.delete_model(mid)
                return self._json({"ok": True})

        # 分发平台
        if p == "/api/platforms" and method == "POST":
            raw = (body.get("name") or "").strip()
            name, hinted = seeds.split_platform_name(raw)
            if not name:
                return self._err("平台名称不能为空")
            if any(x["name"] == name for x in STORE.list_platforms()):
                return self._err(f"「{name}」已经存在了｜官方号和个人号在同一张卡片里分别设篇数")
            STORE.add_platform(name, body.get("formats"), body.get("style", ""),
                               body.get("length_hint", ""), body.get("structure_hint", ""),
                               body.get("audience", ""),
                               account_type=body.get("account_type") or hinted
                               or seeds.guess_account_type(raw))
            return self._json({"ok": True})
        if len(parts) == 2 and parts[0] == "platforms":
            pid = int(parts[1])
            if method == "PUT":
                raw = (body.get("name") or "").strip()
                name, hinted = seeds.split_platform_name(raw)
                if name and any(x["name"] == name and x["id"] != pid
                                for x in STORE.list_platforms()):
                    return self._err("这个平台名称已经存在了")
                kw = dict(body)
                if name:
                    kw["name"] = name
                if hinted and not body.get("account_type"):
                    kw["account_type"] = hinted
                STORE.update_platform(pid, **kw)
                return self._json({"ok": True})
            if method == "DELETE":
                STORE.delete_platform(pid)
                return self._json({"ok": True})

        # 偏好表
        if p == "/api/prefs" and method == "POST":
            STORE.set_pref(int(body["model_id"]), int(body["platform_id"]), body.get("level", "mid"))
            return self._json({"ok": True})

        # 风险清单
        if p == "/api/risks" and method == "POST":
            if not (body.get("item") or "").strip():
                return self._err("风险内容不能为空")
            STORE.add_risk(body["item"].strip(), body.get("platform_id"),
                           body.get("category") or "通用风控", body.get("level") or "中",
                           body.get("tip") or "")
            return self._json({"ok": True})
        if len(parts) == 2 and parts[0] == "risks":
            rid = int(parts[1])
            if method == "PUT":
                STORE.update_risk(rid, **body)
                return self._json({"ok": True})
            if method == "DELETE":
                STORE.delete_risk(rid)
                return self._json({"ok": True})

        # 别名识别：找出中英文对、型号变体等疑似同一实体的写法
        if p == "/api/aliases" and method == "POST":
            kws = [k.strip() for k in (body.get("keywords") or []) if k and k.strip()]
            groups = grouping.find_aliases(kws)
            return self._json({
                "ok": True,
                "groups": [{"words": g, "label": " ⟷ ".join(g)} for g in groups],
                "before": len(kws),
                "after": len(kws) - sum(len(g) - 1 for g in groups),
            })

        # 关键词分组预览：前端要展示"每篇覆盖哪些词"
        if p == "/api/preview-groups" and method == "POST":
            kws = [k.strip() for k in (body.get("keywords") or []) if k and k.strip()]
            if not kws:
                return self._err("还没有关键词")
            plats = {x["id"]: x for x in STORE.list_platforms()}
            out = []
            for sel in body.get("selections") or []:
                pid = int(sel.get("platform_id") or 0)
                platform = plats.get(pid)
                if not platform:
                    continue
                count = max(1, int(sel.get("count", 1)))
                groups = grouping.split_keywords(kws, count,
                                                aliases=body.get("aliases") or [])
                out.append({
                    "platform_id": pid,
                    "platform_name": platform["name"],
                    "count": count,
                    "groups": [{"primary": g[0], "words": g} for g in groups],
                })
            return self._json({"ok": True, "total": sum(x["count"] for x in out), "items": out})

        # 资料解析（不落库，先给用户核对）
        if p == "/api/parse" and method == "POST":
            import base64
            name = (body.get("filename") or "").strip()
            if not name:
                return self._err("缺少文件名")
            try:
                data = base64.b64decode(body.get("content_b64") or "", validate=False)
            except Exception:
                return self._err("文件内容读取失败，请重新选择一次")
            try:
                r = parsers.parse_file(name, data)
            except parsers.Unsupported as e:
                return self._err(str(e))
            except parsers.ParseError as e:
                return self._err(str(e))
            r["filename"] = name
            return self._json(r)

        # 资料批量保存（整批替换，避免反复上一步产生重复）
        if p == "/api/materials/bulk" and method == "POST":
            pid = int(body.get("plan_id") or 0)
            if not pid or not STORE.get_plan(pid):
                return self._err("方案不存在", 404)
            ids = STORE.replace_materials(pid, body.get("items") or [])
            return self._json({"ok": True, "count": len(ids), "materials": STORE.list_materials(pid)})

        # 资料
        if len(parts) == 2 and parts[0] == "materials":
            mid = int(parts[1])
            if method == "PUT":
                STORE.update_material(mid, body.get("text"), body.get("filename"))
                return self._json({"ok": True})
            if method == "DELETE":
                STORE.delete_material(mid)
                return self._json({"ok": True})

        # 方案
        if p == "/api/plans" and method == "POST":
            brief = body.get("brief") or {}
            keywords = [k.strip() for k in (brief.get("keywords") or []) if k and k.strip()]
            kw = (body.get("keyword") or (keywords[0] if keywords else "")).strip()
            if not kw:
                return self._err("请先填写至少一个目标搜索关键词")
            if not keywords:
                keywords = [kw]
                brief["keywords"] = keywords
            title = (body.get("title") or kw + " 内容方案").strip()
            pid = STORE.create_plan(kw, title, brief)
            return self._json({"ok": True, "plan_id": pid})

        if len(parts) == 2 and parts[0] == "plans" and method == "PUT":
            pid = int(parts[1])
            plan = STORE.get_plan(pid)
            if not plan:
                return self._err("方案不存在", 404)
            brief = body.get("brief")
            if brief is not None:
                keywords = [k.strip() for k in (brief.get("keywords") or []) if k and k.strip()]
                if not keywords:
                    return self._err("请至少保留一个目标搜索关键词")
                brief["keywords"] = keywords
                STORE.update_plan(pid, brief=brief, keyword=keywords[0],
                                  title=body.get("title") or plan["title"])
            elif (body.get("title") or "").strip():
                # 只改标题也要生效（原来只在带 brief 时才更新）
                STORE.update_plan(pid, title=body["title"].strip())
            return self._json({"ok": True})

        if len(parts) >= 2 and parts[0] == "plans":
            try:
                pid = int(parts[1])
            except Exception:
                return self._err("方案 ID 不正确")
            if method == "DELETE" and len(parts) == 2:
                STORE.delete_plan(pid)
                return self._json({"ok": True})

            if len(parts) == 3 and parts[2] == "generate" and method == "POST":
                plan = STORE.get_plan(pid)
                if not plan:
                    return self._err("方案不存在", 404)
                sel = body.get("selections") or []
                if not sel:
                    return self._err("请至少选择一个分发平台")
                settings = STORE.get_settings()
                if not settings.get("api_key"):
                    return self._err("还没有配置大模型 API Key，请点右上角「设置」填写后再生成")
                brief = dict(plan["brief"] or {})
                if body.get("keywords"):
                    brief["keywords"] = [k.strip() for k in body["keywords"] if k and k.strip()]
                keywords = [k for k in (brief.get("keywords") or []) if k and k.strip()]
                if not keywords:
                    keywords = [plan.get("keyword") or ""]
                keywords = [k for k in keywords if k]
                if not keywords:
                    return self._err("方案里没有目标关键词，请回到第一步填写")
                brief["keywords"] = keywords
                brief["keyword"] = keywords[0]
                if body.get("rivals") is not None:
                    brief["rivals"] = body["rivals"]
                elif body.get("keyword_brands") is not None:
                    brief["keyword_brands"] = body["keyword_brands"]
                brief["models"] = body.get("models", brief.get("models") or [])
                brief["platforms"] = body.get("platforms", brief.get("platforms") or [])
                # 存下本次的篇数设置，进度接口和"回第二步"都要靠它还原
                brief["selections"] = sel
                snapshot = self._snapshot(brief)
                brief["snapshot"] = snapshot
                STORE.update_plan(pid, brief=brief, status="generating")
                batch_size = max(1, min(10, int(body.get("batch_size") or 3)))
                tasks = generator.build_task_queue(
                    STORE, keywords, sel, aliases=brief.get("aliases") or [],
                    platform_types=brief.get("platform_types") or {})
                total_all = len(tasks)
                articles_n = len(STORE.list_articles(pid))
                remaining = max(0, total_all - articles_n)
                jid = generator.new_job(pid, min(batch_size, remaining))
                generator.start_generate_thread(STORE, pid, brief, sel, jid, batch_size)
                return self._json({
                    "ok": True, "job_id": jid, "total": total_all,
                    "batch": min(batch_size, remaining),
                    "cursor": min(articles_n, total_all), "remaining": remaining,
                    "snapshot": snapshot,
                })

            if len(parts) == 3 and parts[2] == "auto" and method == "POST":
                plan = STORE.get_plan(pid)
                if not plan:
                    return self._err("方案不存在", 404)
                settings = STORE.get_settings()
                if not settings.get("api_key"):
                    return self._err("还没有配置大模型 API Key，请点右上角「设置」填写后再生成")
                brief = dict(plan.get("brief") or {})
                for key in ("keywords", "platforms", "models", "rivals", "aliases",
                            "platform_types", "selections"):
                    if body.get(key) is not None:
                        brief[key] = body[key]
                if body.get("keywords"):
                    kws = [k.strip() for k in body["keywords"] if k and k.strip()]
                    if not kws:
                        return self._err("请至少保留一个目标关键词")
                    brief["keywords"] = kws
                    brief["keyword"] = kws[0]
                prepared = generator._prepare_brief(STORE, pid, brief)
                if not prepared:
                    return self._err("方案里没有目标关键词，请回到第一步填写")
                tasks, _done, pending = generator.pending_tasks(
                    STORE, pid, prepared["keywords"], prepared["selections"],
                    prepared.get("aliases"), prepared.get("platform_types"))
                if not tasks:
                    return self._err("每个平台的篇数都是 0，先回第二步设置篇数")
                if not pending:
                    return self._err("这份方案已经全部写完了；想再多写就回第二步把篇数加上去")
                brief["selections"] = prepared["selections"]
                brief["snapshot"] = brief.get("snapshot") or self._snapshot(brief)
                STORE.update_plan(pid, brief=brief, status="generating")
                jid = generator.new_job(pid, len(pending), kind="auto")
                generator.start_auto_thread(STORE, pid, brief, jid)
                return self._json({
                    "ok": True, "job_id": jid, "planned": len(pending),
                    "total": len(tasks), "done": len(tasks) - len(pending),
                })

            if len(parts) == 3 and parts[2] == "write-one" and method == "POST":
                plan = STORE.get_plan(pid)
                if not plan:
                    return self._err("方案不存在", 404)
                brief = dict(plan.get("brief") or {})
                for key in ("keywords", "platforms", "models", "rivals", "aliases",
                            "platform_types", "selections"):
                    if body.get(key) is not None:
                        brief[key] = body[key]
                if body.get("keywords"):
                    kws = [k.strip() for k in body["keywords"] if k and k.strip()]
                    if not kws:
                        return self._err("请至少保留一个目标关键词")
                    brief["keywords"] = kws
                    brief["keyword"] = kws[0]
                STORE.update_plan(pid, brief=brief)
                task = generator.next_task(STORE, pid, brief)
                if not task:
                    return self._err("没有可写的任务了：检查各平台的篇数设置是否还是 0")
                jid = generator.new_job(pid, 1, kind="write-one")
                generator.start_write_thread(STORE, pid, brief, jid)
                return self._json({
                    "ok": True, "job_id": jid,
                    "task": {
                        "platform": task["platform"]["name"],
                        "words": task["group"], "keyword": task["keyword"],
                        "angle": task["angle"]["name"], "fmt": task["fmt"],
                        "account_type": task.get("account_type") or "personal",
                        "index": task["index"], "count": task.get("count"),
                        "round": task["round"], "covered": task["covered"],
                        "total_words": task["total_words"],
                    },
                })

            if len(parts) == 3 and parts[2] == "reset-progress" and method == "POST":
                STORE.clear_progress(pid)
                return self._json({"ok": True})

            if len(parts) == 3 and parts[2] == "upload" and method == "POST":
                plan = STORE.get_plan(pid)
                if not plan:
                    return self._err("方案不存在", 404)
                if not plan["articles"]:
                    return self._err("这份方案还没有稿件，先完成生成再上传")
                settings = STORE.get_settings()
                adapter = get_upload_adapter(settings)
                try:
                    target = adapter.push(plan, settings)
                except Exception as e:
                    return self._err("上传失败：" + str(e))
                STORE.add_archive(pid, adapter.name, target)
                STORE.update_plan(pid, status="archived")
                return self._json({"ok": True, "target": target, "mode": adapter.name})

            if len(parts) == 3 and parts[2] == "clone" and method == "POST":
                plan = STORE.get_plan(pid)
                if not plan:
                    return self._err("方案不存在", 404)
                new_id = STORE.create_plan(plan["keyword"], plan["title"] + "（复用）", plan["brief"])
                for a in plan["articles"]:
                    STORE.add_article(
                        new_id, platform_id=a["platform_id"], platform_name=a["platform_name"],
                        fmt=a["fmt"], model_name=a["model_name"], angle=a["angle"],
                        account_type=a.get("account_type", ""),
                        keyword=a.get("keyword", ""),
                        title=a["title"], body_md=a["body_md"], tags=a["tags"],
                        decl=a["decl"], risk_tips=a["risk_tips"], geo=a["geo"])
                if plan.get("materials"):
                    STORE.replace_materials(new_id, [
                        {"filename": m["filename"], "kind": m["kind"], "text": m["text"]}
                        for m in plan["materials"]])
                return self._json({"ok": True, "plan_id": new_id})

        # 单篇
        if len(parts) == 3 and parts[0] == "articles":
            aid = int(parts[1])
            if method == "POST" and parts[2] == "audit":
                plan_id = self._article_plan(aid)
                if not plan_id:
                    return self._err("稿件不存在", 404)
                plan = STORE.get_plan(plan_id) or {}
                try:
                    result = generator.audit_article(
                        STORE, STORE.get_settings(), aid, plan.get("brief") or {})
                except Exception as e:                       # noqa: BLE001
                    return self._err("核查失败：" + str(e)[:140])
                if not result.get("ok"):
                    return self._err(result.get("error") or "核查失败")
                return self._json({"ok": True, "audit": result,
                                   "article": STORE.get_article(aid)})

            if method == "POST" and parts[2] == "restore":
                art = STORE.get_article(aid)
                if not art:
                    return self._err("稿件不存在", 404)
                orig = (art.get("body_original") or "").strip()
                if not orig:
                    return self._err("这篇没有核查前的版本可以还原")
                STORE.update_article(aid, body_md=orig, body_original="", audit={})
                plan_id = art["plan_id"]
                plan = STORE.get_plan(plan_id) or {}
                brief = plan.get("brief") or {}
                saved = STORE.get_article(aid)
                platforms = {p["id"]: p for p in STORE.list_platforms()}
                platform = platforms.get(saved.get("platform_id")) or {}
                extras = [w for w in (saved.get("keywords") or [])
                          if w != saved.get("keyword")]
                geo = render.geo_check(
                    saved, saved.get("keyword") or "", (brief.get("brand") or "").strip(),
                    prompts.brands_for(brief), extras,
                    company=(brief.get("company") or "").strip(),
                    account_type=generator.account_type_of(platform, brief),
                    require_risk_notes=True)
                STORE.update_article(aid, geo=geo)
                return self._json({"ok": True, "article": STORE.get_article(aid)})

            if method == "POST" and parts[2] == "regenerate":
                plan_id = self._article_plan(aid)
                if not plan_id:
                    return self._err("稿件不存在", 404)
                jid = generator.new_job(plan_id, 1, kind="regenerate")
                generator.start_regenerate_thread(STORE, aid, jid, body.get("note") or "")
                return self._json({"ok": True, "job_id": jid})

        if len(parts) == 2 and parts[0] == "articles":
            aid = int(parts[1])
            if method == "PUT":
                if body.get("title") is not None and not str(body["title"]).strip():
                    return self._err("标题不能为空")
                STORE.update_article(
                    aid, title=body.get("title"), body_md=body.get("body_md"),
                    tags=body.get("tags"), decl=body.get("decl"), risk_tips=body.get("risk_tips"))
                plan_id = self._article_plan(aid)
                if plan_id:
                    plan = STORE.get_plan(plan_id)
                    brief = (plan or {}).get("brief") or {}
                    saved = [a for a in STORE.list_articles(plan_id) if a["id"] == aid]
                    if saved:
                        kw = saved[0].get("keyword") or (plan or {}).get("keyword", "")
                        extras = [x for x in (saved[0].get("keywords") or []) if x != kw]
                        geo = render.geo_check(
                            saved[0], kw, (brief.get("brand") or "").strip(),
                            prompts.brands_for(brief), extras,
                            company=(brief.get("company") or "").strip(),
                            account_type=generator.account_type_of(
                                {"id": saved[0]["platform_id"]}, brief))
                        STORE.update_article(aid, geo=geo)
                        return self._json({"ok": True, "geo": geo})
                return self._json({"ok": True})
            if method == "DELETE":
                STORE.delete_article(aid)
                return self._json({"ok": True})

        return self._err("接口不存在：" + p + "（" + method + "）", 404)

    def _article_plan(self, aid):
        with STORE.conn() as c:
            r = c.execute("SELECT plan_id FROM articles WHERE id=?", (aid,)).fetchone()
        return r["plan_id"] if r else None

    def _snapshot(self, brief):
        """生成时固化一份「偏好对照表 + 风险清单」快照，便于随方案一起导出。"""
        models = brief.get("models") or []
        plats = brief.get("platforms") or []
        mrows = [m for m in STORE.list_models() if not models or m["name"] in models]
        prows = [p for p in STORE.list_platforms() if not plats or p["name"] in plats]
        prefs = STORE.get_prefs()
        matrix = []
        for m in mrows:
            row = {"model": m["name"], "cells": []}
            for p in prows:
                lv = next((x["level"] for x in prefs
                           if x["model_id"] == m["id"] and x["platform_id"] == p["id"]), "mid")
                row["cells"].append({"platform": p["name"], "level": lv})
            matrix.append(row)
        risks = []
        all_risks = STORE.list_risks()
        for p in prows:
            items = [r for r in all_risks if r["platform_id"] is None] + \
                    [r for r in all_risks if r["platform_id"] == p["id"]]
            risks.append({
                "platform": p["name"],
                "items": [{"category": r["category"], "item": r["item"], "level": r["level"], "tip": r["tip"]}
                          for r in items],
            })
        return {"matrix": matrix, "risks": risks,
                "levels": {"high": "高优先抓取", "mid": "中等抓取", "low": "低抓取"},
                "created_at": time.strftime("%Y-%m-%d %H:%M:%S")}


def _running_instance(port):
    """这个端口上跑的是不是我们自己的程序（而不是别的软件）。"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/bootstrap", timeout=1.2) as r:
            data = json.loads(r.read().decode("utf-8")) or {}
        return bool(data.get("ok") and "platforms" in data)
    except Exception:
        return False


def main():
    port = int(os.environ.get("GEO_PORT", "8770"))
    # 避免 Windows 上两个进程同时绑定同一端口造成"旧页面还开着"的错觉
    ThreadingHTTPServer.allow_reuse_address = False
    force = "--force" in sys.argv
    for i in range(20):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port + i), Handler)
            break
        except OSError:
            if i == 0 and not force and _running_instance(port):
                # 再起一个进程会同时写同一个数据库，宁可不开
                url = f"http://127.0.0.1:{port}/"
                print("=" * 56)
                print("  程序已经在运行了（%d 端口），不再重复启动。" % port)
                print("  已为你打开原页面：" + url)
                print("  要重启的话，先关掉原来那个黑窗口，再双击一次。")
                print("=" * 56)
                if "--no-browser" not in sys.argv and not os.environ.get("GEO_NO_BROWSER"):
                    webbrowser.open(url)
                return
            continue
    else:
        print("端口都被占用了，请先关闭其他程序")
        return
    url = f"http://127.0.0.1:{port + i}/"
    SERVER_INFO["port"] = port + i
    print("=" * 56)
    if i:
        print("  [!] %d 端口已经被占用" % port)
        print("      多半是上一次的窗口还没关，浏览器也还连在旧页面。")
        print("      本次启动在 %d，请用下面的地址；然后关掉旧窗口。" % (port + i))
        print("-" * 56)
    print("  GEO 内容智能体已启动")
    print("  请用浏览器打开：" + url)
    print("  关闭这个黑窗口即退出程序")
    print("=" * 56)
    if "--no-browser" not in sys.argv and not os.environ.get("GEO_NO_BROWSER"):
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")


if __name__ == "__main__":
    main()
