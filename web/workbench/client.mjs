import { DEFAULT_MODEL, OPERATION_KIND, normalizeOptions, clone, running, validateStart, streamReducer } from './model.mjs';
import { localDownloadHeaders } from './download-delivery.mjs';

export const STORAGE_KEY = 'fangli.workbench.v1';
const enc = encodeURIComponent;
export class ApiError extends Error { constructor(message, status = 0) { super(message); this.status = status; } }

export class WorkbenchClient {
  constructor({ fetcher = globalThis.fetch?.bind(globalThis), storage = globalThis.localStorage,
    eventSource = url => new EventSource(url), delay = ms => new Promise(r => setTimeout(r, ms)), operationLimit = 150 } = {}) {
    this.fetcher = fetcher; this.storage = storage; this.eventSource = eventSource; this.delay = delay; this.operationLimit = operationLimit;
    this.listeners = new Set(); this.watchers = new Map(); this.saveQueue = Promise.resolve(); this.revision = 0;
    this.interviewStreams = new Map();
    try { this.cache = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}'); } catch { this.cache = {}; }
    this.pendingDrafts = { ...this.cache.pendingDrafts };
    if (this.cache.pending) this.pendingDrafts[this.cache.pending.id || '_new'] = this.cache.pending;
    const pending = this.pendingDrafts._new;
    this.state = { bootstrap: null, config: null, clients: [], conversations: [], conversation: null, batch: null, articles: [], documents: [], library: [],
      operations: [], job: null, stream: {}, options: normalizeOptions(pending?.options), documentIds: pending?.documentIds || [], availableKeywords: [],
      ui: { followup: true, sidebarWidth: 244, collapsed: false, ...this.cache.ui }, editors: this.cache.editors || {}, messageDrafts:this.cache.messageDrafts || {},
      dirty: !!pending, saved: false, error: '', needsConfirmation: this.cache.needsConfirmation || false, results: {}, busy: new Set(), loaded: false };
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.persist(); for (const fn of this.listeners) fn(this.state); }
  persist() {
    const s = this.state;
    const id = s.conversation?.id;
    const key = id || '_new';
    if (s.dirty) this.pendingDrafts[key] = { options: s.options, documentIds: s.documentIds, followup: s.ui.followup };
    else delete this.pendingDrafts[key];
    const record = { activeId: s.conversation?.id || this.cache.activeId, ui: s.ui, editors: s.editors, messageDrafts:s.messageDrafts,
      needsConfirmation: s.needsConfirmation, pendingDrafts: this.pendingDrafts };
    this.cache = record;
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(record)); } catch { /* Server remains authoritative; surface save errors separately. */ }
  }
  async api(path, method = 'GET', body, {timeoutMs = 45000, headers = {}} = {}) {
    let response;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await this.fetcher(path, { method, headers: { 'Content-Type': 'application/json', ...headers },
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
  assertBriefEditable() { if(this.state.batch?.frozen)throw new Error('本批安排已冻结，可复用为新任务调整'); }
  get keywordChoices() {
    const {availableKeywords, options, conversation, ui, batch} = this.state;
    if (batch?.frozen) return options.keywords;
    return [...new Set([...availableKeywords, ...(ui.taskKeywordChoices?.[conversation?.id || '_new'] || []), ...options.keywords])];
  }
  toggleKeyword(word, checked) {
    this.assertBriefEditable();
    const {availableKeywords, options, conversation, ui} = this.state;
    const id = conversation?.id || '_new';
    const choices = this.keywordChoices;
    const selected = new Set(options.keywords);
    if (checked) selected.add(word); else selected.delete(word);
    ui.taskKeywordChoices = {...ui.taskKeywordChoices, [id]:choices.filter(choice => !availableKeywords.includes(choice))};
    this.setOptions({keywords:choices.filter(choice => selected.has(choice))});
  }
  messageDraft(id = this.state.conversation?.id || '_new') { return this.state.messageDrafts[id]?.text || ''; }
  setMessageDraft(text, id = this.state.conversation?.id || '_new') { this.state.messageDrafts[id]={...this.state.messageDrafts[id],text,error:''};this.persist(); }
  writingTopicScope({options, documentIds} = this.state) {
    return JSON.stringify([options?.note?.trim() || '', documentIds || []]);
  }
  writingTopic(id = this.state.conversation?.id, context = this.state) {
    const topic = this.state.messageDrafts[id]?.topic;
    return topic?.scope === this.writingTopicScope(context) ? topic.text : '';
  }
  setWritingTopic(topic) {
    const id = this.state.conversation.id;
    this.state.messageDrafts[id] = {...this.state.messageDrafts[id],
      topic: topic ? {text:topic,scope:this.writingTopicScope()} : null};
    this.emit();
  }
  messageError(id = this.state.conversation?.id || '_new') { return this.state.messageDrafts[id]?.error || ''; }
  setMessageError(error, id = this.state.conversation?.id || '_new') { this.state.messageDrafts[id]={...this.state.messageDrafts[id],error};this.persist(); }
  articleDraftKey(articleId,{review_id='',base_version=''}={}) { return `${this.state.conversation?.id}:${articleId}:${base_version}:${review_id}`; }
  articleDraft(articleId,scope={}) { return this.state.ui.articleDrafts?.[this.articleDraftKey(articleId,scope)]||{}; }
  setArticleDraft(articleId,patch,scope={}) { const key=this.articleDraftKey(articleId,scope);this.state.ui.articleDrafts={...this.state.ui.articleDrafts,[key]:{...this.articleDraft(articleId,scope),...clone(patch)}};this.persist(); }
  messageContext() { const {document_ids,...options}=this.state.options;return JSON.stringify({options,documentIds:this.state.documentIds}); }
  async submitMessage({start=false,confirmed=false,one=false,chooseTopic}={}) {
    this.assertBriefEditable();
    const id=this.state.conversation?.id;if(!id)throw new Error('请先选择客户并创建任务');
    const text=this.messageDraft(id), followup=this.state.ui.followup;
    if(!start&&!text.trim())throw new ApiError('请先写下本次要求',400);
    const prepared=this.state.messageDrafts[id]?.prepared;
    if(text.trim()&&(!start||prepared?.text!==text||prepared.context!==this.messageContext())) {
      let result,failure;
      try { result=await this.chat(text,start?false:followup); }
      catch(error){failure=error;error.operationKind=OPERATION_KIND.chat;error.conversationId=id;throw error;}
      finally {
        if(this.state.conversation?.id===id){
          this.state.ui.followup=followup;
          if(start&&followup){
            try { const restored=await this.api(this.path('/draft'),'PUT',{followup});if(this.state.conversation?.id===id)this.state.conversation.followup=restored.conversation.followup; }
            catch(error){if(failure)failure.message+='；追问偏好尚未保存，请恢复后台状态';else throw error;}
          }
          this.persist();
        }
      }
      if(!result||this.state.conversation?.id!==id)return null;
      if(result.stale)throw new Error('整理期间本次安排已变化，请核对当前要求后重试');
      this.state.messageDrafts[id]={...this.state.messageDrafts[id],prepared:{text,context:this.messageContext()}};this.persist();
    }
    if(this.state.conversation?.id!==id)return null;
    if(start && await this.start({confirmed,one,chooseTopic}) === null)return null;
    if(this.state.conversation?.id!==id)return null;
    if(this.messageDraft(id)===text){
      const topic=this.writingTopic(id);
      if(topic)this.state.messageDrafts[id]={topic:this.state.messageDrafts[id].topic};
      else delete this.state.messageDrafts[id];
    }
    this.emit();return true;
  }
  setUI(patch) { const followupChanged='followup' in patch&&patch.followup!==this.state.ui.followup;Object.assign(this.state.ui, patch);if(followupChanged)this.markDirty({affectsGeneration:false});else this.emit(); }

  async boot(id, { resumeCached = true } = {}) {
    try {
      const results = await Promise.allSettled([this.api('/api/workbench/bootstrap', 'GET', undefined, {headers: localDownloadHeaders()}), this.api('/api/workbench/zip-config')]);
      if (results[0].status === 'rejected') throw results[0].reason;
      const b = results[0].value; this.state.bootstrap = b; this.state.clients = b.clients || []; this.state.conversations = b.conversations || [];
      this.state.config = results[1].status === 'fulfilled' ? results[1].value : null;
      this.state.configError = results[1].status === 'rejected' ? results[1].reason.message : '';
      this.state.model = b.settings?.model || DEFAULT_MODEL;
      if (!this.state.dirty) this.state.options = normalizeOptions({}, this.targets);
      const target = id || (resumeCached ? this.cache.activeId : null);
      if (target) await this.load(target);
      this.state.loaded = true; this.emit();
    } catch (error) { this.state.error = error.message; this.state.loaded = true; this.emit(); throw error; }
  }

  hydrate(data) {
    const s = this.state; let c = data.conversation;
    const same = s.conversation?.id === c.id;
    s.batch = data.batch || null;
    s.availableKeywords = data.available_keywords || [];
    if (s.conversation?.client_id !== c.client_id) s.library = [];
    if(s.batch?.frozen){clearTimeout(this.saveTimer);s.dirty=false;delete this.pendingDrafts[c.id];}
    const staleDraft=same&&Number(c.draft_revision??0)<Number(s.conversation.draft_revision??0);
    if(staleDraft)c={...c,...Object.fromEntries(['brief','document_ids','mode','followup','needs_confirmation','draft_revision'].map(key=>[key,s.conversation[key]]))};
    s.conversation = c; s.articles = data.articles || c.articles || []; if(!staleDraft)s.documents = data.documents || c.documents || [];
    s.job = data.job || null; s.operations = data.operations || [];
    if (!same || !s.dirty) {
      const source = c.brief || {};
      s.options = normalizeOptions(source, this.targets);
      s.documentIds = clone(c.document_ids || c.draft?.document_ids || source.document_ids || []);
      if(typeof c.followup==='boolean')s.ui.followup=c.followup;
    }
    const pending = this.pendingDrafts[c.id];
    if (pending) {
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
    this.closeStream(); this.closeInterviewStreams(); const token = this.contextToken = Symbol('conversation');
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
    this.assertBriefEditable();
    if(this.state.dirty)await this.saveDraft();
    const cid=this.state.conversation.id,token=this.contextToken;
    const task=async()=>{
      const d=await this.api(`/api/workbench/conversations/${enc(cid)}/profile`,'PUT',{name,profile});
      // This endpoint edits the task snapshot only. Permanent customer changes use /clients/{id}.
      if(this.state.conversation?.id===cid&&this.contextToken===token){
        this.state.conversation=d.conversation;this.state.options=normalizeOptions(d.conversation.brief,this.targets);
        this.state.documentIds=clone(d.conversation.document_ids);this.state.needsConfirmation=Boolean(d.conversation.needs_confirmation);
        this.state.saved=true;this.state.dirty=false;
      }
      this.emit();return d.conversation;
    };
    this.saveQueue=this.saveQueue.catch(()=>{}).then(task);return this.saveQueue;
  }
  async createConversation(clientId, options = {}, { inheritUnassigned = true } = {}) {
    if (this.state.conversation && this.state.dirty) await this.saveDraft();
    const d = await this.api('/api/workbench/conversations', 'POST', { ...options, client_id: clientId });
    const inherit = inheritUnassigned && !this.state.conversation;
    const pendingNote = inherit && this.state.dirty ? this.state.options.note : '';
    const pendingMessage = inherit ? this.messageDraft('_new') : '';
    this.state.dirty = false; this.state.results = {}; this.state.stream = {}; this.state.needsConfirmation = false;
    await this.load(d.conversation.id);
    if (inherit) { delete this.pendingDrafts._new; this.persist(); }
    if(pendingMessage){this.setMessageDraft(pendingMessage,d.conversation.id);delete this.state.messageDrafts._new;this.persist();}
    if(pendingNote){this.setOptions({note:[this.state.options.note,pendingNote].filter(Boolean).join('\n')});await this.saveDraft();}
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
  setOptions(patch) { this.assertBriefEditable();this.state.options = { ...this.state.options, ...clone(patch) }; this.markDirty(); }
  selectDocuments(ids) { this.assertBriefEditable();this.state.documentIds = [...new Set(ids)].map(id => this.state.library.find(d=>String(d.id)===String(id))?.id ?? id);this.state.options.document_ids=clone(this.state.documentIds); this.markDirty(); }
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
        this.state.dirty = false; this.state.saved = true;
        this.state.conversation=d.conversation;this.state.options=normalizeOptions(d.conversation.brief,this.targets);
        this.state.documentIds=clone(d.conversation.document_ids);this.state.needsConfirmation=Boolean(d.conversation.needs_confirmation)||this.state.needsConfirmation;
        const listed = this.state.conversations.findIndex(task => task.id === cid);
        if (listed >= 0) this.state.conversations[listed] = d.conversation;
        this.emit();
      }
      return d;
    };
    this.saveQueue = this.saveQueue.catch(() => {}).then(task); return this.saveQueue;
  }
  async addDocument(document) {
    this.assertBriefEditable();
    const cid = this.state.conversation?.client_id; if (!cid) throw new Error('请先选择客户');
    const conversationId = this.state.conversation.id;
    const d = await this.api(`/api/workbench/clients/${enc(cid)}/documents`, 'POST', document);
    if (!d.document || d.outcome === 'needs_resolution') throw new Error('资料需要明确选择更新或另存，请在客户资料中处理');
    if (d.is_current === false || d.document.is_current === false) throw new Error('原件属于历史修订，请在客户资料中选择当前版本；当前任务选择未改变');
    if (d.outcome === 'pending' || ['pending','error','failed'].includes(d.document.status)) throw new Error(d.document.error || '原件已保存，解析待处理；当前任务的资料选择未改变');
    if (this.state.conversation?.id !== conversationId) return d.document;
    if (!this.state.library.some(x => x.id === d.document.id)) this.state.library.push(d.document);
    if (!this.state.documents.some(x => x.id === d.document.id)) this.state.documents.push(d.document);
    this.selectDocuments([...this.state.documentIds, d.document.id]); await this.saveDraft(); return d.document;
  }
  async reviseDocument(id,text) {
    this.assertBriefEditable();
    const source=[...this.state.library,...this.state.documents].find(d=>String(d.id)===String(id));if(!source)throw new Error('资料不存在');
    if(text.trim().length<10)throw new Error('资料至少需要 10 个字，请核对解析结果');
    const cid=this.state.conversation?.client_id,conversationId=this.state.conversation?.id;
    const d=await this.api(`/api/workbench/clients/${enc(cid)}/documents`,'POST',{filename:source.filename,kind:source.kind,text:text.trim(),update_document_id:source.id});
    if (!d.document || d.outcome === 'needs_resolution' || d.outcome === 'pending') throw new Error('资料修订未成为有效版本，原选择已保留');
    if(this.state.conversation?.id!==conversationId)return d.document;
    const revision = d.document;
    this.state.library = this.state.library.filter(item => item.id !== revision.id && (!revision.group_id || item.group_id !== revision.group_id));
    this.state.library.push(revision);
    if (!this.state.documentIds.some(value=>String(value)===String(id))) { this.emit(); return revision; }
    this.selectDocuments(this.state.documentIds.map(value=>String(value)===String(id)?d.document.id:value));
    const docs=new Map([...this.state.documents,...this.state.library].map(item=>[String(item.id),item]));
    this.state.documents=this.state.documentIds.map(value=>docs.get(String(value))).filter(Boolean);
    await this.saveDraft();return d.document;
  }
  async chat(text, followup = this.state.ui.followup) {
    this.assertBriefEditable();
    if (!text.trim()) throw new Error('请先写下本次要求');
    if (this.activeJob) { this.state.needsConfirmation = true; await this.stop(); }
    await this.saveDraft();
    const d = await this.api(this.path('/chat'), 'POST', { text: text.trim(), document_ids: this.state.documentIds, followup, options: this.state.options });
    return this.watchInterview(d.operation_id);
  }
  async pickWritingTopic(chooseTopic) {
    this.assertBriefEditable();
    this.assertSettled();
    const id = this.state.conversation?.id, path = this.path('/topics');
    await this.saveDraft();
    if (this.state.conversation?.id !== id) return null;
    const context = this.messageContext();
    const topic = await chooseTopic(async (seen,count)=>(await this.api(path,'POST',{seen,count})).topics);
    if (!topic || this.state.conversation?.id !== id) return null;
    if (context !== this.messageContext()) throw new Error('本次资料或安排已变化，请重新选题');
    return topic;
  }
  async start({ confirmed = false, one = false, chooseTopic } = {}) {
    this.assertBriefEditable();
    if (this.activeJob) throw new Error('后台仍在处理当前篇，请等待收尾');
    if (this.state.needsConfirmation && !confirmed) throw new Error('请先确认更新后的安排，再继续写作');
    const errors = validateStart(this.state.options, this.platforms, this.targets); if (errors.length) throw new ApiError(errors.join('；'),400);
    const id = this.state.conversation?.id;
    const path = this.path();
    const picked = this.writingTopic(id);
    let topic = picked;
    if (!topic && chooseTopic) {
      topic = await this.pickWritingTopic(chooseTopic);
      if (!topic) return null;
    } else await this.saveDraft();
    if (this.state.conversation?.id !== id) return null;
    const options = topic ? {...this.state.options,topic} : this.state.options;
    let d;
    try { d = await this.api(path + (one?'/write-one':'/start'), 'POST', { options }); }
    catch(error) {
      if(this.state.conversation?.id!==id)throw error;
      if(error instanceof ApiError && error.status===0) {
        this.state.needsConfirmation=true;this.emit();let stopUnconfirmed=false;
        try { await this.stop();await this.reload(); } catch { stopUnconfirmed=true; }
        this.closeStream();
        throw new ApiError('开始请求结果未确认，已请求暂停后续；请先恢复后台状态，再明确继续。'+(stopUnconfirmed?' 暂停请求也尚未确认。':''));
      }
      throw error;
    }
    if (this.state.conversation?.id !== id) return null;
    if (picked && this.writingTopic(id) === picked) delete this.state.messageDrafts[id].topic;
    if (d.title) {
      const task = this.state.conversation = {...this.state.conversation, title:d.title, status:'running'};
      const listed = this.state.conversations.findIndex(row => row.id === id);
      if (listed >= 0) this.state.conversations[listed] = task;
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
  recordOperation(op) {
    const at=this.state.operations.findIndex(row=>row.id===op.id);
    if(at<0)this.state.operations.push(op);else this.state.operations[at]=op;
    this.emit();
  }
  async finishOperation(op,cid,id) {
    if(cid!==this.state.conversation?.id)return null;
    if(op.status!=='done') {
      await this.reload();
      if(cid!==this.state.conversation?.id)return null;
      const status=op.result?.error_status||(op.kind===OPERATION_KIND.chat&&/^(需求整理|追问格式|追问选项)/.test(op.error||'')?400:0);
      const error=new ApiError(op.error||(op.status==='interrupted'?'操作中断，保留当前内容，请明确重试':'操作已停止'),status);
      error.operationKind=op.kind;error.conversationId=cid;throw error;
    }
    this.state.results[op.kind]={...(op.result||{}),operation_id:id};
    await this.reload();
    if(cid!==this.state.conversation?.id)return null;
    this.emit();return {...op.result,operation_id:id};
  }
  closeInterviewStreams() {
    for(const stream of this.interviewStreams.values())stream.finish(null);
    this.interviewStreams.clear();
  }
  watchInterview(id) {
    if(!id)return Promise.reject(new Error('服务未返回操作编号'));
    if(this.watchers.has(id))return this.watchers.get(id);
    const cid=this.state.conversation?.id;
    let source,settled=false,disconnecting=false;
    const valid=op=>op?.id===id&&op.kind===OPERATION_KIND.chat&&op.conversation_id===cid;
    const task=new Promise((resolve,reject)=>{
      const close=()=>{source?.close();this.interviewStreams.delete(id);};
      const finish=value=>{if(settled)return;settled=true;close();resolve(value);};
      const fail=error=>{if(settled)return;settled=true;close();if(cid!==this.state.conversation?.id)resolve(null);else reject(error);};
      const terminal=async op=>{
        if(settled)return;settled=true;close();
        try{resolve(await this.finishOperation(op,cid,id));}catch(error){if(cid!==this.state.conversation?.id)resolve(null);else reject(error);}
      };
      const lost=async()=>{
        if(settled||disconnecting)return;
        disconnecting=true;source?.close();
        try {
          const d=await this.api(`/api/workbench/operations/${enc(id)}`);
          if(settled)return;
          if(cid!==this.state.conversation?.id){finish(null);return;}
          if(valid(d.operation)) {
            this.recordOperation({...d.operation,stream_disconnected:running(d.operation)});
            if(!running(d.operation)){await terminal(d.operation);return;}
          }
        }catch{ /* A disconnected stream never replays the model request. */ }
        const current=this.state.operations.find(op=>op.id===id);
        if(current&&cid===this.state.conversation?.id)this.recordOperation({...current,stream_disconnected:true});
        fail(new ApiError('回复连接中断，输入与已收到的回复已保留；请恢复后台状态或停止回复'));
      };
      this.interviewStreams.set(id,{finish});
      if(!this.state.operations.some(op=>op.id===id))this.recordOperation({id,kind:OPERATION_KIND.chat,conversation_id:cid,status:'running',result:{},created_at:new Date().toISOString()});
      try {source=this.eventSource(`/api/workbench/operations/${enc(id)}/stream`);}
      catch(error){fail(error);return;}
      source.onmessage=event=>{
        if(settled||disconnecting)return;
        if(cid!==this.state.conversation?.id){finish(null);return;}
        let op;
        try {op=JSON.parse(event.data).operation;if(!valid(op))throw new Error('回复状态不匹配');}
        catch {lost();return;}
        this.recordOperation(op);
        if(!running(op))terminal(op);
      };
      source.onerror=lost;
    }).finally(()=>this.watchers.delete(id));
    this.watchers.set(id,task);return task;
  }
  async watchOperation(id) {
    if (!id) throw new Error('服务未返回操作编号');
    if(this.state.operations.find(op=>op.id===id)?.kind===OPERATION_KIND.chat)return this.watchInterview(id);
    if (this.watchers.has(id)) return this.watchers.get(id);
    const cid = this.state.conversation?.id;
    const task = (async () => {
      for (let index = 0; index < this.operationLimit; index++) {
        if (cid !== this.state.conversation?.id) return null;
        const d = await this.api(`/api/workbench/operations/${enc(id)}`); const op = d.operation;
        if (cid !== this.state.conversation?.id) return null;
        this.recordOperation(op);
        if (!running(op)) {
          return this.finishOperation(op,cid,id);
        }
        await this.delay(index < 10 ? 1500 : 4000);
      }
      await this.api(`/api/workbench/operations/${enc(id)}/stop`, 'POST', {});
      throw new Error('等待已达上限，已请求本地停止收尾；云端执行状态尚未确认，请恢复后台状态');
    })().finally(() => this.watchers.delete(id));
    this.watchers.set(id, task); return task;
  }
  async stopOperation(id) { await this.api(`/api/workbench/operations/${enc(id)}/stop`, 'POST', {}); await this.reload(); this.resumeBackground(); }
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
  async setTaskState(id, field, enabled) {
    if (field === 'archived' && enabled && this.state.conversation?.id === id && this.state.dirty) await this.saveDraft();
    const {task} = await this.api(`/api/workbench/conversations/${enc(id)}/task-state`,'PUT',{[field]:enabled});
    const listed = this.state.conversations.find(value => value.id === id);
    if (listed) Object.assign(listed, task);
    if (this.state.conversation?.id === id) Object.assign(this.state.conversation, task);
    this.emit();
    return task;
  }
  assertSettled() { if(this.activeJob||this.state.operations.some(running))throw new Error('当前任务仍在处理，请等待收尾后再操作'); }
  async deleteArticle(id) {
    this.assertSettled();const article=this.assertEditable(id),cid=this.state.conversation.id;
    await this.api(this.articlePath(id),'DELETE',{expected_version:article.current_version});
    if(this.state.conversation?.id===cid){delete this.state.editors[`${cid}:${id}`];await this.reload();}
  }
  async cloneConversation(id = this.state.conversation?.id) {
    const current = id === this.state.conversation?.id;
    if (current) this.assertSettled();
    else if (this.state.dirty && this.state.conversation) await this.saveDraft();
    const pending=current&&this.state.dirty?{options:clone(this.state.options),documentIds:clone(this.state.documentIds),followup:this.state.ui.followup}:null;
    const d=await this.api(`/api/workbench/conversations/${enc(id)}/clone`,'POST',{});
    // A batch task is frozen. Explicit reuse applies any local changes to the new ordinary task only.
    this.state.dirty=false;await this.load(d.conversation.id);
    if (pending) { delete this.pendingDrafts[id]; this.persist(); }
    if(pending){this.state.options=pending.options;this.state.documentIds=pending.documentIds;this.state.ui.followup=pending.followup;this.markDirty();await this.saveDraft();}
    return d.conversation;
  }
  async deleteConversation() {
    this.assertSettled();const cid=this.state.conversation.id;
    await this.api(this.path(),'DELETE',{});if(this.state.conversation?.id!==cid)return;
    this.closeStream();clearTimeout(this.saveTimer);this.contextToken=Symbol('deleted');
    this.state.conversations=this.state.conversations.filter(c=>c.id!==cid);
    this.state.conversation=null;this.state.batch=null;this.state.articles=[];this.state.documents=[];this.state.library=[];this.state.operations=[];this.state.job=null;this.state.results={};
    this.state.options=normalizeOptions({},this.targets);this.state.documentIds=[];this.state.needsConfirmation=false;this.state.dirty=false;this.state.saved=false;
    for(const key of Object.keys(this.state.editors))if(key.startsWith(cid+':'))delete this.state.editors[key];
    this.cache.activeId=null;delete this.pendingDrafts[cid];this.emit();
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
  dispose() { clearTimeout(this.saveTimer); this.closeStream(); this.closeInterviewStreams(); this.listeners.clear(); }
}
