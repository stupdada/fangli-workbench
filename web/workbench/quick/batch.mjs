
import { BatchMonitor, activeBatch, canonical } from '../customers-client.mjs';
import { readBrowserDraft, writeBrowserDraft } from '../browser-draft.mjs';
import { planOptions } from '../customer-platforms.mjs';
import { MAX_BATCH_VIDEOS, assertBatchVideoLimit, batchVideoResults, installBatchVideoStyles } from '../customer-batch-video.mjs';
import { articleBody, enabled, escapeHTML as e, markdown, optionIssues, splitWords } from '../model.mjs';
import { accountCapacity, distributeCount } from './counts.mjs';
import { articleLengthHint } from './article-length.mjs';
import { createBatchPreview } from './preview.mjs';

const statuses = {queued:'排队中', running:'生成中', done:'已完成', partial:'部分完成', error:'失败', stopped:'已停止', interrupted:'中断待确认'};
const accountTypes = {official:'官方号', personal:'个人号'};
const workspace = '/workbench/zip/index.html';
const draftKey = 'fangli.quick-creation.draft.v1';
const accountKey = item => `${item.platform_id}:${item.account_type}`;
const chevron = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function createQuickCreation(client, service, { onBatch, openDocuments, newCustomer }) {
  const root = document.createElement('section');
  root.className = 'quick-main';
  root.innerHTML = `
    <div class="quick-heading"><h1>快速创作</h1><button type="button" class="quick-toggle" data-expand aria-expanded="false" aria-controls="quick-details" aria-label="展开客户安排"><span>展开安排</span>${chevron}</button></div>
    <form class="quick-form" novalidate>
      <div class="quick-controls">
        <div class="quick-customer-controls">
          <details class="quick-customer-picker"><summary><span data-picked-count>选择客户</span>${chevron}</summary>
            <div class="quick-picker-pop">
              <label><span class="sr-only">搜索客户</span><input type="search" data-picker-search placeholder="搜索客户"></label>
              <div class="quick-picker-list"></div>
            </div>
          </details>
          <button class="quick-select-all" type="button" data-select-all>全选</button>
        </div>
        <label class="quick-count"><span>每客户篇数</span><input type="number" min="1" max="2000" step="1" inputmode="numeric" name="count" placeholder="沿用" aria-describedby="quick-count-limit"></label>
        <div class="quick-length quick-bulk-length" role="group" aria-label="统一文章篇幅">
          <span>文章篇幅</span><button type="button" data-length="长篇" aria-pressed="false">长</button><button type="button" data-length="短篇" aria-pressed="false">短</button>
          <span class="quick-mixed" data-mixed hidden>各客户设置</span>
        </div>
        <details class="quick-customer-picker quick-video-picker" data-video-picker>
          <summary><span data-video-label>＋ 添加视频</span>${chevron}</summary>
          <div class="quick-picker-pop"><p class="muted">设置每位客户的视频条数</p><div data-video-options></div></div>
        </details>
        <button class="button primary quick-submit" type="submit">开始生成</button>
      </div>
      <p class="quick-batch-totals" data-batch-totals role="status" hidden></p>
      <p class="quick-batch-totals" data-draft-status role="status" hidden></p>
      <p class="error-text quick-error" id="quick-count-limit" role="status" hidden></p>
      <p class="error-text quick-error" data-quick-error role="alert" hidden></p>
      <div id="quick-details" class="quick-detail-shell" inert><div class="quick-detail-clip"><div class="quick-details">
        <aside class="quick-clients" aria-label="本批客户">
          <label class="quick-search"><span class="sr-only">搜索客户</span><input type="search" placeholder="搜索客户"></label>
          <div class="quick-client-list"></div>
        </aside>
        <div class="quick-client-work">
          <div class="quick-batch-progress" hidden>
            <span data-batch-status role="status"></span><a data-action="open-quick-batch">批次管理</a>
          </div>
          <div class="quick-client-heading" hidden>
            <h2></h2>
            <div class="quick-view-switch" hidden><button type="button" data-quick-view="plan">安排</button><button type="button" data-quick-view="result">生成结果</button></div>
          </div>
          <p class="quick-empty" data-no-client>请选择客户。</p>
          <fieldset class="quick-plans"></fieldset>
          <section class="quick-result" aria-label="客户稿件" hidden></section>
        </div>
      </div></div></div>
    </form>`;
  const $ = selector => root.querySelector(selector);
  const form = $('form'), button = $('[type=submit]'), all = $('[data-select-all]');
  const preview = createBatchPreview(root, (...args)=>service.batchTopics(...args));
  const expand = $('[data-expand]'), details = $('.quick-detail-shell'), plansRoot = $('.quick-plans');
  const customerPicker = $('.quick-customer-picker'), pickerSearch = $('[data-picker-search]'), pickerList = $('.quick-picker-list');
  const videoPicker = $('[data-video-picker]'), videoOptions = $('[data-video-options]');
  const lifetime = new AbortController();
  const choices = $('.quick-client-list'), search = $('.quick-search input'), countField = form.elements.count;
  const heading = $('.quick-client-heading'), viewSwitch = $('.quick-view-switch');
  const errorBox = $('[data-quick-error]'), result = $('.quick-result');
  const progress = $('.quick-batch-progress'), status = $('[data-batch-status]'), batchLink = $('[data-action="open-quick-batch"]');
  const selected = new Set(), plans = new Map(), articles = new Map(), issues = new Map();
  const videoSettings = new Map();
  const edits = new Map();
  let batch = null, submitting = false, initialized = false, currentId = null, view = 'plan', length = '', resultKey = '';
  let repairAfterSubmit = null;
  let draftSaved = false, documentsToRefresh = null;
  let itemsByClient = new Map();

  function idName(id) { return client.state.clients.find(customer => customer.id === id)?.name || itemsByClient.get(id)?.name || '客户'; }
  function platformName(id) { return client.platforms.find(platform => String(platform.id) === String(id))?.name || `平台 ${id}`; }
  function setError(message) { errorBox.textContent = message; errorBox.hidden = !message; }
  function draftStatus(message) {
    $('[data-draft-status]').textContent = message;
    $('[data-draft-status]').hidden = !message;
  }
  function rememberDraft(entry) {
    if (entry?.options) {
      const draft = {};
      for (const key of ['selections','format_overrides']) {
        if (canonical(entry.options[key]) !== canonical(entry.base[key])) draft[key] = entry.options[key];
      }
      const keywords = entry.words.filter(word=>entry.keywords.has(word));
      if (canonical(keywords) !== canonical(entry.base.keywords)) draft.keywords = keywords;
      const note = entry.row.querySelector('textarea').value;
      const keywordInput = entry.row.querySelector('[data-keyword-entry]').value;
      if (note !== (entry.base.note || '')) draft.note = note;
      if (keywordInput) draft.keywordInput = keywordInput;
      if (entry.manual) draft.manual = true;
      if (entry.length !== undefined) draft.length = entry.length;
      if (entry.documentOverride !== undefined) draft.documentIds = entry.documentOverride;
      const id = entry.row.dataset.clientId;
      if (Object.keys(draft).length) edits.set(id,structuredClone(draft));
      else edits.delete(id);
    }
    draftSaved = writeBrowserDraft(draftKey,{
      selected: [...selected], count:countField.value, length, currentId, expanded:!details.inert,
      clients:Object.fromEntries(edits), videos:Object.fromEntries(videoSettings),
    });
    if (!draftSaved) draftStatus('当前浏览器未能保存本批安排。');
  }
  function batchCount() {
    if (!countField.validity.valid) throw new Error('每客户篇数须为 1 至 2000 的整数，留空沿用方案');
    return countField.value ? countField.valueAsNumber : null;
  }
  function selectionsFor(entry) {
    return entry.manual ? entry.options.selections : distributeCount(entry.options.selections,batchCount());
  }
  function capacityGap(entry) {
    const capacity = accountCapacity(entry.options.selections);
    return !entry.manual && capacity > 0 && countField.valueAsNumber > capacity ? capacity : 0;
  }
  function accountRows(entry) {
    try { return selectionsFor(entry); }
    catch { return entry.options.selections; }
  }
  function clientProblem(id) {
    const entry = plans.get(id);
    if (!entry || entry.loading) return '';
    if (entry.error) return entry.error;
    if (issues.has(id)) return issues.get(id);
    const capacity = capacityGap(entry);
    if (capacity) return capacityMessage(capacity);
    try {
      const options = readOptions(entry);
      const problems = optionIssues(options,client.platforms,client.targets);
      if (!options.selections.length && !videoSettings.get(id)?.count) problems.push('请选择平台和账号，或添加视频');
      if (options.selections.length && !options.keywords.length) problems.push('请填写目标关键词');
      if (videoSettings.get(id)?.count && !documentIdsFor(entry).length) problems.push('制作视频需要客户资料');
      return problems.join('；');
    } catch (error) { return error.message; }
  }
  function setExpanded(open) {
    customerPicker.open = false;
    details.inert = !open;
    root.classList.toggle('is-expanded',open);
    expand.setAttribute('aria-expanded',String(open));
    expand.setAttribute('aria-label',open ? '收起客户安排' : '展开客户安排');
    expand.querySelector('span').textContent = open ? '收起安排' : '展开安排';
    if (open && !currentId) {
      showClient(batch?.items[0]?.client_id || selected.values().next().value || client.state.clients[0]?.id, batch ? 'result' : 'plan');
    } else refresh();
  }

  function renderChoices() {
    const term = search.value.trim().toLocaleLowerCase();
    choices.innerHTML = client.state.clients.filter(customer => customer.name.toLocaleLowerCase().includes(term)).map(customer => `
      <div class="quick-client-row" data-quick-row="${e(customer.id)}">
        <input type="checkbox" data-client-choice="${e(customer.id)}" aria-label="选择 ${e(customer.name)}">
        <button type="button" data-client-view="${e(customer.id)}" title="${e(customer.name)}"><span>${e(customer.name)}</span><small></small></button>
      </div>`).join('') || '<p class="quick-empty">没有匹配的客户</p>';
    refreshChoices();
  }
  function renderPicker() {
    const term = pickerSearch.value.trim().toLocaleLowerCase();
    pickerList.innerHTML = client.state.clients.filter(customer=>customer.name.toLocaleLowerCase().includes(term)).map(customer=>
      `<label><input type="checkbox" data-client-choice="${e(customer.id)}" ${selected.has(customer.id) ? 'checked' : ''}><span>${e(customer.name)}</span></label>`
    ).join('') || '<p class="quick-empty">没有匹配的客户</p>';
  }
  function refreshChoices() {
    const locked = submitting || activeBatch(batch) || Boolean(service.pending);
    for (const row of choices.children) {
      const id = row.dataset.quickRow;
      if (!id) continue;
      const entry = plans.get(id), item = itemsByClient.get(id);
      const input = row.querySelector('input'), link = row.querySelector('button'), summary = link.querySelector('small');
      input.disabled = locked;
      input.checked = selected.has(id);
      if (id === currentId) link.setAttribute('aria-current','true'); else link.removeAttribute('aria-current');
      const problem = selected.has(id) && clientProblem(id);
      summary.classList.toggle('needs-attention',Boolean(problem && !(view === 'result' && item)));
      summary.textContent = view === 'result' && item ? `${statuses[item.status]} · ${item.completed}/${item.planned}` :
        problem ? '待补齐' : entry?.options ? `${accountRows(entry).reduce((sum,item)=>sum+item.count,0)} 篇` :
        selected.has(id) ? '读取中' : '';
    }
    for (const input of pickerList.querySelectorAll('input')) input.checked = selected.has(input.dataset.clientChoice);
  }
  function setSelection(ids) {
    selected.clear();
    for (const id of ids) if (client.state.clients.some(customer => customer.id === id)) selected.add(id);
    refreshSelection();
  }
  function refreshSelection() {
    for (const id of selected) if (!plans.has(id)) void loadPlan(id);
    for (const [id, entry] of plans) {
      if (selected.has(id) || id === currentId) {
        if (entry.row.parentElement !== plansRoot) plansRoot.append(entry.row);
      } else entry.row.remove();
    }
    refresh();
  }

  function renderAccounts(entry) {
    const rows = accountRows(entry);
    const accounts = entry.row.querySelector('[data-accounts]');
    accounts.innerHTML = rows.map(item => {
      const name = `${platformName(item.platform_id)}${accountTypes[item.account_type]}`;
      const platform = client.platforms.find(p => p.id === item.platform_id);
      return `<div class="quick-account-row"><strong>${e(name)}${!platform || !enabled(platform) ? ' <small>已停用</small>' : ''}</strong>
        <label><span class="sr-only">${e(name)}篇数</span><input type="number" min="1" max="20" step="1" data-account-count="${e(accountKey(item))}" value="${item.count}"> 篇</label>
        <button type="button" class="quick-text-button" data-remove-account="${e(accountKey(item))}" aria-label="移除${e(name)}">移除</button></div>`;
    }).join('') || '<p class="quick-empty">请选择本次发布的平台和账号。</p>';
    const picker = entry.row.querySelector('[data-add-picker]');
    picker.querySelector('.quick-account-choices').innerHTML = client.platforms.filter(enabled).flatMap(platform => Object.entries(accountTypes).map(([type,label]) => {
      const key = accountKey({platform_id:platform.id,account_type:type});
      return rows.some(item => accountKey(item) === key) ? '' : `<button type="button" data-add-account="${e(key)}">${e(platform.name)}<span>${label}</span></button>`;
    })).join('') || '<p class="quick-empty">已选全部可用账号</p>';
    const formats = entry.row.querySelector('[data-quick-formats]');
    const platforms = client.platforms.filter(p => enabled(p) && rows.some(item => item.platform_id === p.id));
    formats.hidden = !platforms.length;
    formats.querySelector('.quick-formats').innerHTML = platforms.map(platform => {
      const chosen = entry.options.format_overrides?.[platform.id] ?? platform.formats;
      return `<div><strong>${e(platform.name)}</strong><div>${platform.formats.map(format=>`<label><input type="checkbox" data-quick-format="${e(platform.id)}" value="${e(format)}" ${chosen.includes(format) ? 'checked' : ''}>${e(format)}</label>`).join('')}</div></div>`;
    }).join('');
  }

  function renderKeywords(entry) {
    entry.row.querySelector('.quick-keywords').innerHTML = entry.words.map(word=>
      `<label><input type="checkbox" data-quick-keyword="${e(word)}" ${entry.keywords.has(word) ? 'checked' : ''}><span>${e(word)}</span></label>`
    ).join('');
  }
  function addKeywords(entry) {
    const input = entry.row.querySelector('[data-keyword-entry]');
    const words = splitWords(input.value);
    if (!words.length) return;
    entry.words = [...new Set([...entry.words,...words])];
    for (const word of words) entry.keywords.add(word);
    input.value = '';
    renderKeywords(entry);
    issues.delete(entry.row.dataset.clientId);
    setError('');
    rememberDraft(entry);
    refresh();
  }
  function lengthFor(entry) { return entry?.length ?? length; }
  function refreshLength() {
    const values = new Set([...selected].map(id=>lengthFor(plans.get(id))));
    const mixed = values.size > 1;
    const value = mixed ? null : values.values().next().value ?? length;
    $('[data-mixed]').hidden = !mixed;
    for (const control of root.querySelectorAll('[data-length]')) control.setAttribute('aria-pressed',String(control.dataset.length === value));
    return value;
  }
  function showLength(entry) {
    const preset = lengthFor(entry), row = entry.row;
    for (const control of row.querySelectorAll('[data-client-length]')) control.setAttribute('aria-pressed',String(control.dataset.clientLength === preset));
    const note = row.querySelector('textarea').value;
    const formats = new Map();
    for (const item of accountRows(entry)) formats.set(item.platform_id,Math.max(item.count,formats.get(item.platform_id) || 0));
    const hints = client.platforms.filter(platform=>enabled(platform) && formats.has(platform.id)).flatMap(platform=>
      (entry.options.format_overrides?.[platform.id] ?? platform.formats).slice(0,formats.get(platform.id)).map(format=>{
        const hint = articleLengthHint(platform,format,preset,note,entry.options.note);
        return `<div><dt>${e(platform.name)} · ${e(format === '短视频' ? '短视频文案' : format)}</dt><dd>${e(hint || '按平台规则')}</dd></div>`;
      })
    );
    row.querySelector('.quick-length-hints').innerHTML = hints.join('');
  }

  async function loadPlan(id) {
    const row = document.createElement('section');
    row.className = 'quick-plan';
    row.dataset.clientId = id;
    row.hidden = id !== currentId || view !== 'plan';
    row.innerHTML = '<p class="quick-empty" role="status">正在读取安排…</p>';
    const entry = {row, loading:true, manual:false};
    plans.set(id,entry);
    plansRoot.append(row);
    try {
      const {plan,available_keywords = []} = await service.plan(id);
      const draft = edits.get(id) || {};
      entry.base = planOptions(plan.options);
      entry.options = planOptions({...entry.base,...draft});
      entry.manual = Boolean(draft.manual);
      entry.length = draft.length;
      entry.documentIds = plan.document_ids || [];
      entry.documentOverride = draft.documentIds;
      entry.keywords = new Set(entry.options.keywords);
      entry.words = [...new Set([...entry.keywords,...(entry.base.keywords || []),...available_keywords])];
      row.innerHTML = `<div class="quick-platform-head"><h3>发布安排</h3>
        <details class="quick-add" data-add-picker><summary>添加平台</summary><div class="quick-account-choices"></div></details>
      </div>
      <div data-accounts></div>
      <div class="quick-length-row"><h3>文章篇幅</h3><div class="quick-length" role="group" aria-label="该客户文章篇幅">
        <button type="button" data-client-length="">沿用</button><button type="button" data-client-length="长篇">长</button><button type="button" data-client-length="短篇">短</button>
      </div></div>
      <dl class="quick-length-hints"></dl>
      <div class="quick-keyword-section"><h3>目标关键词</h3><div class="quick-keywords"></div>
        <div class="quick-keyword-add"><input data-keyword-entry maxlength="500" aria-label="添加本批关键词" placeholder="输入关键词，回车添加"><button type="button" class="quick-text-button" data-add-keywords>添加</button></div>
      </div>
      <details class="quick-extra" data-client-note><summary>补充要求</summary><label class="quick-field"><span class="sr-only">${e(idName(id))}的补充要求</span><textarea rows="3" maxlength="20000" placeholder="填写该客户本次的写作要求"></textarea></label></details>
      <details class="quick-extra" data-quick-documents>
        <summary><span data-document-summary>本批资料</span></summary>
        <div data-document-options></div>
        <div class="inline-actions">
          <button type="button" class="quick-text-button" data-reset-documents hidden>沿用常用资料</button>
          <button type="button" class="button quiet sm" data-open-documents>去客户资料补录</button>
        </div>
      </details>
      <details class="quick-extra" data-quick-formats hidden><summary>发布形态</summary><div class="quick-formats"></div></details>
      <p class="error-text quick-error" data-client-error hidden></p>`;
      row.querySelector('textarea').value = draft.note ?? entry.base.note ?? '';
      row.querySelector('[data-keyword-entry]').value = draft.keywordInput || '';
      if (row.querySelector('textarea').value.trim()) row.querySelector('[data-client-note] summary').textContent = '补充要求 · 已填写';
      renderAccounts(entry);
      renderKeywords(entry);
      syncDocumentSummary(entry);
    } catch (error) {
      entry.error = error.message;
      row.innerHTML = `<p class="error-text">${e(error.message)}</p><button class="button quiet" type="button" data-reload-plan>重新读取</button>`;
    } finally {
      entry.loading = false;
      refresh();
    }
  }

  function readOptions(entry) {
    const selections = selectionsFor(entry);
    const options = planOptions(entry.options);
    options.selections = selections;
    options.keywords = entry.words.filter(word=>entry.keywords.has(word));
    options.note = entry.row.querySelector('textarea').value.trim();
    options.format_overrides = Object.fromEntries(Object.entries(options.format_overrides || {}).filter(([id])=>selections.some(item=>String(item.platform_id)===id)));
    const preset = lengthFor(entry);
    if (preset) options.length_hint = preset;
    return options;
  }

  function documentIdsFor(entry) { return entry.documentOverride ?? entry.documentIds; }
  function syncDocumentSummary(entry) {
    const count = documentIdsFor(entry).length;
    entry.row.querySelector('[data-document-summary]').textContent = count ? `本批资料 · ${count} 份` : '本批资料';
    entry.row.querySelector('[data-reset-documents]').hidden = entry.documentOverride === undefined;
  }
  function renderDocumentOptions(entry) {
    const target = entry.row.querySelector('[data-document-options]');
    const selectedIds = new Set(documentIdsFor(entry));
    const documents = entry.availableDocuments || [];
    const missing = [...selectedIds].some(id=>!documents.some(doc=>doc.id === id));
    target.innerHTML = entry.documentError ? `<p class="error-text" role="status">${e(entry.documentError)}</p>` :
      (missing ? '<p class="quick-empty">部分已选资料已移出或有新修订，可重新选择。</p>' : '') +
      (documents.length ? documents.map(doc=>`<label class="quick-document-choice">
        <input type="checkbox" data-quick-document value="${e(doc.id)}" ${selectedIds.has(doc.id)?'checked':''}>
        <span>${e(doc.filename)} <small>修订 ${e(doc.revision)}</small></span>
      </label>`).join('') : '<p class="quick-empty">暂无可用的正文资料。</p>');
  }
  function loadDocuments(entry) {
    if (entry.documentRequest) return entry.documentRequest;
    if (entry.availableDocuments) return Promise.resolve();
    const target = entry.row.querySelector('[data-document-options]');
    target.innerHTML = '<p class="quick-empty" role="status">正在读取客户资料…</p>';
    entry.documentRequest = service.documents(entry.row.dataset.clientId).then(documents=>{
      entry.documentError = '';
      entry.availableDocuments = documents.filter(doc=>doc.is_current && doc.status === 'ready' && doc.text?.trim());
    }).catch(error=>{ entry.documentError = error.message; }).finally(()=>{
      entry.documentRequest = null;
      renderDocumentOptions(entry);
    });
    return entry.documentRequest;
  }

  function changeAccountMembership(entry, key, adding) {
    const [id,type] = key.split(':');
    const visible = accountRows(entry);
    const selection = {platform_id:Number(id),account_type:type,count:1};
    entry.options.selections = entry.options.selections.filter(item=>accountKey(item) !== key);
    if (adding) {
      entry.options.selections.push(selection);
      if (!accountRows(entry).some(item=>accountKey(item) === key)) {
        entry.options.selections = [...visible,selection];
        entry.manual = true;
      }
    }
  }
  function showVideoOptions() {
    const active = document.activeElement;
    const videoClient = active?.dataset.videoCount || active?.dataset.videoNarration;
    const total = [...selected].reduce((sum,id)=>sum + (videoSettings.get(id)?.count || 0),0);
    videoOptions.innerHTML = [...selected].map(id=>{
      const {count = 0, narration = true} = videoSettings.get(id) || {};
      const maximum = Math.max(count, MAX_BATCH_VIDEOS - total + count);
      return `<div class="quick-video-option">
        <label><span>${e(idName(id))}</span><select data-video-count="${e(id)}" aria-label="${e(idName(id))}视频条数">
          ${Array.from({length:maximum + 1},(_,n)=>`<option value="${n}" ${n === count ? 'selected' : ''}>${n} 条</option>`).join('')}
        </select></label>
        ${count ? `<label class="check-label"><input type="checkbox" data-video-narration="${e(id)}" ${narration ? 'checked' : ''}>普通话配音</label>` : ''}
      </div>`;
    }).join('') || '<p class="muted">请先选择客户</p>';
    if (videoClient) {
      const attribute = active.dataset.videoCount ? 'data-video-count' : 'data-video-narration';
      videoOptions.querySelector(`[${attribute}="${CSS.escape(videoClient)}"]`)?.focus();
    }
  }
  function refresh() {
    const pending = Boolean(service.pending), active = activeBatch(batch), locked = submitting || active || pending;
    const ids = [...selected];
    const chosen = ids.map(id=>plans.get(id)).filter(Boolean);
    const loading = chosen.some(entry=>entry.loading);
    const total = chosen.reduce((sum,entry)=>sum + (entry.options ? accountRows(entry).reduce((n,item)=>n+item.count,0) : 0),0);
    const videoTotal = ids.reduce((sum,id)=>sum + (videoSettings.get(id)?.count || 0),0);
    const next = pending || active || loading || submitting ? null : nextAction();
    const limited = !active && !pending && chosen.find(entry=>entry.options && capacityGap(entry));
    const countLimit = $('#quick-count-limit');
    countLimit.hidden = !limited;
    countLimit.textContent = limited ? `${idName(limited.row.dataset.clientId)}：${capacityMessage(capacityGap(limited))}` : '';
    const totals = $('[data-batch-totals]');
    totals.hidden = !ids.length || loading || pending || (!active && (!countField.validity.valid || limited));
    totals.textContent = active ? `文章 ${batch.total} 篇 · 视频 ${batch.video_total || 0} 条` : `文章 ${total} 篇 · 视频 ${videoTotal} 条`;
    const allSelected = ids.length > 0 && ids.length === client.state.clients.length;
    all.disabled = !client.state.clients.length || locked;
    all.textContent = allSelected ? '清空' : '全选';
    all.setAttribute('aria-label',allSelected ? '清空客户选择' : '全选客户');
    $('[data-picked-count]').textContent = ids.length ? `已选 ${ids.length} 位` : '选择客户';
    customerPicker.inert = locked;
    videoPicker.inert = locked;
    $('[data-video-label]').textContent = videoTotal ? `视频 ${videoTotal} 条` : '＋ 添加视频';
    if (videoPicker.open) showVideoOptions();
    countField.disabled = locked;
    for (const control of root.querySelectorAll('[data-length]')) control.disabled = locked;
    refreshLength();
    plansRoot.disabled = locked;
    button.disabled = submitting || active || !pending && loading;
    button.textContent = submitting ? '正在准备…' : active ? '生成中…' : pending ? '恢复本次提交' :
      loading ? '读取安排…' : next?.label || (details.inert ? generateLabel(total,videoTotal) : '预览安排');
    expand.disabled = submitting;
    for (const [id, entry] of plans) {
      entry.row.hidden = id !== currentId || view !== 'plan';
      const error = entry.row.querySelector('[data-client-error]');
      if (error) {
        const message = clientProblem(id);
        error.textContent = message;
        error.hidden = !message;
      }
      if (!entry.row.hidden && entry.options && !entry.error) showLength(entry);
    }
    refreshChoices();
  }

  function showClient(id, nextView = view) {
    currentId = id || null;
    view = nextView === 'result' && itemsByClient.has(id) ? 'result' : 'plan';
    heading.hidden = !id;
    heading.querySelector('h2').textContent = id ? idName(id) : '';
    $('[data-no-client]').hidden = Boolean(id);
    viewSwitch.hidden = !itemsByClient.has(id);
    for (const control of viewSwitch.querySelectorAll('button')) control.setAttribute('aria-pressed',String(control.dataset.quickView === view));
    if (id && view === 'plan' && !plans.has(id)) void loadPlan(id);
    refreshSelection();
    renderResult();
  }
  function generateLabel(articles,videos) {
    const quantities = [articles && `${articles} 篇文章`,videos && `${videos} 条视频`].filter(Boolean);
    return quantities.length ? '生成 ' + quantities.join('和 ') : '开始生成';
  }
  function capacityMessage(maximum) {
    return `现有账号最多安排 ${maximum} 篇，请减少每客户篇数或添加账号。`;
  }
  function clientGap(id) {
    const entry = plans.get(id);
    if (!entry || entry.loading) return null;
    if (entry.error) return {id, field:'[data-reload-plan]', label:'重新读取客户安排'};
    const capacity = capacityGap(entry);
    if (capacity) return {id, field:'[data-add-picker]', label:'调整每客户篇数'};
    const options = readOptions(entry);
    const videos = videoSettings.get(id)?.count;
    const invalid = optionIssues(options,client.platforms,client.targets);
    if (!options.selections.length && !videos) return {id, field:'[data-add-picker]', label:'先安排创作内容'};
    if (options.selections.length && !options.keywords.length) return {id, field:'[data-keyword-entry]', label:'先补充关键词'};
    if (invalid.some(message=>message.startsWith('平台 '))) return {id, field:'[data-remove-account]', label:'调整发布平台'};
    if (invalid.some(message=>message.includes('发布形态'))) return {id, field:'[data-quick-formats]', label:'调整发布形态'};
    const documentError = issues.get(id);
    if (videos && (!documentIdsFor(entry).length || documentError?.includes('需要选择本次客户资料'))) {
      return {id, field:'[data-quick-documents]', label:'补充视频资料'};
    }
    if (documentError && /选定资料|常用资料|视频资料每份/.test(documentError)) {
      return {id, field:'[data-quick-documents]', label:'调整本批资料'};
    }
    return null;
  }
  function nextAction() {
    if (!client.state.clients.length) return {addCustomer:true,label:'新建客户'};
    if (!selected.size) return {pick:true,label:'先选择客户'};
    if (!countField.validity.valid) return {count:true,label:'修正每客户篇数'};
    const gaps = [...selected].map(clientGap).filter(Boolean);
    return gaps.length > 1 ? {...gaps[0],label:`补齐 ${gaps.length} 位客户的安排`} : gaps[0];
  }
  function fixClient(id, field) {
    setExpanded(true);
    if (id) {
      if (search.value) { search.value = ''; renderChoices(); }
      showClient(id,'plan');
      let target = field && plans.get(id)?.row.querySelector(field);
      if (target?.tagName === 'DETAILS') {
        target.open = true;
        target = target.querySelector('summary');
      }
      if (!target) {
        target = heading.querySelector('h2');
        target.tabIndex = -1;
      }
      target.focus();
    }
  }
  function guide(gap) {
    if (gap.addCustomer) return newCustomer();
    if (gap.pick) { customerPicker.open = true; return; }
    if (gap.count) {
      setError('每客户篇数须为 1 至 2000 的整数，留空沿用方案');
      countField.focus();
      return;
    }
    fixClient(gap.id,gap.field);
  }
  function itemsForSubmit() {
    batchCount();
    if (selected.size > 100) throw new Error('每批最多提交 100 位客户，请调整本次选择');
    const items = [], invalid = [];
    for (const id of selected) {
      const entry = plans.get(id);
      try {
        if (entry.error) throw new Error(entry.error);
        const options = readOptions(entry);
        const {count = 0, narration = true} = videoSettings.get(id) || {};
        const videos = Array.from({length:count},()=>({source:'documents',narration}));
        const item = {client_id:id,options};
        if (videos.length) item.videos = videos;
        if (entry.documentOverride !== undefined) item.document_ids = entry.documentOverride;
        items.push(item);
      } catch (error) {
        issues.set(id,error.message);
        invalid.push(id);
      }
    }
    if (invalid.length) {
      repairAfterSubmit = {id:invalid[0]};
      throw new Error(`请检查 ${invalid.length} 位客户的本次安排`);
    }
    assertBatchVideoLimit(items);
    return items;
  }

  async function checkBeforeSubmit(items) {
    const check = await service.preflight(items);
    if (check.ready) return check.items;
    for (const issue of check.issues) if (issue.client_id) issues.set(issue.client_id,issue.error);
    const first = check.issues.find(issue=>issue.client_id);
    if (first) repairAfterSubmit = clientGap(first.client_id) || {id:first.client_id};
    throw new Error(issues.size ? `请检查 ${issues.size} 位客户的本次安排` : check.issues.map(issue=>issue.error).join('\n'));
  }

  async function arrangeAndSubmit(items, usePreview) {
    let notice = '';
    for (;;) {
      const planned = await checkBeforeSubmit(items);
      const choices = usePreview ? await preview.review(planned, items, notice) : await preview.useDefaults(planned, items);
      if (!choices) return null;
      const byClient = new Map(choices.map(({clientId,revision,rows})=>[clientId,{revision,rows}]));
      const confirmed = items.filter(item=>byClient.has(item.client_id))
        .map(item=>({...item,preview:byClient.get(item.client_id)}));
      try {
        return await service.submit(confirmed);
      } catch (error) {
        if (!usePreview || error.status !== 400 || !error.message.includes('预览依据已更新')) throw error;
        notice = '有客户的资料或安排已更新，请重新确认。其他客户的编辑已保留。';
      }
    }
  }

  function showArticle(disclosure) {
    const content = disclosure.querySelector('article');
    if (content.hasChildNodes()) return;
    const item = itemsByClient.get(currentId);
    const article = articles.get(item?.conversation_id)?.items.find(value=>value.id === disclosure.dataset.article);
    if (article) content.innerHTML = markdown(articleBody(article));
  }
  function renderResult() {
    const item = itemsByClient.get(currentId);
    result.hidden = view !== 'result' || !item;
    if (result.hidden) return;
    const entry = articles.get(item.conversation_id);
    const key = JSON.stringify([batch.id,item,entry?.error,entry?.items.map(article=>[article.id,article.current_version])]);
    if (key === resultKey) return;
    resultKey = key;
    const href = item.conversation_id ? `${workspace}?conversation=${encodeURIComponent(item.conversation_id)}` : '';
    const opened = new Set([...result.querySelectorAll('details[open]')].map(disclosure=>disclosure.dataset.article));
    const articlesProgress = item.planned ? `文章 ${item.completed} / ${item.planned} 篇` : '';
    const videosProgress = item.videos?.length ? `视频 ${item.videos.filter(video=>video.status==='done').length} / ${item.videos.length} 条` : '';
    result.innerHTML = `<div class="quick-result-status"><span>${[statuses[item.status],articlesProgress,videosProgress].filter(Boolean).join(' · ')}</span>
      ${href ? `<a href="${href}" data-task="${e(item.conversation_id)}">打开任务</a>` : ''}</div>
      ${item.error ? `<p class="error-text">${e(item.error)}</p>` : ''}
      ${entry?.error ? '<p class="error-text">稿件列表暂不可读取，可打开任务查看。</p>' : ''}
      ${(entry?.items || []).map(article=>`<details data-article="${e(article.id)}" ${opened.has(article.id) ? 'open' : ''}><summary>${e(article.title)}</summary><article></article></details>`).join('')}
      ${batchVideoResults({...batch,items:[item]},status=>statuses[status] || status,{retryInBatch:true})}`;
    result.querySelectorAll('details[open]').forEach(showArticle);
  }

  function updateBatch(value) {
    const isNew = batch?.id !== value.id;
    batch = value;
    itemsByClient = new Map(value.items.map(item=>[item.client_id,item]));
    progress.hidden = false;
    status.textContent = `${statuses[value.status] || '处理中'} · ${value.completed} / ${value.total} 篇${value.video_total ? ` · 视频 ${value.video_completed} / ${value.video_total} 条` : ''}`;
    batchLink.href = `${workspace}?area=customers&batch=${encodeURIComponent(value.id)}`;
    batchLink.dataset.batchId = value.id;
    if (isNew) {
      articles.clear();
      setExpanded(true);
      showClient(itemsByClient.has(currentId) ? currentId : value.items[0]?.client_id,'result');
    } else { refresh(); renderResult(); }
    onBatch(value);
    const pending = value.items.filter(item=>item.conversation_id && item.completed > 0 && articles.get(item.conversation_id)?.count !== item.completed);
    Promise.allSettled(pending.map(async item => {
      const entry = {count:item.completed,items:articles.get(item.conversation_id)?.items || []};
      articles.set(item.conversation_id,entry);
      try {
        const data = await client.api(`/api/workbench/conversations/${encodeURIComponent(item.conversation_id)}`);
        entry.items = data.articles.filter(article=>article.current_version && !article.locked);
      } catch { entry.error = true; }
    })).then(()=>{ if (batch?.id === value.id) renderResult(); });
  }

  const monitor = new BatchMonitor(service,updateBatch,error=>setError(`${error.message}。可打开批次管理继续查看。`));
  result.addEventListener('toggle',event=>{ if (event.target.matches('details[data-article][open]')) showArticle(event.target); },true);
  plansRoot.addEventListener('toggle',event=>{
    if (!event.target.matches('[data-quick-documents][open]')) return;
    const entry = plans.get(event.target.closest('[data-client-id]')?.dataset.clientId);
    if (entry?.options) void loadDocuments(entry);
  },true);
  search.addEventListener('input',renderChoices);
  pickerSearch.addEventListener('input',renderPicker);
  customerPicker.addEventListener('toggle',()=>{
    if (customerPicker.open) { renderPicker(); pickerSearch.focus(); }
  });
  customerPicker.addEventListener('keydown',event=>{
    if (event.key === 'Enter' && event.target === pickerSearch) event.preventDefault();
    if (event.key !== 'Escape') return;
    event.preventDefault();
    customerPicker.open = false;
    customerPicker.querySelector('summary').focus();
  });
  document.addEventListener('pointerdown',event=>{
    if (customerPicker.open && !customerPicker.contains(event.target)) customerPicker.open = false;
    if (videoPicker.open && !videoPicker.contains(event.target)) videoPicker.open = false;
  },{signal:lifetime.signal});
  form.addEventListener('change',event=>{
    const id = event.target.dataset.clientChoice;
    if (!id) return;
    if (event.target.checked) selected.add(id); else selected.delete(id);
    setError('');
    refreshSelection();
    rememberDraft();
  });
  choices.addEventListener('click',event=>{
    const id = event.target.closest('[data-client-view]')?.dataset.clientView;
    if (id) {
      showClient(id);
      if (!activeBatch(batch) && view === 'plan' && draftSaved) rememberDraft();
    }
  });
  expand.addEventListener('click',()=>{
    setExpanded(details.inert);
    if (!activeBatch(batch) && view === 'plan' && draftSaved) rememberDraft();
  });
  all.addEventListener('click',()=>{
    setError('');
    setSelection(selected.size === client.state.clients.length ? [] : client.state.clients.map(customer=>customer.id));
    rememberDraft();
  });
  countField.addEventListener('input',()=>{
    issues.clear();
    setError('');
    for (const entry of plans.values()) if (entry.options) {
      entry.manual = false;
      renderAccounts(entry);
    }
    for (const draft of edits.values()) delete draft.manual;
    rememberDraft();
    refresh();
  });
  viewSwitch.addEventListener('click',event=>{
    const next = event.target.closest('[data-quick-view]')?.dataset.quickView;
    if (next) showClient(currentId,next);
  });

  form.addEventListener('click',event=>{
    const action = event.target.closest('button');
    if (!action) return;
    if (action.hasAttribute('data-length')) {
      length = refreshLength() === action.dataset.length ? '' : action.dataset.length;
      for (const id of selected) {
        const entry = plans.get(id);
        if (entry) delete entry.length;
        const draft = edits.get(id);
        if (draft) delete draft.length;
        issues.delete(id);
      }
      setError('');
      rememberDraft();
      refresh();
      return;
    }
    const entry = plans.get(action.closest('[data-client-id]')?.dataset.clientId);
    if (!entry) return;
    const id = entry.row.dataset.clientId;
    setError('');
    if (action.hasAttribute('data-open-documents')) {
      documentsToRefresh = id;
      Promise.resolve(openDocuments(id)).catch(error=>setError(error.message));
      return;
    }
    if (action.hasAttribute('data-reset-documents')) {
      delete entry.documentOverride;
      syncDocumentSummary(entry);
      renderDocumentOptions(entry);
      issues.delete(id);
      rememberDraft(entry);
      refresh();
      return;
    }
    if (action.hasAttribute('data-client-length')) {
      entry.length = action.dataset.clientLength;
      issues.delete(id);
    }
    if (action.hasAttribute('data-add-keywords')) addKeywords(entry);
    if (action.hasAttribute('data-reload-plan')) {
      entry.row.remove();
      issues.delete(id);
      void loadPlan(id);
    }
    if (action.dataset.addAccount || action.dataset.removeAccount) {
      const adding = Boolean(action.dataset.addAccount);
      changeAccountMembership(entry,action.dataset.addAccount || action.dataset.removeAccount,adding);
      renderAccounts(entry);
      const picker = entry.row.querySelector('[data-add-picker]');
      picker.open = false;
      picker.querySelector('summary').focus();
      issues.delete(id);
    }
    if (action.hasAttribute('data-client-length') || action.dataset.addAccount || action.dataset.removeAccount) rememberDraft(entry);
    refresh();
  });

  plansRoot.addEventListener('keydown',event=>{
    if (event.key !== 'Enter' || event.isComposing || !event.target.matches('[data-keyword-entry]')) return;
    event.preventDefault();
    addKeywords(plans.get(event.target.closest('[data-client-id]').dataset.clientId));
  });
  plansRoot.addEventListener('input',event=>{
    const field = event.target;
    if (field.matches('[data-quick-format],[data-quick-keyword],[data-quick-document]')) return;
    const row = field.closest('[data-client-id]');
    if (!row) return;
    const entry = plans.get(row.dataset.clientId);
    if (field.matches('[data-account-count]')) {
      if (field.validity.valid && Number.isInteger(field.valueAsNumber)) {
        setAccountCount(entry,field.dataset.accountCount,field.valueAsNumber);
        rememberDraft(entry);
      }
      return;
    }
    issues.delete(row.dataset.clientId);
    setError('');
    if (field.matches('textarea')) row.querySelector('[data-client-note] summary').textContent = field.value.trim() ? '补充要求 · 已填写' : '补充要求';
    rememberDraft(entry);
    refresh();
  });
  plansRoot.addEventListener('change',event=>{
    const field = event.target;
    const entry = plans.get(field.closest('[data-client-id]')?.dataset.clientId);
    if (!entry) return;
    const id = entry.row.dataset.clientId;
    issues.delete(id);
    setError('');
    if (field.matches('[data-quick-document]')) {
      const documents = [...entry.row.querySelectorAll('[data-quick-document]:checked')].map(input=>input.value);
      if (documents.length > 100) {
        field.checked = false;
        setError('每位客户本批最多选择 100 份资料。');
      } else {
        entry.documentOverride = documents;
        syncDocumentSummary(entry);
        rememberDraft(entry);
      }
      refresh();
      return;
    }
    if (field.matches('[data-quick-keyword]')) {
      if (field.checked) entry.keywords.add(field.dataset.quickKeyword);
      else entry.keywords.delete(field.dataset.quickKeyword);
    }
    if (field.matches('[data-account-count]')) {
      const key = field.dataset.accountCount, value = field.valueAsNumber;
      if (!field.validity.valid || !Number.isInteger(value)) {
        field.value = accountRows(entry).find(item=>accountKey(item)===key).count;
        setError('每个账号的篇数须为 1 至 20 的整数');
      } else {
        setAccountCount(entry,key,value);
      }
    }
    if (field.matches('[data-quick-format]')) {
      const platformId = field.dataset.quickFormat;
      const formats = [...entry.row.querySelectorAll('[data-quick-format]:checked')].filter(input=>input.dataset.quickFormat===platformId).map(input=>input.value);
      entry.options.format_overrides = {...entry.options.format_overrides,[platformId]:formats};
    }
    if (field.matches('[data-quick-keyword],[data-account-count],[data-quick-format]')) rememberDraft(entry);
    refresh();
  });
  function setAccountCount(entry,key,count) {
    entry.options.selections = accountRows(entry).map(item=>accountKey(item) === key ? {...item,count} : item);
    entry.manual = true;
  }

  videoPicker.addEventListener('toggle',()=>{ if (videoPicker.open) showVideoOptions(); });
  videoPicker.addEventListener('keydown',event=>{
    if (event.key !== 'Escape' || !videoPicker.open) return;
    event.preventDefault();
    videoPicker.open = false;
    videoPicker.querySelector('summary').focus();
  });
  videoOptions.addEventListener('change',event=>{
    const field = event.target;
    const id = field.dataset.videoCount || field.dataset.videoNarration;
    const current = videoSettings.get(id) || {count:0,narration:true};
    videoSettings.set(id,field.dataset.videoCount ? {...current,count:Number(field.value)} : {...current,narration:field.checked});
    issues.delete(id);
    setError('');
    rememberDraft();
    refresh();
  });

  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if (button.disabled || submitting || activeBatch(batch)) return;
    const gap = service.pending ? null : nextAction();
    if (gap) {
      try { await guide(gap); }
      catch (error) { setError(error.message); }
      return;
    }
    submitting = true;
    customerPicker.open = false;
    videoPicker.open = false;
    setError('');
    issues.clear();
    refresh();
    try {
      let submitted;
      if (service.pending) submitted = await service.retrySubmission();
      else {
        if (!details.inert) rememberDraft();
        submitted = await arrangeAndSubmit(itemsForSubmit(), !details.inert);
      }
      if (!submitted) return;
      writeBrowserDraft(draftKey,null);
      draftSaved = false;
      draftStatus('');
      preview.clear();
      updateBatch(submitted);
      monitor.start(submitted);
    } catch (error) { setError(error.message); }
    finally {
      submitting = false;
      refresh();
      if (repairAfterSubmit) {
        fixClient(repairAfterSubmit.id,repairAfterSubmit.field);
        repairAfterSubmit = null;
      }
    }
  });
  installBatchVideoStyles();
  return {
    root,
    get batchId() { return batch?.id; },
    get returningFromDocuments() { return Boolean(documentsToRefresh); },
    addCustomer(id) {
      selected.add(id);
      renderChoices();
      refreshSelection();
      rememberDraft();
    },
    async enter({clientIds = [], batchId} = {}) {
      const first = !initialized;
      initialized = true;
      const draft = first ? readBrowserDraft(draftKey) : null;
      if (draft) {
        draftSaved = true;
        const activeIds = new Set(client.state.clients.map(customer=>customer.id));
        for (const [id,edit] of Object.entries(draft.clients || {})) if (activeIds.has(id)) edits.set(id,edit);
        for (const [id,settings] of Object.entries(draft.videos || {})) if (activeIds.has(id)) videoSettings.set(id,settings);
        countField.value = draft.count || '';
        length = draft.length || '';
      }
      if (first) setSelection(service.pending?.items.map(item=>item.client_id) || draft?.selected || clientIds);
      else if (!activeBatch(batch) && !service.pending) {
        const activeIds = new Set(client.state.clients.map(customer => customer.id));
        if ([...selected].some(id => !activeIds.has(id))) setSelection([...selected]);
        if (view === 'plan' && currentId && !activeIds.has(currentId)) showClient(selected.values().next().value, 'plan');
      }
      renderChoices();
      if (batchId && batch?.id !== batchId) {
        const initial = await service.batch(batchId);
        if (first && !service.pending && (!draft || activeBatch(initial))) setSelection(initial.items.map(item=>item.client_id));
        updateBatch(initial);
        monitor.start(initial);
      }
      if (draft && !service.pending && !activeBatch(batch)) {
        draftStatus('已恢复本批安排。');
        showClient(selected.has(draft.currentId) ? draft.currentId : selected.values().next().value,'plan');
        setExpanded(Boolean(draft.expanded));
      }
      if (documentsToRefresh) {
        const id = documentsToRefresh;
        documentsToRefresh = null;
        issues.delete(id);
        plans.get(id)?.row.remove();
        await loadPlan(id);
        fixClient(id,'[data-quick-documents]');
        rememberDraft();
      }
    },
    dispose() { lifetime.abort(); monitor.dispose(); preview.close(); },
  };
}
