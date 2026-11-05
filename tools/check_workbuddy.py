"""本机 WorkBuddy 连接检查：依赖、SDK 加载、配置格式，可选最小真实调用。

默认只做离线检查，不发起任何网络请求。`--live` 只做一次模型目录查询（不产生正文
token）；`--live-chat` 额外做一次最小对话（会消耗你自己的额度），需要显式指定。
输出只包含字段是否有效与端点主机名，不回显 publishableKey、令牌或完整地址。
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'config/workbuddy.json'
EXAMPLE = ROOT / 'config/workbuddy.example.json'
SDK = ROOT / 'vendor/workbuddy-sdk.js'
DRIVER = ROOT / 'bridge/workbuddy.cjs'
PLACEHOLDERS = ('YOUR-WORKBUDDY-ENDPOINT', 'YOUR-OAUTH-RELAY', 'REPLACE_WITH_YOUR', 'example')
DEFAULT_MODEL = 'deepseek-v4.1-flash'

# 与 SDK 的 resolveRuntimeConfig 一致：endpoint 必须为绝对 http(s) 地址，
# publishableKey 必须以 wbpk_ 开头，oauthRelayBaseUrl 可留空。
SDK_PROBE = r"""
const fs = require('node:fs'), vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const ctx = vm.createContext({fetch() {}, Headers, Request, Response, URL, URLSearchParams,
  TextDecoder, TextEncoder, ReadableStream, AbortController, DOMException, crypto: webcrypto,
  setTimeout, clearTimeout, localStorage: {getItem: () => null, setItem() {}, removeItem() {}},
  sessionStorage: {getItem: () => null, setItem() {}, removeItem() {}}, console: {log() {}, warn() {}, error() {}}});
ctx.window = ctx; ctx.self = ctx;
vm.runInContext(fs.readFileSync(process.argv[1], 'utf8'), ctx);
const factory = ctx.WorkBuddyCloud && ctx.WorkBuddyCloud.createWorkBuddyCloud;
if (typeof factory !== 'function') { console.log(JSON.stringify({ok: false, reason: 'missing_factory'})); process.exit(0); }
const accepts = (config) => { try { factory(config); return true; } catch { return false; } };
console.log(JSON.stringify({ok: true, accepts_valid: accepts({endpoint: 'http://127.0.0.1:1', publishableKey: 'wbpk_probe'}),
  rejects_bad_key: !accepts({endpoint: 'http://127.0.0.1:1', publishableKey: 'wrong'}),
  rejects_bad_url: !accepts({endpoint: 'not-a-url', publishableKey: 'wbpk_probe'})}));
