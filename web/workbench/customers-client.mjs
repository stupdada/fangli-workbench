import { clone } from './model.mjs';
import { parseFile } from './files.mjs';

const enc = encodeURIComponent;
export const activeBatch = batch => ['queued', 'running'].includes(batch?.status);
export const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const pendingKey = 'fangli.batch.pending.v1';

export class CustomerClient {
  constructor(api, { storage = globalThis.localStorage, uuid = () => crypto.randomUUID() } = {}) {
    this.api = api; this.storage = storage; this.uuid = uuid;
    try { this.pending = JSON.parse(storage?.getItem(pendingKey) || 'null'); } catch { this.pending = null; }
  }
  path(id, tail = '') { return `/api/workbench/clients/${enc(id)}${tail}`; }
  async clients(archived = false) { return (await this.api('/api/workbench/clients' + (archived ? '?archived=1' : ''))).clients; }
  async client(id) { return (await this.api(this.path(id))).client; }
  archiveClient(id) { return this.api(this.path(id, '/archive'), 'POST', {}); }
  restoreClient(id) { return this.api(this.path(id, '/restore'), 'POST', {}); }
  async importDrafts() { return (await this.api('/api/workbench/import-drafts')).drafts; }
  startImport(id, name) { return this.api('/api/workbench/import-drafts', 'POST', {id,name}); }
  async saveClient(id, name, profile, creationId) { return (await this.api(id ? this.path(id) : '/api/workbench/clients', id ? 'PUT' : 'POST', { name, profile, ...(!id && creationId ? {creation_id:creationId} : {}) })).client; }
  plan(id) { return this.api(this.path(id, '/generation-plan')); }
  savePlan(id, payload) { return this.api(this.path(id, '/generation-plan'), 'PUT', payload); }
  async documents(id, removed = false) { return (await this.api(this.path(id, '/documents' + (removed ? '?removed=1' : '')))).documents; }
  removeDocument(id, documentId) { return this.api(this.path(id, `/documents/${enc(documentId)}`), 'DELETE', {}); }
  restoreDocument(id, documentId, add_to_defaults) { return this.api(this.path(id, `/documents/${enc(documentId)}/restore`), 'POST', {add_to_defaults}); }
  retryDocument(id, documentId, payload = {}) { return this.api(this.path(id, `/documents/${enc(documentId)}/retry`), 'POST', payload); }
  checkDocument(id, payload) { return this.api(this.path(id, '/documents/check'), 'POST', payload); }
  addDocument(id, payload) { return this.api(this.path(id, '/documents'), 'POST', payload); }
  async revisions(id, documentId) { return (await this.api(this.path(id, `/documents/${enc(documentId)}/revisions`))).documents; }
  history(id) { return this.api(this.path(id, '/history')); }
  startIntake(id, payload) { return this.api(this.path(id, '/intakes'), 'POST', payload); }
  latestIntake(id) { return this.api(this.path(id, '/intakes')); }
  intake(id, intakeId) { return this.api(this.path(id, `/intakes/${enc(intakeId)}`)); }
  adoptIntake(id, intakeId, payload) { return this.api(this.path(id, `/intakes/${enc(intakeId)}/adopt`), 'POST', payload); }
  searchClaim(id, intakeId, claimKey, query) {
    return this.api(this.path(id, `/intakes/${enc(intakeId)}/claims/${enc(claimKey)}/search`), 'POST', {query});
  }
  reviewClaim(id, intakeId, claimKey, payload) {
    return this.api(this.path(id, `/intakes/${enc(intakeId)}/claims/${enc(claimKey)}/review`), 'POST', payload);
  }
  async batches() { return (await this.api('/api/workbench/batches')).batches; }
  batchPath(id, tail = '') { return `/api/workbench/batches/${enc(id)}${tail}`; }
  async batch(id) { return (await this.api(this.batchPath(id))).batch; }
  async batchAction(id, action, payload = {}) { return (await this.api(this.batchPath(id, `/${action}`), 'POST', payload)).batch; }
  async retryBatchVideo(batchId, videoId, payload = {}) {
    const {batch} = await this.api(this.batchPath(batchId, `/videos/${enc(videoId)}/retry`), 'POST', payload);
    if (!batch?.id) throw new Error('未收到批次状态，请刷新后查看');
    return batch;
  }
  batchVideoDownload(batchId) { return this.batchPath(batchId, '/video-download'); }
  preflight(items) { return this.api('/api/workbench/batches/preflight', 'POST', { items: clone(items) }); }
  async submit(items) {
    const snapshot = clone(items);
    if (this.pending && canonical(this.pending.items) !== canonical(snapshot)) throw new Error('上一批提交结果尚未确认，请先重发同一次请求并恢复结果，再提交新安排');
    if (!this.pending) this.pending = { request_key: this.uuid(), items: snapshot };
    // Persist before crossing the write boundary. A failed/ambiguous response retains both key and payload.
    this.storage?.setItem(pendingKey, JSON.stringify(this.pending));
    let batch;
    try { ({ batch } = await this.api('/api/workbench/batches', 'POST', clone(this.pending))); }
    catch (error) {
      // Validation rejection is a confirmed no-write result; permit correcting the batch draft.
      if (error.status === 400) { this.pending = null; this.storage?.removeItem?.(pendingKey); }
      throw error;
    }
    if (!batch?.id) throw new Error('批次响应不完整，请重发同一次请求恢复结果');
    this.pending = null; this.storage?.removeItem?.(pendingKey);
    return batch;
  }
  retrySubmission() { if (!this.pending) throw new Error('没有待恢复的提交'); return this.submit(this.pending.items); }
}

