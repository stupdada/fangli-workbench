"""Discover explicit local API configuration and stream chat completions."""
import json
import os
import sys
from urllib import error, parse, request


PROVIDERS = {
    'deepseek': ('DeepSeek 官方 API', 'DEEPSEEK', 'https://api.deepseek.com', 'deepseek-flash'),
    'dashscope': ('阿里云百炼 API', 'DASHSCOPE', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'),
    'compatible': ('自定义兼容 API', 'GEO_LLM', '', ''),
}


def connection(transport):
    _, prefix, default_base, default_model = PROVIDERS[transport]
    key = os.environ.get(prefix + '_API_KEY', '').strip()
    base = (os.environ.get(prefix + '_BASE_URL', '').strip() or default_base).rstrip('/')
    model = os.environ.get(prefix + '_MODEL', '').strip() or default_model
    try:
        url = parse.urlsplit(base)
        if not (url.scheme == 'https' or url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1', '::1')):
            return None
        if not url.hostname or url.username or url.password or url.query or url.fragment:
            return None
        if url.port == 0:
            return None
    except ValueError:
        return None
    if not key or any(char.isspace() for char in key):
        return None
    return key, base, model


def sources():
    found = []
    for ident, (name, _, _, _) in PROVIDERS.items():
        config = connection(ident)
        found.append({'id': ident, 'name': name, 'configured': config is not None,
                      'default_model': config[2] if config else ''})
    return found


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def execute(payload, emit):
    transport = payload['transport']
    config = connection(transport)
    if not config:
        emit({'type': 'error', 'kind': 'configuration'})
        return
    key, base, _ = config
    suffix = '/chat/completions'
    endpoint = base if base.endswith(suffix) else base + suffix
    body = {k: payload[k] for k in ('model', 'messages', 'temperature', 'max_tokens')}
    body['stream'] = True
    if payload['force_json']:
        body['response_format'] = {'type': 'json_object'}
    if 'thinking' in payload:
        body['thinking'] = payload['thinking']
    if 'enable_thinking' in payload:
        body['enable_thinking'] = payload['enable_thinking']
    if transport in ('deepseek', 'dashscope'):
        body['stream_options'] = {'include_usage': True}
    req = request.Request(endpoint, json.dumps(body, ensure_ascii=False).encode('utf-8'), {
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Accept': 'text/event-stream',
    }, method='POST')
    finish = None
    with request.build_opener(NoRedirect).open(req, timeout=payload['timeout']) as response:
        if response.headers.get_content_type() != 'text/event-stream':
            raise ValueError('expected event stream')
        data = []
        for line in response:
            line = line.decode('utf-8').rstrip('\r\n')
            if line.startswith('data:'):
                data.append(line[5:].lstrip(' '))
            if line or not data:
                continue
            event = '\n'.join(data)
            data.clear()
            if event == '[DONE]':
                emit({'type': 'done', 'finish_reason': finish})
                return
            chunk = json.loads(event)
            if chunk.get('error'):
                raise ValueError('upstream error')
            choices = chunk.get('choices') or []
            if choices:
                choice = choices[0]
                delta = choice.get('delta') or {}
                if delta.get('refusal') or delta.get('tool_calls'):
                    raise ValueError('unexpected choice')
                if isinstance(delta.get('content'), str) and delta['content']:
                    emit({'type': 'delta', 'text': delta['content']})
                finish = choice.get('finish_reason') or finish
            if isinstance(chunk.get('usage'), dict):
                usage = {k: v for k, v in chunk['usage'].items()
                         if k in ('prompt_tokens', 'completion_tokens', 'total_tokens') and type(v) is int}
                emit({'type': 'usage', 'usage': usage})
    raise ValueError('incomplete event stream')


if __name__ == '__main__':
    def emit(value):
        print(json.dumps(value, ensure_ascii=False), flush=True)

    try:
        execute(json.load(sys.stdin), emit)
    except error.HTTPError as exc:
        status = exc.code
        exc.close()
        kind = ('auth' if status in (401, 403) else 'rate_limited' if status == 429 else
                'provider_rejected' if 300 <= status < 500 else 'uncertain')
        emit({'type': 'error', 'kind': kind, 'status': status})
    except (OSError, ValueError, TypeError, AttributeError):
        emit({'type': 'error', 'kind': 'uncertain'})
