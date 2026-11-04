#!/usr/bin/env python3
"""Shared media/process utilities and the local video-rendering CLI."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave

PIPELINE_VERSION = 4
ENDPOINTS = {
    'cn': 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    'intl': 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
}
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp'}
MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | {'.mp4', '.mov', '.mkv', '.webm'}
LANGUAGES = {'Auto', 'Chinese', 'English', 'German', 'Italian', 'Portuguese', 'Spanish', 'Japanese', 'Korean', 'French', 'Russian'}


class EngineError(Exception):
    def __init__(self, code, message, *, halt_batch=False, billing_uncertain=False, request_id=None):
        super().__init__(message)
        self.code, self.halt_batch, self.billing_uncertain = code, halt_batch, billing_uncertain
        self.request_id = request_id

    def fields(self):
        result = {'errorCode': self.code, 'error': str(self), 'haltBatch': self.halt_batch,
                  'billingUncertain': self.billing_uncertain}
        if self.request_id:
            result['requestId'] = self.request_id
        return result


class Cancelled(EngineError):
    def __init__(self):
        super().__init__('CANCELLED', '本地执行已停止', halt_batch=True)


class Context:
    def __init__(self, on_status=None, log_path=None):
        self.stop = threading.Event()
        self.reason = None
        self.on_status = on_status or (lambda status: None)
        self.log_path = Path(log_path) if log_path else None
        self._log_lock = threading.Lock()

    def cancel(self, reason='requested'):
        self.reason = reason
        self.stop.set()

    def check(self):
        if self.stop.is_set():
            raise Cancelled()

    def log(self, event, **data):
        if self.log_path:
            with self._log_lock:
                with self.log_path.open('a', encoding='utf-8') as stream:
                    stream.write(json.dumps({'time': time.time(), 'event': event, **data}, ensure_ascii=False) + '\n')


def watch_parent(context):
    # Raw pipe reads avoid holding CPython's buffered-stdin lock during Windows shutdown.
    pending = b''
    try:
        while chunk := os.read(sys.stdin.fileno(), 4096):
            pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                try:
                    if json.loads(line).get('command') == 'cancel':
                        context.cancel()
                except (ValueError, AttributeError):
                    context.cancel('invalid_control')
            if len(pending) > 4096:
                context.cancel('invalid_control')
                pending = b''
        context.cancel('parent_disconnected')
    except OSError:
        context.cancel('parent_disconnected')


def safe_env(name, default=''):
    """Read only a named TTS variable, including safe Windows per-user/machine settings."""
    value = os.environ.get(name)
    if value:
        return value
    if sys.platform == 'win32':
        import winreg
        for hive, key in [(winreg.HKEY_CURRENT_USER, 'Environment'),
                          (winreg.HKEY_LOCAL_MACHINE, r'SYSTEM\CurrentControlSet\Control\Session Manager\Environment')]:
            try:
                with winreg.OpenKey(hive, key) as handle:
                    value, _ = winreg.QueryValueEx(handle, name)
                    if isinstance(value, str) and value:
                        return value
            except OSError:
                pass
    return default


def options(provider='aliyun', model=None, voice=None, allow_online=False):
    if provider not in {'aliyun', 'mock'}:
        raise EngineError('INVALID_INPUT', '仅支持 aliyun 配音与明确标记的 mock 离线测试')
    model = model or safe_env('TTS_MODEL') or 'qwen3-tts-flash'
    voice = voice or safe_env('TTS_VOICE') or 'Cherry'
    region = safe_env('TTS_REGION') or safe_env('DASHSCOPE_REGION') or 'cn'
    region = {'cn-beijing': 'cn', 'ap-southeast-1': 'intl'}.get(region, region)
    language = safe_env('TTS_LANGUAGE') or 'Chinese'
    if region not in ENDPOINTS or language not in LANGUAGES:
        raise EngineError('INVALID_CONFIG', 'TTS_REGION 仅支持 cn/intl（或对应地域名），TTS_LANGUAGE 必须是支持的语种', halt_batch=True)
    if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', model):
        raise EngineError('INVALID_CONFIG', '无效的 TTS model', halt_batch=True)
    if not isinstance(voice, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', voice):
        raise EngineError('INVALID_CONFIG', '无效的 TTS voice', halt_batch=True)
    return {'provider': provider, 'model': model, 'voice': voice, 'region': region,
            'language': language, 'allowOnline': allow_online is True}


def save_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, path)


@contextmanager
def execution_lock(directory, name='.engine.lock'):
    """OS locks release on crashes; persistent lock files do not mean a task is active."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / name).open('a+b') as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if sys.platform == 'win32':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise EngineError('ENGINE_BUSY', '同一缓存或输出目录已有执行任务，请等待其停止', halt_batch=True) from None
        try:
            yield
        finally:
            handle.seek(0)
            if sys.platform == 'win32':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def memory_snapshot(pid):
    if sys.platform != 'win32':
        return {}
    import ctypes
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in ['PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage',
             'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage', 'PagefileUsage',
             'PeakPagefileUsage', 'PrivateUsage']]
    class Memory(ctypes.Structure):
        _fields_ = [('length', wintypes.DWORD), ('load', wintypes.DWORD)] + [
            (name, ctypes.c_ulonglong) for name in ['totalPhysical', 'freePhysical', 'totalPageFile', 'freePageFile',
             'totalVirtual', 'freeVirtual', 'extendedVirtual']]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    data, status = Counters(), Memory()
    data.cb, status.length = ctypes.sizeof(data), ctypes.sizeof(status)
    process = kernel.OpenProcess(0x410, False, pid)
    result = {}
    if process:
        try:
            psapi = ctypes.WinDLL('psapi', use_last_error=True)
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
            if psapi.GetProcessMemoryInfo(process, ctypes.byref(data), data.cb):
                result.update(workingSetBytes=data.WorkingSetSize, privateBytes=data.PrivateUsage)
        finally:
            kernel.CloseHandle(process)
    if kernel.GlobalMemoryStatusEx(ctypes.byref(status)):
        result.update(freePhysicalBytes=status.freePhysical, freeCommitBytes=status.freePageFile)
    return result


