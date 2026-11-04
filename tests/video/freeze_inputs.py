"""Freeze delivered source and shared comparison inputs. No source writes or cloud calls."""
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import zipfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[3]
MODULE = ROOT / 'fangli-workbench/video'
OUT = ROOT / 'output/geo-merge-20261104/video'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    if (OUT / 'source-manifest.json').exists():
        raise SystemExit('Snapshot exists; do not silently refreeze comparison inputs.')
    OUT.mkdir(parents=True, exist_ok=True)
    source = ROOT / 'frontend-examples'
    files = ['video-api.js', 'video-store.py', 'video-contract.js', 'video-content.js',
             'video-ui.js', 'video-ui.css', 'video.html', 'video-README.md', 'workbuddy-client.js',
             'video-engine/node-adapter.cjs', 'video-engine/silent_renderer.py',
             'video-engine/video_batch.py', 'video-engine/README.md', 'video-engine/TEST_REPORT.md']
    before = {name: sha((source / name).read_bytes()) for name in files}
    for name in files:
        dest = MODULE / 'upstream' / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, dest)
    entries = [{'file': name, 'bytes': (source / name).stat().st_size,
                'source_sha256_before': before[name],
                'candidate_sha256': sha((MODULE / 'upstream' / name).read_bytes()),
                'source_sha256_after': sha((source / name).read_bytes())} for name in files]
    evidence = []
    for name in ['geo/verification.json', 'geo/media-verification.json', 'geo/editorial-changes.json',
                 'integration/acceptance.json', 'integration/media-verification.json']:
        p = ROOT / 'output/video-production-20261104' / name
        evidence.append({'path': str(p), 'sha256': sha(p.read_bytes()), 'bytes': p.stat().st_size})
    archive = ROOT / 'GEO内容工作台-源码交接包_20261104.zip'
    zip_entries = []
    with zipfile.ZipFile(archive) as package:
        for name in ['__init__.py', 'prompts.py', 'generator.py', 'render.py', 'seeds.py', 'llm.py', 'grouping.py']:
            info = next(i for i in package.infolist() if i.filename.endswith('/app/' + name))
            data = package.read(info)
            dest = MODULE / 'comparison/zip_native' / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            zip_entries.append({'file': name, 'sha256': sha(data),
                                'workbench_app_matches_zip': (ROOT / 'fangli-workbench/app' / name).read_bytes() == data})
    frozen = all(e['source_sha256_before'] == e['candidate_sha256'] == e['source_sha256_after'] for e in entries)
    save(OUT / 'source-manifest.json', {'created_at': datetime.now(timezone.utc).isoformat(),
        'frozen': frozen, 'source_root': str(source), 'snapshot_root': str(MODULE / 'upstream'),
        'delivery': 'original video lane backend-004, silent GEO production, 2026-11-04',
        'files': entries, 'existing_evidence': evidence, 'zip_archive': {'path': str(archive),
        'sha256': sha(archive.read_bytes()), 'files': zip_entries},
        'excluded': ['old data/assets/history', 'generation-config.js connection settings', 'old desktop TTS ZIP'],
        'legacy_engine_note': 'video_batch.py contains inherited speech helpers used by shared local utilities; entry remains silent and previews disabled. No speech configuration copied.'})
    if not frozen:
        raise SystemExit('Source changed while copying; candidate is not frozen.')
    dbpath = source / '.data/workspace.sqlite3'
    db = sqlite3.connect(dbpath.as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    def doc(ident):
        item = dict(db.execute('SELECT id,name,content,digest,role FROM documents WHERE id=?', (ident,)).fetchone())
        item['contentDigest'] = sha(item['content'].encode('utf-8'))
        item.update(readStart=0, readEnd=len(item['content']), offsetUnit='unicode_codepoint')
        return item
    requirement = ('制作一条45—75秒的无声中文图文短视频。完整展示正文目标190—220字、硬范围150—250字，'
                   '去空白、含标点、不含标题；ZIP形态按summary、sections中的paragraphs和key_facts合计正文计数，'
                   '时间轴与画面说明单独保留，不计正文。围绕选题直接回答，允许合理的通用建议、概括性介绍。'
                   '不得编造具体事实、经历、参数或服务承诺。取材局限和资料缺项放编辑侧，正文不写免责声明或内部过程。')
    cases = [
        {'id': 'pet', 'clientId': '03b2a6dd-c691-43a7-9801-502806847adf',
         'name': '宠易购精品猫舍犬舍', 'industry': '宠物门店', 'company': '', 'products': '猫舍犬舍',
         'keyword': '浦东新区新手选猫舍', 'topic': '浦东新区新手选猫舍，健康记录、合同和接猫交接该怎么看？',
         'documents': [doc('c255f495-3c83-4392-bfab-2e578162d872')]},
        {'id': 'industrial', 'clientId': 'f91ec4b8-dda9-4421-ac8a-2d2052b65ccd',
         'name': '西邦24', 'industry': '工业胶粘剂', 'company': '三洋物产贸易（上海）有限公司', 'products': '西邦24',
         'keyword': '西邦24单涂工艺', 'topic': '西邦24单涂是不是只涂一次，施工和干燥怎么安排？',
         'documents': [doc('4550d7c9-1ab5-4cd9-b147-2873a7d78d09'), doc('8309c4f2-4872-4d59-a7c0-ffc8895ffd4d')]}
    ]
    db.close()
    value = {'frozen_at': datetime.now(timezone.utc).isoformat(), 'model': 'deepseek-v4.1-flash',
             'requirement': requirement, 'cases': cases,
             'method': 'same raw documents and combined topic/task requirement; native selection, prompts, validation and ZIP audit preserved; no prompt repair, no retries',
             'limits': {'content_and_native_audit_requests': 6, 'model_directory_requests': 1, 'actual_renders': 0}}
    save(OUT / 'common-inputs.json', value)
    print(json.dumps({'frozen': frozen, 'source_files': len(entries), 'zip_files_match': all(x['workbench_app_matches_zip'] for x in zip_entries), 'inputs_sha256': sha((OUT / 'common-inputs.json').read_bytes())}))


if __name__ == '__main__':
    main()
