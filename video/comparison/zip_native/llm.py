# -*- coding: utf-8 -*-
"""大模型调用（OpenAI 兼容协议，纯标准库）。

免费接口常见问题都收在这里：
- 429 限流       → 按 Retry-After 或指数退避重试
- 5xx / 超时     → 退避重试
- 401 密钥错     → 直接报错，重试无意义
- 400 参数错     → 若是 response_format 不支持，自动降级重试
- 输出被截断     → 抛 truncated，让调用方提高 max_tokens
"""

import json
import re
import time
import urllib.error
import urllib.request


class LLMError(Exception):
    def __init__(self, msg, kind="unknown", status=None, retry_after=None):
        super().__init__(msg)
        self.kind = kind          # rate_limit / auth / bad_request / server / timeout / network / truncated
        self.status = status
        self.retry_after = retry_after

    @property
    def retryable(self):
        # 连不上（地址错/服务没开）重试也没用，直接提示用户；超时才值得再试
        return self.kind in ("rate_limit", "server", "timeout")


def _endpoint(base):
    base = (base or "").strip().rstrip("/")
    if not base:
        raise LLMError("未填写接口地址（API Base）", "bad_request")
    if base.endswith("/chat/completions"):
        return base
    return base + "/chat/completions"


def _kind_of(status, detail):
    if status == 429:
        return "rate_limit"
    if status in (401, 403):
        return "auth"
    if status == 400:
        return "bad_request"
    if status and 500 <= status < 600:
        return "server"
    return "unknown"


def _friendly(kind, status, detail):
    head = {
        "rate_limit": "接口限流（请求太频繁，免费额度常见）",
        "auth": "API Key 无效或没有权限",
        "bad_request": "请求参数被接口拒绝",
        "server": "接口服务端错误",
        "timeout": "接口响应超时",
        "network": "连不上接口",
        "truncated": "模型输出被长度上限截断",
    }.get(kind, "调用失败")
    tail = (detail or "").strip().replace("\n", " ")
    return f"{head}：{tail[:300]}" if tail else head


def _is_thinking_model(model, base):
    m = (model or "").lower()
    b = (base or "").lower()
    return ("qwen3" in m) or ("qwen" in m and "-thinking" in m) or ("dashscope" in b and "qwen" in m)


def chat(messages, settings, temperature=None, max_tokens=None, force_json=False, timeout=300):
    base = settings.get("api_base", "")
    key = settings.get("api_key", "")
    model = settings.get("model", "")
    if not key:
        raise LLMError("还没有填写 API Key，请点右上角「设置」填一个大模型 Key", "auth")

    payload = {
        "model": model,
        "messages": messages,
        "temperature": settings.get("temperature", 0.8) if temperature is None else temperature,
        "max_tokens": max_tokens or settings.get("max_tokens", 4000),
        "stream": False,
    }
    if force_json:
        payload["response_format"] = {"type": "json_object"}
    # qwen3 系列默认开深度思考，单篇要 2 分钟以上；关掉后 30 秒左右就能出稿
    disable_thinking = bool(settings.get("disable_thinking", True))
    if disable_thinking and _is_thinking_model(model, base):
        payload["enable_thinking"] = False

    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(_endpoint(base), data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + key)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        if e.code == 400 and "enable_thinking" in detail:
            # 该接口不认这个参数，去掉后重试一次
            settings = dict(settings)
            settings["disable_thinking"] = False
            return chat(messages, settings, temperature, max_tokens, force_json, timeout)
        kind = _kind_of(e.code, detail)
        retry_after = None
        try:
            ra = e.headers.get("Retry-After")
            if ra:
                retry_after = max(1, min(120, int(float(ra))))
        except Exception:
            retry_after = None
        raise LLMError(_friendly(kind, e.code, detail), kind, e.code, retry_after)
    except urllib.error.URLError as e:
        reason = str(getattr(e, "reason", e))
        kind = "timeout" if "timed out" in reason.lower() else "network"
        raise LLMError(_friendly(kind, None, reason), kind)
    except TimeoutError:
        raise LLMError(_friendly("timeout", None, ""), "timeout")

    try:
        obj = json.loads(raw)
    except Exception:
        raise LLMError("接口返回内容无法解析：" + raw[:200], "unknown")

    try:
        choice = obj["choices"][0]
        content = choice["message"]["content"] or ""
        finish = choice.get("finish_reason")
    except Exception:
        raise LLMError("接口返回结构异常：" + raw[:200], "unknown")

    if finish == "length":
        raise LLMError(_friendly("truncated", None, "finish_reason=length"), "truncated")
    return content