def run(command, cwd=None, context=None, *, ignore_cancel=False, timeout=600):
    context = context or Context()
    if not ignore_cancel:
        context.check()
    process = subprocess.Popen([str(x) for x in command], cwd=cwd, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=0x08000000 if sys.platform == 'win32' else 0)
    context.log('process_start', pid=process.pid, command=[str(x) for x in command], cwd=str(cwd or Path.cwd()), **memory_snapshot(process.pid))
    started, last_memory = time.monotonic(), time.monotonic()
    try:
        while True:
            try:
                stdout, stderr = process.communicate(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                if not ignore_cancel and context.stop.is_set():
                    process.terminate()
                    try:
                        process.communicate(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate()
                    raise Cancelled()
                if time.monotonic() - started > timeout:
                    process.kill()
                    process.communicate()
                    raise EngineError('PROCESS_TIMEOUT', '本地媒体处理超时')
                if time.monotonic() - last_memory >= 10:
                    context.log('process_memory', pid=process.pid, **memory_snapshot(process.pid))
                    last_memory = time.monotonic()
        if process.returncode:
            raise EngineError('MEDIA_PROCESS_FAILED', stderr.decode('utf-8', errors='replace')[-2500:])
        return stdout.decode('utf-8', errors='replace')
    finally:
        context.log('process_end', pid=process.pid, exitCode=process.poll(), elapsedSeconds=round(time.monotonic() - started, 3))


def probe(path, context=None, *, ignore_cancel=False):
    try:
        return json.loads(run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams',
                               '-show_format', '-of', 'json', str(path)], context=context, ignore_cancel=ignore_cancel, timeout=60))
    except (ValueError, EngineError) as error:
        if isinstance(error, Cancelled):
            raise
        raise EngineError('MEDIA_INVALID', '媒体无法解码或不是有效的本地媒体文件') from None


def duration(path, context=None, *, ignore_cancel=False):
    data = probe(path, context, ignore_cancel=ignore_cancel)
    try:
        seconds = float(data['format']['duration'])
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError()
        return seconds
    except (KeyError, ValueError):
        raise EngineError('MEDIA_INVALID', '媒体时长无效') from None


def validate_text(text):
    if not isinstance(text, str) or not text.strip() or len(text) > 600 or '\x00' in text:
        raise EngineError('INVALID_INPUT', '每段配音必须是1-600字符的口播文本；画面说明与屏幕文字应单独保存')
    return text


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()


def file_digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def speech_key(text, config):
    return digest({'cacheVersion': 1, 'text': text, **{k: config[k] for k in ['provider', 'model', 'voice', 'language', 'region']}})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise EngineError('TTS_BILLING_UNCERTAIN', '拒绝配音请求重定向；未自动重试', halt_batch=True, billing_uncertain=True)


