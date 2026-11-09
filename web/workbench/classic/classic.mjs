import { WorkbenchClient } from '../client.mjs';
import { CustomerClient, importCustomerFile } from '../customers-client.mjs';
import { classicURL } from '../classic-view.mjs';
import { streamDocument, remainingCount } from '../live-model.mjs';
import {
  PROFILE_FIELDS, escapeHTML as e, enabled, markdown, articleBody, accountName,
  planSummary, validateStart, selectionCounts, setCount, splitWords, running,
} from '../model.mjs';

const client = new WorkbenchClient();
const customers = new CustomerClient(client.api.bind(client));
const s = client.state;
const el = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const matching = (left, right) => String(left) === String(right);
const has = (items, id) => items.some(item => matching(item, id));
const hide = (id, hidden) => el(id).classList.toggle('hidden', !!hidden);
const text = (id, value) => { el(id).textContent = value ?? ''; };
const rendered = new Map();
function html(id, value) {
  if (rendered.get(id) === value) return;
  el(id).innerHTML = value;
  rendered.set(id, value);
}
const checked = value => value ? ' checked' : '';
const disabled = value => value ? ' disabled' : '';

let step = 1;
let selectingCustomer = false;
let busy = false;
let previousTask;
let previousJob;
let selectedArticle;
let editView = 'preview';
let picks = new Set();
let knownArticles = new Set();
let wordChoices = new Set();
let aliasCandidates = [];
let lastPreview = '';
let lastStream = '';

const currentArticle = () => client.article(selectedArticle);
const lockedPlan = () => busy || selectingCustomer || client.activeJob || s.batch?.frozen || !s.conversation;
const currentEditorKey = () => s.conversation?.id + ':' + selectedArticle;
const currentEditor = () => s.editors[currentEditorKey()];
const setStep = next => { step = next; render(); window.scrollTo(0, 0); };

function notice() {
  hide('classicNotice', !s.error);
  html('classicNotice', s.error ? '<span>' + e(s.error) + '</span> <button type="button" class="btn ghost sm" id="dismissNotice">关闭</button>' +
    (s.conversation ? ' <button type="button" class="btn ghost sm" id="recoverTask">恢复后台状态</button>' : '') : '');
  if (s.error) {
    el('dismissNotice').onclick = () => { s.error = ''; notice(); };
    if (s.conversation) el('recoverTask').onclick = () => act(async () => {
      await client.reload(); s.error = ''; client.resumeBackground();
    });
  }
}

async function act(action) {
  if (busy) return;
  busy = true;
  render();
  try { await action(); }
  catch (error) { client.fail(error); }
  finally { busy = false; render(); }
}

const dialog = el('classicDialog');
function ask(title, content, confirm = '确认') {
  text('classicDialogTitle', title);
  html('classicDialogBody', content);
  const button = dialog.querySelector('[value=confirm]');
  button.textContent = confirm || '确认';
  button.hidden = !confirm;
  dialog.querySelector('[value=cancel]').textContent = confirm ? '取消' : '关闭';
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' ? new FormData(dialog.querySelector('form')) : null), { once: true });
  });
}

function taskChange() {
  const id = s.conversation?.id;
  if (previousTask === id) return;
  previousTask = id;
  previousJob = null;
  selectedArticle = null;
  editView = 'preview';
  lastPreview = lastStream = '';
  picks = new Set();
  knownArticles = new Set();
  wordChoices = new Set(s.options.keywords);
  aliasCandidates = [];
  step = client.activeJob ? 3 : s.articles.length ? 4 : 1;
  if (id) history.replaceState(null, '', classicURL(id));
}

