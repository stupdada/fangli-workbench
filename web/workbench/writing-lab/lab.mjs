import { workspaceRail } from '../workspace-rail.mjs';
import { applyWorkbenchPalette } from '../palette.mjs';
import markdownIt from '../vendor/markdown-it.mjs';
import { analysisMarkup, collectFeedback, escape, feedbackFields, markList, selectionTools, sideLabel } from './lab-feedback.mjs';

const api = '/api/workbench/writing-lab';
const $ = selector => document.querySelector(selector);
const markdown = markdownIt({ html: false, linkify: false }).disable('image');
const withoutTitle = body => body.replace(/^# [^\n]*\n+/, '');
const modes = {fragment: '片段盲选', full: '全文盲选', report: '本轮结果'};
const actions = [
  ['1', 'left', '选 A'], ['2', 'right', '选 B'], ['3', 'tie', '差不多'],
  ['4', 'neither', '都不行'], ['0', 'skip', '跳过'],
];
const labels = ['答得直接', '有信息增量', '营销感重', '模板或重复', '重要说法缺依据', '更便于引用'];

const batchSelect = $('#lab-batches');
const modeBar = $('#lab-modes');
const review = $('#lab-review');
const status = $('#lab-status');
const dialog = $('#lab-dialog');
const form = $('#lab-form');
const state = { id: '', mode: 'fragment', batch: null, pair: null, events: null, reading: 0, saving: false,
  reason: '', marks: [], selection: null, report: null, proposal: null };
let requestKey = '';

applyWorkbenchPalette();
$('#lab-navigation').innerHTML = workspaceRail('writing-lab');

async function request(path = '', body) {
  const response = await fetch(api + path, body === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || '训练台请求未完成');
  return data;
}

function notice(error = '') {
  const element = $('#lab-error');
  element.textContent = error;
  element.hidden = !error;
}

function remember() {
  const url = new URL(location.href);
  url.searchParams.set('batch', state.id);
  url.searchParams.set('view', state.mode);
  history.replaceState(null, '', url);
}

function batchStatus() {
  const batch = state.batch;
  if (!batch) return;
  const ready = batch.drafts.ready || 0;
  const failed = batch.drafts.error || 0;
  const total = Object.values(batch.drafts).reduce((sum, n) => sum + n, 0);
  const pending = batch.drafts.queued || 0;
  const run = { running: '真实出稿中', done: '本批出稿结束', paused: '出稿已暂停' }[batch.status];
  const action = batch.status === 'running' ? '<button class="button quiet" type="button" data-run="pause">暂停后续出稿</button>' :
    batch.status === 'paused' && pending ? '<button class="button quiet" type="button" data-run="resume">继续未调用的稿件</button>' : '';
  status.innerHTML = `<span>${run} · ${ready}/${total} 篇可用${failed ? ` · ${failed} 篇失败` : ''}</span>
    ${batch.status === 'running' ? `<progress aria-label="出稿进度" value="${ready + failed}" max="${total}"></progress>` : ''}${action}
    ${batch.analysis ? `<button class="button quiet" type="button" data-report>${analysisActive(batch) ? '反馈分析中…' : batch.analysis.status === 'error' ? '查看分析状态' : '查看反馈分析'}</button>` : ''}
    ${batch.error ? `<p class="error-text">${escape(batch.error)}</p>` : ''}`;
  for (const button of modeBar.querySelectorAll('[data-kind]')) {
    const mode = button.dataset.kind;
    const count = batch.pairs[mode];
    button.textContent = modes[mode] + (count ? ` ${count.voted}/${count.ready}` : '');
    button.setAttribute('aria-pressed', String(state.mode === mode));
  }
  const progress = review.querySelector('.lab-progress');
  const count = batch.pairs[state.mode];
  if (progress && count) progress.textContent = `已评 ${count.voted} / ${count.ready} 道可选题`;
  const undo = review.querySelector('[data-undo]');
  if (undo && count) undo.disabled = !count.voted || state.saving;
}

const analysisActive = batch => ['queued', 'running'].includes(batch.analysis?.status);
const active = batch => batch.status === 'running' || analysisActive(batch);

function watch() {
  if (state.events || !active(state.batch)) return;
  const batch = state.id;
  const events = new EventSource(`${api}/${batch}/events`);
  state.events = events;
  events.onmessage = ({data}) => {
    if (state.id !== batch) return events.close();
    const current = JSON.parse(data);
    const before = state.batch.pairs[state.mode]?.ready;
    const finished = state.batch.status === 'running' && current.status !== 'running';
    const analysisChanged = JSON.stringify(state.batch.analysis) !== JSON.stringify(current.analysis);
    state.batch = current;
    batchStatus();
    if (!state.saving && (state.mode === 'report' ? analysisChanged : !state.pair && (finished || before !== current.pairs[state.mode]?.ready))) {
      loadQuestion().catch(error => notice(error.message));
    }
    if (!active(current)) {
      events.close();
      if (state.events === events) state.events = null;
    }
  };
}

function article(side, id, isFull) {
  const letter = sideLabel[id];
  const body = markdown.render(withoutTitle(side.body));
  return `<article class="lab-article" data-side="${id}" aria-label="${letter} 稿"><div class="lab-side"><strong>${letter}</strong>${isFull ? '全文' : '首稿片段'}${selectionTools(id)}</div>
    <h3>${escape(side.title)}</h3><div class="lab-copy" tabindex="0">${isFull ? body : markdown.render(side.excerpt) || '<p>该稿这一处没有对应片段。</p>'}</div>
    ${isFull ? '' : `<details><summary>查看完整首稿</summary><div class="lab-copy" tabindex="0">${body}</div></details>`}</article>`;
}

function renderQuestion(pair) {
  const batch = state.batch;
  const count = batch.pairs[state.mode];
  if (!pair) {
    const message = batch.status === 'running' ? '这一类题暂时选完了。新稿配对后会自动出现。' :
      count?.voted ? '这一类可选题已经评完。' : '当前没有可选题。';
    review.innerHTML = `<p class="lab-empty">${message}</p>${count?.voted ? '<div class="lab-actions"><button class="button outline" data-report>查看本轮结果</button><button class="button quiet" data-undo>撤回上一题</button></div>' : ''}`;
    return;
  }
  const isFull = state.mode === 'full';
  review.innerHTML = `<div class="lab-prompt"><div class="lab-progress"></div><h2 id="lab-question" tabindex="-1">${escape(pair.question)}</h2>
    <p>${escape(pair.topic)} · ${escape(pair.platform)}${pair.account === 'official' ? '官方号' : '个人号'}</p></div>
    <div class="lab-comparison">${article(pair.left, 'left', isFull)}${article(pair.right, 'right', isFull)}</div>
    ${feedbackFields(pair.feedback || {}, isFull)}
    <footer class="lab-decisions"><div class="lab-reasons" role="group" aria-label="选择理由"><span>理由可选</span>
      ${labels.map(label => `<button type="button" data-reason="${label}" aria-pressed="${state.reason === label}">${label}</button>`).join('')}</div>
    <div class="lab-actions">${actions.map(([key, value, label]) => `<button type="button" class="button ${value === 'left' || value === 'right' ? 'outline' : 'quiet'}" data-vote="${value}" aria-keyshortcuts="${key}"><kbd aria-hidden="true">${key}</kbd>${label}</button>`).join('')}
      <button class="button quiet" type="button" data-detail aria-controls="lab-feedback">展开细评</button>
      <button class="button quiet lab-undo" type="button" data-undo>撤回上一题</button></div></footer>`;
}

function renderReport(results, analysis) {
  state.report = analysis;
  const counts = results.length ? `<div class="lab-report-wrap"><table class="lab-results">
    <thead><tr><th>题型</th><th>对比写法</th><th>新版胜</th><th>基准胜</th><th>差不多</th><th>都不行</th><th>仅细评</th><th>跳过</th></tr></thead>
    <tbody>${results.map(row => `<tr><td>${modes[row.kind]}</td><td>${escape(row.variant)}</td><td>${row.challenger}</td><td>${row.baseline}</td><td>${row.tie}</td><td>${row.neither}</td><td>${row.feedback}</td><td>${row.skip}</td></tr>`).join('')}</tbody></table></div>
    <p class="lab-help">按已保存的盲选汇总。片段和全文的结果分别计算。</p>` : '<p class="lab-empty">开始盲选后，这里会显示各写法的得票。</p>';
  review.innerHTML = counts + analysisMarkup(analysis);
}

async function loadQuestion({focus = false, prefer = ''} = {}) {
  const run = ++state.reading;
  const {id, mode} = state;
  if (!id) return;
  state.reason = '';
  state.marks = [];
  state.selection = null;
  state.pair = null;
  if (mode === 'report') {
    const {results, analysis} = await request(`/${id}/report`);
    if (run === state.reading) renderReport(results, analysis);
  } else {
    const {pair} = await request(`/${id}/next?kind=${mode}${prefer ? `&prefer=${encodeURIComponent(prefer)}` : ''}`);
    if (run !== state.reading) return;
    state.pair = pair;
    state.reason = pair?.reason || '';
    state.marks = pair?.feedback?.marks || [];
    renderQuestion(pair);
    batchStatus();
    if (focus && pair) {
      $('#lab-question').focus({preventScroll: true});
      $('#lab-question').scrollIntoView({block: 'nearest'});
    }
  }
}

async function openBatch(id, mode = state.mode) {
  state.events?.close();
  state.events = null;
  state.id = id;
  state.mode = mode;
  state.batch = null;
  state.pair = null;
  const run = ++state.reading;
  review.innerHTML = '<p class="lab-empty">正在读取题目…</p>';
  const {batch} = await request(`/${id}`);
  if (run !== state.reading) return;
  state.batch = batch;
  batchSelect.value = id;
  remember();
  batchStatus();
  await loadQuestion();
  if (state.id === id) watch();
}

async function loadHome(preferred = '') {
  const data = await request();
  form.elements.client.replaceChildren(...data.clients.map(row => new Option(row.name, row.id)));
  form.elements.platform.replaceChildren(...data.platforms.map(row => new Option(row.name, row.id)));
  batchSelect.replaceChildren(...data.batches.map(row => new Option(row.name, row.id)));
  $('#lab-batch').hidden = modeBar.hidden = !data.batches.length;
  if (!data.batches.length) {
    review.innerHTML = '<p class="lab-empty">还没有训练批次。新建一批，就能比较真实出稿的不同写法。</p>';
    return;
  }
  const query = new URLSearchParams(location.search);
  const id = preferred || query.get('batch');
  const mode = query.get('view');
  await openBatch(data.batches.some(row => row.id === id) ? id : data.batches[0].id, Object.hasOwn(modes, mode) ? mode : 'fragment');
}

async function saveChoice(choice, undo = false) {
  if (state.saving || (!undo && !state.pair)) return;
  const {id, mode, pair, reason} = state;
  state.saving = true;
  notice();
  try {
    const {batch, pair_id} = await (undo ? request(`/${id}/undo`, {kind: mode}) :
      request(`/${id}/vote/${pair.id}`, {choice, reason, feedback: collectFeedback(review, state.marks)}));
    if (state.id === id && state.mode === mode) {
      state.batch = batch;
      await loadQuestion({focus: true, prefer: pair_id});
      watch();
    }
  } catch (error) { notice(error.message); }
  finally { state.saving = false; batchStatus(); }
}

batchSelect.addEventListener('change', () => openBatch(batchSelect.value).catch(error => notice(error.message)));
function openMode(mode) {
  if (!mode || mode === state.mode || state.saving || !state.batch) return;
  state.mode = mode;
  notice();
  remember();
  batchStatus();
  loadQuestion().catch(error => notice(error.message));
}
modeBar.addEventListener('click', event => openMode(event.target.closest('[data-kind]')?.dataset.kind));

function updateMarks() {
  review.querySelector('[data-marks]').innerHTML = markList(state.marks);
}

document.addEventListener('selectionchange', () => {
  if (!state.pair) return;
  const selection = window.getSelection();
  const parent = node => (node instanceof Element ? node : node?.parentElement)?.closest('.lab-copy, .lab-article h3');
  const start = parent(selection?.anchorNode);
  const end = parent(selection?.focusNode);
  const side = start && start === end ? start.closest('[data-side]')?.dataset.side : null;
  const text = selection?.toString().trim();
  state.selection = side && text && text.length <= 500 ? {side, text} : null;
  for (const tools of review.querySelectorAll('[data-selection-side]')) tools.hidden = tools.dataset.selectionSide !== state.selection?.side;
});
review.addEventListener('pointerdown', event => {
  if (event.target.closest('[data-mark]')) event.preventDefault();
});
review.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || state.saving) return;
  if (button.dataset.vote) return saveChoice(button.dataset.vote);
  if (button.hasAttribute('data-undo')) return saveChoice('', true);
  if (button.hasAttribute('data-report')) return openMode('report');
  if (button.hasAttribute('data-detail')) {
    $('#lab-feedback').open = true;
    $('#lab-feedback').scrollIntoView({block: 'start'});
    return;
  }
  if (button.dataset.analyze) return analyze(button);
  if (button.dataset.nextRound) return openCreate(state.report.current);
  if (button.dataset.mark && state.selection) {
    if (state.marks.length >= 8) return notice('每题最多保存 8 处选段。');
    const mark = {...state.selection, kind: button.dataset.mark};
    if (!state.marks.some(item => item.side === mark.side && item.text === mark.text && item.kind === mark.kind)) state.marks.push(mark);
    review.querySelector('.lab-feedback').open = true;
    updateMarks();
    window.getSelection().removeAllRanges();
    notice();
  }
  if (button.hasAttribute('data-remove-mark')) {
    state.marks.splice(Number(button.dataset.removeMark), 1);
    updateMarks();
  }
  if (button.dataset.reason) {
    state.reason = state.reason === button.dataset.reason ? '' : button.dataset.reason;
    for (const item of review.querySelectorAll('[data-reason]')) item.setAttribute('aria-pressed', String(item.dataset.reason === state.reason));
  }
});
document.addEventListener('keydown', event => {
  if (dialog.open || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      event.target.closest('input,textarea,select,[contenteditable]')) return;
  const action = actions.find(([key]) => key === event.key);
  if (action && state.pair) {
    event.preventDefault();
    saveChoice(action[1]);
  }
});
status.addEventListener('click', async event => {
  if (event.target.closest('[data-report]')) return openMode('report');
  const button = event.target.closest('[data-run]');
  if (!button) return;
  button.disabled = true;
  notice();
  try {
    await request(`/${state.id}/${button.dataset.run}`, {});
    if (button.dataset.run === 'resume') await openBatch(state.id);
    else button.textContent = '正在收尾…';
  } catch (error) { notice(error.message); button.disabled = false; }
});

