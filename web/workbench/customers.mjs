import { PROFILE_FIELDS, escapeHTML as e, splitWords } from './model.mjs';
import { CustomerClient, BatchMonitor, importCustomerFile, activeBatch } from './customers-client.mjs';
import { CustomerIntake, installIntakeStyles } from './customer-intake.mjs';
import { CustomerImport, customerFileTypes } from './customer-import.mjs';
import { claimReviewForm, claimSearchForm } from './customer-claim-check.mjs';
import { batchVideoResults, batchVideoRetryable, installBatchVideoStyles } from './customer-batch-video.mjs';
import { platformFields, collectPlatforms, planOptions } from './customer-platforms.mjs';
import { keywordLinksField, keywordLinksText, parseKeywordLinks } from './keyword-links.mjs';
import { shortVideoPath } from './workspace-rail.mjs';

const usable = d => !['pending','error','failed','superseded'].includes(d.status) && !!d.text?.trim();
const statusName = status => ({ queued:'排队中', running:'生成中', done:'已完成', partial:'部分完成', error:'失败', stopped:'已停止', interrupted:'中断待确认', pending:'待处理', active:'可使用', ready:'可使用' }[status] || status || '可使用');
const action = (name, label, attrs = '', cls = 'quiet') => `<button type="button" class="button ${cls}" data-customer-action="${name}" ${attrs}>${label}</button>`;
const idAttr = id => `data-id="${e(id)}"`;
const customerContext = c => [c.profile?.company, c.profile?.industry].filter(Boolean).join(' · ');

function keywordMarkup(words, aliases) {
  return `<div class="spread"><label class="field" for="customer-keyword-entry"><span>常用关键词</span></label>${action('plan-aliases','别名分组')}</div>
    <div class="reply-row"><input id="customer-keyword-entry" type="text" placeholder="输入关键词，回车添加">${action('add-plan-keywords','添加','','outline')}</div>
    <input type="hidden" name="keywords" value="${e(words.join('，'))}">
    <input type="hidden" name="aliases" value="${e(JSON.stringify(aliases))}">
    <div class="keyword-list">${words.map(word => action('remove-plan-keyword',`${e(word)} <span aria-hidden="true">×</span>`,
      `data-word="${e(word)}" aria-label="移除关键词 ${e(word)}"`,'keyword-choice customer-keyword')).join('')}</div>
    ${aliases.length ? `<p class="helper">别名分组 · ${aliases.map(group => e(group.join(' / '))).join(' · ')}</p>` : ''}`;
}

