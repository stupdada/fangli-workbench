"""CPU page-video renderer; timestamps come from the produced WAV segments."""
import argparse
from array import array
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import wave

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

STOP = threading.Event()
ROOT = Path(__file__).resolve().parent
VOICE = 'Microsoft Huihui Desktop'
DAILY_SIZE = (1080, 1920)
DAILY_SECONDS = 22
TYPE_SIZE = (1080, 1920)
TYPE_SECONDS = 22
TYPE_PAPER = '#fbfbfa'


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def run(command, directory, name, timeout=None):
    log = Path(directory) / (name + '.log')
    with log.open('w', encoding='utf-8') as stream:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        write_json(Path(directory) / 'active-process.json', {'pid': child.pid, 'command': command, 'log': str(log)})
        deadline = time.monotonic() + timeout if timeout else None
        while child.poll() is None:
            if STOP.wait(.15) or deadline is not None and time.monotonic() >= deadline:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                raise RuntimeError('本地制作已停止' if STOP.is_set() else '读取画面素材超时')
        if child.returncode:
            raise RuntimeError(f'{name}未完成，请查看制作记录')
    return log.read_text(encoding='utf-8').lstrip('\ufeff').strip()


def font_path(bold=False):
    for candidate in [os.environ.get('FANGLI_VIDEO_FONT'), 'C:/Windows/Fonts/msyhbd.ttc' if bold else None, 'C:/Windows/Fonts/msyh.ttc',
                      'C:/Windows/Fonts/simhei.ttf', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']:
        if candidate and Path(candidate).is_file():
            return candidate
    raise RuntimeError('需要可用的中文字体')


def lines(draw, text, font, width):
    result, current = [], ''
    for char in text:
        if char == '\n' or current and draw.textlength(current + char, font=font) > width:
            result.append(current)
            current = '' if char == '\n' else char
        else:
            current += char
    if current:
        result.append(current)
    return result


def draw_heading(draw, text, font, y, color):
    wrapped = lines(draw, text, font, 608)
    if len(wrapped) > 2:
        raise RuntimeError('页面标题超出两行，请缩短标题')
    for row in wrapped:
        draw.text((56, y), row, font=font, fill=color, stroke_width=1)
        y += 74
    return y


def draw_points(draw, points, font, number_font, y, accent, layout):
    for i, point in enumerate(points, 1):
        wrapped = lines(draw, point, font, 548)
        if len(wrapped) > 2 or y + 40 * len(wrapped) > 1050:
            raise RuntimeError('画面要点超出页面，请缩短要点')
        draw.line((56, y - 6, 664, y - 6), fill='#52635f', width=1)
        if layout == 'process':
            draw.text((56, y + 5), f'{i:02d}', font=number_font, fill=accent)
        else:
            draw.line((56, y + 18, 78, y + 18), fill=accent, width=2)
        for j, row in enumerate(wrapped):
            draw.text((108, y + j * 40), row, font=font, fill='#e7eeeb')
        y += len(wrapped) * 40 + 12


def caption_rows(draw, caption, font, width=598):
    wrapped = lines(draw, caption, font, width)
    if len(wrapped) > 2:
        raise RuntimeError('分段字幕超出两行，请把口播拆成更短的段落')
    if len(wrapped) != 2:
        return wrapped
    candidates = []
    for split in range(1, len(caption)):
        left, right = caption[:split].rstrip(), caption[split:].lstrip()
        widths = [draw.textlength(row, font=font) for row in (left, right)]
        if not left or not right or max(widths) > width or right[0] in '，。！？、；：）】》':
            continue
        natural = caption[split-1] in '，。！？、；： ' or caption[split].isspace()
        if natural and min(widths) >= 170:
            candidates.append((abs(widths[0] - widths[1]), left, right))
    return list(min(candidates)[1:]) if candidates else wrapped


def daily_image(draft, index, target, show_caption, media):
    source = media[draft['pages'][index]['asset_id']].convert('RGB')
    ratio = source.width / source.height
    if .49 <= ratio <= .67:
        image = ImageOps.fit(source, DAILY_SIZE, Image.Resampling.LANCZOS)
    else:
        backdrop = ImageOps.fit(source, (135, 240)).filter(ImageFilter.GaussianBlur(9))
        image = backdrop.resize(DAILY_SIZE, Image.Resampling.BICUBIC)
        photo = ImageOps.contain(source, (1080, 1540), Image.Resampling.LANCZOS)
        image.paste(photo, ((1080-photo.width)//2, (1920-photo.height)//2))
    if show_caption:
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(font_path(), 64)
        caption = draft['script']['paragraphs'][index]['text']
        rows = caption_rows(draw, caption, font, 900)
        center = 420 if index == 0 else 1450
        for i, row in enumerate(rows):
            y = center + 79 * (i - (len(rows) - 1) / 2)
            draw.text((540, y), row, font=font, anchor='mm', fill='#fffdf8',
                      stroke_width=5, stroke_fill='#302822')
    image.save(target)


def typography_heading(draw, text, font_pathname, maximum, width):
    for size in range(maximum, 87, -4):
        font = ImageFont.truetype(font_pathname, size)
        if draw.textlength(text, font=font) <= width:
            return font, [text]
    for size in range(maximum, 77, -4):
        font = ImageFont.truetype(font_pathname, size)
        pairs = [(text[:i].rstrip(), text[i:].lstrip()) for i in range(1, len(text))]
        fits = []
        for first, second in pairs:
            if second[0] in '，。；：？！、）】》' or first[-1] in '（【《':
                continue
            a, b = draw.textlength(first, font=font), draw.textlength(second, font=font)
            if max(a, b) <= width:
                fits.append((abs(a - b), first, second))
        if fits:
            _, first, second = min(fits)
            return font, [first, second]
    return font, lines(draw, text, font, width)


def typography_page(draft, index, client, directory):
    page = draft['pages'][index]
    width, height = TYPE_SIZE
    left, right = 104, 914
    ink, muted, blue = '#202126', '#555c69', '#315dc0'
    title_layer = Image.new('RGBA', TYPE_SIZE)
    detail_layer = Image.new('RGBA', TYPE_SIZE)
    title_draw, detail_draw = ImageDraw.Draw(title_layer), ImageDraw.Draw(detail_layer)
    regular, bold = font_path(), font_path(bold=True)
    label_font = ImageFont.truetype(regular, 32)
    brand = str(client.get('profile', {}).get('brand') or client['name']).strip()
    if brand:
        title_draw.text((left, 244), lines(title_draw, brand, label_font, 600)[0], font=label_font, fill=muted, anchor='lt')
    title_draw.text((right, 244), f'{index + 1:02d} / {len(draft["pages"]):02d}', font=label_font, fill=muted, anchor='rt')

    y = 616 if index == 0 else 572
    title_draw.rounded_rectangle((left, y - 62, left + 56, y - 54), 4, fill=blue)
    heading_font, heading_rows = typography_heading(title_draw, page['heading'], bold, 116 if index == 0 else 108, right - left)
    for row in heading_rows:
        title_draw.text((left, y), row, font=heading_font, fill=ink, anchor='lt')
        y += round(heading_font.size * 1.22)

    detail_font = ImageFont.truetype(regular, 46)
    y += 35
    for row in lines(detail_draw, page['points'][0], detail_font, right - left):
        detail_draw.text((left, y), row, font=detail_font, fill=muted, anchor='lt')
        y += 68
    progress = round((right - left) * (index + 1) / len(draft['pages']))
    title_draw.line((left, 1616, right, 1616), fill='#e0e3e9', width=2)
    title_draw.line((left, 1616, left + progress, 1616), fill=blue, width=3)

    stem = f'page-{index+1}'
    title_layer.save(directory / f'{stem}-title.png')
    detail_layer.save(directory / f'{stem}-detail.png')
    plate = Image.new('RGBA', (width, height), TYPE_PAPER)
    plate.alpha_composite(title_layer)
    plate.alpha_composite(detail_layer)
    plate.convert('RGB').save(directory / f'{stem}.png')


def typography_command(directory, durations):
    command = ['ffmpeg', '-hide_banner', '-loglevel', 'warning', '-y', '-filter_complex_threads', '1']
    filters, scenes = [], []
    for index, duration in enumerate(durations):
        for part in ('title', 'detail'):
            command.extend(['-threads', '1', '-loop', '1', '-framerate', '25', '-t', str(duration),
                            '-i', str(directory / f'page-{index+1}-{part}.png')])
        paper, title, detail, stage, scene = (f'{name}{index}' for name in ('paper', 'title', 'detail', 'stage', 'scene'))
        w, h = TYPE_SIZE
        filters.extend([
            f'color=c=0x{TYPE_PAPER[1:]}:s={w}x{h}:r=25:d={duration},format=rgba[{paper}]',
            f'[{index*2}:v]format=rgba,fade=t=in:st=0:d=0.32:alpha=1[{title}]',
            f'[{index*2+1}:v]format=rgba,fade=t=in:st=0.16:d=0.32:alpha=1[{detail}]',
            f"[{paper}][{title}]overlay=x=0:y='max(0,18*(1-t/0.32))':shortest=1:format=auto[{stage}]",
            f"[{stage}][{detail}]overlay=x=0:y='max(0,18*(1-max(t-0.16,0)/0.32))':shortest=1:format=auto,format=yuv420p[{scene}]",
        ])
        scenes.append(f'[{scene}]')
    filters.append(''.join(scenes) + f'concat=n={len(scenes)}:v=1:a=0[out]')
    return command + ['-filter_complex', ';'.join(filters), '-map', '[out]']


def page_image(draft, index, client, target, show_caption=True, media=None):
    if draft.get('template') == 'daily':
        daily_image(draft, index, target, show_caption, media)
        return
    page = draft['pages'][index]
    layout = page.get('layout') or draft.get('template', 'process')
    accent = {'process': '#99e6cb', 'intro': '#f0cf97', 'qa': '#bcd4ff'}[layout]
    paper, ink = '#152622', '#f6faf8'
    font_file = font_path()
    fonts = {size: ImageFont.truetype(font_file, size) for size in (22, 26, 30, 32, 58, 62)}
    image = Image.new('RGB', (720, 1280), paper)
    source = media[page['asset_id']] if page.get('asset_id') else None
    portrait = source is not None and 0.47 <= source.width / source.height <= 0.67

    if portrait:
        background = ImageOps.fit(source, image.size, Image.Resampling.LANCZOS)
        image.paste(background, mask=background.getchannel('A'))
        # Keep the subject bright between the top label and the text overlay.
        overlay = Image.new('RGBA', image.size)
        shade = ImageDraw.Draw(overlay)
        for y in range(image.height):
            alpha = max(0, int(150 * (1 - y / 185)), min(245, int(245 * (y - 355) / 415)))
            shade.line((0, y, 720, y), fill=(10, 22, 19, alpha))
        image.paste(overlay, mask=overlay.getchannel('A'))
    elif source is not None:
        # Diagrams and other wide material keep their entire frame.
        frame = ImageOps.contain(source, (608, 356), Image.Resampling.LANCZOS)
        image.paste(frame, ((720 - frame.width) // 2, 153 + (356 - frame.height) // 2), frame.getchannel('A'))

    draw = ImageDraw.Draw(image)
    brand = str(client.get('profile', {}).get('brand') or client['name'])
    brand = lines(draw, brand, fonts[26], 480)[0] if brand.strip() else ''
    draw.text((56, 64), brand, font=fonts[26], fill=ink)
    folio = f'{index + 1:02d}  /  {len(draft["pages"]):02d}'
    draw.text((664, 67), folio, font=fonts[22], fill=accent, anchor='rt')
    draw.line((56, 120, 664, 120), fill='#627772', width=1)
    length = 608 * (index + 1) / len(draft['pages'])
    draw.line((56, 120, 56 + length, 120), fill=accent, width=3)

    if portrait:
        title_y, points_floor = 610, 0
    elif source is not None:
        title_y, points_floor = 550, 0
    else:
        if layout == 'process':
            label = f'步骤 {index + 1:02d}'
        elif layout == 'qa':
            label = '问题' if index == 0 else '解答'
        else:
            label = '概览'
        draw.text((56, 243), label, font=fonts[26], fill=accent)
        title_y, points_floor = 305, 555
    title_end = draw_heading(draw, page['heading'], fonts[58 if source is not None else 62], title_y, ink)
    points = [point for point in page['points'] if point.strip() != page['heading'].strip()]
    draw_points(draw, points, fonts[30], fonts[22], max(points_floor, title_end + 20), accent, layout)

    caption = draft['script']['paragraphs'][index]['text']
    subtitle_lines = caption_rows(draw, caption, fonts[32])
    if show_caption:
        caption_y = 1092 if len(subtitle_lines) == 2 else 1114
        for row in subtitle_lines:
            width = draw.textlength(row, font=fonts[32])
            draw.text(((720-width)/2, caption_y), row, font=fonts[32], fill='white',
                      stroke_width=2, stroke_fill='#09110f')
            caption_y += 44
    image.save(target)


def check_media_size(width, height):
    if not 1 <= width <= 8192 or not 1 <= height <= 8192 or width*height > 32_000_000:
        raise RuntimeError('画面素材尺寸超出范围')


def representative_frame(source, directory, index, maximum=(720, 720)):
    file = source['file']
    if source['type'].startswith('video/'):
        base = ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm']
        probe = json.loads(run(['ffprobe', *base, '-select_streams', 'V:0', '-show_entries', 'stream=width,height',
                                '-of', 'json', file], directory, f'media-probe-{index}', timeout=20))
        streams = probe.get('streams', [])
        if not streams:
            raise RuntimeError('素材没有可用的视频画面')
        check_media_size(streams[0]['width'], streams[0]['height'])
        frame = directory / f'media-frame-{index}.png'
        run(['ffmpeg', *base, '-y', '-threads', '2', '-i', file, '-map', '0:V:0', '-frames:v', '1',
             '-vf', 'scale=720:720:force_original_aspect_ratio=decrease', '-an', '-sn', '-dn', '-update', '1', str(frame)],
            directory, f'media-frame-{index}', timeout=20)
        file = frame
    try:
        with Image.open(file) as image:
            check_media_size(*image.size)
            frame = ImageOps.exif_transpose(image)
            frame.thumbnail(maximum, Image.Resampling.LANCZOS)
            return frame.convert('RGBA')
    except (OSError, Image.DecompressionBombError):
        raise RuntimeError('画面素材无法解码') from None


def seconds(path):
    with wave.open(str(path), 'rb') as audio:
        return audio.getnframes() / audio.getframerate()


def concatenate_wav(paths, target):
    with wave.open(str(target), 'wb') as result:
        expected = None
        for path in paths:
            with wave.open(str(path), 'rb') as part:
                params = part.getparams()[:3]
                if expected is None:
                    expected = params
                    result.setnchannels(params[0])
                    result.setsampwidth(params[1])
                    result.setframerate(params[2])
                elif params != expected:
                    raise RuntimeError('音频格式不一致')
                while data := part.readframes(8192):
                    result.writeframesraw(data)


def speech(draft, voice, directory):
    request = {'voice': voice, 'segments': [{'text': p['text'], 'output': str(directory / f'speech-{i+1}.wav')}
                                            for i, p in enumerate(draft['script']['paragraphs'])]}
    request_file = directory / 'speech-request.json'
    write_json(request_file, request)
    shell = shutil.which('pwsh') or shutil.which('powershell')
    if not shell:
        raise RuntimeError('本机普通话配音需要PowerShell与System.Speech')
    result = json.loads(run([shell, '-NoProfile', '-File', str(ROOT / 'speech.ps1'), '-RequestPath', str(request_file)], directory, 'speech'))
    paths = [Path(s['output']) for s in request['segments']]
    raw_duration = sum(seconds(p) for p in paths)
    # Preserve the voice's normal rate when already in range. Bounded tempo correction
    # uses the actual audio and is probed again before timestamps are committed.
    factor = raw_duration / 36 if not 30 <= raw_duration <= 45 else 1
    if not .65 <= factor <= 1.5:
        raise RuntimeError('实际口播时长超出可调整范围，请修改口播')
    if factor != 1:
        adjusted = []
        for i, path in enumerate(paths):
            target = directory / f'timed-{i+1}.wav'
            run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(path),
                 '-af', f'atempo={factor:.8f}', '-c:a', 'pcm_s16le', str(target)], directory, f'tempo-{i+1}')
            adjusted.append(target)
        paths = adjusted
    durations = [seconds(p) for p in paths]
    concatenate_wav(paths, directory / 'narration.wav')
    result.update(rawDuration=raw_duration, tempoFactor=factor, segmentDurations=durations,
                  duration=seconds(directory / 'narration.wav'))
    write_json(directory / 'audio.json', result)
    return durations, result


def stamp(value):
    milliseconds = round(value * 1000)
    return f'{milliseconds//3600000:02d}:{milliseconds//60000%60:02d}:{milliseconds//1000%60:02d},{milliseconds%1000:03d}'


def timeline(draft, durations):
    cursor, captions = 0., []
    for page, paragraph, duration in zip(draft['pages'], draft['script']['paragraphs'], durations):
        captions.append({'page_id': page['id'], 'start': cursor, 'end': cursor+duration, 'text': paragraph['text']})
        cursor += duration
    return captions


def silent_durations(draft):
    weights = [len(p['text']) for p in draft['script']['paragraphs']]
    remaining = 36 - 4 * len(weights)
    return [4 + remaining * n / sum(weights) for n in weights]


def daily_music(directory):
    """Write a short original arpeggio for the five-photo template."""
    rate, beat = 24000, .6
    chords = [(60, 64, 67, 72), (57, 60, 64, 69), (53, 57, 60, 65), (55, 59, 62, 67)]
    samples = [0.0] * (rate * DAILY_SECONDS)
    for i in range(72):
        chord = chords[(i // 8) % len(chords)]
        note = chord[(0, 2, 1, 3, 1, 2, 3, 2)[i % 8]]
        start = round(i * beat * rate / 2)
        phase = math.tau * 440 * 2 ** ((note - 69) / 12) / rate
        for offset in range(min(rate, len(samples) - start)):
            t = offset / rate
            envelope = min(1, t * 140) * math.exp(-6 * t)
            samples[start + offset] += envelope * (math.sin(phase * offset) + .2 * math.sin(2 * phase * offset))
    fade = rate * 3 // 4
    pcm = array('h', (round(sample * 2800 * min(1, i/fade, (len(samples)-1-i)/fade))
                      for i, sample in enumerate(samples)))
    if sys.byteorder != 'little':
        pcm.byteswap()
    file = directory / 'music.wav'
    with wave.open(str(file), 'wb') as stream:
        stream.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        stream.writeframes(pcm.tobytes())
    return file


def health(directory):
    font = font_path()
    if not all(shutil.which(name) for name in ['ffmpeg', 'ffprobe']):
        raise RuntimeError('需要FFmpeg与ffprobe')
    request = directory / 'speech-health-request.json'
    write_json(request, {'operation': 'health'})
    try:
        shell = shutil.which('pwsh') or shutil.which('powershell')
        voices = json.loads(run([shell, '-NoProfile', '-File', str(ROOT / 'speech.ps1'), '-RequestPath', str(request)], directory, 'speech-health'))
    except Exception:
        voices = {'provider': 'windows-system-speech', 'voices': [], 'defaultVoice': VOICE}
    return {'ready': True, 'width': 720, 'height': 1280, 'font': Path(font).name,
            'speech': voices, 'narrationReady': VOICE in voices['voices'], 'templates': ['process', 'intro', 'qa', 'daily']}


def execute(request):
    directory = Path(request['output']).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    if request['operation'] == 'health':
        return health(directory)
    if request['operation'] == 'asset-preview':
        frame = representative_frame(request['asset'], directory, 1)
        temp = directory / 'asset.png.tmp'
        frame.save(temp, format='PNG')
        os.replace(temp, directory / 'asset.png')
        return {'width': frame.width, 'height': frame.height}
    draft = request['draft']
    daily = draft.get('template') == 'daily'
    typography = draft.get('template') == 'typography'
    size = TYPE_SIZE if typography else DAILY_SIZE if daily else (720, 1280)
    ids = dict.fromkeys(page['asset_id'] for page in draft['pages'] if page.get('asset_id'))
    media = {ident: representative_frame(request['media'][ident], directory, index, size if daily else (720, 720))
             for index, ident in enumerate(ids, 1)}
    if typography:
        for i in range(len(draft['pages'])):
            typography_page(draft, i, request['client'], directory)
        shutil.copyfile(directory / 'page-1.png', directory / 'cover.png')
    else:
        for i in range(len(draft['pages'])):
            page_image(draft, i, request['client'], directory / f'page-{i+1}.png', media=media)
        page_image(draft, 0, request['client'], directory / 'cover.png', show_caption=False, media=media)
    if request['operation'] == 'preview':
        return {'pages': len(draft['pages']), 'width': size[0], 'height': size[1]}
    with_voice = not (daily or typography) and request.get('narration', True)
    audio_file = None
    if typography:
        durations = [TYPE_SECONDS / len(draft['pages'])] * len(draft['pages'])
        audio = {'provider': None, 'voice': None, 'actualTtsSegments': 0, 'duration': TYPE_SECONDS}
    elif daily:
        durations = [DAILY_SECONDS / 5] * 5
        audio_file = daily_music(directory)
        audio = {'kind': 'music', 'provider': 'local', 'voice': None, 'actualTtsSegments': 0, 'duration': DAILY_SECONDS}
    elif with_voice:
        durations, audio = speech(draft, request.get('voice', VOICE), directory)
        audio_file = directory / 'narration.wav'
    else:
        durations = silent_durations(draft)
        audio = {'provider': None, 'voice': None, 'actualTtsSegments': 0, 'duration': sum(durations)}
    captions = timeline(draft, durations)
    write_json(directory / 'captions.json', captions)
    write_json(directory / 'script.json', draft['script'])
    write_json(directory / 'pages.json', draft['pages'])
    srt = '\n\n'.join(f'{i+1}\n{stamp(c["start"])} --> {stamp(c["end"])}\n{c["text"]}' for i, c in enumerate(captions)) + '\n'
    (directory / 'captions.srt').write_text(srt, encoding='utf-8')
    if typography:
        command = typography_command(directory, durations)
    else:
        # Relative image names also work when the data directory contains Chinese characters.
        concat = 'ffconcat version 1.0\n' + ''.join(f"file 'page-{i+1}.png'\nduration {duration:.9f}\n" for i, duration in enumerate(durations))
        concat += f"file 'page-{len(durations)}.png'\n"
        (directory / 'pages.ffconcat').write_text(concat, encoding='utf-8')
        command = ['ffmpeg', '-hide_banner', '-loglevel', 'warning', '-y', '-threads', '2',
                   '-f', 'concat', '-safe', '0', '-i', str(directory / 'pages.ffconcat')]
        if audio_file:
            command += ['-i', str(audio_file)]
        command += ['-vf', 'fps=25,format=yuv420p']
    command += ['-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-crf', '22']
    command += ['-c:a', 'aac', '-b:a', '128k'] if audio_file else ['-an']
    command += ['-t', f'{sum(durations):.9f}', '-movflags', '+faststart', str(directory / 'video.mp4')]
    run(command, directory, 'ffmpeg')
    probe = json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(directory / 'video.mp4')], directory, 'ffprobe'))
    write_json(directory / 'ffprobe.json', probe)
    video = next(s for s in probe['streams'] if s['codec_type'] == 'video')
    audio_streams = [s for s in probe['streams'] if s['codec_type'] == 'audio']
    duration = float(probe['format']['duration'])
    fixed_duration = TYPE_SECONDS if typography else DAILY_SECONDS if daily else None
    duration_ok = abs(duration - fixed_duration) <= .05 if fixed_duration else 30 <= duration <= 45.1
    if (video['width'], video['height']) != size or not duration_ok or bool(audio_file) != bool(audio_streams):
        raise RuntimeError('成片未通过画幅、时长或音轨检查')
    return {'duration': duration, 'audio': audio, 'captions': captions, 'actualTtsSegments': audio['actualTtsSegments'],
            'actualMp4Encodes': 1, 'width': size[0], 'height': size[1], 'audioStreams': len(audio_streams)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--watch-parent', action='store_true')
    args = parser.parse_args()
    if args.watch_parent:
        def watch():
            sys.stdin.read()
            STOP.set()
        threading.Thread(target=watch, daemon=True).start()
    request = json.loads(Path(args.request).read_text(encoding='utf-8'))
    try:
        result = execute(request)
        write_json(Path(request['output']) / 'result.json', result)
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False), flush=True)
    except Exception as exc:
        write_json(Path(request['output']) / 'failure.json', {'error': str(exc)})
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False), flush=True)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
