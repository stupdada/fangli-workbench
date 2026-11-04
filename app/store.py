# -*- coding: utf-8 -*-
"""数据层：SQLite 持久化 + 可替换的上传适配器（本地归档 / HTTP 云端）。"""

import json
import os
import sqlite3
import time
import urllib.request
from pathlib import Path

from . import seeds

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = Path(os.environ.get("GEO_DB") or (DATA_DIR / "geo.db"))


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _dumps(v):
    return json.dumps(v, ensure_ascii=False)


def _loads(s, default):
    if not s:
        return default
    try:
        return json.loads(s)
    except Exception:
        return default


class Store:
    def __init__(self, db_path=None):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.db_path = str(db_path or DB_PATH)
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()
        self._seed_if_empty()
        self._normalize_platform_names()
        self._recover_interrupted()

    def _normalize_platform_names(self):
        """平台名里的「企业号 / 个人号」后缀挪到 account_type，只跑一次。

        老库里平台叫「抖音企业号」，卡片上又有一行官方号 / 个人号的篇数，
        名字和账号类型重复表达同一件事。这里把名字收敛成「抖音」，账号类型
        交给字段本身；方案里已生成稿件记录的 platform_name 同步改掉，
        历史稿件读起来不会出现「抖音企业号 · 官方号」这种叠字。
        """
        with self.conn() as c:
            if c.execute("SELECT v FROM meta WHERE k='platform_norm_v1'").fetchone():
                return
            for r in c.execute("SELECT id,name,account_type FROM platforms").fetchall():
                clean, hinted = seeds.split_platform_name(r["name"])
                if clean == r["name"] or not clean:
                    continue
                c.execute("UPDATE platforms SET name=?, account_type=? WHERE id=?",
                          (clean, hinted or r["account_type"] or "personal", r["id"]))
                c.execute("UPDATE articles SET platform_name=? WHERE platform_id=?",
                          (clean, r["id"]))
            c.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('platform_norm_v1','1')")

    def _recover_interrupted(self):
        """生成任务只存在内存里。程序重启后，卡在「生成中」但已有稿件的方案要归位，
        否则用户会一直看到一个永远转圈的方案。"""
        with self.conn() as c:
            c.execute(
                "UPDATE plans SET status='generated' WHERE status='generating' "
                "AND EXISTS(SELECT 1 FROM articles WHERE articles.plan_id = plans.id)")
            c.execute(
                "UPDATE plans SET status='draft' WHERE status='generating' "
                "AND NOT EXISTS(SELECT 1 FROM articles WHERE articles.plan_id = plans.id)")

    # ----------------------------------------------------------- 基础 ----
    def conn(self):
        c = sqlite3.connect(self.db_path, timeout=15)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        return c

    def _init_schema(self):
        with self.conn() as c:
            c.executescript(
                """
                CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

                CREATE TABLE IF NOT EXISTS models (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL,
                    note TEXT DEFAULT '',
                    enabled INTEGER DEFAULT 1,
                    sort INTEGER DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS platforms (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL,
                    formats TEXT DEFAULT '["图文"]',
                    style TEXT DEFAULT '',
                    length_hint TEXT DEFAULT '',
                    structure_hint TEXT DEFAULT '',
                    audience TEXT DEFAULT '',
                    account_type TEXT DEFAULT 'personal',
                    enabled INTEGER DEFAULT 1,
                    sort INTEGER DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS prefs (
                    model_id INTEGER NOT NULL,
                    platform_id INTEGER NOT NULL,
                    level TEXT DEFAULT 'mid',
                    PRIMARY KEY (model_id, platform_id)
                );

                CREATE TABLE IF NOT EXISTS risks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform_id INTEGER,
                    category TEXT DEFAULT '通用风控',
                    item TEXT NOT NULL,
                    level TEXT DEFAULT '中',
                    tip TEXT DEFAULT '',
                    sort INTEGER DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS plans (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    keyword TEXT NOT NULL,
                    title TEXT DEFAULT '',
                    brief TEXT DEFAULT '{}',
                    status TEXT DEFAULT 'draft',
                    created_at TEXT,
                    updated_at TEXT
                );

                CREATE TABLE IF NOT EXISTS articles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    plan_id INTEGER NOT NULL,
                    platform_id INTEGER,
                    platform_name TEXT,
                    fmt TEXT DEFAULT '图文',
                    model_name TEXT DEFAULT '',
                    angle TEXT DEFAULT '',
                    account_type TEXT DEFAULT '',
                    keyword TEXT DEFAULT '',
                    keywords TEXT DEFAULT '[]',
                    title TEXT DEFAULT '',
                    body_md TEXT DEFAULT '',
                    tags TEXT DEFAULT '[]',
                    decl TEXT DEFAULT '[]',
                    risk_tips TEXT DEFAULT '[]',
                    geo TEXT DEFAULT '{}',
                    audit TEXT DEFAULT '{}',
                    body_original TEXT DEFAULT '',
                    sort INTEGER DEFAULT 0,
                    created_at TEXT,
                    updated_at TEXT
                );

                CREATE TABLE IF NOT EXISTS archives (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    plan_id INTEGER NOT NULL,
                    target TEXT,
                    path TEXT,
                    created_at TEXT
                );

                CREATE TABLE IF NOT EXISTS plan_progress (
                    plan_id INTEGER PRIMARY KEY,
                    cursor INTEGER DEFAULT 0,
                    total INTEGER DEFAULT 0,
                    done TEXT DEFAULT '[]',
                    signature TEXT DEFAULT '',
                    failed TEXT DEFAULT '[]',
                    updated_at TEXT
                );

                CREATE TABLE IF NOT EXISTS materials (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    plan_id INTEGER NOT NULL,
                    filename TEXT,
                    kind TEXT,
                    chars INTEGER DEFAULT 0,
                    text TEXT,
                    created_at TEXT
                );
                """
            )
            # 老库升级：补上 keywords 相关的新字段
            cols = [r["name"] for r in c.execute("PRAGMA table_info(articles)")]
            if "keyword" not in cols:
                c.execute("ALTER TABLE articles ADD COLUMN keyword TEXT DEFAULT ''")
            if "keywords" not in cols:
                c.execute("ALTER TABLE articles ADD COLUMN keywords TEXT DEFAULT '[]'")

            if "audit" not in cols:
                c.execute("ALTER TABLE articles ADD COLUMN audit TEXT DEFAULT '{}'")
            if "body_original" not in cols:
                c.execute("ALTER TABLE articles ADD COLUMN body_original TEXT DEFAULT ''")
            if "account_type" not in cols:
                # 每篇记下用的是官方号还是个人号：按平台的号种配额写稿要靠它统计
                c.execute("ALTER TABLE articles ADD COLUMN account_type TEXT DEFAULT ''")
                c.execute(
                    "UPDATE articles SET account_type=COALESCE("
                    "(SELECT account_type FROM platforms WHERE platforms.id=articles.platform_id),'personal')"
                    " WHERE IFNULL(account_type,'')=''")

            pcols = [r["name"] for r in c.execute("PRAGMA table_info(platforms)")]
            if "account_type" not in pcols:
                c.execute("ALTER TABLE platforms ADD COLUMN account_type TEXT DEFAULT 'personal'")
                c.execute("UPDATE platforms SET account_type='official' "
                          "WHERE name LIKE '%企业号%' OR name LIKE '%机构号%' OR name LIKE '%官方%'")
            pcols = [r["name"] for r in c.execute("PRAGMA table_info(plan_progress)")]
            if "done" not in pcols:
                c.execute("ALTER TABLE plan_progress ADD COLUMN done TEXT DEFAULT '[]'")

    def _seed_if_empty(self):
        with self.conn() as c:
            n = c.execute("SELECT COUNT(*) FROM platforms").fetchone()[0]
            if n:
                return
            t = now()
            for i, p in enumerate(seeds.PLATFORMS):
                c.execute(
                    "INSERT INTO platforms(name,formats,style,length_hint,structure_hint,audience,"
                    "account_type,enabled,sort) VALUES(?,?,?,?,?,?,?,1,?)",
                    (p["name"], _dumps(p["formats"]), p["style"], p["length_hint"],
                     p["structure_hint"], p["audience"],
                     p.get("account_type") or seeds.guess_account_type(p["name"]), i),
                )
            for i, m in enumerate(seeds.MODELS):
                c.execute("INSERT INTO models(name,note,enabled,sort) VALUES(?,?,1,?)",
                          (m["name"], m["note"], i))
            models = {r["name"]: r["id"] for r in c.execute("SELECT id,name FROM models")}
            plats = {r["name"]: r["id"] for r in c.execute("SELECT id,name FROM platforms")}
            for mname, row in seeds.DEFAULT_PREFS.items():
                for pname, level in row.items():
                    if mname in models and pname in plats:
                        c.execute("INSERT OR REPLACE INTO prefs(model_id,platform_id,level) VALUES(?,?,?)",
                                  (models[mname], plats[pname], level))
            sort = 0
            for cat, item, level, tip in seeds.COMMON_RISKS:
                c.execute("INSERT INTO risks(platform_id,category,item,level,tip,sort) VALUES(NULL,?,?,?,?,?)",
                          (cat, item, level, tip, sort))
                sort += 1
            for pname, rows in seeds.PLATFORM_RISKS.items():
                pid = plats.get(pname)
                if not pid:
                    continue
                sort = 0
                for cat, item, level, tip in rows:
                    c.execute("INSERT INTO risks(platform_id,category,item,level,tip,sort) VALUES(?,?,?,?,?,?)",
                              (pid, cat, item, level, tip, sort))
                    sort += 1
            c.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('seeded_at',?)", (t,))

    # ------------------------------------------------------------ 设置 ----
    def get_meta(self, k, default=None):
        with self.conn() as c:
            r = c.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return r["v"] if r else default

    def set_meta(self, k, v):
        with self.conn() as c:
            c.execute("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", (k, str(v)))

    def get_settings(self):
        raw = self.get_meta("settings", "{}")
        s = _loads(raw, {})
        s.setdefault("api_base", "https://api.deepseek.com/v1")
        s.setdefault("api_key", "")
        s.setdefault("model", "deepseek-chat")
        s.setdefault("temperature", 0.8)
        s.setdefault("max_tokens", 4000)
        s.setdefault("upload_mode", "local")
        s.setdefault("upload_url", "")
        s.setdefault("upload_token", "")
        s.setdefault("brand", "")
        s.setdefault("disable_thinking", True)
        s.setdefault("title_prefix", True)
        return s

    def save_settings(self, patch):
        s = self.get_settings()
        for k, v in patch.items():
            if k in ("api_base", "api_key", "model", "upload_mode", "upload_url", "upload_token", "brand"):
                s[k] = str(v or "").strip()
            elif k == "temperature":
                try:
                    s[k] = max(0.0, min(1.5, float(v)))
                except Exception:
                    pass
            elif k == "disable_thinking":
                s[k] = bool(v)
            elif k == "title_prefix":
                s[k] = bool(v)
            elif k == "max_tokens":
                try:
                    s[k] = max(800, min(8000, int(v)))
                except Exception:
                    pass
        self.set_meta("settings", _dumps(s))
        return s

    # ------------------------------------------------------ 模型 / 平台 ----
    def list_models(self):
        with self.conn() as c:
            return [dict(r) for r in c.execute("SELECT * FROM models ORDER BY sort,id")]

    def add_model(self, name, note=""):
        with self.conn() as c:
            n = c.execute("SELECT COALESCE(MAX(sort),0)+1 FROM models").fetchone()[0]
            cur = c.execute("INSERT INTO models(name,note,enabled,sort) VALUES(?,?,1,?)", (name, note, n))
            mid = cur.lastrowid
            for r in c.execute("SELECT id FROM platforms"):
                c.execute("INSERT OR IGNORE INTO prefs(model_id,platform_id,level) VALUES(?,?,'mid')",
                          (mid, r["id"]))
        return mid

    def update_model(self, mid, name=None, note=None, enabled=None):
        with self.conn() as c:
            if name:
                c.execute("UPDATE models SET name=? WHERE id=?", (name, mid))
            if note is not None:
                c.execute("UPDATE models SET note=? WHERE id=?", (note, mid))
            if enabled is not None:
                c.execute("UPDATE models SET enabled=? WHERE id=?", (1 if enabled else 0, mid))

    def delete_model(self, mid):
        with self.conn() as c:
            c.execute("DELETE FROM models WHERE id=?", (mid,))
            c.execute("DELETE FROM prefs WHERE model_id=?", (mid,))

    def list_platforms(self):
        with self.conn() as c:
            rows = [dict(r) for r in c.execute("SELECT * FROM platforms ORDER BY sort,id")]
        for r in rows:
            r["formats"] = _loads(r["formats"], ["图文"])
        return rows

    def add_platform(self, name, formats=None, style="", length_hint="", structure_hint="", audience="",
                     account_type=None):
        with self.conn() as c:
            n = c.execute("SELECT COALESCE(MAX(sort),0)+1 FROM platforms").fetchone()[0]
            cur = c.execute(
                "INSERT INTO platforms(name,formats,style,length_hint,structure_hint,audience,"
                "account_type,enabled,sort) VALUES(?,?,?,?,?,?,?,1,?)",
                (name, _dumps(formats or ["图文"]), style, length_hint, structure_hint, audience,
                 account_type or "personal", n))
            pid = cur.lastrowid
            for r in c.execute("SELECT id FROM models"):
                c.execute("INSERT OR IGNORE INTO prefs(model_id,platform_id,level) VALUES(?,?,'mid')",
                          (r["id"], pid))
        return pid

    def update_platform(self, pid, **kw):
        fields, vals = [], []
        for k in ("name", "style", "length_hint", "structure_hint", "audience", "enabled", "account_type"):
            if k in kw and kw[k] is not None:
                fields.append(f"{k}=?")
                vals.append(1 if k == "enabled" and kw[k] else (0 if k == "enabled" else kw[k]))
        if "formats" in kw and kw["formats"]:
            fields.append("formats=?")
            vals.append(_dumps(kw["formats"]))
        if not fields:
            return
        vals.append(pid)
        with self.conn() as c:
            c.execute(f"UPDATE platforms SET {','.join(fields)} WHERE id=?", vals)

    def delete_platform(self, pid):
        with self.conn() as c:
            c.execute("DELETE FROM platforms WHERE id=?", (pid,))
            c.execute("DELETE FROM prefs WHERE platform_id=?", (pid,))
            c.execute("DELETE FROM risks WHERE platform_id=?", (pid,))

    # ------------------------------------------------------------ 偏好 ----
    def get_prefs(self):
        with self.conn() as c:
            rows = c.execute("SELECT * FROM prefs").fetchall()
        return [{"model_id": r["model_id"], "platform_id": r["platform_id"], "level": r["level"]}
                for r in rows]

    def set_pref(self, model_id, platform_id, level):
        with self.conn() as c:
            c.execute("INSERT OR REPLACE INTO prefs(model_id,platform_id,level) VALUES(?,?,?)",
                      (model_id, platform_id, level))

    # ------------------------------------------------------------ 风险 ----
    def list_risks(self):
        with self.conn() as c:
            rows = [dict(r) for r in c.execute("SELECT * FROM risks ORDER BY platform_id IS NOT NULL, platform_id, sort, id")]
        return rows

    def add_risk(self, item, platform_id=None, category="通用风控", level="中", tip=""):
        with self.conn() as c:
            n = c.execute("SELECT COALESCE(MAX(sort),0)+1 FROM risks WHERE platform_id IS ?",
                          (platform_id,)).fetchone()[0]
            cur = c.execute(
                "INSERT INTO risks(platform_id,category,item,level,tip,sort) VALUES(?,?,?,?,?,?)",
                (platform_id, category, item, level, tip, n))
        return cur.lastrowid

    def update_risk(self, rid, **kw):
        fields, vals = [], []
        for k in ("category", "item", "level", "tip"):
            if k in kw and kw[k] is not None:
                fields.append(f"{k}=?")
                vals.append(kw[k])
        if not fields:
            return
        vals.append(rid)
        with self.conn() as c:
            c.execute(f"UPDATE risks SET {','.join(fields)} WHERE id=?", vals)

    def delete_risk(self, rid):
        with self.conn() as c:
            c.execute("DELETE FROM risks WHERE id=?", (rid,))

    # ------------------------------------------------------------ 方案 ----
    def create_plan(self, keyword, title, brief):
        t = now()
        with self.conn() as c:
            cur = c.execute(
                "INSERT INTO plans(keyword,title,brief,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (keyword, title, _dumps(brief), "draft", t, t))
        return cur.lastrowid

    def update_plan(self, pid, **kw):
        fields, vals = [], []
        for k in ("keyword", "title", "status"):
            if k in kw and kw[k] is not None:
                fields.append(f"{k}=?")
                vals.append(kw[k])
        if "brief" in kw and kw["brief"] is not None:
            fields.append("brief=?")
            vals.append(_dumps(kw["brief"]))
        fields.append("updated_at=?")
        vals.append(now())
        vals.append(pid)
        with self.conn() as c:
            c.execute(f"UPDATE plans SET {','.join(fields)} WHERE id=?", vals)

    def list_plans(self):
        with self.conn() as c:
            rows = [dict(r) for r in c.execute("SELECT * FROM plans ORDER BY id DESC")]
            for r in rows:
                r["brief"] = _loads(r["brief"], {})
                r["article_count"] = c.execute(
                    "SELECT COUNT(*) FROM articles WHERE plan_id=?", (r["id"],)).fetchone()[0]
                r["archived"] = c.execute(
                    "SELECT COUNT(*) FROM archives WHERE plan_id=?", (r["id"],)).fetchone()[0]
        return rows

    def get_plan(self, pid):
        with self.conn() as c:
            r = c.execute("SELECT * FROM plans WHERE id=?", (pid,)).fetchone()
            if not r:
                return None
            p = dict(r)
            p["brief"] = _loads(p["brief"], {})
            p["articles"] = self.list_articles(pid)
            p["materials"] = self.list_materials(pid)
            p["archives"] = [dict(x) for x in c.execute("SELECT * FROM archives WHERE plan_id=? ORDER BY id DESC", (pid,))]
        return p

    def delete_plan(self, pid):
        with self.conn() as c:
            c.execute("DELETE FROM articles WHERE plan_id=?", (pid,))
            c.execute("DELETE FROM archives WHERE plan_id=?", (pid,))
            c.execute("DELETE FROM materials WHERE plan_id=?", (pid,))
            c.execute("DELETE FROM plan_progress WHERE plan_id=?", (pid,))
            c.execute("DELETE FROM plans WHERE id=?", (pid,))

    # -------------------------------------------------------- 生成进度 ----
    def get_progress(self, plan_id, signature=""):
        """返回本方案的生成进度；signature 不一致说明任务变了，从 0 重新开始。"""
        with self.conn() as c:
            r = c.execute("SELECT * FROM plan_progress WHERE plan_id=?", (plan_id,)).fetchone()
        if not r:
            return {"cursor": 0, "total": 0, "signature": "", "failed": [], "done": []}
        d = dict(r)
        d["failed"] = _loads(d.get("failed"), [])
        d["done"] = _loads(d.get("done"), [])
        if signature and d.get("signature") != signature:
            return {"cursor": 0, "total": 0, "signature": "", "failed": [], "done": []}
        return d

    def save_progress(self, plan_id, cursor, total, signature, failed=None, done=None):
        with self.conn() as c:
            c.execute(
                "INSERT INTO plan_progress(plan_id,cursor,total,done,signature,failed,updated_at)"
                " VALUES(?,?,?,?,?,?,?) ON CONFLICT(plan_id) DO UPDATE SET"
                " cursor=excluded.cursor, total=excluded.total, done=excluded.done,"
                " signature=excluded.signature, failed=excluded.failed,"
                " updated_at=excluded.updated_at",
                (plan_id, cursor, total, _dumps(sorted(done or [])), signature,
                 _dumps(failed or []), now()))

    def clear_progress(self, plan_id):
        with self.conn() as c:
            c.execute("DELETE FROM plan_progress WHERE plan_id=?", (plan_id,))

    # ------------------------------------------------------------ 资料 ----
    def add_material(self, plan_id, filename, kind, text):
        with self.conn() as c:
            cur = c.execute(
                "INSERT INTO materials(plan_id,filename,kind,chars,text,created_at) VALUES(?,?,?,?,?,?)",
                (plan_id, filename, kind, len(text or ""), text or "", now()))
        return cur.lastrowid

    def list_materials(self, plan_id):
        with self.conn() as c:
            rows = c.execute(
                "SELECT id,plan_id,filename,kind,chars,created_at,text FROM materials WHERE plan_id=? ORDER BY id",
                (plan_id,)).fetchall()
        return [dict(r) for r in rows]

    def replace_materials(self, plan_id, items):
        """整批替换，避免用户反复上一步造成重复资料。"""
        with self.conn() as c:
            c.execute("DELETE FROM materials WHERE plan_id=?", (plan_id,))
        ids = []
        for it in items:
            text = (it.get("text") or "").strip()
            if not text:
                continue
            ids.append(self.add_material(plan_id, it.get("filename") or "粘贴资料",
                                         it.get("kind") or "粘贴文本", text))
        return ids

    def update_material(self, mid, text=None, filename=None):
        with self.conn() as c:
            if text is not None:
                c.execute("UPDATE materials SET text=?, chars=? WHERE id=?",
                          (text, len(text), mid))
            if filename:
                c.execute("UPDATE materials SET filename=? WHERE id=?", (filename, mid))

    def delete_material(self, mid):
        with self.conn() as c:
            c.execute("DELETE FROM materials WHERE id=?", (mid,))

    # ------------------------------------------------------------ 稿件 ----
    def add_article(self, plan_id, **kw):
        t = now()
        with self.conn() as c:
            n = c.execute("SELECT COALESCE(MAX(sort),0)+1 FROM articles WHERE plan_id=?", (plan_id,)).fetchone()[0]
            cur = c.execute(
                "INSERT INTO articles(plan_id,platform_id,platform_name,fmt,model_name,angle,account_type,"
                "keyword,keywords,"
                "title,body_md,tags,decl,risk_tips,geo,sort,created_at,updated_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (plan_id, kw.get("platform_id"), kw.get("platform_name"), kw.get("fmt", "图文"),
                 kw.get("model_name", ""), kw.get("angle", ""), kw.get("account_type", ""),
                 kw.get("keyword", ""),
                 _dumps(kw.get("keywords") or ([kw.get("keyword")] if kw.get("keyword") else [])),
                 kw.get("title", ""),
                 kw.get("body_md", ""), _dumps(kw.get("tags", [])), _dumps(kw.get("decl", [])),
                 _dumps(kw.get("risk_tips", [])), _dumps(kw.get("geo", {})), n, t, t))
        return cur.lastrowid

    def update_article(self, aid, **kw):
        fields, vals = [], []
        for k in ("title", "body_md", "fmt", "angle", "keyword", "body_original"):
            if k in kw and kw[k] is not None:
                fields.append(f"{k}=?")
                vals.append(kw[k])
        for k in ("tags", "decl", "risk_tips", "geo", "keywords", "audit"):
            if k in kw and kw[k] is not None:
                fields.append(f"{k}=?")
                vals.append(_dumps(kw[k]))
        if not fields:
            return
        fields.append("updated_at=?")
        vals.append(now())
        vals.append(aid)
        with self.conn() as c:
            c.execute(f"UPDATE articles SET {','.join(fields)} WHERE id=?", vals)

    def delete_article(self, aid):
        with self.conn() as c:
            c.execute("DELETE FROM articles WHERE id=?", (aid,))

    def get_article(self, aid):
        with self.conn() as c:
            r = c.execute("SELECT * FROM articles WHERE id=?", (aid,)).fetchone()
        if not r:
            return None
        a = dict(r)
        a["tags"] = _loads(a["tags"], [])
        a["decl"] = _loads(a["decl"], [])
        a["risk_tips"] = _loads(a["risk_tips"], [])
        a["keywords"] = _loads(a.get("keywords"), []) or ([a["keyword"]] if a.get("keyword") else [])
        a["geo"] = _loads(a["geo"], {})
        a["audit"] = _loads(a.get("audit"), {})
        return a

    def list_articles(self, plan_id):
        with self.conn() as c:
            rows = [dict(r) for r in c.execute(
                "SELECT * FROM articles WHERE plan_id=? ORDER BY sort,id", (plan_id,))]
        for r in rows:
            r["tags"] = _loads(r["tags"], [])
            r["decl"] = _loads(r["decl"], [])
            r["risk_tips"] = _loads(r["risk_tips"], [])
            r["keywords"] = _loads(r.get("keywords"), []) or ([r["keyword"]] if r.get("keyword") else [])
            r["geo"] = _loads(r["geo"], {})
            r["audit"] = _loads(r.get("audit"), {})
        return rows

    def add_archive(self, plan_id, target, path):
        with self.conn() as c:
            c.execute("INSERT INTO archives(plan_id,target,path,created_at) VALUES(?,?,?,?)",
                      (plan_id, target, path, now()))