function render() {
  taskChange();
  const job = s.job;
  if (step === 3 && previousJob && !client.activeJob && s.articles.length &&
      (job?.status === 'done' || s.stream.finished && s.stream.status === 'done') && !remainingCount(s)) {
    step = 4;
  }
  previousJob = client.activeJob ? job.id : previousJob;
  const view = selectingCustomer ? 1 : step;
  for (let n = 1; n <= 4; n++) {
    hide('step' + n, view !== n);
    const item = document.querySelector('[data-step="' + n + '"]');
    item.classList.toggle('active', view === n);
    item.classList.toggle('done', view > n);
    if (view === n) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
  text('srvInfo', !s.loaded ? '正在打开…' : s.dirty ? '正在保存草稿' : s.conversation ? '草稿已保存' : '');
  el('btnHome').disabled = busy || !s.loaded;
  notice();
  if (view === 1) renderPreparation();
  if (view === 2) renderConfirmation();
  if (view === 3) renderWriting();
  if (view === 4) renderArticles();
}

function renderPreparation() {
  const customer = s.clients.find(c => matching(c.id, s.conversation?.client_id));
  const selection = selectingCustomer ? '' : customer?.id;
  const immutable = lockedPlan();
  const options = s.options;
  html('classicCustomer', '<option value="">请选择客户</option>' +
    s.clients.map(c => '<option value="' + e(c.id) + '"' + (matching(c.id, selection) ? ' selected' : '') + '>' + e(c.name) + '</option>').join(''));
  el('classicCustomer').disabled = busy || !s.loaded;
  el('classicCustomer').value = selection || '';
  text('classicTask', selectingCustomer ? '选择客户后开始新方案' : s.conversation?.title || '请选择客户');
  html('classicProfile', !customer || selectingCustomer ? '' : PROFILE_FIELDS.filter(([key]) => key !== 'name').map(([key, label]) =>
    '<div><b>' + e(label) + '</b><p>' + e(options[key] || '—') + '</p></div>').join(''));
  for (const id of ['k_input', 'btnAddKw', 'btnDetectAlias', 'fileInput', 'btnPaste', 'f_note']) el(id).disabled = immutable;
  el('btnToStep2').disabled = busy || selectingCustomer || !s.conversation || client.activeJob || !!s.batch?.frozen;
  hide('classicExistingTask', !selectingCustomer || !s.conversation);
  hide('classicFrozen', !s.batch?.frozen || selectingCustomer);
  if (document.activeElement !== el('f_note')) el('f_note').value = selectingCustomer ? '' : options.note;
  for (const keyword of options.keywords) if (!selectingCustomer) wordChoices.add(keyword);
  html('kwList', selectingCustomer ? '' : [...wordChoices].map(word =>
    '<label class="chip classic-choice' + (has(options.keywords, word) ? ' on' : '') + '"><input type="checkbox" data-word="' +
    e(word) + '"' + checked(has(options.keywords, word)) + disabled(immutable) + '>' + e(word) + '</label>').join(''));
  text('kwHint', selectingCustomer || options.keywords.length ? '' : '请勾选或添加目标关键词');
  renderAliases();
  const docs = selectingCustomer ? [] : [...new Map([...s.documents, ...s.library.filter(d => d.is_current && d.status === 'ready')].map(d => [String(d.id), d])).values()];
  html('matList', docs.map(d => '<div class="mat-row"><label class="classic-choice"><input type="checkbox" data-document="' +
    e(d.id) + '"' + checked(has(s.documentIds, d.id)) + disabled(immutable) + '>' + e(d.filename) +
    '</label><button class="btn ghost sm" data-read-document="' + e(d.id) + '">查看资料</button></div>').join('') ||
    '<p class="tip">' + (customer && !selectingCustomer ? '这位客户还没有可用资料。' : '选客户后显示资料。') + '</p>');
  text('matSummary', selectingCustomer ? '' : '已选 ' + s.documentIds.length + ' 份');
  html('modelChips', selectingCustomer ? '' : client.targets.filter(t => enabled(t) || has(options.models, t.name)).map(t =>
    '<label class="chip classic-choice' + (has(options.models, t.name) ? ' on' : '') + '"><input type="checkbox" data-target="' +
    e(t.name) + '"' + checked(has(options.models, t.name)) + disabled(immutable) + '>' + e(t.name) + '</label>').join(''));
  html('platformCards', selectingCustomer ? '' : client.platforms.filter(p => enabled(p) || options.selections.some(item => matching(item.platform_id, p.id))).map(platform => {
    const counts = selectionCounts(options, platform.id);
    const fields = ['official', 'personal'].map(kind =>
      '<label class="field"><span>' + accountName(kind) + '</span><input type="number" min="0" max="20" step="1" data-platform="' +
      e(platform.id) + '" data-account="' + kind + '" value="' + counts[kind] + '"' + disabled(immutable) + '></label>').join('');
    const formats = (platform.formats || []).map(format => '<label class="classic-choice"><input type="checkbox" data-format="' +
      e(platform.id) + '" value="' + e(format) + '"' + checked(has(options.format_overrides[platform.id] || platform.formats, format)) +
      disabled(immutable) + '>' + e(format) + '</label>').join(' ');
    return '<div class="plat-card' + (counts.official || counts.personal ? ' on' : '') + '"><strong>' + e(platform.name) +
      '</strong><div class="grid2 tight">' + fields + '</div>' + formats + '</div>';
  }).join(''));
  text('planSummary', selectingCustomer ? '' : planSummary(options, client.platforms).text);
}

function renderAliases() {
  if (selectingCustomer) { html('aliasList', ''); return; }
  const groups = new Map([...s.options.aliases, ...aliasCandidates].map(group => [JSON.stringify([...group].sort()), group]));
  html('aliasList', [...groups].map(([key, group]) => '<label class="classic-choice"><input type="checkbox" data-alias="' +
    e(key) + '"' + checked(s.options.aliases.some(a => JSON.stringify([...a].sort()) === key)) + disabled(lockedPlan()) +
    '>' + e(group.join(' / ')) + '</label>').join(' '));
}

function renderConfirmation() {
  const config = s.config || {};
  const platforms = client.platforms.filter(p => s.options.selections.some(item => matching(item.platform_id, p.id)));
  const models = client.targets.filter(m => s.options.models.includes(m.name));
  const summary = planSummary(s.options, client.platforms);
  const issues = validateStart(s.options, client.platforms, client.targets);
  text('classicRecap', [s.options.client, summary.text, s.documentIds.length + ' 份资料', s.options.keywords.length + ' 个关键词'].filter(Boolean).join(' · '));
  text('genSummary', issues.length ? issues.join('；') : '共 ' + summary.count + ' 篇');
  el('btnGenerate').disabled = lockedPlan() || !!issues.length;
  const levels = {high:'高优先抓取', mid:'中等抓取', low:'低抓取'};
  html('prefTable', '<table><thead><tr><th scope="col">目标 AI</th>' +
    platforms.map(p => '<th scope="col">' + e(p.name) + '</th>').join('') + '</tr></thead><tbody>' +
    models.map(m => '<tr><th scope="row">' + e(m.name) + '</th>' + platforms.map(p => {
      const level = (config.prefs || []).find(x => matching(x.model_id, m.id) && matching(x.platform_id, p.id))?.level || 'mid';
      return '<td><span class="lv ' + e(level) + '">' + e(levels[level] || level) + '</span></td>';
    }).join('') + '</tr>').join('') + '</tbody></table>');
  const risks = (config.risks || []).filter(r => r.platform_id == null || platforms.some(p => matching(p.id, r.platform_id)));
  html('riskList', risks.map(r => '<p><strong>' + e(r.level) + ' · ' + e(r.item) + '</strong> ' + e(r.tip) + '</p>').join('') || '<p class="tip">暂无适用的风险项。</p>');
}

function renderWriting() {
  const job = s.job || {};
  const stream = s.stream || {};
  const writing = client.activeJob;
  const remaining = remainingCount(s);
  text('writeTitle', writing ? '正在写第 ' + (stream.index || (job.done || 0) + 1) + ' 篇' : '本次写作进度');
  text('jobMsg', job.message || stream.message || (writing ? '正在准备…' : '已保存的稿件可查看'));
  hide('autoBar', !s.job);
  const total = job.planned || stream.planned || 0;
  const done = job.done ?? stream.done ?? 0;
  el('autoFill').style.width = (total ? Math.min(100, done / total * 100) : 0) + '%';
  text('autoText', done + ' / ' + total + ' 篇');
  el('btnPause').disabled = busy || !writing || !!job.cancel || !!s.batch?.frozen;
  const raw = stream.text || '';
  if (raw !== lastStream) {
    const draft = streamDocument(raw);
    html('streamText', (draft.title ? '<h3>' + e(draft.title) + '</h3>' : '') + markdown(draft.body));
    lastStream = raw;
  }
  hide('streamEmpty', !!el('streamText').textContent.trim());
  text('streamEmpty', writing ? '等待正文…' : '已完成稿件显示在下方。');
  text('streamChars', (stream.chars ?? raw.length) + ' 字');
  text('streamTask', [stream.platform, ...(stream.words || [])].filter(Boolean).join(' · '));
  hide('doneList', !s.articles.length);
  text('doneCount', s.articles.length);
  html('doneItems', s.articles.map(a => '<button class="btn ghost sm" data-article="' + e(a.id) + '">' + e(a.title || '未命名稿件') + '</button>').join(' '));
  hide('writeDone', writing);
  text('writeSummary', remaining ? '还有 ' + remaining + ' 篇待写' : '本次稿件已保存');
  el('btnContinue').disabled = lockedPlan() || !remaining;
  el('btnBackToSetup2').disabled = lockedPlan();
  el('btnGoPreview').disabled = !s.articles.length;
  el('btnSkip').disabled = !s.articles.length;
}

function renderArticles() {
  const articles = s.articles;
  const pickable = articles.filter(a => a.current_version != null && !a.locked);
  for (const a of articles) {
    if (!knownArticles.has(a.id) && a.current_version != null && !a.locked) {
      knownArticles.add(a.id);
      picks.add(a.id);
    }
  }
  if (!currentArticle()) selectedArticle = articles[0]?.id;
  const picked = pickable.filter(a => picks.has(a.id));
  text('planTitle', s.conversation?.title || '本次稿件');
  text('planMeta', planSummary(s.options, client.platforms).text);
  text('listCount', '共 ' + articles.length + ' 篇');
  text('pickCount', '导出勾选：' + picked.length + ' / ' + pickable.length + ' 篇');
  text('btnExportWord', '导出所选 Word（' + picked.length + ' 篇）');
  el('btnExportWord').disabled = !picked.length || busy;
  document.querySelectorAll('[data-export]').forEach(button => { button.disabled = !picked.length || busy; });
  html('articleList', articles.map(a =>
    '<div class="art-row"><input type="checkbox" aria-label="' + e('选择导出 ' + a.title) + '" data-pick="' + e(a.id) +
    '"' + checked(picks.has(a.id)) + disabled(!pickable.includes(a)) + '><button class="btn ' + (matching(selectedArticle, a.id) ? 'primary' : 'ghost') +
    ' sm" data-article="' + e(a.id) + '">' + e(a.title || '未命名稿件') + '</button></div>').join(''));
  const remaining = remainingCount(s);
  hide('progressBanner', !client.activeJob && !remaining && !s.batch?.frozen);
  text('progressText', s.batch?.frozen ? '本批安排已冻结' : client.activeJob ? '后台仍在写稿' : '还有 ' + remaining + ' 篇待写');
  el('btnResume').disabled = lockedPlan() || !remaining;
  el('btnBackToSetup').disabled = lockedPlan();
  const a = currentArticle();
  hide('editorEmpty', !!a);
  hide('editorBody', !a);
  if (!a) return;
  const editor = currentEditor();
  const immutable = busy || a.locked || a.current_version == null;
  text('edPlatform', (client.platforms.find(p => matching(p.id, a.platform_id))?.name || a.platform || '') + ' · ' + accountName(a.account_type));
  text('edAngle', a.angle || '');
  text('edFmt', a.fmt || a.format || '');
  text('edWords', (a.words || []).join(' / ') || a.keyword || '');
  const fields = {edTitle:editor?.title ?? a.title, edBody:editor?.body ?? articleBody(a),
    edTags:editor?.tags ?? (a.tags || []).join('，'),
    edDecl:editor?.decl?.replace(/\r?\n/g, '，') ?? (a.decl || []).join('，')};
  for (const [key, value] of Object.entries(fields)) {
    if (document.activeElement !== el(key)) el(key).value = value ?? '';
    el(key).readOnly = immutable;
  }
  const preview = editView === 'preview';
  hide('edBody', preview);
  hide('edPreview', !preview);
  for (const button of document.querySelectorAll('[data-view]')) button.classList.toggle('active', button.dataset.view === editView);
  if (lastPreview !== fields.edBody) {
    html('edPreview', markdown(fields.edBody));
    lastPreview = fields.edBody;
  }
  el('btnSaveArt').disabled = immutable || !editor?.dirty;
  for (const id of ['btnRegen','btnAuditAgain','btnRestore','btnDelArt']) el(id).disabled = immutable || !!editor?.dirty || client.activeJob || s.operations.some(running);
  text('saveHint', a.locked ? '稿件正在处理…' : editor?.dirty ? '修改已暂存在本机' : '');
  const audit = a.audit || a.article?.audit || {};
  text('auditSummary', audit.summary || audit.note || (a.review === 'unverified' || a.review?.status === 'unverified' ? '此版本尚未核查' : ''));
  const items = Array.isArray(audit) ? audit : audit.items || audit.claims || audit.findings || [];
  html('auditList', Array.isArray(items) ? items.map(item => '<li>' + e(typeof item === 'string' ? item : [item.claim || item.text, item.verdict || item.status, item.reason || item.note].filter(Boolean).join(' · ')) + '</li>').join('') : '');
}

function addKeywords() {
  const words = splitWords(el('k_input').value);
  if (!words.length) return;
  client.setOptions({keywords:[...new Set([...s.options.keywords, ...words])]});
  el('k_input').value = '';
  el('k_input').focus();
}

function checkedValues(attribute, value) {
  return [...document.querySelectorAll('input[' + attribute + ']:checked')]
    .filter(input => value === undefined || input.getAttribute(attribute) === value).map(input => input.value);
}

function rememberEditor() {
  const a = currentArticle();
  if (!a) return;
  s.editors[currentEditorKey()] = {
    base: currentEditor()?.base ?? a.current_version,
    title: el('edTitle').value, body: el('edBody').value,
    tags: el('edTags').value, decl: splitWords(el('edDecl').value).join('\n'), dirty: true, reading: false,
  };
  client.persist();
  renderArticles();
}

function openArticle(id) {
  selectedArticle = client.article(id)?.id;
  editView = 'preview';
  setStep(4);
}

async function beginWriting() {
  if (s.needsConfirmation) {
    const confirmation = await ask('确认后续安排', '<p>' + e(planSummary(s.options, client.platforms).text) +
      ' · ' + s.documentIds.length + ' 份资料</p><p>' + e(s.options.keywords.join('、')) + '</p>', '确认并继续');
    if (!confirmation) return;
  }
  s.error = '';
  await client.start({confirmed:s.needsConfirmation});
  setStep(3);
}

async function changeTask(action) {
  if (s.dirty && s.conversation) await client.saveDraft();
  s.error = '';
  await action();
  selectingCustomer = false;
  await loadWordChoices();
}

async function loadWordChoices() {
  if (!s.conversation) return;
  const data = await customers.plan(s.conversation.client_id);
  for (const word of data.available_keywords || data.plan?.options?.keywords || []) wordChoices.add(word);
  render();
}

async function upload(files) {
  const id = s.conversation?.client_id;
  if (!id || s.batch?.frozen || client.activeJob) return;
  const ids = [...s.documentIds];
  const warnings = [];
  for (const file of files) {
    try {
      const result = await importCustomerFile(customers, id, file, async info => {
        const answer = await ask('选择资料修订', '<p>' + e(info.filename) +
          ' 与已有资料同名。请选择更新哪一份，或作为新资料保存。</p><select name="choice">' +
          '<option value="">作为新资料保存</option>' + (info.candidates || []).map(d =>
            '<option value="' + e(d.id) + '">' + e(d.filename) + '</option>').join('') + '</select>', '保存资料');
        if (!answer) return null;
        return answer.get('choice') ? {update_document_id:answer.get('choice')} : {as_new:true};
      });
      if (result.outcome === 'cancelled') continue;
      if (result.document?.status === 'ready' && result.document.is_current !== false && result.is_current !== false) {
        for (const previous of s.library.filter(d => d.group_id === result.document.group_id && !matching(d.id, result.document.id))) {
          const index = ids.findIndex(value => matching(value, previous.id));
          if (index >= 0) ids.splice(index, 1);
        }
        ids.push(result.document.id);
      } else warnings.push(file.name + '：' + (result.document?.error || '请在客户管理处理资料状态'));
    } catch (error) { warnings.push(file.name + '：' + error.message); }
  }
  s.library = await customers.documents(id);
  client.selectDocuments(ids);
  await client.saveDraft();
  if (warnings.length) throw new Error(warnings.join('；'));
}

function exportArticles(fmt) {
  const ids = s.articles.filter(a => picks.has(a.id) && a.current_version != null && !a.locked).map(a => a.id);
  if (!ids.length) return;
  const url = new URL(client.path('/export'), location.origin);
  url.searchParams.set('fmt', fmt);
  url.searchParams.set('ids', ids.join(','));
  if (fmt === 'md' || fmt === 'txt') url.searchParams.set('scope', 'body');
  location.assign(url);
}

const actions = {
  btnHome: () => { selectingCustomer = true; setStep(1); el('classicCustomer').focus(); },
  classicExistingTask: () => { selectingCustomer = false; setStep(client.activeJob ? 3 : s.articles.length ? 4 : 1); },
  cloneBatch: () => act(() => changeTask(() => client.cloneConversation())),
  btnSettings: () => act(async () => {
    if (s.dirty && s.conversation) await client.saveDraft();
    const params = new URLSearchParams({entry:'settings'});
    if (s.conversation) params.set('conversation', s.conversation.id);
    location.assign('/workbench?' + params);
  }),
  btnHistory: () => act(async () => {
    const tasks = s.conversations;
    const result = await ask('历史记录', '<div id="classicHistory">' +
      (tasks.map((task, index) => '<label class="classic-history-row"><span><input type="radio" name="task" value="' +
        e(task.id) + '"' + checked(index === 0) + '> ' + e(task.title || '未命名方案') + '</span><small>' +
        e(s.clients.find(c => matching(c.id, task.client_id))?.name || '') + '</small></label>').join('') || '<p>还没有历史方案。</p>') +
      '</div>', tasks.length ? '打开方案' : null);
    if (result?.get('task')) await changeTask(() => client.load(result.get('task')));
  }),
  btnAddKw: addKeywords,
  btnDetectAlias: () => act(async () => {
    aliasCandidates = (await client.api('/api/aliases', 'POST', {keywords:s.options.keywords})).aliases || [];
    if (!aliasCandidates.length) await ask('别名分组', '<p>没有发现疑似同义写法。</p>', null);
  }),
  btnPaste: () => act(async () => {
    const data = await ask('粘贴客户资料', '<label>名称 <input name="filename" value="补充资料.txt"></label>' +
      '<label>正文<textarea name="text" rows="8" required></textarea></label>', '保存资料');
    if (data) await client.addDocument({filename:data.get('filename'), text:data.get('text'), kind:'text'});
  }),
  btnToStep2: () => act(async () => {
    if (s.dirty) await client.saveDraft();
    setStep(2);
  }),
  btnBack1: () => setStep(1),
  btnGenerate: () => act(beginWriting),
  btnContinue: () => act(beginWriting),
  btnResume: () => act(beginWriting),
  btnPause: () => act(() => client.stop()),
  btnGoPreview: () => setStep(4),
  btnSkip: () => setStep(4),
  btnBackToWrite: () => setStep(3),
  btnBackToSetup2: () => setStep(1),
  btnBackToSetup: () => setStep(1),
  btnPickAll: () => { picks = new Set(s.articles.filter(a => !a.locked && a.current_version != null).map(a => a.id)); renderArticles(); },
  btnPickNone: () => { picks.clear(); renderArticles(); },
  btnExportWord: () => exportArticles('docx'),
  btnSaveArt: () => act(async () => {
    const draft = currentEditor();
    if (!draft?.dirty) return;
    const a = currentArticle();
    const lines = draft.body.split(/\r?\n/);
    if (draft.title !== a.title && /^#\s+/.test(lines[0]) && lines[0].replace(/^#\s+/, '').trim() === a.title?.trim()) {
      lines[0] = '# ' + draft.title;
    }
    const tags = draft.tags.split(/[,，\s]+/).filter(Boolean).map(tag => tag.startsWith('#') ? tag : '#' + tag);
    await client.saveArticle(selectedArticle, lines.join('\n'), draft.title, draft.base, {tags, decl:splitWords(draft.decl)});
  }),
  btnRegen: () => act(() => articleOperation('regenerate', '重新写这篇', '会重新生成并核查这篇稿件。原版本可在历史版本中查看。')),
  btnAuditAgain: () => act(() => articleOperation('audit', '再次核查', '会对照客户资料重新核查，核查可能修正正文。')),
  btnRestore: () => act(async () => {
    const data = await client.versions(selectedArticle);
    const versions = (data.versions || []).filter(v => !matching(v.id, data.current_version));
    const choice = await ask('历史版本', versions.map((v, index) => '<details><summary>' + e(v.label || '稿件版本') +
      ' · ' + e(v.created_at || '') + '</summary><div class="preview">' + markdown(articleBody(v.article)) +
      '</div><label><input type="radio" name="version" value="' + e(v.id) + '"' + checked(index === 0) + '> 采用此版本</label></details>').join('') ||
      '<p>暂无其他版本。</p>', versions.length ? '采用所选版本' : null);
    if (choice?.get('version')) await client.selectVersion(selectedArticle, Number(choice.get('version')));
  }),
  btnDelArt: () => act(async () => {
    if (await ask('删除稿件', '<p>' + e(currentArticle()?.title) + '</p>', '删除稿件')) await client.deleteArticle(selectedArticle);
  }),
};

async function articleOperation(kind, title, message) {
  if (await ask(title, '<p>' + e(message) + '</p>', title)) await client.articleOperation(selectedArticle, kind);
}

for (const [id, action] of Object.entries(actions)) el(id).addEventListener('click', action);

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.article) openArticle(button.dataset.article);
  if (button.dataset.export) exportArticles(button.dataset.export);
  if (button.dataset.view) { editView = button.dataset.view; renderArticles(); }
  if (button.dataset.readDocument) {
    const doc = [...s.documents, ...s.library].find(d => matching(d.id, button.dataset.readDocument));
    if (doc) void act(() => ask(doc.filename, '<pre>' + e(doc.text) + '</pre>', null));
  }
});

