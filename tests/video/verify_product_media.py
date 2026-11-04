"""One-time independent checks of the single productization render, no rendering retries."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.request

BASE = Path(__file__).resolve().parents[2]
OUT = BASE.parent / 'output/geo-merge-20261104/video/productization'


def now(): return datetime.now(timezone.utc).isoformat()
def sha(data): return hashlib.sha256(data).hexdigest()
def canon(text): return re.sub(r'\s', '', text)
def milliseconds(text):
    h, m, s, ms = map(int, re.split('[:,]', text))
    return ((h * 60 + m) * 60 + s) * 1000 + ms


def main():
    if (OUT / 'media-verification.json').exists(): raise SystemExit('Media evidence already exists; do not repeat checks unchanged.')
    service = json.loads((OUT / 'service.json').read_text(encoding='utf-8'))
    base = service['url'].split('/video/')[0]
    client = '03b2a6dd-c691-43a7-9801-502806847adf'
    receipts, processes = [], []
    def get(path):
        url = base + path
        with urllib.request.urlopen(url, timeout=15) as response:
            data = response.read()
            receipts.append({'url': url, 'status': response.status, 'bytes': len(data), 'sha256': sha(data), 'time': now()})
            return data
    batches = json.loads(get('/api/video/batches?clientId=' + client))['batches']
    assert len(batches) == 1, 'Only one real batch is authorized in this stage'
    batch, job = batches[0], batches[0]['jobs'][0]
    assert batch['state'] == 'completed' and len(batch['jobs']) == 1
    assert job['source']['article_id'] == 17 and job['source']['version_id'] == 7
    assert job['targetAcknowledged'] is True and job['targetAssessment']['met'] is False
    downloads = OUT / 'downloads'; downloads.mkdir(exist_ok=True)
    video, subtitles = downloads / 'zip-full.mp4', downloads / 'zip-full.srt'
    video.write_bytes(get(job['videoUrl'])); subtitles.write_bytes(get(job['subtitlesUrl']))
    (OUT / 'submitted-batch.json').write_text(json.dumps(batch, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    def run(command):
        started = now()
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        output, error = proc.communicate(timeout=45)
        processes.append({'pid': proc.pid, 'command': command, 'startedAt': started, 'endedAt': now(), 'exitCode': proc.returncode, 'stderrBytes': len(error)})
        if proc.returncode: raise RuntimeError(error.decode('utf-8', 'replace')[:250])
        return output
    probe = json.loads(run(['ffprobe', '-v', 'error', '-show_entries', 'stream=index,codec_type,width,height,avg_frame_rate,r_frame_rate,nb_frames,duration', '-show_entries', 'format=duration,size', '-of', 'json', str(video)]))
    videos = [s for s in probe['streams'] if s['codec_type'] == 'video']
    audios = [s for s in probe['streams'] if s['codec_type'] == 'audio']
    assert len(videos) == 1 and len(audios) == 0
    stream = videos[0]
    assert (stream['width'], stream['height'], stream['avg_frame_rate']) == (720, 1280, '25/1')
    planned = sum(s['durationSeconds'] for s in job['segments'])
    duration = float(probe['format']['duration'])
    assert abs(duration - planned) < .025
    srt = subtitles.read_text(encoding='utf-8-sig')
    entries = []
    for block in re.split(r'\n\s*\n', srt.strip()):
        rows = block.splitlines()
        assert re.fullmatch(r'\d+', rows[0])
        start, end = rows[1].split(' --> ')
        entries.append({'startMs': milliseconds(start), 'endMs': milliseconds(end), 'text': '\n'.join(rows[2:])})
    assert len(entries) == len(job['segments']) == 35
    assert canon(''.join(e['text'] for e in entries)) == canon(job['originalText'])
    assert len(canon(job['originalText'])) == 580
    assert entries[0]['startMs'] == 0 and abs(entries[-1]['endMs'] / 1000 - duration) < .025
    assert all(a['endMs'] == b['startMs'] for a, b in zip(entries, entries[1:]))
    assert '画面：' not in job['originalText'] and '声明：' not in job['originalText']
    raw_generation = (OUT.parent / 'comparison/pet/zip/raw-generation.txt').read_text(encoding='utf-8')
    raw_audit = (OUT.parent / 'comparison/pet/zip/raw-audit.txt').read_text(encoding='utf-8')
    assert job['source']['provenance']['rawGeneration'] == raw_generation
    assert job['source']['provenance']['rawAudit'] == raw_audit
    assert job['editorial']['allNonblankLinesClassified']
    frames = OUT / 'frames'; frames.mkdir(exist_ok=True)
    samples = [1, duration / 2, duration - 1]
    frame_files = []
    for index, time in enumerate(samples):
        file = frames / ('frame-' + str(index + 1) + '.png')
        run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', str(round(time, 3)), '-i', str(video), '-frames:v', '1', '-threads', '1', str(file)])
        frame_files.append(file)
    from PIL import Image, ImageOps, ImageDraw
    sheet = Image.new('RGB', (720, 470), '#f5f6f8')
    draw = ImageDraw.Draw(sheet)
    for index, file in enumerate(frame_files):
        with Image.open(file) as image:
            thumb = ImageOps.contain(image.convert('RGB'), (220, 400))
            sheet.paste(thumb, (index * 240 + 10, 15))
        draw.text((index * 240 + 14, 430), str(round(samples[index], 2)) + ' s', fill='#292b31')
    sheet.save(OUT / 'contact-sheet.jpg', quality=92)
    process_logs = []
    for file in Path(service['dataDir']).glob('batches/*/output/engine-processes.jsonl'):
        process_logs.append({'path': str(file), 'bytes': file.stat().st_size})
    report = {'status': 'passed', 'time': now(), 'batchId': batch['id'], 'jobId': job['id'], 'version': batch['version'],
        'video': str(video), 'subtitles': str(subtitles), 'width': 720, 'height': 1280, 'fps': 25,
        'frames': int(stream['nb_frames']), 'durationSeconds': duration, 'plannedDurationSeconds': planned,
        'audioTrackCount': len(audios), 'bodyCharacters': 580, 'subtitleCharacters': len(canon(''.join(e['text'] for e in entries))),
        'screenCount': len(entries), 'completeDisplay': True, 'contiguousSubtitleTimeline': True,
        'sourceArticle': 17, 'sourceVersion': 7, 'nativeRawOutputsPreserved': True, 'targetMismatchExplicitlyAcknowledged': True,
        'actualRenders': 1, 'modelCalls': 0, 'directoryCalls': 0, 'ttsCalls': 0, 'imageCalls': 0, 'cloudVideoCalls': 0,
        'mediaSource': 'existing user-reference screenshot crop cat.png, 400x690; no image generation; visual does not establish every statement in the script',
        'frameSamplesSeconds': samples, 'probe': probe, 'httpReceipts': receipts, 'verificationProcesses': processes, 'engineProcessLogs': process_logs,
        'scope': 'production video module + strict read-only source fixture; main workbench proxy not connected in this stage'}
    (OUT / 'media-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: report[k] for k in ('status', 'batchId', 'screenCount', 'durationSeconds', 'audioTrackCount', 'subtitleCharacters', 'actualRenders', 'modelCalls')}))


if __name__ == '__main__': main()
