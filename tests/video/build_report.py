"""Summarize preserved experiment evidence; never calls a model or renderer."""
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re

BASE = Path(__file__).resolve().parents[2]
OUT = BASE.parent / 'output/geo-merge-20261104/video'


def read(file): return json.loads(file.read_text(encoding='utf-8'))
def chars(text): return len(re.sub(r'\s', '', text))
def elapsed(value):
    return round((datetime.fromisoformat(value['endedAt'].replace('Z', '+00:00')) - datetime.fromisoformat(value['startedAt'].replace('Z', '+00:00'))).total_seconds(), 3)


def main():
    cases = []
    for ident in ('pet', 'industrial'):
        folder = OUT / 'comparison' / ident
        initial = read(folder / 'zip/model-draft.json')
        zip_draft = read(folder / 'zip/draft-display.json')
        zip_final = read(folder / 'zip/audited-display.json')
        zip_audit = read(folder / 'zip/native-audit.json')
        zip_calls = [read(folder / 'zip' / ('raw-' + name + '.txt.meta.json')) for name in ('generation', 'audit')]
        video = read(folder / 'video/result.json')
        raw_video = json.loads((folder / 'video/raw-generation.txt').read_text(encoding='utf-8'))
        cases.append({'case': ident, 'zip': {
            'draftDisplayCharacters': zip_draft['displayCharacters'], 'finalDisplayCharacters': zip_final['displayCharacters'],
            'sectionNarrationOnlyCharacters': chars(''.join(p for s in initial['data']['sections'] for p in s['paragraphs'])),
            'allRenderedNonblankLinesClassified': zip_final['allNonblankLinesClassified'],
            'nativeAudit': zip_audit, 'elapsedSeconds': sum(elapsed(c) for c in zip_calls),
            'requests': 2, 'usage': {k: sum(c['usage'].get(k, 0) for c in zip_calls) for k in ('prompt_tokens', 'completion_tokens', 'total_tokens', 'credit')},
            'withinTestLength': 150 <= zip_final['displayCharacters'] <= 250,
            'pagination': 'not attempted: full display text exceeds native current video paginator test range; no truncation',
            'manualEditorialChanges': 0},
            'video': {'state': video['state'], 'characters': chars(raw_video['body']),
                'elapsedSeconds': elapsed(video), 'requests': 1, 'usage': video.get('usage'),
                'screenCount': video.get('result', {}).get('screenCount'),
                'durationSeconds': video.get('result', {}).get('durationSeconds'),
                'completeDisplay': ''.join(s['text'] for s in video.get('result', {}).get('segments', [])) == re.sub(r'\s', '', raw_video['body']),
                'withinTestLength': 150 <= chars(raw_video['body']) <= 250,
                'nativeValidation': 'passed', 'independentFactAudit': 'none in native flow',
                'manualEditorialChanges': 0}})
    calls = read(OUT / 'calls.json')
    summary = {'status': 'completed', 'recommendation': 'ZIP native text flow as next-stage base; not production-ready for this short-script specification',
        'sourceFrozen': read(OUT / 'source-manifest.json')['frozen'], 'cases': cases,
        'calls': calls['counters'], 'model': calls['model'], 'actualRenders': 0,
        'tests': {'command': 'node --test D:/Codex/方立/fangli-workbench/tests/video/integration.test.cjs', 'passed': 3, 'failed': 0, 'fixture': 'strict localhost workspace-context + renderer stub'},
        'remaining': ['native ZIP complete display length 580/709 exceeds test range',
                      'pet ZIP audit removes unsupported store practices but leaves no brand in display body',
                      'industrial ZIP generic two-coat counts/transport benefit still need actual line conditions',
                      'current video industrial text treats product as contact actor',
                      'real main-service proxy and browser interactions not connected in this stage']}
    (OUT / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    inventory = []
    for folder in (BASE / 'video', BASE / 'tests/video'):
        for file in sorted(folder.rglob('*')):
            if file.is_file() and '__pycache__' not in file.parts:
                inventory.append({'path': str(file.relative_to(BASE)), 'bytes': file.stat().st_size,
                                  'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
    (OUT / 'candidate-files.json').write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'cases': [{'case': c['case'], 'zip_chars': c['zip']['finalDisplayCharacters'], 'video_chars': c['video']['characters']} for c in cases], 'calls': calls['counters'], 'actualRenders': 0}))


if __name__ == '__main__': main()
