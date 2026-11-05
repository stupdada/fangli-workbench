"""Bailian WebSearch over the documented Streamable HTTP MCP endpoint."""
import json
import os
import re
from urllib import error, request
from urllib.parse import urlsplit

from .errors import Problem

ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp'
MAX_RESPONSE = 1024 * 1024
COUNT = 8
SUPPORTED_PROTOCOLS = ('2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25')


class SearchUnavailable(Problem):
    status = 503


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def public_url(value):
    if not isinstance(value, str) or len(value) > 2000 or not value.isprintable() or any(c.isspace() for c in value):
        return ''
    try:
        url = urlsplit(value)
        if url.scheme in ('http', 'https') and url.hostname and not url.username and not url.password and '\\' not in value:
            return value
    except ValueError:
        pass
    return ''


def candidates(result):
    """Keep provider links and snippets as leads. An unknown result is a protocol error."""
    if not isinstance(result, dict) or result.get('isError'):
        raise SearchUnavailable('公开搜索服务未返回有效结果')
    payloads, plain = [], []
    if 'structuredContent' in result:
        payloads.append(result['structuredContent'])
    blocks = result.get('content', [])
    if not isinstance(blocks, list):
        raise SearchUnavailable('公开搜索回执的格式未识别，请稍后核对接口')
    for part in blocks:
        if isinstance(part, dict) and part.get('type') == 'text' and isinstance(part.get('text'), str):
            try:
                payloads.append(json.loads(part['text']))
            except ValueError:
                plain.append(part['text'])

    for payload in payloads:
        if isinstance(payload, dict):
            if 'pages' in payload:
                status = payload.get('status')
                if type(status) is not int or status != 0 or not isinstance(payload['pages'], list):
                    raise SearchUnavailable('公开搜索服务未返回有效结果')
                payload = payload['pages']
            else:
                payload = next((payload[key] for key in ('results', 'searchResults', 'data') if isinstance(payload.get(key), list)), None)
        if not isinstance(payload, list):
            continue
        found = {}
        for item in payload:
            if not isinstance(item, dict):
                continue
            url = public_url(item.get('url') or item.get('link'))
            if not url or url in found:
                continue
            title = item.get('title')
            snippet = item.get('snippet') or item.get('summary') or item.get('content') or ''
            found[url] = {'url':url, 'title':title[:300] if isinstance(title, str) else url,
                          'snippet':snippet[:1200] if isinstance(snippet, str) else ''}
        if found or not payload:
            return list(found.values())[:COUNT]
    # MCP also permits plain text blocks. Links in those blocks remain unreviewed leads.
    links = {}
    for block in plain:
        for match in re.finditer(r'https?://[^\s<>()\[\]"，。；、]+', block):
            url = public_url(match.group().rstrip('.,;'))
            if url and url not in links:
                links[url] = {'url':url,'title':url,'snippet':''}
    if links:
        return list(links.values())[:COUNT]
    if result.get('content') == [] and 'structuredContent' not in result:
        return []
    raise SearchUnavailable('公开搜索回执的格式未识别，请稍后核对接口')


class BailianClaimSearch:
    @staticmethod
    def configured():
        return bool(os.environ.get('DASHSCOPE_API_KEY', '').strip())

    def __call__(self, query):
        key = os.environ.get('DASHSCOPE_API_KEY', '').strip()
        if not key:
            raise SearchUnavailable('当前工作台未配置公开搜索凭据')
        opener = request.build_opener(NoRedirect)
        protocol = '2025-03-26'
        session = None

        def rpc(method, params, ident=None):
            payload = {'jsonrpc':'2.0','method':method}
            if params is not None:
                payload['params'] = params
            if ident is not None:
                payload['id'] = ident
            headers = {'Authorization':'Bearer '+key, 'Content-Type':'application/json',
                       'Accept':'application/json, text/event-stream', 'MCP-Protocol-Version':protocol}
            if session:
                headers['Mcp-Session-Id'] = session
            req = request.Request(ENDPOINT, data=json.dumps(payload, ensure_ascii=False).encode(), headers=headers, method='POST')
            try:
                with opener.open(req, timeout=15) as response:
                    sid = response.headers.get('Mcp-Session-Id')
                    if ident is None:
                        return {}, sid
                    if response.headers.get_content_type() == 'text/event-stream':
                        obj = self._read_event(response, ident)
                    else:
                        raw = response.read(MAX_RESPONSE+1)
                        if len(raw) > MAX_RESPONSE:
                            raise SearchUnavailable('公开搜索回执超过大小限制')
                        obj = json.loads(raw)
            except error.HTTPError as exc:
                message = {401:'公开搜索凭据未通过验证',403:'当前凭据没有公开搜索权限',
                           404:'当前凭据无法使用已配置的公开搜索服务',429:'公开搜索服务暂时限流'}.get(exc.code)
                raise SearchUnavailable(message or '公开搜索服务暂时无法响应') from None
            except (OSError, ValueError):
                raise SearchUnavailable('公开搜索服务暂时无法响应') from None
            if not isinstance(obj, dict) or obj.get('id') != ident or not isinstance(obj.get('result'), dict):
                raise SearchUnavailable('公开搜索服务未返回有效结果')
            return obj['result'], sid

        init, session = rpc('initialize', {'protocolVersion':protocol, 'capabilities':{},
                            'clientInfo':{'name':'fangli-claim-search','version':'1.0'}}, 1)
        protocol = init.get('protocolVersion')
        # Bailian's Streamable HTTP endpoint can negotiate the older message version.
        if protocol not in SUPPORTED_PROTOCOLS:
            raise SearchUnavailable('公开搜索服务协议版本不受支持')
        rpc('notifications/initialized', None)
        result, _ = rpc('tools/call', {'name':'bailian_web_search','arguments':{'query':query,'count':COUNT}}, 2)
        return candidates(result)

    @staticmethod
    def _read_event(response, ident):
        remaining = MAX_RESPONSE
        data = []
        while remaining > 0:
            line = response.readline(remaining+1)
            remaining -= len(line)
            if remaining < 0 or not line:
                break
            if line.startswith(b'data:'):
                data.append(line[5:].strip())
            elif not line.strip() and data:
                obj = json.loads(b'\n'.join(data))
                if isinstance(obj, dict) and obj.get('id') == ident:
                    return obj
                data.clear()
        raise SearchUnavailable('公开搜索流未返回完整结果')
