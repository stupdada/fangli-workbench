# -*- coding: utf-8 -*-
"""一篇一篇写 + 流式输出的测试。

覆盖：写一篇 → SSE 增量推送 → 稿件落库 → 平台轮转 → 词不重复 → 连续写到全覆盖
      → 第二轮换角度 → 异常任务不卡死

用法：python tools/test_stream.py
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
PORT = 8798
MOCK_PORT = 8896
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


def read_sse(job_id, timeout=45):
    """读 SSE，返回 (chunks, end_event)。chunks 是收到的增量文本片段列表。"""
    req = urllib.request.Request(URL + f"/api/jobs/{job_id}/stream")
    req.add_header("Accept", "text/event-stream")
    chunks, end = [], None
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            for raw in r:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data:"):
                    continue
                obj = json.loads(line[5:].strip())
                if obj.get("type") == "chunk":
                    chunks.append(obj["text"])
                elif obj.get("type") == "end":
                    end = obj
                    break
    except Exception as e:                      # noqa: BLE001
        end = {"status": "stream_error", "error": str(e)}
    return chunks, end


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
        p1, p2 = plats[3], plats[4]          # 两个个人号
        # 12 个词，够写 3 篇（每篇 4 个），用来验证"一个词只写一篇"
        kws = ["甲关键词", "乙关键词", "丙关键词", "丁关键词",
               "戊关键词", "己关键词", "庚关键词", "辛关键词",
               "壬关键词", "癸关键词", "子关键词", "丑关键词"]

        pid = api("/api/plans", "POST", {"brief": {
            "keywords": kws, "brand": "某某新材", "models": ["豆包"],
            "platforms": [p1["name"], p2["name"]],
            "platform_types": {str(p1["id"]): "personal", str(p2["id"]): "personal"},
            "selections": [
                {"platform_id": p1["id"], "account_type": "personal", "count": 2},
                {"platform_id": p2["id"], "account_type": "personal", "count": 2},
            ],
        }})["plan_id"]
        check("建档成功", bool(pid), str(pid))

        print("\n[1] 预览下一篇")
        nt = api(f"/api/plans/{pid}/next-task")["task"]
        check("能预览到下一篇", nt is not None, str(nt))
        check("第一篇发在第一个平台", nt and nt["platform"] == p1["name"], str(nt and nt["platform"]))
        check("第一篇带 2-4 个词", nt and 2 <= len(nt["words"]) <= 4, str(nt and nt["words"]))
        check("词都来自关键词表", nt and set(nt["words"]) <= set(kws))
        check("说明这是第 1 篇", nt and nt["index"] == 1, str(nt and nt["index"]))
        check("用的是个人号", nt and nt.get("account_type") == "personal",
              str(nt and nt.get("account_type")))

        print("\n[2] 写第一篇：流式能看到文字在出")
        r = api(f"/api/plans/{pid}/write-one", "POST", {})
        check("接口返回 job", r.get("ok") and r.get("job_id"), str(r)[:120])
        chunks, end = read_sse(r["job_id"])
        check("收到多个增量片段（不是一次性返回）", len(chunks) >= 3, f"收到 {len(chunks)} 段")
        check("拼接后是完整 JSON", "".join(chunks).strip().startswith("{"), "".join(chunks)[:60])
        check("流结束事件正常", end and end.get("status") == "done", str(end)[:120])
        check("结束事件带标题", end and end.get("title"), str(end and end.get("title")))
        check("结束事件带评分", end and isinstance(end.get("score"), int), str(end and end.get("score")))
        check("结束事件带核查结果", end and isinstance(end.get("audit"), dict),
              str(end and end.get("audit"))[:120])

        arts = api(f"/api/plans/{pid}")["plan"]["articles"]
        check("稿件已落库", len(arts) == 1, str(len(arts)))
        check("第一篇发在第一个平台", arts and arts[0]["platform_name"] == p1["name"],
              arts[0]["platform_name"] if arts else "")
        check("第一篇没有把词全用掉", arts and set(arts[0]["keywords"]) < set(kws),
              str(arts[0]["keywords"]) if arts else "")
        check("稿件有正文", arts and len(arts[0]["body_md"]) > 200)
        check("稿件里存了核查记录", arts and arts[0]["audit"].get("at"),
              str(arts[0].get("audit") if arts else None)[:120])
        check("核查有结论", arts and "count" in arts[0]["audit"],
              str(arts[0].get("audit") if arts else None)[:120])

        print("\n[3] 写第二篇：换平台、换词")
        nt2 = api(f"/api/plans/{pid}/next-task")["task"]
        check("第二篇换到另一个平台", nt2 and nt2["platform"] == p2["name"],
              str(nt2 and nt2["platform"]))
        r2 = api(f"/api/plans/{pid}/write-one", "POST", {})
        chunks2, end2 = read_sse(r2["job_id"])
        check("第二篇也流式完成", end2 and end2.get("status") == "done", str(end2)[:120])

        arts = api(f"/api/plans/{pid}")["plan"]["articles"]
        check("两篇都在", len(arts) == 2, str(len(arts)))
        names = [a["platform_name"] for a in arts]
        check("两个平台各一篇", sorted(names) == sorted([p1["name"], p2["name"]]), str(names))
        titles = [a["title"] for a in arts]
        check("两篇标题不同", len(set(titles)) == 2, str(titles))

        print("\n[4] 第三篇：回到第一个平台，写它的第 2 篇")
        nt3 = api(f"/api/plans/{pid}/next-task")["task"]
        check("第三篇回到第一个平台", nt3 and nt3["platform"] == p1["name"],
              str(nt3 and nt3["platform"]))
        check("同平台第 2 篇，换一组没写过的词",
              nt3 and not (set(nt3["words"]) & set(arts[0]["keywords"])),
              str(nt3 and nt3["words"]))
        check("标明是第 2 篇", nt3 and nt3["index"] == 2, str(nt3 and nt3["index"]))
        r3 = api(f"/api/plans/{pid}/write-one", "POST", {})
        _, end3 = read_sse(r3["job_id"])
        check("第三篇写完", end3 and end3.get("status") == "done", str(end3)[:120])
        arts = api(f"/api/plans/{pid}")["plan"]["articles"]
        check("一共三篇", len(arts) == 3, str(len(arts)))
        same_plat = [a for a in arts if a["platform_name"] == p1["name"]]
        check("同平台两篇角度不同", len({a["angle"] for a in same_plat}) == len(same_plat),
              str([a["angle"] for a in same_plat]))
        check("同平台两篇标题不同", len({a["title"] for a in same_plat}) == len(same_plat),
              str([a["title"] for a in same_plat]))

        p1_words = [w for a in arts if a["platform_name"] == p1["name"] for w in a["keywords"]]
        detail = " | ".join(f"{a['platform_name']}:{a['keywords']}" for a in arts)
        check("同一个平台内用词不重复", len(p1_words) == len(set(p1_words)), detail)

        print("\n[4b] 两个平台的配额都写满后，不再排新任务")
        r4 = api(f"/api/plans/{pid}/write-one", "POST", {})
        if r4.get("ok"):
            _, e4 = read_sse(r4["job_id"])
            check("第四篇正常写完", e4 and e4.get("status") == "done", str(e4)[:100])
        check("4 篇之后没有新任务了", api(f"/api/plans/{pid}/next-task")["task"] is None)
        r5 = api(f"/api/plans/{pid}/write-one", "POST", {})
        check("再点写一篇会明确提示配额写满", not r5.get("ok") and "没有可写" in (r5.get("error") or ""),
              str(r5)[:120])

        print("\n[5] 边界情况")
        bad = api("/api/jobs/no_such_job/stream")
        check("不存在的任务给 404 而不是挂住", not bad.get("ok"), str(bad)[:80])

        empty = api("/api/plans", "POST", {"keyword": "", "title": "空词方案",
                                           "brief": {"keywords": [], "brand": "X"}})
        check("没有关键词时不给建方案", not empty.get("ok"), str(empty)[:80])

        p_no_kw = api("/api/plans", "POST", {"keyword": "临时", "title": "无词",
                                             "brief": {"brand": "X"}})["plan_id"]
        r_ne = api(f"/api/plans/{p_no_kw}/write-one", "POST", {})
        check("没有关键词列表时用方案主词兜底", r_ne.get("ok"), str(r_ne)[:120])
        if r_ne.get("ok"):
            _, e_ne = read_sse(r_ne["job_id"])
            check("兜底也能写出稿", e_ne and e_ne.get("status") == "done", str(e_ne)[:100])

        print("\n[5b] 同一个方案不能同时写两篇")
        sys.path.insert(0, str(BASE))
        from app import generator as _g
        check("第一次占位成功", _g.acquire_write(999) is True)
        check("同时第二次被拒", _g.acquire_write(999) is False)
        _g.release_write(999)
        check("释放后可以再占", _g.acquire_write(999) is True)
        _g.release_write(999)
        check("释放后不再占着", _g.acquire_write(999) is True)

        pc = api("/api/plans", "POST", {"brief": {
            "keywords": ["并发一", "并发二"], "brand": "X", "models": ["豆包"],
            "platforms": [p1["name"]]}})["plan_id"]
        r1 = api(f"/api/plans/{pc}/write-one", "POST", {})
        r2 = api(f"/api/plans/{pc}/write-one", "POST", {})
        ends = []
        for rr in (r1, r2):
            _, e = read_sse(rr["job_id"]) if rr.get("ok") else (None, None)
            ends.append((e or {}).get("status"))
        check("连点两次不会写出两篇", ends.count("done") == 1, str(ends))
        check("被挡下的那次有明确提示", "error" in ends, str(ends))
        check("库里只有一篇", len(api(f"/api/plans/{pc}")["plan"]["articles"]) == 1,
              str(len(api(f"/api/plans/{pc}")["plan"]["articles"])))
        _g.release_write(999)

        print("\n[6] 逐篇写完，同平台内的词不会重复或遗漏")
        pid2 = api("/api/plans", "POST", {"brief": {
            "keywords": ["词一", "词二", "词三", "词四", "词五"], "brand": "X",
            "models": ["豆包"], "platforms": [p1["name"]],
            "selections": [{"platform_id": p1["id"], "account_type": "personal", "count": 3}],
        }})["plan_id"]
        seen = []
        for n in range(3):
            rr = api(f"/api/plans/{pid2}/write-one", "POST", {})
            if not rr.get("ok"):
                break
            _, e = read_sse(rr["job_id"])
            if not e or e.get("status") != "done":
                break
            a = api(f"/api/plans/{pid2}")["plan"]["articles"][-1]
            seen.extend(a["keywords"])
        check("三篇合起来覆盖全部 5 个词",
              set(seen) == {"词一", "词二", "词三", "词四", "词五"},
              str(sorted(set(seen))))
        check("三篇内用词不重复", len(seen) == len(set(seen)), str(seen))
        check("三篇写完额度用尽", api(f"/api/plans/{pid2}/next-task")["task"] is None)

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
