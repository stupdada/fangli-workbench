import { workspaceRail, workbenchReturnPath } from '../workspace-rail.mjs';
import { applyWorkbenchPalette } from '../palette.mjs';
import { randomUUID, sha256Hex } from '../browser-crypto.mjs';

applyWorkbenchPalette();
const $ = selector => document.querySelector(selector);
const root = $('#geo-app');
const dialog = $('#geo-dialog');
const form = $('#geo-form');
const route = new URL(location.href);
const returnPath = workbenchReturnPath(route.searchParams.get('return_to'));
const state = { clients: [], customer: '', home: null, plan: null, run: null, busy: false, loading: true, error: '' };
let generation = 0;
let pollTimer;
let submitDialog;
let pendingRequest;
let historyDirty = false;
const statusText = { running: '检测中', stopping: '正在停止', done: '已结束', stopped: '已停止', interrupted: '已中断',
  queued: '等待检测', complete: '回答完成', incomplete: '回答不完整', failed: '请求失败', unknown: '结果待确认', skipped: '未执行' };
const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const active = run => ['running', 'stopping'].includes(run?.state);
const label = value => statusText[value] || value;
const clientPath = (suffix = '', id = state.customer) => '/api/workbench/clients/' + encodeURIComponent(id) + '/geo' + suffix;
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const lines = value => String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);

async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok || !data.ok) throw Object.assign(new Error(data.error || '操作没有完成，请稍后重试'), {status: res.status});
  return data;
}

function button(action, title, type = 'quiet', attrs = '') {
  return '<button type="button" class="button geo-action ' + type + (type === 'primary' ? ' geo-primary' : '') +
    '" data-geo-action="' + action + '" ' + attrs + '>' + e(title) + '</button>';
}

function planMarkup(plan) {
  const discovery = plan.questions.filter(q => q.kind === 'discovery').length;
  const branded = plan.questions.length - discovery;
  const ready = state.home.provider.ready;
  const model = state.home.provider.models?.find(option => option.id === state.home.provider.model);
  const running = active(state.run) || state.home.runs.some(active);
  const runnable = discovery > 0 && !state.busy && !running;
  const primary = !ready ? button('connect', '连接豆包', 'primary', state.busy ? 'disabled' : '') :
    discovery ? button('start', '开始检测', 'primary', runnable ? '' : 'disabled') :
      button('edit', '填写业务关键词', 'primary');
  return '<section class="geo-plan" aria-label="本次检测"><div class="geo-heading"><h2>本次检测</h2>' +
    '<span class="geo-meta">' + e(state.home.provider.entry) + (model ? ' · ' + e(model.label) : '') + '</span></div>' +
    (discovery ? '<p>' + discovery + ' 条非品牌题 · ' + branded + ' 条品牌核验题 · 每题 ' + plan.repeat + ' 次</p>' :
      '<p>这个客户缺少业务关键词。填写一个客户会搜索的词，例如「宠物洗护」，即可准备默认题目。</p>') +
    (plan.topic ? '<p class="geo-meta">业务关键词 ' + e(plan.topic) + '</p>' : '') +
    (plan.urls.length ? '<p class="geo-meta">同时追踪 ' + plan.urls.length + ' 个稿件链接</p>' : '') +
    (plan.questions.length ? '<details class="geo-disclosure" id="geo-questions"><summary>查看题目</summary><ol>' +
      plan.questions.map(q => '<li>' + e(q.text) + (q.kind === 'branded' ? ' <small class="geo-meta">品牌核验</small>' : '') + '</li>').join('') + '</ol></details>' : '') +
    '<div class="geo-actions">' + primary + button('edit', '调整本次检测', 'quiet', state.busy || running ? 'disabled' : '') +
    (ready ? button('connect', '连接设置', 'quiet', state.busy || running ? 'disabled' : '') : '') + '</div>' +
    '<p class="geo-meta">' + (ready ? '本轮最多发出 ' + plan.questions.length * plan.repeat + ' 次模型请求，费用由火山方舟计收。' :
      '首次使用需要保存火山方舟 API Key。保存后即可检测。') + '</p></section>';
}

