# -*- coding: utf-8 -*-
"""接口稳定性测试：限流退避、错误分类、降级、截断识别。

用本地假接口按脚本返回 429/401/400/500/截断，验证 llm 层的处理是否符合预期。

用法：python tools/test_retry.py
"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import llm  # noqa: E402

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append((name, detail))
    print(("  [通过] " if ok else "  [失败] ") + name + (("  -> " + detail) if detail and not ok else ""))


SCRIPT = []        # 每项：(status, headers, body)
CALLS = []         # 每次请求的 body（dict）


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        CALLS.append(body)
        if not SCRIPT:
            status, headers, payload = 200, {}, ok_body("兜底")
        else:
            status, headers, payload = SCRIPT.pop(0) if len(SCRIPT) > 1 else SCRIPT[0]
        raw = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        for k, v in (headers or {}).items():
            self.send_header(k, str(v))
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def ok_body(text):
    return {"choices": [{"message": {"content": text}, "finish_reason": "stop"}]}


def trunc_body():
    return {"choices": [{"message": {"content": "半截"}, "finish_reason": "length"}]}


PORT = 8893
SETTINGS = {"api_base": f"http://127.0.0.1:{PORT}/v1", "api_key": "k", "model": "m",
            "temperature": 0.7, "max_tokens": 1000}

# 把 sleep 换成记录，避免测试真的等
WAITS = []
llm.time.sleep = lambda s: WAITS.append(s)

srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ["no_proxy"] = "127.0.0.1"
os.environ["NO_PROXY"] = "127.0.0.1"

MSGS = [{"role": "user", "content": "只说 JSON"}]


def reset(script):
    global SCRIPT, CALLS, WAITS
    SCRIPT = list(script)
    CALLS = []
    WAITS = []


print("\n[1] 429 限流：按退避重试后成功")
reset([(429, {}, {"error": "rate limit"}), (429, {}, {"error": "rate limit"}), (200, {}, ok_body("好了"))])
try:
    out = llm.chat_with_retry(MSGS, SETTINGS, max_retries=5)
    check("最终拿到结果", out == "好了")
    check("调用 3 次", len(CALLS) == 3, str(len(CALLS)))
    check("退避 2 秒、4 秒", WAITS == [2, 4], str(WAITS))
except Exception as e:
    check("最终拿到结果", False, str(e))

print("\n[2] Retry-After 优先于默认退避")
reset([(429, {"Retry-After": "7"}, {"error": "slow down"}), (200, {}, ok_body("ok"))])
try:
    llm.chat_with_retry(MSGS, SETTINGS)
    check("按服务端要求的 7 秒等待", WAITS == [7], str(WAITS))
except Exception as e:
    check("按服务端要求的 7 秒等待", False, str(e))

print("\n[3] 401 不重试，直接报密钥问题")
reset([(401, {}, {"error": "invalid api key"})])
try:
    llm.chat_with_retry(MSGS, SETTINGS)
    check("应当抛错", False)
except llm.LLMError as e:
    check("错误分类为 auth", e.kind == "auth", e.kind)
    check("只调用了 1 次，不做无意义重试", len(CALLS) == 1, str(len(CALLS)))
    check("提示可读", "API Key" in str(e), str(e)[:60])

print("\n[4] 400 response_format 不支持：自动降级")
reset([(400, {}, {"error": "response_format is not supported"}), (200, {}, ok_body("降级成功"))])
try:
    out = llm.chat_with_retry(MSGS, SETTINGS, force_json=True)
    check("降级后成功", out == "降级成功")
    check("第一次带 response_format", "response_format" in CALLS[0], str(CALLS[0].keys()))
    check("第二次去掉 response_format", "response_format" not in CALLS[1], str(CALLS[1].keys()))
except Exception as e:
    check("降级后成功", False, str(e))

print("\n[5] 500 服务端错误：重试")
reset([(500, {}, {"error": "internal"}), (200, {}, ok_body("恢复"))])
try:
    out = llm.chat_with_retry(MSGS, SETTINGS)
    check("重试后成功", out == "恢复")
    check("重试了 1 次", len(CALLS) == 2, str(len(CALLS)))
except Exception as e:
    check("重试后成功", False, str(e))

print("\n[6] 连续 429 超出重试上限要报错")
reset([(429, {}, {"error": "rate limit"})])
try:
    llm.chat_with_retry(MSGS, SETTINGS, max_retries=2)
    check("应当抛错", False)
except llm.LLMError as e:
    check("超出上限时报 rate_limit", e.kind == "rate_limit", e.kind)
    check("总共请求 3 次（1 次 + 2 次重试）", len(CALLS) == 3, str(len(CALLS)))

print("\n[7] 输出被截断要能被识别")
reset([(200, {}, trunc_body())])
try:
    llm.chat(MSGS, SETTINGS)
    check("应当抛错", False)
except llm.LLMError as e:
    check("分类为 truncated", e.kind == "truncated", e.kind)
    check("提示说明是长度问题", "截断" in str(e), str(e)[:60])
    check("截断不重试", not e.retryable)

print("\n[8] 没有 Key 时立刻报错，不发请求")
reset([(200, {}, ok_body("x"))])
try:
    llm.chat(MSGS, {"api_base": SETTINGS["api_base"], "api_key": "", "model": "m"})
    check("应当抛错", False)
except llm.LLMError as e:
    check("分类为 auth", e.kind == "auth", e.kind)
    check("没有发出请求", len(CALLS) == 0, str(len(CALLS)))

print("\n[9] 网络不通归类为 network")
bad = dict(SETTINGS)
bad["api_base"] = "http://127.0.0.1:8899/v1"
try:
    llm.chat(MSGS, bad, timeout=3)
    check("应当抛错", False)
except llm.LLMError as e:
    check("分类为 network", e.kind == "network", e.kind)
    check("不可重试", not e.retryable)

print("\n[9b] 千问深度思考开关")
QWEN = dict(SETTINGS)
QWEN["model"] = "qwen3.8-max"
QWEN["api_base"] = "https://dashscope.aliyuncs.com/compatible-mode/v1"

import app.llm as _llm  # noqa: E402
check("识别出 qwen3 是思考模型", _llm._is_thinking_model("qwen3.8-max", QWEN["api_base"]))
check("普通模型不误判", not _llm._is_thinking_model("deepseek-chat", "https://api.deepseek.com/v1"))
check("glm 不误判", not _llm._is_thinking_model("glm-4.7-flash", "https://open.bigmodel.cn/api/paas/v4"))

# 用本地假接口验证参数确实带上了
QWEN_LOCAL = dict(SETTINGS)
QWEN_LOCAL["model"] = "qwen3.8-max"
reset([(200, {}, ok_body("x"))])
_llm.chat(MSGS, dict(QWEN_LOCAL, disable_thinking=True))
check("默认带上 enable_thinking=false", CALLS[0].get("enable_thinking") is False, str(CALLS[0].keys()))

reset([(200, {}, ok_body("x"))])
_llm.chat(MSGS, dict(QWEN_LOCAL, disable_thinking=False))
check("关掉开关后不带该参数", "enable_thinking" not in CALLS[0], str(CALLS[0].keys()))

reset([(200, {}, ok_body("x"))])
_llm.chat(MSGS, dict(SETTINGS, disable_thinking=True))
check("非千问模型不带该参数", "enable_thinking" not in CALLS[0], str(CALLS[0].keys()))

# 接口不认这个参数时要去掉重试
reset([(400, {}, {"error": "Unsupported parameter: enable_thinking"}),
       (200, {}, ok_body("去掉参数后成功"))])
try:
    out = _llm.chat(MSGS, dict(QWEN_LOCAL, disable_thinking=True))
    check("不认参数时自动去掉重试", out == "去掉参数后成功", str(out))
    check("重试时不带 enable_thinking", "enable_thinking" not in CALLS[-1])
except Exception as e:
    check("不认参数时自动去掉重试", False, str(e)[:80])

print("\n[10] 正常 JSON 解析容错")
check("纯 JSON 能解析", llm.parse_json('{"a":1}') == {"a": 1})
check("带代码块能解析", llm.parse_json('```json\n{"a":1}\n```') == {"a": 1})
check("前后有废话能解析", llm.parse_json('好的，如下：{"a":1} 完毕') == {"a": 1})
check("多余逗号能修", llm.parse_json('{"a":1,}') == {"a": 1})
check("彻底不是 JSON 返回 None", llm.parse_json("这不是 JSON") is None)

srv.shutdown()

print("\n" + "=" * 46)
print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
if failed:
    for n, d in failed:
        print("  失败：" + n + ("  " + d if d else ""))
    print("结果：不通过")
    sys.exit(1)
print("结果：全部通过")
