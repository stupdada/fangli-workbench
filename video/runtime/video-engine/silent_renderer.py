"""Image-led local video timeline. Display text and durations; no audio path."""
import json
import math
import os
from pathlib import Path
import re
import shutil
import unicodedata
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFont
import video_batch as v

VERSION = 1
FPS = 25
MAX_LINES = 2


def font_file():
    windows = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'
    for path in [windows / 'msyhbd.ttc', windows / 'msyh.ttc',
                 Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc')]:
        if path.is_file():
            return path
    raise v.EngineError('FONT_MISSING', '缺少可用的中文字体，请配置微软雅黑或Noto Sans CJK字体', halt_batch=True)


@lru_cache(maxsize=8)
def font_hash(path, size, modified):
    return v.file_digest(path)


def text_layout(text, width, height, style):
    if not isinstance(text, str) or not text.strip() or len(text) > 500:
        raise v.EngineError('TEXT_LAYOUT_INVALID', '每段展示文字需为1—500字符，请将长文字拆成多个画面')
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    if any(unicodedata.category(char) in {'Cc', 'Cs'} and char != '\n' for char in text):
        raise v.EngineError('TEXT_LAYOUT_INVALID', '展示文字只接受可显示的文字及换行')
    size = style['fontSize']
    if type(size) is not int or not max(16, math.ceil(min(width, height) / 40)) <= size <= 160:
        raise v.EngineError('TEXT_LAYOUT_INVALID', '当前画幅的字号应为可读的16—160像素，建议使用默认48像素')
    font = ImageFont.truetype(str(font_file()), size)
    stroke = max(2, round(size * .075))
    margin_x, margin_y = max(12, round(width * .07)), max(14, round(height * .09))
    available = width - 2 * margin_x - 2 * stroke
    lines = []
    for paragraph in text.split('\n'):
        line = ''
        for token in re.findall(r'[A-Za-z0-9][A-Za-z0-9_.+%/-]*|.', paragraph):
            if font.getlength(token) > available:
                raise v.EngineError('TEXT_LAYOUT_TOO_LONG', '有连续文字超出画面宽度，请手动换行或拆成多个画面')
            if line and font.getlength(line + token) > available:
                if token in '。！？；，、：,.!?;:%)]）】》' and len(line) > 1:
                    lines.append(line[:-1])
                    line = line[-1] + token
                else:
                    lines.append(line)
                    line = token
            else:
                line += token
        lines.append(line)
    if len(lines) > MAX_LINES:
        raise v.EngineError('TEXT_LAYOUT_TOO_LONG', f'文字以{size}像素显示将超过2行，请缩短或拆成多个画面')
    displayed = '\n'.join(lines)
    image = Image.new('RGBA', (width, height))
    draw = ImageDraw.Draw(image)
    spacing = max(6, round(size * .25))
    bbox = draw.multiline_textbbox((0, 0), displayed, font=font, spacing=spacing, stroke_width=stroke, align='center')
    box_width, box_height = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if box_width > width - 2 * margin_x or box_height > min(height * .28, height - 2 * margin_y):
        raise v.EngineError('TEXT_LAYOUT_TOO_LONG', '展示文字在当前画幅中超出安全区，请拆段或选择适合的字号')
    top = margin_y if style['position'] == 'top' else height - margin_y - box_height
    x, y = (width - box_width) / 2 - bbox[0], top - bbox[1]
    color = '#ffffff' if style['preset'] == 'white-outline' else '#ffdf37'
    draw.multiline_text((x, y), displayed, font=font, spacing=spacing, fill=color,
                        stroke_width=stroke, stroke_fill='#111111', align='center')
    return image, displayed, {'x': (width - box_width) / 2, 'y': top, 'width': box_width, 'height': box_height,
                              'fontSize': size, 'lines': len(lines), 'font': str(font_file())}


def validate_job(job, root):
    if not isinstance(job, dict) or not v.valid_id(job.get('id')):
        raise v.EngineError('INVALID_INPUT', '任务id无效')
    width, height = job.get('width', 720), job.get('height', 1280)
    if any(type(value) is not int or not 128 <= value <= 1920 or value % 2 for value in [width, height]):
        raise v.EngineError('INVALID_INPUT', '宽高必须为128—1920之间的偶数')
    motion = job.get('motion', 'gentle')
    supplied_style = job.get('textStyle', {})
    if not isinstance(supplied_style, dict):
        raise v.EngineError('INVALID_INPUT', 'textStyle必须是对象')
    style = {'position': supplied_style.get('position', 'bottom'), 'preset': supplied_style.get('preset', 'white-outline'),
             'fontSize': supplied_style.get('fontSize', 48)}
    if not all(isinstance(value, str) for value in [motion, style['position'], style['preset']]) or motion not in {'none', 'gentle'} or style['position'] not in {'top', 'bottom'} or style['preset'] not in {'white-outline', 'yellow-outline'}:
        raise v.EngineError('INVALID_INPUT', '运动或文字样式选项无效')
    segments = job.get('segments')
    if not isinstance(segments, list) or not 1 <= len(segments) <= 100:
        raise v.EngineError('INVALID_INPUT', '每条视频需要1—100段')
    normalized, seen, total = [], set(), 0
    for segment in segments:
        if not isinstance(segment, dict) or not v.valid_id(segment.get('id')) or segment['id'] in seen:
            raise v.EngineError('INVALID_INPUT', '每段需要唯一的有效id')
        seen.add(segment['id'])
        seconds = segment.get('durationSeconds', 5)
        if type(seconds) not in {int, float} or not math.isfinite(seconds) or not 1 <= seconds <= 60:
            raise v.EngineError('DURATION_INVALID', '每段时长必须为1—60秒')
        # Quantize cumulative boundaries, keeping total rounding error within half a frame.
        frames = round((total + seconds) * FPS) - round(total * FPS)
        total += seconds
        media = segment.get('media')
        if not isinstance(media, str) or not media or media.startswith(('\\\\', '//')) or re.match(r'^[A-Za-z]+://', media):
            raise v.EngineError('MEDIA_INVALID', '素材需为后端验证过的本地文件')
        media = (Path(root) / media).resolve()
        if not media.is_file() or str(media).startswith(('\\\\', '//')) or media.suffix.lower() not in v.MEDIA_EXTENSIONS:
            raise v.EngineError('MEDIA_INVALID', '素材不存在或格式不受支持')
        overlay, displayed, box = text_layout(segment.get('text'), width, height, style)
        overlay.close()
        normalized.append({'id': segment['id'], 'text': segment['text'], 'media': str(media), 'durationSeconds': frames / FPS,
                           'requestedDurationSeconds': seconds, 'frames': frames, 'displayed': displayed, 'textBox': box})
    if total > 600:
        raise v.EngineError('DURATION_INVALID', '单条视频总时长不能超过600秒')
    return width, height, motion, style, normalized


def inspect_video(path, seconds, context, width, height):
    info = v.probe(path, context)
    streams = info.get('streams', [])
    video = [stream for stream in streams if stream.get('codec_type') == 'video']
    if any(stream.get('codec_type') == 'audio' for stream in streams) or len(video) != 1:
        raise v.EngineError('RENDER_INVALID', '输出音视频流不符合图文视频要求')
    if (video[0].get('width'), video[0].get('height'), video[0].get('r_frame_rate')) != (width, height, '25/1'):
        raise v.EngineError('RENDER_INVALID', '输出画幅或帧率不符合要求')
    if abs(float(info['format']['duration']) - seconds) > .025:
        raise v.EngineError('RENDER_INVALID', '视频时长与时间轴不符')
    return info


def segment_key(segment, width, height, motion, style):
    font = font_file()
    stat = font.stat()
    return v.digest({'version': VERSION, 'mode': 'silent', 'mediaHash': v.file_digest(segment['media']),
        'text': segment['text'], 'durationSeconds': segment['durationSeconds'], 'requestedDurationSeconds': segment['requestedDurationSeconds'], 'motion': motion,
        'width': width, 'height': height, 'textStyle': style, 'font': font_hash(str(font), stat.st_size, stat.st_mtime_ns)})


def render_job(job, root, output, cache_dir, context):
    width, height, motion, style, segments = validate_job(job, root)
    work = Path(output) / job['id']
    work.mkdir(parents=True, exist_ok=True)
    status = {'id': job['id'], 'mode': 'silent', 'state': 'running', 'phase': 'render',
              'completedSegments': 0, 'totalSegments': len(segments), 'reusedSegments': 0}
    def update(**changes):
        status.update(changes)
        v.save_json(work / 'status.json', status)
        context.on_status(dict(status))
    try:
        update()
        for segment in segments:
            info = v.probe(segment['media'], context)
            if not any(s.get('codec_type') == 'video' for s in info.get('streams', [])):
                raise v.EngineError('MEDIA_INVALID', '素材没有可用画面')
            if not any(name in info.get('format', {}).get('format_name', '').split(',') for name in
                       ['png_pipe', 'jpeg_pipe', 'webp_pipe', 'image2', 'mov', 'mp4', 'matroska', 'webm']):
                raise v.EngineError('MEDIA_INVALID', '素材真实容器不受支持')
        clips, srt, elapsed, signatures = [], [], 0.0, []
        for index, segment in enumerate(segments):
            context.check()
            update(phase='render')
            seconds = segment['durationSeconds']
            key = segment_key(segment, width, height, motion, style)
            signatures.append(key)
            clip = work / f'clip-{index:03}.mp4'
            record = work / f'clip-{index:03}.json'
            cached = Path(cache_dir) / 'silent-clips' / (key + '.mp4')
            cached.parent.mkdir(parents=True, exist_ok=True)
            reused = False
            if clip.exists() and record.exists():
                prior = json.loads(record.read_text(encoding='utf-8'))
                if prior.get('fingerprint') == key and prior.get('mode') == 'silent':
                    inspect_video(clip, seconds, context, width, height)
                    reused = True
            if not reused and cached.exists():
                inspect_video(cached, seconds, context, width, height)
                partial = clip.with_name(clip.stem + '.partial.mp4')
                shutil.copyfile(cached, partial)
                os.replace(partial, clip)
                reused = True
            if not reused:
                overlay_name = f'text-{index:03}.png'
                overlay, _, _ = text_layout(segment['text'], width, height, style)
                overlay.save(work / overlay_name)
                overlay.close()
                image = Path(segment['media']).suffix.lower() in v.IMAGE_EXTENSIONS
                command = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2',
                           '-filter_threads', '1', '-filter_complex_threads', '1']
                command += ['-loop', '1', '-framerate', '25'] if image else ['-stream_loop', '-1']
                command += ['-protocol_whitelist', 'file,pipe', '-i', segment['media'], '-loop', '1', '-framerate', '25', '-i', overlay_name]
                base = (f'[0:v:0]split=2[bg][fg];[bg]scale={width}:{height}:force_original_aspect_ratio=increase,'
                        f'crop={width}:{height},gblur=sigma=24,eq=brightness=-0.12[bgfit];'
                        f'[fg]scale={width}:{height}:force_original_aspect_ratio=decrease,setsar=1[fgfit];'
                        '[bgfit][fgfit]overlay=(W-w)/2:(H-h)/2,setsar=1')
                if image and motion == 'gentle':
                    base += f",zoompan=z='1+0.025*on/{max(1, segment['frames'] - 1)}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={width}x{height}:fps=25"
                filters = base + ',fps=25[base];[base][1:v:0]overlay=0:0:format=auto,format=yuv420p[outv]'
                partial = clip.with_name(clip.stem + '.partial.mp4')
                command += ['-filter_complex', filters, '-map', '[outv]', '-an', '-sn', '-dn', '-frames:v', str(segment['frames']),
                            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-threads', '2',
                            '-video_track_timescale', '25000', '-movflags', '+faststart', partial.name]
                v.run(command, cwd=work, context=context)
                context.check()
                inspect_video(partial, seconds, context, width, height)
                os.replace(partial, clip)
                cache_partial = cached.with_name(cached.stem + '.partial.mp4')
                shutil.copyfile(clip, cache_partial)
                os.replace(cache_partial, cached)
            v.save_json(record, {'mode': 'silent', 'fingerprint': key, 'durationSeconds': seconds,
                                 'audioTrackCount': 0, 'textBox': segment['textBox']})
            status['reusedSegments'] += int(reused)
            srt.append(f'{index + 1}\n{v.stamp(elapsed)} --> {v.stamp(elapsed + seconds)}\n{segment["displayed"]}\n')
            clips.append((clip.name, seconds))
            elapsed += seconds
            update(completedSegments=index + 1)
        context.check()
        update(phase='concat')
        (work / 'concat.txt').write_text(''.join(f"file '{name}'\nduration {seconds:.6f}\n" for name, seconds in clips), encoding='utf-8')
        v.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1',
               '-protocol_whitelist', 'file,pipe', '-i', 'concat.txt', '-map', '0:v:0', '-an', '-sn', '-dn', '-c:v', 'copy',
               '-t', f'{elapsed:.6f}', '-movflags', '+faststart', 'video.partial.mp4'], cwd=work, context=context)
        context.check()
        info = inspect_video(work / 'video.partial.mp4', elapsed, context, width, height)
        (work / 'subtitles.srt').write_text('\n'.join(srt), encoding='utf-8')
        os.replace(work / 'video.partial.mp4', work / 'video.mp4')
        update(state='completed', audioTrackCount=0, durationSeconds=float(info['format']['duration']),
               video=str((work / 'video.mp4').resolve()), subtitles=str((work / 'subtitles.srt').resolve()), segmentFingerprints=signatures)
    except v.Cancelled as error:
        update(state='stopping')
        update(state='cancelled', **error.fields())
    except v.EngineError as error:
        update(state='failed', **error.fields())
    return status


