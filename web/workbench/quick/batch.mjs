
import { BatchMonitor, activeBatch } from '../customers-client.mjs';
import { planOptions } from '../customer-platforms.mjs';
import { addBatchVideo, assertBatchVideoLimit, collectBatchVideos, installBatchVideoStyles, updateVideoLimit, updateVideoSource, videoPlanner } from '../customer-batch-video.mjs';
import { articleBody, enabled, escapeHTML as e, markdown, optionIssues, planSummary, splitWords } from '../model.mjs';
import { distributeCount } from './counts.mjs';
import { articleLengthHint } from './article-length.mjs';
import { createBatchPreview } from './preview.mjs';

const statuses = {queued:'排队中', running:'生成中', done:'已完成', partial:'部分完成', error:'失败', stopped:'已停止', interrupted:'中断待确认'};
const accountTypes = {official:'官方号', personal:'个人号'};
const workspace = '/workbench/zip/index.html';
const accountKey = item => `${item.platform_id}:${item.account_type}`;
const chevron = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function createQuickCreation(client, service, { onBatch }) {
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
        <label class="quick-count"><span>每客户篇数</span><input type="number" min="1" max="2000" step="1" inputmode="numeric" name="count" placeholder="沿用"></label>
        <div class="quick-length quick-bulk-length" role="group" aria-label="统一文章篇幅">
          <span>文章篇幅</span><button type="button" data-length="长篇" aria-pressed="false">长</button><button type="button" data-length="短篇" aria-pressed="false">短</button>
          <span class="quick-mixed" data-mixed hidden>各客户设置</span>
        </div>
        <button class="button primary quick-submit" type="submit">开始生成</button>
      </div>
      <p class="quick-batch-totals" data-batch-totals role="status" hidden></p>
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
            <div class="quick-view-switch" hidden><button type="button" data-quick-view="plan">安排</button><button type="button" data-quick-view="result">稿件</button></div>
          </div>
          <p class="quick-empty" data-no-client>请选择客户。</p>
          <fieldset class="quick-plans"></fieldset>
          <section class="quick-result" aria-label="客户稿件" hidden></section>
        </div>
      </div></div></div>
    </form>`;
  const $ = selector => root.querySelector(selector);
  const form = $('form'), button = $('[type=submit]'), all = $('[data-select-all]');
  const preview = createBatchPreview(root);
  const expand = $('[data-expand]'), details = $('.quick-detail-shell'), plansRoot = $('.quick-plans');
  const customerPicker = $('.quick-customer-picker'), pickerSearch = $('[data-picker-search]'), pickerList = $('.quick-picker-list');
  const lifetime = new AbortController();
  const choices = $('.quick-client-list'), search = $('.quick-search input'), countField = form.elements.count;
  const heading = $('.quick-client-heading'), viewSwitch = $('.quick-view-switch');
  const errorBox = $('[data-quick-error]'), result = $('.quick-result');
  const progress = $('.quick-batch-progress'), status = $('[data-batch-status]'), batchLink = $('[data-action="open-quick-batch"]');
  const selected = new Set(), plans = new Map(), articles = new Map(), issues = new Map();
  let batch = null, submitting = false, initialized = false, currentId = null, view = 'plan', length = '', resultKey = '';
  let itemsByClient = new Map();

  function idName(id) { return client.state.clients.find(customer => customer.id === id)?.name || itemsByClient.get(id)?.name || '客户'; }
  function platformName(id) { return client.platforms.find(platform => String(platform.id) === String(id))?.name || `平台 ${id}`; }
  function setError(message) { errorBox.textContent = message; errorBox.hidden = !message; }
  function batchCount() {
    if (!countField.validity.valid) throw new Error('每客户篇数须为 1 至 2000 的整数，留空沿用方案');
    return countField.value ? countField.valueAsNumber : null;
  }
  function selectionsFor(entry) {
    return entry.manual ? entry.options.selections : distributeCount(entry.options.selections,batchCount());
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
    try {
      const options = readOptions(entry);
      const problems = optionIssues(options,client.platforms,client.targets);
      if (!options.selections.length && !entry.row.querySelector('[data-batch-video-row]')) problems.push('请选择平台和账号');
      if (options.selections.length && !options.keywords.length) problems.push('请填写目标关键词');
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
      entry.options = planOptions(plan.options);
      entry.keywords = new Set(entry.options.keywords);
      entry.words = [...new Set([...entry.keywords,...available_keywords])];
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
      <details class="quick-extra" data-quick-formats hidden><summary>发布形态</summary><div class="quick-formats"></div></details>
      <details class="quick-extra"><summary>视频安排 <span class="quick-video-time">成片 30—45 秒</span></summary>
        <p class="quick-video-limit" data-batch-video-limit></p>${videoPlanner()}
      </details>
      <p class="error-text quick-error" data-client-error hidden></p>`;
      row.querySelector('textarea').value = entry.options.note || '';
      if (entry.options.note) row.querySelector('[data-client-note] summary').textContent = '补充要求 · 已填写';
      renderAccounts(entry);
      renderKeywords(entry);
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
  function videoPlans() {
    return [...new Set([...selected, currentId])].map(id=>plans.get(id)?.row).filter(Boolean);
  }
  function refresh() {
    const pending = Boolean(service.pending), active = activeBatch(batch), locked = submitting || active || pending;
    const ids = [...selected];
    const chosen = ids.map(id=>plans.get(id));
    const loading = chosen.some(entry=>entry.loading);
    const total = chosen.reduce((sum,entry)=>sum + (entry.options ? accountRows(entry).reduce((n,item)=>n+item.count,0) : 0),0);
    const videoTotal = chosen.reduce((sum,entry)=>sum + entry.row.querySelectorAll('[data-batch-video-row]').length,0);
    const totals = $('[data-batch-totals]');
    totals.hidden = !ids.length || loading || pending;
    totals.textContent = active ? `文章 ${batch.total} 篇 · 视频 ${batch.video_total || 0} 条` : `文章 ${total} 篇 · 视频 ${videoTotal} 条`;
    const allSelected = ids.length > 0 && ids.length === client.state.clients.length;
    all.disabled = !client.state.clients.length || locked;
    all.textContent = allSelected ? '清空' : '全选';
    all.setAttribute('aria-label',allSelected ? '清空客户选择' : '全选客户');
    $('[data-picked-count]').textContent = ids.length ? `已选 ${ids.length} 位` : '选择客户';
    customerPicker.inert = locked;
    countField.disabled = locked;
    for (const control of root.querySelectorAll('[data-length]')) control.disabled = locked;
    refreshLength();
    plansRoot.disabled = locked;
    button.disabled = submitting || active || !pending && (!ids.length || loading);
    const action = details.inert ? '开始生成' : '预览安排';
    button.textContent = submitting ? '正在提交…' : active ? '生成中…' : pending ? '恢复本次提交' :
      loading ? '读取安排…' : action;
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
    updateVideoLimit(plansRoot,videoPlans());
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
  function fixClient(id) {
    setExpanded(true);
    if (id) {
      if (search.value) { search.value = ''; renderChoices(); }
      showClient(id,'plan');
      heading.querySelector('h2').tabIndex = -1;
      heading.querySelector('h2').focus({preventScroll:true});
    }
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
        const videos = collectBatchVideos(entry.row,planSummary(options,client.platforms).count);
        items.push(videos.length ? {client_id:id,options,videos} : {client_id:id,options});
      } catch (error) {
        issues.set(id,error.message);
        invalid.push(id);
      }
    }
    if (invalid.length) {
      fixClient(invalid[0]);
      throw new Error(`请检查 ${invalid.length} 位客户的本次安排`);
    }
    return items;
  }

  async function checkBeforeSubmit(items) {
    const check = await service.preflight(items);
    if (check.ready) return check.items;
    for (const issue of check.issues) if (issue.client_id) issues.set(issue.client_id,issue.error);
    fixClient(check.issues.find(issue=>issue.client_id)?.client_id);
    throw new Error(issues.size ? `请检查 ${issues.size} 位客户的本次安排` : check.issues.map(issue=>issue.error).join('\n'));
  }

  async function reviewAndSubmit(items) {
    let notice = '';
    for (;;) {
      const planned = await checkBeforeSubmit(items);
      const choices = await preview.review(planned, notice);
      if (!choices) return null;
      const byClient = new Map(choices.map(({clientId,revision,rows})=>[clientId,{revision,rows}]));
      const confirmed = items.filter(item=>byClient.has(item.client_id))
        .map(item=>({...item,preview:byClient.get(item.client_id)}));
      try {
        return await service.submit(confirmed);
      } catch (error) {
        if (error.status !== 400 || !error.message.includes('预览依据已更新')) throw error;
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
    result.innerHTML = `<div class="quick-result-status"><span>${statuses[item.status]} · ${item.completed} / ${item.planned} 篇</span>
      ${href ? `<a href="${href}" data-task="${e(item.conversation_id)}">打开任务</a>` : ''}</div>
      ${item.error ? `<p class="error-text">${e(item.error)}</p>` : ''}
      ${entry?.error ? '<p class="error-text">稿件列表暂不可读取，可打开任务查看。</p>' : ''}
      ${(entry?.items || []).map(article=>`<details data-article="${e(article.id)}" ${opened.has(article.id) ? 'open' : ''}><summary>${e(article.title)}</summary><article></article></details>`).join('')}`;
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
  },{signal:lifetime.signal});
  form.addEventListener('change',event=>{
    const id = event.target.dataset.clientChoice;
    if (!id) return;
    if (event.target.checked) selected.add(id); else selected.delete(id);
    setError('');
    refreshSelection();
  });
  choices.addEventListener('click',event=>{
    const id = event.target.closest('[data-client-view]')?.dataset.clientView;
    if (id) showClient(id);
  });
  expand.addEventListener('click',()=>setExpanded(details.inert));
  all.addEventListener('click',()=>{
    setError('');
    setSelection(selected.size === client.state.clients.length ? [] : client.state.clients.map(customer=>customer.id));
  });
  countField.addEventListener('input',()=>{
    issues.clear();
    setError('');
    for (const entry of plans.values()) if (entry.options) {
      entry.manual = false;
      renderAccounts(entry);
    }
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
        issues.delete(id);
      }
      setError('');
      refresh();
      return;
    }
    const entry = plans.get(action.closest('[data-client-id]')?.dataset.clientId);
    if (!entry) return;
    const id = entry.row.dataset.clientId;
    setError('');
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
    if (action.dataset.customerAction === 'batch-video-add') {
      addBatchVideo(action.closest('.batch-video-planner'),videoPlans());
      issues.delete(id);
    }
    if (action.dataset.customerAction === 'batch-video-remove') {
      const planner = action.closest('.batch-video-planner');
      action.closest('[data-batch-video-row]').remove();
      planner.querySelector('[data-customer-action="batch-video-add"]').focus();
      issues.delete(id);
    }
    refresh();
  });

  plansRoot.addEventListener('keydown',event=>{
    if (event.key !== 'Enter' || event.isComposing || !event.target.matches('[data-keyword-entry]')) return;
    event.preventDefault();
    addKeywords(plans.get(event.target.closest('[data-client-id]').dataset.clientId));
  });
  plansRoot.addEventListener('input',event=>{
    const field = event.target;
    if (field.matches('[data-account-count],[data-quick-format],[data-quick-keyword],[data-batch-video-source]')) return;
    const row = field.closest('[data-client-id]');
    if (!row) return;
    issues.delete(row.dataset.clientId);
    setError('');
    if (field.matches('textarea')) row.querySelector('[data-client-note] summary').textContent = field.value.trim() ? '补充要求 · 已填写' : '补充要求';
    refresh();
  });
  plansRoot.addEventListener('change',event=>{
    const field = event.target;
    const entry = plans.get(field.closest('[data-client-id]')?.dataset.clientId);
    if (!entry) return;
    const id = entry.row.dataset.clientId;
    issues.delete(id);
    setError('');
    if (field.matches('[data-quick-keyword]')) {
      if (field.checked) entry.keywords.add(field.dataset.quickKeyword);
      else entry.keywords.delete(field.dataset.quickKeyword);
    }
    if (field.matches('[data-batch-video-source]')) updateVideoSource(field);
    if (field.matches('[data-account-count]')) {
      const key = field.dataset.accountCount, value = field.valueAsNumber;
      if (!field.validity.valid || !Number.isInteger(value)) {
        field.value = accountRows(entry).find(item=>accountKey(item)===key).count;
        setError('每个账号的篇数须为 1 至 20 的整数');
      } else {
        entry.options.selections = accountRows(entry).map(item=>accountKey(item) === key ? {...item,count:value} : item);
        entry.manual = true;
      }
    }
    if (field.matches('[data-quick-format]')) {
      const platformId = field.dataset.quickFormat;
      const formats = [...entry.row.querySelectorAll('[data-quick-format]:checked')].filter(input=>input.dataset.quickFormat===platformId).map(input=>input.value);
      entry.options.format_overrides = {...entry.options.format_overrides,[platformId]:formats};
    }
    refresh();
  });

  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if (button.disabled || submitting || activeBatch(batch)) return;
    const shouldReview = !details.inert;
    submitting = true;
    customerPicker.open = false;
    setError('');
    issues.clear();
    refresh();
    try {
      let submitted;
      if (service.pending) submitted = await service.retrySubmission();
      else {
        const items = itemsForSubmit();
        assertBatchVideoLimit(items);
        if (shouldReview) submitted = await reviewAndSubmit(items);
        else {
          await checkBeforeSubmit(items);
          submitted = await service.submit(items);
        }
      }
      if (!submitted) return;
      preview.clear();
      updateBatch(submitted);
      monitor.start(submitted);
    } catch (error) { setError(error.message); }
    finally { submitting = false; refresh(); }
  });
  installBatchVideoStyles();
  return {
    root,
    get batchId() { return batch?.id; },
    async enter({clientIds = [], batchId} = {}) {
      const first = !initialized;
      initialized = true;
      if (first) setSelection(service.pending?.items.map(item=>item.client_id) || clientIds);
      else if (!activeBatch(batch) && !service.pending) {
        const activeIds = new Set(client.state.clients.map(customer => customer.id));
        if ([...selected].some(id => !activeIds.has(id))) setSelection([...selected]);
        if (view === 'plan' && currentId && !activeIds.has(currentId)) showClient(selected.values().next().value, 'plan');
      }
      renderChoices();
      if (batchId && batch?.id !== batchId) {
        const initial = await service.batch(batchId);
        if (first && !service.pending) setSelection(initial.items.map(item=>item.client_id));
        updateBatch(initial);
        monitor.start(initial);
      }
    },
    dispose() { lifetime.abort(); monitor.dispose(); preview.close(); },
  };
}