"""


def url_problem(value):
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return 'invalid_url'
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        return 'invalid_url'
    return ''


def inspect_config():
    result = {'path': 'config/workbuddy.json', 'present': CONFIG.is_file(), 'fields': {}, 'problems': []}
    if not CONFIG.is_file():
        example = {}
        try:
            example = json.loads(EXAMPLE.read_text(encoding='utf-8'))
        except Exception:
            pass
        result['problems'].append({'field': 'file', 'reason': 'missing_local_config',
                                   'fix': '复制 config/workbuddy.example.json 为 config/workbuddy.json 后填写自己的连接值'})
        result['expected_fields'] = sorted(example) or ['endpoint', 'oauthRelayBaseUrl', 'publishableKey']
        return result
    try:
        data = json.loads(CONFIG.read_text(encoding='utf-8'))
    except Exception:
        result['problems'].append({'field': 'file', 'reason': 'invalid_json'})
        return result
    if not isinstance(data, dict):
        result['problems'].append({'field': 'file', 'reason': 'not_an_object'})
        return result

    endpoint = data.get('endpoint')
    if not isinstance(endpoint, str) or not endpoint.strip():
        result['fields']['endpoint'] = 'missing'
        result['problems'].append({'field': 'endpoint', 'reason': 'missing'})
    elif any(mark in endpoint for mark in PLACEHOLDERS):
        result['fields']['endpoint'] = 'placeholder'
        result['problems'].append({'field': 'endpoint', 'reason': 'placeholder_value'})
    else:
        bad = url_problem(endpoint.strip())
        result['fields']['endpoint'] = bad or 'ok'
        if bad:
            result['problems'].append({'field': 'endpoint', 'reason': bad})
        else:
            result['endpoint_host'] = urllib.parse.urlsplit(endpoint.strip()).netloc

    key = data.get('publishableKey')
    if not isinstance(key, str) or not key.strip():
        result['fields']['publishableKey'] = 'missing'
        result['problems'].append({'field': 'publishableKey', 'reason': 'missing'})
    elif any(mark in key for mark in PLACEHOLDERS):
        result['fields']['publishableKey'] = 'placeholder'
        result['problems'].append({'field': 'publishableKey', 'reason': 'placeholder_value'})
    elif not key.strip().startswith('wbpk_'):
        result['fields']['publishableKey'] = 'prefix'
        result['problems'].append({'field': 'publishableKey', 'reason': 'must_start_with_wbpk'})
    else:
        result['fields']['publishableKey'] = 'ok'
        result['publishableKey_length'] = len(key.strip())

    relay = data.get('oauthRelayBaseUrl')
    if relay in (None, ''):
        result['fields']['oauthRelayBaseUrl'] = 'empty_optional'
    elif not isinstance(relay, str):
        result['fields']['oauthRelayBaseUrl'] = 'invalid_type'
        result['problems'].append({'field': 'oauthRelayBaseUrl', 'reason': 'invalid_type'})
    elif any(mark in relay for mark in PLACEHOLDERS):
        result['fields']['oauthRelayBaseUrl'] = 'placeholder'
        result['problems'].append({'field': 'oauthRelayBaseUrl', 'reason': 'placeholder_value'})
    else:
        bad = url_problem(relay.strip())
        result['fields']['oauthRelayBaseUrl'] = bad or 'ok'
        if bad:
            result['problems'].append({'field': 'oauthRelayBaseUrl', 'reason': bad})

    unknown = sorted(set(data) - {'endpoint', 'oauthRelayBaseUrl', 'publishableKey'})
    if unknown:
        result['unknown_fields'] = unknown
    return result


def inspect_runtime():
    result = {'node': bool(shutil.which('node')), 'python': f'{sys.version_info.major}.{sys.version_info.minor}'}
    if result['node']:
        try:
            raw = subprocess.check_output(['node', '--version'], text=True).strip().lstrip('v')
            result['node_version'] = raw
            result['node20+'] = int(raw.split('.')[0]) >= 20
        except Exception:
            result['node20+'] = False
    else:
        result['node20+'] = False
    result['python3.10+'] = sys.version_info >= (3, 10)
    return result


def inspect_sdk():
    result = {'path': 'vendor/workbuddy-sdk.js', 'present': SDK.is_file()}
    if not result['present']:
        result['problems'] = [{'reason': 'missing_sdk'}]
        return result
    result['bytes'] = SDK.stat().st_size
    if not result['bytes']:
        result['problems'] = [{'reason': 'empty_sdk'}]
        return result
    if not shutil.which('node'):
        result['load'] = 'skipped_no_node'
        return result
    try:
        raw = subprocess.run(['node', '-e', SDK_PROBE, str(SDK)], capture_output=True, text=True, timeout=60)
        payload = json.loads((raw.stdout or '').strip().splitlines()[-1])
    except Exception as error:
        result['load'] = 'failed'
        result['problems'] = [{'reason': type(error).__name__}]
        return result
    result['load'] = 'ok' if payload.get('ok') else 'failed'
    result['contract'] = {k: bool(payload.get(k)) for k in ('accepts_valid', 'rejects_bad_key', 'rejects_bad_url')}
    if not all(result['contract'].values()):
        result['problems'] = [{'reason': 'unexpected_config_contract'}]
    return result


def call_driver(payload, timeout=90):
    raw = subprocess.run(['node', str(DRIVER)], input=json.dumps(payload, ensure_ascii=False),
                         capture_output=True, text=True, encoding='utf-8', timeout=timeout)
    events, error = [], None
    for line in (raw.stdout or '').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except ValueError:
            continue
        events.append(item)
        if item.get('type') == 'error':
            error = {'kind': item.get('kind'), 'status': item.get('status')}
    return events, error


def live_models():
    events, error = call_driver({'operation': 'models', 'timeout': 30}, timeout=60)
    if error:
        return {'ok': False, 'error': error, 'model_calls': 0}
    models = next((e.get('models') for e in events if e.get('type') == 'models'), None)
    if not isinstance(models, list):
        return {'ok': False, 'error': {'kind': 'unexpected'}, 'model_calls': 0}
    ids = [str(m.get('id') if isinstance(m, dict) else m) for m in models]
    return {'ok': True, 'directory_count': len(ids), 'has_default_model': DEFAULT_MODEL in ids,
            'model_ids': ids[:40], 'model_calls': 0}


def live_chat(model):
    events, error = call_driver({'model': model, 'messages': [{'role': 'user', 'content': '仅回复“ok”'}],
                                 'temperature': 0, 'max_tokens': 16, 'timeout': 60}, timeout=120)
    if error:
        return {'ok': False, 'error': error, 'content_calls': 0}
    done = next((e for e in events if e.get('type') == 'done'), None)
    text = ''.join(e.get('text', '') for e in events if e.get('type') == 'delta')
    return {'ok': bool(done), 'finish_reason': (done or {}).get('finish_reason'),
            'chars': len(text.strip()), 'content_calls': 1}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='额外做一次模型目录查询（不产生正文 token）')
    parser.add_argument('--live-chat', action='store_true', help='额外做一次最小对话，会消耗你自己的额度')
    parser.add_argument('--model', default=DEFAULT_MODEL, help='真实调用使用的精确模型 ID')
    args = parser.parse_args()

    config = inspect_config()
    runtime = inspect_runtime()
    sdk = inspect_sdk()
    problems = list(config.get('problems', [])) + list(sdk.get('problems', []))
    for name, present in (('node', runtime['node']), ('Node 20+', runtime['node20+']), ('Python 3.10+', runtime['python3.10+'])):
        if not present:
            problems.append({'dependency': name, 'reason': 'missing_runtime_dependency'})

    live = {'requested': bool(args.live or args.live_chat)}
    content_calls = 0
    if args.live or args.live_chat:
        if config.get('problems'):
            live.update({'ok': False, 'skipped': 'configuration_incomplete', 'model_calls': 0})
        else:
            directory = live_models()
            live['models'] = directory
            if args.live_chat and directory.get('ok'):
                chat = live_chat(args.model)
                live['chat'] = chat
                content_calls += chat.get('content_calls', 0)
            live['ok'] = bool(live.get('models', {}).get('ok')) and (not args.live_chat or live.get('chat', {}).get('ok'))

    report = {'ok': not problems, 'config': config, 'runtime': runtime, 'sdk': sdk,
              'live': live, 'content_model_calls': content_calls,
              'note': 'SDK 接通不代表文案质量通过；额度与计费以你自己的账号为准。'}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if problems or (live['requested'] and not live.get('ok')) else 0


if __name__ == '__main__':
    raise SystemExit(main())