function count(metric) {
  return metric.eligible ? metric.hits + '/' + metric.eligible : '暂无可判定结果';
}

function failureReason(run) {
  const first = run.items.find(item => item.state === 'failed' || item.state === 'unknown');
  const reason = first?.reason || '';
  if (reason === '火山方舟拒绝请求（HTTP 404）') {
    return '方舟找不到这轮使用的模型，或当前 Key 无权调用。请在「连接设置」选好模型后开始新检测。';
  }
  if (reason === '火山方舟拒绝请求（HTTP 403）') {
    return '方舟拒绝访问。请检查这轮使用的模型和搜索组件是否已开通，以及当前 Key 的权限。';
  }
  return reason;
}

function reportMarkup(run) {
  if (!run) return '';
  const finished = run.items.filter(item => !['queued','running','skipped'].includes(item.state)).length;
  const earlier = run.comparable[0];
  const counts = Object.fromEntries(['failed','incomplete','unknown','skipped'].map(s => [s, run.items.filter(item => item.state === s).length]));
  const failures = Object.entries(counts).filter(([, value]) => value).map(([key, value]) => label(key) + ' ' + value + ' 次').join(' · ');
  const provider = state.home.provider;
  const sameConfig = provider.model === run.spec.model && provider.config === run.spec.config;
  const canRepeat = provider.ready && sameConfig && !state.home.runs.some(active);
  const issue = failureReason(run);
  return '<section class="geo-report" aria-label="逐题检测结果"><div class="geo-heading"><h2>检测结果</h2><span class="geo-meta">' +
    e(date(run.created_at)) + ' · 题库第 ' + run.revision + ' 版</span></div>' +
    '<p class="geo-meta">' + e(run.spec.entry) + '</p>' +
    '<p role="status">' + e(label(run.state)) + ' · 已执行 ' + finished + '/' + run.items.length + ' 次</p>' +
    (issue ? '<p class="error-text" role="alert">' + e(issue) + '</p>' : '') +
    (active(run) ? '<progress class="geo-progress" aria-label="检测进度" value="' + finished + '" max="' + run.items.length + '"></progress>' : '') +
    '<div class="geo-summary">' + Object.entries(run.summary).filter(([, part]) => part.planned).map(([key, part]) => '<p><strong>' + (key === 'discovery' ? '非品牌题' : '品牌核验题') +
      '</strong> · 完整回答 ' + part.answered + '/' + part.planned + ' · 品牌提及 ' + count(part.mentioned) +
      (run.spec.urls.length ? ' · 文章引用 ' + count(part.article_hit) : '') + '</p>').join('') +
    (failures ? '<p class="geo-meta">' + e(failures) + '</p>' : '') +
    (earlier && !active(run) ? '<p class="geo-meta">上次同条件检测 ' + e(date(earlier.date)) + ' · 非品牌提及 ' + count(earlier.summary.discovery.mentioned) + '</p>' : '') +
    (!sameConfig && !active(run) ? '<p class="geo-meta">检测配置已更新。用「开始检测」可运行新一轮。</p>' : '') +
    '</div><div class="geo-actions">' +
    (active(run) ? button('stop', run.state === 'stopping' ? '正在停止' : '停止后续请求', 'quiet', run.state === 'stopping' || state.busy ? 'disabled' : '') :
      button('repeat', '按原计划复测', 'outline', !canRepeat || state.busy ? 'disabled' : '')) +
    '</div><ol class="geo-results">' + run.items.map(itemMarkup).join('') + '</ol></section>';
}

