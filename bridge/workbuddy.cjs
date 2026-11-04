'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {webcrypto} = require('node:crypto');

function classified(error) {
  const status = Number(error?.status || 0);
  const kind = ['truncated', 'configuration', 'cancelled'].includes(error?.kind) ? error.kind :
    status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limited' :
    status >= 400 && status < 500 ? 'provider_rejected' : 'uncertain';
  return {type: 'error', kind, status}; // Raw SDK errors may contain credentials or upstream bodies.
}

function diagnostic(error) {
  let message = String(error?.message || 'WorkBuddy request failed');
  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/workbuddy.json'), 'utf8'));
    for (const key of ['publishableKey', 'endpoint', 'oauthRelayBaseUrl']) {
      if (config[key]) message = message.replaceAll(config[key], '[redacted]');
    }
  } catch {}
  message = message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/(?:wbpk_|sk-)[A-Za-z0-9_\-]+/g, '[redacted]')
    .replace(/https?:\/\/[^\s"']+/g, '[redacted-url]');
  const field = value => typeof value === 'string' && /^[A-Za-z0-9_.:\-]{1,120}$/.test(value) ? value : undefined;
  return {message: message.slice(0, 500), code: field(error?.code || error?.error?.code),
    param: field(error?.error?.param), request_id: field(error?.requestId)};
}

async function execute(input, emit, fetchImpl = fetch) {
  let config;
  try {config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/workbuddy.json'), 'utf8'));}
  catch {throw Object.assign(new Error('configuration'), {kind: 'configuration'});}
  const memory = new Map();
  const storage = {getItem: k => memory.get(k) || null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k)};
  const bodies = new Set(), controller = new AbortController();
  let timer;
  const arm = () => {clearTimeout(timer); timer = setTimeout(() => controller.abort(), (input.timeout || 300) * 1000);};
  const wrapped = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Origin', 'http://127.0.0.1');
    const result = await fetchImpl(url, {...init, headers, signal: controller.signal});
    if (result.body) bodies.add(result.body);
    return result;
  };
  const ctx = vm.createContext({fetch: wrapped, Headers, Request, Response, URL, URLSearchParams,
    TextDecoder, TextEncoder, ReadableStream, AbortController, DOMException, crypto: webcrypto,
    setTimeout, clearTimeout, localStorage: storage, sessionStorage: storage,
    console: {log() {}, warn() {}, error() {}}});
  ctx.window = ctx; ctx.self = ctx;
  arm();
  try {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../vendor/workbuddy-sdk.js'), 'utf8'), ctx);
    const cloud = ctx.WorkBuddyCloud.createWorkBuddyCloud({...config, fetch: wrapped});
    if (input.operation === 'models') {
      const values = await cloud.llm.models.list(controller.signal);
      const models = values.filter(m => m.enabled !== false && !m.disabled && m.capabilities?.chat !== false &&
        m.capabilities?.streaming !== false && (!m.modalities?.output || m.modalities.output.includes('text')))
        .map(m => ({id: m.id, name: m.name || m.id, capabilities: m.capabilities || {}, maxOutputTokens: m.maxOutputTokens}));
      emit({type: 'models', models});
      return;
    }
    const request = {model: input.model, messages: input.messages, stream: true,
      temperature: input.temperature, max_tokens: input.max_tokens};
    if (input.force_json) request.response_format = {type: 'json_object'};
    if (input.enable_thinking !== undefined) request.enable_thinking = input.enable_thinking;
    let finish = '', text = '';
    for await (const chunk of cloud.llm.chat.completions.create({...request, signal: controller.signal})) {
      arm();
      const choice = chunk.choices?.[0];
      if (choice?.delta?.refusal || choice?.delta?.tool_calls?.length) throw new Error('refused');
      if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
        text += choice.delta.content;
        emit({type: 'delta', text: choice.delta.content});
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) emit({type: 'usage', usage: chunk.usage});
    }
    if (controller.signal.aborted || finish !== 'stop' || !text.trim()) {
      throw Object.assign(new Error('incomplete'), {kind: finish === 'length' ? 'truncated' : 'uncertain'});
    }
    emit({type: 'done', finish_reason: finish});
  } finally {
    clearTimeout(timer);
    controller.abort();
    for (const body of bodies) {try {await body.cancel();} catch {}}
  }
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', piece => {raw += piece;});
  process.stdin.on('end', async () => {
    const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
    try {await execute(JSON.parse(raw), emit);}
    catch (error) {emit({...classified(error), diagnostic: diagnostic(error)}); process.exitCode = 1;}
  });
}
module.exports = {execute, classified, diagnostic};
