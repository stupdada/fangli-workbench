# -*- coding: utf-8 -*-
"""自动连写 + 每平台篇数配额的测试。

覆盖：官方号/个人号分别设 0-20 篇 → 点一次自动一篇接一篇写完
      → 配额不超不少 → 中途暂停 → 再继续能接着写完
      → 篇数写满后不给新任务

用法：python tools/test_auto.py
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
PORT = 8794
MOCK_PORT = 8892
URL = f"http://127.0.0.1:{PORT}"

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append((name, detail))
    print(("  [通过] " if ok else "  [失败] ") + name +
          (("  -> " + detail) if detail and not ok else ""))


def api(path, method="GET", body=None, timeout=60):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
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


def read_sse(job_id, timeout=180, on_next=None, stop_after_next=None):
    """读 SSE 直到 end。返回 (next 事件列表, end 事件)。"""
    req = urllib.request.Request(URL + f"/api/jobs/{job_id}/stream")
    req.add_header("Accept", "text/event-stream")
    nexts, end, n = [], None, 0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            for raw in r:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data:"):
                    continue
                obj = json.loads(line[5:].strip())
                if obj.get("type") == "next":
                    nexts.append(obj)
                    n += 1
                    if on_next:
                        on_next(obj, n)
                    if stop_after_next and n >= stop_after_next:
                        break
                elif obj.get("type") == "end":
                    end = obj
                    break
    except Exception as e:                      # noqa: BLE001
        if not end:
            end = {"status": "stream_error", "error": str(e)}
    return nexts, end


def main():
    tmp = Path(tempfile.mkdtemp())
    env = dict(os.environ)
    env.update({"GEO_DB": str(tmp / "t.db"), "GEO_ARCHIVE": str(tmp / "archive"),
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

        plats = api("/api/bootstrap")["platforms"]
        p1, p2 = plats[3], plats[4]
        kws = ["复合材料怎么选", "复合材料价格", "玻璃钢和碳纤维区别",
               "复合材料检测机构", "复合材料工艺", "复合材料供应商"]

        print("\n[1] 建方案：A 平台官方 2 篇 + 个人 1 篇，B 平台个人 1 篇 = 4 篇")
        sel = [
            {"platform_id": p1["id"], "account_type": "official", "count": 2},
            {"platform_id": p1["id"], "account_type": "personal", "count": 1},
            {"platform_id": p2["id"], "account_type": "personal", "count": 1},
        ]
        pid = api("/api/plans", "POST", {"brief": {
            "keywords": kws, "brand": "某某新材", "models": ["豆包"],
            "platforms": [p1["name"], p2["name"]], "selections": sel,
        }})["plan_id"]
        prog = api(f"/api/plans/{pid}/progress")["progress"]
        check("总任务算成 4 篇", prog["total"] == 4, str(prog["total"]))
        check("一开始没写过", prog["done_count"] == 0, str(prog["done_count"]))

        print("\n[2] 点一次「开始」，中间不再点，看它自己往下写")
        r = api(f"/api/plans/{pid}/auto", "POST", {})
        check("接口返回 job", r.get("ok") and r.get("job_id"), str(r)[:120])
        check("计划写 4 篇", r.get("planned") == 4, str(r.get("planned")))
        nexts, end = read_sse(r["job_id"])
        check("推送了 4 次「换下一篇」", len(nexts) == 4, f"收到 {len(nexts)} 次")
        check("流正常结束", end and end.get("status") == "done", str(end)[:160])
        check("结束事件说写完了 4 篇", (end or {}).get("done") == 4, str((end or {}).get("done")))
        check("结束事件带完整清单", len((end or {}).get("items") or []) == 4,
              str(len((end or {}).get("items") or [])))
        check("提示是全部写完", "全部写完" in ((end or {}).get("message") or ""),
              (end or {}).get("message", "")[:80])

        arts = api(f"/api/plans/{pid}")["plan"]["articles"]
        check("库里正好 4 篇", len(arts) == 4, str(len(arts)))
        a1 = [a for a in arts if a["platform_id"] == p1["id"] and a.get("account_type") == "official"]
        a2 = [a for a in arts if a["platform_id"] == p1["id"] and a.get("account_type") == "personal"]
        a3 = [a for a in arts if a["platform_id"] == p2["id"]]
        check("A 平台官方号正好 2 篇", len(a1) == 2, str(len(a1)))
        check("A 平台个人号正好 1 篇", len(a2) == 1, str(len(a2)))
        check("B 平台正好 1 篇", len(a3) == 1, str(len(a3)))
        check("4 篇标题各不相同", len({a["title"] for a in arts}) == 4,
              str([a["title"] for a in arts]))
        check("同平台两篇角度不同", len({a["angle"] for a in a1}) == 2,
              str([a["angle"] for a in a1]))

        print("\n[3] 配额写满后再点开始，要明确说已经写完")
        r2 = api(f"/api/plans/{pid}/auto", "POST", {})
        check("拒绝并说明原因", not r2.get("ok") and "全部写完" in (r2.get("error") or ""),
              str(r2)[:120])
        check("没有多写出稿件", len(api(f"/api/plans/{pid}")["plan"]["articles"]) == 4)

        print("\n[4] 6 篇的计划，写到第 2 篇时暂停")
        pid2 = api("/api/plans", "POST", {"brief": {
            "keywords": kws, "brand": "某某新材", "models": ["豆包"],
            "platforms": [p1["name"]],
            "selections": [{"platform_id": p1["id"], "account_type": "personal", "count": 6}],
        }})["plan_id"]
        r3 = api(f"/api/plans/{pid2}/auto", "POST", {})
        check("计划写 6 篇", r3.get("planned") == 6, str(r3.get("planned")))

        holder = {}

        def ask_stop(obj, n):
            if n == 2 and not holder.get("stopped"):
                holder["stopped"] = True
                holder["resp"] = api(f"/api/jobs/{r3['job_id']}/stop", "POST", {})

        nexts2, end2 = read_sse(r3["job_id"], on_next=ask_stop, stop_after_next=None)
        check("暂停接口有回应", (holder.get("resp") or {}).get("ok") is True,
              str(holder.get("resp"))[:120])
        check("任务以「暂停」收场", end2 and end2.get("status") == "paused", str(end2)[:160])
        stopped_n = len(api(f"/api/plans/{pid2}")["plan"]["articles"])
        check("停在了半路（没写满 6 篇）", 0 < stopped_n < 6, f"写下 {stopped_n} 篇")
        check("暂停提示说还剩几篇", "还剩" in ((end2 or {}).get("message") or ""),
              (end2 or {}).get("message", "")[:80])

        print("\n[5] 点「继续」，把剩下的补完")
        left = 6 - stopped_n
        r4 = api(f"/api/plans/{pid2}/auto", "POST", {})
        check("继续时只排剩下的篇数", r4.get("planned") == left,
              f"剩 {left}，返回 {r4.get('planned')}")
        _, end4 = read_sse(r4["job_id"])
        check("继续后写完了", end4 and end4.get("status") == "done", str(end4)[:120])
        arts2 = api(f"/api/plans/{pid2}")["plan"]["articles"]
        check("总共正好 6 篇", len(arts2) == 6, str(len(arts2)))
        check("6 篇标题各不相同", len({a["title"] for a in arts2}) == 6,
              str([a["title"] for a in arts2]))
        check("6 篇角度不重复", len({a["angle"] for a in arts2}) == 6,
              str([a["angle"] for a in arts2]))
        words = [w for a in arts2 for w in a["keywords"]]
        check("词被轮换复用而不是全空", len(words) >= 6, str(words))

        print("\n[6] 边界：篇数全是 0 时不给开始")
        pid3 = api("/api/plans", "POST", {"brief": {
            "keywords": ["边界词"], "brand": "X", "models": ["豆包"],
            "platforms": [p1["name"]],
            "selections": [{"platform_id": p1["id"], "account_type": "personal", "count": 0}],
        }})["plan_id"]
        r5 = api(f"/api/plans/{pid3}/auto", "POST", {})
        check("0 篇时不启动任务", not r5.get("ok") and "0" in (r5.get("error") or ""),
              str(r5)[:120])

        print("\n" + "=" * 46)
        print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
        if failed:
            print("  失败：" + "、".join(n for n, _ in failed))
            print("结果：不通过")
            return 1
        print("结果：全部通过")
        return 0
    finally:
        for proc in (srv, mock):
            proc.terminate()
            try:
                proc.wait(timeout=6)
            except Exception:
                proc.kill()


if __name__ == "__main__":
    sys.exit(main())
