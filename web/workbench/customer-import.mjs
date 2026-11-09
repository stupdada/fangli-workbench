import { CustomerIntake, renderIntake } from './customer-intake.mjs';
import { originalPayload, recognitionExtensions, recognizesFile } from './customers-client.mjs';
import { RecognitionReview } from './customer-recognition.mjs';
import { enabled, escapeHTML as e, setCount } from './model.mjs';
import { planOptions } from './customer-platforms.mjs';
import { parseFile } from './files.mjs';
import { readBrowserDraft, writeBrowserDraft } from './browser-draft.mjs';
import { randomUUID } from './browser-crypto.mjs';

export const customerFileTypes = ['.docx','.xlsx','.pptx','.txt','.md','.csv','.tsv','.json','.html',...recognitionExtensions].join(',');
const pendingRecognition = doc => doc.status === 'pending' && doc.has_recognition;
const usableText = doc => doc.status === 'ready' && !!doc.text?.trim();
const platformDraftKey = id => `fangli.import-platforms.${id}`;
const importDraftKey = 'fangli.customer-import.draft.v1';
const fileInfo = ({name,size,lastModified}) => ({name,size,lastModified});
const fileKey = file => JSON.stringify(fileInfo(file));
const articleCounts = Array.from({length:21}, (_, index) => index);
const accounts = {personal:'个人号', official:'企业号'};

function defaultCounts(platform, count = 1) {
  return platform?.account_type === 'official' ? {personal:0,official:count} : {personal:count,official:0};
}

function readPlatformDraft(id, platforms) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(platformDraftKey(id)) || '{}');
    const entries = Array.isArray(saved) ? saved.filter(id => typeof id === 'string').map(id => [id,1]) : Object.entries(saved);
    const savedCounts = new Map(entries);
    const counts = {};
    for (const platform of platforms.filter(enabled)) {
      const id = String(platform.id);
      const value = savedCounts.get(id);
      if (value > 0 && articleCounts.includes(value)) {
        counts[id] = defaultCounts(platform,value);
      } else if (articleCounts.includes(value?.personal) && articleCounts.includes(value?.official)) {
        counts[id] = value;
      }
    }
    return counts;
  } catch { return {}; }
}

function selectionKeys(selections) {
  return selections.map(({platform_id,account_type,count}) => `${platform_id}:${account_type}:${count}`).sort().join(',');
}

