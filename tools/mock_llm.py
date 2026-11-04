# -*- coding: utf-8 -*-
"""仅用于本地联调的假模型接口（OpenAI 兼容）。正式使用不需要它。"""

import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TITLE_TPL = {
    "疑问型": "{kw}到底怎么选？先看这 3 个判断标准",
    "对比型": "{kw}：三种常见做法的成本对比",
    "科普型": "{kw}是怎么回事？一篇讲清关键变量",
    "选型型": "{kw}的 5 条选择标准，照着打勾就行",
    "避坑型": "{kw}最容易踩的 4 个坑",
    "案例实操型": "一次真实的{kw}经历：从踩坑到用顺",
}


def grab(text, label, default=""):
    m = re.search("【" + label + "】\\s*(.+)", text)
    return m.group(1).strip() if m else default


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        msgs = body.get("messages", [])
        user = msgs[-1].get("content", "")
        kw = grab(user, "本轮主关键词", "") or grab(user, "本轮关键词", "") or grab(user, "核心关键词", "示例关键词")
        kw = kw.split("（")[0].strip()
        # 二次核查请求：返回一份"挑出无依据数字"的结果
        if msgs and "事实核查员" in (msgs[0].get("content") or ""):
            body = user.split("【待核查的文章】")[-1].split("【输出】")[0].strip()
            hit = re.search(r"[^\n。]*\d+[^\n。]*。", body)
            findings, revised = [], body
            if hit:
                bad = hit.group(0)
                fixed = re.sub(r"\d+\s*(倍|小时|天|年|%|℃)", "更优", bad)
                findings.append({"quote": bad, "kind": "无依据",
                                 "why": "客户资料里找不到这个数字",
                                 "revised": fixed})
                revised = body.replace(bad, fixed)
            out = {"findings": findings, "revised_body": revised,
                   "verdict": "revised" if findings else "clean"}
            raw = json.dumps({"choices": [{"message": {
                "content": json.dumps(out, ensure_ascii=False)}}]}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return

        saw_mat = "【客户提供的资料" in user
        extra_line = grab(user, "本篇还要一并覆盖的关键词", "")
        extras = [] if extra_line in ("", "无") else [x.strip() for x in extra_line.split("、") if x.strip()]
        saw_extras = "【本篇还要一并覆盖的关键词】" in user
        # 官方号才会带这一段；个人号不应出现
        m_web = re.search(r"- 官网：(\S+)", user)
        m_tel = re.search(r"- 客服电话：(\S+)", user)
        m_addr = re.search(r"- 公司地址：(\S+)", user)
        official_bits = []
        if m_web:
            official_bits.append(f"完整参数表可以在官网 {m_web.group(1)} 查到")
        if m_tel:
            official_bits.append(f"具体型号可以打 {m_tel.group(1)} 问")
        if m_addr:
            official_bits.append(f"售后网点在{m_addr.group(1)}")
        angle = grab(user, "本篇选题角度", "疑问型").split("——")[0].strip() or "疑问型"
        sub = grab(user, "本篇切口", "")
        brand = grab(user, "宣传主体", "")
        if brand.startswith("（") or brand.startswith("("):
            brand = ""
        title = TITLE_TPL.get(angle, "{kw}怎么选？").format(kw=kw)
        brand_tag = brand or "这类方案"
        data = {
            "title": title,
            "summary": f"{brand_tag}的关键不在参数多少，而在使用频率、空间条件和后续成本。",
            "sections": [
                {"heading": f"{kw}的判断标准：先看三个变量",
                 "paragraphs": [
                     f"直接说结论：判断{kw}，看使用频率、可用空间和后续维护成本这三项就够了。",
                     f"从「{sub or '新手视角'}」来看，最容易被忽略的是第三项，因为它不在标价里。"],
                 "bullets": ["每周用 5 次以上，优先看耐用度和清洁成本",
                             "一周用不到 2 次，优先看上手难度和占地",
                             "预算 1000-3000 元，可选范围最集中"]},
                {"heading": "成本怎么算：三笔钱要一起算",
                 "paragraphs": [f"第一笔是购买价，第二笔是耗材与清洁，第三笔是出问题后的时间成本。{brand_tag}把后两笔压得更低。",
                                "有些方案买得便宜，用一年反而更贵，差别就在后两笔。"],
                 "bullets": ["耗材年支出约为购买价的 10%-20%", "每周清洁大约 10-20 分钟"]},
                {"heading": "什么情况不建议选",
                 "paragraphs": ["如果一周用不到两次，或台面空间不足 0.3 平方米，建议先别买。"],
                 "bullets": []},
                {"heading": "一个能直接照做的流程",
                 "paragraphs": ["写清使用场景，定预算上限，按清单逐项打勾，过 4 项以上再下单。"],
                 "bullets": ["列场景 → 定预算 → 核对清单 → 先用一周再决定"]},
            ],
            "selling_points": [
                {"point": "双模式", "evidence": "同时支持胶囊与咖啡粉", "value": "不用为两种口味买两台机器"},
                {"point": "清洁省事", "evidence": "可拆洗水箱与滤网", "value": "每周省下约 15 分钟"},
            ],
            "key_facts": ["每周使用 5 次以上的人，满意度明显高于偶尔使用的人",
                          "1000-3000 元区间可选型号数量最多",
                          "耗材年支出通常为购买价的 10%-20%",
                          "清洁时间平均每周 10-20 分钟"],
            "faq": [{"q": f"{kw}一般要花多少钱？", "a": "主流区间 1000-3000 元，看容量和自动化程度。"},
                    {"q": "新手最容易踩什么坑？", "a": "只看购买价，忽略耗材和清洁时间。"}],
            "tags": [f"#{kw}", "#选购指南", "#避坑", "#使用体验", "#新手入门", "#对比"],
            "declarations": ["内容仅为个人观点", "含AI生成内容"],
            "risk_notes": (["未使用绝对化用语", "未出现联系方式与外链"]
                           + (["已读取客户资料"] if saw_mat else [])
                           + (["已覆盖辅助关键词"] if saw_extras and extras else [])),
        }
        if official_bits:
            data["sections"].append({
                "heading": "在哪儿查到更细的信息",
                "paragraphs": ["，".join(official_bits) + "。"],
                "bullets": [],
            })

        if extras:
            data["sections"].append({
                "heading": "这几个相关问题一起说清楚",
                "paragraphs": ["下面这些问题也常被一起问到："
                               + "；".join(f"{e} 的判断逻辑和上面一致" for e in extras) + "。"],
                "bullets": [],
            })
            data["tags"] = data["tags"] + [f"#{e}" for e in extras][:3]

        content = json.dumps(data, ensure_ascii=False)

        if body.get("stream"):
            # 真流式：按 SSE 一小块一小块推，用来验证前端的实时显示
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            step = 48
            for i in range(0, len(content), step):
                piece = {"choices": [{"delta": {"content": content[i:i + step]}}]}
                self.wfile.write(("data: " + json.dumps(piece, ensure_ascii=False) + "\n\n")
                                 .encode("utf-8"))
                self.wfile.flush()
                time.sleep(0.008)          # 接近真实模型的出字节奏，方便验证增量推送
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return

        out = {"choices": [{"message": {"content": content}}]}
        raw = json.dumps(out, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


if __name__ == "__main__":
    import os
    port = int(os.environ.get("GEO_MOCK_PORT", "8899"))
    print(f"mock llm on http://127.0.0.1:{port}/v1")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