def mock_audio(text, target):
    """Test tone only; not synthesized speech."""
    rate, seconds = 24000, max(1, min(5, len(text) / 6))
    with wave.open(str(target), 'wb') as stream:
        stream.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        block = bytearray()
        for i in range(round(rate * seconds)):
            block += struct.pack('<h', int(1200 * math.sin(2 * math.pi * 440 * i / rate)))
        stream.writeframes(block)


def classify_http(status, provider_code='', request_id=None):
    lowered = provider_code.lower()
    if status in {401, 403} or any(word in lowered for word in ['apikey', 'unauthor', 'accessdenied', 'permission']):
        return EngineError('TTS_AUTH_FAILED', '阿里云配音鉴权失败；请检查 Key、地域和模型权限', halt_batch=True, request_id=request_id)
    if status == 402 or any(word in lowered for word in ['quota', 'balance', 'arrear', 'credit', 'unpaid', 'allocationquota']):
        return EngineError('TTS_QUOTA_EXCEEDED', '阿里云配音额度或余额不足；未自动重试', halt_batch=True, request_id=request_id)
    if status == 429 or 'ratelimit' in lowered or 'throttl' in lowered:
        return EngineError('TTS_RATE_LIMITED', '阿里云配音限流；需要明确重试，未自动重试', halt_batch=True, request_id=request_id)
    if status >= 500:
        return EngineError('TTS_BILLING_UNCERTAIN', '阿里云配音服务异常；计费结果未确认，未自动重试', halt_batch=True, billing_uncertain=True, request_id=request_id)
    return EngineError('TTS_REQUEST_REJECTED', '阿里云配音参数或文本被拒绝；请检查模型、音色及文本', halt_batch=True, request_id=request_id)


def speech(text, target, config, context):
    context.check()
    if config['provider'] == 'mock':
        mock_audio(text, target)
        return {'requestId': None, 'usage': {}, 'audioSource': 'offline-test-tone-not-human-speech'}
    if not config['allowOnline']:
        raise EngineError('ONLINE_NOT_ALLOWED', '缓存未命中；真实配音需要 allowOnline: true', halt_batch=True)
    key = safe_env('DASHSCOPE_API_KEY')
    if not key:
        raise EngineError('TTS_NOT_CONFIGURED', '未设置 DASHSCOPE_API_KEY；未发出配音请求', halt_batch=True)
    payload = {'model': config['model'], 'input': {'text': text, 'voice': config['voice'], 'language_type': config['language']}}
    request = urllib.request.Request(ENDPOINTS[config['region']], data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(NoRedirect())
    context.check()
    context.log('tts_request_start', provider='aliyun', model=config['model'], voice=config['voice'], characters=len(text))
    try:
        with opener.open(request, timeout=120) as response:
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError()
            result = json.loads(raw)
        status = int(result.get('status_code', 200))
        if status >= 400 or result.get('code'):
            raise classify_http(status if status >= 400 else 400, str(result.get('code', '')), result.get('request_id'))
        audio = result.get('output', {}).get('audio', {})
        parsed = urllib.parse.urlparse(audio.get('url', ''))
        if parsed.scheme == 'http' and parsed.hostname and parsed.hostname.endswith('.aliyuncs.com'):
            parsed = parsed._replace(scheme='https')
        if parsed.scheme != 'https' or not parsed.hostname or not parsed.hostname.endswith('.aliyuncs.com') or parsed.username or parsed.password or parsed.port not in {None, 443}:
            raise EngineError('TTS_BILLING_UNCERTAIN', '阿里云未返回允许的 HTTPS 音频地址；未自动重试', halt_batch=True, billing_uncertain=True, request_id=result.get('request_id'))
        # Finish and cache an already-issued request even when stop arrives. Never forward the API key.
        with opener.open(urllib.request.Request(urllib.parse.urlunparse(parsed)), timeout=120) as response, Path(target).open('wb') as stream:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 64 * 1024 * 1024:
                    raise ValueError()
                stream.write(chunk)
        metadata = {'requestId': result.get('request_id'), 'usage': result.get('usage', {}),
                    'audioId': audio.get('id'), 'audioExpiresAt': audio.get('expires_at'), 'audioHost': parsed.hostname,
                    'audioSource': 'aliyun-qwen-tts', 'responseStatus': status}
        context.log('tts_response', **metadata)
        return metadata
    except urllib.error.HTTPError as error:
        if 'result' in locals():
            raise EngineError('TTS_BILLING_UNCERTAIN', '配音已返回，但音频下载失败；可能已计费，未自动重试', halt_batch=True, billing_uncertain=True, request_id=result.get('request_id')) from None
        try:
            detail = json.loads(error.read(64 * 1024))
        except (ValueError, OSError):
            detail = {}
        raise classify_http(error.code, str(detail.get('code', '')), detail.get('request_id')) from None
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError, TypeError, AttributeError):
        raise EngineError('TTS_BILLING_UNCERTAIN', '配音响应或音频下载未完成；计费结果未确认，未自动重试', halt_batch=True, billing_uncertain=True,
                          request_id=result.get('request_id') if isinstance(locals().get('result'), dict) else None) from None