function itemMarkup(item) {
  const status = item.mentioned === true ? '提到品牌' : item.mentioned === false ? '未提到品牌' : label(item.state);
  const cls = item.mentioned === true ? 'ok' : ['failed','unknown','incomplete'].includes(item.state) ? 'problem' : '';
  const source = item.citations?.length ? '<ul>' + item.citations.map(c =>
    '<li><a href="' + e(c.url) + '" target="_blank" rel="noopener noreferrer">' + e(c.title || c.url) + '</a></li>').join('') + '</ul>' : '';
  return '<li><details id="geo-item-' + item.ordinal + '"><summary><span>' + e(item.question) + '</span><span class="geo-status ' + cls + '">' +
    e(status) + ' · 第 ' + item.sample + ' 次</span></summary><div class="geo-evidence">' +
    (item.reason ? '<p>' + e(item.reason) + '</p>' : '') +
    (item.provider_code ? '<p class="geo-meta">方舟错误码 ' + e(item.provider_code) + '</p>' : '') +
    (item.answer ? '<p class="geo-answer">' + e(item.answer) + '</p>' : '') +
    (item.answer ? '<p class="geo-meta">' + (item.search === true ? '已确认联网搜索' : '联网搜索未确认') +
      (item.article_hit === true ? ' · 引用了目标文章' : item.article_hit === false ? ' · 未引用目标文章' : '') + '</p>' : '') +
    (source ? '<strong>回答引用</strong>' + source : item.answer ? '<p class="geo-meta">' +
      (item.citations_observable ? '本次回答未附结构化引用' : '本次引用信息不完整') + '</p>' : '') + '</div></details></li>';
}

function render() {
  const opened = [...root.querySelectorAll('details[open]')].map(el => el.id);
  const focus = root.contains(document.activeElement) ? { id: document.activeElement.id, action: document.activeElement.dataset.geoAction } : null;
  const options = state.clients.map(c => '<option value="' + e(c.id) + '"' + (c.id === state.customer ? ' selected' : '') + '>' + e(c.name) + '</option>').join('');
  const history = state.home?.runs || [];
  root.innerHTML = workspaceRail('geo',{links:{customers:returnPath}}) + '<main id="geo-main" class="geo-main"><div class="geo-topbar"><span class="geo-brand">方立工作台</span>' +
    (state.clients.length ? '<label class="geo-client"><span>客户</span><select id="geo-customer" ' + (state.busy ? 'disabled' : '') + '><option value="">选择客户</option>' + options + '</select></label>' : '') +
    '</div><div class="geo-surface"><h1>GEO 检测</h1><p class="geo-intro">看 AI 有没有提到客户，或引用已发布的稿件。</p>' +
    (state.error ? '<p class="error-text geo-message" role="alert">' + e(state.error) + '</p>' : '') +
    (state.loading ? '<p role="status">正在读取检测记录…</p>' :
      state.home && state.plan ? planMarkup(state.plan) + reportMarkup(state.run) +
        (history.length ? '<section class="geo-history"><h2>历史检测</h2><ul>' + history.map(run => '<li><button type="button" class="geo-history-button" data-run="' + e(run.id) + '"' +
        (state.run?.id === run.id ? ' aria-current="true"' : '') + (active(state.run) ? ' disabled' : '') + '><span>' + e(date(run.created_at)) + ' · 第 ' + run.revision + ' 版</span><span class="geo-meta">' + e(label(run.state)) + '</span></button></li>').join('') + '</ul></section>' : '') :
      state.clients.length ? '<p>从右上角选择要检测的客户。</p>' :
        '<p>先在客户页建立客户，填上品牌和主营业务。</p><a class="button primary geo-primary" href="/workbench/zip/index.html?area=customers">前往客户页</a>') +
    '</div></main>';
  for (const id of opened) { const el = document.getElementById(id); if (el) el.open = true; }
  if (focus?.id) document.getElementById(focus.id)?.focus({preventScroll: true});
  else if (focus?.action) root.querySelector('[data-geo-action="' + focus.action + '"]')?.focus({preventScroll: true});
}

function remember() {
  const next = new URL(location.href);
  if (state.customer) next.searchParams.set('client', state.customer); else next.searchParams.delete('client');
  if (state.run?.id) next.searchParams.set('run', state.run.id); else next.searchParams.delete('run');
  history.replaceState(null, '', next);
  try { if (state.customer) localStorage.setItem('fangli.geo.customer', state.customer); } catch { /* Optional preference. */ }
}

function clearPoll() { clearTimeout(pollTimer); pollTimer = undefined; }