export class CustomerImport {
  constructor(service, onCustomer, getPlatforms) {
    Object.assign(this,{service,onCustomer,getPlatforms});
    this.intake = new CustomerIntake(service, () => this.showReview());
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'customer-dialog customer-import-dialog';
    this.dialog.setAttribute('aria-labelledby','customer-import-title');
    this.dialog.innerHTML = '<form novalidate><header><h2 id="customer-import-title">新建客户</h2><button type="button" class="icon-button" data-close aria-label="关闭窗口">×</button></header><p class="helper" data-draft-status role="status" hidden></p><p class="helper" data-import-progress role="status"></p><progress class="customer-progress" data-import-progress-bar aria-label="资料处理进度" hidden></progress><div data-import-body></div><p class="error-text" role="alert"></p><footer><button type="button" class="button quiet" data-drafts hidden>继续导入草稿</button><button type="button" class="button quiet" data-discard-local hidden>放弃本地草稿</button><button type="button" class="button outline" data-pause-recognition hidden>当前页完成后暂停</button><button type="button" class="button quiet" data-close>关闭</button><button class="button primary" type="submit"></button></footer></form>';
    document.body.append(this.dialog);
    this.form = this.dialog.querySelector('form');
    this.body = this.form.querySelector('[data-import-body]');
    this.submit = this.form.querySelector('[type=submit]');
    this.draftsButton = this.form.querySelector('[data-drafts]');
    this.draftStatus = this.form.querySelector('[data-draft-status]');
    this.discard = this.form.querySelector('[data-discard-local]');
    this.closeButton = this.form.querySelector('footer [data-close]');
    this.error = this.form.querySelector('[role=alert]');
    this.progress = this.form.querySelector('[data-import-progress]');
    this.progressBar = this.form.querySelector('[data-import-progress-bar]');
    this.pause = this.form.querySelector('[data-pause-recognition]');
    this.pause.onclick = () => {
      this.pause.disabled = this.pauseRequested = true;
      this.progress.textContent = '当前页完成后暂停，已识别的页面会留在草稿中。';
    };
    this.form.onsubmit = event => {
      event.preventDefault();
      if (this.busy) return;
      if (this.flow.missingFiles.length && !this.flow.needsRestore && !this.flow.saved) this.form.elements.files.click();
      else this.run(() => this.advance());
    };
    this.dialog.addEventListener('click',event => this.click(event));
    this.dialog.addEventListener('input',event => {
      const {name,value,dataset} = event.target;
      if (dataset.intakeField && this.intake.draft) {
        this.intake.change(dataset.intakeField,value);
        this.body.querySelector('.intake-save-state').textContent = this.intake.message;
        this.rememberReview();
      } else if (this.flow.stage === 'files') {
        if (name === 'name' || name === 'text') {
          this.flow[name] = value;
          this.rememberDraft();
        }
        if (name === 'import_platform' || name === 'import_platform_count') {
          this.updatePlatformChoice(event.target);
          return;
        }
        this.showSelection();
      }
    });
    this.dialog.addEventListener('cancel',event => { event.preventDefault(); this.closeDraft(); });
    this.dialog.addEventListener('close',() => this.intake.stop());
  }

  open(onComplete, {forTask = false,draft = null} = {}) {
    if (this.dialog.open) return;
    const key = draft ? `${importDraftKey}.${draft.id}` : importDraftKey;
    const saved = readBrowserDraft(key);
    this.initFlow({onComplete,forTask,key,draft,saved});
    this.error.textContent = '';
    this.showDraftStatus(saved ? '已恢复本地草稿。' : '');
    this.showFiles();
    this.dialog.showModal();
    if (draft) this.run(() => this.resumeDraft(draft));
    else if (saved?.serverAttempted) this.run(() => this.restoreServerDraft());
    else this.checkDrafts(this.flow);
  }

  initFlow({onComplete,forTask,key,draft = null,saved = null}) {
    this.flow = {
      id: draft?.id || saved?.id || randomUUID(),
      taskId: forTask ? saved?.taskId || randomUUID() : null,
      files: [], missingFiles: saved?.files || [], documents: [],
      name: saved?.name ?? draft?.name ?? '', text: saved?.text ?? '', hasDrafts: false,
      platformCounts: saved?.platformCounts ?? (draft ? readPlatformDraft(draft.id,this.getPlatforms()) : {}),
      onComplete,forTask,key,customer:draft,serverAttempted: Boolean(draft || saved?.serverAttempted),
      documentIds: saved?.documentIds, reviewDraft: saved?.reviewDraft, restored: Boolean(saved),
      needsRestore: Boolean(saved?.serverAttempted && !draft),
    };
    this.intake.switchClient(this.flow.id);
    this.dialog.querySelector('h2').textContent = draft || saved ? '继续导入草稿' : '新建客户';
  }

  showDraftStatus(message) {
    this.draftStatus.textContent = message;
    this.draftStatus.hidden = !message;
  }

  hasDraft() {
    const {name,text,files,missingFiles,platformCounts,serverAttempted} = this.flow;
    return Boolean(name || text || files.length || missingFiles.length || Object.keys(platformCounts).length || serverAttempted);
  }

