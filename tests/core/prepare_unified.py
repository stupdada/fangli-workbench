"""SQLite online backup and explicitly labelled, existing-media protocol fixtures. No rendering."""
import copy
import hashlib
import importlib.util
import json
import shutil
import sqlite3
import struct
import sys
import uuid
from contextlib import closing
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from bridge.native import LocalStore
from bridge.storage import Workspace
from bridge.zip_evidence import backfill_article

OUT = ROOT.parent / 'output/geo-merge-20261104/core/unified'
SOURCE = ROOT.parent / 'output/geo-merge-20261104/core/live'
VIDEO_SOURCE = ROOT.parent / 'output/geo-merge-20261104/video/productization'


def hash_file(path):
    sha = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(65536), b''): sha.update(chunk)
    return sha.hexdigest()


def main():
    target = OUT / 'data/workbench.db'
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists(): raise RuntimeError('Refusing to overwrite an existing unified acceptance database')
    source_db = SOURCE / 'data/workbench.db'
    with closing(sqlite3.connect(source_db.as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(target)) as destination:
        source.backup(destination, pages=64)
    store = LocalStore(target); workspace = Workspace(store)
    fixtures = json.loads((SOURCE / 'acceptance.json').read_text(encoding='utf-8'))['fixtures']
    imported = []
    for fixture in fixtures.values():
        imported.append(backfill_article(store, fixture['article_id'], SOURCE / 'data/traces'))
    if not all(item['status'] == 'saved' for item in imported): raise RuntimeError('Existing ZIP evidence did not have a unique exact-body match')
    # No model is called to create this unadopted protocol-only candidate.
    aid = fixtures['industry']['article_id']; current = workspace.current(aid); owner = 'core-003-protocol-fixture'
    workspace.lock_article(aid, owner, current['current_version'])
    candidate = copy.deepcopy(current)
    for key in ('current_version', 'version_label', 'origin', 'review', 'locked'): candidate.pop(key, None)
    candidate['body_md'] += '\n仅验收·未采用协议候选，非模型生成。\n'
    candidate['audit'] = {}; candidate['geo'] = {}
    try:
        unadopted = workspace.save_candidate(aid, current['current_version'], candidate, {'status': 'unverified'}, owner,
            origin='revision', label='仅验收·未采用协议候选（无模型）', metadata={'protocol_fixture': True, 'model_calls': 0})
    finally: workspace.unlock_article(aid, owner)

    # Reuse one completed record/media only. No old client/assets database is migrated.
    spec = importlib.util.spec_from_file_location('protocol_video_store', ROOT / 'video/upstream/video-store.py')
    native = importlib.util.module_from_spec(spec); spec.loader.exec_module(native)
    video_root = target.parent / 'video'
    video_store = native.VideoStore(video_root, target)
    original_batch = '1e1c9342-ba87-4b06-bc2d-65df6afc75e9'
    with closing(sqlite3.connect((VIDEO_SOURCE / 'real-data/video.sqlite3').as_uri() + '?mode=ro', uri=True)) as source:
        source.row_factory = sqlite3.Row
        batch = dict(source.execute('SELECT * FROM batches WHERE id=?', (original_batch,)).fetchone())
        job = dict(source.execute('SELECT * FROM jobs WHERE batch=? ORDER BY position LIMIT 1', (original_batch,)).fetchone())
    assert batch['state'] == job['state'] == 'completed'
    fixture_batch = str(uuid.uuid4()); fixture_job = 'protocol-reused-video'
    job_spec = json.loads(job['spec'])
    job_spec['id'] = fixture_job
    job_spec['title'] = '仅验收·复用169.12秒历史样片（非本轮生成）'
    job_spec.pop('source', None)
    job_spec['editorial'] = {'origin': 'protocol-media-reuse', 'originalBatchId': original_batch, 'newEncoding': False}
    batch_spec = {'clientId': fixtures['shop']['client_id'], 'mode': 'silent', 'fps': 25, 'jobs': [job_spec],
        'assetDigests': {}, 'protocolFixture': {'sourceBatchId': original_batch, 'newEncoding': False}}
    digest = hashlib.sha256(json.dumps(batch_spec, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    batch.update(id=fixture_batch, client=fixtures['shop']['client_id'], spec=json.dumps(batch_spec, ensure_ascii=False), digest=digest, version=digest)
    job.update(batch=fixture_batch, id=fixture_job, spec=json.dumps(job_spec, ensure_ascii=False))
    with video_store.db:
        for table, row in [('batches', batch), ('jobs', job)]:
            video_store.db.execute('INSERT INTO ' + table + '(' + ','.join(row) + ') VALUES(' + ','.join('?' for _ in row) + ')', list(row.values()))
    video_store.close()
    output = video_root / 'batches' / fixture_batch / 'output' / fixture_job
    output.mkdir(parents=True)
    media = []
    for filename in ('video.mp4', 'subtitles.srt'):
        source_path = VIDEO_SOURCE / 'downloads' / ('zip-full.mp4' if filename.endswith('mp4') else 'zip-full.srt')
        copied = output / filename; shutil.copyfile(source_path, copied)
        media.append({'source': str(source_path), 'copy': str(copied), 'bytes': copied.stat().st_size,
            'source_sha256': hash_file(source_path), 'copy_sha256': hash_file(copied), 'new_encoding': False})
        assert media[-1]['source_sha256'] == media[-1]['copy_sha256']
    # Valid MP4 free-box padding makes a >12MiB transfer fixture without changing encoded frames.
    padded = OUT / 'protocol-reused-padded.mp4'
    shutil.copyfile(output / 'video.mp4', padded)
    desired = 13 * 1024 * 1024
    free_box = desired - padded.stat().st_size
    with padded.open('ab') as file:
        file.write(struct.pack('>I4s', free_box, b'free'))
        remaining = free_box - 8
        while remaining:
            count = min(65536, remaining); file.write(b'\0' * count); remaining -= count
    result = {'dispatch_id': 'core-003', 'fixture_only': True, 'workspace_backup': {'source': str(source_db), 'target': str(target),
        'method': 'sqlite3.Connection.backup(mode=ro source, pages=64); active DB/WAL not file-copied', 'source_service_untouched': 72376},
        'clients': workspace.clients(), 'fixtures': fixtures, 'zip_evidence_backfill': imported,
        'unadopted_candidate': {'article_id': aid, 'version_id': unadopted, 'client_id': fixtures['industry']['client_id'], 'model_calls': 0},
        'media_fixture': {'batch_id': fixture_batch, 'job_id': fixture_job, 'client_id': fixtures['shop']['client_id'],
            'source_batch_id': original_batch, 'files': media, 'new_encoding': False},
        'upload_fixture': {'path': str(padded), 'bytes': padded.stat().st_size, 'sha256': hash_file(padded),
            'method': 'existing MP4 plus standard free box; encoded frames unchanged; protocol only'},
        'model_calls': 0, 'catalog_calls': 0, 'encodes': 0}
    (OUT / 'fixtures.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'backup': str(target), 'zip_evidence': imported, 'unadopted_version': unadopted,
        'reused_media_bytes': media[0]['bytes'], 'upload_protocol_bytes': padded.stat().st_size, 'encodes': 0}, ensure_ascii=False, indent=2))


if __name__ == '__main__': main()
