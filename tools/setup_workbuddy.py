"""交互式填写本机 WorkBuddy 连接配置，不把凭据写进命令行历史或输出。

用法（在仓库根目录）：
    python tools/setup_workbuddy.py

publishableKey 的输入不回显；也可以先用环境变量 WORKBUDDY_ENDPOINT /
WORKBUDDY_PUBLISHABLE_KEY / WORKBUDDY_OAUTH_RELAY 准备好，再直接运行本脚本。

只写本机 config/workbuddy.json（已被 .gitignore 忽略，权限尽量收到 0600），
不会提交、不会上传、不会打印完整凭据。
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import stat
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'config/workbuddy.json'
PLACEHOLDER_MARKS = ('YOUR-', 'REPLACE_WITH', 'example')


def url_problem(value):
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return '不是合法 URL'
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        return '需要 http(s) 开头的完整地址'
    return ''


def ask(label, default='', secret=False, validate=None, required=True, hint=''):
    while True:
        shown = f'{label}{"（回车跳过）" if not required and not default else ""}'
        if hint:
            print(f'  {hint}')
        if secret:
            value = getpass.getpass(f'{shown}: ').strip()
        else:
            value = input(f'{shown}: ').strip()
        value = value or default
        if not value:
            if required:
                print('  这一项不能为空，请重新输入。\n')
                continue
            return ''
        if any(mark in value for mark in PLACEHOLDER_MARKS):
            print('  看起来还是示例占位值，请填写自己的真实配置。\n')
            continue
        problem = validate(value) if validate else ''
        if problem:
            print(f'  {problem}，请重新输入。\n')
            continue
        return value


def write_config(data):
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    temp = CONFIG.with_suffix('.json.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temp, CONFIG)
    if os.name == 'posix':
        os.chmod(CONFIG, stat.S_IRUSR | stat.S_IWUSR)
    return CONFIG


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--force', action='store_true', help='已存在时也重新填写')
    args = parser.parse_args()

    if CONFIG.is_file() and not args.force:
        existing = json.loads(CONFIG.read_text(encoding='utf-8'))
        key = existing.get('publishableKey', '')
        print(f'{CONFIG.relative_to(ROOT)} 已存在（publishableKey 长度 {len(key)}）。')
        print('要覆盖请加 --force；只想检查格式请运行：python tools/check_workbuddy.py')
        return 0

    print('填写本机 WorkBuddy 连接（来源：WorkBuddy 云服务控制台该应用的 publicConfig）')
    print('凭据只写入本机 config/workbuddy.json，不进 Git、不进对话记录。\n')

    env_endpoint = os.environ.get('WORKBUDDY_ENDPOINT', '').strip()
    env_key = os.environ.get('WORKBUDDY_PUBLISHABLE_KEY', '').strip()
    relay_supplied = 'WORKBUDDY_OAUTH_RELAY' in os.environ
    env_relay = os.environ.get('WORKBUDDY_OAUTH_RELAY', '').strip()
    if not sys.stdin.isatty() and not (env_endpoint and env_key):
        print('当前不是交互终端，也没有通过环境变量给出 endpoint 与 publishableKey。')
        print('请在终端里直接运行 python tools/setup_workbuddy.py，或先设置')
        print('WORKBUDDY_ENDPOINT / WORKBUDDY_PUBLISHABLE_KEY 再运行。')
        return 2

    endpoint = env_endpoint or ask(
        'endpoint（应用的发布域名数据面地址）', validate=url_problem,
        hint='例如 https://<你的应用域名>，形如 https://xxx.workbuddy.link 的具体域名以控制台为准')
    publishable_key = env_key or ask(
        'publishableKey（wbpk_ 开头，输入不回显）', secret=True,
        validate=lambda v: '' if v.startswith('wbpk_') else '需要以 wbpk_ 开头')
    oauth_relay = env_relay if relay_supplied else ask(
        'oauthRelayBaseUrl（可选，仅第三方登录需要）', required=False, validate=url_problem,
        hint='只在本工作台调用模型时可以留空')

    config = {'endpoint': endpoint.rstrip('/'), 'oauthRelayBaseUrl': oauth_relay.rstrip('/'),
              'publishableKey': publishable_key}
    path = write_config(config)
    print(f'\n已写入 {path.relative_to(ROOT)}：endpoint={urllib.parse.urlsplit(endpoint).netloc}，'
          f'publishableKey=wbpk_…（长度 {len(publishable_key)}），'
          f'oauthRelayBaseUrl={"已填写" if oauth_relay else "空"}')
    print('下一步：python tools/check_workbuddy.py     # 离线校验格式与 SDK')
    print('       python tools/check_workbuddy.py --live  # 真实目录查询，会用到你的账号')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