  rememberDraft() {
    const {id,taskId,name,text,platformCounts,files,missingFiles,serverAttempted,documentIds,reviewDraft,key} = this.flow;
    const exists = this.hasDraft();
    const saved = writeBrowserDraft(key, exists ? {
      id,taskId,name,text,platformCounts,serverAttempted,documentIds,reviewDraft,
      files: [...missingFiles,...files.map(fileInfo)],
    } : null);
    this.closeButton.textContent = exists ? '保存草稿并退出' : '关闭';
    if (!saved) this.showDraftStatus('本地草稿未能保存，请先保留此窗口。');
    return saved;
  }

  closeDraft() {
    if (this.busy || (this.hasDraft() && !this.rememberDraft())) return;
    this.dialog.close();
  }

  async restoreServerDraft() {
    let record;
    try { record = await this.service.client(this.flow.id); }
    catch (error) {
      if (error.status !== 404) throw error;
      this.flow.serverAttempted = false;
      this.flow.needsRestore = false;
      this.rememberDraft();
      this.showSelection();
      return this.checkDrafts(this.flow);
    }
    this.flow.needsRestore = false;
    if (record.import_draft) return this.resumeDraft(record);
    this.flow.saved = record;
    this.showSavedCustomer();
  }

  async checkDrafts(flow) {
    try {
      const drafts = await this.service.importDrafts();
      if (this.flow !== flow || !this.dialog.open || flow.customer) return;
      flow.hasDrafts = drafts.length > 0;
      this.draftsButton.hidden = !flow.hasDrafts || flow.stage !== 'files' || this.hasDraft();
    } catch {
      // The new customer form remains usable while the draft list is unavailable.
    }
  }

  async resumeDraft(draft) {
      if (draft.id !== this.flow.id) {
        const {onComplete,forTask,key} = this.flow;
        this.initFlow({onComplete,forTask,key,draft});
      }
      this.flow.customer = draft;
      this.flow.serverAttempted = true;
      this.rememberDraft();
      this.intake.switchClient(draft.id);
      this.dialog.querySelector('h2').textContent='继续导入草稿';
      this.showFiles();
      await this.refreshDocuments();
      if (this.flow.text.trim() || this.flow.missingFiles.length ||
          this.flow.documents.some(doc => doc.status === 'pending') || !this.flow.documents.some(usableText)) return;
      await this.intake.load(draft.id);
      const record = this.intake.record;
      const sources = this.flow.documents.filter(usableText);
      if (record && record.sources.length === sources.length &&
          sources.every(doc => record.sources.some(source => source.id === doc.id))) {
        this.flow.documentIds = record.sources.map(doc => doc.id);
        this.flow.stage = 'review';
        this.showReview();
        if (record.status === 'running') this.intake.watch(60);
      }
  }

  async showDrafts() {
    const drafts=await this.service.importDrafts();
    this.flow.hasDrafts=drafts.length > 0;
    this.flow.stage='drafts';
    this.draftsButton.hidden=true;
    this.submit.hidden=true;
    this.body.innerHTML='<button type="button" class="button quiet" data-back>返回新建客户</button>' +
      (drafts.map(d=>`<div class="customer-document"><span>${e(d.name||'未命名导入')}<small> · ${d.document_count} 份资料</small></span><button type="button" class="button outline" data-resume="${e(d.id)}">继续导入</button></div>`).join('') || '<p class="empty">暂无待确认的导入。</p>');
    this.flow.drafts=drafts;
  }

  updatePlatformChoice(control) {
    const {flow} = this;
    if (control.name === 'import_platform') {
      const id = control.value;
      const row = this.body.querySelector(`[data-import-platform-row="${CSS.escape(id)}"]`);
      const fields = [...row.querySelectorAll('select')];
      row.hidden = !control.checked;
      if (control.checked) {
        flow.platformCounts[id] = Object.fromEntries(fields.map(field => [field.dataset.account,Number(field.value)]));
      } else {
        delete flow.platformCounts[id];
        for (const field of fields) field.value = field.dataset.defaultCount;
      }
    } else {
      const id = control.closest('[data-import-platform-row]').dataset.importPlatformRow;
      flow.platformCounts[id][control.dataset.account] = Number(control.value);
    }
    try { sessionStorage.setItem(platformDraftKey(flow.id),JSON.stringify(flow.platformCounts)); } catch {}
    this.rememberDraft();
    this.showSelection();
  }

