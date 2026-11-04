'use strict';
// Internal bridge. HTTP owns client/asset authorization and durable task state.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class EngineError extends Error {
  constructor(fields) {
    super(fields.error || '视频引擎执行失败');
    this.name = 'VideoEngineError';
    this.code = fields.errorCode || 'ENGINE_FAILED';
    this.errorCode = this.code;
    this.haltBatch = fields.haltBatch !== false;
    this.billingUncertain = fields.billingUncertain === true;
    if (fields.requestId) this.requestId = fields.requestId;
  }
}

let queue = Promise.resolve();
function serial(operation) {
  const pending = queue.then(operation, operation);
  queue = pending.catch(() => {});
  return pending;
}

function defaultCacheDir() {
  const root = process.env.FANGLI_VIDEO_DATA_DIR || (process.env.FANGLI_DATA_DIR && path.join(process.env.FANGLI_DATA_DIR, 'video')) || path.join(__dirname, '..', '.data', 'video');
  return path.join(root, 'cache');
}

async function cancelledBatch(manifest) {
  const value = typeof manifest === 'string' ? JSON.parse(await fs.readFile(manifest, 'utf8')) : manifest;
  return { success: false, mode: 'silent', jobs: (value?.jobs || []).map(job => ({ id: job.id, mode: 'silent', state: 'cancelled', phase: 'render',
    completedSegments: 0, totalSegments: job.segments?.length || 0, errorCode: 'CANCELLED',
    error: '尚未开始；本地已停止', haltBatch: true, billingUncertain: false })) };
}

async function execute(mode, settings) {
  if (mode === 'preview' || (settings.mode && settings.mode !== 'silent')) {
    throw new EngineError({ errorCode: 'MODE_UNSUPPORTED', error: '当前入口支持图文视频制作' });
  }
  const { signal, onStatus = () => {} } = settings;
  if (signal?.aborted) {
    if (mode === 'batch') return cancelledBatch(settings.manifest);
    throw new EngineError({ errorCode: 'CANCELLED', error: '试听尚未开始，已停止' });
  }
  if (typeof settings.output !== 'string' || !settings.output) throw new TypeError('output must be a local path');
  const output = path.resolve(settings.output);
  const directory = mode === 'preview' ? path.dirname(output) : output;
  await fs.mkdir(directory, { recursive: true });
  const requestPath = path.join(directory, `.engine-request-${randomUUID()}.json`);
  const request = { operation: mode, mode: 'silent', output, cacheDir: path.resolve(settings.cacheDir || defaultCacheDir()) };
  if (mode === 'batch') request.manifest = typeof settings.manifest === 'string' ? path.resolve(settings.manifest) : settings.manifest;
  else request.text = settings.text;
  await fs.writeFile(requestPath, JSON.stringify(request), { encoding: 'utf8', mode: 0o600 });
  try {
    return await new Promise((resolve, reject) => {
      const args = [path.join(__dirname, 'video_batch.py'), '--request', requestPath, '--watch-parent-stdin'];
      const childEnv = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
      for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LANG']) {
        if (process.env[name]) childEnv[name] = process.env[name];
      }
      const child = spawn(process.env.FANGLI_PYTHON || 'python', args, { windowsHide: true,
        env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      let buffer = '', stderr = '', finalResult, engineError, callbackError;
      let statusTail = Promise.resolve();
      const active = new Map();
      let stopSent = false;
      function notify(status) {
        active.set(status.id, status);
        statusTail = statusTail.then(() => onStatus(status)).catch(error => {
          callbackError ||= error;
          stop();
        });
      }
      function stop() {
        if (stopSent) return;
        stopSent = true;
        // Resolve only after the exact local FFmpeg child has stopped.
        if (child.stdin.writable) child.stdin.end('{"command":"cancel"}\n');
        for (const status of active.values()) {
          if (status.state === 'running') notify({ ...status, state: 'stopping' });
        }
      }
      function parse(line) {
        if (!line.trim()) return;
        try {
          const message = JSON.parse(line);
          if (message.type === 'status') notify(message.status);
          else if (message.type === 'result') {
            finalResult = message.result;
            if (child.stdin.writable) child.stdin.end();
          }
          else if (message.type === 'error') engineError = new EngineError(message.error);
        } catch {
          engineError ||= new EngineError({ errorCode: 'ENGINE_PROTOCOL', error: '引擎输出不是有效的结构化消息' });
          stop();
        }
      }
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
        if (buffer.length > 1024 * 1024) {
          buffer = '';
          engineError = new EngineError({ errorCode: 'ENGINE_PROTOCOL', error: '引擎消息超过限制' });
          stop();
        }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-32768); });
      child.stdin.on('error', () => {});
      child.once('error', error => {
        engineError = new EngineError({ errorCode: 'ENGINE_START_FAILED', error: `无法启动 Python 引擎：${error.code || 'unknown'}` });
      });
      child.once('close', async code => {
        signal?.removeEventListener('abort', stop);
        if (buffer.trim()) parse(buffer);
        await statusTail;
        if (stderr) {
          try { await fs.appendFile(path.join(directory, 'engine-stderr.log'), stderr, 'utf8'); }
          catch { /* Preserve the original execution result if diagnostics cannot be persisted. */ }
        }
        if (callbackError) return reject(callbackError);
        if (engineError) return reject(engineError);
        if ((code === 0 || code === 1) && finalResult) return resolve(finalResult);
        reject(new EngineError({ errorCode: 'ENGINE_INTERRUPTED', error: `引擎进程意外退出（${code ?? 'signal'}），请检查本地日志`, billingUncertain: false }));
      });
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    });
  } finally {
    await fs.rm(requestPath, { force: true });
  }
}

function renderBatch(settings) { return serial(() => execute('batch', settings)); }
function previewSpeech(settings) { return serial(() => execute('preview', settings)); }

module.exports = { renderBatch, previewSpeech, EngineError };