def render_batch(manifest, output, cache_dir, context=None):
    context = context or v.Context()
    if isinstance(manifest, (str, Path)):
        data = json.loads(Path(manifest).read_text(encoding='utf-8-sig'))
    else:
        data = manifest
    if isinstance(data, dict) and data.get('mode', 'silent') != 'silent':
        raise v.EngineError('MODE_UNSUPPORTED', '当前入口支持图文视频制作', halt_batch=True)
    jobs, root = v.load_manifest(manifest)
    output, cache_dir = Path(output).resolve(), Path(cache_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    results = []
    with v.execution_lock(cache_dir), v.execution_lock(output, '.output.lock'):
        for job in jobs:
            if context.stop.is_set():
                result = {'id': job['id'], 'mode': 'silent', 'state': 'cancelled', 'phase': 'render',
                          'completedSegments': 0, 'totalSegments': len(job.get('segments', [])), **v.Cancelled().fields()}
                context.on_status(result)
            else:
                try:
                    result = render_job(job, root, output, cache_dir, context)
                except v.Cancelled as error:
                    result = {'id': job['id'], 'mode': 'silent', 'state': 'cancelled', 'phase': 'render',
                              'completedSegments': 0, 'totalSegments': len(job.get('segments', [])), **error.fields()}
                    context.on_status(result)
                except v.EngineError as error:
                    result = {'id': job['id'], 'mode': 'silent', 'state': 'failed', 'phase': 'render',
                              'completedSegments': 0, 'totalSegments': len(job.get('segments', [])), **error.fields()}
                    context.on_status(result)
            results.append(result)
            v.save_json(output / 'batch-status.json', {'mode': 'silent', 'success': False, 'jobs': results})
        result = {'mode': 'silent', 'success': all(job['state'] == 'completed' for job in results), 'jobs': results}
        v.save_json(output / 'batch-status.json', result)
        return result