def cached_speech(text, cache_dir, config, context):
    validate_text(text)
    context.check()
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = speech_key(text, config)
    target, metadata_path = cache_dir / (key + '.wav'), cache_dir / (key + '.json')
    if target.exists():
        try:
            with wave.open(str(target), 'rb') as stream:
                seconds = stream.getnframes() / stream.getframerate()
                if stream.getnchannels() != 1 or stream.getsampwidth() != 2 or seconds <= 0:
                    raise ValueError()
            metadata = json.loads(metadata_path.read_text(encoding='utf-8')) if metadata_path.exists() else {}
            if metadata.get('sha256') and metadata['sha256'] != file_digest(target):
                raise ValueError()
            return {'audioPath': str(target.resolve()), 'durationSeconds': seconds, 'cacheHit': True,
                    'cacheKey': key, 'metadataPath': str(metadata_path.resolve()), **{k: config[k] for k in ['provider', 'model', 'voice']}}
        except (wave.Error, EOFError, OSError, ValueError, ZeroDivisionError):
            target.replace(target.with_name(key + '.invalid-' + uuid.uuid4().hex + '.wav'))
            metadata_path.unlink(missing_ok=True)
    partial = cache_dir / (key + '.' + uuid.uuid4().hex + '.partial.wav')
    source = cache_dir / (key + '.source.audio')
    receipt = cache_dir / (key + '.source.json')
    started = time.time()
    recovered_source = source.exists()
    try:
        if recovered_source:
            metadata = json.loads(receipt.read_text(encoding='utf-8')) if receipt.exists() else {'audioSource': 'recovered-provider-source'}
            if metadata.get('sourceSha256') and metadata['sourceSha256'] != file_digest(source):
                raise EngineError('TTS_AUDIO_INVALID', '已保留的服务商原音频校验失败；未重新请求配音', halt_batch=True, request_id=metadata.get('requestId'))
        else:
            metadata = speech(text, partial, config, context)
            # Preserve the already-returned billable audio BEFORE decoding or normalizing it.
            # A local codec failure must never delete the sole copy or cause another cloud call.
            os.replace(partial, source)
            metadata.update(cacheKey=key, text=text, provider=config['provider'], model=config['model'], voice=config['voice'],
                            language=config['language'], region=config['region'], sourceSha256=file_digest(source), createdAt=started)
            save_json(receipt, metadata)
        try:
            info = probe(source, context, ignore_cancel=True)
            audio_stream = next((s for s in info.get('streams', []) if s.get('codec_type') == 'audio'), None)
            source_seconds = float(info['format']['duration'])
            if not audio_stream or not math.isfinite(source_seconds) or not 0 < source_seconds <= 600:
                raise ValueError()
            canonical = audio_stream.get('codec_name') == 'pcm_s16le' and audio_stream.get('channels') == 1 and audio_stream.get('sample_rate') == '24000' and info['format'].get('format_name') == 'wav'
            if canonical:
                try:
                    with wave.open(str(source), 'rb') as stream:
                        header_seconds = stream.getnframes() / stream.getframerate()
                        canonical = abs(header_seconds - source_seconds) <= .05
                except (wave.Error, EOFError, ZeroDivisionError):
                    canonical = False
            if canonical:
                shutil.copyfile(source, partial)
            else:
                run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe',
                     '-i', str(source), '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', '-ac', '1', '-ar', '24000', str(partial)],
                    context=context, ignore_cancel=True, timeout=120)
            with wave.open(str(partial), 'rb') as stream:
                seconds = stream.getnframes() / stream.getframerate()
                if stream.getnchannels() != 1 or stream.getsampwidth() != 2 or stream.getframerate() != 24000 or not 0 < seconds <= 600:
                    raise ValueError()
            metadata.update(sourceFormat=info['format'].get('format_name'), sourceCodec=audio_stream.get('codec_name'),
                            sourceSampleFormat=audio_stream.get('sample_fmt'), sourceSampleRate=audio_stream.get('sample_rate'),
                            sourceChannels=audio_stream.get('channels'), normalizationApplied=not canonical)
        except (wave.Error, EOFError, KeyError, ValueError, ZeroDivisionError, EngineError):
            raise EngineError('TTS_AUDIO_INVALID' if config['provider'] != 'mock' else 'MOCK_AUDIO_INVALID',
                '服务商原音频已保留，但本地解码或标准化未通过；未重新请求配音', halt_batch=True, request_id=metadata.get('requestId')) from None
        metadata.update(cacheKey=key, text=text, provider=config['provider'], model=config['model'], voice=config['voice'],
                        language=config['language'], region=config['region'], durationSeconds=seconds, sha256=file_digest(partial), createdAt=started)
        os.replace(partial, target)
        save_json(metadata_path, metadata)
        return {'audioPath': str(target.resolve()), 'durationSeconds': seconds, 'cacheHit': recovered_source, 'cacheKey': key,
                'metadataPath': str(metadata_path.resolve()), **{k: config[k] for k in ['provider', 'model', 'voice']}}
    finally:
        partial.unlink(missing_ok=True)