async function analyze(button) {
  button.disabled = true;
  const id = state.id;
  notice();
  try {
    const {batch} = await request(`/${id}/analysis`, {retry: button.dataset.analyze === 'retry'});
    if (state.id !== id) return;
    state.batch = batch;
    batchStatus();
    watch();
    if (state.mode === 'report') await loadQuestion();
  } catch (error) { notice(error.message); button.disabled = false; }
}

function enteredTopics() {
  return form.elements.topics.value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [topic, keyword] = line.split(/[|｜]/, 2).map(part => part.trim());
    return {topic, keyword: keyword || topic};
  });
}
function receipt() {
  const count = enteredTopics().length;
  const versions = state.proposal ? 2 : 4;
  $('#lab-receipt').textContent = `${count} 道题 · ${versions * count} 篇真实首稿 · 每题 ${versions} 种写法`;
}
function openCreate(analysis = null) {
  const proposal = analysis?.result?.proposal;
  if (state.proposal?.id !== (proposal ? analysis.id : undefined)) requestKey = '';
  state.proposal = proposal ? {id: analysis.id, ...proposal} : null;
  const context = $('#lab-next-round');
  context.hidden = !proposal;
  if (proposal) {
    context.textContent = `基准写法与「${proposal.title}」做对照。建议范围为${proposal.scope}，请填写新选题。`;
    form.elements.name.value = `验证 · ${proposal.title}`.slice(0, 100);
  }
  $('#lab-form-error').textContent = '';
  receipt();
  dialog.showModal();
}
$('#lab-create').addEventListener('click', () => openCreate());
form.addEventListener('input', () => { requestKey = ''; receipt(); });
for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => dialog.close());
form.addEventListener('submit', async event => {
  event.preventDefault();
  const topics = enteredTopics();
  const errorBox = $('#lab-form-error');
  errorBox.textContent = '';
  if (!topics.length || topics.length > 40 || topics.some(row => !row.topic)) {
    errorBox.textContent = '请填写 1 至 40 道完整选题。';
    return;
  }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  submit.textContent = '正在提交…';
  requestKey ||= crypto.randomUUID();
  try {
    const {id} = await request('', {name: form.elements.name.value, request_key: requestKey,
      ...(state.proposal ? {analysis_id: state.proposal.id} : {}), groups: [{
      client_id: form.elements.client.value, platform_id: Number(form.elements.platform.value),
      account_type: form.elements.account.value, topics,
    }]});
    dialog.close();
    form.reset();
    requestKey = '';
    await loadHome(id);
  } catch (error) {
    if (dialog.open) errorBox.textContent = error.message;
    else notice(error.message);
  } finally { submit.disabled = false; submit.textContent = '开始真实出稿'; }
});

loadHome().catch(error => { notice(error.message); review.replaceChildren(); });