function watch() {
  clearPoll();
  if (document.hidden || !active(state.run)) return;
  const epoch = generation, id = state.run.id, cid = state.customer;
  pollTimer = setTimeout(async () => {
    try {
      const {run} = await api(clientPath('/runs/' + encodeURIComponent(id), cid));
      if (epoch !== generation || state.run?.id !== id) return;
      const changed = state.run.state !== run.state || run.items.some((item, index) => state.run.items[index]?.state !== item.state);
      state.run = run;
      if (!active(run) || historyDirty) {
        historyDirty = false;
        const data = await api(clientPath('', cid));
        if (epoch !== generation || state.run?.id !== id) return;
        state.home.runs = data.runs;
      }
      if (changed) render();
      watch();
    } catch (error) {
      if (epoch === generation && state.run?.id === id) {
        state.error = error.message + '。刷新页面可继续查看该轮记录。';
        render();
      }
    }
  }, 1800);
}

async function selectClient(cid, requestedRun) {
  const epoch = ++generation;
  clearPoll();
  Object.assign(state, {customer: cid, home: null, plan: null, run: null, loading: Boolean(cid), error: ''});
  render();
  try {
    if (!cid) return;
    const home = await api(clientPath('', cid));
    if (epoch !== generation) return;
    state.home = home;
    state.plan = structuredClone(home.plan);
    const id = requestedRun || home.runs[0]?.id;
    if (id) {
      const {run} = await api(clientPath('/runs/' + encodeURIComponent(id), cid));
      if (epoch !== generation) return;
      state.run = run;
    }
  } catch (error) {
    if (epoch === generation) state.error = error.message;
  } finally {
    if (epoch === generation) { state.loading = false; remember(); render(); watch(); }
  }
}

async function openRun(id) {
  const epoch = ++generation;
  clearPoll();
  const {run} = await api(clientPath('/runs/' + encodeURIComponent(id)));
  if (epoch !== generation) return;
  state.run = run;
  remember();
  render();
  watch();
}

function openDialog(title, markup, action, submit = '保存') {
  $('#geo-dialog-title').textContent = title;
  $('#geo-dialog-body').innerHTML = markup;
  $('#geo-submit').textContent = submit;
  $('#geo-dialog-error').textContent = '';
  submitDialog = action;
  dialog.showModal();
}

function openConnection() {
  const provider = state.home.provider;
  const keySource = provider.key_source || (provider.ready ? 'local' : 'none');
  const options = provider.models || [{id: provider.model, label: provider.model}];
  const keyInput = '<label>' + (provider.ready ? '新 API Key' : 'API Key') + '<input name="key" type="password" ' +
    (provider.ready ? '' : 'required ') + 'autocomplete="off" maxlength="300"></label>';
  const keyMarkup = keySource === 'environment' ? '<p><strong>API Key 由启动环境提供</strong></p>' :
    keySource === 'local' ? '<p><strong>API Key 已保存</strong>，换模型时会继续使用。</p>' +
      '<details class="geo-disclosure"><summary>更换 API Key</summary><div class="geo-fields">' + keyInput + '</div></details>' : keyInput;
  const modelMarkup = '<label>检测模型<select name="model"' + (provider.model_locked ? ' disabled' : '') + '>' +
    options.map(option => '<option value="' + e(option.id) + '"' + (option.id === provider.model ? ' selected' : '') + '>' +
      e(option.label) + (option.id === 'doubao-seed-2-1-lite-260915' ? '（推荐）' : '') + '</option>').join('') + '</select></label>' +
    (provider.model_locked ? '<p class="geo-meta">检测模型由启动环境指定。</p>' : '');
  openDialog(provider.ready ? '连接设置' : '连接豆包', keyMarkup + modelMarkup +
    '<p class="geo-meta">首次使用时，在方舟「应用组件库 → 应用组件」开通联网内容插件。检测使用全网、头条图文和抖音百科，费用按方舟账单计。</p>' +
    '<p><a class="text-button" href="https://console.volcengine.com/ark/" target="_blank" rel="noopener noreferrer">打开火山方舟控制台</a></p>', async data => {
      const result = await api('/api/workbench/geo/connection', 'PUT', Object.fromEntries(data));
      state.home.provider = result.provider;
    }, '保存连接');
}