export class CustomersWorkspace {
  constructor(client, { render, toast, openTask, newTask, reuseTask, resolveFile }) {
    Object.assign(this, { client, render, toast, openTask, newTask, reuseTask, resolveFile });
    this.service = new CustomerClient(client.api.bind(client));
    installIntakeStyles();
    installBatchVideoStyles();
    this.intake = new CustomerIntake(this.service, () => { if (this.active && this.tab === 'intake') this.render(); });
    this.customerImport = new CustomerImport(this.service, customer => {
      const index = this.client.state.clients.findIndex(item => item.id === customer.id);
      if (index < 0) this.client.state.clients.push(customer);
      else this.client.state.clients[index] = customer;
      this.render();
    });
    this.intakeSelection = new Map();
    this.planDrafts = new Map();
    this.tab = 'profile'; this.search = ''; this.active = false;
    this.dialog = document.createElement('dialog'); this.dialog.className = 'customer-dialog';
    this.dialog.innerHTML = '<form><header><h2></h2><button type="button" data-customer-action="close-dialog" class="icon-button" aria-label="关闭窗口">×</button></header><div class="customer-dialog-body"></div><p class="error-text" role="alert"></p><footer><button type="button" class="button quiet" data-customer-action="close-dialog">取消</button><button class="button primary" type="submit">保存</button></footer></form>';
    document.body.append(this.dialog);
    this.dialog.querySelector('form').onsubmit = event => { event.preventDefault(); this.run(async () => { const close = await this.submitDialog?.(new FormData(event.target)); if (close !== false) this.dialog.close(); }); };
    document.addEventListener('click', event => {
      const el = event.target.closest('[data-customer-action]'); if (!el) return;
      event.preventDefault(); this.run(() => this.perform(el.dataset.customerAction, el));
    });
    document.addEventListener('change', event => {
      const el = event.target;
      if (el.dataset.intakeDocument) {
        const selected = this.intakeSelection.get(this.id);
        if (selected) {
          el.checked ? selected.add(el.dataset.intakeDocument) : selected.delete(el.dataset.intakeDocument);
          const start = document.querySelector('[data-customer-action="intake-start"]');
          if (start) start.disabled = !selected.size;
        }
      }
      if (el.id === 'customer-search') { this.search = el.value; this.render(); document.getElementById('customer-search')?.focus(); }
    });
    document.addEventListener('input', event => {
      const el = event.target;
      const plan = el.closest('#customer-plan');
      if (plan && this.active && el.id !== 'customer-keyword-entry') this.capturePlan(plan);
      if (el.dataset.intakeField && el.closest('[data-intake-editor]') && this.intake.draft) {
        this.intake.change(el.dataset.intakeField,el.value);
        const status = document.querySelector('.intake-save-state'); if (status) status.textContent = this.intake.message;
        if (el.dataset.intakeField.startsWith('claim:')) {
          const changed = this.intake.claimChanged(Number(el.dataset.intakeField.slice(6)));
          const row = el.closest('.intake-editorial-row');
          row.querySelector('[data-claim-check]').hidden = changed;
          row.querySelector('[data-claim-check-draft]').hidden = !changed;
        }
      }
    });
    document.addEventListener('keydown', event => {
      if (event.target.id !== 'customer-keyword-entry' || event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      this.addPlanKeywords(event.target.closest('form'), event.target.value);
    });
    document.addEventListener('paste', event => {
      if (event.target.id !== 'customer-keyword-entry') return;
      const pasted = event.clipboardData.getData('text');
      if (splitWords(pasted).length < 2) return;
      event.preventDefault();
      this.addPlanKeywords(event.target.closest('form'), [event.target.value,pasted].join('\n'));
    });
    this.monitor = new BatchMonitor(this.service, batch => { this.batch = batch; if (this.active) this.render(); }, error => { this.error = error.message; if (this.active) this.render(); });
  }
  async run(fn) {
    if (this.busy) return;
    this.busy = true;
    const submit = this.dialog.querySelector('[type=submit]'); submit.disabled = true;
    try { this.error = ''; this.dialog.querySelector('.error-text').textContent = ''; await fn(); }
    catch (error) { this.error = error.message; if (this.dialog.open) this.dialog.querySelector('.error-text').textContent = error.message; else { this.toast(error.message); this.render(); } }
    finally { this.busy = false; submit.disabled = false; }
  }
  modal(title, body, submit, label = '保存') {
    this.dialog.querySelector('h2').textContent = title;
    const content = this.dialog.querySelector('.customer-dialog-body');
    if (typeof body === 'string') content.innerHTML = body;
    else content.replaceChildren(body);
    this.dialog.querySelector('.error-text').textContent = ''; this.submitDialog = submit;
    const button = this.dialog.querySelector('[type=submit]'); button.textContent = label; button.hidden = !submit; button.disabled = Boolean(this.busy);
    if (!this.dialog.open) this.dialog.showModal();
  }
  async enter() { this.active = true; await this.refreshClients(); }
  leave() { this.active = false; this.monitor.start(null); this.intake.stop(); }
  syncPlanRoute() {
    const url = new URL(location.href);
    if (url.searchParams.get('area') !== 'customers') return;
    if (this.id && this.tab === 'plan' && !this.batch) url.searchParams.set('plan',this.id);
    else url.searchParams.delete('plan');
    history.replaceState(history.state,'',url);
  }
  planDraft(id = this.id) {
    if (!this.planDrafts.has(id)) {
      try {
        const draft = JSON.parse(sessionStorage.getItem('fangli.customer-plan.' + id));
        this.planDrafts.set(id,draft?.counts && draft?.formats && Array.isArray(draft.documents) ? draft : null);
      } catch { this.planDrafts.set(id,null); }
    }
    return this.planDrafts.get(id);
  }
  setPlanDraft(id, draft) {
    this.planDrafts.set(id,draft);
    try {
      const key = 'fangli.customer-plan.' + id;
      if (draft) sessionStorage.setItem(key,JSON.stringify(draft));
      else sessionStorage.removeItem(key);
    } catch { /* Keep the draft in memory when session storage is unavailable. */ }
  }
  capturePlan(form) {
    const data = new FormData(form);
    const counts = Object.fromEntries([...form.querySelectorAll('[data-plan-platform]')].map(input =>
      [input.dataset.planPlatform + ':' + input.dataset.planAccount,input.value]));
    const formats = {};
    for (const input of form.querySelectorAll('[data-plan-format]')) {
      formats[input.dataset.planFormat] ??= [];
      if (input.checked) formats[input.dataset.planFormat].push(input.value);
    }
    const revision = this.planDraft()?.revision ?? this.planData.plan.revision;
    this.setPlanDraft(this.id,{revision,keywords:data.get('keywords'),aliases:JSON.parse(data.get('aliases')),
      keywordLinks:data.get('keyword_links'),note:data.get('note'),documents:data.getAll('documents'),counts,formats});
    form.querySelector('[data-plan-unsaved]').hidden = false;
  }
  setPlanKeywords(form, words, aliases) {
    form.querySelector('[data-plan-keywords]').innerHTML = keywordMarkup(words, aliases);
    this.capturePlan(form);
    form.querySelector('#customer-keyword-entry').focus();
  }
  addPlanKeywords(form, value) {
    const added = splitWords(value);
    if (!added.length) return;
    const data = new FormData(form);
    const words = [...new Set([...splitWords(data.get('keywords')), ...added])];
    this.setPlanKeywords(form, words, JSON.parse(data.get('aliases')));
  }
  async refreshClients() {
    this.client.state.clients = await this.service.clients();
    this.render();
  }
  async detail(id, tab = this.tab) {
    this.intake.switchClient(id);
    const token = this.detailToken = Symbol(); this.id = id; this.tab = tab; this.loading = true; this.render();
    this.syncPlanRoute();
    try {
      const [customer, documents, plan, history] = await Promise.all([this.service.client(id), this.service.documents(id), this.service.plan(id), this.service.history(id)]);
      if (token !== this.detailToken) return;
      const available = new Set(documents.filter(usable).map(d => d.id));
      const previous = this.customer?.id === id ? new Set(this.documents.map(d => d.id)) : null;
      if (previous && this.intakeSelection.has(id)) {
        this.intakeSelection.set(id,new Set([...available].filter(did => this.intakeSelection.get(id).has(did) || !previous.has(did))));
      } else this.intakeSelection.set(id,available);
      Object.assign(this, { customer, documents, planData:plan, historyData:history });
      if (customer.archived_at && ['intake','plan'].includes(this.tab)) {
        this.tab = 'profile';
        this.syncPlanRoute();
      }
    } finally { if (token === this.detailToken) { this.loading = false; this.render(); } }
  }
  view() {
    const error = this.error ? `<p class="customer-error" role="alert">${e(this.error)}</p>` : '';
    const pending = this.service.pending ? `<div class="notice"><span>上一批提交结果待确认。重发使用原请求编号，不创建第二份批次。</span>${action('retry-submit','恢复本次提交')}</div>` : '';
    return `<section class="customers-page">${pending}${error}${this.batch ? this.batchView() : this.id ? this.detailView() : this.listView()}</section>`;
  }
  distinguishClient(customer) {
    const context = customerContext(customer);
    const ambiguous = this.client.state.clients.some(other =>
      other.id !== customer.id && other.name_conflict && customerContext(other) === context);
    return [context, !context || ambiguous ? `编号 ${customer.id.slice(-6)}` : ''].filter(Boolean).join(' · ');
  }
  listView() {
    const customers = this.client.state.clients.filter(c => `${c.name} ${c.profile?.brand || ''} ${c.profile?.products || ''}`.toLowerCase().includes(this.search.toLowerCase()));
    return `<header class="customer-heading"><div><h1>客户</h1><p>档案、资料与常用创作安排。</p></div>${action('new-client','新建客户','','primary')}</header><div class="customer-list-tools"><label><span class="sr-only">查找客户</span><input id="customer-search" type="search" placeholder="查找客户、品牌或产品" value="${e(this.search)}"></label><span>${customers.length} 位客户</span>${action('archived-clients','已归档客户')}${action('import-drafts','导入草稿')}${action('batches','批次记录')}</div><div class="customer-table-scroll"><table class="customer-table"><thead><tr><th>客户</th><th>品牌 / 产品</th><th>行业</th><th>操作</th></tr></thead><tbody>${customers.map(c => `<tr><td>${action('detail',e(c.name),idAttr(c.id),'text-button')}${c.name_conflict ? `<small class="customer-disambiguator">${e(this.distinguishClient(c))}</small>` : ''}</td><td>${e([c.profile?.brand,c.profile?.products].filter(Boolean).join(' / ') || '待补充')}</td><td>${e(c.profile?.industry || '—')}</td><td>${action('create-task','开始创作',idAttr(c.id))}${action('open-plan','常用方案',idAttr(c.id))}</td></tr>`).join('')}</tbody></table></div>${!customers.length ? `<div class="empty large"><h2>建立第一位客户</h2><p>先填写名称、添加资料，再保存常用发布安排。</p>${action('new-client','新建客户','','primary')}</div>` : ''}`;
  }
  detailView() {
    const c = this.customer;
    if (this.loading || !c || c.id !== this.id) return `<p role="status">正在读取客户资料…</p>`;
    const videoQuery = new URLSearchParams({client_id:c.id, return_to:location.pathname + location.search});
    const tabs = [['profile','档案'],['documents','资料'],['history','历史']];
    if (!c.archived_at) tabs.splice(2,0,['intake','整理档案'],['plan','常用方案']);
    const controls = c.archived_at ? `<span class="helper">已归档</span>${action('restore-client','恢复客户',idAttr(c.id),'outline')}` :
      `${action('archive-client','归档客户')}${action('edit-client','编辑档案')}<a class="button quiet" href="/workbench/geo/?client=${encodeURIComponent(c.id)}">查看 GEO 检测</a><a class="button outline" href="${e(`${shortVideoPath}?${videoQuery}`)}">制作短视频</a>${action('create-task','开始创作',idAttr(c.id),'primary')}`;
    return `${action('back','返回客户列表')}<header class="customer-heading"><div><h1>${e(c.name)}</h1><p>${e(c.profile?.products || c.profile?.industry || '客户内容空间')}</p></div><div>${controls}</div></header><nav class="customer-tabs" aria-label="客户详情">${tabs.map(([key,title]) => action('tab',title,`data-tab="${key}" aria-pressed="${this.tab === key}"`,this.tab === key ? 'active' : 'quiet')).join('')}</nav>${({profile:() => this.profileView(),documents:() => this.documentsView(),intake:() => this.intake.view(),plan:() => this.planView(),history:() => this.historyView()})[this.tab]()}`;
  }
  profileView() { return `<dl class="customer-profile">${PROFILE_FIELDS.map(([key,label]) => `<div><dt>${label}</dt><dd>${e(key === 'name' ? this.customer.name : this.customer.profile?.[key] || '未填写')}</dd></div>`).join('')}</dl>`; }
  documentsView() {
    const selected = this.intakeSelection.get(this.id) || new Set();
    return `<div class="customer-list-tools">${this.customer.archived_at ? '' : `${action('upload','上传文件','','primary')}${action('paste','粘贴资料')}${action('intake-start','整理所选资料',selected.size ? '' : 'disabled','outline')}`}${action('removed-documents','已移出资料')}${action('refresh-detail','刷新')}</div><div class="customer-documents">${this.documents.map(d => `<div class="customer-document"><div>${this.customer.archived_at ? `<strong>${e(d.filename)}</strong>` : `<label class="intake-document-choice"><input type="checkbox" data-intake-document="${e(d.id)}" ${selected.has(d.id) ? 'checked' : ''} ${usable(d) ? '' : 'disabled'} aria-label="整理 ${e(d.filename)}"><strong>${e(d.filename)}</strong></label>`}<p>修订 ${d.revision || 1} · ${e(statusName(d.status))} · ${(d.text || '').length.toLocaleString()} 字${d.has_original ? ' · 已保存原件' : ' · 无原件副本'}</p>${d.error ? `<p class="error-text">${e(d.error)}</p>` : ''}</div><div>${this.customer.archived_at ? '' : `${action('document','核对 / 修订',idAttr(d.id))}${action('remove-document','移出资料库',idAttr(d.id))}`}${action('revisions','历史',idAttr(d.id))}${d.has_original ? `<a class="button quiet" href="${e(this.service.path(this.id,`/documents/${encodeURIComponent(d.id)}/original`))}" download>原件</a>` : ''}<a class="button quiet" href="${e(this.service.path(this.id,`/documents/${encodeURIComponent(d.id)}/text`))}" download>文字</a></div></div>`).join('') || `<p class="empty">${this.customer.archived_at ? '暂无资料。' : '上传客户资料，或粘贴已经核对的文字。'}</p>`}</div>`;
  }
  planView() {
    const plan = this.planData.plan, o = plan.options || {};
    const draft = this.planDraft();
    const changed = draft && draft.revision !== plan.revision;
    return `<form id="customer-plan"><div class="customer-list-tools"><p>新任务沿用此方案和所选资料组的最新有效修订。本次任务临时调整不会改写这里。</p></div>${(this.planData.issues || []).map(issue => `<p class="error-text">${e(typeof issue === 'string' ? issue : issue.error || issue.message)}</p>`).join('')}<div class="form-grid"><section class="keyword-editor customer-plan-keywords" data-plan-keywords>${keywordMarkup(draft ? splitWords(draft.keywords || '') : o.keywords || [], draft?.aliases ?? o.aliases ?? [])}</section>${keywordLinksField(draft?.keywordLinks ?? keywordLinksText(o.keyword_links))}<label class="field"><span>长期写作要求</span><textarea class="input" name="note" rows="2">${e(draft?.note ?? o.note ?? '')}</textarea></label></div><h2 class="section-title">常用发布安排</h2>${platformFields(this.client.platforms,o,draft)}<h2 class="section-title">默认资料</h2><div class="library-list">${this.documents.map(d => `<label><input type="checkbox" name="documents" value="${e(d.id)}" ${(draft?.documents ?? plan.document_ids ?? []).includes(d.id) ? 'checked' : ''} ${usable(d) ? '' : 'disabled'}><span>${e(d.filename)}<small>修订 ${d.revision || 1} · ${e(statusName(d.status))}</small></span></label>`).join('') || '<p class="empty">先在资料页上传或粘贴正文。</p>'}</div><footer class="customer-plan-footer"><span>方案修订 ${plan.revision || 0}</span><span data-plan-unsaved ${draft ? '' : 'hidden'}><span role="status">${changed ? '方案已有新版本，本页保留了原草稿。' : '有未保存的修改'}</span> ${action('discard-plan','放弃修改')}</span>${action('save-plan','保存客户常用方案','','primary')}</footer></form>`;
  }
  historyView() {
    return `<h2 class="section-title">创作任务</h2>${(this.historyData.conversations || []).map(t => `<div class="customer-document"><span>${e(t.title)} <small>${e(t.deleted_at ? '已删除' : t.archived_at ? '已归档' : statusName(t.status))} · ${e(t.created_at || '')}</small></span><div>${t.deleted_at ? '' : action('open-task','打开',idAttr(t.id))}${this.customer.archived_at || t.deleted_at ? '' : `<details><summary>更多</summary>${action('reuse-task','沿用安排新建',idAttr(t.id))}</details>`}</div></div>`).join('') || '<p class="empty">还没有创作任务。</p>'}<h2 class="section-title">生成批次</h2>${this.batchRows(this.historyData.batches || [])}`;
  }
  batchRows(batches) {
    return batches.map(b => {
      const articles = typeof b.total === 'number' ? ` · 文章 ${Number(b.completed || 0)} / ${b.total} 篇` : '';
      const videos = b.video_total ? ` · 视频 ${Number(b.video_completed || 0)} / ${Number(b.video_total)} 条` : '';
      return `<div class="customer-document"><span>${e(b.created_at || b.id)} <small>${e(statusName(b.status))}${articles}${videos}</small></span>${action('batch','查看批次',idAttr(b.id))}</div>`;
    }).join('') || '<p class="empty">还没有批次记录。</p>';
  }
  batchView() {
    const b = this.batch;
    const videoTotal = Number(b.video_total || 0);
    const videoCompleted = Number(b.video_completed || 0);
    const items = b.items || [];
    const rows = items.filter(item => !videoTotal || item.planned).map(item => `<tr><td>${e(item.name)}</td><td>${e(statusName(item.status))}</td><td>${Number(item.completed || 0)} / ${Number(item.planned || 0)}</td><td>${item.error ? `<p class="error-text">${e(item.error)}</p>` : ''}${item.archived_at || item.deleted_at ? `<small>${item.deleted_at ? '任务已删除' : '任务已归档'}</small> ` : ''}${item.conversation_id && !item.deleted_at ? action('open-task','打开任务',idAttr(item.conversation_id)) : ''}</td></tr>`);
    const articles = rows.length ? `<div class="customer-table-scroll"><table class="customer-table" aria-label="文章进度"><thead><tr><th>客户</th><th>状态</th><th>进度</th><th>结果</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '';
    const continueAction = activeBatch(b) ? action('stop-batch','停止后续') : ['stopped','interrupted','partial','error'].includes(b.status) ? action('resume-batch','继续未完成项','','primary') : '';
    const download = videoCompleted > 0 ? `<a class="button outline" href="${e(this.service.batchVideoDownload(b.id))}" download>下载已完成视频</a>` : '';
    const progress = `文章 <strong>${Number(b.completed || 0)}</strong> / ${Number(b.total || 0)} 篇${videoTotal ? ` · 视频 <strong>${videoCompleted}</strong> / ${videoTotal} 条` : ''}`;
    const stopHint = videoTotal ? '停止后，尚未开始的内容暂停排队。' : '停止会取消尚未开始项，并请求当前篇收尾。';
    const headingStatus = [b.created_at,statusName(b.status)].filter(Boolean).map(e).join(' · ');
    return `${action('back','返回客户列表')}<header class="customer-heading batch-heading"><div><h1>生成批次</h1><p>${headingStatus}</p></div><div class="batch-heading-actions">${action('refresh-batch','刷新')}${download}${continueAction}</div></header><p class="batch-progress" role="status">${progress}</p><p class="helper">已完成项会保留。${stopHint}</p>${articles}${batchVideoResults(b,statusName)}`;
  }
  editClient(c) {
    const field = ([key,label]) => `<label class="field"><span>${label}</span><input name="${key}" value="${e(key === 'name' ? c.name : c.profile?.[key] || '')}" ${key === 'name' ? 'required maxlength="100"' : 'maxlength="4000"'}></label>`;
    this.modal('编辑客户档案', `<div class="form-grid">${PROFILE_FIELDS.slice(0,5).map(field).join('')}</div><details><summary>联系方式</summary><div class="form-grid">${PROFILE_FIELDS.slice(5).map(field).join('')}</div></details>`, async data => {
      const saved = await this.service.saveClient(c.id, String(data.get('name')).trim(), Object.fromEntries(PROFILE_FIELDS.slice(1).map(([key]) => [key, String(data.get(key) || '').trim()])));
      await this.refreshClients(); await this.detail(saved.id,'profile'); this.toast('客户档案已保存');
    });
  }
  async resolveImport(info) {
    return new Promise(resolve => {
      const close = () => { this.dialog.removeEventListener('close',close); resolve(null); };
      this.modal('确认资料更新', `<p>${e(info.filename)} 与以下资料名称相近。请选择更新对象，或作为独立资料另存。</p>${(info.candidates || []).map((d,i) => `<label class="check-label"><input type="radio" name="update" value="${e(d.id)}" ${i ? '' : 'checked'}>${e(d.filename)} · 修订 ${d.revision || 1}</label>`).join('')}<label class="check-label"><input type="radio" name="update" value="new">另存为独立资料</label>`, data => { const id = data.get('update'); if (!id) throw new Error('请选择更新对象或另存'); this.dialog.removeEventListener('close',close); resolve(id === 'new' ? {as_new:true} : {update_document_id:id}); }, '确认导入');
      this.dialog.addEventListener('close',close);
    });
  }
  async importFiles(files) {
    const clientId = this.id; const results = [];
    // The resolution dialog owns its own submit handler; do not keep the outer UI busy while awaiting it.
    this.busy = false;
    for (const file of files) results.push(await importCustomerFile(this.service, clientId, file, info => this.resolveImport(info)));
    await this.detail(clientId,'documents');
    this.toast(results.map(r => r.is_current === false ? '原件属于历史修订，当前版本未改变' : ({created:'已保存原件与解析文字',updated:'已更新资料修订',duplicate:'原件已存在，已复用',pending:'原件已保存，解析待处理',cancelled:'已取消导入',needs_resolution:'资料待确认'})[r.outcome] || r.outcome).join('；'));
  }
  async showBatch(batch) { this.batch = batch; this.monitor.start(batch); this.render(); }
  async perform(name, el) {
    const id = el.dataset.id;
    if (name === 'close-dialog') { this.dialog.close(); return; }
    if (name === 'back') { this.id = null; this.batch = null; this.monitor.start(null); this.intake.stop(); this.syncPlanRoute(); this.render(); return; }
    if (name === 'archived-clients') {
      const archived = await this.service.clients(true);
      this.modal('已归档客户',archived.map(c => `<div class="customer-document"><span>${e(c.name)}
        <small>${e([customerContext(c),`编号 ${c.id.slice(-6)}`].filter(Boolean).join(' · '))}</small></span>
        <div>${action('archived-detail','查看档案与历史',idAttr(c.id))}${action('restore-client','恢复客户',idAttr(c.id))}</div></div>`).join('') || '<p class="empty">暂无归档客户。</p>',null);
      return;
    }
    if (name === 'archived-detail') { this.dialog.close(); return this.detail(id,'history'); }
    if (name === 'restore-client') {
      this.modal('恢复客户','<p>恢复后，此客户将重新出现在活动列表中，可继续使用原有档案和资料创作。</p>',async () => {
        await this.service.restoreClient(id);
        await this.refreshClients();
        await this.detail(id,'history');
        this.toast('客户已恢复');
      },'恢复客户');
      return;
    }
    if (name === 'archive-client') {
      const customer = this.customer;
      this.modal('归档客户',`<p>将「${e(customer.name)}」移出活动客户列表和批量选择。档案、资料和历史任务可从「已归档客户」查看。</p>`,async () => {
        await this.service.archiveClient(customer.id);
        await this.detail(customer.id,'history');
        await this.refreshClients();
        this.toast('客户已归档');
      },'归档客户');
      return;
    }
    if (name === 'detail' || name === 'open-plan') return this.detail(id,name === 'open-plan' ? 'plan' : 'profile');
    if (name === 'tab') { this.tab = el.dataset.tab; this.syncPlanRoute(); if (this.tab === 'intake') { this.intake.stop(); await this.intake.load(this.id); if (this.intake.record?.status === 'running') this.intake.watch(60); } else this.intake.stop(); this.render(); return; }
    if (name === 'intake-start') { const ids = [...(this.intakeSelection.get(this.id) || [])]; if (!ids.length) throw new Error('请选择要整理的资料'); this.tab = 'intake'; await this.intake.start(this.id,ids); this.render(); return; }
    if (name === 'intake-refresh') return this.intake.refresh();
    if (name === 'intake-retry') return this.intake.start(this.id,this.intake.record.sources.map(d => d.id),true);
    if (name === 'intake-use-field') return this.intake.useField(el.dataset.field);
    if (name === 'claim-search' || name === 'claim-review') {
      const claim = this.intake.claimForCheck(id);
      const {cid,record} = this.intake;
      const search = name === 'claim-search';
      this.modal(search ? '查找公开出处' : '核对公开出处', search ? claimSearchForm(claim) : claimReviewForm(claim), async data => {
        const fields = Object.fromEntries(data);
        const response = search
          ? await this.service.searchClaim(cid,record.id,id,fields.query)
          : await this.service.reviewClaim(cid,record.id,id,{...fields,expected_revision:claim.public_check.revision});
        if (this.intake.record?.id === record.id) this.intake.accept(response.intake);
        this.toast(search ? '搜索结果已保存' : '核对记录已保存');
      },search ? '搜索' : '保存核对记录');
      return;
    }
    if (name === 'intake-save') { this.intake.busy = true; this.render(); try { this.customer = await this.intake.save(); await this.refreshClients(); this.toast('客户档案与整理结果已保存'); } finally { this.intake.busy = false; this.render(); } return; }
    if (name === 'refresh-detail') return this.detail(this.id);
    if (name === 'import-drafts') {
      const drafts = await this.service.importDrafts();
      this.modal('导入草稿',drafts.map(d => `<div class="customer-document"><span>${e(d.name || '未命名导入')}<small> · ${d.document_count} 份资料</small></span>${action('resume-import','继续导入',idAttr(d.id))}</div>`).join('') || '<p class="empty">暂无待确认的导入。</p>',null);
      return;
    }
    if (name === 'new-client' || name === 'resume-import') {
      const draft = name === 'resume-import' ? (await this.service.importDrafts()).find(d => d.id === id) : null;
      if (name === 'resume-import' && !draft) throw new Error('这份草稿已确认，请到客户列表查看');
      if (this.dialog.open) this.dialog.close();
      return this.customerImport.open(async customer => {
        await this.detail(customer.id,'profile');
        this.toast('客户档案已保存');
      }, {draft});
    }
    if (name === 'edit-client') return this.editClient(this.customer);
    if (name === 'create-task') { this.leave(); return this.newTask(id); }
    if (name === 'open-task') { this.dialog.close(); this.leave(); return this.openTask(id); }
    if (name === 'reuse-task') return this.reuseTask(id);
    if (name === 'discard-plan') {
      const id = this.id;
      this.modal('放弃方案修改','<p>放弃此页未保存的编辑，重新读取已保存的常用方案。</p>',async () => {
        this.setPlanDraft(id,null);
        await this.detail(id,'plan');
      },'放弃修改');
      return;
    }
    if (['add-plan-keywords','remove-plan-keyword','plan-aliases'].includes(name)) {
      const form = el.closest('#customer-plan');
      const entry = form.querySelector('#customer-keyword-entry');
      if (name === 'add-plan-keywords') return this.addPlanKeywords(form, entry.value);
      const data = new FormData(form);
      const words = splitWords(data.get('keywords')), aliases = JSON.parse(data.get('aliases'));
      if (name === 'remove-plan-keyword') {
        const word = el.dataset.word;
        return this.setPlanKeywords(form,words.filter(value => value !== word),
          aliases.map(group => group.filter(value => value !== word)).filter(group => group.length > 1));
      }
      const {aliases: suggestions} = await this.client.api('/api/aliases','POST',{keywords:words});
      const groups = [...new Map([...aliases,...suggestions].map(group => [JSON.stringify([...group].sort()),group])).values()];
      this.modal('常用关键词别名分组',
        `<div class="library-list">${groups.map((group,i) => `<label><input type="checkbox" name="group" value="${i}" checked><span>${e(group.join(' / '))}</span></label>`).join('')}</div>
        <label class="field"><span>手动补充分组</span><textarea name="manual" rows="3" placeholder="每行一组，用逗号分隔同组的常用关键词"></textarea></label>`,
        selection => {
          const manual = String(selection.get('manual') || '').split(/\r?\n/).map(splitWords).filter(group => group.length);
          if (manual.some(group => group.length < 2 || group.some(word => !words.includes(word)))) {
            throw new Error('每组至少选择两个已添加的常用关键词');
          }
          const chosen = [...selection.getAll('group').map(index => groups[Number(index)]),...manual];
          this.setPlanKeywords(document.getElementById('customer-plan'),words,
            [...new Map(chosen.map(group => [JSON.stringify([...group].sort()),group])).values()]);
        },'应用分组');
      return;
    }
    if (name === 'save-plan') {
      const root = document.getElementById('customer-plan');
      this.addPlanKeywords(root,root.querySelector('#customer-keyword-entry').value);
      const data = new FormData(root);
      const options = planOptions(collectPlatforms(this.client.platforms,root,{...this.planData.plan.options,
        keywords:splitWords(data.get('keywords')),aliases:JSON.parse(data.get('aliases')),keyword_links:parseKeywordLinks(data.get('keyword_links')),note:String(data.get('note')).trim()}));
      const id = this.id, draft = this.planDraft();
      const result = await this.service.savePlan(id,{options,document_ids:data.getAll('documents'),expected_revision:draft?.revision ?? this.planData.plan.revision});
      const latest = this.planDraft(id);
      this.setPlanDraft(id,latest === draft ? null : {...latest,revision:result.plan.revision});
      if (this.id === id) this.planData = result;
      this.render(); this.toast('常用方案已保存，新任务将带出此安排'); return;
    }
    if (name === 'upload') { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.accept = customerFileTypes; input.onchange = () => this.run(() => this.importFiles([...input.files])); input.click(); return; }
    if (name === 'paste') { this.modal('粘贴客户资料','<label class="field"><span>资料名称</span><input name="filename" required value="粘贴资料"></label><label class="field"><span>正文</span><textarea name="text" required rows="10"></textarea></label>',async data => { const result = await this.service.addDocument(this.id,{filename:String(data.get('filename')),text:String(data.get('text'))}); if (!result.document || result.outcome === 'needs_resolution') throw new Error('同名资料已存在，请从资料列表明确选择修订对象'); await this.detail(this.id,'documents'); }); return; }
    if (name === 'document') { const d = this.documents.find(d => d.id === id); this.modal(d.filename,`<label class="field"><span>解析正文</span><textarea name="text" rows="14">${e(d.text || '')}</textarea></label>`, async data => { const result = await this.service.addDocument(this.id,{filename:d.filename,kind:d.kind,text:String(data.get('text')),update_document_id:d.id}); if (!result.document || !usable(result.document)) throw new Error(result.document?.error || '修订尚未成为有效资料'); await this.detail(this.id,'documents'); },'保存新修订'); return; }
    if (name === 'remove-document') {
      const cid = this.id, doc = this.documents.find(item => item.id === id);
      this.modal('移出资料库',`<p>将「${e(doc.filename)}」及其修订移出资料库。已有任务仍可打开原来的资料和原件。</p>`,async () => {
        await this.service.removeDocument(cid,id);
        await this.detail(cid,'documents');
        this.toast('资料已移出');
      },'移出资料库');
      return;
    }
    if (name === 'removed-documents') {
      const removed = await this.service.documents(this.id,true);
      this.modal('已移出资料',removed.map(d => `<div class="customer-document"><span>${e(d.filename)}
        <small>修订 ${d.revision || 1}</small></span><div>${action('revisions','查看修订和原件',idAttr(d.id))}${this.customer.archived_at ? '' : action('restore-document','恢复资料',`${idAttr(d.id)} data-usable="${usable(d)}"`)} </div></div>`).join('') ||
        '<p class="empty">暂无移出的资料。</p>',null);
      return;
    }
    if (name === 'restore-document') {
      const cid = this.id;
      this.modal('恢复资料',`<p>将原有修订恢复到资料库，供你查看和手动选用。</p>${el.dataset.usable === 'true' ? '<label class="check-label"><input type="checkbox" name="add">同时加入新任务的默认资料</label>' : ''}`,async data => {
        await this.service.restoreDocument(cid,id,data.has('add'));
        await this.detail(cid,'documents');
        this.toast('资料已恢复');
      },'恢复资料');
      return;
    }
    if (name === 'revisions') { const docs = await this.service.revisions(this.id,id); this.modal('资料修订历史',docs.map(d => `<div class="customer-document"><span>${e(d.filename)} · 修订 ${d.revision || 1} · ${e(statusName(d.status))}</span><div>${d.has_original ? `<a class="button quiet" download href="${e(this.service.path(this.id,`/documents/${encodeURIComponent(d.id)}/original`))}">原件</a>` : ''}<a class="button quiet" download href="${e(this.service.path(this.id,`/documents/${encodeURIComponent(d.id)}/text`))}">文字</a></div></div>`).join(''),null); return; }
    if (name === 'retry-submit') { await this.showBatch(await this.service.retrySubmission()); return; }
    if (name === 'batches') { this.modal('批次记录',this.batchRows(await this.service.batches()),null); return; }
    if (name === 'batch') { this.dialog.close(); return this.showBatch(await this.service.batch(id)); }
    if (name === 'refresh-batch') return this.showBatch(await this.service.batch(this.batch.id));
    if (name === 'stop-batch') return this.showBatch(await this.service.batchAction(this.batch.id,'stop'));
    if (name === 'batch-video-retry') {
      const batchId = this.batch?.id;
      const video = (this.batch?.items || []).flatMap(item => item.videos || []).find(video => video.id === id);
      if (!batchVideoRetryable(video)) return;
      const retry = async payload => this.showBatch(await this.service.retryBatchVideo(batchId,id,payload));
      if (video.status !== 'interrupted') return retry({});
      this.modal('恢复这条视频', `<p>${e(video.topic)}在处理时中断。中断前的请求可能已经执行，请确认后恢复。</p><label class="check-label"><input type="checkbox" name="ack" required>确认恢复这条视频</label>`, async data => {
        if (!data.has('ack')) throw new Error('请先确认恢复');
        await retry({acknowledge_uncertain:true});
      }, '确认恢复');
      return;
    }
    if (name === 'resume-batch') {
      const uncertain = this.batch.status === 'interrupted' || this.batch.items.some(item => item.status === 'interrupted' || item.videos?.some(video => video.status === 'interrupted'));
      this.modal('继续未完成项', uncertain ? '<p>部分操作在中断前可能已经执行。继续会重新尝试这些未确认项。</p><label class="check-label"><input type="checkbox" name="ack" required>我已确认可能重复执行，继续未确认项</label>' : '<p>继续尚未完成的项，已完成项保持不变。</p>', async data => { if (uncertain && !data.has('ack')) throw new Error('请先确认未确认操作的重试风险'); await this.showBatch(await this.service.batchAction(this.batch.id,'resume',uncertain ? {acknowledge_uncertain:true} : {})); },'确认继续');
    }
  }
  dispose() { this.monitor.dispose(); this.intake.stop(); this.customerImport.intake.stop(); }
}
