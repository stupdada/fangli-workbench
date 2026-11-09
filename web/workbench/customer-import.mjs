import { CustomerIntake, renderIntake } from './customer-intake.mjs';
import { originalPayload } from './customers-client.mjs';
import { escapeHTML as e } from './model.mjs';
import { parseFile } from './files.mjs';

export const customerFileTypes = '.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv,.json,.html,.pdf';

export class CustomerImport {
  constructor(service, onCustomer) {
    Object.assign(this,{service,onCustomer});
    this.intake = new CustomerIntake(service, () => this.showReview());
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'customer-dialog';
    this.dialog.setAttribute('aria-labelledby','customer-import-title');
    this.dialog.innerHTML = '<form novalidate><header><h2 id="customer-import-title">新建客户</h2><button type="button" class="icon-button" data-close aria-label="关闭窗口">×</button></header><div data-import-body></div><p class="error-text" role="alert"></p><footer><button type="button" class="button quiet" data-close>关闭</button><button class="button primary" type="submit"></button></footer></form>';
    document.body.append(this.dialog);
    this.form = this.dialog.querySelector('form');
    this.body = this.form.querySelector('[data-import-body]');
    this.submit = this.form.querySelector('[type=submit]');
    this.error = this.form.querySelector('[role=alert]');
    this.form.onsubmit = event => { event.preventDefault(); this.run(() => this.advance()); };
    this.dialog.addEventListener('click',event => this.click(event));
    this.dialog.addEventListener('input',event => {
      const {name,value,dataset} = event.target;
      if (dataset.intakeField && this.intake.draft) {
        this.intake.change(dataset.intakeField,value);
        this.body.querySelector('.intake-save-state').textContent = this.intake.message;
        this.rememberReview();
      } else if (this.flow.stage === 'files') {
        if (name === 'name' || name === 'text') this.flow[name] = value;
        this.showSelection();
      }
    });
    this.dialog.addEventListener('cancel',event => { if (this.busy) event.preventDefault(); });
    this.dialog.addEventListener('close',() => this.intake.stop());
  }

  open(onComplete, {forTask = false,draft = null} = {}) {
    if (this.dialog.open) return;
    this.flow = {id:draft?.id || crypto.randomUUID(),taskId:forTask ? crypto.randomUUID() : null,
      files:[],documents:[],name:draft?.name || '',text:'',onComplete,forTask,customer:draft};
    this.intake.switchClient(this.flow.id);
    this.error.textContent = '';
    this.dialog.querySelector('h2').textContent = draft ? '继续导入草稿' : '新建客户';
    this.showFiles();
    this.dialog.showModal();
    if (draft) this.run(() => this.resumeDraft(draft));
  }

  async resumeDraft(draft) {
      Object.assign(this.flow,{id:draft.id,name:draft.name||'',text:'',files:[],customer:draft});
      this.intake.switchClient(draft.id);
      this.dialog.querySelector('h2').textContent='继续导入草稿';
      this.showFiles();
      await this.refreshDocuments();
      await this.intake.load(draft.id);
      const record = this.intake.record;
      if (record && record.sources.length === this.flow.documents.length &&
          this.flow.documents.every(doc => record.sources.some(source => source.id === doc.id))) {
        this.flow.documentIds = record.sources.map(doc => doc.id);
        this.flow.stage = 'review';
        this.showReview();
        if (record.status === 'running') this.intake.watch(60);
      }
  }

  async showDrafts() {
    const drafts=await this.service.importDrafts();
    this.flow.stage='drafts';
    this.submit.hidden=true;
    this.body.innerHTML='<button type="button" class="button quiet" data-back>返回新建客户</button>' +
      (drafts.map(d=>`<div class="customer-document"><span>${e(d.name||'未命名导入')}<small> · ${d.document_count} 份资料</small></span><button type="button" class="button outline" data-resume="${e(d.id)}">继续导入</button></div>`).join('') || '<p class="empty">暂无待确认的导入。</p>');
    this.flow.drafts=drafts;
  }

  showFiles() {
    const flow = this.flow;
    flow.stage = 'files';
    this.body.innerHTML = `<label class="field"><span>客户 / 项目名称</span><input type="text" name="name" maxlength="100" value="${e(flow.name)}" ${flow.customer ? 'readonly' : ''} placeholder="有资料时可以先识别名称"></label>
      <div class="customer-import-drop"><label class="field"><span>上传客户资料（可多选）</span><input type="file" name="files" accept="${customerFileTypes}" multiple></label><p class="helper" data-import-files role="status"></p></div>
      <label class="field"><span>粘贴资料</span><textarea name="text" rows="4" placeholder="产品介绍、服务说明或其他已知资料">${e(flow.text)}</textarea></label>
      <p class="helper">${flow.customer ? '资料已存入草稿，可以关闭窗口后继续。' : '有资料时可直接识别，核对档案和关键词后再确认。'}</p>
      ${flow.customer ? '' : '<button type="button" class="button quiet" data-drafts>继续导入草稿</button>'}<div data-import-documents></div>`;
    const add = files => {
      const key = file => JSON.stringify([file.name,file.size,file.lastModified]);
      flow.files = [...new Map([...flow.files,...files].map(file=>[key(file),file])).values()];
      this.showSelection();
    };
    this.form.elements.files.onchange = event => add(event.target.files);
    const drop = this.body.querySelector('.customer-import-drop');
    drop.ondragover = event => event.preventDefault();
    drop.ondrop = event => { event.preventDefault(); if (!this.busy) add(event.dataTransfer.files); };
    this.showSelection();
  }

  showSelection() {
    const flow = this.flow;
    this.body.querySelector('[data-import-files]').textContent = flow.files.map(file=>file.name).join('、') || '也可以把文件拖到这里。';
    this.submit.textContent = flow.files.length || flow.text.trim() || flow.customer ? '识别资料' : '保存客户';
    this.submit.hidden = false;
  }