function defaultQuestions(brand, topic) {
  const tails = ['有哪些值得了解的品牌或商家？','怎么选？','有哪些常见选择，各自适合什么情况？','有哪些评价较好的选择？','预算有限时有哪些选择？','第一次了解时应该考虑哪些选择？'];
  return {discovery: topic ? tails.map(t => topic + t).join('\n') : '',
    branded: brand ? [brand + '主要提供什么产品或服务？','在哪里能查到' + brand + '的官方资料？'].join('\n') : ''};
}

function openPlan() {
  const plan = state.plan;
  const questions = kind => plan.questions.filter(q => q.kind === kind).map(q => q.text).join('\n');
  openDialog('调整本次检测', '<label>业务关键词<input name="topic" maxlength="60" value="' + e(plan.topic) +
    '" placeholder="例如 宠物洗护"></label>' +
    '<div>' + button('suggest', '按关键词填入默认题目', 'outline') + '</div>' +
    '<label>非品牌题 · 每行一题<textarea name="discovery" rows="6" placeholder="例如 浦东宠物洗护怎么选？">' + e(questions('discovery')) + '</textarea></label>' +
    '<details class="geo-disclosure"><summary>品牌、次数和稿件链接</summary><div class="geo-fields">' +
    '<label>品牌名称与别名 · 每行一个<textarea name="aliases" rows="2">' + e(plan.aliases.join('\n')) + '</textarea></label>' +
    '<label>品牌核验题 · 每行一题<textarea name="branded" rows="2">' + e(questions('branded')) + '</textarea></label>' +
    '<label>每题次数<select name="repeat"><option value="1">1 次</option><option value="2"' + (plan.repeat === 2 ? ' selected' : '') + '>2 次</option></select></label>' +
    '<label>追踪稿件（可选）<select name="article"><option value="">只检测品牌</option></select></label>' +
    '<label>公开文章链接 · 每行一个<textarea name="urls" rows="2" placeholder="https://…">' + e(plan.urls.join('\n')) + '</textarea></label></div></details>', async data => {
      const aliases = lines(data.get('aliases'));
      const topic = String(data.get('topic') || '').trim();
      const discovery = lines(data.get('discovery') || (!questions('discovery') && topic ? defaultQuestions(aliases[0], topic).discovery : ''));
      const branded = lines(data.get('branded'));
      const repeat = Number(data.get('repeat'));
      const urls = lines(data.get('urls'));
      const [article_id, version_id] = String(data.get('article')).split('/').map(Number);
      if (!aliases.length || !discovery.length || (discovery.length + branded.length) * repeat > state.home.provider.max_calls) {
        throw new Error('请填写品牌和至少一道非品牌题，每轮最多 ' + state.home.provider.max_calls + ' 次请求。');
      }
      if (Boolean(article_id) !== Boolean(urls.length)) throw new Error('追踪文章时，请同时选择稿件并填写公开链接。');
      const spec = { topic, aliases, questions: [...discovery.map(text => ({kind:'discovery', text})),
        ...branded.map(text => ({kind:'branded', text}))], repeat, urls, article_id: article_id || null, version_id: version_id || null };
      const result = await api(clientPath('/plan'), 'PUT', spec);
      state.plan = result.plan;
      state.home.revision = result.revision;
      state.error = '';
    }, '保存题目');
  const select = form.elements.article;
  if (plan.article_id) select.add(new Option('原选稿件 · 版本 ' + plan.version_id, plan.article_id + '/' + plan.version_id, true, true));
  const option = select.value;
  api(clientPath('/articles')).then(({articles}) => {
    if (!dialog.open || form.elements.article !== select) return;
    for (const article of articles) {
      const value = article.article_id + '/' + article.version_id;
      if (value !== option) select.add(new Option(article.title + ' · 版本 ' + article.version_id, value));
    }
  }).catch(() => {
    if (dialog.open && form.elements.article === select) $('#geo-dialog-error').textContent = '未能读取可选稿件，可先做品牌检测。';
  });
}

