import { PROFILE_FIELDS, escapeHTML as e, enabled, planSummary, splitWords, clone, selectionCounts, setCount } from './model.mjs';
import { CustomerClient, BatchMonitor, importCustomerFile, activeBatch } from './customers-client.mjs';
import { CustomerIntake, installIntakeStyles } from './customer-intake.mjs';
import { claimReviewForm, claimSearchForm } from './customer-claim-check.mjs';
import { addBatchVideo, assertBatchVideoLimit, batchConfirmation, batchVideoResults, batchVideoRetryable,
  collectBatchVideos, installBatchVideoStyles, updateVideoLimit, updateVideoSource, videoPlanner } from './customer-batch-video.mjs';

const usable = d => !['pending','error','failed','superseded'].includes(d.status) && !!d.text?.trim();
const statusName = status => ({ queued:'排队中', running:'生成中', done:'已完成', partial:'部分完成', error:'失败', stopped:'已停止', interrupted:'中断待确认', pending:'待处理', active:'可使用', ready:'可使用' }[status] || status || '可使用');
const planKeys = ['keywords','selections','format_overrides','note','rivals','aliases','models'];
export const planOptions = options => Object.fromEntries(planKeys.filter(k => options?.[k] !== undefined).map(k => [k, clone(options[k])]));
const action = (name, label, attrs = '', cls = 'quiet') => `<button type="button" class="button ${cls}" data-customer-action="${name}" ${attrs}>${label}</button>`;
const idAttr = id => `data-id="${e(id)}"`;