  showFiles() {
    const flow = this.flow;
    flow.stage = 'files';
    const platforms = this.getPlatforms().filter(enabled);
    this.discard.hidden = !flow.restored || flow.key !== importDraftKey;
    this.body.innerHTML = `<label class="field"><span>客户 / 项目名称</span><input type="text" name="name" maxlength="100" value="${e(flow.name)}" ${flow.customer ? 'readonly' : ''} placeholder="可从资料识别"></label>
      <section class="customer-import-materials" aria-labelledby="customer-import-materials-title">
        <h3 id="customer-import-materials-title">客户资料</h3>
        <div class="customer-import-drop">
          <label class="customer-import-upload"><input class="sr-only" type="file" name="files" accept="${customerFileTypes}" multiple><span>点击上传或拖入文件</span></label>
          <div class="inline-actions" data-import-selection hidden><p data-import-files role="status"></p><button type="button" class="button quiet" data-clear-files>清除待上传文件</button></div>
        </div>
        <label class="field"><span>粘贴资料</span><textarea name="text" rows="3">${e(flow.text)}</textarea></label>
        <div data-import-documents></div>
      </section>
      <fieldset class="customer-import-platforms" ${platforms.length ? '' : 'hidden'}>
        <legend>发布平台<span>可选</span></legend>
        <div class="inline-actions">${platforms.map(({id,name}) => `<label class="keyword-choice">
          <input type="checkbox" name="import_platform" value="${e(id)}" ${Object.hasOwn(flow.platformCounts,id)?'checked':''}><span>${e(name)}</span>
        </label>`).join('')}</div>
        ${platforms.map(platform => {
          const {id,name} = platform;
          const defaults = defaultCounts(platform);
          const counts = flow.platformCounts[id] || defaults;
          return `<div class="customer-import-platform-choice" data-import-platform-row="${e(id)}" ${Object.hasOwn(flow.platformCounts,id)?'':'hidden'}>
            <strong>${e(name)}</strong>
            <div class="inline-actions">${Object.entries(accounts).map(([account,label]) => `<label class="customer-import-platform-count">
              <span>${label}</span><select name="import_platform_count" data-account="${account}" data-default-count="${defaults[account]}" aria-label="${e(name)}${label}篇数">
                ${articleCounts.map(value => `<option value="${value}" ${value===counts[account]?'selected':''}>${value ? `${value} 篇` : '不安排'}</option>`).join('')}
              </select>
            </label>`).join('')}</div>
          </div>`;
        }).join('')}
      </fieldset>`;
    const add = files => {
      flow.files = [...new Map([...flow.files,...files].map(file=>[fileKey(file),file])).values()];
      const picked = new Set(flow.files.map(fileKey));
      flow.missingFiles = flow.missingFiles.filter(file=>!picked.has(fileKey(file)));
      this.rememberDraft();
      this.showSelection();
    };
    this.form.elements.files.onchange = event => add(event.target.files);
    const drop = this.body.querySelector('.customer-import-drop');
    drop.ondragover = event => { event.preventDefault(); event.stopPropagation(); };
    drop.ondrop = event => { event.preventDefault(); event.stopPropagation(); if (!this.busy) add(event.dataTransfer.files); };
    this.showSelection();
  }

