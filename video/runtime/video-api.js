'use strict';
// Local HTTP boundary. No provider response, credential or filesystem path is public.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { MAX_UPLOAD, MAX_JSON, TYPES, UUID, SILENT_LIMITS, ERRORS, fault, normalizeBatch, digest, matchesType, errorInfo } = require('./video-contract.js');
const { createVideoContent } = require('./video-content.js');
const contentText = require('../public/content.js');

function localProcessEnv(env) {
  const result = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LANG']) if (env[key]) result[key] = env[key];
  return result;
}

function createStore({ dataDir, env, onUnavailable = () => {} }) {
  let child, sequence = 0, closed = false;
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // A rejected startup is still consumed when callers have not yet awaited ready.
  ready.catch(() => {});
  child = spawn(env.FANGLI_PYTHON || 'python', [path.join(__dirname, '../workspace-store.py')], {
    windowsHide: true, env: { ...localProcessEnv(env), FANGLI_WORKSPACE_BASE: env.FANGLI_WORKSPACE_BASE, FANGLI_VIDEO_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  const rejectAll = () => {
    if (!closed) onUnavailable();
    closed = true;
    const error = fault(503, 'STORE_UNAVAILABLE'); readyReject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line); } catch { rejectAll(); child.kill(); return; }
    if ('ready' in value) {
      if (value.ready) readyResolve(); else readyReject(fault(value.status || 503, value.code || 'STORE_UNAVAILABLE'));
      return;
    }
    const request = pending.get(value.id); if (!request) return;
    pending.delete(value.id);
    if (value.ok) request.resolve(value.data); else request.reject(fault(value.status || 503, value.code || 'STORE_UNAVAILABLE'));
  });
  // Deliberately drain stderr; untrusted details do not enter HTTP or logs.
  child.stderr.on('data', () => {});
  child.stdin.on('error', rejectAll); child.on('error', rejectAll); child.on('close', rejectAll);
  async function call(op, data = {}) {
    await ready;
    if (closed) throw fault(503, 'STORE_UNAVAILABLE');
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, op, data }) + '\n', error => { if (error) { pending.delete(id); reject(fault(503, 'STORE_UNAVAILABLE')); } });
    });
  }
  return { ready, call, get pid() { return child.pid; }, async close() {
    if (closed) { await exited; return; }
    try { await call('shutdown'); } catch { child.kill(); }
    child.stdin.end(); await exited;
  } };
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw fault(413, 'INVALID_INPUT', '请求内容超过大小限制');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fault(413, 'INVALID_INPUT', '请求内容超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/json') throw fault(415, 'INVALID_INPUT', '需要application/json');
  let value;
  try { value = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8')); } catch (error) {
    if (error.status) throw error; throw fault(400, 'INVALID_INPUT', 'JSON格式不正确');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault(400, 'INVALID_INPUT', '需要JSON对象');
  return value;
}
function within(base, target) { const relative = path.relative(base, target); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
async function existingFile(base, target) {
  try {
    const resolvedBase = await fsp.realpath(base), resolved = await fsp.realpath(target), stat = await fsp.stat(resolved);
    if (!within(resolvedBase, resolved) || !stat.isFile()) throw new Error();
    return { file: resolved, size: stat.size };
  } catch { throw fault(404, 'FILE_MISSING'); }
}
async function fileDigest(file, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
async function sendFile(req, res, base, file, { type, name, inline = false, range = false }) {
  const stat = await existingFile(base, file);
  const headers = { 'Content-Type': type, 'Content-Length': stat.size, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  let start = 0, end = stat.size - 1, status = 200;
  if (range) headers['Accept-Ranges'] = 'bytes';
  if (range && req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2]) || stat.size === 0) {
      res.writeHead(416, { ...headers, 'Content-Length': 0, 'Content-Range': `bytes */${stat.size}` }); res.end(); return;
    }
    if (!match[1]) { const count = Number(match[2]); start = Math.max(0, stat.size - count); if (!count) start = stat.size; }
    else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= stat.size || start > end) {
      res.writeHead(416, { ...headers, 'Content-Length': 0, 'Content-Range': `bytes */${stat.size}` }); res.end(); return;
    }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`; headers['Content-Length'] = end - start + 1;
  }
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || stat.size === 0) { res.end(); return; }
  const stream = fs.createReadStream(stat.file, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}

function createHandler(options = {}) {
  const env = options.env || process.env;
  const dataDir = path.resolve(options.dataDir || env.FANGLI_VIDEO_DATA_DIR || path.join(env.FANGLI_DATA_DIR || path.join(__dirname, '.data'), 'video'));
  const publicRelative = path.relative(__dirname, dataDir);
  const unsafeDir = within(__dirname, dataDir) && !publicRelative.split(path.sep).some(part => part.startsWith('.'));
  // The default entry is the local renderer. Explicit 0 is a maintenance/test gate.
  let adapter = typeof options.renderBatch === 'function' ? { renderBatch: options.renderBatch } : null;
  function getAdapter() {
    if (adapter) return adapter;
    if (options.renderBatch === null || env.FANGLI_VIDEO_ENGINE_ENABLED === '0') throw fault(503, 'ENGINE_NOT_CONNECTED');
    try {
      const candidate = require('./video-engine/node-adapter.cjs');
      if (typeof candidate.renderBatch !== 'function') throw new Error();
      adapter = candidate; return adapter;
    } catch { throw fault(503, 'ENGINE_NOT_CONNECTED'); }
  }
  let rendererHealth, healthPromise, healthSettled = false;
  async function checkRenderer(force = false) {
    if (force && healthSettled) healthPromise = null;
    if (!healthPromise) { healthSettled = false; healthPromise = (async () => {
      try { getAdapter(); } catch { return { ready: false, errorCode: 'ENGINE_NOT_CONNECTED', error: ERRORS.ENGINE_NOT_CONNECTED }; }
      if (typeof options.renderBatch === 'function') return { ready: true };
      return new Promise(resolve => {
        const code = "import sys,json,shutil; sys.path.insert(0,sys.argv[1]); result={'ready':False};\ntry:\n if not all(shutil.which(p) for p in ['ffmpeg','ffprobe']): result['errorCode']='MEDIA_TOOLS_MISSING'\n else:\n  import silent_renderer as s\n  from PIL import ImageFont\n  ImageFont.truetype(str(s.font_file()),48)\n  result={'ready':True}\nexcept Exception as e: result['errorCode']=getattr(e,'code','ENGINE_START_FAILED')\nprint(json.dumps(result))";
        const child = spawn(env.FANGLI_PYTHON || 'python', ['-c', code, path.join(__dirname, 'video-engine')], { windowsHide: true, env: localProcessEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { output += value; }); child.stderr.on('data', () => {});
        const finish = value => { const errorCode = ['FONT_MISSING', 'MEDIA_TOOLS_MISSING', 'ENGINE_START_FAILED'].includes(value.errorCode) ? value.errorCode : 'ENGINE_START_FAILED'; resolve(value.ready ? { ready: true } : { ready: false, errorCode, error: ERRORS[errorCode] }); };
        child.once('error', () => finish({})); child.once('close', () => { try { finish(JSON.parse(output)); } catch { finish({}); } });
      });
    })().finally(() => { healthSettled = true; }); }
    rendererHealth = await healthPromise; return rendererHealth;
  }
  function available() { return rendererHealth?.ready === true; }
  function requireRenderer() { if (!available()) throw fault(503, rendererHealth?.errorCode || 'ENGINE_NOT_CONNECTED'); return getAdapter(); }
  let store, content, init, closing = false, pumpPromise = null, pumpRequested = false, active = null;
  async function initialize() {
    if (!init) init = (async () => {
      if (unsafeDir) throw fault(503, 'STORE_UNAVAILABLE', '视频数据目录必须位于静态目录之外或隐藏目录中');
      for (const directory of ['uploads', 'batches', 'previews', 'cache']) await fsp.mkdir(path.join(dataDir, directory), { recursive: true, mode: 0o700 });
      store = createStore({ dataDir, env, onUnavailable() { closing = true; active?.control.abort(); } }); await store.ready;
      content = createVideoContent({ store:(op,data)=>store.call(op,data), env });
      await checkRenderer();
    })();
    await init;
    if (closing) throw fault(503, 'STORE_UNAVAILABLE');
  }
  const batchDir = record => path.join(dataDir, 'batches', record.id, ...(record.layout === 'compact' ? [] : [record.version]));
  const outputDir = record => path.join(batchDir(record), 'output');
  function checkOutputPaths(record) {
    if (process.platform === 'win32' && record.jobs.some(job => path.join(outputDir(record), job.id, 'status.json.' + '0'.repeat(32) + '.tmp').length >= 260)) throw fault(400, 'DATA_PATH_TOO_LONG');
  }
  const cacheDir = path.join(dataDir, 'cache');
  async function asset(clientId, id, expectedDigest, signal) {
    const meta = await store.call('asset.get', { clientId, id });
    if (!TYPES[meta.type] || meta.file !== id + TYPES[meta.type]) throw fault(400, 'ASSET_INVALID');
    let file;
    try { file = (await existingFile(path.join(dataDir, 'uploads'), path.join(dataDir, 'uploads', meta.file))).file; }
    catch { throw fault(400, 'MEDIA_MISSING'); }
    const sha256 = await fileDigest(file, signal);
    if (meta.sha256 && meta.sha256 !== sha256 || expectedDigest && expectedDigest !== sha256) throw fault(409, 'MEDIA_CHANGED');
    return { file, sha256 };
  }
  async function retryReadiness(record) {
    if (record.mode !== 'silent' || record.spec.mode !== 'silent') return { canRetry: false, retryUnavailableReason: ERRORS.MODE_UNSUPPORTED };
    if (!['cancelled', 'interrupted', 'failed'].includes(record.state) || record.jobs.every(j => j.state === 'completed')) return { canRetry: false };
    if (!available()) return { canRetry: false, retryUnavailableReason: rendererHealth?.error || ERRORS.ENGINE_NOT_CONNECTED };
    try {
      checkOutputPaths(record);
      const verified = new Set();
      for (const job of record.jobs) {
        if (job.state === 'completed') {
          if (job.result?.mode !== 'silent' || job.result.audioTrackCount !== 0) throw fault(409, 'ADAPTER_PROTOCOL');
          for (const file of ['video.mp4', 'subtitles.srt']) await existingFile(outputDir(record), path.join(outputDir(record), job.id, file));
        } else for (const segment of job.spec.segments) {
          if (!verified.has(segment.media)) { await asset(record.client, segment.media, record.spec.assetDigests?.[segment.media]); verified.add(segment.media); }
        }
      }
      return { canRetry: true };
    } catch (error) { return { canRetry: false, retryUnavailableReason: ERRORS[error.code] || ERRORS.MEDIA_MISSING }; }
  }
  async function view(record) {
    const silent = record.mode === 'silent' && record.spec.mode === 'silent';
    const query = `?clientId=${encodeURIComponent(record.client)}`;
    const jobs = record.jobs.map(job => {
      const result = { id: job.id, title: job.spec.title, state: job.state, phase: job.phase || null, completedSegments: job.completed, totalSegments: job.total,
        version: job.version, source: job.spec.source || null, originalText: job.spec.originalText ?? job.spec.segments.map(s => s.text).join('\n'), segments: job.spec.segments };
      Object.assign(result,{editorial:job.spec.editorial||null,targetPreset:job.spec.targetPreset,targetAssessment:job.spec.targetAssessment,targetAcknowledged:job.spec.targetAcknowledged});
      if (job.spec.contentGenerationId) {result.contentGenerationId=job.spec.contentGenerationId;result.contentEdited=job.spec.contentEdited===true;}
      if (silent) {
        Object.assign(result, { mode: 'silent', width: job.spec.width, height: job.spec.height, motion: job.spec.motion, textStyle: job.spec.textStyle });
        if (job.state === 'completed' && job.result?.mode === 'silent' && job.result.audioTrackCount === 0) Object.assign(result, job.result);
      }
      if (job.error_code) { result.errorCode = job.error_code; result.error = ERRORS[job.error_code] || ERRORS.RENDER_FAILED; }
      if (job.state === 'completed') {
        const base = `/api/video/batches/${record.id}/files/${job.id}`;
        result.videoUrl = `${base}/video.mp4${query}`; result.subtitlesUrl = `${base}/subtitles.srt${query}`;
      }
      return result;
    });
    const result = { id: record.id, clientId: record.client, state: record.state, version: record.version, mode: silent ? 'silent' : record.spec.mode || (record.spec.provider ? 'speech' : 'legacy'),
      createdAt: record.created, updatedAt: record.updated, attempt: record.attempt, jobs, ...await retryReadiness(record) };
    if (!silent) Object.assign(result, { provider: record.spec.provider, model: record.spec.model, voice: record.spec.voice });
    else if (record.state === 'completed' && jobs.every(job => job.audioTrackCount === 0)) Object.assign(result, { audioTrackCount: 0, durationSeconds: jobs.reduce((sum, job) => sum + job.durationSeconds, 0) });
    if (record.error_code) { result.errorCode = record.error_code; result.error = ERRORS[record.error_code] || ERRORS.RENDER_FAILED; }
    return result;
  }
  async function runBatch(record, control) {
    let fatalCode;
    try {
      if (record.mode !== 'silent' || record.spec.mode !== 'silent') throw fault(409, 'MODE_UNSUPPORTED');
      requireRenderer();
      checkOutputPaths(record);
      for (const job of record.jobs) {
        if (job.state === 'completed') continue;
        if (control.signal.aborted || closing) break;
        if (!await store.call('job.start', { id: record.id, jobId: job.id })) break;
        let phase = 'render', tail = Promise.resolve(), callbackError, callbackFault;
        try {
          const segments = [], verified = new Map();
          for (const segment of job.spec.segments) {
            if (control.signal.aborted) break;
            if (!verified.has(segment.media)) verified.set(segment.media, await asset(record.client, segment.media, record.spec.assetDigests?.[segment.media], control.signal));
            segments.push({ ...segment, media: verified.get(segment.media).file });
          }
          if (control.signal.aborted) break;
          const manifest = path.join(batchDir(record), 'manifests', job.id + '.json');
          await fsp.mkdir(path.dirname(manifest), { recursive: true, mode: 0o700 });
          await fsp.writeFile(manifest, JSON.stringify({ mode: 'silent', fps: record.spec.fps, jobs: [{ ...job.spec, segments }] }), { encoding: 'utf8', mode: 0o600 });
          if (control.signal.aborted) break;
          const result = await getAdapter().renderBatch({ manifest, output: outputDir(record), cacheDir, mode: 'silent', signal: control.signal, onStatus(status) {
              if (status?.id !== job.id || control.signal.aborted || callbackFault) return;
              if (status.phase != null && !['render', 'concat'].includes(status.phase)) { callbackFault = fault(500, 'MODE_UNSUPPORTED'); control.abort(); return; }
              if (status.phase) phase = status.phase;
              if (status.errorCode) callbackError = errorInfo(status);
              const completed = Number.isInteger(status.completedSegments) ? Math.max(0, Math.min(job.total, status.completedSegments)) : 0;
              const eventPhase = phase;
              tail = tail.then(() => store.call('job.progress', { id: record.id, jobId: job.id, phase: eventPhase, completed })).catch(() => { callbackFault = fault(503, 'STORE_UNAVAILABLE'); control.abort(); });
            } });
          await tail;
          if (callbackFault) throw callbackFault;
          if (control.signal.aborted) break;
          if (callbackError?.fatal) throw { code: callbackError.code, haltBatch: true };
          if (typeof result?.success !== 'boolean' || !Array.isArray(result.jobs) || result.jobs.length !== 1) throw fault(500, 'ADAPTER_PROTOCOL');
          const final = result?.jobs?.find(status => status.id === job.id);
          if (final?.state !== 'completed') throw final?.errorCode ? final : callbackError ? { code: callbackError.code } : result?.errorCode ? result : fault(500, 'ADAPTER_PROTOCOL');
          if (!result.success) throw fault(500, 'ADAPTER_PROTOCOL');
          if (final.mode !== 'silent' || result.mode !== undefined && result.mode !== 'silent') throw fault(500, 'ADAPTER_PROTOCOL');
          if (!Number.isInteger(final.audioTrackCount)) throw fault(500, 'ADAPTER_PROTOCOL');
          if (final.audioTrackCount !== 0 || result.audioTrackCount !== undefined && result.audioTrackCount !== 0) throw fault(500, 'AUDIO_TRACK_PRESENT');
          const plannedDuration = job.spec.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
          const tolerance = 0.5 / SILENT_LIMITS.fps + 0.005;
          if (!Number.isFinite(final.durationSeconds) || final.durationSeconds <= 0 || final.durationSeconds > SILENT_LIMITS.maxJobDurationSeconds + 1 / SILENT_LIMITS.fps || Math.abs(final.durationSeconds - plannedDuration) > tolerance) throw fault(500, 'ADAPTER_PROTOCOL');
          for (const name of ['video.mp4', 'subtitles.srt']) {
            try { await existingFile(outputDir(record), path.join(outputDir(record), job.id, name)); }
            catch { throw fault(500, 'RENDER_FAILED'); }
          }
          const details = { mode: 'silent', audioTrackCount: 0, durationSeconds: final.durationSeconds };
          if (Number.isInteger(final.reusedSegments) && final.reusedSegments >= 0 && final.reusedSegments <= job.total) details.reusedSegments = final.reusedSegments;
          await store.call('job.finish', { id: record.id, jobId: job.id, state: 'completed', result: details });
        } catch (error) {
          await tail;
          const info = errorInfo(error);
          if (control.signal.aborted && !callbackFault) break;
          if (['FONT_MISSING', 'MEDIA_TOOLS_MISSING', 'ENGINE_START_FAILED'].includes(info.code)) {
            rendererHealth = { ready: false, errorCode: info.code, error: info.message }; healthPromise = Promise.resolve(rendererHealth);
          }
          await store.call('job.finish', { id: record.id, jobId: job.id, state: 'failed', errorCode: info.code });
          if (info.fatal) { fatalCode = info.code; break; }
        }
      }
    } catch (error) { fatalCode = errorInfo(error).code; }
    await store.call('batch.finish', { id: record.id, cancelled: control.signal.aborted && !fatalCode, fatalCode });
  }
  function schedule() {
    if (closing) return;
    if (pumpPromise) { pumpRequested = true; return; }
    pumpPromise = (async () => {
      while (!closing) {
        const record = await store.call('batch.claim'); if (!record) break;
        const control = new AbortController(); active = { kind: 'batch', id: record.id, control };
        try { await runBatch(record, control); } finally { active = null; }
      }
    })().catch(() => { if (active) active.control.abort(); }).finally(() => { pumpPromise = null; if (pumpRequested) { pumpRequested = false; schedule(); } });
  }
  async function handle(req, res) {
    let url; try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
    if (url.pathname !== '/api/video' && !url.pathname.startsWith('/api/video/')) return false;
    try {
      if (!['127.0.0.1', 'localhost'].includes((req.headers.host || '').split(':')[0])) throw fault(403, 'INVALID_INPUT', '仅允许本机访问');
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']) || req.headers.origin && req.headers.origin !== `http://${req.headers.host}` || !['GET', 'HEAD'].includes(req.method) && req.headers.origin !== `http://${req.headers.host}`) throw fault(403, 'INVALID_INPUT', '仅允许本机同源访问');
      if (req.method === 'POST' && url.pathname === '/api/video/voice-previews') throw fault(409, 'PREVIEW_DISABLED');
      if (req.method === 'POST' && url.pathname === '/api/video/content-generations') { json(res,410,{errorCode:'CONTENT_AUTHORING_MOVED',error:ERRORS.CONTENT_AUTHORING_MOVED,authoringUrl:'/workbench/zip/index.html'});return true; }
      await initialize();
      const clientId = url.searchParams.get('clientId') || undefined;
      if (req.method === 'POST' && url.pathname === '/api/video/content-layouts') { const input=await readJson(req);requireRenderer();json(res,200,await content.relayout(input));return true; }
      if (req.method === 'GET' && url.pathname === '/api/video/config') {
        if (url.searchParams.get('refresh') === '1') await checkRenderer(true);
        const rendererAvailable = available();
        json(res, 200, { mode: 'silent', engineReady: rendererAvailable, rendererAvailable, maxJobs: 30, maxSegments: 100, maxSegmentCharacters: 500, maxUploadBytes: MAX_UPLOAD,
          ...SILENT_LIMITS, contentGeneration:{enabled:false,state:'zip-workbench',authoringUrl:'/workbench/zip/index.html'}, contentPresets:contentText.presets, width: 720, height: 1280, motions: ['none', 'gentle'], textStyles: { positions: ['top', 'bottom'], presets: ['white-outline', 'yellow-outline'], fontSize: SILENT_LIMITS.defaultFontSize },
          defaults: { width: 720, height: 1280, motion: 'gentle', durationSeconds: 5, textStyle: { position: 'bottom', preset: 'white-outline', fontSize: 48 } }, ...(rendererAvailable ? {} : { rendererErrorCode: rendererHealth.errorCode, rendererError: rendererHealth.error }), uploadTypes: Object.keys(TYPES) }); return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/video/upload') {
        await store.call('client.check', { clientId });
        const type = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
        if (!TYPES[type]) throw fault(415, 'INVALID_INPUT', '支持PNG、JPEG、WebP、MP4、MOV、WebM、MKV');
        const bytes = await readBody(req, MAX_UPLOAD);
        if (!bytes.length || !matchesType(bytes, type)) throw fault(415, 'INVALID_INPUT', '文件签名与声明的媒体类型不符');
        const id = crypto.randomUUID(), file = id + TYPES[type];
        const name = path.basename((url.searchParams.get('name') || 'media').replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').slice(0, 180) || 'media';
        const dest = path.join(dataDir, 'uploads', file);
        await fsp.writeFile(dest, bytes, { flag: 'wx', mode: 0o600 });
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        try { await store.call('asset.put', { id, clientId, name, type, size: bytes.length, file, sha256 }); } catch (error) { await fsp.unlink(dest).catch(() => {}); throw error; }
        json(res, 201, { id, assetId: id, clientId, name, type, size: bytes.length }); return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/video/batches') {
        const records = await store.call('batch.list', { clientId }); json(res, 200, { batches: await Promise.all(records.map(view)) }); return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/video/batches') {
        const spec = normalizeBatch(await readJson(req)); requireRenderer();
        for (const job of spec.jobs) if (job.source) {
          if (typeof options.resolveSource !== 'function') throw fault(503, 'CONTENT_SOURCES_MISSING');
          job.source = await options.resolveSource(spec.clientId, job.source);
          const classified=contentText.partition(job.source.body_md);
          job.editorial={...classified,origin:'zip-article',provenance:job.source.provenance,currentEdited:contentText.canon(classified.displayBody)!==contentText.canon(job.originalText)};
        }
        for (const job of spec.jobs) if (!job.source) {
          const classified=contentText.partition(job.manualMarkdown??job.originalText);
          job.editorial={...classified,origin:'manual',currentEdited:contentText.canon(classified.displayBody)!==contentText.canon(job.originalText)};
        }
        spec.assetDigests = {};
        for (const job of spec.jobs) for (const segment of job.segments) {
          if (!spec.assetDigests[segment.media]) spec.assetDigests[segment.media] = (await asset(spec.clientId, segment.media)).sha256;
        }
        const id = crypto.randomUUID(); checkOutputPaths({ id, layout: 'compact', jobs: spec.jobs });
        const result = await store.call('batch.create', { id, digest: digest(spec), jobVersions: Object.fromEntries(spec.jobs.map(j => [j.id, digest({ mode: 'silent', fps: spec.fps, ...j, assetDigests: Object.fromEntries(j.segments.map(s => [s.media, spec.assetDigests[s.media]])) })])), spec });
        json(res, result.created ? 202 : 200, await view(result.record)); schedule(); return true;
      }
      const preview = url.pathname.match(/^\/api\/video\/voice-previews\/([a-f0-9-]{36})\/audio\.wav$/);
      if (preview && ['GET', 'HEAD'].includes(req.method) && UUID.test(preview[1])) {
        const record = await store.call('preview.get', { id: preview[1], clientId });
        if (record.state !== 'completed') throw fault(404, 'NOT_FOUND');
        await sendFile(req, res, dataDir, path.join(dataDir, 'previews', record.id, 'audio.wav'), { type: 'audio/wav', name: 'preview.wav', inline: true, range: true }); return true;
      }
      const match = url.pathname.match(/^\/api\/video\/batches\/([a-f0-9-]{36})\/(status|stop|retry|files\/([A-Za-z0-9_-]{1,64})\/(video\.mp4|subtitles\.srt))$/);
      if (match && UUID.test(match[1])) {
        if (match[2] === 'status' && req.method === 'GET') { json(res, 200, await view(await store.call('batch.get', { id: match[1], clientId }))); return true; }
        if (['stop', 'retry'].includes(match[2]) && req.method === 'POST') {
          const input = await readJson(req);
          if (input.clientId && clientId && input.clientId !== clientId) throw fault(404, 'NOT_FOUND');
          const owner = input.clientId || clientId;
          const record = await store.call('batch.get', { id: match[1], clientId: owner });
          if (match[2] === 'stop') {
            const stopped = await store.call('batch.stop', { id: record.id, clientId: owner });
            if (stopped.state === 'stopping' && active?.kind === 'batch' && active.id === record.id) active.control.abort();
            json(res, 200, await view(stopped)); return true;
          }
          if (record.mode !== 'silent' || record.spec.mode !== 'silent') throw fault(409, 'MODE_UNSUPPORTED');
          const readiness = await retryReadiness(record);
          if (!readiness.canRetry) throw fault(409, 'RETRY_UNAVAILABLE', readiness.retryUnavailableReason || ERRORS.RETRY_UNAVAILABLE);
          requireRenderer();
          const retried = await store.call('batch.retry', { id: record.id, clientId: owner });
          json(res, 202, await view(retried)); schedule(); return true;
        }
        if (match[3] && ['GET', 'HEAD'].includes(req.method)) {
          const record = await store.call('batch.get', { id: match[1], clientId });
          const job = record.jobs.find(j => j.id === match[3]);
          if (!job || job.state !== 'completed') throw fault(404, 'NOT_FOUND');
          const video = match[4] === 'video.mp4';
          await sendFile(req, res, outputDir(record), path.join(outputDir(record), job.id, match[4]), {
            type: video ? 'video/mp4' : 'application/x-subrip; charset=utf-8', name: `${job.id}-${match[4]}`, inline: video && url.searchParams.get('inline') === '1', range: video,
          }); return true;
        }
      }
      throw fault(404, 'NOT_FOUND');
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { errorCode: error.code && ERRORS[error.code] ? error.code : 'STORE_UNAVAILABLE', error: error.status ? error.message : ERRORS.STORE_UNAVAILABLE }); else res.end();
      return true;
    }
  }
  handle.ready = initialize;
  // An event-driven completion boundary for embedding and deterministic offline tests.
  handle.whenIdle = async () => {
    while (pumpPromise) await pumpPromise;
  };
  handle.close = async () => {
    closing = true;
    if (!init) return;
    await init.catch(() => {});
    if (active?.kind === 'batch') {
      await store.call('batch.stop', { id: active.id }).catch(() => {}); active?.control.abort();
    } else if (active) active.control.abort();
    if (pumpPromise) await pumpPromise;
    if (store) await store.close();
  };
  Object.defineProperty(handle, 'storePid', { get: () => store?.pid });
  return handle;
}
const handle = createHandler();
module.exports = { createHandler, createStore, handle, MAX_UPLOAD };