  async refreshDocuments() {
    const groups = new Map();
    for (const doc of await this.service.documents(this.flow.id)) {
      if (!groups.has(doc.group_id) || doc.revision > groups.get(doc.group_id).revision) groups.set(doc.group_id,doc);
    }
    this.flow.documents = [...groups.values()];
    this.showSelection();
    this.body.querySelector('[data-import-documents]').innerHTML = this.flow.documents.map(doc => `<div class="customer-document"><span>${e(doc.filename)}
      <small>${doc.status === 'pending' ? e(doc.error || '待解析') : '已保存正文'}</small></span><div>
      ${doc.status === 'pending' ? `<button type="button" class="button quiet" data-retry="${e(doc.id)}">重试解析</button><button type="button" class="button quiet" data-retry-text="${e(doc.id)}">补录正文</button>` : ''}
      <button type="button" class="button quiet" data-remove="${e(doc.id)}">移出草稿</button></div></div>`).join('');
  }

  rememberReview() {
    try { sessionStorage.setItem(`fangli.import.${this.intake.key}`,JSON.stringify(this.intake.draft)); } catch {}
  }

  showReview() {
    if (!this.dialog.open || !this.intake.record || this.flow.stage !== 'review') return;
    const {record,message,key} = this.intake;
    if (record.status === 'ready' && this.flow.reviewKey !== key) {
      this.flow.reviewKey = key;
      try {
        const saved = JSON.parse(sessionStorage.getItem(`fangli.import.${key}`) || 'null');
        if (saved) { this.intake.draft = saved; this.intake.drafts.set(key,saved); }
      } catch {}
    }
    this.body.innerHTML = `<button type="button" class="button quiet" data-back>返回资料</button>${renderIntake(record,this.intake.draft,{message,compact:true})}`;
    this.submit.hidden = record.status !== 'ready';
    this.submit.textContent = this.flow.forTask ? '确认并开始创作' : '确认保存';
  }

  click(event) {
    const button = event.target.closest('button');
    if (!button) return;
    const data = button.dataset;
    if ('close' in data) { if (!this.busy) this.dialog.close(); return; }
    if ('back' in data) { this.intake.stop(); this.showFiles(); if(this.flow.customer)this.run(()=>this.refreshDocuments()); return; }
    if ('drafts' in data) { this.run(()=>this.showDrafts()); return; }
    if (data.resume) { this.run(()=>this.resumeDraft(this.flow.drafts.find(d=>d.id===data.resume))); return; }
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
    if (data.customerAction === 'intake-refresh') this.run(()=>this.intake.refresh());
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

  async run(work) {
    if (this.busy) return;
    this.busy = this.submit.disabled = this.body.inert = true;
    this.error.textContent = '';
    try { await work(); }
    catch (error) { this.error.textContent = error.message; }
    finally { this.busy = this.submit.disabled = this.body.inert = false; }
  }

  async upload(file) {
    const {filename,content_b64} = await originalPayload(file);
    const payload = {filename,content_b64,as_new:true};
    if (/\.pdf$/i.test(filename)) {
      try { payload.text = (await parseFile(file,this.service.api)).text; }
      catch { /* Keep the original as a pending document for later OCR or transcription. */ }
    }
    await this.service.addDocument(this.flow.id,payload);
  }

  async advance() {
    const flow = this.flow;
    if (flow.saved) return this.finish();
    if (flow.stage === 'review' && this.intake.record?.status === 'ready') {
      const key = this.intake.key;
      flow.saved = await this.intake.save();
      try { sessionStorage.removeItem(`fangli.import.${key}`); } catch {}
      return this.finish();
    }
    if (!flow.customer && !flow.files.length && !flow.text.trim()) {
      if (!flow.name.trim()) throw new Error('请填写客户名称或添加资料');
      flow.saved = await this.service.saveClient(null,flow.name.trim(),{},flow.id);
      return this.finish();
    }
    if (!flow.customer) {
      ({client:flow.customer} = await this.service.startImport(flow.id,flow.name));
      if (!flow.customer.import_draft) throw new Error('这份导入已确认，请在客户页打开');
      this.form.elements.name.readOnly = true;
    }
    const remaining = [], errors = [];
    for (const file of flow.files) {
      try { await this.upload(file); }
      catch (error) { remaining.push(file); errors.push(`${file.name}：${error.message}`); }
    }
    flow.files = remaining;
    if (flow.text.trim()) {
      try {
        await this.service.addDocument(flow.id,{filename:'粘贴资料',text:flow.text.trim(),as_new:true});
        this.form.elements.text.value = flow.text = '';
      } catch (error) { errors.push(error.message); }
    }
    await this.refreshDocuments();
    if (errors.length) throw new Error(errors.join('；'));
    if (!flow.documents.length) throw new Error('请先上传或粘贴至少一份资料');
    if (flow.documents.some(doc=>doc.status === 'pending')) throw new Error('草稿已保存。请重试、补录或移出未解析资料，再识别其余资料。');
    flow.documentIds = flow.documents.map(doc=>doc.id);
    flow.stage = 'review';
    try { await this.intake.start(flow.id,flow.documentIds); }
    catch (error) { this.showFiles(); await this.refreshDocuments(); throw error; }
  }

  async finish() {
    const {saved,documentIds,taskId,onComplete} = this.flow;
    this.onCustomer(saved);
    this.body.innerHTML = '<p role="status">客户档案已保存。</p>';
    this.submit.textContent = '继续';
    await onComplete(saved,taskId ? {creation_id:taskId,document_ids:documentIds || []} : undefined);
    this.dialog.close();
  }
}