def preview_speech(text, output, cache_dir, config, context=None):
    context = context or Context()
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with execution_lock(cache_dir):
        result = cached_speech(text, cache_dir, config, context)
        context.check()
        if Path(result['audioPath']) != output:
            temporary = output.with_name(output.name + '.' + uuid.uuid4().hex + '.tmp')
            shutil.copyfile(result['audioPath'], temporary)
            os.replace(temporary, output)
        return {**result, 'audioPath': str(output)}


def stamp(seconds, ass=False):
    n = round(seconds * (100 if ass else 1000))
    if ass:
        return f'{n // 360000:01}:{n // 6000 % 60:02}:{n // 100 % 60:02}.{n % 100:02}'
    return f'{n // 3600000:02}:{n // 60000 % 60:02}:{n // 1000 % 60:02},{n % 1000:03}'


def display_units(text):
    return sum(0.55 if ord(c) < 128 else 1 for c in text)


def caption_cues(text, seconds):
    # Proportional timing inside measured audio; these are not forced-alignment timestamps.
    clean = re.sub(r'[<>\\{}\x00-\x1f]', '', text).strip()
    tokens = re.findall(r'[A-Za-z0-9][A-Za-z0-9_.+%/-]*|.', clean)
    chunks, current = [], ''
    for token in tokens:
        if current and display_units(current + token) > 28:
            chunks.append(current.strip())
            current = ''
        current += token
        if token in '。！？；!?;' or (token in '，、,:：' and display_units(current) >= 10):
            chunks.append(current.strip())
            current = ''
    if current.strip():
        chunks.append(current.strip())
    weights = [max(1, display_units(chunk)) for chunk in chunks]
    total, start, result = sum(weights), 0, []
    for index, (chunk, weight) in enumerate(zip(chunks, weights)):
        lines, line = [], ''
        for token in re.findall(r'[A-Za-z0-9][A-Za-z0-9_.+%/-]*|.', chunk):
            if line and display_units(line + token) > 15 and token not in '。！？；，、：,.!?;:%)]）】》':
                lines.append(line.strip())
                line = ''
            line += token
        if line:
            lines.append(line.strip())
        end = seconds if index == len(chunks) - 1 else start + seconds * weight / total
        result.append((start, end, '\n'.join(lines)))
        start = end
    return result