document.addEventListener('change', event => {
  const field = event.target;
  const data = field.dataset;
  if (field.id === 'classicCustomer') {
    if (field.value && (selectingCustomer || !matching(field.value, s.conversation?.client_id))) {
      const id = field.value;
      void act(() => changeTask(() => client.createConversation(id)));
    } else render();
    return;
  }
  if (data.pick) {
    const id = client.article(data.pick)?.id;
    if (field.checked) picks.add(id);
    else picks.delete(id);
    renderArticles();
    return;
  }
  if (lockedPlan()) return;
  const options = s.options;
  if (data.word) client.setOptions({keywords:[...wordChoices].filter(word => word === data.word ? field.checked : options.keywords.includes(word))});
  if (data.document) {
    const docs = s.documentIds.filter(id => !matching(id, data.document));
    if (field.checked) docs.push(data.document);
    client.selectDocuments(docs);
  }
  if (data.target) {
    const targets = options.models.filter(model => model !== data.target);
    if (field.checked) targets.push(data.target);
    client.setOptions({models:targets});
  }
  if (data.alias) {
    const aliases = options.aliases.filter(group => JSON.stringify([...group].sort()) !== data.alias);
    if (field.checked) aliases.push(JSON.parse(data.alias));
    client.setOptions({aliases});
  }
  if (data.platform) {
    const platform = client.platforms.find(p => matching(p.id, data.platform));
    try { client.setOptions({selections:setCount(options, platform.id, data.account, field.value).selections}); }
    catch (error) { client.fail(error); field.value = selectionCounts(options, platform.id)[data.account]; }
  }
  if (data.format) {
    const formats = checkedValues('data-format', data.format);
    if (formats.length) client.setOptions({format_overrides:{...options.format_overrides, [data.format]:formats}});
    else { field.checked = true; client.fail(new Error('每个平台至少保留一种发布形态')); }
  }
});