  showSelection() {
    const flow = this.flow;
    const ready = flow.files.map(file=>file.name).join('、');
    const missing = flow.missingFiles.map(file=>file.name).join('、');
    this.body.querySelector('[data-import-files]').textContent = [ready,missing ? `请重新选择未上传的文件：${missing}` : ''].filter(Boolean).join('。');
    this.body.querySelector('[data-import-selection]').hidden = !ready && !missing;
    this.draftsButton.hidden = !flow.hasDrafts || this.hasDraft();
    this.closeButton.textContent = this.hasDraft() ? '保存草稿并退出' : '关闭';
    if (flow.needsRestore) this.submit.textContent = '读取导入草稿';
    else if (missing) this.submit.textContent = '重新选择文件';
    else if (flow.files.length || flow.text.trim()) this.submit.textContent = '识别资料';
    else if (flow.documents.some(pendingRecognition)) this.submit.textContent = '核对识别文字';
    else if (flow.documents.some(usableText)) this.submit.textContent = '整理客户档案';
    else this.submit.textContent = flow.forTask ? '保存并继续创作' : '保存客户';
    this.submit.hidden = false;
  }

  async refreshDocuments() {
    const groups = new Map();
    for (const doc of await this.service.documents(this.flow.id)) {
      if (!groups.has(doc.group_id) || doc.revision > groups.get(doc.group_id).revision) groups.set(doc.group_id,doc);
    }
    this.flow.documents = [...groups.values()];
    const assetsOnly = this.flow.documents.length > 0 && this.flow.documents.every(doc => doc.status === 'ready' && !usableText(doc));
    this.form.elements.name.readOnly = !!this.flow.customer && !assetsOnly;
    if (assetsOnly) this.form.elements.name.placeholder = '请填写客户名称';
    this.showSelection();
    this.body.querySelector('[data-import-documents]').innerHTML = this.flow.documents.map(doc => `<div class="customer-document"><span>${e(doc.filename)}
      <small>${pendingRecognition(doc) ? '识别文字待确认' : doc.status === 'pending' ? e(doc.error || '待解析') : usableText(doc) ? '已保存正文' : '已保留原件和图片'}</small></span><div>
      ${pendingRecognition(doc) ? `<button type="button" class="button outline" data-recognition="${e(doc.id)}">核对文字</button>` : doc.status === 'pending' ? `<button type="button" class="button quiet" data-retry="${e(doc.id)}">重试解析</button><button type="button" class="button quiet" data-retry-text="${e(doc.id)}">补录正文</button>` : ''}
      <button type="button" class="button quiet" data-remove="${e(doc.id)}">移出草稿</button></div></div>`).join('');
  }

  async openRecognition(doc) {
    const report = await this.service.recognition(this.flow.id,doc.id);
    this.flow.recognition = new RecognitionReview(this.service,this.flow.id,doc,report);
    this.flow.stage = 'recognition';
    this.showRecognition();
    await this.processRecognition();
  }

  canOrganizeAfterRecognition(currentDocumentId) {
    const {files, missingFiles, text, documents} = this.flow;
    return !files.length && !missingFiles.length && !text.trim() &&
      !documents.some(doc => doc.status === 'pending' && doc.id !== currentDocumentId);
  }

  showRecognition() {
    const review = this.flow.recognition;
    const canContinue = review.report.pages.length > 0 && !review.waiting.length &&
      this.canOrganizeAfterRecognition(review.doc.id);
    this.body.innerHTML = `<button type="button" class="button quiet" data-back>返回资料</button>
      <div class="recognition-heading"><h3>核对识别文字</h3><p>${e(review.doc.filename)}</p>
      ${canContinue ? '<p class="helper">确认后，有正文的资料会接着用来整理客户档案。</p>' : ''}</div>${review.markup()}`;
    review.bind(this.body,page => this.run(async () => {
      this.setProgress(`正在重新识别第 ${page} 页…`);
      await review.retry(page);
      this.showRecognition();
    }));
    this.submit.hidden = false;
    this.submit.textContent = !review.report.pages.length ? '重新读取原件' : review.waiting.length ? '继续识别' :
      canContinue ? '确认并继续' : '确认本文件';
  }