def choose_font():
    if (Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts/msyh.ttc').is_file():
        return 'Microsoft YaHei'
    return 'Noto Sans CJK SC'


def write_captions(work, index, text, seconds, width, height, test_only=False):
    cues = caption_cues(text, seconds)
    name = f'segment-{index:03}.ass'  # Relative ASCII filenames avoid Windows filter-path escaping.
    fontsize = max(18, round(min(width / 17, height / 22)))
    header = (f'[Script Info]\nScriptType: v4.00+\nPlayResX: {width}\nPlayResY: {height}\nWrapStyle: 2\n'
              '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
              f'Style: Default,{choose_font()},{fontsize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,{round(width * .075)},{round(width * .075)},{round(height * .13)},1\n'
              '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n')
    events = []
    if test_only:
        events.append(f'Dialogue: 1,{stamp(0, True)},{stamp(seconds, True)},Default,,0,0,0,,{{\\an8\\pos({width // 2},{round(height * .06)})\\fs{max(18, fontsize - 10)}}}离线测试提示音 · 非人声\n')
    for start, end, caption in cues:
        escaped = caption.replace('\n', r'\N')
        events.append(f'Dialogue: 0,{stamp(start, True)},{stamp(end, True)},Default,,0,0,0,,{escaped}\n')
    (work / name).write_text(header + ''.join(events), encoding='utf-8')
    return name, cues


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', value) and not re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])', value, re.I)


def validate(job, root):
    if not isinstance(job, dict) or not valid_id(job.get('id')):
        raise EngineError('INVALID_INPUT', '任务 id 只允许1-64位字母、数字、下划线或连字符，不能是 Windows 设备名')
    width, height = job.get('width', 720), job.get('height', 1280)
    if any(type(x) is not int or not 128 <= x <= 1920 or x % 2 for x in [width, height]):
        raise EngineError('INVALID_INPUT', '宽高必须是128-1920之间的偶数')
    segments = job.get('segments')
    if not isinstance(segments, list) or not 1 <= len(segments) <= 100:
        raise EngineError('INVALID_INPUT', '每条视频需要1-100段口播与素材')
    seen, normalized = set(), []
    for segment in segments:
        if not isinstance(segment, dict) or not valid_id(segment.get('id')) or segment['id'] in seen:
            raise EngineError('INVALID_INPUT', '段落需要唯一且有效的 id')
        seen.add(segment['id'])
        text = validate_text(segment.get('text'))
        media = segment.get('media')
        if not isinstance(media, str) or not media or media.startswith(('\\\\', '//')) or re.match(r'^[A-Za-z]+://', media):
            raise EngineError('INVALID_INPUT', '素材只接受已由后端验证归属的本地文件路径')
        media = (Path(root) / media).resolve()
        if not media.is_file() or str(media).startswith(('\\\\', '//')) or media.suffix.lower() not in MEDIA_EXTENSIONS:
            raise EngineError('MEDIA_INVALID', '素材不存在、位于网络共享或扩展名不受支持')
        normalized.append({'id': segment['id'], 'text': text, 'media': str(media)})
    return width, height, normalized


