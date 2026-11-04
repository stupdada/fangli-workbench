# -*- coding: utf-8 -*-
"""本地联调脚本：用假模型跑通 建档 → 生成 → 自检 → 导出 → 上传 全流程。"""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:8770"


def call(path, method="GET", body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
        try:
            return json.loads(raw)
        except Exception:
            return raw


print("1) 配置假模型")
print(call("/api/settings", "POST", {"api_base": "http://127.0.0.1:8899/v1", "api_key": "mock", "model": "mock-1"}))

print("2) 建档")
brief = {"topic": "家用咖啡设备选购", "industry": "家电", "brand": "", "audience": "预算 1000-3000 的上班族",
         "points": "3 秒出咖啡；水箱 1.2L；支持胶囊和粉；质保 2 年", "tone": "平实、专业、讲人话", "extra": ""}
p = call("/api/plans", "POST", {"keyword": "小型咖啡机怎么选", "title": "小型咖啡机怎么选 · 多平台方案", "brief": brief})
pid = p["plan_id"]
print("   plan_id =", pid)

print("3) 生成（2 平台 × 2 篇）")
plats = call("/api/bootstrap")["platforms"]
sel = [{"platform_id": plats[0]["id"], "count": 2}, {"platform_id": plats[3]["id"], "count": 2}]
g = call(f"/api/plans/{pid}/generate", "POST",
         {"selections": sel, "models": ["豆包", "DeepSeek"],
          "platforms": [plats[0]["name"], plats[3]["name"]]})
print("   job:", g["job_id"], "total", g["total"])

for _ in range(60):
    j = call("/api/jobs/" + g["job_id"])["job"]
    if j["status"] in ("done", "error"):
        break
    time.sleep(1)
print("   状态：", j["status"], "|", j["message"])
for it in j["items"]:
    print("   -", it["platform"], it["index"], it["state"], it.get("title", "")[:26], it.get("score"))

plan = call(f"/api/plans/{pid}")["plan"]
print("4) 稿件数：", len(plan["articles"]))
a = plan["articles"][0]
print("   标题：", a["title"])
print("   评分：", a["geo"]["score"], "字数：", a["geo"]["chars"])
print("   未通过项：", [c["name"] for c in a["geo"]["checks"] if not c["ok"]])
print("   正文前 12 行：")
print("\n".join(a["body_md"].splitlines()[:12]))

print("5) 导出 Markdown")
md = call(f"/api/plans/{pid}/export?fmt=md")
md = md.decode("utf-8") if isinstance(md, bytes) else md
print("   长度：", len(md), "| 含对照表：", "抓取偏好对照表" in md, "| 含风险清单：", "风险点清单" in md)

print("6) 上传归档")
up = call(f"/api/plans/{pid}/upload", "POST", {})
print("   ", up)

print("7) 快照检查")
snap = plan["brief"]["snapshot"]
print("   matrix 行数：", len(snap["matrix"]), "风险平台数：", len(snap["risks"]))

print("8) 编辑一篇并回读")
aid = a["id"]
r = call(f"/api/articles/{aid}", "PUT", {"title": a["title"] + "（改）"})
print("   保存后分数：", r.get("geo", {}).get("score"))