  async processRecognition() {
    const review = this.flow.recognition;
    if (!review.waiting.length) return;
    this.pauseRequested = false;
    this.pause.disabled = this.pause.hidden = false;
    try {
      await review.processWaiting((done,total) => {
        const phase = this.pauseRequested ? '正在暂停' : '正在识别文字';
        this.setProgress(`${phase} · 已处理 ${done} / ${total} 页`, done, total);
      }, () => this.pauseRequested);
    } finally {
      this.pause.hidden = true;
      this.showRecognition();
    }
  }

  rememberReview() {
    this.flow.reviewDraft = {key:this.intake.key,value:this.intake.draft};
    this.rememberDraft();
  }

  showReview() {
    if (!this.dialog.open || !this.intake.record || this.flow.stage !== 'review') return;
    const {record,message,key} = this.intake;
    if (record.status === 'ready' && this.flow.reviewKey !== key) {
      this.flow.reviewKey = key;
      try {
        const saved = this.flow.reviewDraft?.key === key ? this.flow.reviewDraft.value :
          JSON.parse(sessionStorage.getItem(`fangli.import.${key}`) || 'null');
        if (saved) { this.intake.draft = saved; this.intake.drafts.set(key,saved); }
      } catch {}
    }
    this.body.innerHTML = `<button type="button" class="button quiet" data-back>返回资料</button>${renderIntake(record,this.intake.draft,{message,compact:true,statusUnavailable:this.intake.statusUnavailable})}`;
    this.submit.hidden = record.status !== 'ready';
    this.submit.textContent = this.flow.forTask ? '确认并继续创作' : '确认保存';
  }

  click(event) {
    const button = event.target.closest('button');
    if (!button) return;
    const data = button.dataset;
    if ('close' in data) { this.closeDraft(); return; }
    if ('discardLocal' in data && !this.busy) {
      const {onComplete,forTask,key} = this.flow;
      if (!writeBrowserDraft(key,null)) return this.showDraftStatus('本地草稿未能清除，请重试。');
      this.initFlow({onComplete,forTask,key:importDraftKey});
      this.showDraftStatus('');
      this.showFiles();
      this.checkDrafts(this.flow);
      return;
    }
    if ('back' in data) { this.intake.stop(); this.showFiles(); if(this.flow.customer)this.run(()=>this.refreshDocuments()); return; }
    if ('clearFiles' in data) {
      this.flow.files = [];
      this.flow.missingFiles = [];
      this.form.elements.files.value = '';
      this.rememberDraft();
      this.showSelection();
      return;
    }
    if ('drafts' in data) { this.run(()=>this.showDrafts()); return; }
    if (data.resume) { this.run(()=>this.resumeDraft(this.flow.drafts.find(d=>d.id===data.resume))); return; }
    if (data.recognition) { this.run(() => this.openRecognition(this.flow.documents.find(doc => doc.id === data.recognition))); return; }
    if (data.remove) this.run(async () => {
      await this.service.removeDocument(this.flow.id,data.remove);
      await this.refreshDocuments();
    });
    if (data.retry) this.run(()=>this.retry(data.retry));
    if (data.retryText) {
      const row = button.closest('.customer-document');
      if (row.nextElementSibling?.hasAttribute('data-import-text-editor')) return;
      const editor = document.createElement('div');
      editor.dataset.importTextEditor = '';
      editor.innerHTML = '<label class="field"><span>经核对的正文</span><textarea rows="4" maxlength="200000"></textarea></label><button type="button" class="button outline">保存解析正文</button>';
      row.after(editor);
      const text = editor.querySelector('textarea');
      editor.querySelector('button').onclick = ()=>this.run(()=>this.retry(data.retryText,text.value));
      text.focus();
    }
    if (!data.customerAction) return;
    event.stopPropagation();
    if (data.customerAction === 'intake-use-field') { this.intake.useField(data.field); this.rememberReview(); }
    if (data.customerAction === 'intake-refresh') this.run(()=>this.intake.refresh({resume:true}));
    if (data.customerAction === 'intake-retry') this.run(()=>this.intake.start(this.flow.id,this.flow.documentIds,true));
  }