async function start(repeatRunId) {
  const cid = state.customer, epoch = generation;
  const {topic, aliases, questions, repeat, urls, article_id, version_id} = state.plan;
  const payload = repeatRunId ? {repeat_run_id: repeatRunId} : {plan: {topic, aliases, questions, repeat, urls, article_id, version_id}};
  const signature = sha256Hex(new TextEncoder().encode(JSON.stringify([cid, payload])));
  try { pendingRequest ||= JSON.parse(sessionStorage.getItem('fangli.geo.pending')); } catch { /* Optional recovery. */ }
  if (pendingRequest?.signature !== signature) pendingRequest = {signature, key: randomUUID()};
  try { sessionStorage.setItem('fangli.geo.pending', JSON.stringify(pendingRequest)); } catch { /* In-memory deduplication remains. */ }
  const {run_id} = await api(clientPath('/runs', cid), 'POST', {...payload, request_key: pendingRequest.key});
  pendingRequest = null;
  try { sessionStorage.removeItem('fangli.geo.pending'); } catch { /* Optional recovery. */ }
  if (epoch !== generation || cid !== state.customer) return;
  historyDirty = true;
  await openRun(run_id);
  if (!active(state.run)) {
    const data = await api(clientPath('', cid));
    if (state.customer === cid && state.run?.id === run_id) state.home.runs = data.runs;
    historyDirty = false;
  }
}

async function act(fn) {
  if (state.busy) return;
  const cid = state.customer;
  state.busy = true;
  state.error = '';
  render();
  try { await fn(); } catch (error) { if (state.customer === cid) state.error = error.message; }
  finally { state.busy = false; render(); }
}

root.addEventListener('change', event => {
  if (event.target.id === 'geo-customer') selectClient(event.target.value);
});
root.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.run) { act(() => openRun(target.dataset.run)); return; }
  const action = target.dataset.geoAction;
  if (action === 'connect') openConnection();
  if (action === 'edit') openPlan();
  if (action === 'start') act(() => start());
  if (action === 'repeat') act(() => start(state.run.id));
  if (action === 'stop') act(async () => {
    const epoch = generation, id = state.run.id;
    const result = await api(clientPath('/runs/' + encodeURIComponent(id) + '/stop'), 'POST', {});
    if (epoch === generation && state.run?.id === id) { state.run = result.run; watch(); }
  });
});
dialog.addEventListener('click', event => {
  if (event.target.closest('[data-close]')) dialog.close();
  if (event.target.closest('[data-geo-action="suggest"]')) {
    const topic = form.elements.topic.value.trim(), brand = lines(form.elements.aliases.value)[0];
    if (!topic) { $('#geo-dialog-error').textContent = '先填一个客户会搜索的业务关键词。'; form.elements.topic.focus(); return; }
    const questions = defaultQuestions(brand, topic);
    form.elements.discovery.value = questions.discovery;
    form.elements.branded.value = questions.branded;
    $('#geo-dialog-error').textContent = '';
  }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const save = $('#geo-submit');
  if (save.disabled) return;
  const action = submitDialog;
  save.disabled = true;
  $('#geo-dialog-error').textContent = '';
  try { await action(new FormData(form)); dialog.close(); render(); }
  catch (error) { $('#geo-dialog-error').textContent = error.message; }
  finally { save.disabled = false; }
});
dialog.addEventListener('close', () => { form.reset(); $('#geo-dialog-body').replaceChildren(); });
document.addEventListener('visibilitychange', watch);

async function boot() {
  render();
  try {
    const data = await api('/api/workbench/clients');
    state.clients = data.clients;
    let saved;
    try { saved = localStorage.getItem('fangli.geo.customer'); } catch { /* Optional preference. */ }
    const id = [route.searchParams.get('client'), saved, state.clients.length === 1 ? state.clients[0].id : '']
      .find(value => state.clients.some(client => client.id === value)) || '';
    await selectClient(id, route.searchParams.get('client') === id ? route.searchParams.get('run') : null);
  } catch (error) {
    Object.assign(state, {loading: false, error: error.message});
    render();
  }
}
boot();
