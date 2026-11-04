# -*- coding: utf-8 -*-
"""资料录入 + 多关键词生成 的后端全流程测试。

覆盖：文件解析接口 → 建档(多关键词) → 资料入库 → 按关键词各写一轮 → 资料确实进入提示词
      → 导出包含关键词与资料清单 → 资料可改可删

用法：python tools/test_intake.py
"""

import base64
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
PORT = 8792
MOCK_PORT = 8898
URL = f"http://127.0.0.1:{PORT}"

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append((name, detail))
    print(("  [通过] " if ok else "  [失败] ") + name + (("  -> " + detail) if detail and not ok else ""))


def api(path, method="GET", body=None, raw=False):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            content = r.read()
    except urllib.error.HTTPError as e:
        content = e.read()
    if raw:
        return content
    try:
        return json.loads(content)
    except Exception:
        return {"ok": False, "error": content[:200]}


def wait_port(port, timeout=25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = socket.socket()
        s.settimeout(0.3)
        try:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        finally:
            s.close()
        time.sleep(0.3)
    return False


def make_docx(text_paras, table=None):
    body = "".join(
        f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in text_paras)
    if table:
        rows = ""
        for r in table:
            cells = "".join(
                f"<w:tc><w:p><w:r><w:t>{c}</w:t></w:r></w:p></w:tc>" for c in r)
            rows += f"<w:tr>{cells}</w:tr>"
        body += f"<w:tbl>{rows}</w:tbl>"
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           f"<w:body>{body}</w:body></w:document>")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", doc)
    return buf.getvalue()