def render_job(job, root, output, cache_dir, config, context):
    width, height, segments = validate(job, root)
    work = Path(output) / job['id']
    work.mkdir(parents=True, exist_ok=True)
    status = {'id': job['id'], 'state': 'running', 'phase': 'tts', 'completedSegments': 0, 'totalSegments': len(segments),
              'provider': config['provider'], 'model': config['model'], 'voice': config['voice'], 'audioCacheHits': 0,
              'voiceDisclosure': '离线测试提示音（非人声）' if config['provider'] == 'mock' else 'AI 合成配音'}
    def update(**changes):
        status.update(changes)
        save_json(work / 'status.json', status)
        context.on_status(dict(status))
    try:
        media_hashes = []
        for segment in segments:  # Check all assets for this job before paying for any narration.
            context.check()
            info = probe(segment['media'], context)
            if not any(stream.get('codec_type') == 'video' for stream in info.get('streams', [])):
                raise EngineError('MEDIA_INVALID', '素材没有可用的图片或视频画面')
            if not any(name in info.get('format', {}).get('format_name', '').split(',') for name in
                       ['png_pipe', 'jpeg_pipe', 'webp_pipe', 'image2', 'mov', 'mp4', 'matroska', 'webm']):
                raise EngineError('MEDIA_INVALID', '素材真实容器不受支持')
            media_hashes.append(file_digest(segment['media']))
        clips, elapsed, srt, cache_keys = [], 0.0, [], []
        update()
        for index, segment in enumerate(segments):
            context.check()
            update(phase='tts')
            audio = cached_speech(segment['text'], cache_dir, config, context)
            cache_keys.append(audio['cacheKey'])
            status['audioCacheHits'] += int(audio['cacheHit'])
            context.check()
            seconds = math.ceil(audio['durationSeconds'] * 25) / 25
            caption_file, cues = write_captions(work, index, segment['text'], seconds, width, height, config['provider'] == 'mock')
            for start, end, caption in cues:
                srt.append(f'{len(srt) + 1}\n{stamp(elapsed + start)} --> {stamp(elapsed + end)}\n{caption}\n')
            signature = digest([PIPELINE_VERSION, segment['id'], segment['text'], audio['cacheKey'], media_hashes[index], width, height, choose_font()])
            clip, record = f'clip-{index:03}.mp4', work / f'clip-{index:03}.json'
            reused = False
            if (work / clip).exists() and record.exists():
                try:
                    old = json.loads(record.read_text(encoding='utf-8'))
                    reused = old.get('fingerprint') == signature and abs(duration(work / clip, context) - seconds) < .1
                except (ValueError, EngineError):
                    pass
            update(phase='render')
            if not reused:
                media, image = Path(segment['media']), Path(segment['media']).suffix.lower() in IMAGE_EXTENSIONS
                command = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-filter_threads', '1']
                command += ['-loop', '1', '-framerate', '25'] if image else ['-stream_loop', '-1']
                command += ['-protocol_whitelist', 'file,pipe', '-i', str(media), '-protocol_whitelist', 'file,pipe', '-i', audio['audioPath']]
                filters = f'scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=0x101820,setsar=1'
                if image:
                    filters += f",zoompan=z='min(1.035,1+on*0.00018)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={width}x{height}:fps=25"
                filters += f',fps=25,ass={caption_file}'
                partial = f'clip-{index:03}.partial.mp4'
                command += ['-map', '0:v:0', '-map', '1:a:0', '-vf', filters, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,apad',
                            '-t', f'{seconds:.6f}', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
                            '-threads', '2', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-video_track_timescale', '25000', '-movflags', '+faststart', partial]
                run(command, cwd=work, context=context)
                context.check()
                if abs(duration(work / partial, context) - seconds) > .12:
                    raise EngineError('RENDER_INVALID', '视频分段时长不符合配音时长')
                os.replace(work / partial, work / clip)
                save_json(record, {'fingerprint': signature, 'durationSeconds': seconds, 'audioCacheKey': audio['cacheKey']})
            clips.append((clip, seconds))
            elapsed += seconds
            update(completedSegments=index + 1)
        context.check()
        update(phase='concat')
        (work / 'concat.txt').write_text(''.join(f"file '{clip}'\nduration {seconds:.6f}\n" for clip, seconds in clips), encoding='utf-8')
        run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-protocol_whitelist', 'file,pipe',
             '-i', 'concat.txt', '-t', f'{elapsed:.6f}', '-c', 'copy', '-movflags', '+faststart', 'video.partial.mp4'], cwd=work, context=context)
        context.check()
        info = probe(work / 'video.partial.mp4', context)
        actual = float(info['format']['duration'])
        if abs(actual - elapsed) > .15 or not all(any(s.get('codec_type') == kind for s in info['streams']) for kind in ['audio', 'video']):
            raise EngineError('RENDER_INVALID', '成片音视频流或总时长验收失败')
        os.replace(work / 'video.partial.mp4', work / 'video.mp4')
        (work / 'subtitles.srt').write_text('\n'.join(srt), encoding='utf-8')
        update(state='completed', durationSeconds=actual, video=str((work / 'video.mp4').resolve()),
               subtitles=str((work / 'subtitles.srt').resolve()), audioCacheKeys=cache_keys)
    except Cancelled as error:
        update(state='stopping')
        update(state='cancelled', **error.fields())
    except EngineError as error:
        update(state='failed', **error.fields())
    except Exception:
        update(state='failed', errorCode='ENGINE_INTERNAL', error='本地合成发生内部错误，请检查引擎日志', haltBatch=True, billingUncertain=False)
    return status


def load_manifest(manifest):
    if isinstance(manifest, (str, Path)):
        path = Path(manifest).resolve()
        data, root = json.loads(path.read_text(encoding='utf-8-sig')), path.parent
    else:
        data, root = manifest, Path.cwd()
    jobs = data.get('jobs') if isinstance(data, dict) else None
    if not isinstance(jobs, list) or not 1 <= len(jobs) <= 30:
        raise EngineError('INVALID_INPUT', '批次必须包含1-30条视频')
    ids = [job.get('id') if isinstance(job, dict) else None for job in jobs]
    if not all(valid_id(value) for value in ids) or len(ids) != len(set(ids)):
        raise EngineError('INVALID_INPUT', '批次任务 id 无效或重复')
    return jobs, root


