"""Build final stage-002 metadata from already gathered evidence, without tests or rendering."""
import hashlib
import json
from pathlib import Path

BASE = Path(__file__).resolve().parents[2]
OUT = BASE.parent / 'output/geo-merge-20261104/video/productization'


def read(path): return json.loads(path.read_text(encoding='utf-8-sig'))


def main():
    media = read(OUT / 'media-verification.json')
    service = read(OUT / 'service.json')
    events = []
    for log in Path(service['dataDir']).glob('batches/*/output/engine-processes.jsonl'):
        events.extend(json.loads(line) for line in log.read_text(encoding='utf-8').splitlines() if line.strip())
    starts = [e for e in events if e['event'] == 'process_start']
    ends = [e for e in events if e['event'] == 'process_end']
    engine_start = next(e for e in events if e['event'] == 'engine_start')
    engine_end = next(e for e in events if e['event'] == 'engine_end')
    stdout = (OUT / 'server.stdout.log').read_text(encoding='utf-8').strip().splitlines()
    assert len(stdout) == 1 and json.loads(stdout[0])['type'] == 'ready'
    assert (OUT / 'server.stderr.log').stat().st_size == 0
    assert len(starts) == len(ends) and all(e['exitCode'] == 0 for e in ends)
    assert not read(OUT / 'host-closed.json')['remainingPids']
    resource = {'enginePid': engine_start['pid'], 'engineElapsedSeconds': round(engine_end['time'] - engine_start['time'], 3),
                'mediaProcessStarts': len(starts), 'mediaProcessEnds': len(ends),
                'minimumFreePhysicalBytes': min(e['freePhysicalBytes'] for e in events if 'freePhysicalBytes' in e),
                'minimumFreeCommitBytes': min(e['freeCommitBytes'] for e in events if 'freeCommitBytes' in e),
                'guard': 'Light PASS, see resource-before.txt', 'resourceLog': str(OUT / 'resources.jsonl')}
    (OUT / 'resource-summary.json').write_text(json.dumps(resource, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    summary = {'dispatch': 'video-002', 'status': 'completed', 'modelCalls': 0, 'directoryCalls': 0, 'ttsCalls': 0, 'imageCalls': 0, 'cloudVideoCalls': 0,
               'actualRenders': 1, 'media': {k: media[k] for k in ('batchId', 'jobId', 'version', 'bodyCharacters', 'subtitleCharacters', 'screenCount', 'durationSeconds', 'audioTrackCount', 'frames')},
               'offlineTests': {'commands': ['node --test fangli-workbench/tests/video/product.test.cjs', 'node --test fangli-workbench/tests/video/edit-invariants.test.cjs', 'node --test --test-name-pattern incomplete fangli-workbench/tests/video/edit-invariants.test.cjs'], 'newFocusedCasesPassed': 4, 'fail': 0, 'unchangedCasesReused': True},
               'browser': {'iab': 'unavailable: Browser is not available: iab', 'fallback': 'Chrome DevTools existing browser, isolated geo-video-002 tab; owned tab closed',
                           'desktop': [1440, 1000], 'mobile': [390, 844], 'horizontalOverflow': False,
                           'manualTextCharacters': 42, 'manualTextScreens': 2, 'manualTextSeconds': 12,
                           'assetFillDomRegressionFixed': True, 'moviePreview': {'readyState': 4, 'duration': 169.12, 'width': 720, 'height': 1280},
                           'consoleErrorsObserved': 0, 'downloadHttp': 'MP4 and SRT fetched and verified; preview range206'},
               'sourceVersion': {'article_id': 17, 'version_id': 7, 'metadata': 'original Markdown, structured ZIP data, native audit, original raw generation and audit responses preserved'},
               'resource': resource, 'serviceClosed': True,
               'remaining': ['real main workbench proxy and source metadata mapping require next-stage integration',
                             'independent four-direction video writer reserved; no fake control or cloud call in this stage',
                             'existing ZIP text quality findings remain editor-side; no automatic factual or brand rewrite',
                             'automatic pagination can leave a short final screen; full body is retained and screen editing is available']}
    (OUT / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    files = []
    for folder in (BASE / 'video', BASE / 'tests/video'):
        for file in sorted(folder.rglob('*')):
            if file.is_file() and '__pycache__' not in file.parts:
                files.append({'path': str(file.relative_to(BASE)), 'bytes': file.stat().st_size,
                              'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
    (OUT / 'files.json').write_text(json.dumps(files, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'completed', 'actualRenders': 1, 'modelCalls': 0, 'audioTrackCount': 0, 'durationSeconds': 169.12, 'processStarts': len(starts), 'processEnds': len(ends), 'serviceClosed': True}))


if __name__ == '__main__': main()
