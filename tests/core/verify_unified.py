"""New real cross-service HTTP boundaries only. No model, directory, or encoding endpoint."""
import hashlib
import http.client
import json
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT.parent / 'output/geo-merge-20261104/core/unified'


def hash_file(path):
    sha = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(65536), b''): sha.update(chunk)
    return sha.hexdigest()


def finish_upload(request, service, fixtures, records, static):
    shop = fixtures['fixtures']['shop']; protocol = fixtures['media_fixture']
    upload_file = Path(fixtures['upload_fixture']['path'])
    with upload_file.open('rb') as file:
        uploaded, _ = request('/api/video/upload?clientId=' + shop['client_id'] + '&name=' + quote('仅验收-复用旧样片-freebox.mp4'),
            'POST', file, status=201, json_body=False, headers={'Content-Type': 'video/mp4', 'Content-Length': str(upload_file.stat().st_size)})
    stored = Path(service['data_dir']) / 'video/uploads' / (uploaded['id'] + '.mp4')
    assert uploaded['type'] == 'video/mp4' and uploaded['size'] == 13 * 1024 * 1024
    assert hash_file(stored) == fixtures['upload_fixture']['sha256']
    request('/api/video/upload?clientId=' + shop['client_id'], 'POST', b'bad', status=415,
        json_body=False, headers={'Content-Type': 'application/octet-stream'})
    request('/api/video/upload?clientId=' + shop['client_id'], 'POST', b'', status=413,
        json_body=False, headers={'Content-Type': 'video/mp4', 'Content-Length': str(64 * 1024 * 1024 + 1)})
    download = OUT / 'protocol-downloaded.mp4'
    result = {'ok': True, 'static': static, 'requests': len(records), 'adopted_body_truth': True, 'old_version_pinned': True,
        'metadata_actual_and_separate': True, 'incomplete_and_cross_client_rejected': True,
        'unadopted_main_status': 409, 'unadopted_video_status': 503, 'module_status_preserved': True,
        'range_head_download': True, 'download_sha256': hash_file(download), 'upload': uploaded,
        'upload_bytes': uploaded['size'], 'upload_sha256': hash_file(stored), 'origin_and_sec_fetch_preserved': True,
        'new_model_calls': 0, 'new_catalog_calls': 0, 'new_encodes': 0}
    if '--resume-upload' in sys.argv:
        result['reused_pre_upload_boundaries'] = 44
        result['fixture_correction'] = 'Initial test helper removed default Origin when any custom header was present; fixed the helper and repeated only the changed upload inputs.'
    (OUT / 'http-summary.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main():
    service = json.loads((OUT / 'service.json').read_text(encoding='utf-8'))
    fixtures = json.loads((OUT / 'fixtures.json').read_text(encoding='utf-8'))
    base = service['url']; origin = urlsplit(base)
    records = json.loads((OUT / 'http-boundaries.json').read_text(encoding='utf-8')) if '--resume-upload' in sys.argv else []
    def request(path, method='GET', body=None, status=200, headers=None, json_body=True, download=None):
        if method == 'POST' and path.startswith('/api/video/batches'): raise AssertionError('Encoding endpoint forbidden')
        if 'provider-models' in path or path.endswith(('/chat', '/start', '/style-review', '/style-rewrite', '/revise')):
            raise AssertionError('Model/directory endpoints forbidden')
        request_headers = {'Origin': base, 'Sec-Fetch-Site': 'same-origin'}
        if json_body and body is not None:
            body = json.dumps(body, ensure_ascii=False).encode('utf-8'); request_headers['Content-Type'] = 'application/json'
        request_headers.update(headers or {})
        if headers and 'Origin' in headers and headers['Origin'] is None: request_headers.pop('Origin', None)
        conn = http.client.HTTPConnection(origin.hostname, origin.port, timeout=60)
        conn.request(method, path, body=body, headers=request_headers)
        response = conn.getresponse(); actual_headers = dict(response.getheaders())
        sha, size, parts = hashlib.sha256(), 0, []
        file = download.open('wb') if download else None
        try:
            while True:
                part = response.read(65536)
                if not part: break
                sha.update(part); size += len(part)
                if file: file.write(part)
                else: parts.append(part)
        finally:
            if file: file.close()
            conn.close()
        raw = b''.join(parts)
        record = {'method': method, 'path': path, 'status': response.status, 'headers': actual_headers,
            'response_bytes': size, 'response_sha256': sha.hexdigest(), 'stream_chunk_limit': 65536}
        if 'application/json' in actual_headers.get('Content-Type', ''):
            record['response'] = json.loads(raw)
        records.append(record)
        (OUT / 'http-boundaries.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
        assert response.status == status, (response.status, raw[:500])
        return record.get('response', raw), actual_headers

    if '--resume-upload' in sys.argv:
        static_paths = {'/', '/workbench/zip/', '/video/', '/video/video-ui.js', '/video/content.js', '/video/authoring-view.js', '/video/video-ui.css', '/video/fangli-sans.woff2'}
        static = [{'path': r['path'], 'bytes': r['response_bytes'], 'mime': r['headers']['Content-Type'], 'head': True}
            for r in records if r['method'] == 'GET' and r['path'] in static_paths and r['status'] == 200]
        return finish_upload(request, service, fixtures, records, static)
    boot, _ = request('/api/workbench/bootstrap')
    assert boot['provider_models'] == []
    static = []
    for path, mime in [('/', 'text/html'), ('/workbench/zip/', 'text/html'), ('/video/', 'text/html'),
        ('/video/video-ui.js', 'javascript'), ('/video/content.js', 'javascript'), ('/video/authoring-view.js', 'javascript'),
        ('/video/video-ui.css', 'text/css'), ('/video/fangli-sans.woff2', 'font/woff2')]:
        raw, response_headers = request(path)
        _, head = request(path, 'HEAD')
        assert mime in response_headers['Content-Type']
        assert int(head['Content-Length']) == len(raw)
        static.append({'path': path, 'bytes': len(raw), 'mime': response_headers['Content-Type'], 'head': True})
    _, redirect = request('/video', status=302); assert redirect['Location'] == '/video/'
    for path in ('/video/../config/workbuddy.json', '/video/%2e%2e/bridge/service.py'):
        request(path, status=403)
    request('/config/workbuddy.json', status=404)
    request('/video/private.sqlite3', status=404)
    request('/video/', status=403, headers={'Origin': 'http://foreign.invalid'})
    request('/api/video/content-imports', 'POST', {}, status=403, headers={'Origin': None})
    request('/api/video/content-imports', 'POST', {}, status=403, headers={'Sec-Fetch-Site': 'same-site'})
    request('/api/video/content-generations', 'POST', {}, status=410)

    shop = fixtures['fixtures']['shop']; industry = fixtures['fixtures']['industry']
    path = '/api/workbench/conversations/' + shop['conversation_id']
    view, _ = request(path); before = next(a for a in view['articles'] if a['id'] == shop['article_id'])
    body = '# 仅验收·采用稿正文真值\n\n巷里焙舍提供面包和咖啡，赶时间可以外带，愿意停留也可以堂食。\n\n这是一份明确采用的人工工作版本，作为跨服务正文真值夹具。保留这段完整文字，不用原生结构化旧稿替换。\n\n声明：含AI生成内容\n'
    changed, _ = request(path + '/articles/' + str(before['id']), 'PUT', {'expected_version': before['current_version'], 'title': '仅验收·采用稿正文真值', 'body_md': body})
    article = changed['article']; vid = article['current_version']
    query = f"client_id={shop['client_id']}&article_id={article['id']}&version_id={vid}"
    context, _ = request('/api/workbench/video-context?' + query)
    assert context['article']['body_md'] == body
    assert all(k in context['article'] for k in ('zip_data', 'native_audit', 'body_original', 'raw_generation', 'raw_audit'))
    assert '仅验收·采用稿正文真值' not in context['article']['raw_generation']
    assert 'wbpk_' not in json.dumps(context)
    # Pinning an earlier adopted version cannot jump to the current manual version.
    old, _ = request('/api/workbench/video-context?' + query.replace('version_id=' + str(vid), 'version_id=' + str(before['current_version'])))
    assert old['article']['body_md'] == before['body_md']
    request('/api/workbench/video-context?' + query.replace(shop['client_id'], industry['client_id']), status=404)
    request('/api/workbench/video-context?client_id=' + shop['client_id'] + '&article_id=' + str(article['id']), status=400)
    unadopted = fixtures['unadopted_candidate']
    request('/api/workbench/video-context?client_id=' + unadopted['client_id'] + '&article_id=' + str(unadopted['article_id']) + '&version_id=' + str(unadopted['version_id']), status=409)
    request('/api/video/content-imports', 'POST', {'clientId': shop['client_id'], 'source': {'article_id': article['id']}}, status=400)
    request('/api/video/content-imports', 'POST', {'clientId': industry['client_id'], 'source': {'article_id': article['id'], 'version_id': vid}}, status=404)
    # The video module maps upstream 409 to 503 today; the main proxy preserves it.
    rejected, _ = request('/api/video/content-imports', 'POST', {'clientId': unadopted['client_id'],
        'source': {'article_id': unadopted['article_id'], 'version_id': unadopted['version_id']}}, status=503)
    assert rejected['errorCode'] == 'STORE_UNAVAILABLE'
    controller_fixture = {'url': base, 'client_id': shop['client_id'], 'article_id': article['id'], 'version_id': vid,
        'expected_body': body, 'expected_provenance': context['article'], 'restore_version': before['current_version'],
        'conversation_id': shop['conversation_id']}
    (OUT / 'controller-fixture.json').write_text(json.dumps(controller_fixture, ensure_ascii=False, indent=2), encoding='utf-8')

    protocol = fixtures['media_fixture']; media_base = '/api/video/batches/' + protocol['batch_id'] + '/files/' + protocol['job_id']
    video_url = media_base + '/video.mp4?clientId=' + protocol['client_id']
    source_movie = Path(protocol['files'][0]['source']); total = source_movie.stat().st_size
    _, head = request(video_url, 'HEAD'); assert int(head['Content-Length']) == total and head['Accept-Ranges'] == 'bytes'
    piece, ranged = request(video_url, headers={'Range': 'bytes=0-63'}, status=206)
    with source_movie.open('rb') as file: assert piece == file.read(64)
    assert ranged['Content-Range'] == f'bytes 0-63/{total}' and 'attachment' in ranged['Content-Disposition']
    _, ranged_head = request(video_url, 'HEAD', headers={'Range': 'bytes=0-63'}, status=206)
    assert ranged_head['Content-Length'] == '64'
    suffix, suffix_headers = request(video_url, headers={'Range': 'bytes=-32'}, status=206)
    with source_movie.open('rb') as file: file.seek(-32, 2); assert suffix == file.read()
    assert suffix_headers['Content-Range'] == f'bytes {total-32}-{total-1}/{total}'
    _, invalid = request(video_url, headers={'Range': 'bytes=999999999-'}, status=416)
    assert invalid['Content-Range'] == f'bytes */{total}'
    download = OUT / 'protocol-downloaded.mp4'; request(video_url, download=download)
    assert hash_file(download) == protocol['files'][0]['source_sha256']
    srt, srt_headers = request(media_base + '/subtitles.srt?clientId=' + protocol['client_id'])
    assert hashlib.sha256(srt).hexdigest() == protocol['files'][1]['source_sha256']
    assert 'attachment' in srt_headers['Content-Disposition']
    request(video_url.replace(protocol['client_id'], industry['client_id']), status=404)

    finish_upload(request, service, fixtures, records, static)


if __name__ == '__main__': main()