  async retry(id,text) {
    const doc = this.flow.documents.find(item=>item.id===id);
    if (text === undefined && doc?.has_original && /\.pdf$/i.test(doc.filename)) {
      const response = await fetch(doc.original_url);
      if (!response.ok) throw new Error('无法读取已保存的 PDF 原件');
      const file = new File([await response.blob()],doc.filename,{type:'application/pdf'});
      text = (await parseFile(file,this.service.api)).text;
    }
    const {document:updated} = await this.service.retryDocument(this.flow.id,id,text === undefined ? {} : {text});
    if (updated.status !== 'ready') throw new Error(updated.error || '资料仍未解析，可补录校对后的正文');
    await this.refreshDocuments();
  }

  setProgress(message, done, total) {
    this.progress.textContent = message;
    this.progressBar.hidden = !message;
    if (total) {
      this.progressBar.max = total;
      this.progressBar.value = done;
    } else {
      this.progressBar.removeAttribute('max');
      this.progressBar.removeAttribute('value');
    }
  }

  async run(work) {
    if (this.busy) return;
    this.busy = this.submit.disabled = this.draftsButton.disabled = this.body.inert = true;
    this.error.textContent = '';
    try { await work(); }
    catch (error) { this.error.textContent = error.message; }
    finally { this.busy = this.submit.disabled = this.draftsButton.disabled = this.body.inert = false; this.setProgress(''); }
  }

  async upload(file) {
    const recognize = recognizesFile(file.name);
    const {filename,content_b64} = await originalPayload(file,{recognize});
    const payload = {filename,content_b64,as_new:true};
    if (recognize) payload.recognize = true;
    await this.service.addDocument(this.flow.id,payload);
  }

  async advance() {
    const flow = this.flow;
    if (flow.needsRestore) return this.restoreServerDraft();
    if (flow.saved) return this.finish();
    this.platformSelections();
    if (flow.stage === 'recognition') {
      if (!flow.recognition.report.pages.length) {
        await flow.recognition.retry();
        this.showRecognition();
        return this.processRecognition();
      }
      if (flow.recognition.waiting.length) return this.processRecognition();
      this.setProgress('正在保存校对后的文字…');
      await flow.recognition.confirm();
      this.showFiles();
      await this.refreshDocuments();
      const next = flow.documents.find(pendingRecognition);
      if (next) return this.openRecognition(next);
      if (this.canOrganizeAfterRecognition() && flow.documents.some(usableText)) return this.organizeDocuments();
      return;
    }
    if (flow.stage === 'review' && this.intake.record?.status === 'ready') {
      const key = this.intake.key;
      flow.saved = await this.intake.save();
      delete flow.reviewDraft;
      try { sessionStorage.removeItem(`fangli.import.${key}`); } catch {}
      return this.finish();
    }
    if (!flow.customer && !flow.files.length && !flow.text.trim()) {
      if (!flow.name.trim()) throw new Error('请填写客户名称或添加资料');
      flow.serverAttempted = true;
      this.rememberDraft();
      flow.saved = await this.service.saveClient(null,flow.name.trim(),{},flow.id);
      return this.finish();
    }
    if (!flow.customer) {
      flow.serverAttempted = true;
      this.rememberDraft();
      ({client:flow.customer} = await this.service.startImport(flow.id,flow.name));
      this.draftsButton.hidden = true;
      if (!flow.customer.import_draft) throw new Error('这份导入已确认，请在客户页打开');
      this.form.elements.name.readOnly = true;
    }
    const errors = [];
    const pasted = flow.text.trim();
    const total = flow.files.length + Number(Boolean(pasted));
    let done = 0;
    for (const file of flow.files) {
      this.setProgress(`已处理 ${done} / ${total} 份资料 · 正在读取 ${file.name}`, done, total);
      try {
        await this.upload(file);
        flow.files = flow.files.filter(pending=>pending !== file);
        this.rememberDraft();
      } catch (error) { errors.push(`${file.name}：${error.message}`); }
      done++;
    }
    if (pasted) {
      this.setProgress(`已处理 ${done} / ${total} 份资料 · 正在读取粘贴内容`, done, total);
      try {
        await this.service.addDocument(flow.id,{filename:'粘贴资料',text:pasted,as_new:true});
        this.form.elements.text.value = flow.text = '';
        this.rememberDraft();
      } catch (error) { errors.push(error.message); }
      done++;
    }
    if (total) this.setProgress(`已处理 ${done} / ${total} 份资料`, done, total);
    await this.refreshDocuments();
    if (errors.length) throw new Error(errors.join('；'));
    if (!flow.documents.length) throw new Error('请先上传或粘贴至少一份资料');
    const next = flow.documents.find(pendingRecognition);
    if (next) return this.openRecognition(next);
    if (flow.documents.some(doc=>doc.status === 'pending')) throw new Error('草稿已保存。请重试、补录或移出未解析资料，再识别其余资料。');
    if (!flow.documents.some(usableText)) {
      flow.documentIds = [];
      this.rememberDraft();
      if (!flow.name.trim()) throw new Error('请填写客户名称，原件和图片会一起保存');
      flow.saved = await this.service.finalizeImport(flow.id,flow.name.trim());
      return this.finish();
    }
    return this.organizeDocuments();
  }