def chat_stream(messages, settings, temperature=None, max_tokens=None, force_json=False,
                timeout=300):
    """流式调用：逐块吐出模型生成的文本。

    注意：这里不重试、不吞异常。调用方拿到 LLMError 后自己决定要不要重来，
    否则重试会把已经吐出去的内容重复一遍。
    """
    base = settings.get("api_base", "")
    key = settings.get("api_key", "")
    model = settings.get("model", "")
    if not key:
        raise LLMError("还没有填写 API Key，请点右上角「设置」填一个大模型 Key", "auth")

    payload = {
        "model": model,
        "messages": messages,
        "temperature": settings.get("temperature", 0.8) if temperature is None else temperature,
        "max_tokens": max_tokens or settings.get("max_tokens", 4000),
        "stream": True,
    }
    if force_json:
        payload["response_format"] = {"type": "json_object"}
    disable_thinking = bool(settings.get("disable_thinking", True))
    if disable_thinking and _is_thinking_model(model, base):
        payload["enable_thinking"] = False

    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(_endpoint(base), data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + key)
    req.add_header("Accept", "text/event-stream")

    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        kind = _kind_of(e.code, detail)
        retry_after = None
        try:
            ra = e.headers.get("Retry-After")
            if ra:
                retry_after = max(1, min(120, int(float(ra))))
        except Exception:
            retry_after = None
        raise LLMError(_friendly(kind, e.code, detail), kind, e.code, retry_after)
    except urllib.error.URLError as e:
        reason = str(getattr(e, "reason", e))
        kind = "timeout" if "timed out" in reason.lower() else "network"
        raise LLMError(_friendly(kind, None, reason), kind)
    except TimeoutError:
        raise LLMError(_friendly("timeout", None, ""), "timeout")

    try:
        with resp:
            for raw in resp:
                line = raw.decode("utf-8", "ignore").strip()
                if not line or not line.startswith("data:"):
                    continue
                body = line[5:].strip()
                if body in ("[DONE]", "DONE"):
                    break
                try:
                    obj = json.loads(body)
                except Exception:
                    continue
                if isinstance(obj, dict) and obj.get("error"):
                    raise LLMError("接口返回错误：" + str(obj["error"])[:200], "unknown")
                for ch in obj.get("choices") or []:
                    piece = (ch.get("delta") or {}).get("content")
                    if piece:
                        yield piece
    except LLMError:
        raise
    except Exception as e:
        raise LLMError("流式读取中断：" + str(e)[:160], "network")


def stream_with_retry(messages, settings, temperature=None, max_tokens=None, force_json=False,
                      timeout=300, max_retries=3, on_wait=None):
    """流式 + 限流重试。只在「一个字都还没吐出来」时重试，避免重复输出。"""
    delays = [2, 4, 8, 16]
    last = None
    for attempt in range(max_retries + 1):
        produced = False
        try:
            for piece in chat_stream(messages, settings, temperature, max_tokens,
                                     force_json, timeout):
                produced = True
                yield piece
            return
        except LLMError as e:
            last = e
            if produced or e.kind not in ("rate_limit", "server", "timeout", "network"):
                raise
            if attempt >= max_retries:
                break
            wait = e.retry_after or delays[min(attempt, len(delays) - 1)]
            if on_wait:
                on_wait(wait, e)
            time.sleep(wait)
    raise last or LLMError("流式调用失败")


def chat_with_retry(messages, settings, temperature=None, max_tokens=None, force_json=False,
                    timeout=300, max_retries=5, on_wait=None):
    """带退避重试的调用。on_wait(seconds, err) 用于向前端报告等待状态。"""
    delays = [2, 4, 8, 16, 32]
    last = None
    for attempt in range(max_retries + 1):
        try:
            return chat(messages, settings, temperature, max_tokens, force_json, timeout)
        except LLMError as e:
            last = e
            if e.kind == "bad_request" and force_json and "response_format" in str(e):
                force_json = False
                continue
            if not e.retryable or attempt >= max_retries:
                raise
            wait = e.retry_after or delays[min(attempt, len(delays) - 1)]
            if on_wait:
                try:
                    on_wait(wait, e)
                except Exception:
                    pass
            time.sleep(wait)
    raise last


def parse_json(text):
    """从模型输出里稳健地取出 JSON 对象。"""
    if not text:
        return None
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except Exception:
        pass
    start, end = t.find("{"), t.rfind("}")
    if start >= 0 and end > start:
        frag = t[start:end + 1]
        try:
            return json.loads(frag)
        except Exception:
            frag2 = re.sub(r",\s*([}\]])", r"\1", frag)
            try:
                return json.loads(frag2)
            except Exception:
                return None
    return None


def ping(settings):
    txt = chat([{"role": "user", "content": "只回复两个字：可用"}], settings,
               temperature=0, max_tokens=20, timeout=40)
    return (txt or "").strip()[:40]
