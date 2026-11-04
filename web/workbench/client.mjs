import { DEFAULT_MODEL, OPERATION_KIND, normalizeOptions, clone, running, validateStart, streamReducer } from './model.mjs';

export const STORAGE_KEY = 'fangli.workbench.v1';
const enc = encodeURIComponent;
export class ApiError extends Error { constructor(message, status = 0) { super(message); this.status = status; } }

export class WorkbenchClient {
  constructor({ fetcher = globalThis.fetch?.bind(globalThis), storage = globalThis.localStorage,
    eventSource = url => new EventSource(url), delay = ms => new Promise(r => setTimeout(r, ms)), operationLimit = 150 } = {}) {
    this.fetcher = fetcher; this.storage = storage; this.eventSource = eventSource; this.delay = delay; this.operationLimit = operationLimit;
    this.listeners = new Set(); this.watchers = new Map(); this.saveQueue = Promise.resolve(); this.revision = 0;
    try { this.cache = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}'); } catch { this.cache = {}; }
    this.state = { bootstrap: null, config: null, clients: [], conversations: [], conversation: null, articles: [], documents: [], library: [],
      operations: [], job: null, stream: {}, options: normalizeOptions(this.cache.pending?.options), documentIds: this.cache.pending?.documentIds || [],
      ui: { followup: true, sidebarWidth: 244, collapsed: false, ...this.cache.ui }, editors: this.cache.editors || {},
      dirty: !!this.cache.pending, saved: false, error: '', needsConfirmation: this.cache.needsConfirmation || false, results: {}, busy: new Set(), loaded: false };
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.persist(); for (const fn of this.listeners) fn(this.state); }
  persist() {
    const s = this.state;
    const record = { activeId: s.conversation?.id || this.cache.activeId, ui: s.ui, editors: s.editors,
      needsConfirmation: s.needsConfirmation,
      pending: s.dirty ? { id: s.conversation?.id || null, options: s.options, documentIds: s.documentIds,followup:s.ui.followup } : null };
    this.cache = record;
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(record)); } catch { /* Server remains authoritative; surface save errors separately. */ }
  }
  async api(path, method = 'GET', body) {
    let response;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 45000);
    try {
      response = await this.fetcher(path, { method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new ApiError(data.error || `请求失败（${response.status}）`, response.status);
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error.name === 'AbortError' ? '请求超时；执行结果未确认，请先恢复后台状态' : '无法连接本机服务，请恢复服务后重试');
    } finally { clearTimeout(timer); }
  }
  path(tail = '') { if (!this.state.conversation) throw new Error('请先选择客户并创建任务'); return `/api/workbench/conversations/${enc(this.state.conversation.id)}${tail}`; }
  articlePath(aid, tail = '') { return this.path(`/articles/${enc(aid)}${tail}`); }
  get activeJob() { return running(this.state.job); }
  get targets() { return this.state.bootstrap?.target_models || []; }
  get platforms() { return this.state.bootstrap?.platforms || []; }
  setUI(patch) { const followupChanged='followup' in patch&&patch.followup!==this.state.ui.followup;Object.assign(this.state.ui, patch);if(followupChanged)this.markDirty({affectsGeneration:false});else this.emit(); }

  async boot(id) {
    try {
      const results = await Promise.allSettled([this.api('/api/workbench/bootstrap'), this.api('/api/workbench/zip-config')]);
      if (results[0].status === 'rejected') throw results[0].reason;
      const b = results[0].value; this.state.bootstrap = b; this.state.clients = b.clients || []; this.state.conversations = b.conversations || [];
      this.state.config = results[1].status === 'fulfilled' ? results[1].value : null;
      this.state.configError = results[1].status === 'rejected' ? results[1].reason.message : '';
      this.state.model = b.settings?.model || DEFAULT_MODEL;
      if (!this.cache.pending) this.state.options = normalizeOptions({}, this.targets);
      const target = id || this.cache.activeId;
      if (target) await this.load(target);
      this.state.loaded = true; this.emit();
    } catch (error) { this.state.error = error.message; this.state.loaded = true; this.emit(); throw error; }
  }

  hydrate(data) {
    const s = this.state; const c = data.conversation;
    const same = s.conversation?.id === c.id;
    s.conversation = c; s.articles = data.articles || c.articles || []; s.documents = data.documents || c.documents || [];
    s.job = data.job || null; s.operations = data.operations || [];
    if (!same || !s.dirty) {
      const source = c.brief || {};
      s.options = normalizeOptions(source, this.targets);
      s.documentIds = clone(c.document_ids || c.draft?.document_ids || source.document_ids || []);
      if(typeof c.followup==='boolean')s.ui.followup=c.followup;
    }
    const pending = this.cache.pending;
    if (pending && String(pending.id) === String(c.id)) {
      s.options = normalizeOptions(pending.options, this.targets); s.documentIds = pending.documentIds || []; s.dirty = true;
      if(typeof pending.followup==='boolean')s.ui.followup=pending.followup;
    } else if (!same) { s.dirty = false; }
    s.options.document_ids=clone(s.documentIds);
    s.needsConfirmation=Boolean(c.needs_confirmation)||Boolean((same||this.cache.activeId===c.id)&&s.needsConfirmation);
    const index = s.conversations.findIndex(x => x.id === c.id);
    if (index < 0) s.conversations.unshift(c); else s.conversations[index] = c;
    s.results={};
    for (const op of [...s.operations].sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')))) {
      if (op.result) s.results[op.kind] = { ...op.result, operation_id: op.id };
    }
    this.emit();
  }
  async load(id) {
    if (this.state.conversation && String(this.state.conversation.id) !== String(id)) {
      this.state.results = {}; this.state.stream = {}; this.state.ui.reply = ''; this.state.needsConfirmation = false;
    }
    this.closeStream(); const token = this.contextToken = Symbol('conversation');
    const data = await this.api(`/api/workbench/conversations/${enc(id)}`);
    if(token !== this.contextToken)return null;
    this.hydrate(data);
    const clientId = data.conversation.client_id;
    const library = await this.api(`/api/workbench/clients/${enc(clientId)}/documents`);
    if(token !== this.contextToken)return null;
    this.state.library = library.documents || [];
    this.emit(); this.resumeBackground(); return data;
  }
  async reload() { const cid=this.state.conversation.id,token=this.contextToken;const data = await this.api(this.path());if(cid===this.state.conversation?.id&&token===this.contextToken)this.hydrate(data);return data; }
  resumeBackground() {
    if (this.activeJob && this.state.job?.id) this.attachStream(this.state.job.id);
    for (const op of this.state.operations) if (running(op) && op.kind!==OPERATION_KIND.writing) this.watchOperation(op.id).catch(e => this.fail(e));
  }
  fail(error) { this.state.error = error.message || String(error); this.emit(); }
  async createClient(name, profile) {
    const d = await this.api('/api/workbench/clients', 'POST', { name, profile });
    const i = this.state.clients.findIndex(x => x.id === d.client.id);
    if (i < 0) this.state.clients.push(d.client); else this.state.clients[i] = d.client;
    this.emit(); return d.client;
  }
  async updateProfile(name,profile) {
    if(this.state.dirty)await this.saveDraft();
    const cid=this.state.conversation.id,token=this.contextToken;
    const task=async()=>{
      const d=await this.api(`/api/workbench/conversations/${enc(cid)}/profile`,'PUT',{name,profile});
      const index=this.state.clients.findIndex(c=>c.id===d.client.id);
      if(index<0)this.state.clients.push(d.client);else this.state.clients[index]=d.client;
      if(this.state.conversation?.id===cid&&this.contextToken===token){
        this.state.conversation=d.conversation;this.state.options=normalizeOptions(d.conversation.brief,this.targets);
        this.state.documentIds=clone(d.conversation.document_ids);this.state.needsConfirmation=Boolean(d.conversation.needs_confirmation);
        this.state.saved=true;this.state.dirty=false;this.cache.pending=null;
      }
      this.emit();return d.client;
    };
    this.saveQueue=this.saveQueue.catch(()=>{}).then(task);return this.saveQueue;
  }
  async createConversation(clientId) {
    if (this.state.conversation && this.state.dirty) await this.saveDraft();
    const d = await this.api('/api/workbench/conversations', 'POST', { client_id: clientId });
    const pending = !this.state.conversation ? clone(this.state.options) : null;
    this.state.dirty = false; this.cache.pending = null; this.state.results = {}; this.state.stream = {}; this.state.needsConfirmation = false;
    await this.load(d.conversation.id);
    if(pending){this.state.options={...this.state.options,...pending};this.state.documentIds=[];this.markDirty();await this.saveDraft();}
    return d.conversation;
  }
  markDirty({affectsGeneration=true}={}) {
    this.state.dirty = true; this.state.saved = false; this.revision++;
    if (affectsGeneration && this.activeJob && !this.state.needsConfirmation) {
      this.state.needsConfirmation = true;
      this.pausePromise = this.stop().catch(error => { this.fail(error); throw error; });
      this.pausePromise.catch(() => {});
    }
    clearTimeout(this.saveTimer);
    if (this.state.conversation) this.saveTimer = setTimeout(() => this.saveDraft().catch(e => this.fail(e)), 650);
    this.emit();
  }
  setOptions(patch) { this.state.options = { ...this.state.options, ...clone(patch) }; this.markDirty(); }
  selectDocuments(ids) { this.state.documentIds = [...new Set(ids)].map(id => this.state.library.find(d=>String(d.id)===String(id))?.id ?? id);this.state.options.document_ids=clone(this.state.documentIds); this.markDirty(); }
  async saveDraft(mode) {
    clearTimeout(this.saveTimer);
    if (!this.state.conversation) { this.persist(); return; }
    const cid = this.state.conversation.id, revision = this.revision;
    const payload = { options: clone(this.state.options), document_ids: clone(this.state.documentIds),followup:this.state.ui.followup, ...(mode ? { mode } : {}) };
    const path = this.path('/draft');
    const task = async () => {
      if (this.pausePromise) await this.pausePromise;
      const d = await this.api(path, 'PUT', payload);
      if (cid === this.state.conversation?.id && revision === this.revision) {
        this.state.dirty = false; this.state.saved = true; this.cache.pending = null;
        this.state.conversation=d.conversation;this.state.options=normalizeOptions(d.conversation.brief,this.targets);
        this.state.documentIds=clone(d.conversation.document_ids);this.state.needsConfirmation=Boolean(d.conversation.needs_confirmation)||this.state.needsConfirmation;
        this.emit();
      }
      return d;
    };
    this.saveQueue = this.saveQueue.catch(() => {}).then(task); return this.saveQueue;
  }
  async addDocument(document) {
    const cid = this.state.conversation?.client_id; if (!cid) throw new Error('请先选择客户');
    const d = await this.api(`/api/workbench/clients/${enc(cid)}/documents`, 'POST', document);
    if (!this.state.library.some(x => x.id === d.document.id)) this.state.library.push(d.document);
    if (!this.state.documents.some(x => x.id === d.document.id)) this.state.documents.push(d.document);
    this.selectDocuments([...this.state.documentIds, d.document.id]); await this.saveDraft(); return d.document;
  }
  async reviseDocument(id,text) {
    const source=this.state.library.find(d=>String(d.id)===String(id));if(!source)throw new Error('资料不存在');
    if(text.trim().length<10)throw new Error('资料至少需要 10 个字，请核对解析结果');
    const cid=this.state.conversation?.client_id,conversationId=this.state.conversation?.id;
    const d=await this.api(`/api/workbench/clients/${enc(cid)}/documents`,'POST',{filename:source.filename,kind:source.kind,text:text.trim()});
    if(this.state.conversation?.id!==conversationId)return d.document;
    if(!this.state.library.some(item=>item.id===d.document.id))this.state.library.push(d.document);
    this.selectDocuments(this.state.documentIds.map(value=>String(value)===String(id)?d.document.id:value));
    this.state.documents=this.state.library.filter(item=>this.state.documentIds.some(value=>String(value)===String(item.id)));
    await this.saveDraft();return d.document;
  }
  async chat(text, followup = this.state.ui.followup) {
    if (!text.trim()) throw new Error('请先写下本次要求');
    if (this.activeJob) { this.state.needsConfirmation = true; await this.stop(); }
    await this.saveDraft();
    const d = await this.api(this.path('/chat'), 'POST', { text: text.trim(), document_ids: this.state.documentIds, followup, options: this.state.options });
    return this.watchOperation(d.operation_id);
  }
  async start({ confirmed = false, one = false } = {}) {
    if (this.activeJob) throw new Error('后台仍在处理当前篇，请等待收尾');
    if (this.state.needsConfirmation && !confirmed) throw new Error('请先确认更新后的安排，再继续写作');
    const errors = validateStart(this.state.options, this.platforms, this.targets); if (errors.length) throw new Error(errors.join('；'));
    await this.saveDraft();
    let d;
    try { d = await this.api(this.path(one?'/write-one':'/start'), 'POST', { options: this.state.options }); }
    catch(error) {
      if(error instanceof ApiError && error.status===0) {
        this.state.needsConfirmation=true;this.emit();let stopUnconfirmed=false;
        try { await this.stop();await this.reload(); } catch { stopUnconfirmed=true; }
        this.closeStream();
        throw new ApiError('开始请求结果未确认，已请求暂停后续；请先恢复后台状态，再明确继续。'+(stopUnconfirmed?' 暂停请求也尚未确认。':''));
      }
      throw error;
    }
    this.state.needsConfirmation = false; this.pausePromise = null;
    this.state.job = { id: d.job_id, status: 'running', planned: d.planned, total: d.total, done: 0, message: '准备写作' };
    this.state.stream = {}; this.emit(); this.attachStream(d.job_id); return d;
  }
  async stop() { const d = await this.api(this.path('/stop'), 'POST', {}); if (this.state.job) this.state.job.cancel = true; this.emit(); return d; }
  closeStream() { this.source?.close(); this.source = null; }
  attachStream(jid) {
    if (this.source?.jobId === jid) return;
    this.closeStream(); const cid = this.state.conversation?.id;
    const source = this.eventSource(`/api/jobs/${enc(jid)}/stream`); source.jobId = jid; this.source = source;
    source.onmessage = event => {
      if (this.state.conversation?.id !== cid || this.source !== source) return;
      let data; try { data = JSON.parse(event.data); } catch { this.interruptStream(new Error('收到无法识别的写作状态')); return; }
      this.state.stream = streamReducer(this.state.stream, data);
      if (data.type === 'status' && this.state.job) Object.assign(this.state.job, { message: data.message, phase: data.phase, done: data.done, planned: data.planned });
      this.emit();
      if (data.type === 'next' && data.prev) this.reload().catch(e => this.fail(e));
      if (data.type === 'end') {
        this.closeStream(); if (this.state.job) this.state.job.status = data.status;
        if (data.status === 'error' || ['interrupted', 'stopped'].includes(data.status)) this.state.error = data.error || '写作未完成，已有稿件已保留';
        this.reload().catch(e => this.fail(e));
      }
    };
    source.onerror = () => {if(this.source===source&&this.state.conversation?.id===cid)this.interruptStream(new Error('写作连接中断，当前结果尚未确认。已请求暂停后续，请恢复后台状态后再决定是否继续。'));};
  }
  async interruptStream(error) {
    if (!this.source) return; this.closeStream(); this.state.needsConfirmation = true; this.fail(error);
    try { await this.stop(); await this.reload(); } catch (e) { this.fail(new Error(`${error.message} ${e.message}`)); }
    // No automatic reconnect, re-start or replay of uncertain model calls.
  }
  async watchOperation(id) {
    if (!id) throw new Error('服务未返回操作编号');
    if (this.watchers.has(id)) return this.watchers.get(id);
    const cid = this.state.conversation?.id;
    const task = (async () => {
      for (let index = 0; index < this.operationLimit; index++) {
        if (cid !== this.state.conversation?.id) return null;
        const d = await this.api(`/api/workbench/operations/${enc(id)}`); const op = d.operation;
        if (cid !== this.state.conversation?.id) return null;
        const at = this.state.operations.findIndex(x => x.id === id);
        if (at < 0) this.state.operations.push(op); else this.state.operations[at] = op;
        this.emit();
        if (!running(op)) {
          if (op.status !== 'done') { await this.reload(); throw new Error(op.error || (op.status === 'interrupted' ? '操作中断，保留当前内容，请明确重试' : '操作已停止')); }
          this.state.results[op.kind] = { ...(op.result || {}), operation_id: id };
          await this.reload(); this.emit(); return { ...op.result, operation_id: id };
        }
        await this.delay(index < 10 ? 1500 : 4000);
      }
      await this.api(`/api/workbench/operations/${enc(id)}/stop`, 'POST', {});
      throw new Error('等待已达上限，已请求本地停止收尾；云端执行状态尚未确认，请恢复后台状态');
    })().finally(() => this.watchers.delete(id));
    this.watchers.set(id, task); return task;
  }
  async stopOperation(id) { await this.api(`/api/workbench/operations/${enc(id)}/stop`, 'POST', {}); await this.reload(); }
  article(id) { return this.state.articles.find(a => String(a.id) === String(id)); }
  assertEditable(id) { const a = this.article(id); if (!a) throw new Error('稿件不存在'); if (a.locked) throw new Error('这篇稿件正在处理，收尾后才可修改'); return a; }
  async saveArticle(id, body_md, title, expected_version, metadata={}) {
    const a = this.assertEditable(id);
    const cid=this.state.conversation.id;
    const d = await this.api(this.articlePath(id), 'PUT', { expected_version: expected_version ?? a.current_version, body_md, title,...metadata });
    if(this.state.conversation?.id===cid)this.state.articles = this.state.articles.map(x => x.id === a.id ? d.article : x);
    delete this.state.editors[`${cid}:${id}`]; this.emit(); return d.article;
  }
  async versions(id) { return this.api(this.articlePath(id, '/versions')); }
  assertSettled() { if(this.activeJob||this.state.operations.some(running))throw new Error('当前任务仍在处理，请等待收尾后再操作'); }
  async deleteArticle(id) {
    this.assertSettled();const article=this.assertEditable(id),cid=this.state.conversation.id;
    await this.api(this.articlePath(id),'DELETE',{expected_version:article.current_version});
    if(this.state.conversation?.id===cid){delete this.state.editors[`${cid}:${id}`];await this.reload();}
  }
  async cloneConversation() {
    this.assertSettled();if(this.state.dirty)await this.saveDraft();
    const d=await this.api(this.path('/clone'),'POST',{});await this.load(d.conversation.id);return d.conversation;
  }
  async deleteConversation() {
    this.assertSettled();const cid=this.state.conversation.id;
    await this.api(this.path(),'DELETE',{});if(this.state.conversation?.id!==cid)return;
    this.closeStream();clearTimeout(this.saveTimer);this.contextToken=Symbol('deleted');
    this.state.conversations=this.state.conversations.filter(c=>c.id!==cid);
    this.state.conversation=null;this.state.articles=[];this.state.documents=[];this.state.library=[];this.state.operations=[];this.state.job=null;this.state.results={};
    this.state.options=normalizeOptions({},this.targets);this.state.documentIds=[];this.state.needsConfirmation=false;this.state.dirty=false;this.state.saved=false;
    for(const key of Object.keys(this.state.editors))if(key.startsWith(cid+':'))delete this.state.editors[key];
    this.cache.activeId=null;this.cache.pending=null;this.emit();
  }
  async selectVersion(id, version_id) {
    const a = this.assertEditable(id);
    const cid=this.state.conversation.id;
    const d = await this.api(this.articlePath(id, '/select-version'), 'POST', { expected_version: a.current_version, version_id });
    if(this.state.conversation?.id===cid)this.state.articles = this.state.articles.map(x => x.id === a.id ? d.article : x); this.emit(); return d.article;
  }
  async beginArticleOperation(id, kind, payload = {}) {
    const a = this.assertEditable(id);
    const d = await this.api(this.articlePath(id, `/${kind}`), 'POST', { expected_version: a.current_version, ...payload });
    a.locked = true; this.emit();
    return d.operation_id;
  }
  async articleOperation(id,kind,payload={}) { return this.watchOperation(await this.beginArticleOperation(id,kind,payload)); }
  async compare(id, candidate) { return this.api(this.articlePath(id, `/compare?candidate_version=${enc(candidate)}`)); }
  async reviewRecord(id, payload) { this.assertEditable(id); return this.api(this.articlePath(id, '/review-record'), 'PUT', payload); }
  dispose() { clearTimeout(this.saveTimer); this.closeStream(); this.listeners.clear(); }
}
