# -*- coding: utf-8 -*-
"""勾选导出测试：只导勾中的那几篇，Word/Markdown/JSON 三种格式都要听话。

用法：python tools/test_export_pick.py
"""

import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
PORT = 8796
URL = f"http://127.0.0.1:{PORT}"
sys.path.insert(0, str(BASE))

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append((name, detail))
    print(("  [通过] " if ok else "  [失败] ") + name +
          (("  -> " + detail) if detail and not ok else ""))


def api(path, method="GET", body=None, timeout=30):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def fetch(path):
    """取导出文件，返回 (状态码, 原始字节)。"""
    try:
        with urllib.request.urlopen(URL + path, timeout=40) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def docx_text(data):
    """把 docx 里的文字抽出来（标签全去掉），只用来断内容，不做排版校验。"""
    import re
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        xml = z.read("word/document.xml").decode("utf-8", "ignore")
    return re.sub(r"<[^>]+>", "", xml)


plain = docx_text


def wait_port(port, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def main():
    tmp = Path(tempfile.mkdtemp())
    db = tmp / "t.db"
    env = dict(os.environ)
    env.update({"GEO_DB": str(db), "GEO_ARCHIVE": str(tmp / "archive"),
                "GEO_PORT": str(PORT), "GEO_NO_BROWSER": "1",
                "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"})
    srv = subprocess.Popen([sys.executable, str(BASE / "app" / "server.py"), "--no-browser"],
                           cwd=str(BASE), env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_port(PORT):
            print("  [失败] 服务没起来")
            return 1
        plats = api("/api/bootstrap")["platforms"]
        p1 = plats[3]
        pid = api("/api/plans", "POST", {"brief": {
            "keywords": ["甲词", "乙词", "丙词"], "brand": "某某新材", "models": ["豆包"],
            "platforms": [p1["name"]],
            "selections": [{"platform_id": p1["id"], "account_type": "personal", "count": 3}],
        }})["plan_id"]

        # 直接落库 3 篇，省掉等模型的时间（导出逻辑不依赖生成过程）
        from app.store import Store
        st = Store(str(db))
        ids = []
        for i in range(3):
            ids.append(st.add_article(
                pid, platform_id=p1["id"], platform_name=p1["name"], fmt="图文",
                model_name="mock-1", angle="疑问型", account_type="personal",
                keyword=f"第{i + 1}篇主词",
                title=f"这是第{i + 1}篇的标题",
                body_md=(f"# 这是第{i + 1}篇的标题\n\n## 第{i + 1}篇小标题\n\n"
                         f"第{i + 1}篇的正文内容。"),
                keywords=[f"第{i + 1}篇主词"], tags=["#标签"], decl=["含AI生成内容"],
                risk_tips=[], geo={"score": 90 - i * 10}))
        check("三篇稿件准备就绪", len(api(f"/api/plans/{pid}")["plan"]["articles"]) == 3)

        print("\n[1] 不带 ids：导全部")
        code, data = fetch(f"/api/plans/{pid}/export?fmt=docx")
        check("Word 下载成功", code == 200 and data[:2] == b"PK", f"{code} {data[:8]}")
        txt = plain(data)
        check("三篇都在", all(f"第{i + 1}篇的标题" in txt for i in range(3)), txt[:200])

        print("\n[2] 带 ids：只导前两篇")
        want = f"{ids[0]},{ids[1]}"
        code2, data2 = fetch(f"/api/plans/{pid}/export?fmt=docx&ids={want}")
        check("Word 下载成功", code2 == 200 and data2[:2] == b"PK", str(code2))
        txt2 = plain(data2)
        check("第 1 篇在", "第1篇的标题" in txt2)
        check("第 2 篇在", "第2篇的标题" in txt2)
        check("第 3 篇被剔掉", "第3篇的标题" not in txt2, txt2[:200])
        check("被剔掉的那篇正文也不在", "第3篇的正文内容" not in txt2)

        print("\n[3] 只导一篇")
        _, data3 = fetch(f"/api/plans/{pid}/export?fmt=docx&ids={ids[2]}")
        txt3 = plain(data3)
        check("只剩第 3 篇", "第3篇的标题" in txt3 and "第1篇的标题" not in txt3, txt3[:200])

        print("\n[4] Markdown 也按勾选走")
        code4, data4 = fetch(f"/api/plans/{pid}/export?fmt=md&ids={want}")
        md = data4.decode("utf-8")
        check("状态正常", code4 == 200, str(code4))
        check("md 里有前两篇", "第1篇的标题" in md and "第2篇的标题" in md)
        check("md 里没有第三篇", "第3篇的标题" not in md)
        check("md 的稿件数写的是 2", "稿件数量：2" in md,
              [x for x in md.split("\n") if "稿件数量" in x])

        print("\n[5] JSON 也按勾选走")
        _, data5 = fetch(f"/api/plans/{pid}/export?fmt=json&ids={want}")
        obj = json.loads(data5)
        check("json 里只有 2 篇", len(obj.get("articles") or []) == 2,
              str(len(obj.get("articles") or [])))
        check("json 里没有第三篇",
              all(a.get("id") != ids[2] for a in obj.get("articles") or []))

        print("\n[6] 一篇都没勾时不能导出空文件")
        code6, data6 = fetch(f"/api/plans/{pid}/export?fmt=docx&ids=,")
        check("空 ids 被拒绝", code6 != 200, str(code6))
        code7, data7 = fetch(f"/api/plans/{pid}/export?fmt=docx&ids=999999")
        check("全是不存在的 id 也会被拒绝", code7 != 200 or not data7, str(code7))

        print("\n[7] 空方案导出给明确提示")
        pid2 = api("/api/plans", "POST", {"brief": {
            "keywords": ["空方案词"], "brand": "X"}})["plan_id"]
        code8, data8 = fetch(f"/api/plans/{pid2}/export?fmt=docx")
        check("空方案不给下载", code8 != 200, str(code8))
        try:
            msg = json.loads(data8).get("error") or ""
        except Exception:
            msg = ""
        check("提示说得清楚", "没有选中任何稿件" in msg, msg[:80])

        print("\n" + "=" * 46)
        print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
        if failed:
            print("  失败：" + "、".join(n for n, _ in failed))
            print("结果：不通过")
            return 1
        print("结果：全部通过")
        return 0
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=6)
        except Exception:
            srv.kill()


if __name__ == "__main__":
    sys.exit(main())