# ---------------------------------------------------------------- 上传适配器 ----
class LocalArchiveAdapter:
    """把整套结构化方案写到本地归档目录，模拟「服务器落库」。"""

    name = "local"

    def push(self, plan, settings):
        root = Path(os.environ.get("GEO_ARCHIVE") or (BASE_DIR / "data" / "archive"))
        d = root / f"plan_{plan['id']}_{time.strftime('%Y%m%d_%H%M%S')}"
        d.mkdir(parents=True, exist_ok=True)
        (d / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
        for i, a in enumerate(plan["articles"], 1):
            safe = f"{i:02d}_{a['platform_name']}_{a['angle']}".replace("/", "_").replace("\\", "_")
            (d / f"{safe}.md").write_text(a["body_md"], encoding="utf-8")
        return str(d)


class HttpUploadAdapter:
    """把 {plan} 以 JSON POST 到公司服务器接口。接口约定：返回 2xx 即视为成功。"""

    name = "http"

    def push(self, plan, settings):
        url = settings.get("upload_url") or ""
        if not url:
            raise RuntimeError("未配置上传接口地址")
        body = json.dumps(plan, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json; charset=utf-8")
        token = settings.get("upload_token") or ""
        if token:
            req.add_header("Authorization", "Bearer " + token)
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode("utf-8", "ignore")
        return f"HTTP {resp.status} {text[:300]}"


def get_upload_adapter(settings):
    if (settings.get("upload_mode") or "local") == "http":
        return HttpUploadAdapter()
    return LocalArchiveAdapter()
