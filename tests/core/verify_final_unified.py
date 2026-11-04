"""Minimal acceptance of the updated retained service; never calls model/catalog/encode APIs."""
import hashlib
import io
import json
import sys
import urllib.request
import urllib.error
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True
OUT = Path(__file__).resolve().parents[3] / 'output/geo-merge-20261104/core/unified'
service = json.loads((OUT / 'service.json').read_text(encoding='utf-8'))
fixture = json.loads((OUT / 'controller-fixture.json').read_text(encoding='utf-8'))
fixtures = json.loads((OUT / 'fixtures.json').read_text(encoding='utf-8'))
requests = []


def get(path, status=200, binary=False):
    assert path.startswith('/api/workbench/') and not any(p in path for p in ('provider-models', '/start', '/write-one'))
    try: response = urllib.request.urlopen(service['url'] + path, timeout=12)
    except urllib.error.HTTPError as exc: response = exc
    with response:
        body = response.read()
        assert response.status == status, (path, response.status, body[:300])
        requests.append({'method': 'GET', 'path': path, 'status': response.status, 'bytes': len(body)})
        return (body, dict(response.headers)) if binary else json.loads(body)


resumed = '--resume-archive' in sys.argv
reused = []
if resumed:
    # The first pass completed these four assertions, then stopped at a fixture-key typo.
    reused = ['runtime main/video PID + readiness', 'bootstrap contains only the two acceptance clients',
              'shop adopted version restored to 4', 'manual source version9 Markdown/structured/raw generation/raw audit exact']
    runtime = {'main': {'pid': service['pid']}, 'video': service['video']}
else:
    runtime = get('/api/workbench/runtime')
    assert runtime['main']['pid'] == service['pid'] and runtime['video']['status'] == 'ready'
    assert runtime['video']['pid'] == service['video']['pid']
    bootstrap = get('/api/workbench/bootstrap')
    assert len(bootstrap['clients']) == 2
    view = get('/api/workbench/conversations/' + fixture['conversation_id'])
    assert next(a for a in view['articles'] if a['id'] == fixture['article_id'])['current_version'] == fixture['restore_version']
source_path = '/api/workbench/video-context?client_id=' + fixture['client_id'] + '&article_id=' + str(fixture['article_id']) + '&version_id='
if not resumed:
    source = get(source_path + str(fixture['version_id']))['article']
    assert source['body_md'] == fixture['expected_body']
    assert source['zip_data'] == fixture['expected_provenance']['zip_data']
    assert source['raw_generation'] == fixture['expected_provenance']['raw_generation']
    assert source['raw_audit'] == fixture['expected_provenance']['raw_audit']
candidate = fixtures['unadopted_candidate']
get(source_path + str(candidate['version_id']), status=404)
get('/api/workbench/video-context?client_id=' + candidate['client_id'] + f'&article_id={candidate["article_id"]}&version_id={candidate["version_id"]}', status=409)
raw, headers = get('/api/workbench/conversations/' + fixture['conversation_id'] + '/archive', binary=True)
assert headers['Content-Type'] == 'application/zip'
with zipfile.ZipFile(io.BytesIO(raw)) as archive:
    assert archive.testzip() is None
    names = archive.namelist()
    assert all('..' not in n.split('/') and not n.startswith('/') for n in names)
    assert all('traces/' not in n and 'workbuddy.json' not in n and not n.endswith('.db') for n in names)
    assert all('exports/current.' + fmt in names for fmt in ('docx', 'md', 'txt', 'json'))
    exported = json.loads(archive.read('exports/current.json'))
    restored_version = json.loads(archive.read(f'articles/{fixture["article_id"]}/versions/{fixture["restore_version"]}.json'))
    assert exported['articles'][0]['body_md'] == restored_version['article']['body_md']
    archived_version = json.loads(archive.read(f'articles/{fixture["article_id"]}/versions/{fixture["version_id"]}.json'))
    assert archived_version['article']['body_md'] == fixture['expected_body']
    assert json.loads(archive.read('documents.json'))
    for name in names:
        if name.endswith('.docx'): continue
        text = archive.read(name).decode('utf-8')
        assert 'wbpk_' not in text and 'Bearer ' not in text
        assert 'config/workbuddy.json' not in text and '\\traces\\' not in text
(OUT / 'local-task-archive.zip').write_bytes(raw)
service['video'] = {k: v for k, v in runtime['video'].items() if k not in ('ok',)}
(OUT / 'service.json').write_text(json.dumps(service, ensure_ascii=False, indent=2), encoding='utf-8')
result = {'ok': True, 'url': service['url'], 'main_pid': service['pid'], 'video': runtime['video'], 'requests': requests,
    'reused_first_pass_assertions': reused, 'fixture_correction': 'candidate ID is nested under unadopted_candidate; completed first-pass reads were reused' if resumed else None,
    'retained_legacy_fixture_migration': True, 'adopted_version_restored': fixture['restore_version'],
    'old_adopted_manual_source_still_immutable': fixture['version_id'], 'cross_article_version_rejected_404': True,
    'archive': {'path': str(OUT / 'local-task-archive.zip'), 'bytes': len(raw), 'entries': len(names), 'sha256': hashlib.sha256(raw).hexdigest(),
        'valid_zip_and_four_exports': True, 'versions_and_parsed_documents_present': True, 'connection_config_and_diagnostic_dirs_absent': True},
    'model_calls': 0, 'catalog_calls': 0, 'encodes': 0}
(OUT / 'final-boundaries.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