export async function originalPayload(file) {
  if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} 超过 8 MB，请拆分后添加`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { filename: file.name, sha256: [...digest].map(v => v.toString(16).padStart(2, '0')).join(''), content_b64: btoa(binary) };
}

export async function importCustomerFile(service, clientId, file, resolve) {
  const original = await originalPayload(file);
  const check = await service.checkDocument(clientId, { filename: file.name, sha256: original.sha256 });
  if (check.duplicate) return { outcome: 'duplicate', document: check.duplicate, is_current: check.is_current ?? check.duplicate.is_current };
  let choice = {};
  if (check.candidates?.length) {
    choice = await resolve({ ...check, filename: file.name });
    if (!choice) return { outcome: 'cancelled' };
  }
  const payload = { filename: file.name, content_b64: original.content_b64, ...choice };
  if (/\.pdf$/i.test(file.name)) payload.text = (await parseFile(file, service.api)).text;
  let result = await service.addDocument(clientId, payload);
  // The server rechecks after upload; a concurrent import may introduce a new candidate.
  if (result.outcome === 'needs_resolution') {
    const resolution = await resolve({ ...result, filename: file.name });
    if (!resolution) return { outcome: 'cancelled' };
    result = await service.addDocument(clientId, { ...payload, ...resolution });
  }
  return result;
}

export class BatchMonitor {
  constructor(service, onUpdate, onError, { visibility = globalThis.document, schedule = (...args) => setTimeout(...args), cancel = (...args) => clearTimeout(...args), limit = 600 } = {}) {
    Object.assign(this, { service, onUpdate, onError, visibility, schedule, cancel, limit });
    this.onVisibility = () => { this.cancel(this.timer); if (!visibility.hidden && this.id) this.tick(); };
    visibility?.addEventListener('visibilitychange', this.onVisibility);
  }
  start(batch) { this.cancel(this.timer); this.id = activeBatch(batch) ? batch.id : null; this.remaining = this.limit; this.generation = (this.generation || 0) + 1; if (this.id && !this.visibility?.hidden) this.timer = this.schedule(() => this.tick(), 3000); }
  async tick() {
    if (!this.id || this.visibility?.hidden || this.inflight === this.generation) return;
    const generation = this.generation; this.inflight = generation;
    try {
      const batch = await this.service.batch(this.id);
      if (generation !== this.generation) return;
      this.onUpdate(batch); if (!activeBatch(batch)) { this.id = null; return; }
      if (--this.remaining <= 0) { this.id = null; this.onError(new Error('自动更新已暂停，可点击刷新继续查看批次')); return; }
      this.timer = this.schedule(() => this.tick(), 3000);
    } catch (error) { if (generation === this.generation) { this.id = null; this.onError(error); } }
    finally { if (this.inflight === generation) this.inflight = null; }
  }
  dispose() { this.id = null; this.generation = (this.generation || 0) + 1; this.cancel(this.timer); this.visibility?.removeEventListener('visibilitychange', this.onVisibility); }
}
