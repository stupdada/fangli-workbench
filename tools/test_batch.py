# -*- coding: utf-8 -*-
"""分批生成与断点续跑测试。

验证：每批只跑 N 篇、进度落库、下一批接着跑、全部写完不再重复、全失败要报错而不是假装成功。

用法：python tools/test_batch.py
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
PORT = 8794
MOCK_PORT = 8894
URL = f"http://127.0.0.1:{PORT}"

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append((name, detail))
    print(("  [通过] " if ok else "  [失败] ") + name + (("  -> " + detail) if detail and not ok else ""))


def api(path, method="GET", body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"ok": False, "error": f"HTTP {e.code}"}


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


def wait_job(jid, timeout=90):
    t0 = time.time()
    j = None
    while time.time() - t0 < timeout:
        j = api("/api/jobs/" + jid)["job"]
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.8)
    return j


def main():
    os.environ["no_proxy"] = "127.0.0.1,localhost"
    os.environ["NO_PROXY"] = "127.0.0.1,localhost"
    tmp = Path(tempfile.mkdtemp(prefix="geo_batch_"))
    db = tmp / "geo.db"
    (tmp / "archive").mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env.update({"GEO_DB": str(db), "GEO_ARCHIVE": str(tmp / "archive"),
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
        api("/api/settings", "POST", {"api_base": f"http://127.0.0.1:{MOCK_PORT}/v1",
                                      "api_key": "mock", "model": "mock-1"})

        print("\n[1] 建方案：4 个词，2 个平台各 3 篇 = 6 篇")
        kws = ["复合材料怎么选", "复合材料价格", "玻璃钢和碳纤维区别", "复合材料检测机构"]
        p = api("/api/plans", "POST", {"brief": {"keywords": kws, "brand": "某某新材",
                                                "rivals": ["德龙"], "models": ["豆包"]}})
        pid = p["plan_id"]
        plats = api("/api/bootstrap")["platforms"]
        sel = [{"platform_id": plats[0]["id"], "count": 3},
               {"platform_id": plats[3]["id"], "count": 3}]

        print("\n[2] 第一批（每批 2 篇）")
        r1 = api(f"/api/plans/{pid}/generate", "POST",
                 {"selections": sel, "keywords": kws, "batch_size": 2})
        check("总量识别为 6", r1.get("total") == 6, str(r1.get("total")))
        check("本批只有 2 篇", r1.get("batch") == 2, str(r1.get("batch")))
        check("起始进度为 0", r1.get("cursor") == 0, str(r1.get("cursor")))

        j1 = wait_job(r1["job_id"])
        check("第一批完成", j1["status"] == "done", j1.get("message", "")[:80])
        arts = api(f"/api/plans/{pid}")["plan"]["articles"]
        check("只生成了 2 篇", len(arts) == 2, str(len(arts)))
        prog = api(f"/api/plans/{pid}/progress")["progress"]
        check("进度记到 2", prog["cursor"] == 2, str(prog["cursor"]))
        check("总任务数记住 6", prog["total"] == 6, str(prog["total"]))

        print("\n[3] 第二批：接着跑，不从头来")
        r2 = api(f"/api/plans/{pid}/generate", "POST",
                 {"selections": sel, "keywords": kws, "batch_size": 2})
        check("从第 3 篇开始", r2.get("cursor") == 2, str(r2.get("cursor")))
        j2 = wait_job(r2["job_id"])
        check("第二批完成", j2["status"] == "done")
        arts = api(f"/api/plans/{pid}")["plan"]["articles"]
        check("累计 4 篇", len(arts) == 4, str(len(arts)))
        check("没有重复稿（标题数=篇数）", len({a["title"] for a in arts}) == len(arts), str(len(arts)))

        print("\n[4] 第三批：写完最后 2 篇")
        r3 = api(f"/api/plans/{pid}/generate", "POST",
                 {"selections": sel, "keywords": kws, "batch_size": 2})
        wait_job(r3["job_id"])
        plan = api(f"/api/plans/{pid}")["plan"]
        check("6 篇全部写完", len(plan["articles"]) == 6, str(len(plan["articles"])))
        check("剩余为 0", api(f"/api/plans/{pid}/progress")["progress"]["cursor"] == 6)

        print("\n[5] 再点一次不会重复生成")
        r4 = api(f"/api/plans/{pid}/generate", "POST",
                 {"selections": sel, "keywords": kws, "batch_size": 2})
        j4 = wait_job(r4["job_id"])
        check("提示已写完", "已经全部写完" in (j4.get("message") or ""), j4.get("message", "")[:60])
        check("稿件数没变", len(api(f"/api/plans/{pid}")["plan"]["articles"]) == 6)

        print("\n[6] 进度落库，重启后还在")
        sys.path.insert(0, str(BASE))
        from app.store import Store
        s2 = Store(str(db))
        check("新进程读到进度 6", s2.get_progress(pid)["cursor"] == 6, str(s2.get_progress(pid)))

        print("\n[7] 换关键词不会把已经写好的稿子算废")
        kws2 = kws + ["新增的一个词"]
        r5 = api(f"/api/plans/{pid}/generate", "POST",
                 {"selections": sel, "keywords": kws2, "batch_size": 2})
        check("已写的 6 篇仍算已写", r5.get("cursor") == 6, str(r5.get("cursor")))
        check("没有剩余任务", r5.get("remaining") == 0, str(r5.get("remaining")))
        j5 = wait_job(r5["job_id"])
        check("提示已经写完，不会重复生成", "已经全部写完" in (j5.get("message") or ""),
              (j5.get("message") or "")[:80])
        check("稿件数没变", len(api(f"/api/plans/{pid}")["plan"]["articles"]) == 6,
              str(len(api(f"/api/plans/{pid}")["plan"]["articles"])))

        print("\n[7b] 只有把篇数加上去，才补写新增的那几篇")
        sel2 = [{"platform_id": s["platform_id"], "count": s["count"] + 1} for s in sel]
        r5b = api(f"/api/plans/{pid}/generate", "POST",
                  {"selections": sel2, "keywords": kws2, "batch_size": 4})
        check("总量变成 8 篇", r5b.get("total") == 8, str(r5b.get("total")))
        check("只剩 2 篇没写", r5b.get("remaining") == 2, str(r5b.get("remaining")))
        wait_job(r5b["job_id"])
        check("补齐到 8 篇",
              len(api(f"/api/plans/{pid}")["plan"]["articles"]) == 8,
              str(len(api(f"/api/plans/{pid}")["plan"]["articles"])))

        print("\n[8] 全失败必须报错，不能假装成功")
        p2 = api("/api/plans", "POST", {"brief": {"keywords": ["测试词"], "brand": "X",
                                                 "models": ["豆包"]}})["plan_id"]
        api("/api/settings", "POST", {"api_base": "http://127.0.0.1:8899/v1",
                                      "api_key": "mock", "model": "mock-1"})
        r6 = api(f"/api/plans/{p2}/generate", "POST",
                 {"selections": [{"platform_id": plats[0]["id"], "count": 2}],
                  "keywords": ["测试词"], "batch_size": 2})
        j6 = wait_job(r6["job_id"])
        check("状态是 error 而不是 done", j6["status"] == "error", j6["status"])
        check("提示说清楚是全部失败", "全部失败" in (j6.get("message") or ""), j6.get("message", "")[:80])
        check("带上真实原因", "连不上" in (j6.get("error") or ""), (j6.get("error") or "")[:80])
        check("这批没有稿件", len(api(f"/api/plans/{p2}")["plan"]["articles"]) == 0)

        print("\n[9] 失败的批次进度不前进，可以重试")
        prog2 = api(f"/api/plans/{p2}/progress")["progress"]
        check("进度仍然停在 0", prog2["cursor"] == 0, str(prog2["cursor"]))

        print("\n[10] 重新开始按钮清空进度")
        api("/api/settings", "POST", {"api_base": f"http://127.0.0.1:{MOCK_PORT}/v1",
                                      "api_key": "mock", "model": "mock-1"})
        r7 = api(f"/api/plans/{p2}/reset-progress", "POST", {})
        check("清空成功", r7.get("ok"))
        check("进度归零", api(f"/api/plans/{p2}/progress")["progress"]["cursor"] == 0)

        print("\n[11] 进度丢了也不会重复生成（以稿件表为准）")
        p3 = api("/api/plans", "POST", {"brief": {"keywords": ["甲", "乙", "丙", "丁"],
                                                 "brand": "X", "models": ["豆包"]}})["plan_id"]
        sel3 = [{"platform_id": plats[0]["id"], "count": 4}]
        api("/api/settings", "POST", {"api_base": f"http://127.0.0.1:{MOCK_PORT}/v1",
                                      "api_key": "mock", "model": "mock-1"})
        r8 = api(f"/api/plans/{p3}/generate", "POST",
                 {"selections": sel3, "keywords": ["甲", "乙", "丙", "丁"], "batch_size": 2})
        wait_job(r8["job_id"])
        check("先写 2 篇", len(api(f"/api/plans/{p3}")["plan"]["articles"]) == 2)

        api(f"/api/plans/{p3}/reset-progress", "POST", {})
        prog3 = api(f"/api/plans/{p3}/progress")["progress"]
        check("进度清空后总任务仍是 4", prog3["total"] == 4, str(prog3))
        check("已完成的按稿件数算（2）", prog3.get("done_count") == 2, str(prog3))
        check("剩余 2 篇", prog3.get("remaining") == 2, str(prog3))

        r9 = api(f"/api/plans/{p3}/generate", "POST",
                 {"selections": sel3, "keywords": ["甲", "乙", "丙", "丁"], "batch_size": 4})
        wait_job(r9["job_id"])
        arts3 = api(f"/api/plans/{p3}")["plan"]["articles"]
        check("补齐到 4 篇，没有重复", len(arts3) == 4, str(len(arts3)))
        check("4 篇标题各不相同", len({a["title"] for a in arts3}) == 4,
              str([a["keyword"] for a in arts3]))
        check("4 个词各一篇", {a["keyword"] for a in arts3} == {"甲", "乙", "丙", "丁"},
              str([a["keyword"] for a in arts3]))

    finally:
        for p_ in (srv, mock):
            try:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(p_.pid)], capture_output=True)
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
