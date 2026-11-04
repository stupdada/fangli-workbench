"""ZIP call signatures over the WorkBuddy SDK. No implicit retry or model switch."""
import json
import os
import queue
import shutil
import subprocess
import threading
import time
from pathlib import Path
from app import llm

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = 'deepseek-v4.1-flash'
local = threading.local()


def public_error(error):
    if isinstance(error, llm.LLMError):
        return str(error)[:400]
    from .errors import Problem
    if isinstance(error, Problem):
        return str(error)[:400]
    return '本地处理未完成，已保存内容保留；请查看服务状态后明确重试'


def failure(kind='uncertain', status=None):
    # These kinds intentionally cannot trigger ZIP's network/bad_request fallback.
    messages = {
        'auth': 'WorkBuddy 连接未获授权，请检查本机连接配置',
        'configuration': 'WorkBuddy 需要 Node.js 20+ 和有效的本机连接配置',
        'provider_rejected': 'WorkBuddy 拒绝了本次请求；请核对模型与参数后明确重试',
        'rate_limited': 'WorkBuddy 当前限流；本次已停止，请稍后明确重试',
        'truncated': '模型输出被长度上限截断，未当作完整结果；请调整后明确重试',
        'cancelled': '已停止本地处理；云端是否已停止无法确认，未自动重复请求',
        'uncertain': 'WorkBuddy 返回不完整、超时或连接中断；执行状态不确定，未自动重复调用',
    }
    return llm.LLMError(messages.get(kind, messages['uncertain']), kind, status)


def events(payload):
    node = shutil.which(os.environ.get('GEO_NODE', 'node'))
    if not node:
        raise failure('configuration')
    proc = subprocess.Popen([node, str(ROOT / 'bridge/workbuddy.cjs')], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    inbox = queue.Queue(maxsize=256)
    closing = threading.Event()

    def read():
        try:
            for line in proc.stdout:
                while not closing.is_set():
                    try:
                        inbox.put(line, timeout=.2)
                        break
                    except queue.Full:
                        pass
        finally:
            if not closing.is_set():
                inbox.put(None)

    reader = threading.Thread(target=read, name='workbuddy-stdout', daemon=True)
    reader.start()
    ended = False
    deadline = time.monotonic() + payload.get('timeout', 300) + 5
    try:
        proc.stdin.write(json.dumps(payload, ensure_ascii=False, allow_nan=False))
        proc.stdin.close()
        while True:
            cancelled = getattr(local, 'cancel', None)
            if cancelled and cancelled.is_set():
                raise failure('cancelled')
            try:
                line = inbox.get(timeout=.2)
            except queue.Empty:
                if time.monotonic() >= deadline:
                    raise failure()
                continue
            if line is None:
                break
            deadline = time.monotonic() + payload.get('timeout', 300) + 5
            try:
                item = json.loads(line)
            except (ValueError, TypeError):
                raise failure() from None
            if not isinstance(item, dict):
                raise failure()
            kind = item.get('type')
            if kind == 'error':
                trace = getattr(local, 'trace', None)
                if trace:
                    trace('provider_error', {'kind': item.get('kind'), 'status': item.get('status'),
                        'diagnostic': item.get('diagnostic', {})})
                raise failure(item.get('kind') or 'uncertain', item.get('status'))
            if kind in ('done', 'models'):
                ended = True
            if ended and kind not in ('done', 'models'):
                raise failure()
            yield item
        proc.wait(timeout=3)
        if not ended or proc.returncode:
            raise failure()
    except (OSError, subprocess.SubprocessError, UnicodeError):
        raise failure() from None
    finally:
        closing.set()
        if proc.poll() is None:
            proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)
        reader.join(timeout=1)
        if not proc.stdin.closed:
            proc.stdin.close()
        proc.stdout.close()


def stream(messages, settings, temperature=None, max_tokens=None, force_json=False, timeout=300, **_):
    # Native regeneration has its own fallback loop. A failed WorkBuddy operation
    # must never dispatch another request through that loop without a new user action.
    previous = getattr(local, 'failure', None)
    if previous: raise failure(previous['kind'], previous.get('status'))
    payload = {'model': settings.get('model') or DEFAULT_MODEL, 'messages': messages,
               'temperature': settings.get('temperature', .8) if temperature is None else temperature,
               'max_tokens': max_tokens or settings.get('max_tokens', 4000),
               'force_json': force_json, 'timeout': timeout}
    if settings.get('disable_thinking', True) and llm._is_thinking_model(payload['model'], settings.get('api_base', '')):
        payload['enable_thinking'] = False
    trace = getattr(local, 'trace', None)
    pieces, error, done = [], None, False
    if trace:
        trace('request', payload)
    try:
        for item in events(payload):
            if item.get('type') == 'delta' and isinstance(item.get('text'), str):
                pieces.append(item['text'])
                yield item['text']
            elif item.get('type') == 'usage' and getattr(local, 'usage', None) is not None:
                local.usage.append(item['usage'])
            elif item.get('type') == 'done':
                finish = item.get('finish_reason')
                if finish != 'stop':
                    raise failure('truncated' if finish == 'length' else 'uncertain')
                done = True
        if not done or not ''.join(pieces).strip():
            raise failure()
    except llm.LLMError as exc:
        error = {'kind': exc.kind, 'status': exc.status, 'message': public_error(exc)}
        local.failure = error
        halt = getattr(local, 'halt', None)
        if halt:
            halt()
        raise
    finally:
        if trace:
            trace('response', {'text': ''.join(pieces), 'finish_reason': 'stop' if done else None, 'error': error})


def chat(messages, settings, temperature=None, max_tokens=None, force_json=False, timeout=300, **kwargs):
    return ''.join(stream(messages, settings, temperature, max_tokens, force_json, timeout, **kwargs))


def models():
    for item in events({'operation': 'models', 'timeout': 30}):
        if item.get('type') == 'models' and isinstance(item.get('models'), list):
            return item['models']
    raise failure()


def install():
    llm.chat = chat
    llm.chat_stream = stream
    llm.chat_with_retry = chat
    llm.stream_with_retry = stream