export class CustomersWorkspace {
  constructor(client, { render, toast, openTask, newTask, resolveFile }) {
    Object.assign(this, { client, render, toast, openTask, newTask, resolveFile });
    this.service = new CustomerClient(client.api.bind(client));
    installIntakeStyles();
    installBatchVideoStyles();
    this.intake = new CustomerIntake(this.service, () => { if (this.active && this.tab === 'intake') this.render(); });
    this.intakeSelection = new Map();
    this.selected = new Set(); this.tab = 'profile'; this.search = ''; this.active = false;
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
      if (el.matches('[data-batch-video-source]')) updateVideoSource(el);
      if (el.matches('[data-batch-articles]')) {
        const platforms = el.closest('[data-batch-client]').querySelector('.batch-article-platforms');
        platforms.disabled = platforms.hidden = !el.checked;
      }
      if (el.dataset.intakeDocument) {
        const selected = this.intakeSelection.get(this.id);
        if (selected) {
          el.checked ? selected.add(el.dataset.intakeDocument) : selected.delete(el.dataset.intakeDocument);
          const start = document.querySelector('[data-customer-action="intake-start"]');
          if (start) start.disabled = !selected.size;
        }
      }
      if (el.dataset.customerSelect) { el.checked ? this.selected.add(el.dataset.customerSelect) : this.selected.delete(el.dataset.customerSelect); this.render(); }
      if (el.id === 'customer-search') { this.search = el.value; this.render(); document.getElementById('customer-search')?.focus(); }
    });
    document.addEventListener('input', event => {
      const el = event.target;
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
  async refreshClients() {
    this.client.state.clients = await this.service.clients();
    const available = new Set(this.client.state.clients.map(c => c.id)); this.selected = new Set([...this.selected].filter(id => available.has(id)));
    this.render();
  }
  async detail(id, tab = this.tab) {
    this.intake.switchClient(id);
    const token = this.detailToken = Symbol(); this.id = id; this.tab = tab; this.loading = true; this.render();
    try {
      const [customer, documents, plan, history] = await Promise.all([this.service.client(id), this.service.documents(id), this.service.plan(id), this.service.history(id)]);
      if (token !== this.detailToken) return;
      const available = new Set(documents.filter(usable).map(d => d.id));
      const previous = this.customer?.id === id ? new Set(this.documents.map(d => d.id)) : null;
      if (previous && this.intakeSelection.has(id)) {
        this.intakeSelection.set(id,new Set([...available].filter(did => this.intakeSelection.get(id).has(did) || !previous.has(did))));
      } else this.intakeSelection.set(id,available);
      Object.assign(this, { customer, documents, planData:plan, historyData:history });
    } finally { if (token === this.detailToken) { this.loading = false; this.render(); } }
  }
  view() {
    const error = this.error ? `<p class="customer-error" role="alert">${e(this.error)}</p>` : '';
    const pending = this.service.pending ? `<div class="notice"><span>上一批提交结果待确认。重发使用原请求编号，不创建第二份批次。</span>${action('retry-submit','恢复本次提交')}</div>` : '';
    return `<section class="customers-page">${pending}${error}${this.batch ? this.batchView() : this.id ? this.detailView() : this.listView()}</section>`;
  }
  listView() {
    const customers = this.client.state.clients.filter(c => `${c.name} ${c.profile?.brand || ''} ${c.profile?.products || ''}`.toLowerCase().includes(this.search.toLowerCase()));
    return `<header class="customer-heading"><div><h1>客户</h1><p>档案、资料与常用创作安排。</p></div>${action('new-client','新建客户','','primary')}</header><div class="customer-list-tools"><label><span class="sr-only">查找客户</span><input id="customer-search" type="search" placeholder="查找客户、品牌或产品" value="${e(this.search)}"></label><span>${this.selected.size ? `已选 ${this.selected.size} 位客户` : `${customers.length} 位客户`}</span>${action('select-visible','全选当前结果')}${action('clear-selection','清空选择')}${action('batches','批次记录')}${action('batch-prepare','批量生成',this.selected.size ? '' : 'disabled','primary')}</div><div class="customer-table-scroll"><table class="customer-table"><thead><tr><th>选择</th><th>客户</th><th>品牌 / 产品</th><th>行业</th><th>操作</th></tr></thead><tbody>${customers.map(c => `<tr><td><input type="checkbox" aria-label="选择${e(c.name)}" data-customer-select="${e(c.id)}" ${this.selected.has(c.id) ? 'checked' : ''}></td><td>${action('detail',e(c.name),idAttr(c.id),'text-button')}</td><td>${e([c.profile?.brand,c.profile?.products].filter(Boolean).join(' / ') || '待补充')}</td><td>${e(c.profile?.industry || '—')}</td><td>${action('create-task','开始创作',idAttr(c.id))}${action('open-plan','常用方案',idAttr(c.id))}</td></tr>`).join('')}</tbody></table></div>${!customers.length ? `<div class="empty large"><h2>建立第一位客户</h2><p>先填写名称、添加资料，再保存常用发布安排。</p>${action('new-client','新建客户','','primary')}</div>` : ''}`;
  }
  detailView() {
    const c = this.customer;
    if (this.loading || !c || c.id !== this.id) return `<p role="status">正在读取客户资料…</p>`;
    const tabs = [['profile','档案'],['documents','资料'],['intake','整理档案'],['plan','常用方案'],['history','历史']];
    return `${action('back','返回客户列表')}<header class="customer-heading"><div><h1>${e(c.name)}</h1><p>${e(c.profile?.products || c.profile?.industry || '客户内容空间')}</p></div><div>${action('edit-client','编辑档案')}${action('create-task','开始创作',idAttr(c.id),'primary')}</div></header><nav class="customer-tabs" aria-label="客户详情">${tabs.map(([key,title]) => action('tab',title,`data-tab="${key}" aria-pressed="${this.tab === key}"`,this.tab === key ? 'active' : 'quiet')).join('')}</nav>${({profile:() => this.profileView(),documents:() => this.documentsView(),intake:() => this.intake.view(),plan:() => this.planView(),history:() => this.historyView()})[this.tab]()}`;
  }
  profileView() { return `<dl class="customer-profile">${PROFILE_FIELDS.map(([key,label]) => `<div><dt>${label}</dt><dd>${e(key === 'name' ? this.customer.name : this.customer.profile?.[key] || '未填写')}</dd></div>`).join('')}</dl>`; }
  documentsView() {
    const selected = this.intakeSelection.get(this.id) || new Set();
    return `<div class="customer-list-tools">${action('upload','上传文件','','primary')}${action('paste','粘贴资料')}${action('refresh-detail','刷新')}${action('intake-start','整理所选资料',selected.size ? '' : 'disabled','outline')}</div><div class="customer-documents">${this.documents.map(d => `<div class="customer-document"><div><label class="intake-document-choice"><input type="checkbox" data-intake-document="${e(d.id)}" ${selected.has(d.id) ? 'checked' : ''} ${usable(d) ? '' : 'disabled'} aria-label="整理 ${e(d.filename)}"><strong>${e(d.filename)}</strong></label><p>修订 ${d.revision || 1} · ${e(statusName(d.status))} · ${(d.text || '').length.toLocaleString()} 字${d.has_original ? ' · 已保存原件' : ' · 无原件副本'}</p>${d.error ? `<p class="error-text">${e(d.error)}</p>` : ''}</div><div>${action('document','核对 / 修订',idAttr(d.id))}${action('revisions','历史',idAttr(d.id))}${d.has_original ? `<a class="button quiet" href="${e(this.service.path(this.id,`/documents/${encodeURIComponent(d.id)}/original`))}" download>原件</a>` : ''}<a class="button quiet" href="${e(this.service.path(this.id,`/documents/${encodeURIComponent(d.id)}/text`))}" download>文字</a></div></div>`).join('') || '<p class="empty">上传客户资料，或粘贴已经核对的文字。</p>'}</div>`;
  }
  platformFields(options, prefix) {
    const platforms = this.client.platforms.filter(enabled);
    return `<div class="customer-table-scroll"><table class="customer-table plan-platforms" data-plan-prefix="${prefix}"><thead><tr><th>平台</th><th>官方号 / 篇</th><th>个人号 / 篇</th><th>发布形态</th></tr></thead><tbody>${platforms.map(p => { const counts = selectionCounts(options,p.id); return `<tr><th>${e(p.name)}</th>${['official','personal'].map(type => `<td><input type="number" min="0" max="20" step="1" value="${counts[type]}" data-plan-platform="${e(p.id)}" data-plan-account="${type}" aria-label="${e(p.name)}${type === 'official' ? '官方号' : '个人号'}篇数"></td>`).join('')}<td><div class="format-picks">${(p.formats || []).map(fmt => `<label><input type="checkbox" data-plan-format="${e(p.id)}" value="${e(fmt)}" ${(options.format_overrides?.[p.id] || p.formats).includes(fmt) ? 'checked' : ''}>${e(fmt)}</label>`).join('')}</div></td></tr>`; }).join('')}</tbody></table></div>`;
  }
  collectPlatforms(root, options = {}) {
    let result = { ...clone(options), selections:[], format_overrides:{} };
    for (const input of root.querySelectorAll('[data-plan-platform]')) result = setCount(result, input.dataset.planPlatform.match(/^\d+$/) ? Number(input.dataset.planPlatform) : input.dataset.planPlatform, input.dataset.planAccount, input.value);
    for (const p of this.client.platforms.filter(enabled)) {
      const formats = [...root.querySelectorAll('[data-plan-format]')].filter(input => String(p.id) === input.dataset.planFormat && input.checked).map(input => input.value);
      if (result.selections.some(s => String(s.platform_id) === String(p.id)) && !formats.length) throw new Error(`${p.name}至少选择一种发布形态`);
      if (formats.length) result.format_overrides[p.id] = formats;
    }
    return result;
  }
  planView() {
    const plan = this.planData.plan, o = plan.options || {};
    return `<form id="customer-plan"><div class="customer-list-tools"><p>新任务沿用此方案和所选资料组的最新有效修订。本次任务临时调整不会改写这里。</p></div>${(this.planData.issues || []).map(issue => `<p class="error-text">${e(typeof issue === 'string' ? issue : issue.error || issue.message)}</p>`).join('')}<div class="form-grid"><label class="field"><span>常用关键词 / 内容方向</span><input name="keywords" value="${e((o.keywords || []).join('，'))}" placeholder="产品词、应用词，逗号分隔"></label><label class="field"><span>长期写作要求</span><textarea name="note" rows="2">${e(o.note || '')}</textarea></label></div><h2 class="section-title">常用发布安排</h2>${this.platformFields(o,'customer-plan')}<h2 class="section-title">默认资料</h2><div class="library-list">${this.documents.map(d => `<label><input type="checkbox" name="documents" value="${e(d.id)}" ${(plan.document_ids || []).includes(d.id) ? 'checked' : ''} ${usable(d) ? '' : 'disabled'}><span>${e(d.filename)}<small>修订 ${d.revision || 1} · ${e(statusName(d.status))}</small></span></label>`).join('') || '<p class="empty">先在资料页上传或粘贴正文。</p>'}</div><footer class="customer-plan-footer"><span>方案修订 ${plan.revision || 0}</span>${action('save-plan','保存客户常用方案','','primary')}</footer></form>`;
  }
  historyView() {
    return `<h2 class="section-title">创作任务</h2>${(this.historyData.conversations || []).map(t => `<div class="customer-document"><span>${e(t.title)} <small>${e(statusName(t.status))} · ${e(t.created_at || '')}</small></span>${action('open-task','打开',`data-id="${e(t.id)}"`)}</div>`).join('') || '<p class="empty">还没有创作任务。</p>'}<h2 class="section-title">生成批次</h2>${this.batchRows(this.historyData.batches || [])}`;
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
    const rows = items.filter(item => !videoTotal || item.planned).map(item => `<tr><td>${e(item.name)}</td><td>${e(statusName(item.status))}</td><td>${Number(item.completed || 0)} / ${Number(item.planned || 0)}</td><td>${item.error ? `<p class="error-text">${e(item.error)}</p>` : ''}${item.conversation_id ? action('open-task','打开任务',idAttr(item.conversation_id)) : ''}</td></tr>`);
    const articles = rows.length ? `<div class="customer-table-scroll"><table class="customer-table" aria-label="文章进度"><thead><tr><th>客户</th><th>状态</th><th>进度</th><th>结果</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '';
    const continueAction = activeBatch(b) ? action('stop-batch','停止后续') : ['stopped','interrupted','partial','error'].includes(b.status) ? action('resume-batch','继续未完成项','','primary') : '';
    const download = videoCompleted > 0 ? `<a class="button outline" href="${e(this.service.batchVideoDownload(b.id))}" download>下载已完成视频</a>` : '';
    const progress = `文章 <strong>${Number(b.completed || 0)}</strong> / ${Number(b.total || 0)} 篇${videoTotal ? ` · 视频 <strong>${videoCompleted}</strong> / ${videoTotal} 条` : ''}`;
    const stopHint = videoTotal ? '停止后，尚未开始的内容暂停排队。' : '停止会取消尚未开始项，并请求当前篇收尾。';
    const headingStatus = [b.created_at,statusName(b.status)].filter(Boolean).map(e).join(' · ');
    return `${action('back','返回客户列表')}<header class="customer-heading batch-heading"><div><h1>生成批次</h1><p>${headingStatus}</p></div><div class="batch-heading-actions">${action('refresh-batch','刷新')}${download}${continueAction}</div></header><p class="batch-progress" role="status">${progress}</p><p class="helper">已完成项会保留。${stopHint}</p>${articles}${batchVideoResults(b,statusName)}`;
  }
  editClient(existing = null) {
    const c = existing || {name:'',profile:{}};
    const field = ([key,label]) => `<label class="field"><span>${label}</span><input name="${key}" value="${e(key === 'name' ? c.name : c.profile?.[key] || '')}" ${key === 'name' ? 'required maxlength="100"' : 'maxlength="4000"'}></label>`;
    this.modal(existing ? '编辑客户档案' : '新建客户', `<div class="form-grid">${PROFILE_FIELDS.slice(0,5).map(field).join('')}</div><details><summary>联系方式</summary><div class="form-grid">${PROFILE_FIELDS.slice(5).map(field).join('')}</div></details>`, async data => {
      const saved = await this.service.saveClient(existing?.id, String(data.get('name')).trim(), Object.fromEntries(PROFILE_FIELDS.slice(1).map(([key]) => [key, String(data.get(key) || '').trim()])));
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
  async prepareBatch() {
    if (this.service.pending) { await this.showBatch(await this.service.retrySubmission()); return; }
    const ids = [...this.selected]; if (!ids.length) throw new Error('先选择需要生成内容的客户');
    const plans = await Promise.all(ids.map(async id => ({client_id:id, ...await this.service.plan(id)})));
    const names = id => this.client.state.clients.find(c => c.id === id)?.name || id;
    const editor = document.createElement('div');
    editor.dataset.batchEditor = '';
    editor.innerHTML = `<p>文章沿用客户常用方案。你可以调整本批篇数，也可以单独安排视频。</p>
      <label class="field"><span>本批内容方向 / 关键词（可选）</span><input name="batch-keywords" placeholder="留空沿用各客户方向"></label>
      <label class="field"><span>本批补充要求（可选）</span><textarea name="batch-note" rows="2" placeholder="追加到各客户长期要求"></textarea></label>
      <p data-batch-video-limit aria-live="polite"></p>${plans.map(({client_id,plan},i) => `<details class="batch-client" data-batch-client="${i}" ${plans.length === 1 ? 'open' : ''}>
      <summary>${e(names(client_id))} · ${e(planSummary(plan.options,this.client.platforms).text)}</summary>
      <label class="check-label"><input type="checkbox" data-batch-articles checked>安排文章</label>
      <fieldset class="batch-article-platforms" aria-label="文章发布安排">${this.platformFields(plan.options,`batch-${i}`)}</fieldset>
      ${videoPlanner()}</details>`).join('')}`;
    updateVideoLimit(editor);
    const showEditor = () => this.modal('本批生成安排', editor, preflight, '检查本批安排');
    const preflight = async data => {
      const direction = splitWords(data.get('batch-keywords'));
      const note = String(data.get('batch-note') || '').trim();
      const items = plans.map(({client_id,plan},i) => {
        const customer = editor.querySelector(`[data-batch-client="${i}"]`);
        try {
          const base = planOptions(plan.options);
          if (direction.length) base.keywords = direction;
          if (note) base.note = [base.note,note].filter(Boolean).join('\n');
          const options = customer.querySelector('[data-batch-articles]').checked
            ? planOptions(this.collectPlatforms(customer,base))
            : {...base, selections:[], format_overrides:{}};
          const articleCount = options.selections.reduce((count, selection) => count + selection.count, 0);
          const videos = collectBatchVideos(customer,articleCount);
          return videos.length ? {client_id, options, videos} : {client_id, options};
        } catch (error) {
          customer.open = true;
          throw new Error(`${names(client_id)}：${error.message}`);
        }
      });
      assertBatchVideoLimit(items);
      const check = await this.service.preflight(items);
      const review = document.createElement('div');
      review.innerHTML = `${batchConfirmation(check,names,this.client.platforms)}<button type="button" class="button quiet">返回修改</button>`;
      review.querySelector('button').onclick = () => { if (!this.busy) showEditor(); };
      this.modal('确认本批安排', review, check.ready ? async () => this.showBatch(await this.service.submit(items)) : null, '加入生成队列');
      return false;
    };
    showEditor();
  }
  async showBatch(batch) { this.batch = batch; this.monitor.start(batch); this.render(); }
  async perform(name, el) {
    const id = el.dataset.id;
    if (name === 'close-dialog') { this.dialog.close(); return; }
    if (name === 'back') { this.id = null; this.batch = null; this.monitor.start(null); this.intake.stop(); this.render(); return; }
    if (name === 'detail' || name === 'open-plan') return this.detail(id,name === 'open-plan' ? 'plan' : 'profile');
    if (name === 'tab') { this.tab = el.dataset.tab; if (this.tab === 'intake') { this.intake.stop(); await this.intake.load(this.id); if (this.intake.record?.status === 'running') this.intake.watch(60); } else this.intake.stop(); this.render(); return; }
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
    if (name === 'new-client') return this.editClient();
    if (name === 'edit-client') return this.editClient(this.customer);
    if (name === 'create-task') { this.leave(); return this.newTask(id); }
    if (name === 'open-task') { this.dialog.close(); this.leave(); return this.openTask(id); }
    if (name === 'select-visible') { for (const input of document.querySelectorAll('[data-customer-select]')) this.selected.add(input.dataset.customerSelect); this.render(); return; }
    if (name === 'clear-selection') { this.selected.clear(); this.render(); return; }
    if (name === 'save-plan') {
      const root = document.getElementById('customer-plan'), data = new FormData(root);
      const options = planOptions(this.collectPlatforms(root,{...this.planData.plan.options,keywords:splitWords(data.get('keywords')),note:String(data.get('note')).trim()}));
      this.planData = await this.service.savePlan(this.id,{options,document_ids:data.getAll('documents'),expected_revision:this.planData.plan.revision});
      this.render(); this.toast('常用方案已保存，新任务将带出此安排'); return;
    }
    if (name === 'upload') { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.accept = '.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv,.json,.html,.pdf'; input.onchange = () => this.run(() => this.importFiles([...input.files])); input.click(); return; }
    if (name === 'paste') { this.modal('粘贴客户资料','<label class="field"><span>资料名称</span><input name="filename" required value="粘贴资料"></label><label class="field"><span>正文</span><textarea name="text" required rows="10"></textarea></label>',async data => { const result = await this.service.addDocument(this.id,{filename:String(data.get('filename')),text:String(data.get('text'))}); if (!result.document || result.outcome === 'needs_resolution') throw new Error('同名资料已存在，请从资料列表明确选择修订对象'); await this.detail(this.id,'documents'); }); return; }
    if (name === 'document') { const d = this.documents.find(d => d.id === id); this.modal(d.filename,`<label class="field"><span>解析正文</span><textarea name="text" rows="14">${e(d.text || '')}</textarea></label>`, async data => { const result = await this.service.addDocument(this.id,{filename:d.filename,kind:d.kind,text:String(data.get('text')),update_document_id:d.id}); if (!result.document || !usable(result.document)) throw new Error(result.document?.error || '修订尚未成为有效资料'); await this.detail(this.id,'documents'); },'保存新修订'); return; }
    if (name === 'revisions') { const docs = await this.service.revisions(this.id,id); this.modal('资料修订历史',docs.map(d => `<div class="customer-document"><span>${e(d.filename)} · 修订 ${d.revision || 1} · ${e(statusName(d.status))}</span><div>${d.has_original ? `<a class="button quiet" download href="${e(this.service.path(this.id,`/documents/${encodeURIComponent(d.id)}/original`))}">原件</a>` : ''}<a class="button quiet" download href="${e(this.service.path(this.id,`/documents/${encodeURIComponent(d.id)}/text`))}">文字</a></div></div>`).join(''),null); return; }
    if (name === 'batch-prepare') return this.prepareBatch();
    if (name === 'batch-video-add') return addBatchVideo(el.closest('[data-batch-editor]'),el.closest('.batch-video-planner'));
    if (name === 'batch-video-remove') {
      const planner = el.closest('.batch-video-planner');
      el.closest('[data-batch-video-row]').remove();
      updateVideoLimit(planner.closest('[data-batch-editor]'));
      planner.querySelector('[data-customer-action="batch-video-add"]').focus();
      return;
    }
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
  dispose() { this.monitor.dispose(); this.intake.stop(); }
}