el('k_input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addKeywords(); }
});
el('f_note').addEventListener('input', event => client.setOptions({note:event.target.value}));
for (const id of ['edTitle','edBody','edTags','edDecl']) el(id).addEventListener('input', rememberEditor);
const dropZone = el('dropZone');
const fileInput = el('fileInput');
dropZone.tabIndex = 0;
dropZone.setAttribute('role', 'button');
dropZone.setAttribute('aria-label', '上传客户资料');
dropZone.addEventListener('click', event => { if (event.target !== fileInput && !lockedPlan()) fileInput.click(); });
dropZone.addEventListener('keydown', event => {
  if (['Enter',' '].includes(event.key) && !lockedPlan()) { event.preventDefault(); fileInput.click(); }
});
dropZone.addEventListener('dragover', event => event.preventDefault());
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  if (!lockedPlan() && event.dataTransfer.files.length) void act(() => upload([...event.dataTransfer.files]));
});
fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (files.length) void act(() => upload(files));
});
el('btnCustomers').addEventListener('click', event => {
  if (!s.dirty || !s.conversation) return;
  event.preventDefault();
  void act(async () => { await client.saveDraft(); location.assign(el('btnCustomers').href); });
});
window.addEventListener('pagehide', () => { client.persist(); client.dispose(); });
client.subscribe(render);
render();
try {
  await client.boot(query.get('conversation'));
  await loadWordChoices();
  if (query.get('entry') === 'tasks') actions.btnHistory();
  if (['review','export'].includes(query.get('entry')) && s.articles.length) setStep(4);
} catch (error) { client.fail(error); }
