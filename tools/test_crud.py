# -*- coding: utf-8 -*-
"""配置类功能的后端落地测试：平台 / 模型 / 风险 / 偏好 / 方案 / 稿件 / 设置 / 导出。

这些是界面上每个按钮背后真正要发生的事。路由写错、方法不支持、
删了但没落库，都会在这里暴露。

用法：python tools/test_crud.py
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
PORT = 8797
URL = f"http://127.0.0.1:{PORT}"

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append((name, detail))
    print(("  [通过] " if ok else "  [失败] ") + name +
          (("  -> " + detail) if detail and not ok else ""))


def api(path, method="GET", body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def wait_port(port, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def boot():
    tmp = Path(tempfile.mkdtemp())
    env = dict(os.environ)
    env.update({"GEO_DB": str(tmp / "t.db"), "GEO_ARCHIVE": str(tmp / "archive"),
                "GEO_PORT": str(PORT), "GEO_NO_BROWSER": "1",
                "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"})
    srv = subprocess.Popen([sys.executable, str(BASE / "app" / "server.py"), "--no-browser"],
                           cwd=str(BASE), env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return srv, tmp


def main():
    srv, tmp = boot()
    try:
        if not wait_port(PORT):
            print("  [失败] 服务没起来")
            return 1

        print("\n[1] 分发平台：增 / 改 / 删")
        r = api("/api/platforms", "POST", {"name": "测试平台X", "formats": ["图文"]})
        check("新增平台成功", r.get("ok"), str(r)[:100])
        plats = api("/api/bootstrap")["platforms"]
        x = next((p for p in plats if p["name"] == "测试平台X"), None)
        check("新增的出现在列表里", x is not None)
        check("默认算个人号", x and x.get("account_type") == "personal", str(x and x.get("account_type")))
        check("重复名称被拒绝",
              not api("/api/platforms", "POST", {"name": "测试平台X"}).get("ok"))
        check("空名称被拒绝", not api("/api/platforms", "POST", {"name": "  "}).get("ok"))

        if x:
            check("改名成功",
                  api(f"/api/platforms/{x['id']}", "PUT", {"name": "测试平台X2"}).get("ok"))
            check("改名已落库",
                  any(p["name"] == "测试平台X2" for p in api("/api/bootstrap")["platforms"]))
            check("改成已存在的名字被拒绝",
                  not api(f"/api/platforms/{x['id']}", "PUT", {"name": "搜狐个人号"}).get("ok"))
            check("改格式成功",
                  api(f"/api/platforms/{x['id']}", "PUT", {"formats": ["图文", "短视频"]}).get("ok"))
            p2 = next(p for p in api("/api/bootstrap")["platforms"] if p["id"] == x["id"])
            check("格式已落库", p2["formats"] == ["图文", "短视频"], str(p2["formats"]))
            check("改账号类型成功",
                  api(f"/api/platforms/{x['id']}", "PUT", {"account_type": "official"}).get("ok"))
            p3 = next(p for p in api("/api/bootstrap")["platforms"] if p["id"] == x["id"])
            check("账号类型已落库", p3["account_type"] == "official", str(p3["account_type"]))

            check("新增时名字里带后缀也接受",
                  api("/api/platforms", "POST", {"name": "测试平台N个人号", "formats": ["图文"]}).get("ok"))
            pn = next((p for p in api("/api/bootstrap")["platforms"] if p["name"] == "测试平台N"), None)
            check("后缀被剥掉、类型自动落到字段上",
                  pn is not None and pn["account_type"] == "personal", str(pn))

            api("/api/platforms", "POST", {"name": "临时平台Y"})
            y = next(p for p in api("/api/bootstrap")["platforms"] if p["name"] == "临时平台Y")
            check("删除平台接口存在",
                  api(f"/api/platforms/{y['id']}", "DELETE").get("ok"),
                  str(api(f"/api/platforms/{y['id']}", "DELETE")))
            check("删除后列表里没有",
                  not any(p["name"] == "临时平台Y" for p in api("/api/bootstrap")["platforms"]))

        print("\n[2] 目标大模型：增 / 改 / 删")
        check("新增模型", api("/api/models", "POST", {"name": "测试模型Z"}).get("ok"))
        ms = api("/api/bootstrap")["models"]
        z = next((m for m in ms if m["name"] == "测试模型Z"), None)
        check("模型出现在列表里", z is not None)
        if z:
            check("改模型说明",
                  api(f"/api/models/{z['id']}", "PUT", {"note": "改过的说明"}).get("ok"))
            m2 = next(m for m in api("/api/bootstrap")["models"] if m["id"] == z["id"])
            check("说明已落库", m2["note"] == "改过的说明", m2["note"])
            check("模型改成已存在的名字被拒绝",
                  not api(f"/api/models/{z['id']}", "PUT", {"name": "豆包"}).get("ok"))
            check("停用模型",
                  api(f"/api/models/{z['id']}", "PUT", {"enabled": 0}).get("ok"))
            m3 = next(m for m in api("/api/bootstrap")["models"] if m["id"] == z["id"])
            check("停用已落库", int(m3["enabled"]) == 0, str(m3["enabled"]))
            check("删除模型", api(f"/api/models/{z['id']}", "DELETE").get("ok"))
            check("删除后不在列表",
                  not any(m["name"] == "测试模型Z" for m in api("/api/bootstrap")["models"]))

        print("\n[3] 风险清单：增 / 改 / 删")
        r = api("/api/risks", "POST", {"item": "测试风险条目", "category": "测试类",
                                       "level": "低", "tip": "随便写"})
        check("新增风险", r.get("ok"), str(r)[:80])
        rs = api("/api/bootstrap")["risks"]
        zr = next((x for x in rs if x["item"] == "测试风险条目"), None)
        check("风险出现在列表", zr is not None)
        check("空内容被拒绝", not api("/api/risks", "POST", {"item": " "}).get("ok"))
        if zr:
            check("改风险内容",
                  api(f"/api/risks/{zr['id']}", "PUT", {"item": "改过的风险", "level": "高"}).get("ok"))
            r2 = next(x for x in api("/api/bootstrap")["risks"] if x["id"] == zr["id"])
            check("内容已落库", r2["item"] == "改过的风险", r2["item"])
            check("等级已落库", r2["level"] == "高", r2["level"])
            check("删除风险", api(f"/api/risks/{zr['id']}", "DELETE").get("ok"))
            check("删除后不在列表",
                  not any(x["item"] == "改过的风险" for x in api("/api/bootstrap")["risks"]))

        print("\n[4] 抓取偏好：点格子后真的存下来")
        boot1 = api("/api/bootstrap")
        mid, pid = boot1["models"][0]["id"], boot1["platforms"][0]["id"]
        before = [p for p in boot1["prefs"] if p["model_id"] == mid and p["platform_id"] == pid]
        old = before[0]["level"] if before else "mid"
        new = "low" if old != "low" else "high"
        check("设置偏好", api("/api/prefs", "POST",
                              {"model_id": mid, "platform_id": pid, "level": new}).get("ok"))
        after = [p for p in api("/api/bootstrap")["prefs"]
                 if p["model_id"] == mid and p["platform_id"] == pid]
        check("偏好已落库", after and after[0]["level"] == new,
              f"{old} → {new}，实际 {after[0]['level'] if after else '无'}")

        print("\n[5] 方案：改标题 / 复用 / 删除")
        p1 = api("/api/plans", "POST", {"keyword": "甲", "title": "原标题",
                                        "brief": {"keywords": ["甲"], "brand": "X"}})["plan_id"]
        check("改名成功", api(f"/api/plans/{p1}", "PUT", {"title": "新标题"}).get("ok"))
        check("标题已落库", api(f"/api/plans/{p1}")["plan"]["title"] == "新标题")
        check("改 brief 成功",
              api(f"/api/plans/{p1}", "PUT", {"brief": {"keywords": ["甲"], "brand": "Y"}}).get("ok"))
        check("brief 已落库",
              api(f"/api/plans/{p1}")["plan"]["brief"].get("brand") == "Y")

        cp = api(f"/api/plans/{p1}/clone", "POST", {})
        check("复用方案", cp.get("ok") and cp.get("plan_id"), str(cp)[:80])
        check("复用后多了一个方案", len(api("/api/plans")["plans"]) >= 2)
        check("删除方案", api(f"/api/plans/{p1}", "DELETE").get("ok"))
        check("删除后查不到", not api(f"/api/plans/{p1}").get("ok"))
        if cp.get("plan_id"):
            api(f"/api/plans/{cp['plan_id']}", "DELETE")

        print("\n[6] 稿件：保存 / 删除")
        p2 = api("/api/plans", "POST", {"keyword": "乙", "title": "稿件测试",
                                        "brief": {"keywords": ["乙"], "brand": "X"}})["plan_id"]
        # 没有「直接建稿」的接口，这里直接往库里插一篇，模拟已生成的稿件
        import sqlite3
        conn = sqlite3.connect(str(tmp / "t.db"))
        conn.execute("INSERT INTO articles(plan_id,platform_id,platform_name,fmt,model_name,angle,"
                     "keyword,keywords,title,body_md,tags,decl,risk_tips,geo,sort,created_at,updated_at)"
                     " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (p2, 1, "搜狐个人号", "图文", "m", "疑问型", "乙", '["乙"]',
                      "测试稿件", "# 测试稿件\n\n正文。", "[]", "[]", "[]", "{}", 0,
                      "2026-01-01", "2026-01-01"))
        conn.commit()
        conn.close()
        arts = api(f"/api/plans/{p2}")["plan"]["articles"]
        check("稿件出现在方案里", len(arts) == 1, str(len(arts)))
        if arts:
            a = arts[0]
            check("保存稿件",
                  api(f"/api/articles/{a['id']}", "PUT",
                      {"title": "改过的标题", "body_md": "# 改过的标题\n\n新正文。"}).get("ok"))
            a2 = next(x for x in api(f"/api/plans/{p2}")["plan"]["articles"]
                      if x["id"] == a["id"])
            check("标题已落库", a2["title"] == "改过的标题", a2["title"])
            check("正文已落库", "新正文" in a2["body_md"])
            check("删除稿件", api(f"/api/articles/{a['id']}", "DELETE").get("ok"))
            check("删除后方案里没有稿件",
                  len(api(f"/api/plans/{p2}")["plan"]["articles"]) == 0)
        api(f"/api/plans/{p2}", "DELETE")

        print("\n[7] 设置：保存后读回")
        api("/api/settings", "POST", {"temperature": "0.7", "max_tokens": "5000",
                                      "disable_thinking": False})
        st = api("/api/bootstrap")["settings"]
        check("温度已落库", float(st["temperature"]) == 0.7, str(st["temperature"]))
        check("上限已落库", int(st["max_tokens"]) == 5000, str(st["max_tokens"]))
        check("思考开关已落库", st.get("disable_thinking") is False, str(st.get("disable_thinking")))
        check("传空 key 不会把已有 key 清掉",
              "api_key" not in api("/api/settings", "POST", {"api_key": ""})["settings"])

        print("\n[8] 平台被删后，方案的引用不会让程序崩")
        p3 = api("/api/plans", "POST", {"keyword": "丙", "title": "引用测试",
                                        "brief": {"keywords": ["丙"], "brand": "X"}})["plan_id"]
        tmp_plat = api("/api/platforms", "POST", {"name": "将要删除的平台"})
        tp = next(p for p in api("/api/bootstrap")["platforms"] if p["name"] == "将要删除的平台")
        api(f"/api/plans/{p3}", "PUT", {"brief": {"keywords": ["丙"],
                                                  "selections": [{"platform_id": tp["id"], "count": 1}]}})
        api(f"/api/platforms/{tp['id']}", "DELETE")
        check("方案仍能打开", api(f"/api/plans/{p3}").get("ok"))
        check("平台确实删掉了",
              not any(p["name"] == "将要删除的平台" for p in api("/api/bootstrap")["platforms"]))
        api(f"/api/plans/{p3}", "DELETE")

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
            srv.wait(timeout=8)
        except Exception:
            srv.kill()


if __name__ == "__main__":
    sys.exit(main())