  async organizeDocuments() {
    const flow = this.flow;
    flow.documentIds = flow.documents.filter(usableText).map(doc=>doc.id);
    this.rememberDraft();
    flow.stage = 'review';
    this.setProgress('正在整理客户档案…');
    try { await this.intake.start(flow.id,flow.documentIds); }
    catch (error) { this.showFiles(); await this.refreshDocuments(); throw error; }
  }

  platformSelections() {
    const catalogue = this.getPlatforms().filter(enabled);
    let options = {selections:[]};
    for (const [id,counts] of Object.entries(this.flow.platformCounts)) {
      const platform = catalogue.find(p => String(p.id) === id);
      if (!platform) throw new Error('所选发布平台已停用，请返回资料并重新选择。');
      if (!counts.personal && !counts.official) throw new Error(`请给${platform.name}至少安排 1 篇，或取消勾选该平台。`);
      options = setCount(options,platform.id,'personal',counts.personal);
      options = setCount(options,platform.id,'official',counts.official);
    }
    return options.selections;
  }

  async savePlatforms() {
    const flow = this.flow;
    if (flow.platformsSaved) return;
    const selections = this.platformSelections();
    if (!selections.length) return;
    const {plan} = await this.service.plan(flow.saved.id);
    if (plan.revision === 0) {
      await this.service.savePlan(flow.saved.id,{
        options:{...planOptions(plan.options),selections},
        document_ids:plan.document_ids,
        expected_revision:0
      });
    } else if (selectionKeys(plan.options.selections) !== selectionKeys(selections)) {
      throw new Error('常用方案已被更新，请在客户档案中确认发布平台。');
    }
    flow.platformsSaved = true;
    try { sessionStorage.removeItem(platformDraftKey(flow.id)); } catch {}
  }

  showSavedCustomer() {
    this.draftsButton.hidden = true;
    this.discard.hidden = true;
    this.body.innerHTML = '<p role="status">客户档案已保存。</p>';
    this.submit.hidden = false;
    this.submit.textContent = this.flow.forTask ? '继续创作' : '查看客户档案';
  }

  async finish() {
    const {saved,documentIds,taskId,onComplete,key} = this.flow;
    this.onCustomer(saved);
    this.showSavedCustomer();
    try { await this.savePlatforms(); }
    catch (error) {
      this.submit.textContent = '重试保存发布平台';
      throw error;
    }
    await onComplete(saved,taskId ? {creation_id:taskId,document_ids:documentIds || []} : undefined);
    writeBrowserDraft(key,null);
    this.dialog.close();
  }
}
