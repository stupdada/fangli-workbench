"""Offline repository handoff checks. Does not call models or render media."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
# Exact, nonfunctional canaries used by existing error-redaction tests.
TEST_CANARIES = {
    'tests/core/test_transport.py': {'a641aacbf1e24cf266167b66720cb3c275f9405569dd22fde75899ea795c68ef'},
    'tests/video/workspace-errors.test.cjs': {'e439075def7e94a8f950b3f92e3de6f7cb93109868b4d4ce29d8fa5f1b8bc119'},
}


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staged', action='store_true', help='check exact index blobs before committing')
    parser.add_argument('--runtime', action='store_true', help='also require local video dependencies')
    args = parser.parse_args()
    problems, checks = [], {}

    def read(name):
        return git('show', ':' + name) if args.staged else (ROOT / name).read_bytes()

    try:
        if args.staged:
            names = git('ls-files', '--cached', '-z').decode('utf-8').split('\0')
        else:
            names = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').decode('utf-8').split('\0')
        names = sorted(set(filter(None, names)))
        actual_key = ''
        private = ROOT / 'config/workbuddy.json'
        if private.is_file():
            actual_key = json.loads(private.read_text(encoding='utf-8')).get('publishableKey', '')
        credential = re.compile(rb'(?:wbpk_|sk-|ghp_|github_pat_|gho_)[A-Za-z0-9_-]{18,}')
        for name in names:
            p = Path(name)
            if (name == 'config/workbuddy.json' or p.name.startswith('.env') and p.name != '.env.example'
                    or p.suffix in ('.db', '.sqlite', '.sqlite3', '.pem', '.key')
                    or name.startswith('data/') and name != 'data/README.md'
                    or any(x in p.parts for x in ('.data', 'test-output', '__pycache__', 'node_modules'))):
                problems.append({'path': name, 'reason': 'private_or_runtime_file'})
                continue
            data = read(name)
            unexpected = any(hashlib.sha256(m.group()).hexdigest() not in TEST_CANARIES.get(name, set())
                             for m in credential.finditer(data))
            if unexpected or (len(actual_key) > 8 and actual_key.encode('utf-8') in data):
                problems.append({'path': name, 'reason': 'credential_literal'})
        checks['files_checked'] = len(names)
        manifest = json.loads(read('tests/zip-core.sha256.json'))
        current = json.loads(read('tests/first-generation-core.sha256.json'))
        if set(current) != {'generator.py', 'prompts.py'}:
            problems.append({'path': 'tests/first-generation-core.sha256.json', 'reason': 'unexpected_first_generation_scope'})
        for name, digest in manifest.items():
            if hashlib.sha256(read('app/' + name)).hexdigest() != current.get(name, digest):
                problems.append({'path': 'app/' + name, 'reason': 'first_generation_hash_changed' if name in current else 'original_zip_hash_changed'})
        checks['original_zip_files'] = len(manifest) - len(current)
        checks['first_generation_updated_files'] = len(current)
        config = json.loads(read('config/style-library.json'))
        if Path(config['root']).is_absolute():
            problems.append({'path': 'config/style-library.json', 'reason': 'absolute_style_path'})
        for name in ('profiles.json', 'expression-references.json'):
            json.loads(read(config['root'].rstrip('/') + '/' + name))
        for base, manifest_name, field in (
                ('style-library/', 'style-library/provenance.json', 'files_sha256'),
                ('docs/evidence/', 'docs/evidence/provenance.json', 'files')):
            for name, record in json.loads(read(manifest_name))[field].items():
                digest = record['sha256'] if isinstance(record, dict) else record
                if hashlib.sha256(read(base + name)).hexdigest() != digest:
                    problems.append({'path': base + name, 'reason': 'snapshot_hash_changed'})
        example = json.loads(read('config/workbuddy.example.json'))
        if set(example) != {'endpoint', 'oauthRelayBaseUrl', 'publishableKey'}:
            problems.append({'path': 'config/workbuddy.example.json', 'reason': 'configuration_shape'})
        for name in ('docs/HANDOFF.md', 'docs/AGENT_START.md', 'docs/evidence/README.md'):
            if not read(name).decode('utf-8').strip():
                problems.append({'path': name, 'reason': 'empty_handoff_document'})
        if not args.staged:
            sys.path.insert(0, str(ROOT))
            from bridge import style_library
            previous = Path.cwd()
            try:
                os.chdir(ROOT.parent)
                result = style_library.references({'platform_name': '抖音', 'account_type': 'official', 'fmt': '图文'}, 'handoff-check')
            finally:
                os.chdir(previous)
            if not result.get('profiles'):
                problems.append({'path': 'bridge/style_library.py', 'reason': 'relative_style_loading'})
            checks['style_loading_from_other_directory'] = bool(result.get('profiles'))
        if args.runtime:
            dependencies = {name: bool(shutil.which(name)) for name in ('node', 'ffmpeg', 'ffprobe')}
            dependencies['Pillow'] = importlib.util.find_spec('PIL') is not None
            if dependencies['node']:
                major = int(subprocess.check_output(['node', '--version'], text=True).strip().lstrip('v').split('.')[0])
                dependencies['Node20+'] = major >= 20
            dependencies['Python3.10+'] = sys.version_info >= (3, 10)
            engine = ROOT / 'video/runtime/video-engine'
            sys.path.insert(0, str(engine))
            from silent_renderer import font_file
            dependencies['CJK_font'] = font_file().is_file()
            checks['runtime_dependencies'] = dependencies
            for name, present in dependencies.items():
                if not present:
                    problems.append({'dependency': name, 'reason': 'missing_runtime_dependency'})
    except Exception as error:
        problems.append({'reason': type(error).__name__, 'detail': 'repository input or dependency check failed'})
    print(json.dumps({'ok': not problems, 'scope': 'git_index' if args.staged else 'working_tree',
                      'checks': checks, 'problems': problems,
                      'external_model_calls': 0, 'media_encodes': 0}, ensure_ascii=False, indent=2))
    return 1 if problems else 0


if __name__ == '__main__':
    raise SystemExit(main())