def main():
    os.environ["no_proxy"] = "127.0.0.1,localhost"
    os.environ["NO_PROXY"] = "127.0.0.1,localhost"
    tmp = Path(tempfile.mkdtemp(prefix="geo_intake_"))
    db = tmp / "geo.db"
    archive = tmp / "archive"
    archive.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env.update({"GEO_DB": str(db), "GEO_ARCHIVE": str(archive),
                "GEO_PORT": str(PORT), "GEO_NO_BROWSER": "1",
                "GEO_MOCK_PORT": str(MOCK_PORT),
                "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"})

    mock = subprocess.Popen([sys.executable, str(BASE / "tools" / "mock_llm.py")],
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv = subprocess.Popen([sys.executable, str(BASE / "app" / "server.py"), "--no-browser"],
                           cwd=str(BASE), env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not (wait_port(MOCK_PORT) and wait_port(PORT)):
            print("  [失败] 服务没起来")
            return 1

        print("\n[1] 文件解析接口")
        docx = make_docx(
            ["某某电器 小型咖啡机 产品介绍",
             "X1 机型支持胶囊与咖啡粉两种方式，水箱 1.2L，整机重量 4.5kg。",
             "质保两年，全国联保。"],
            table=[["型号", "零售价"], ["X1", "1299元"], ["X2", "1899元"]])
        r = api("/api/parse", "POST", {"filename": "产品介绍.docx",
                                       "content_b64": base64.b64encode(docx).decode()})
        check("上传 docx 能解析", r.get("ok") and "胶囊与咖啡粉" in r.get("text", ""), str(r)[:120])
        check("表格转文本", "1299元" in r.get("text", ""))
        check("返回类型与字数", r.get("kind") == "Word 文档" and r.get("chars", 0) > 40)

        r = api("/api/parse", "POST", {"filename": "公司简介.txt",
                                       "content_b64": base64.b64encode("我们成立于 2010 年，专注家用咖啡设备。".encode("utf-8")).decode()})
        check("上传 txt 能解析", r.get("ok") and "2010" in r.get("text", ""))

        r = api("/api/parse", "POST", {"filename": "资料.pdf",
                                       "content_b64": base64.b64encode(b"%PDF-1.4 xx").decode()})
        check("PDF 给出可照做的替代方案", not r.get("ok") and "另存为" in r.get("error", ""), str(r)[:100])

        r = api("/api/parse", "POST", {"filename": "神秘.xyz",
                                       "content_b64": base64.b64encode(b"xx").decode()})
        check("未知格式提示粘贴或另存", not r.get("ok") and "粘贴" in r.get("error", ""))

        print("\n[2] 建档（2 个目标关键词 + 一份全局品牌名单）")
        # 4 个词分到每个平台的 2 篇里，必然出现"一篇覆盖多词"
        kws = ["小型咖啡机怎么选", "胶囊咖啡机好用吗", "家用咖啡机推荐", "咖啡机哪个牌子好"]
        krivals = ["德龙", "飞利浦", "九阳", "雀巢多趣酷思", "小米", "某某电器"]
        _plats = api("/api/bootstrap")["platforms"]
        p = api("/api/plans", "POST", {
            "brief": {"keywords": kws, "rivals": krivals,
                      "industry": "家电", "brand": "某某电器",
                      "company": "某某电器有限公司", "website": "mou-electrics.cn",
                      "products": "家用咖啡设备",
                      "tone": "平实",
                      # 主流程验证的是个人号，明确指定，避免抖音默认官方号改写官网
                      "platform_types": {str(_plats[0]["id"]): "personal",
                                         str(_plats[3]["id"]): "personal"},
                      "extra": "", "models": ["豆包"], "platforms": []}})
        pid = p.get("plan_id")
        check("方案创建成功", bool(pid), str(p)[:120])

        saved_brief = api(f"/api/plans/{pid}")["plan"]["brief"]
        check("全局品牌名单存下来了", saved_brief.get("rivals") == krivals,
              str(saved_brief.get("rivals"))[:80])
        check("我方品牌存下来了", saved_brief.get("brand") == "某某电器")

        p = api("/api/plans", "POST", {"brief": {"keywords": []}})
        check("没有关键词时拒绝建档", not p.get("ok") and "关键词" in p.get("error", ""))

        print("\n[3] 资料入库")
        r = api("/api/materials/bulk", "POST", {"plan_id": pid, "items": [
            {"filename": "产品介绍.docx", "kind": "Word 文档", "text": "X1 支持胶囊与咖啡粉，水箱 1.2L，重量 4.5kg，质保两年。"},
            {"filename": "竞品分析.txt", "kind": "纯文本", "text": "A 品牌主打低价，B 品牌主打颜值；我们主打一机双用。"},
        ]})
        check("资料保存成功", r.get("count") == 2, str(r)[:100])

        r = api("/api/materials/bulk", "POST", {"plan_id": pid, "items": [
            {"filename": "产品介绍.docx", "kind": "Word 文档", "text": "X1 支持胶囊与咖啡粉，水箱 1.2L。"}]})
        check("重复保存是整批替换（不叠加）", r.get("count") == 1, str(r)[:100])

        api("/api/materials/bulk", "POST", {"plan_id": pid, "items": [
            {"filename": "产品介绍.docx", "kind": "Word 文档", "text": "X1 支持胶囊与咖啡粉，水箱 1.2L，重量 4.5kg，质保两年。"},
            {"filename": "竞品分析.txt", "kind": "纯文本", "text": "A 品牌主打低价，B 品牌主打颜值；我们主打一机双用。"},
        ]})

        print("\n[4] 生成（2 平台各 2 篇，关键词自由组合到篇内）")
        api("/api/settings", "POST", {"api_base": f"http://127.0.0.1:{MOCK_PORT}/v1",
                                      "api_key": "mock", "model": "mock-1"})
        plats = api("/api/bootstrap")["platforms"]
        sel = [{"platform_id": plats[0]["id"], "count": 2},
               {"platform_id": plats[3]["id"], "count": 2}]
        g = api(f"/api/plans/{pid}/generate", "POST",
                {"selections": sel, "keywords": kws, "rivals": krivals,
                 "models": ["豆包"], "platforms": [plats[0]["name"], plats[3]["name"]],
                 "batch_size": 10})
        check("总量按篇数算，不再乘以关键词数（2+2=4）", g.get("total") == 4, str(g.get("total")))

        j = None
        for _ in range(120):
            j = api("/api/jobs/" + g["job_id"])["job"]
            if j["status"] in ("done", "error"):
                break
            time.sleep(1)
        check("生成完成", j and j["status"] == "done",
              f"{j.get('status')} | {j.get('message')} | {str(j.get('error'))[:150]} | "
              f"items={[it.get('state') for it in j.get('items', [])]}"[:400])

        plan = api(f"/api/plans/{pid}")["plan"]
        arts = plan["articles"]
        check("稿件数量 = 4（按篇数，不按词数）", len(arts) == 4, str(len(arts)))

        # 全局摊分后：关键词按全方案篇数切分，每篇文章拿到不同的主词，
        # 4 篇合起来覆盖全部关键词（不再像旧版每平台各自取第一组、标题雷同）。
        all_covered = [w for a in arts for w in a.get("keywords", [])]
        check("4 篇文章合起来覆盖全部关键词", set(all_covered) == set(kws),
              str(set(kws) - set(all_covered)))
        for pname in {a["platform_name"] for a in arts}:
            group = [a for a in arts if a["platform_name"] == pname]
            covered = [w for a in group for w in a.get("keywords", [])]
            check(f"{pname} 词不重复", len(covered) == len(set(covered)), str(covered))
            check(f"{pname} 两篇主词不同", len({a["keyword"] for a in group}) == len(group),
                  str([a["keyword"] for a in group]))
            check(f"{pname} 两篇角度不同", len({a["angle"] for a in group}) == len(group),
                  str([a["angle"] for a in group]))
            check(f"{pname} 两篇标题不同", len({a["title"] for a in group}) == len(group))
        check("4 篇文章主词两两不同（防标题雷同核心断言）",
              len({a["keyword"] for a in arts}) == len(arts),
              str([a["keyword"] for a in arts]))
        check("每篇文章至少覆盖 1 个关键词",
              all(len(a.get("keywords", [])) >= 1 for a in arts),
              str([a.get("keywords") for a in arts]))
        check("标题只放主词（不含同组辅词）",
              all(all(w not in a["title"] for w in a.get("keywords", [])[1:]) for a in arts),
              str([a["title"] for a in arts]))

        # 分组预览接口
        pv = api("/api/preview-groups", "POST",
                 {"keywords": kws, "selections": [{"platform_id": plats[0]["id"], "count": 2}]})
        check("分组预览可调用", pv.get("ok") and pv.get("total") == 2, str(pv)[:100])
        check("预览里每篇带主词与覆盖词",
              all(g.get("primary") and g.get("words") for g in pv["items"][0]["groups"]))
        cover_preview = [w for g in pv["items"][0]["groups"] for w in g["words"]]
        check("预览覆盖全部关键词", set(cover_preview) == set(kws), str(cover_preview))

        print("\n[5] 资料确实进入了提示词")
        saw = [a for a in arts if "已读取客户资料" in (a.get("risk_tips") or [])]
        check("模型收到了客户资料", len(saw) == len(arts), f"{len(saw)}/{len(arts)}")

        print("\n[5b] 宣传写法与竞品规避")
        rivals = {"德龙", "飞利浦", "九阳", "雀巢多趣酷思", "小米"}
        bad = [a for a in arts if any(n in a["body_md"] for n in rivals)]
        check("正文没有出现任何竞品名", not bad, str([a["title"][:14] for a in bad]))
        names = {c["name"] for c in arts[0]["geo"]["checks"]}
        check("自检含「未出现竞品名」", "未出现竞品名" in names, str(names))
        check("自检含「品牌露出适度」", "品牌露出适度" in names)
        check("每篇都提到了我方品牌", all("某某电器" in a["body_md"] for a in arts),
              str([a["body_md"].count("某某电器") for a in arts]))
        # 结构按平台差别化：不再要求每篇都有固定的「核心优势」
        # 但要保证每篇都有 2 级小标题，且结构不是完全照抄
        check("每篇都有 2 级小标题", all(a["body_md"].count("\n## ") >= 2 for a in arts),
              str([a["body_md"].count("\n## ") for a in arts]))
        structures = [[x for x in a["body_md"].split("\n") if x.startswith("## ")] for a in arts]
        check("不同平台的小节结构不完全一样",
              len({tuple(x) for x in structures}) >= 2,
              str(structures)[:200])
        ok_geo = [c for a in arts for c in a["geo"]["checks"]
                  if c["name"] in ("未出现竞品名", "品牌露出适度") and c["ok"]]
        check("两项宣传类自检全部通过", len(ok_geo) == 2 * len(arts), f"{len(ok_geo)}/{2*len(arts)}")

        print("\n[5c] 不再出现硬广式信息块")
        check("没有「品牌与联系信息」小节",
              not any("品牌与联系信息" in a["body_md"] for a in arts),
              str([a["id"] for a in arts]))
        check("没有品牌/公司/主营的条目罗列",
              not any(re.search(r"(?m)^-\s*(品牌|公司全称|主营产品)\s*[:：]", a["body_md"])
                      for a in arts))
        check("没有官网域名", not any("mou-electrics.cn" in a["body_md"] for a in arts))
        check("没有「官网是多少」这类问答",
              not any("官网是多少" in a["body_md"] for a in arts))
        check("没有「哪家公司生产的」这类问答",
              not any("哪家公司生产" in a["body_md"] for a in arts))
        check("没有电话/微信/二维码",
              not any(k in a["body_md"] for a in arts for k in ("电话：", "微信", "二维码")))
        check("没有残留域名",
              not any(re.search(r"[a-z0-9][a-z0-9\-]{0,30}\.(com|cn|net)", a["body_md"], re.I)
                      for a in arts),
              str([a["id"] for a in arts if re.search(r"\.(com|cn|net)", a["body_md"], re.I)]))
        check("自检里已没有「品牌信息块完整」",
              not any(c["name"] == "品牌信息块完整" for a in arts for c in a["geo"]["checks"]))
        check("正文没被删空（每篇都在 500 字以上）",
              all(a["geo"]["chars"] > 500 for a in arts),
              str([a["geo"]["chars"] for a in arts]))

        print("\n[5d] 清理旧稿的函数不会破坏正文")
        sample = arts[0]["body_md"]
        sys.path.insert(0, str(BASE))
        from app import render as _render
        passthrough = _render.strip_ad_block(sample)
        check("新稿件再过一遍清理不变形", passthrough.strip() == sample.strip())
        check("清理后仍以声明结尾", "声明" in passthrough.strip()[-60:])

        print("\n[6] 方案与导出的完整性")
        check("方案带回了资料清单", len(plan.get("materials", [])) == 2)
        check("方案带回了关键词列表", plan["brief"].get("keywords") == kws)

        md = api(f"/api/plans/{pid}/export?fmt=md", raw=True).decode("utf-8")
        check("导出含关键词列表", "本轮目标搜索关键词" in md and kws[1] in md)
        check("导出含全局品牌名单", "搜索后同时出现的品牌" in md and "德龙" in md and "雀巢" in md)
        check("导出含资料清单", "客户资料：2 份" in md and "产品介绍.docx" in md)
        check("导出含抓取偏好表", "抓取偏好对照表" in md)
        check("导出含风险清单", "风险点清单" in md)
        check("导出含全部稿件", all(a["title"] in md for a in arts), str(len(arts)))

        print("\n[6b] 导出 Word")
        req = urllib.request.Request(URL + f"/api/plans/{pid}/export?fmt=docx")
        with urllib.request.urlopen(req, timeout=60) as r:
            blob = r.read()
            ctype = r.headers.get("Content-Type", "")
            disp = r.headers.get("Content-Disposition", "")
        check("返回的是 docx 类型", "wordprocessingml.document" in ctype, ctype)
        check("文件名以 .docx 结尾", ".docx" in disp, disp[:80])
        check("内容是非空 zip", blob[:2] == b"PK" and len(blob) > 5000, f"{len(blob)} 字节")
        import io, zipfile
        names = zipfile.ZipFile(io.BytesIO(blob)).namelist()
        check("docx 结构完整", "word/document.xml" in names and "[Content_Types].xml" in names)
        sys.path.insert(0, str(BASE))
        from app import parsers as _parsers
        back = _parsers.parse_file("x.docx", blob)["text"]
        check("读回来含稿件正文", "某某电器" in back or "小型咖啡机" in back, back[:80])
        check("每篇稿件标题都在", all(a["title"] in back for a in arts),
              str([a["title"][:12] for a in arts]))
        check("Word 里不含抓取偏好对照表", "抓取偏好对照表" not in back)
        check("Word 里不含风险点清单", "风险点清单" not in back)
        check("Word 里不含平台标注", "｜疑问型｜" not in back and "｜图文" not in back)

        print("\n[7] 资料可改可删")
        mid = plan["materials"][0]["id"]
        r = api(f"/api/materials/{mid}", "PUT", {"text": "改过之后的资料内容，只保留水箱 1.2L。"})
        check("修改资料成功", r.get("ok"))
        plan2 = api(f"/api/plans/{pid}")["plan"]
        m = [x for x in plan2["materials"] if x["id"] == mid][0]
        check("修改后字数同步", m["chars"] == len("改过之后的资料内容，只保留水箱 1.2L。"), str(m["chars"]))
        r = api(f"/api/materials/{mid}", "DELETE")
        check("删除资料成功", r.get("ok"))
        plan3 = api(f"/api/plans/{pid}")["plan"]
        check("删除后只剩 1 份", len(plan3["materials"]) == 1, str(len(plan3["materials"])))

        print("\n[8] 归档带上资料")
        up = api(f"/api/plans/{pid}/upload", "POST", {})
        check("上传归档成功", up.get("ok"), str(up)[:100])
        pj = json.loads((Path(up["target"]) / "plan.json").read_text(encoding="utf-8"))
        check("归档包里有资料全文", len(pj.get("materials", [])) == 1 and "竞品分析" in pj["materials"][0]["filename"])

        print("\n[9] 老方案兼容（没有关键词列表也能重写）")
        aid = arts[0]["id"]
        rg = api(f"/api/articles/{aid}/regenerate", "POST", {})
        jj = None
        for _ in range(60):
            jj = api("/api/jobs/" + rg["job_id"])["job"]
            if jj["status"] in ("done", "error"):
                break
            time.sleep(1)
        check("单篇重写成功", jj and jj["status"] == "done", (jj or {}).get("error", "")[:80])

        print("\n[9b] 别名合并：中英文写法的词并成同一篇")
        akws = ["西邦 24", "Cilbond 24", "西邦 62W", "Cilbond 62W"]
        al = api("/api/aliases", "POST", {"keywords": akws})
        check("别名接口识别出 2 组", al.get("ok") and len(al["groups"]) == 2, str(al)[:120])
        check("合并后词数变少", al.get("after") == 2, str(al.get("after")))
        alias_groups = [g["words"] for g in al["groups"]]

        pv = api("/api/preview-groups", "POST", {
            "keywords": akws, "aliases": alias_groups,
            "selections": [{"platform_id": plats[0]["id"], "count": 2}]})
        all_words = [w for x in pv["items"][0]["groups"] for w in x["words"]]
        check("预览里 4 个词都在", set(all_words) == set(akws), str(all_words))
        pgroups = pv["items"][0]["groups"]
        pair_ok = all([
            any("西邦 24" in x["words"] and "Cilbond 24" in x["words"] for x in pgroups),
            any("西邦 62W" in x["words"] and "Cilbond 62W" in x["words"] for x in pgroups),
        ])
        check("同一实体的两种写法在同一篇", pair_ok, str(pgroups))

        ap = api("/api/plans", "POST", {"brief": {"keywords": akws, "aliases": alias_groups,
                                                 "brand": "某某新材", "models": ["豆包"]}})["plan_id"]
        api("/api/materials/bulk", "POST", {"plan_id": ap, "items": [
            {"filename": "产品.docx", "kind": "Word 文档",
             "text": "西邦 24（Cilbond 24）是双组分结构胶。西邦 62W（Cilbond 62W）耐高温。"}]})
        ag = api(f"/api/plans/{ap}/generate", "POST", {
            "selections": [{"platform_id": plats[0]["id"], "count": 2}],
            "keywords": akws, "aliases": alias_groups, "batch_size": 10})
        aj = None
        for _ in range(80):
            aj = api("/api/jobs/" + ag["job_id"])["job"]
            if aj["status"] in ("done", "error"):
                break
            time.sleep(1)
        check("别名方案生成成功", aj and aj["status"] == "done", (aj or {}).get("message", "")[:80])
        ars = api(f"/api/plans/{ap}")["plan"]["articles"]
        check("生成 2 篇", len(ars) == 2, str(len(ars)))
        covered = [w for a in ars for w in a.get("keywords", [])]
        check("4 个写法全部落到稿件里", set(covered) == set(akws), str(covered))
        check("每篇里中英文成对出现",
              all(("西邦" in str(a.get("keywords")) and "Cilbond" in str(a.get("keywords")))
                  for a in ars), str([a.get("keywords") for a in ars]))

        print("\n[9c] 官方号 / 个人号生成分叉")
        off_plat = plats[0]      # 抖音企业号，默认官方号
        per_plat = plats[3]      # 知乎个人号，默认个人号
        check("抖音企业号默认官方", off_plat.get("account_type") == "official",
              str(off_plat.get("account_type")))
        check("知乎个人号默认个人", per_plat.get("account_type") == "personal",
              str(per_plat.get("account_type")))

        op = api("/api/plans", "POST", {"brief": {
            "keywords": ["橡胶粘接"], "brand": "某某新材",
            "company": "某某新材料有限公司",
            "website": "mou-new.cn", "phone": "400-800-1234",
            "address": "上海市嘉定区测试路 88 号",
            "models": ["豆包"],
            "platform_types": {str(off_plat["id"]): "official",
                               str(per_plat["id"]): "personal"}}})["plan_id"]
        og = api(f"/api/plans/{op}/generate", "POST", {
            "selections": [{"platform_id": off_plat["id"], "count": 1},
                           {"platform_id": per_plat["id"], "count": 1}],
            "keywords": ["橡胶粘接"], "batch_size": 10})
        oj = None
        for _ in range(80):
            oj = api("/api/jobs/" + og["job_id"])["job"]
            if oj["status"] in ("done", "error"):
                break
            time.sleep(1)
        check("两个平台都生成完成", oj and oj["status"] == "done",
              (oj or {}).get("message", "")[:100])

        arts2 = api(f"/api/plans/{op}")["plan"]["articles"]
        off_art = [a for a in arts2 if a["platform_name"] == off_plat["name"]]
        per_art = [a for a in arts2 if a["platform_name"] == per_plat["name"]]
        check("官方号写了一篇", len(off_art) == 1, str(len(off_art)))
        check("个人号写了一篇", len(per_art) == 1, str(len(per_art)))

        if off_art and per_art:
            ob, pb = off_art[0]["body_md"], per_art[0]["body_md"]
            check("官方号正文写了官网", "mou-new.cn" in ob)
            check("官方号正文写了客服电话", "400-800-1234" in ob)
            check("官方号没有微信号", "微信" not in ob)
            check("个人号正文没有官网", "mou-new.cn" not in pb, pb[:120])
            check("个人号正文没有电话", "400-800-1234" not in pb)
            check("个人号正文没有地址", "上海市嘉定区测试路" not in pb)

            off_names = {c["name"]: c["ok"] for c in off_art[0]["geo"]["checks"]}
            per_names = {c["name"]: c["ok"] for c in per_art[0]["geo"]["checks"]}
            check("官方号自检：官方信息已带出", off_names.get("官方信息已带出") is True)
            check("个人号自检：无官方联系方式", per_names.get("未出现官方联系方式") is True)
            check("两篇自检都没有私人导流",
                  off_names.get("无导流信息") is True and per_names.get("无导流信息") is True)

        print("\n[10] 重启后中断的生成状态自动归位")
        sys.path.insert(0, str(BASE))
        from app.store import Store
        s2 = Store(str(db))
        s2.update_plan(pid, status="generating")
        s2.add_article(pid, platform_id=plats[0]["id"], platform_name="抖音企业号",
                       fmt="图文", angle="疑问型", keyword=kws[0],
                       title="一篇用来验证状态的稿件", body_md="# t\n\n正文内容足够长。", tags=[], decl=[])
        s3 = Store(str(db))
        check("有稿件的方案归位为已生成", s3.get_plan(pid)["status"] == "generated",
              s3.get_plan(pid)["status"])

        draft_pid = s3.create_plan("空关键词", "空方案", {"keywords": ["空关键词"]})
        s3.update_plan(draft_pid, status="generating")
        s4 = Store(str(db))
        check("没稿件的方案退回草稿", s4.get_plan(draft_pid)["status"] == "draft",
              s4.get_plan(draft_pid)["status"])

    finally:
        for p_ in (srv, mock):
            try:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(p_.pid)],
                               capture_output=True)
            except Exception:
                pass
        time.sleep(1)
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n" + "=" * 46)
    print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
    if failed:
        for n, d in failed:
            print("  失败：" + n + ("  " + d if d else ""))
        print("结果：不通过")
        return 1
    print("结果：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