def render_batch(manifest, output, cache_dir, config, context=None):
    context = context or Context()
    jobs, root = load_manifest(manifest)
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    results, halted = [], None
    with execution_lock(cache_dir), execution_lock(output, '.output.lock'):
        for job in jobs:
            if context.stop.is_set() or halted:
                result = {'id': job['id'], 'state': 'cancelled' if context.stop.is_set() else 'interrupted', 'phase': 'tts',
                          'completedSegments': 0, 'totalSegments': len(job.get('segments', [])),
                          'errorCode': 'CANCELLED' if context.stop.is_set() else 'BATCH_HALTED',
                          'error': '尚未开始；本地已停止' if context.stop.is_set() else '前序配音失败，整批等待明确重试',
                          'haltBatch': True, 'billingUncertain': False}
                context.on_status(result)
            else:
                try:
                    result = render_job(job, root, output, cache_dir, config, context)
                except Cancelled as error:
                    result = {'id': job['id'], 'state': 'cancelled', 'phase': 'tts', 'completedSegments': 0,
                              'totalSegments': len(job.get('segments', [])), **error.fields()}
                    context.on_status(result)
                except EngineError as error:
                    result = {'id': job['id'], 'state': 'failed', 'phase': 'tts', 'completedSegments': 0,
                              'totalSegments': len(job.get('segments', [])), **error.fields()}
                    context.on_status(result)
                if result.get('haltBatch'):
                    halted = result
            results.append(result)
            save_json(output / 'batch-status.json', {'success': False, 'jobs': results})
        result = {'success': all(job['state'] == 'completed' for job in results), 'jobs': results}
        save_json(output / 'batch-status.json', result)
        return result


def emit(kind, value):
    print(json.dumps({'type': kind, kind: value}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description='本地图文视频合成')
    parser.add_argument('manifest', nargs='?')
    parser.add_argument('--request')
    parser.add_argument('--out', default='output')
    parser.add_argument('--cache-dir')
    parser.add_argument('--mode', choices=['silent'], default='silent')
    parser.add_argument('--watch-parent-stdin', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    context = None
    try:
        if args.request:
            request = json.loads(Path(args.request).read_text(encoding='utf-8'))
        elif args.manifest:
            request = {'operation': 'batch', 'mode': args.mode, 'manifest': str(Path(args.manifest).resolve()), 'output': args.out,
                       'cacheDir': args.cache_dir}
        else:
            raise EngineError('INVALID_INPUT', '需要 manifest 或 --request')
        if not all(shutil.which(executable) for executable in ['ffmpeg', 'ffprobe']):
            raise EngineError('MEDIA_TOOLS_MISSING', 'ffmpeg 与 ffprobe 必须在 PATH 中', halt_batch=True)
        output = Path(request['output']).resolve()
        log_root = output.parent if request.get('mode') == 'preview' else output
        log_root.mkdir(parents=True, exist_ok=True)
        context = Context(lambda status: emit('status', status), log_root / 'engine-processes.jsonl')
        context.log('engine_start', pid=os.getpid(), command=sys.argv, **memory_snapshot(os.getpid()))
        if args.watch_parent_stdin:
            threading.Thread(target=watch_parent, args=(context,), daemon=True).start()
        if request.get('mode', 'silent') != 'silent' or request.get('operation', 'batch') != 'batch':
            raise EngineError('MODE_UNSUPPORTED', '当前入口支持图文视频制作', halt_batch=True)
        cache_dir = Path(request.get('cacheDir') or output.parent / 'cache').resolve()
        from silent_renderer import render_batch as render_silent_batch
        result = render_silent_batch(request.get('manifest'), output, cache_dir, context)
        emit('result', result)
        return 0 if result.get('success', True) else 1
    except EngineError as error:
        emit('error', error.fields())
        return 2
    except Exception:
        emit('error', EngineError('ENGINE_INTERNAL', '引擎请求或文件处理失败', halt_batch=True).fields())
        return 2
    finally:
        if context:
            context.log('engine_end', pid=os.getpid(), stopped=context.stop.is_set(), **memory_snapshot(os.getpid()))


if __name__ == '__main__':
    # The renderer imports this module for shared Context/EngineError identities.
    sys.modules['video_batch'] = sys.modules[__name__]
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
