import { compactTaskTitle, installTaskContext, recentTaskMarkup, recentTasks, taskDisplayTitle, taskStateButton } from './task-list.mjs';
import { geoPath, guidePath, railIcons, shortVideoPath, workspaceRail } from './workspace-rail.mjs';
import { activityMarkup, liveMarkup, reconcile, setupLiveUI, tickElapsed, captureFollowing, restoreFollowing } from './live-workspace.mjs';
import { remainingCount } from './live-model.mjs';
import { createModeSwitcher } from './mode-switch.mjs';
import { createTaskPresentation } from './task-presentation.mjs';
import { createWorkbenchPaperFeedback } from './paper-feedback.mjs';
import { paperMotionEnabled, setPaperMotionEnabled } from '../assets/paper-motion.mjs';
import { liveReplyMarkup } from './dialogue-view.mjs';
import { WorkbenchClient } from './client.mjs';
import { randomUUID } from './browser-crypto.mjs';
import { DEFAULT_MODEL, PROFILE_FIELDS, clone, enabled, running, accountName, splitWords, normalizeOptions, selectionCounts, setCount,
  togglePlatform, planSummary, optionIssues, escapeHTML as e, markdown, articleBody, valueText,OPERATION_KIND,latestOperation,reviewDefaults,reviewSelection,interviewMessageText } from './model.mjs';
import { CustomersWorkspace } from './customers.mjs';
import { chooseArticleTopic } from './topic-picker.mjs';
import { createQuickCreation } from './quick/batch.mjs';
import { CustomerClient, importCustomerFile, recognitionExtensions } from './customers-client.mjs';
import { RecognitionReview } from './customer-recognition.mjs';
import { applyFontSizes, changeFontSize, fontSizeControl, installReadingLayout, restoreReadingScroll } from './reading-view.mjs';
import { articleWordCount, generationLengthField, generationContextMarkup } from './generation-style.mjs';
import { keywordLinksField, keywordLinksText, parseKeywordLinks } from './keyword-links.mjs';
import { articleEditorialMarkup } from './article-editorial.mjs';
import { classicEnabled, setClassicEnabled, classicURL } from './classic-view.mjs';
import { WORKBENCH_PALETTES, currentWorkbenchPalette, setWorkbenchPalette } from './palette.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let mode = document.body.dataset.mode;
const client = new WorkbenchClient();
const updatePaperFeedback = createWorkbenchPaperFeedback();
const taskPresentation = createTaskPresentation(document, {reduced:()=>matchMedia('(prefers-reduced-motion: reduce)').matches});
const customerService = new CustomerClient(client.api.bind(client));
let pendingChat=null, topicPickerOpen=false;
const syncReadingLayout = installReadingLayout($('#root'));
applyFontSizes(client.state.ui);
const initialRoute = new URLSearchParams(location.search);
let customerArea = initialRoute.get('area') === 'customers', quickArea = initialRoute.get('area') === 'quick';
let entryView = initialRoute.get('area') === 'new' ? 'new' : initialRoute.has('conversation') ? null : 'start';
const DEFAULT_ENTRY_MODE = 'zip';
let entryMode = DEFAULT_ENTRY_MODE;
let creatingTask = false, newTaskRequest = null;
let wasWriting = false, navigationGeneration = 0;
const classicSettingsVisit = classicEnabled() && new URLSearchParams(location.search).get('entry') === 'settings';
function enterClassic(id = client.state.conversation?.id) {
  client.persist();
  intentionalNavigation = true;
  location.assign(classicURL(id));
}
const paths = {
  ...railIcons,
  logo: '<circle cx="12" cy="12" r="10"/><path d="M8.5 18V6h9M8.5 12h6M13 18h3"/>',
  menu: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M12 20V4m-6 6 6-6 6 6"/>', right: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>', download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  check: '<path d="m4 12 5 5L20 6"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>', review: '<path d="M9 3h10v18H5V7zM9 3v4H5M9 12h6M9 16h4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>', back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
const button = (action, text, symbol, cls = '', disabled = false, extra = '') => `<button type="button" class="button ${cls}" data-action="${action}" ${disabled ? 'disabled' : ''} ${extra}>${symbol ? icon(symbol) : ''}${text}</button>`;
const iconButton = (action, text, symbol) => `<button type="button" class="icon-button" data-action="${action}" aria-label="${text}" title="${text}">${icon(symbol)}</button>`;
const statusText = status => ({ running: '正在处理', done: '已完成', draft: '草稿', paused: '已暂停', error: '未完成', stopped: '已停止', interrupted: '执行中断', idle: '待开始' }[status] || status || '草稿');
function factMarkup(report) {
  if(typeof report==='string')return `<p>${e(report)}</p>`;
  if(!report||!Object.keys(report).length)return '<p>此版本未记录模型复核。</p>';
  const findings=report.findings;
  return `${report.status?`<p><strong>模型复核返回：${e(report.status)}</strong></p>`:''}${report.verdict?`<p>原生核查返回：${e(report.verdict)}</p>`:''}<p>${e(report.summary||report.reason||report.assessment||report.message||'模型记录已保存。')}</p>${report.independently_verified===false?'<p class="helper">独立核验：未进行。请结合下方实际审阅意见判断。</p>':''}${Array.isArray(findings)?`<p class="small">模型问题记录：${findings.length} 条</p>${findings.map(issue=>`<section><blockquote>${e(issue.quote||'')}</blockquote><p>${e(issue.kind||'')} ${e(issue.why||'')}</p>${issue.revised!=null?`<p>核查后：${e(issue.revised)}</p>`:''}</section>`).join('')}`:''}<details><summary>查看完整模型返回</summary><pre class="diff-text">${e(valueText(report))}</pre></details>`;
}
function checksOnly(value) { return Array.isArray(value) ? value.map(checksOnly) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key])=>!/score|rating/i.test(key)).map(([key,v])=>[key,checksOnly(v)])) : value; }
function nativeArticleInfo(a) {
  if(!a)return '';
  const rows=[['写作角度',a.angle],['关键词',(a.keywords||[]).join('、')||a.keyword],['标签',(a.tags||[]).join('、')],['声明',(a.decl||[]).join('、')]];
  return `<details id="native-article-info"><summary>ZIP 稿件信息与检查</summary><dl class="plain-dl">${rows.filter(([,value])=>value).map(([key,value])=>`<div><dt>${key}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>${a.risk_tips?.length?`<h3>风险提示</h3>${a.risk_tips.map(t=>`<p>${e(valueText(t))}</p>`).join('')}`:''}${a.audit&&Object.keys(a.audit).length?`<h3>原生核查</h3>${factMarkup(a.audit)}`:''}${a.geo&&Object.keys(a.geo).length?`<h3>具体检查项</h3><pre class="diff-text">${e(valueText(checksOnly(a.geo)))}</pre>`:''}</details>`;
}
let panel = null, surface = 'compose', step = 1, selectedId = null, composing = false, renderPending = false;
let selectedSuggestions = new Set(),conservativeSuggestions=new Set(),reviewError='',selectedReviewId=null, rewriteMode = 'full', reviews = {}, versionsData = {}, modalSubmit = null, lastTask = null;
let tooltipTimer, toastTimer, importing = false, operationBusy = false, lastFocus, lastFocusAction, intentionalNavigation = false;
let settingsSession=null, renderParts=new Map(), lastInspectorKey='', renderedArticleId=null;
let aliasTimer, aliasState = { key: '', groups: [], status: 'idle' };
const modeViews = new Map();
let stepGeneration = 0;
const modeSwitcher = createModeSwitcher({getMode:()=>mode, getTaskId:()=>client.state.conversation?.id,
  saveMode:next=>client.saveDraft(next), applyMode:applyMode});
const aliasCache = new Map();
const modal = $('#modal');
$('.dialog-head [data-close]').innerHTML = icon('close');
$$('[data-close]', modal).forEach(b => b.onclick = () => settingsSession&&!settingsSession.current?.main&&b.closest('footer')?openSettings(settingsSession.section,true):modal.close());
modal.addEventListener('close', () => { settingsSession=null;modal.classList.remove('settings-dialog');$('.dialog-actions [data-close]',modal).textContent='取消';modalSubmit = null; if(lastFocus?.isConnected)lastFocus.focus();else if(lastFocusAction)$(`[data-action="${CSS.escape(lastFocusAction)}"]`)?.focus(); });
$('#modal-form').onsubmit = async event => {
  event.preventDefault(); if (!modalSubmit) return;
  const owner=modalSubmit,submit = $('#modal-submit'); submit.disabled = true;for(const nav of $$('[data-settings-section]',modal))nav.disabled=true; $('#modal-error').textContent = '';
  try { const close = await owner(new FormData($('#modal-form'))); if (owner===modalSubmit&&close !== false) modal.close(); }
  catch (error) { $('#modal-error').textContent = error.message; }
  finally { if(owner===modalSubmit)submit.disabled=false;for(const nav of $$('[data-settings-section]',modal))nav.disabled=false; }
};
function dialog(title,html,submit,options={}) { if(settingsSession)return settingsDisplay(title,html,submit,options);return baseDialog(title,html,submit,options); }
function baseDialog(title, html, submit, { label = '保存', wide = false } = {}) {
  if(!modal.open){lastFocus = document.activeElement?.closest('.toolbar-menu')?.querySelector('summary')||document.activeElement;lastFocusAction=lastFocus?.dataset.action;} modal.classList.toggle('wide', wide);
  $('#modal-body').onchange = null;$('#modal-body').onclick=null;
  $('#platform-summary')?.remove();
  $('#profile-switch-toggle')?.remove();
  $('#modal-title').textContent = title; $('#modal-body').innerHTML = html; $('#modal-error').textContent = '';
  $('#modal-submit').disabled=false;$('#modal-submit').textContent = label; $('#modal-submit').hidden = !submit; modalSubmit = submit;
  if (!modal.open) modal.showModal();
}
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 4200); }
function displayTaskTitle(task, compact = false) {
  const s = client.state;
  const active = task.id === s.conversation?.id;
  const brief = active ? s.options : task.brief;
  const documentIds = active ? s.documentIds : task.document_ids;
  const topic = client.writingTopic(task.id, {options:brief, documentIds});
  const customer = s.clients.find(c => c.id === task.client_id);
  const customerName = brief?.client?.trim() || customer?.name?.trim() || '';
  const title = taskDisplayTitle(task, {brief, topic, customerName});
  return compact ? compactTaskTitle(title, customerName, customer?.profile?.brand) : title;
}
function updateTaskSearch() {
  const search = $('#task-search');
  if (!search) return;
  const archived = $('#task-search-archived').checked;
  const phrase = search.value.trim().toLowerCase();
  const tasks = (archived ? client.state.conversations.filter(t=>t.archived_at) : recentTasks(client.state.conversations))
    .map(task => ({task, title:displayTaskTitle(task)}))
    .filter(({task, title}) => title.toLowerCase().includes(phrase) || displayTaskTitle(task, true).toLowerCase().includes(phrase));
  $('#task-search-results').innerHTML = tasks.map(({task, title})=>`<div class="task-search-row"><button type="button" class="task-row" data-task="${e(task.id)}" data-guide-intent="${e(search.dataset.guideIntent)}">${e(title)}</button>${archived ? taskStateButton(task,'archived') : ''}</div>`).join('') || '<p class="empty">没有匹配的任务。</p>';
}
function findTask(intent='') {
  const titles={review:'选择要审阅的任务',export:'选择要导出的任务'};
  dialog(titles[intent]||'查找任务',`<label class="field"><span>任务标题</span><input type="search" id="task-search" data-guide-intent="${e(intent)}" placeholder="输入标题关键词"></label><label class="check-label"><input type="checkbox" id="task-search-archived">已归档</label><div id="task-search-results"></div>`,null);
  $('#task-search').oninput=updateTaskSearch;
  $('#task-search-archived').onchange=updateTaskSearch;
  updateTaskSearch();
  $('#task-search').focus();
}
const closeTaskContext = installTaskContext(()=>client.state.conversations,hideTooltip);
async function changeTaskState(control) {
  const task = client.state.conversations.find(t=>t.id===control.dataset.taskId);
  if (!task) return;
  const field = control.dataset.taskState;
  const enabled = !task[`${field}_at`];
  closeTaskContext();
  await client.setTaskState(task.id,field,enabled);
  updateTaskSearch();
  toast(field === 'pinned' ? (enabled ? '任务已置顶' : '已取消置顶') : (enabled ? '任务已归档' : '任务已恢复'));
}
async function openGuideTarget(intent) {
  if(!['review','export'].includes(intent))return;
  const article=client.state.articles.find(a=>a.current_version!=null&&!a.locked);
  if(!article){toast('这个任务还没有可操作的已保存稿件，请先完成写作。');return;}
  selectedId=article.id;surface='articles';step=4;showDraft('article');panel=intent==='review'?'review':null;render();
  if(intent==='export')await exportDialog();
}
async function act(fn) {
  try { client.state.error = ''; await fn(); }
  catch (error) { if(error.status===400){if(error.operationKind===OPERATION_KIND.chat){client.setMessageError(error.message,error.conversationId);if(client.state.conversation?.id===error.conversationId){surface='compose';render();}}else if(panel==='review'){reviewError=error.message;render();if(/素材/.test(error.message))$('#rewrite-material')?.focus();}else if(mode==='chat'&&/关键词|平台|安排/.test(error.message)){panel='arrangement';render();}if(error.operationKind!==OPERATION_KIND.chat)toast(error.message);}else{client.fail(error);toast(error.message);} }
}
function currentClient() {
  const {conversation, clients, options} = client.state;
  if (!conversation) return null;
  const id = conversation.client_id, customer = clients.find(item => item.id === id);
  const profile = Object.fromEntries(PROFILE_FIELDS.filter(([key]) => key !== 'name').map(([key]) => [key,options[key] ?? '']));
  return {...customer,id,name:options.client ?? '',profile};
}
function moreMenu(id,label,items) { return `<details class="toolbar-menu" id="${id}"><summary class="icon-button" aria-label="${label}" title="${label}">${icon('more')}</summary><div class="menu-items">${items}</div></details>`; }
function readingBody(article) {
  const lines=articleBody(article).split(/\r?\n/);
  if(/^#\s+/.test(lines[0]||'')&&lines[0].replace(/^#\s+/,'').trim()===article.title?.trim())lines.shift();
  return lines.join('\n');
}
function currentArticle() { return client.article(selectedId) || client.state.articles[0]; }
function editorKey(a) { return `${client.state.conversation?.id}:${a.id}`; }
function localEditor(a) { return client.state.editors[editorKey(a)]; }
const savingEditors = new Set();
function editedBody(a, editor) {
  const lines = editor.body.split(/\r?\n/);
  if (editor.title !== a.title && /^#\s+/.test(lines[0]) && lines[0].replace(/^#\s+/,'').trim() === a.title?.trim()) {
    lines[0] = '# ' + editor.title;
    return lines.join('\n');
  }
  return editor.body;
}
function isOperationRunning() { return client.state.operations.some(o => running(o) && o.kind!==OPERATION_KIND.writing); }
function reviewFor(a) {
  if (reviews[a.id]) return reviews[a.id];
  const op = latestOperation(client.state.operations,OPERATION_KIND.review,a.id);
  const rewrite=latestOperation(client.state.operations,OPERATION_KIND.rewrite,a.id);
  return op ? { ...op.result, operation_id: op.id,...(rewrite?.result.base_version===op.result.base_version?{candidate:rewrite.result.candidate_version}:{}) } : null;
}

function sidebarToggle(collapsed) {
  const label = collapsed ? '展开任务栏' : '折叠任务栏';
  return `<button type="button" class="icon-button ${collapsed ? 'task-sidebar-opener' : ''}" id="sidebar-toggle" data-action="collapse" aria-label="${label}" aria-controls="task-sidebar" aria-expanded="${!collapsed}" title="${label}">${icon('menu')}</button>`;
}
function workspaceReturnPath(articleId) {
  const params = new URLSearchParams();
  if (!entryView && client.state.conversation?.id) params.set('conversation',client.state.conversation.id);
  if (entryView === 'new' && !customerArea && !quickArea) params.set('area','new');
  if (customerArea) {
    params.set('area','customers');
    customers.writeLocation(params);
  }
  if (quickArea) {
    params.set('area','quick');
    if (quick.batchId) params.set('batch',quick.batchId);
  }
  if (!entryView && articleId) params.set('article',articleId);
  return location.pathname + (params.size ? '?' + params : '');
}
function videoWorkspaceHref(customerId) {
  const query = new URLSearchParams({return_to:workspaceReturnPath(currentArticle()?.id)});
  if (customerId) query.set('client_id',customerId);
  return `${shortVideoPath}?${query}`;
}
function sidebar(s) {
  const area = quickArea ? 'quick' : customerArea ? 'customers' : 'standard';
  const customerId = customerArea ? (customers.customer?.archived_at ? null : customers.id) :
    quickArea || standardEntry() ? null : s.conversation?.client_id;
  const links = {video:videoWorkspaceHref(customerId)};
  if (customerArea && customerId && !customers.batch) {
    links.geo = `${geoPath}?${new URLSearchParams({client:customerId,return_to:workspaceReturnPath()})}`;
  }
  const recent = recentTasks(s.conversations);
  return `<aside class="sidebar workbench-sidebar" aria-label="工作台导航">
    ${workspaceRail(area,{actions:['standard','quick','customers','settings'],links})}
    <section class="task-sidebar" id="task-sidebar" aria-label="任务列表" ${s.ui.collapsed?'hidden':''}>
      <header class="task-sidebar-head"><a class="task-sidebar-brand" href="${guidePath}" aria-label="方立科技使用指南" title="使用指南"><svg class="task-sidebar-mark" viewBox="94 43.5 68 45" width="30" height="20" aria-hidden="true" focusable="false"><use href="/assets/ferly-mark.svg#mark"/></svg><span>方立科技</span></a><div>${iconButton('find-task','查找任务','search')}${s.ui.collapsed?'':sidebarToggle(false)}</div></header>
      <button type="button" class="nav-button task-new" data-action="start-page">${icon('plus')}新建内容</button>
      <div class="recent" id="recent"><h2>最近任务</h2>${recent.length ? recent.map(t=>recentTaskMarkup(t,area==='standard' && !standardEntry() && t.id===s.conversation?.id,displayTaskTitle(t,true))).join('') : '<p class="empty-tasks">创建内容后，任务会保存在这里。</p>'}</div>
      <div class="resizer" id="sidebar-resizer" role="separator" aria-label="调整任务侧栏宽度" aria-orientation="vertical" tabindex="0" aria-valuemin="190" aria-valuemax="380" aria-valuenow="${s.ui.sidebarWidth}"></div>
    </section></aside>`;
}
function modeSwitchMarkup(selectedMode, disabled = false) {
  return `<div class="mode-switch" role="group" aria-label="创作方式">${[['chat','对话'],['zip','分步']].map(([value,label]) =>
    `<button type="button" data-action="mode-${value}" class="${selectedMode === value ? 'active' : ''}" aria-pressed="${selectedMode === value}" ${disabled ? 'disabled' : ''}><span class="mode-label">${label}</span></button>`).join('')}</div>`;
}
function topbar(s) {
  const opener = s.ui.collapsed ? sidebarToggle(true) : '';
  const entry = standardEntry();
  if (entry) return `<header class="topbar entry-topbar"><div class="task-heading">${opener}</div>${entry === 'new' && !classicEnabled() ? modeSwitchMarkup(entryMode,creatingTask) : ''}</header>`;
  if (quickArea || customerArea) {
    const back = customerArea && quick.returningFromDocuments ? button('quick','返回本批安排','back','outline') : '';
    return `<header class="topbar${customerArea?' customer-topbar':''}"><div class="task-heading">${opener}</div>${back}</header>`;
  }
  const a = currentArticle();
  const reading = a && (mode === 'zip' ? step === 4 : draftPanelState().open && draftPanelState().view === 'article');
  return `<header class="topbar"><div class="task-heading">${opener}<strong>${e(s.conversation ? displayTaskTitle(s.conversation) : '新建内容')}</strong><span class="save-status" role="status">${s.dirty ? '草稿待保存' : s.saved || s.conversation?.status === 'draft' ? '草稿已保存' : '已从后台恢复'}</span></div>
    ${modeSwitchMarkup(mode)}
    <div class="top-actions">${reading ? '' : button('sources', '<span class="action-label">资料</span>', 'file', 'quiet', false, `aria-expanded="${panel === 'sources'}"`)}${s.conversation?.archived_at ? taskStateButton(s.conversation,'archived') : s.conversation ? moreMenu('task-menu','任务更多操作',taskStateButton(s.conversation,'archived')+button('delete-task','删除任务',null,'quiet sm danger',client.activeJob||isOperationRunning())) : ''}${!reading && s.conversation ? button('export','导出','download','outline') : ''}</div></header>`;
}
function standardEntry() {
  if (customerArea || quickArea) return null;
  return entryView || (!client.state.conversation ? 'start' : null);
}

function startPage() {
  return `<section class="creation-entry creation-start" aria-labelledby="creation-entry-title">
    <h1 id="creation-entry-title" tabindex="-1">今天想做什么？</h1>
    <div class="creation-start-actions">
      <div>${button('new-task','新建内容','plus','primary')}<p>选客户，写一篇文章</p></div>
      <div>${button('add-customer','新建客户','plus','outline')}<p>建档，导入客户资料</p></div>
    </div>
  </section>`;
}

function newContentPage() {
  const clients = client.state.clients.filter(c => !c.archived_at && !c.import_draft);
  return `<section class="creation-entry creation-new" aria-labelledby="creation-entry-title">
    ${button('start-page','返回开始页','back','quiet sm')}
    <h1 id="creation-entry-title" tabindex="-1">新建内容</h1>
    ${clients.length ? `<form id="new-content-form">
      <label class="field"><span>给谁写</span><select name="client_id" required data-key="${e(JSON.stringify(clients.map(c=>[c.id,c.name,c.name_conflict])))}" ${creatingTask?'disabled':''}>
        <option value="">选择客户</option>
        ${clients.map(c => `<option value="${e(c.id)}" ${newTaskRequest?.clientId===c.id?'selected':''}>${e(c.name + (c.name_conflict ? ' · ' + customers.distinguishClient(c) : ''))}</option>`).join('')}
      </select></label>
      <div class="creation-entry-actions">
        ${button('new-client','新建客户','plus','outline',creatingTask)}
        <button class="button primary" type="submit" ${creatingTask?'disabled':''}>${creatingTask?'正在创建…':'继续创作'}</button>
      </div>
    </form>` : `<p>先建一位客户，再开始写作。</p>${button('new-client','新建客户','plus','primary',creatingTask)}`}
  </section>`;
}
function notices(s) {
  const issues=optionIssues(s.options,client.platforms,client.targets);
  return `${s.batch?.frozen ? `<div class="notice" role="status"><span>本批安排已冻结</span>${button('clone-task','沿用安排新建',null,'outline sm',client.activeJob||isOperationRunning())}</div>` : ''}${s.bootstrap?.preview ? '<div class="preview-banner">离线接口预览 · 示例操作由本机替身响应 · 真实模型调用 0</div>' : ''}
    ${issues.length?`<div class="notice" role="status"><span>安排待调整：${issues.map(e).join('；')}</span>${button('compose','查看安排',null,'quiet sm')}</div>`:''}
    ${s.error ? `<div class="notice error" role="alert"><span>${e(s.error)}</span>${button('recover', '恢复后台状态', null, 'outline', !s.conversation)}${button('dismiss-error', '关闭提示', null, 'quiet')}</div>` : ''}
    ${s.needsConfirmation ? `<div class="notice"><span>已更新后续要求。${client.activeJob ? '当前篇仍在收尾，后续已请求暂停。' : '确认新的资料、平台与要求后再继续。'}</span>${button('confirm-plan', '确认并继续', null, 'outline', client.activeJob)}${button('compose', '查看要求', null, 'quiet')}</div>` : ''}`;
}
function clientLine() {
  const c = currentClient();
  const customer = c
    ? button('profile', `<span>${e(c.name)}</span>${icon('chevron')}`, null, 'customer-profile-trigger', false, 'aria-haspopup="dialog"')
    : `<strong>尚未选择</strong>${button('choose-client','选择客户',null,'outline sm')}${button('new-client','新建客户','plus','outline sm')}`;
  return `<div class="client-line"><span>本次客户</span>${customer}</div>`;
}
function docRows(docs, { selectable = false, compact = false } = {}) {
  const selected = new Set(client.state.documentIds.map(String));
  return docs.length ? docs.map(doc => {
    const id = e(doc.id), name = e(doc.filename);
    const info = `<span class="doc-info"><strong>${name}</strong>${compact ? '' : `<small>${e(doc.kind || '资料')} · ${(doc.text || '').length.toLocaleString()} 字${doc.digest ? ' · 已入库' : ''}${doc.is_current === false ? ' · 历史修订' : ''}</small>`}</span>`;
    const content = selectable ? `<label class="doc-choice"><input type="checkbox" id="doc-choice-${id}" data-doc-choice="${id}" aria-label="${name}" ${selected.has(String(doc.id)) ? 'checked' : ''}>${info}</label>` : `${icon('file')}${info}`;
    return `<div class="doc-row" data-key="doc-${id}">${content}<button class="icon-button" data-doc="${id}" aria-label="查看 ${name}" title="核对正文">${icon('search')}</button></div>`;
  }).join('') : '<p class="empty">添加客户资料，开始这次创作。</p>';
}
function selectedDocs() { const docs=new Map([...client.state.documents,...client.state.library].map(d=>[String(d.id),d]));return client.state.documentIds.map(id=>docs.get(String(id))).filter(Boolean); }
function taskDocumentChoices() {
  const selected = selectedDocs();
  if (client.state.batch?.frozen) return selected;
  const library = client.state.library.filter(doc => doc.is_current && doc.status === 'ready' && doc.text?.trim());
  return [...new Map([...library, ...selected].map(doc => [String(doc.id), doc])).values()];
}
function pendingImageRows() {
  if (client.state.batch?.frozen) return '';
  return client.state.library.filter(doc=>doc.status==='pending' && doc.has_recognition).map(doc=>
    `<div class="doc-row" data-key="recognition-${e(doc.id)}"><span class="doc-info"><strong>${e(doc.filename)}</strong><small>识别待确认</small></span>${button('recognize-document','核对识别文字',null,'quiet sm',importing,`data-recognition-id="${e(doc.id)}"`)}</div>`).join('');
}
function narratedVideoHref(conversation, article) {
  if (!conversation?.client_id) return '';
  const query = new URLSearchParams({client_id:conversation.client_id,return_to:workspaceReturnPath(article?.id)});
  if (article) {
    if (!Number.isSafeInteger(article.id) || article.id < 1 || !Number.isSafeInteger(article.current_version) || article.current_version < 1) return '';
    query.set('article_id', article.id);
    query.set('version_id', article.current_version);
  } else {
    if (!conversation.id) return '';
    query.set('conversation_id', conversation.id);
  }
  return `${shortVideoPath}?${query}`;
}
function materialsVideoButton() {
  return narratedVideoHref(client.state.conversation) && selectedDocs().length
    ? button('narrated-from-materials', '用本次资料制作视频', 'video', 'quiet sm', importing)
    : '';
}
async function openMaterialsVideo() {
  const task = client.state.conversation;
  const href = narratedVideoHref(task);
  if (!href || !selectedDocs().length || importing) return;
  if (client.state.dirty) await client.saveDraft();
  if (client.state.conversation?.id !== task.id) return;
  if (client.state.dirty) throw new Error('资料选择刚刚更新，请保存后再进入视频制作');
  location.assign(href);
}
function sourceBlock() {
  return `<div class="sources-preview" id="source-dropzone" data-dropzone><div class="spread"><h2 class="section-title">客户资料</h2><div class="inline-actions">${button('upload', '上传文件或图片', 'plus', 'quiet sm', importing)}${button('paste', '粘贴', null, 'quiet sm')}${materialsVideoButton()}</div></div>${docRows(taskDocumentChoices(), {selectable:true})}${pendingImageRows()}${importing?'<p role="status">正在保存原件并解析…</p>':''}</div>`;
}
function keywordEditor({showAliases = true} = {}) {
  const selected = new Set(client.state.options.keywords);
  return `<section class="keyword-editor">
    <div class="spread"><label class="field" for="keyword-entry"><span>目标搜索关键词</span></label>
      <div class="inline-actions">${showAliases ? button('detect-aliases','别名分组',null,'quiet sm') : ''}${button('edit-keyword-links','串联关键词',null,'quiet sm')}</div>
    </div>
    <div class="reply-row"><input type="text" id="keyword-entry" placeholder="输入关键词，回车添加">${button('add-keyword','添加','plus','outline')}</div>
    <div class="keyword-list">${client.keywordChoices.map((word,index)=>`<label class="keyword-choice"><input type="checkbox" id="keyword-choice-${index}" data-keyword-choice="${e(word)}" ${selected.has(word) ? 'checked' : ''}><span>${e(word)}</span></label>`).join('')}</div>
    ${showAliases ? aliasHint() : ''}
  </section>`;
}
function aliasHint() {
  if(aliasState.status==='loading')return '<p class="helper" role="status">正在检查关键词的别名写法…</p>';
  if(aliasState.status==='error')return '<p class="helper" role="status">别名提示暂未完成，可点“识别并确认别名”重试。</p>';
  const confirmed=new Set(client.state.options.aliases.map(group=>JSON.stringify([...group].sort())));
  const candidates=aliasState.groups.filter(group=>!confirmed.has(JSON.stringify([...group].sort())));
  return candidates.length?`<p class="helper" role="status">发现 ${candidates.length} 组疑似别名，尚未合并：${candidates.map(group=>e(group.join(' / '))).join('；')}。请核对后确认。</p>`:'';
}
function syncAliasCandidates() {
  const key=JSON.stringify(client.state.options.keywords);
  if(key===aliasState.key)return;
  clearTimeout(aliasTimer);aliasState={key,groups:[],status:'idle'};
  if(client.state.options.keywords.filter(word=>word.trim()).length<2)return;
  aliasState.status='loading';
  aliasTimer=setTimeout(()=>loadAliasCandidates(key).catch(()=>{}),350);
}
async function loadAliasCandidates(key=JSON.stringify(client.state.options.keywords)) {
  let request=aliasCache.get(key);
  if(!request){request=client.api('/api/aliases','POST',{keywords:JSON.parse(key)}).then(result=>result.aliases);aliasCache.set(key,request);}
  try { const groups=await request;if(aliasState.key===key){aliasState={key,groups,status:'done'};render();}return groups; }
  catch(error){aliasCache.delete(key);if(aliasState.key===key){aliasState={key,groups:[],status:'error'};render();}throw error;}
}
function targetsBlock(prefix = 'target') {
  const opts = client.state.options;
  const available=client.targets.filter(enabled),invalid=opts.models.filter(name=>!available.some(t=>(t.name||t)===name));
  return `<div class="target-list">${available.map((t, i) => { const name = typeof t === 'string' ? t : t.name; return `<label><input type="checkbox" id="${prefix}-${i}" data-target="${e(name)}" ${opts.models.includes(name) ? 'checked' : ''}>${e(name)}</label>`; }).join('') || '<span class="muted small">尚未配置目标 AI，请在配置管理中添加。</span>'}${invalid.map(name=>`<span class="invalid-choice">${e(name)} · 已失效 <button type="button" class="button quiet sm" data-remove-target="${e(name)}">移除</button></span>`).join('')}</div>`;
}
function expandedOptions() {
  return `<details class="advanced" id="advanced-options"><summary>本次可选调整</summary><div class="details-content">${advancedFields()}</div></details>`;
}
function advancedFields() {
  const o=client.state.options;
  return `<div class="form-grid">${generationLengthField(o)}<label class="field"><span>同现品牌 / 公司 <span title="自家品牌与公司仍按原规则排除。">ⓘ</span></span><textarea class="input" id="option-rivals" data-option="rivals" rows="2">${e((o.rivals||[]).join('\n'))}</textarea></label><label class="field"><span>别名分组 <span title="每行一组，同组用逗号分隔；只在确认后生效。">ⓘ</span></span><textarea class="input" id="option-aliases" rows="2">${e((o.aliases||[]).map(g=>g.join('，')).join('\n'))}</textarea></label></div>`;
}
function messageTarget() {
  const draft=draftPanelState(),a=currentArticle();
  if(client.activeJob||!a?.current_version)return 'requirements';
  if(client.state.batch?.frozen)return 'article';
  return draft.target||'article';
}
function chatRevisionMessages() {const key=client.state.conversation?.id||'_new';client.state.ui.chatRevisions??={};return client.state.ui.chatRevisions[key]??=[];}
function revisionMessagesMarkup(anchor) {
  return chatRevisionMessages().filter(m=>m.anchor===anchor).map((m,index)=>`<div class="message user" data-key="revision-user-${m.id}"><span class="message-label">你 · 修改第 ${m.number} 篇</span><div class="message-copy">${e(m.text)}</div></div>${m.candidate?`<div class="message assistant" data-key="revision-result-${m.id}"><span class="message-label">方立</span><p>修改候选已准备好，采用后更新当前稿。</p><button class="button quiet" data-action="chat-candidate" data-article-id="${m.articleId}" data-candidate-version="${m.candidate}">查看修改候选与差异</button></div>`:m.error?`<p class="error-text" data-key="revision-error-${m.id}">${e(m.error)}</p>`:''}`).join('');
}
async function reviseFromChat() {
  const s=client.state,a=currentArticle(),id=s.conversation.id,text=client.messageDraft().trim();
  if(!text)throw new Error('请写下对当前稿的修改要求');
  if(localEditor(a)?.dirty)throw new Error('请先保存右侧的人工编辑，再提交修改要求');
  client.assertEditable(a.id);
  const note={id:randomUUID(),text,anchor:(s.conversation.messages||[]).filter(m=>m.role!=='system'&&m.role!=='tool').length,articleId:a.id,number:s.articles.findIndex(row=>row.id===a.id)+1};chatRevisionMessages().push(note);
  showDraft('article');operationBusy=true;render();
  try {
    const result=await client.articleOperation(a.id,'revise',{instruction:text});
    if(!result||client.state.conversation?.id!==id)return;
    note.candidate=result.candidate_version;
    if(client.messageDraft(id).trim()===text)client.setMessageDraft('',id);
    client.persist();
  }catch(error){note.error=error.message;client.setMessageError(error.message,id);throw error;}
  finally{operationBusy=false;render();}
}
function chatHistory() {
  const s=client.state,messages=(s.conversation?.messages||[]).filter(m=>m.role!=='system'&&m.role!=='tool'),result=s.results[OPERATION_KIND.chat];
  const question=pendingChat||s.operations.some(op=>op.kind===OPERATION_KIND.chat&&running(op))||result?.ready?null:result?.questions?.[0],qText=question?.text||question?.question||question?.title,choices=question?.options||[];
  const history=messages.map((m,index)=>`<div data-key="${m.role==='assistant'&&m.content?.operation_id?'reply-'+e(m.content.operation_id):'message-'+index}" class="message ${m.role==='user'?'user':'assistant'}"><span class="message-label">${m.role==='user'?'你':'方立'}</span><div class="rendered-copy message-copy">${m.role==='user'?e(interviewMessageText(m)):markdown(interviewMessageText(m))}</div></div>${revisionMessagesMarkup(index+1)}`).join('');
  return `<section class="conversation-log" id="conversation-log" aria-label="创作对话">${revisionMessagesMarkup(0)}${history}${pendingChat&&pendingChat.id===s.conversation?.id&&pendingChat.text&&interviewMessageText(messages.findLast(m=>m.role==='user')||{})!==pendingChat.text?`<div class="message user" data-key="pending-message"><span class="message-label">你</span><div class="message-copy">${e(pendingChat.text)}</div></div>`:''}${liveReplyMarkup(s,!!pendingChat)}${s.ui.followup&&qText?`<section class="question" aria-label="${e(qText)}">${interviewMessageText(messages.at(-1)||{}).includes(qText)?'':`<h3>${e(qText)}</h3>`}<div class="question-options">${choices.map((opt,i)=>{const label=typeof opt==='string'?opt:opt.text||opt.label;return `<button data-answer="${i}" data-answer-text="${e(label)}">${e(label)}</button>`;}).join('')}</div></section>`:''}</section>`;
}

function operationRows(kinds=null) {
  return client.state.operations.filter(o => running(o) && o.kind!==OPERATION_KIND.writing&&(!kinds||kinds.includes(o.kind))).map(o => `<div class="operation-row" role="status"><span class="working-dot"></span><span>${e(({ interview:'正在理解需求',style_review:'正在通读审阅',style_rewrite:'正在生成候选并做一次只读复核',revision:'正在生成修改候选',fact_repair:'正在生成事实修订候选',zip_regenerate:'正在整篇重写并核查',zip_audit:'正在核查当前稿，可能修正正文' })[o.kind] || '后台正在处理')}</span><button class="text-button" data-stop-operation="${e(o.id)}">请求本地停止</button></div>`).join('');
}
function fitMessageInput(followCaret=false) {
  const input=$('#message-input');if(!input)return;
  const composer=input.closest('.composer'),previousScroll=input.scrollTop;
  const line=parseFloat(getComputedStyle(input).lineHeight),limit=line*6;
  composer.classList.remove('is-multiline');input.style.height=`${line}px`;
  const multiline=!!input.value&&(input.value.includes('\n')||input.scrollHeight>line+1);
  composer.classList.toggle('is-multiline',multiline);
  input.style.height='0px';
  const content=input.value?input.scrollHeight:line;
  input.style.height=`${Math.max(line,Math.min(content,limit))}px`;
  input.style.overflowY=content>limit+1?'auto':'hidden';
  input.scrollTop=followCaret&&document.activeElement===input&&input.selectionEnd===input.value.length?input.scrollHeight:previousScroll;
  input.closest('.chat-compose-area').classList.toggle('has-draft',!!input.value);
  const nextLabel = $('[data-writing-cta] .writing-cta-label');
  if (nextLabel) nextLabel.textContent = writingGap(true)?.label || '开始写作';
}
function writingGap(allowMessage = false) {
  const {options} = client.state;
  const issues = optionIssues(options,client.platforms,client.targets);
  if (issues.some(issue=>issue.startsWith('目标 AI'))) return {kind:'targets',label:'调整目标 AI'};
  if (issues.some(issue=>issue.includes('发布形态'))) return {kind:'formats',label:'调整发布形态'};
  if (issues.some(issue=>issue.startsWith('平台 '))) return {kind:'platforms',label:'调整发布平台'};
  if (!planSummary(options,client.platforms).count) return {kind:'platforms',label:'先选发布平台'};
  const hasKeyword = options.keywords.some(word=>word.trim());
  if (!hasKeyword && !(allowMessage && client.messageDraft().trim())) return {kind:'keywords',label:'先补充关键词'};
  return null;
}
function writingButton(disabled, chat = false) {
  const label = writingGap(chat)?.label || '开始写作';
  return button('start',`<span class="writing-cta-label">${label}</span>`,'right','primary',disabled,'data-writing-cta');
}
function composeView() {
  const s=client.state,c=currentClient(),target=messageTarget(),hasMessages=!!s.conversation?.messages?.length||client.activeJob||!!s.articles.length||isOperationRunning()||operationBusy;
  const canPickTopic=target==='requirements'&&!s.batch?.frozen&&!client.activeJob;
  const topic=canPickTopic?client.writingTopic():'';
  const topicActions=canPickTopic?button('recommend-topic',topic?'更换选题':'推荐选题',null,'context-chip composer-topic',operationBusy||isOperationRunning(),'aria-haspopup="dialog"'):'';
  const topicSummary=topic?`<div class="composer-topic-summary"><span>已选题</span><strong>${e(topic)}</strong>${button('clear-writing-topic','移除',null,'quiet sm',operationBusy||isOperationRunning(),'aria-label="移除已选题"')}</div>`:'';
  const writingAction = target === 'requirements' && !s.batch?.frozen && !client.activeJob &&
    (!s.articles.length || remainingCount(s,client.platforms) > 0) ? writingButton(isOperationRunning()||operationBusy,true) : '';
  return `<section class="chat-workbench ${hasMessages?'is-conversation':'is-first'}">${!hasMessages?'<h1>这次想写什么？</h1>':''}<div class="chat-context">${button('choose-client',c?e(c.name):'选择客户','chevron','context-chip')}${button('sources',`资料 ${s.documentIds.length} 份`,'file','context-chip')}${button('arrangement','本次安排','settings','context-chip',false,'data-paper-arrangement')}</div>${chatHistory()}${s.job||s.operations.some(running)?activityMarkup(s,'chat'):''}<div class="chat-compose-area"><div class="composer"><textarea id="message-input" rows="1" aria-label="创作消息" placeholder="${target==='article'?'说说这篇稿件需要怎样修改':'说说这次想写什么'}">${e(client.messageDraft())}</textarea><div class="composer-toolbar">${iconButton('upload','添加资料','plus')}<span class="spacer"></span><button type="button" class="context-chip composer-platform" data-action="platforms" aria-label="平台安排" title="平台安排">${icon('settings')}</button><button class="send-button" data-action="interview" aria-label="发送消息" ${operationBusy||isOperationRunning()?'disabled':''}>${icon('arrow')}</button></div></div><div class="composer-foot"><div class="composer-followup">${s.articles.some(a=>a.current_version)?`<label class="message-target"><span class="sr-only">本条消息用途</span><select id="message-target" aria-label="本条消息用途"><option value="requirements" ${target==='requirements'?'selected':''} ${s.batch?.frozen?'disabled':''}>调整本次要求</option><option value="article" ${target==='article'?'selected':''} ${client.activeJob?'disabled':''}>修改第 ${s.articles.findIndex(a=>a.id===currentArticle()?.id)+1} 篇</option></select></label>`:''}<label class="check-label" ${target==='article'?'hidden':''}><input type="checkbox" id="followup-enabled" ${s.ui.followup?'checked':''}>追问</label>${topicActions}</div><div class="inline-actions">${s.articles.length?button('articles',`查看 ${s.articles.length} 篇稿件`,null,'quiet'):''}${writingAction}</div></div>${topicSummary}${client.messageError()?`<div class="composer-error" role="alert"><span>${e(client.messageError())}</span><div>${button('arrangement','查看本次安排',null,'quiet sm')}${button('dismiss-message-error','关闭提示',null,'quiet sm')}</div></div>`:''}${!hasMessages?'<div class="prompt-examples chat-suggestions"><button data-prompt="0">介绍产品或服务</button><button data-prompt="1">解答常见问题</button><button data-prompt="2">介绍客户与业务</button></div>':''}</div></section>`;
}
function configBlock(section) {
  const cfg = client.state.config;
  if (!cfg) return `<p class="error-text">${e(client.state.configError || '配置尚未加载')}。${button('reload-config', '加载配置', null, 'quiet sm')}</p>`;
  const prefs = cfg.prefs || cfg.preferences || [], selectedP = client.platforms;
  const models = client.targets;
  const risks = cfg.risks || [];
  const html=`<p class="helper">原 ZIP 的有效抓取偏好与风险配置。调整用于后续写作；后台按启动快照处理在途任务。</p><details id="preference-matrix"><summary>目标 AI × 平台抓取偏好</summary><div class="matrix-scroll" tabindex="0" aria-label="横向滚动查看各平台抓取偏好"><table class="matrix"><thead><tr><th scope="col">目标 AI</th>${selectedP.map(p => `<th scope="col">${e(p.name)}</th>`).join('')}</tr></thead><tbody>${models.map(m => `<tr><th scope="row">${e(m.name || m)}</th>${selectedP.map(p => { const pref = prefs.find(x => String(x.model_id) === String(m.id) && String(x.platform_id) === String(p.id)); return `<td><select aria-label="${e(m.name)} 对 ${e(p.name)} 的抓取偏好" data-pref-model="${e(m.id)}" data-pref-platform="${e(p.id)}">${[['high','高优先抓取'],['mid','中等抓取'],['low','低抓取']].map(([v,t]) => `<option value="${v}" ${(pref?.level || 'mid') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td>`; }).join('')}</tr>`).join('')}</tbody></table>${!selectedP.length ? '<p class="helper">选择平台后显示对应列。</p>' : ''}</div></details>
    <details id="risk-matrix"><summary>风险清单 · ${risks.length} 条</summary>${risks.filter(r => r.platform_id == null || selectedP.some(p => String(p.id) === String(r.platform_id))).map(r => `<div class="risk-row"><span class="risk-level">${e(r.level)}</span><div class="risk-main"><strong>${e(r.item)}</strong><p>${e(r.category)} · ${e(client.platforms.find(p => p.id === r.platform_id)?.name || '全平台通用')}</p><p>${e(r.tip)}</p></div><div class="risk-actions"><button data-edit-risk="${e(r.id)}">编辑</button><button data-delete-risk="${e(r.id)}">删除</button></div></div>`).join('')}${button('add-risk', '添加风险点', 'plus', 'quiet sm')}</details>
    ${button('config-admin', '管理平台、形态与目标 AI', 'settings', 'quiet sm')}`;
  const template=document.createElement('template');template.innerHTML=html;
  const content=template.content.querySelector(section==='risks'?'#risk-matrix':'#preference-matrix');content.open=true;return content.outerHTML;
}
function stepper() { return `<ol class="stepper" aria-label="分步创作进度">${['资料与关键词','平台安排','生成','编辑与导出'].map((title, i) => `<li class="${step === i + 1 ? 'active' : ''}"><button data-step="${i+1}" ${step === i + 1 ? 'aria-current="step"' : ''}><b>${i+1}</b><span>${title}</span></button></li>`).join('')}</ol>`; }
function hasTaskPlatform(options, id) {
  return options.selections.some(s => String(s.platform_id) === String(id)) || Object.hasOwn(options.format_overrides,id);
}
function taskPlatforms() {
  const options = client.state.options;
  const platforms = client.platforms.filter(p => enabled(p) && hasTaskPlatform(options,p.id));
  if (!platforms.length) return '<p class="empty">选择发布平台后，再安排篇数和发布形态。</p>';
  return `<div class="task-platforms">${platforms.map(p => {
    const counts = selectionCounts(options,p.id), formats = options.format_overrides[p.id] || p.formats;
    const fields = ['official','personal'].map(type => `<label class="platform-amount">${accountName(type)}<input id="task-count-${p.id}-${type}" type="number" min="0" max="20" step="1" data-task-count="${p.id}" data-account="${type}" value="${counts[type]}" aria-label="${e(p.name)}${accountName(type)}篇数"></label>`).join('');
    const picks = p.formats.map(fmt => `<label><input type="checkbox" data-task-format="${p.id}" value="${e(fmt)}" ${formats.includes(fmt)?'checked':''}>${e(fmt === '短视频' ? '短视频文案' : fmt)}</label>`).join('');
    const reset = formats.some(fmt => !p.formats.includes(fmt)) ? button('reset-task-formats','更新发布形态',null,'quiet sm',false,`data-platform-id="${p.id}"`) : '';
    return `<section class="task-platform-row" aria-label="${e(p.name)}"><h2>${e(p.name)}</h2><div class="task-platform-fields">${fields}<div class="format-picks">${picks}</div>${reset}</div></section>`;
  }).join('')}</div>`;
}
function zipView() {
  const s=client.state;
  if (step === 3 || step === 4) {
    const steps = `<div class="reading-steps"><div id="reading-steps-full">${stepper()}</div><button type="button" class="button quiet sm reading-expand" data-expand-reading aria-controls="reading-steps-full" aria-expanded="false">展开步骤</button></div>`;
    return steps + (step === 4 ? articleView() : liveView(true));
  }
  if(step===2)return `${stepper()}<section class="step-surface"><div class="spread"><div><h1>平台安排</h1><p>${e(planSummary(s.options,client.platforms).text)}</p></div>${button('platforms','选择平台','plus','quiet')}</div>${taskPlatforms()}<div class="step-actions">${button('step-1','上一步','back','quiet')}${writingButton(client.activeJob||isOperationRunning()||operationBusy)}</div></section>`;
  return `${stepper()}<section class="step-surface"><header class="preparation-heading"><h1>创作准备</h1>${button('step-2','下一步：平台安排','right','primary')}</header>${clientLine()}<div class="preparation-grid">${sourceBlock()}${keywordEditor({showAliases:false})}</div><label class="field task-note"><span>本次方向与补充要求</span><textarea class="input" id="zip-note" data-option="note" rows="3" placeholder="说明本次想表达的重点">${e(s.options.note)}</textarea></label>${expandedOptions()}</section>`;
}
function liveView(inStep = false) {
  return liveMarkup(client.state,client.platforms,button,{inStep})+(inStep?`<div class="step-actions">${button('step-2','返回配置','back','quiet')}<span></span></div>`:'');
}
function draftPanelState() {
  const id=client.state.conversation?.id||'_new';client.state.ui.draftPanels??={};
  return client.state.ui.draftPanels[id]??= {open:!!(client.activeJob||client.state.articles.length),view:client.activeJob?'live':'article'};
}
function showDraft(view='article') { const draft=draftPanelState();draft.open=true;draft.view=view;client.persist(); }
function chatWorkspace() {
  const s=client.state,draft=draftPanelState(),available=!!(s.job||s.articles.length);
  const body=draft.view==='live'?liveView():s.articles.length?articleView():liveView();
  return `<div class="chat-split ${draft.open&&available?'has-draft':''}" id="chat-split"><div class="chat-pane">${composeView()}${available&&!draft.open?`<button class="reopen-draft" data-action="open-draft">查看稿件${client.activeJob?' · 正在处理':''}</button>`:''}</div><div id="draft-resizer" role="separator" aria-label="调整对话与稿件宽度" aria-orientation="vertical" aria-valuemin="20" aria-valuemax="80" aria-valuenow="40" tabindex="0" ${draft.open&&available?'':'hidden'}></div><section class="draft-pane" aria-label="稿件工作区" ${draft.open&&available?'':'hidden'}><header class="draft-head"><strong>本次稿件</strong><div>${client.activeJob?button('live','查看生成进度',null,'quiet sm'):''}${iconButton('close-draft','关闭稿件区','close')}</div></header><div class="draft-content">${body}</div></section></div>`;
}

function articleView() {
  const s = client.state, a = currentArticle();
  if (!a) return `<section class="empty large"><h2>还没有稿件。</h2><p>从资料与关键词开始，后台完成后在这里编辑和导出。</p>${button('compose','开始创作','plus','primary')}</section>`;
  selectedId = a.id; const editor = localEditor(a);
  const saving = savingEditors.has(editorKey(a)), editLocked = a.locked || saving;
  const display = editor ? {...a,title:editor.title,body_md:editedBody(a,editor)} : a;
  const locked = a.locked || client.activeJob || isOperationRunning() || operationBusy || editor?.dirty;
  return `<section class="article-workspace"><div id="article-scroll" class="article-scroll" tabindex="0" aria-label="稿件正文"><div class="article-list-bar"><div class="article-tabs" role="tablist" aria-label="本次稿件">${s.articles.map((art,i) => `<button class="article-tab ${art.id === a.id ? 'active' : ''}" id="article-tab-${art.id}" role="tab" tabindex="${art.id === a.id ? 0 : -1}" aria-controls="paper" aria-selected="${art.id === a.id}" data-select-article="${art.id}"><span class="article-dot ${art.locked ? 'locked' : ''}"></span>${e(art.platform_name || art.platform || '稿件')} · ${i+1}</button>`).join('')}${client.activeJob ? `<button class="article-tab" data-action="live"><span class="working-dot"></span>写作状态</button>` : ''}</div>${moreMenu('article-menu','稿件列表更多操作',button('delete-article','删除当前稿件',null,'quiet sm danger',locked))}</div>
    <div class="editor-toolbar"><span class="muted">${e(a.version_label || `工作版本 ${a.current_version}`)}${a.locked ? ' · 正在处理，只读' : ''}</span><div class="inline-actions">${button('edit-article',editor && !editor.reading ? '预览草稿' : editor?.dirty ? '继续编辑' : '编辑正文','edit','quiet sm',editLocked)}${button('review','审阅与版本','review','quiet sm',false,`aria-expanded="${['review','versions','editorial'].includes(panel)}"`)}${button('export','导出','download','outline sm')}</div></div>
    ${operationRows([OPERATION_KIND.regenerate,OPERATION_KIND.audit,OPERATION_KIND.revise])}<article class="paper" id="paper" role="tabpanel" aria-labelledby="article-tab-${a.id}"><div class="paper-meta"><span>${e(a.platform_name || a.platform || '')} · ${accountName(a.account_type)}${a.fmt ? ` · ${e(a.fmt)}` : ''}</span><span>${editor?.dirty ? '草稿预览' : a.review ? (a.review.status==='unverified'?'本版本尚未模型核查':a.origin?.startsWith('zip')?'原生模型核查记录可查看':'模型复核记录可查看') : '此版本无核查记录'}</span></div>
    ${editor && !editor.reading ? `<label class="field"><span class="small muted">标题</span><input type="text" id="article-title" class="title-input" value="${e(editor.title)}" ${editLocked ? 'disabled' : ''}></label><label class="field"><span class="small muted">正文 · Markdown</span><textarea id="article-body" class="body-input" ${editLocked ? 'readonly' : ''}>${e(editor.body)}</textarea></label><details id="article-metadata"><summary>标签与声明</summary><div class="details-content"><label class="field"><span>标签 · 空格或逗号分隔</span><input type="text" id="article-tags" value="${e(editor.tags??(a.tags||[]).join(' '))}" ${editLocked?'disabled':''}></label><label class="field"><span>声明 · 每行一条</span><textarea class="input" id="article-decl" ${editLocked?'readonly':''}>${e(editor.decl??(a.decl||[]).join('\n'))}</textarea><small>清空后保存即可移除此版本的标签或声明。</small></label></div></details>` : `<h1>${e(display.title || '未命名稿件')}</h1><div>${markdown(readingBody(display))}</div>`}
    <footer class="paper-foot"><span>${editor?.dirty ? '未保存草稿 · 导出使用采用稿' : '当前采用版 · 用于默认导出'}</span><span id="article-word-count">${articleWordCount(articleBody(display))}</span></footer></article>
    ${editor ? `<div class="editor-save">${editor.base !== a.current_version ? '<p>后台版本已改变，请先保留编辑并核对版本。</p>' : ''}${button('save-article',saving?'正在保存…':'保存新版本','check','primary',editLocked || !editor.dirty)}${button('end-edit','结束编辑',null,'quiet',saving)}</div>` : ''}
    </div>${mode==='zip'?`<div class="revision-box"><div class="reply-row"><textarea class="input" id="revise-instruction" aria-label="对当前稿的修改要求" placeholder="让 AI 修改本篇，例如：开头直接说明用途。">${e(revisionInstruction(a))}</textarea><button class="send-button" data-action="revise" aria-label="生成修改候选" title="生成修改候选" ${a.locked||!a.current_version||isOperationRunning()||operationBusy||editor?.dirty?'disabled':''}>${icon('arrow')}</button></div></div>`:''}</section>`;
}
function sourcesPanel() {
  const c = currentClient();
  const profile = c ? `<details class="inspector-disclosure" id="inspector-client-profile">
    <summary>客户档案 <span>${e(c.name)}</span></summary>
    <dl class="plain-dl">${PROFILE_FIELDS.filter(([key]) => key !== 'name' && c.profile?.[key]).map(([key,label]) => `<div><dt>${label}</dt><dd>${e(c.profile[key])}</dd></div>`).join('')}</dl>
    ${button('profile','编辑档案',null,'quiet sm')}
  </details>` : button('choose-client','选择客户',null,'outline sm');
  return `<div class="inspector-sections">
    <section><h3>本次资料</h3>${docRows(selectedDocs(), { compact: true })}
      <details class="inspector-disclosure" id="inspector-add-materials">
        <summary>添加资料</summary>
        <div class="inline-actions">${button('upload','上传文件或图片','plus','quiet sm',importing)}${button('paste','粘贴',null,'quiet sm')}${button('library','资料库',null,'quiet sm')}</div>
      </details>
      ${pendingImageRows()}
      ${importing ? '<p class="helper" role="status">正在保存原件并解析…</p>' : ''}
    </section>
    ${profile}
    ${materialsVideoButton()}
  </div>`;
}
function arrangementPanel() {
  const { options, model } = client.state;
  const summary = planSummary(options, client.platforms);
  const chat = mode === 'chat';
  return `<div class="inspector-sections">
    <section>
      ${chat ? `<label class="field"><span class="inspector-section-title">本次要求</span><textarea class="input" id="context-note" data-option="note" rows="3" placeholder="尚未填写">${e(options.note)}</textarea></label>` : `
        <div class="spread"><h3>本次要求</h3>${button('step-1','编辑要求与关键词',null,'quiet sm')}</div>
        <p class="inspector-requirement">${e(options.note || '尚未填写')}</p>`}
    </section>
    ${chat ? keywordEditor() : `<section><h3>目标搜索关键词</h3><p>${e(options.keywords.join('、') || '尚未填写')}</p></section>`}
    <section>
      <div class="spread"><h3>平台与篇数</h3>${button(chat?'platforms':'step-2','调整',null,'quiet sm',!!client.state.batch?.frozen,'aria-label="调整平台与篇数"')}</div>
      <p>${e(summary.count ? summary.text : '尚未安排平台')}${summary.count ? ` · 共 ${summary.count} 篇` : ''}</p>
    </section>
    <details class="inspector-disclosure" id="inspector-advanced">
      <summary>高级设置</summary>
      <div class="details-content inspector-sections">
        <section><h4>目标 AI</h4>${chat ? targetsBlock('task-target') : `<p>${e(options.models.join('、') || '尚未选择')}</p>`}</section>
        <section><h4>写作模型</h4><p>${e(model || '尚未配置')}</p></section>
        ${chat ? advancedFields() : ''}
      </div>
    </details>
  </div>`;
}
function reviewScope(r) { return {review_id:r?.operation_id||r?.review_id,base_version:r?.base_version}; }
function reviewKey(a,r) { return client.articleDraftKey(a?.id,reviewScope(r)); }
function clearReviewValidation() { reviewError='';const message=$('#review-validation');if(message)message.textContent=''; }
function storeReviewDraft() {
  if(!selectedReviewId)return;
  const a=currentArticle(),r=reviewFor(a);client.setArticleDraft(a.id,{selected:[...selectedSuggestions],conservative:[...conservativeSuggestions],mode:rewriteMode,material:$('#rewrite-material')?.value??client.articleDraft(a.id,reviewScope(r)).material??''},reviewScope(r));
}
function editKeywordLinks() {
  dialog('本次串联关键词',keywordLinksField(keywordLinksText(client.state.options.keyword_links)),async data=>{
    client.setOptions({keyword_links:parseKeywordLinks(data.get('keyword_links'))});
    await client.saveDraft();
  });
}
function revisionInstruction(a=currentArticle()) { return client.articleDraft(a.id).instruction||''; }
function articleReviewControls(a) {
  return `<div class="inline-actions article-review-controls">${button('show-review','文风审阅',null,'quiet sm',false,panel==='review'?'aria-current="true"':'')}${button('versions','稿件版本',null,'quiet sm',a.locked,panel==='versions'?'aria-current="true"':'')}${button('article-editorial','本版详情',null,'quiet sm',!a.current_version,panel==='editorial'?'aria-current="true"':'')}</div>`;
}
function advancedArticleControls(a, blocked) {
  const editor = localEditor(a);
  const nativeBlocked = blocked || client.activeJob;
  return `<details class="inspector-disclosure" id="article-advanced"><summary>高级操作</summary><div class="inline-actions">${fontSizeControl(editor && !editor.reading ? 'editor' : 'reading', client.state.ui)}${button('native-regenerate','重写、核查并采用',null,'quiet sm',nativeBlocked)}${button('native-audit','重新核查并更新采用稿',null,'quiet sm',nativeBlocked)}${button('accept-expression','保存为认可表达',null,'quiet sm',a.locked||!a.current_version||editor?.dirty)}</div></details>`;
}
function reviewPanel() {
  const a=currentArticle();if(!a)return '<p class="empty">成稿完成后，可在这里手动审阅。</p>';
  const r=reviewFor(a),stale=r&&r.base_version!==a.current_version,key=reviewKey(a,r);
  if(r&&selectedReviewId!==key){const saved=client.articleDraft(a.id,reviewScope(r)),draft=saved.selected?saved:reviewDefaults(r);selectedSuggestions=new Set(draft.selected);conservativeSuggestions=new Set(draft.conservative||[]);rewriteMode=draft.mode;selectedReviewId=key;reviewError='';}
  const material=client.articleDraft(a.id,reviewScope(r)).material||'';
  const itemMarkup=(item,index,observation=false)=>{
    const id=String(item.id??index),inputId=`suggestion-${id}`;
    return `<section class="suggestion" data-review-item="${e(id)}"><div class="suggestion-select"><input id="${e(inputId)}" type="checkbox" data-suggestion="${e(id)}" ${selectedSuggestions.has(id)?'checked':''} ${stale?'disabled':''}><label for="${e(inputId)}"><strong>${e(id)} · ${e(item.signal)}</strong></label></div><div class="suggestion-body"><small>${e(observation?item.position:item.scope||'')}${item.requires_material?' · 需要新增真实素材':''}</small><blockquote>${e(item.quote||'')}</blockquote><p>${e(item.problem||item.reason||'')}</p><p>${e(item.proposal||'')}</p>${item.requires_material?`<fieldset class="material-choice"><legend>这条如何处理</legend><label><input type="radio" name="material-${e(id)}" data-material-choice="${e(id)}" value="material" ${conservativeSuggestions.has(id)?'':'checked'} ${stale?'disabled':''}>补充素材</label><label><input type="radio" name="material-${e(id)}" data-material-choice="${e(id)}" value="conservative" ${conservativeSuggestions.has(id)?'checked':''} ${stale?'disabled':''}>仅删减或收紧</label><p class="helper">保守处理只删除或收紧现有表述，不补充经历、案例或数字。</p></fieldset>`:''}</div></section>`;
  };
  const blocked=a.locked||!a.current_version||isOperationRunning()||operationBusy||localEditor(a)?.dirty;
  return `<div class="inline-actions">${button('run-review',r?'重新通读当前版':'开始文风审阅','review','primary',blocked)}</div>${advancedArticleControls(a,blocked)}${operationRows([OPERATION_KIND.review,OPERATION_KIND.rewrite])}${r?`<p class="helper">${e(r.reviewer||'文风审阅')} · 基于版本 ${e(r.base_version)}${stale?'；当前版本已变化，请重新审阅。':''}</p><p>${e(r.assessment)}</p><h3>修改建议 · ${(r.suggestions||[]).length}</h3>${(r.suggestions||[]).map((item,i)=>itemMarkup(item,i)).join('')}<div class="observations"><h3>观察项 · 可手动选择</h3>${(r.observations||[]).map((item,i)=>itemMarkup(item,i,true)).join('')||'<p>暂无观察项。</p>'}</div><hr><label class="field"><span>修改范围</span><select id="rewrite-mode">${[['full','允许全文重组'],['standard','标准调整'],['light','轻量修改']].map(([v,t])=>`<option value="${v}" ${rewriteMode===v?'selected':''}>${t}</option>`).join('')}</select></label><label class="field" style="margin-top:16px"><span>真实补充素材</span><textarea class="input" id="rewrite-material" placeholder="填写可用于正文的真实经历、数据或原文">${e(material)}</textarea><small>用于支持选择了“补充素材”的建议。</small></label><p id="review-validation" class="error-text" role="alert">${e(reviewError)}</p>${button('rewrite','生成候选并做模型复核',null,'primary',blocked||stale)}${r.candidate?button('open-candidate','查看已有候选与差异',null,'outline'):''}`:'<p class="helper">审阅按需开始，保留当前正文。</p>'}`;
}
function versionsPanel() {
  const a = currentArticle(), data = a && versionsData[a.id];
  return `${a ? `<p>原生初稿、ZIP 成稿、人工版本与候选均保留。当前导出采用版本 ${a.current_version}。</p>${button('load-versions','刷新版本',null,'quiet sm')}${data ? (data.versions || []).map(v => `<section class="version-row"><h3>${e(v.label || v.origin || '工作版本')} ${v.id === a.current_version ? '<span class="version-current">当前采用</span>' : ''}</h3><small>版本 ${v.id} · ${e(v.created_at || '')}</small><div class="inline-actions">${button('version-preview','查看全文与差异',null,'quiet sm',false,`data-version="${v.id}"`)}${button('version-editorial','查看核查',null,'quiet sm',false,`data-version="${v.id}"`)}${v.id !== a.current_version ? button('version-select',['style','revision'].includes(v.origin) ? '采用候选' : '恢复此版',null,'outline sm',a.locked,`data-version="${v.id}"`) : ''}</div></section>`).join('') : '<p class="helper">正在加载版本…</p>'}` : '<p class="empty">还没有稿件。</p>'}`;
}
function settingLimits() { return client.state.bootstrap?.setting_limits || {temperature:{min:0,max:1.5},max_tokens:{min:800,max:8000}}; }
function workBuddyModelOptions(selected) {
  const models = client.state.bootstrap?.provider_models || [];
  const names = models.map(model => typeof model === 'string' ? model : model.id || model.name);
  const options = names.includes(selected) ? names : [selected, ...names];
  return options.map(name => `<option ${name === selected ? 'selected' : ''} value="${e(name)}">${e(name)}${names.length && !names.includes(name) ? '（当前目录未确认）' : ''}</option>`).join('');
}
function settingsPanel() {
  const bootstrap = client.state.bootstrap || {}, settings = bootstrap.settings || {}, limits = settingLimits();
  const transport = settings.transport || 'workbuddy', useApi = transport !== 'workbuddy';
  const sources = (bootstrap.local_api_sources || []).filter(source => source.configured || source.id === transport);
  const selected = sources.find(source => source.id === transport) || sources[0];
  return `<h3>写作模型</h3>
    <fieldset class="writing-source"><legend>模型来源</legend><div class="inline-actions">
      <label class="check-label"><input type="radio" name="writing-source" value="workbuddy" ${useApi ? '' : 'checked'}>WorkBuddy</label>
      <label class="check-label"><input type="radio" name="writing-source" value="api" ${useApi ? 'checked' : ''}>本地 API</label>
    </div></fieldset>
    <div id="setting-workbuddy" ${useApi ? 'hidden' : ''}>
      <label class="field"><span>WorkBuddy 模型</span><select id="setting-model">${workBuddyModelOptions(useApi ? DEFAULT_MODEL : settings.model || DEFAULT_MODEL)}</select></label>
      ${button('provider-models','查询可用模型',null,'quiet sm')}
    </div>
    <div id="setting-api" ${useApi ? '' : 'hidden'}>
      <label class="field"><span>API 服务</span><select id="setting-api-provider" aria-describedby="setting-api-status" ${sources.length ? '' : 'disabled'}>${sources.length ? sources.map(source => `<option value="${e(source.id)}" ${source === selected ? 'selected' : ''}>${e(source.name)}${source.configured ? '' : '（配置缺失）'}</option>`).join('') : '<option value="">未发现可用配置</option>'}</select></label>
      <label class="field"><span>API 模型 ID</span><input type="text" id="setting-api-model" maxlength="120" autocomplete="off" spellcheck="false" value="${e(useApi ? settings.model || '' : selected?.default_model || '')}" ${selected?.configured ? '' : 'disabled'}></label>
      <p class="helper" id="setting-api-status" role="status">${apiSourceStatus(selected)}</p>
    </div>
    <div class="form-grid" style="margin-top:20px"><label class="field"><span>Temperature</span><input type="number" id="setting-temperature" min="${e(limits.temperature.min)}" max="${e(limits.temperature.max)}" step="0.1" value="${e(settings.temperature ?? 0.7)}"></label><label class="field"><span>最大输出 Token</span><input type="number" id="setting-max-tokens" min="${e(limits.max_tokens.min)}" max="${e(limits.max_tokens.max)}" step="1" value="${e(settings.max_tokens || 8000)}"></label><label class="check-label"><input type="checkbox" id="setting-title-prefix" ${settings.title_prefix ? 'checked' : ''}>标题附平台与账号前缀</label></div><label class="field" style="margin-top:20px"><span>默认品牌</span><input type="text" id="setting-brand" value="${e(settings.brand||'')}" placeholder="新建客户时预填，可在档案中清空"></label><label class="check-label" style="margin-top:14px"><input type="checkbox" id="setting-disable-thinking" ${settings.disable_thinking?'checked':''}>关闭模型深度思考</label>`;
}
function apiSourceStatus(source) {
  return source?.configured ? '已发现本机配置。请使用该服务支持的模型 ID。' : '请配置模型服务的环境变量，然后重启工作台。';
}
function syncWritingSource(resetApiModel = false) {
  const content = $('#settings-content');
  const choice = $('[name="writing-source"]:checked', content);
  if (!choice) return;
  $('#setting-workbuddy', content).hidden = choice.value !== 'workbuddy';
  $('#setting-api', content).hidden = choice.value !== 'api';
  const ident = $('#setting-api-provider', content).value;
  const source = client.state.bootstrap?.local_api_sources?.find(item => item.id === ident);
  const input = $('#setting-api-model', content);
  if (resetApiModel) {
    const saved = client.state.bootstrap.settings;
    input.value = saved.transport === ident ? saved.model : source?.default_model || '';
  }
  input.disabled = !source?.configured;
  $('#setting-api-status', content).textContent = apiSourceStatus(source);
}
const settingsSections=[['writing','写作模型'],['platforms','发布平台'],['targets','目标 AI'],['preferences','抓取偏好'],['risks','风险清单'],['appearance','外观']];
function captureSettings() {
  if(!settingsSession?.current)return;
  settingsSession.current.values=$$('input,textarea,select',$('#settings-content')).map(el=>({value:el.value,checked:el.checked}));
  settingsSession.views.set(settingsSession.current.section,settingsSession.current);
}
function settingsDisplay(title,html,submit,options={}) {
  captureSettings();const session=settingsSession,section=session.section;
  const nav=settingsSections.map(([key,label])=>`<button type="button" data-settings-section="${key}" ${section===key?'aria-current="page"':''}>${label}</button>`).join('');
  const current=session.current={title,html,submit,options,section,main:!!options.settingsMain};
  const wrapped=submit?async data=>{await submit(data);if(settingsSession!==session)return false;openSettings(section,true);return false;}:null;
  baseDialog('工作台设置',`<div class="settings-layout"><nav aria-label="设置分类">${nav}</nav><section id="settings-content"><h3 class="settings-title">${e(title)}</h3>${html}</section></div>`,wrapped,{...options,wide:true});
  modal.classList.add('settings-dialog');$('.dialog-actions [data-close]',modal).textContent=current.main?'关闭':'取消编辑';
}
function catalogueMarkup(kind) {
  const platforms=kind==='platforms',rows=platforms?client.platforms:client.targets;
  return rows.map(row=>`<div class="admin-row spread"><div><strong>${e(row.name)}</strong><p class="helper">${platforms?e((row.formats||[]).join(' / ')):e(row.note||'')}${enabled(row)?' · 已启用':' · 已停用'}</p></div><div class="inline-actions"><button type="button" class="button quiet sm" ${platforms?'data-edit-platform':'data-edit-target'}="${e(row.id)}">编辑</button><button type="button" class="button quiet sm" ${platforms?'data-delete-platform':'data-delete-target'}="${e(row.id)}">删除</button></div></div>`).join('')+button(platforms?'add-platform':'add-target',platforms?'添加平台':'添加目标 AI','plus','outline');
}
function openSettings(section='writing',reset=false) {
  if(!settingsSession)settingsSession={section,views:new Map()};
  captureSettings();settingsSession.section=section;
  if (section === 'appearance') {
    const checked = paperMotionEnabled() ? 'checked' : '';
    const palette = currentWorkbenchPalette();
    const paletteOptions = WORKBENCH_PALETTES.map(({value,label}) =>
      `<option value="${e(value)}" ${value===palette?'selected':''}>${e(label)}</option>`).join('');
    settingsDisplay('外观', `<label class="field"><span>界面配色</span><select data-workbench-palette-select aria-describedby="workbench-palette-description">${paletteOptions}</select><small id="workbench-palette-description">用于对话与分步工作台，选择后立即生效。</small></label><label class="check-label"><input type="checkbox" data-classic-view-toggle ${classicEnabled()?'checked':''}>使用 ZIP 原版创作界面</label><p class="helper">在此浏览器使用原版的创作准备、写稿和稿件页面。</p><label class="check-label"><input type="checkbox" data-paper-motion-toggle aria-describedby="paper-motion-description" ${checked}>纸页动效</label><p class="helper" id="paper-motion-description">用于本次安排、新稿提示和使用指南里的写作演示。</p>`, null, {settingsMain:true});
    return;
  }
  if(reset)settingsSession.views.delete(section);
  const saved=settingsSession.views.get(section);
  if(saved){
    const writing = section === 'writing' && saved.main;
    settingsDisplay(saved.title,writing ? settingsPanel() : saved.html,saved.submit,saved.options);
    $$('input,textarea,select',$('#settings-content')).forEach((el,i)=>{
      const previous = saved.values?.[i];
      if(!previous)return;
      if(el.id==='setting-model')el.innerHTML=workBuddyModelOptions(previous.value);
      el.value=previous.value;el.checked=previous.checked;
    });
    if(writing)syncWritingSource();
    return;
  }
  const title=settingsSections.find(([key])=>key===section)?.[1]||'写作模型';
  const html=section==='writing'?settingsPanel():['platforms','targets'].includes(section)?catalogueMarkup(section):configBlock(section);
  settingsDisplay(title,html,section==='writing'?saveSettings:null,{settingsMain:true,label:'保存设置'});
}
function inspector() {
  if (!panel) return '';
  const titles = { sources: '资料', arrangement: '本次安排', review: '审阅与版本', versions: '审阅与版本', editorial: '审阅与版本', settings: '工作台设置' };
  const a = currentArticle();
  const controls = a && ['review','versions','editorial'].includes(panel) ? articleReviewControls(a) : '';
  return `<aside class="inspector" data-inspector-view="${panel}" aria-label="${titles[panel]}"><div id="inspector-resizer" class="inspector-resizer" role="separator" aria-label="调整辅助面板宽度" aria-orientation="vertical" tabindex="0"></div><header class="inspector-head"><h2>${titles[panel]}</h2>${iconButton('close-panel','关闭辅助面板','close')}</header><div class="inspector-body" id="inspector-body">${controls}${({ sources:sourcesPanel, arrangement:arrangementPanel, review:reviewPanel, versions:versionsPanel, editorial:editorialPanel, settings:settingsPanel })[panel]()}</div></aside>`;
}

function freezeTaskInputs() {
  if(!client.state.batch?.frozen)return;
  const writes=new Set(['upload','paste','library','platforms','reset-task-formats','detect-aliases','edit-keyword-links','add-keyword','start','write-one','confirm-plan','new-requirement','interview','send-reply']);
  for(const el of $$('[data-action]', $('#root')))if(writes.has(el.dataset.action)&&!(el.dataset.action==='interview'&&messageTarget()==='article'))el.disabled=true;
  for(const el of $$('[data-option],[data-keyword-choice],[data-doc-choice],[data-task-count],[data-task-format],[data-target],[data-remove-target],[data-prompt],[data-answer],#message-input,#keyword-entry,#followup-enabled,#option-aliases', $('#root'))){
    if(el.id==='message-input'&&messageTarget()==='article')continue;
    if(el.matches('textarea,input[type=text],input[type=number]'))el.readOnly=true;else el.disabled=true;
  }
}

function render() {
  if (composing) { renderPending = true; return; }
  const entry = standardEntry();
  const workspace = $('#workspace');
  if (!entry && workspace && workspace.dataset.workspaceView !== 'new' && lastTask &&
      client.state.conversation?.id && lastTask !== client.state.conversation.id && !taskPresentation.applying) {
    taskPresentation.present(render);
    return;
  }
  const previousTask=lastTask,previousArticle=renderedArticleId;
  const following=captureFollowing($('#root')),oldComposer=$('.chat-compose-area')?.getBoundingClientRect();
  const active = document.activeElement, focusId = active?.id, focusAction=active?.dataset.action;
  const rawValue=active?.matches('textarea,input[type=text],input[type=number],input[type=search]')?active.value:null;
  const selection = active?.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
  const scrollIds = ['workspace','recent','article-scroll'];
  if ($('.inspector')?.dataset.inspectorView === panel && previousTask === client.state.conversation?.id) scrollIds.push('inspector-body');
  const scrolls = scrollIds.map(id => [id,$('#'+id)?.scrollTop || 0]);
  const details = new Map($$('details[id]', $('#root')).map(d => [d.id,d.open]));
  const s = client.state;
  if(wasWriting&&!client.activeJob&&s.job?.status==='done'&&s.articles.length&&draftPanelState().view==='live'){selectedId=s.articles.filter(a=>a.current_version!=null&&!a.locked).at(-1)?.id??selectedId;}
  wasWriting=client.activeJob;
  if (s.conversation?.id !== lastTask) {
    if (!entry && !customerArea && !quickArea && !creatingTask) syncTaskMode();
    lastTask = s.conversation?.id; modeViews.clear(); modeSwitcher.reset(); stepGeneration++; reviews = {}; versionsData = {}; selectedId = null;selectedReviewId=null;
    if (!previousTask && lastTask === initialRoute.get('conversation')) {
      selectedId = s.articles.find(a => String(a.id) === initialRoute.get('article'))?.id ?? null;
      if (selectedId && mode === 'chat') showDraft('article');
    }
    surface = client.activeJob ? 'live' : s.articles.length ? 'articles' : 'compose';
    step = client.activeJob ? 3 : s.articles.length ? 4 : 1;
  }
  if (!s.bootstrap) {
    $('#root').innerHTML = `<div class="boot-state"><h1>方立</h1><p>${e(s.error || '正在打开工作台…')}</p>${s.loaded ? '<p>请确认本机工作台服务已启动，然后刷新页面。</p>' : ''}</div>`; return;
  }
  document.documentElement.style.setProperty('--sidebar', `${s.ui.sidebarWidth}px`);
  const view = entry || (quickArea ? 'quick' : customerArea ? 'customers' : mode === 'zip' ? 'zip-'+step : 'chat');
  const content = entry === 'start' ? startPage() : entry === 'new' ? newContentPage() :
    quickArea ? '<div class="quick-host"></div>' : customerArea ? customers.view() : mode === 'zip' ? zipView() : chatWorkspace();
  const status = entry ? (s.error ? `<div class="notice error" role="alert">${e(s.error)}</div>` : '') : customerArea||quickArea ? '' : notices(s);
  const html = `<div class="app ${s.ui.collapsed ? 'collapsed' : ''}">${sidebar(s)}<button class="mobile-scrim" data-action="collapse" aria-label="关闭任务导航"></button><main class="main">${topbar(s)}<div class="workspace-notices">${status}</div><div class="content-wrap"><div class="workspace" id="workspace" tabindex="-1" data-workspace-view="${view}" data-task-id="${entry?'':e(s.conversation?.id||'')}">${content}</div>${!entry&&!customerArea&&!quickArea||panel==='settings'?inspector():''}</div></main></div>`;
  const template=document.createElement('template');template.innerHTML=html;
  const desiredParts=new Map(['.sidebar','.topbar','.workspace-notices','.workspace','.inspector'].map(selector=>[selector,$(selector,template.content)?.outerHTML]));
  const fresh=template.content,oldApp=$('#root>.app');
  const reviewKey=panel==='review'?JSON.stringify([s.conversation?.id,currentArticle()?.id,currentArticle()?.current_version,currentArticle()?.locked,Boolean(currentArticle() && localEditor(currentArticle())?.dirty),client.activeJob,operationBusy,reviewError,reviewFor(currentArticle()||{}),s.operations.map(o=>[o.id,o.status])]):'';
  if(!oldApp){$('#root').replaceChildren(fresh);renderParts.clear();}
  else {
    oldApp.className=$('.app',fresh).className;
    for(const selector of ['.sidebar','.topbar','.workspace-notices','.workspace']){
      const next=$(selector,fresh),old=$(selector,$('#root')),key=next?.outerHTML;
      if(old&&next&&renderParts.get(selector)!==key){if(selector==='.workspace'){old.dataset.workspaceView=next.dataset.workspaceView;old.dataset.taskId=next.dataset.taskId;reconcile(old,next);}else old.replaceWith(next);}
    }
    const next=$('.inspector',fresh),old=$('.inspector',$('#root'));
    if(next&&!(old&&panel==='review'&&reviewKey===lastInspectorKey)){
      if(!old||renderParts.get('.inspector')!==next.outerHTML){if(old)old.replaceWith(next);else $('.content-wrap').append(next);}
    } else if(!next&&old)old.remove();
  }
  const quickHost = $('.quick-host');
  if (quickHost && quick.root.parentElement !== quickHost) quickHost.append(quick.root);
  renderParts=desiredParts;
  lastInspectorKey=reviewKey;renderedArticleId=currentArticle()?.id;
  freezeTaskInputs();
  for (const [id, open] of details) if ($('#'+id)) $('#'+id).open = open;
  for (const [id, top] of scrolls) if ($('#'+id)) restoreReadingScroll($('#'+id), top);
  syncReadingLayout($('#workspace'), renderedArticleId);
  const focusTarget=focusId?$('#'+CSS.escape(focusId)):focusAction?$(`[data-action="${CSS.escape(focusAction)}"]`):null;
  if (focusTarget && previousTask===s.conversation?.id && (!['article-title','article-body','revise-instruction'].includes(focusId)||previousArticle===currentArticle()?.id)) {
    const next = focusTarget;if(rawValue!==null&&focusId!=='message-input')next.value=rawValue; next.focus({ preventScroll: true });
    if (selection && next.setSelectionRange && !['number','checkbox'].includes(next.type)) try { next.setSelectionRange(...selection); } catch {}
  }
  bindResize();bindInspectorResize();fitMessageInput();setupLiveUI($('#root'),{persist:()=>client.persist(),ui:s.ui});restoreFollowing($('#root'),previousTask===s.conversation?.id?following:[]);
  updatePaperFeedback(s, $('#workspace'));
  if(oldComposer&&previousTask===s.conversation?.id&&!document.documentElement.hasAttribute('data-task-transition')&&!matchMedia('(prefers-reduced-motion: reduce)').matches){const next=$('.chat-compose-area'),rect=next?.getBoundingClientRect();if(rect&&Math.abs(oldComposer.top-rect.top)>40&&oldComposer.width===rect.width)next.animate([{transform:`translateY(${oldComposer.top-rect.top}px)`},{transform:'translateY(0)'}],{duration:280,easing:'cubic-bezier(.16,1,.3,1)'});}
  if(!modal.open&&mode==='chat'&&surface==='compose'&&(previousTask!==s.conversation?.id||document.activeElement===document.body))$('#message-input')?.focus({preventScroll:true});
}
const customers = new CustomersWorkspace(client,{render,toast,openTask:openStandardTask,newTask:beginCustomerTask,reuseTask});
const quick = createQuickCreation(client,customers.service,{
  onBatch:quickBatchUpdated,
  openDocuments:async id => {
    await openCustomersArea();
    if (customerArea) {
      await customers.detail(id,'documents');
      $('[data-customer-action="upload"]',$('#workspace'))?.focus();
    }
  },
  newCustomer:() => customers.customerImport.open(customer => quick.addCustomer(customer.id)),
});
client.subscribe(()=>render());
document.addEventListener('compositionstart', () => composing = true);
document.addEventListener('compositionend', () => { composing = false; if (renderPending) { renderPending = false; render(); } });

async function requireTask() {
  if (!standardEntry() && client.state.conversation) return true;
  await openCreationEntry('new');
  return false;
}
async function openCreationEntry(view) {
  if (creatingTask) return;
  const navigation = ++navigationGeneration;
  if (client.state.dirty && client.state.conversation) await client.saveDraft();
  if (navigation !== navigationGeneration) return;
  if (modal.open) modal.close();
  entryView = view;
  if (view === 'new') entryMode = client.state.conversation ? mode : DEFAULT_ENTRY_MODE;
  newTaskRequest = null;
  showArea(view === 'new' ? 'new' : undefined);
  $('#new-content-form')?.reset();
  $('#workspace')?.scrollTo(0,0);
  $('#creation-entry-title')?.focus({preventScroll:true});
}
function showNewTask(nextMode) {
  entryView = null;
  if (classicEnabled()) { enterClassic(); return; }
  quickArea=customerArea=false;customers.leave();panel=null;surface='compose';step=1;
  if (nextMode !== mode) { applyMode(nextMode); return; }
  history.replaceState(null,'',`${location.pathname}?conversation=${encodeURIComponent(client.state.conversation.id)}`);
  render();
}
function workspaceURL(area, batchId) {
  const params = new URLSearchParams();
  if (area) params.set('area',area);
  if (!entryView && client.state.conversation?.id) params.set('conversation',client.state.conversation.id);
  if (batchId) params.set('batch',batchId);
  return location.pathname + (params.size ? `?${params}` : '');
}
function showArea(area, batchId) {
  modeSwitcher.reset();
  quickArea = area === 'quick';
  customerArea = area === 'customers';
  if (!customerArea) customers.leave();
  panel = null;
  if (!area && !entryView) syncTaskMode();
  history.replaceState(null,'',workspaceURL(area,batchId));
  if (innerWidth <= 760) client.setUI({collapsed:true});
  else render();
}
async function openQuickCreation() {
  if (creatingTask) return;
  const navigation = ++navigationGeneration;
  if (client.state.dirty && client.state.conversation) await client.saveDraft();
  if (navigation !== navigationGeneration) return;
  showArea('quick',quick.batchId);
  const id = entryView ? null : client.state.conversation?.client_id;
  await quick.enter({clientIds:id ? [id] : []});
}
async function openCustomersArea(batchId) {
  if (creatingTask) return;
  const navigation = ++navigationGeneration;
  if (client.state.dirty && client.state.conversation) await client.saveDraft();
  if (navigation !== navigationGeneration) return;
  showArea('customers',batchId);
  await customers.enter();
  if (!batchId && navigation === navigationGeneration) customers.syncRoute();
  if (batchId && navigation === navigationGeneration) {
    const batch = await customers.service.batch(batchId);
    if (navigation === navigationGeneration) await customers.showBatch(batch);
  }
}
async function openStandardTask(id, intent) {
  if (creatingTask) return;
  const navigation = ++navigationGeneration;
  if (client.state.dirty && client.state.conversation) await client.saveDraft();
  if (navigation !== navigationGeneration) return;
  if (classicEnabled()) { enterClassic(id); return; }
  if (id && !await client.load(id)) return;
  if (navigation !== navigationGeneration) return;
  if (modal.open) modal.close();
  entryView = null;
  showArea();
  if (intent) await openGuideTarget(intent);
}
function quickBatchUpdated(batch) {
  if (quickArea) history.replaceState(null,'',workspaceURL('quick',batch.id));
  const tasks = client.state.conversations;
  let changed = false;
  for (const item of [...batch.items].reverse()) {
    if (!item.conversation_id || item.deleted_at) continue;
    const task = tasks.find(task => task.id === item.conversation_id);
    if (!task) {
      tasks.unshift({id:item.conversation_id,client_id:item.client_id,title:`${item.name} · 批量生成`,status:item.status,archived_at:item.archived_at,created_at:batch.created_at});
      changed = true;
    } else if (task.status !== item.status) { task.status = item.status; changed = true; }
  }
  if (changed) render();
}
async function beginCustomerTask(id, options) {
  if (creatingTask) return;
  const fromEntry = standardEntry() === 'new' && !classicEnabled();
  const nextMode = fromEntry ? entryMode : client.state.conversation ? mode : 'chat';
  const navigation = navigationGeneration;
  creatingTask = true;
  render();
  try {
    const created = await client.createConversation(id, {...options, mode:nextMode}, {inheritUnassigned:false});
    if (navigation !== navigationGeneration) return;
    // A retry can recover an existing task created before the user changed their selection.
    if (fromEntry && created.mode !== nextMode) await client.saveDraft(nextMode);
    showNewTask(nextMode);
  } finally {
    creatingTask = false;
    render();
  }
}
async function reuseTask(id) {
  await client.cloneConversation(id);
  if (client.state.conversation.mode !== 'zip') await client.saveDraft('zip');
  showNewTask('zip');
  toast('已沿用安排创建新任务');
}
function openCustomerImport() {
  if (modal.open) modal.close();
  customers.customerImport.open((customer, options) => beginCustomerTask(customer.id, options), {forTask:true});
}
function openCustomerSetup() {
  customers.customerImport.open(async customer => {
    await openCustomersArea();
    await customers.detail(customer.id,'profile');
    toast('客户档案已保存');
  });
}
document.addEventListener('submit', event => {
  if (event.target.id !== 'new-content-form') return;
  event.preventDefault();
  const clientId = new FormData(event.target).get('client_id');
  if (!clientId || creatingTask) return;
  if (newTaskRequest?.clientId !== clientId) newTaskRequest = {clientId,id:randomUUID()};
  act(() => beginCustomerTask(clientId,{creation_id:newTaskRequest.id}));
});
function profileDialog() {
  const c = currentClient();
  if (!c) return openCustomerImport();
  const frozen=!!client.state.batch?.frozen;
  const taskId = client.state.conversation.id;
  const alternatives = client.state.clients.filter(item => item.id !== c.id && !item.archived_at && !item.import_draft);
  const fields = PROFILE_FIELDS.map(([key,label]) => `<label class="field ${['products','address'].includes(key) ? 'wide' : ''}"><span>${label}${key === 'name' ? ' *' : ''}</span><input type="text" name="${key}" value="${e(key === 'name' ? c.name : c.profile[key]??'')}" ${key === 'name' ? 'required maxlength="100"' : 'maxlength="4000"'}></label>`).join('');
  const switchCustomer = `<div class="profile-switch" id="profile-switch-panel" hidden>
    ${alternatives.length ? `<label class="field"><span>选择客户</span><select data-profile-customer>
      <option value="">请选择</option>
      ${alternatives.map(item => `<option value="${e(item.id)}">${e(item.name + (item.name_conflict ? ' · ' + customers.distinguishClient(item) : ''))}</option>`).join('')}
    </select></label><p class="helper">更换后会为所选客户新建任务。当前任务仍可在最近任务中打开。</p>
    <button type="button" class="button outline" data-switch-profile-customer disabled>确认更换</button>`
    : '<p class="helper">暂无其他客户可选。</p>'}
  </div>`;
  dialog('本次任务档案', `${switchCustomer}<p class="helper">${frozen?'本批客户档案只读。':''}品牌、公司与产品分别填写。此处临时调整只用于当前任务；永久档案请在客户区编辑。</p><div class="form-grid">${fields}</div>`, frozen ? null : async data => {
    const name = String(data.get('name')).trim(); if (!name) throw new Error('请填写客户或项目名称');
    const profile = Object.fromEntries(PROFILE_FIELDS.filter(([key]) => key !== 'name').map(([key]) => [key, String(data.get(key)||'').trim()]));
    await client.updateProfile(name,profile);
    toast('本次任务档案已保存');
  }, { label:'保存档案' });
  if(frozen)for(const input of $$('input',modal))input.readOnly=true;
  $('#modal-title').insertAdjacentHTML('afterend', '<button type="button" class="button quiet sm" id="profile-switch-toggle" aria-controls="profile-switch-panel" aria-expanded="false">更换客户</button>');
  const toggle = $('#profile-switch-toggle');
  const switchPanel = $('#profile-switch-panel');
  const select = $('[data-profile-customer]',modal);
  const confirm = $('[data-switch-profile-customer]',modal);
  toggle.onclick = () => {
    switchPanel.hidden = !switchPanel.hidden;
    toggle.setAttribute('aria-expanded', String(!switchPanel.hidden));
    if (!switchPanel.hidden) select?.focus();
  };
  modal.addEventListener('close', () => toggle.remove(), {once:true});
  if (!select) return;
  const requests = new Map();
  const save = $('#modal-submit');
  const error = $('#modal-error');
  const closeButtons = $$('[data-close]',modal);
  let switching = false;
  const guardClose = event => { if (switching) event.preventDefault(); };
  modal.addEventListener('cancel', guardClose);
  modal.addEventListener('close', () => modal.removeEventListener('cancel',guardClose), {once:true});
  select.onchange = () => { confirm.disabled = !select.value; error.textContent = ''; };
  confirm.onclick = async () => {
    if (switching || creatingTask || save.disabled || client.state.conversation?.id !== taskId) return;
    const id = select.value;
    if (!alternatives.some(item => item.id === id)) return;
    const data = new FormData($('#modal-form'));
    const edited = PROFILE_FIELDS.some(([key]) => String(data.get(key) ?? '').trim() !==
      String(key === 'name' ? c.name : c.profile[key] ?? '').trim());
    if (edited) { error.textContent = '请先保存当前档案的修改，再更换客户。'; return; }
    if (!requests.has(id)) requests.set(id, randomUUID());
    switching = select.disabled = confirm.disabled = save.disabled = toggle.disabled = true;
    closeButtons.forEach(el => { el.disabled = true; });
    error.textContent = '';
    try {
      await beginCustomerTask(id,{creation_id:requests.get(id)});
      modal.close();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      switching = select.disabled = confirm.disabled = save.disabled = toggle.disabled = false;
      closeButtons.forEach(el => { el.disabled = false; });
    }
  };
}
function platformDialog() {
  if (mode === 'zip' && step === 2) return platformPicker();
  let draft = clone(client.state.options);
  const platforms = client.platforms.filter(enabled);
  function draw() {
    const active=document.activeElement,top=modal.scrollTop;
    const focusKey=active?.dataset.platformCheck?`[data-platform-check="${CSS.escape(active.dataset.platformCheck)}"]`:active?.dataset.countPlatform?`[data-count-platform="${CSS.escape(active.dataset.countPlatform)}"][data-account="${active.dataset.account}"]`:active?.dataset.formatPlatform?`[data-format-platform="${CSS.escape(active.dataset.formatPlatform)}"][value="${CSS.escape(active.value)}"]`:null;
    const summary = planSummary(draft, platforms);
    const staleIds=[...new Set([...draft.selections.map(s=>String(s.platform_id)),...Object.keys(draft.format_overrides||{})])].filter(id=>!platforms.some(p=>String(p.id)===id));
    const staleMarkup=staleIds.map(id=>`<p class="invalid-choice">${e(client.platforms.find(p=>String(p.id)===id)?.name||'平台 '+id)} · 已失效 <button type="button" class="button quiet sm" data-remove-stale-platform="${e(id)}">移除此安排</button></p>`).join('');
    $('#modal-body').innerHTML = `<p class="helper">选中平台默认安排其默认账号一篇。两种身份各 0—20 篇。</p>${staleMarkup}<div class="platform-list">${platforms.map(p => { const counts = selectionCounts(draft,p.id), selected = counts.official + counts.personal > 0; const formats = p.formats; const override = draft.format_overrides?.[p.id]; return `<section class="platform-row ${selected ? '' : 'unselected'}"><div class="platform-row-head"><label><input type="checkbox" data-platform-check="${e(p.id)}" ${selected ? 'checked' : ''}>${e(p.name)}</label><small>默认${accountName(p.account_type)} · ${(counts.official + counts.personal)} 篇</small></div><div class="account-counts">${[['official','官方号'],['personal','个人号']].map(([type,label]) => `<label class="count-field">${label}<input type="number" min="0" max="20" step="1" value="${counts[type]}" data-count-platform="${e(p.id)}" data-account="${type}" aria-label="${e(p.name)}${label}篇数"></label>`).join('')}</div><div class="format-picks">${formats.map((fmt,i) => `<label><input type="checkbox" data-format-platform="${e(p.id)}" value="${e(fmt)}" ${(override || formats).includes(fmt) ? 'checked' : ''}>${e(fmt)}</label>`).join('')}</div>${(override||[]).some(fmt=>!formats.includes(fmt))?`<p class="error-text">有已移除的发布形态，请更新本次安排。<button type="button" class="button quiet sm" data-reset-platform-formats="${p.id}">使用当前配置</button></p>`:""}<p class="platform-note">${formats.includes('短视频') ? '短视频为文案形态；成片需进入独立视频工作区。' : e((p.length_hint || '').split('；')[0])}</p></section>`; }).join('')}</div><div class="selection-summary"><span>已选 ${summary.platforms} 个平台 · <strong>共 ${summary.count} 篇</strong></span><span>官方 ${draft.selections.filter(s=>s.account_type==='official').reduce((n,s)=>n+s.count,0)} · 个人 ${draft.selections.filter(s=>s.account_type==='personal').reduce((n,s)=>n+s.count,0)}</span></div>`;
    const summaryElement=$('.selection-summary',$('#modal-body'));
    if(summaryElement){$('#platform-summary').innerHTML=summaryElement.innerHTML;summaryElement.remove();}
    if(focusKey)$(focusKey,modal)?.focus({preventScroll:true});modal.scrollTop=top;
  }
  dialog('平台、账号与发布形态','',async () => { client.setOptions({ selections:draft.selections, format_overrides:draft.format_overrides }); await client.saveDraft(); toast('平台安排已保存'); }, { label:'保存安排' });
  const footerSummary=document.createElement('div');footerSummary.id='platform-summary';footerSummary.className='selection-summary platform-footer-summary';$('.dialog-actions',modal).prepend(footerSummary);draw();
  $('#modal-body').onchange = event => {
    const el = event.target;
    try {
      if (el.dataset.platformCheck) draft = togglePlatform(draft,platforms.find(p=>String(p.id)===el.dataset.platformCheck),el.checked);
      if (el.dataset.countPlatform) draft = setCount(draft,platforms.find(p=>String(p.id)===el.dataset.countPlatform).id,el.dataset.account,Number(el.value));
      if (el.dataset.formatPlatform) {
        const pid = el.dataset.formatPlatform, checked = $$(`[data-format-platform="${CSS.escape(pid)}"]:checked`,modal).map(x=>x.value);
        if (!checked.length) throw new Error('每个平台至少保留一种发布形态');
        draft.format_overrides = { ...draft.format_overrides, [pid]:checked };
      }
      $('#modal-error').textContent = ''; draw();
    } catch(error) { $('#modal-error').textContent=error.message; draw(); }
  };
  $('#modal-body').onclick=event=>{const reset=event.target.closest('[data-reset-platform-formats]');if(reset){const id=reset.dataset.resetPlatformFormats;draft.format_overrides[id]=[...platforms.find(p=>String(p.id)===id).formats];draw();return;}const remove=event.target.closest('[data-remove-stale-platform]');if(remove){const id=remove.dataset.removeStalePlatform;draft.selections=draft.selections.filter(s=>String(s.platform_id)!==id);delete draft.format_overrides[id];draw();}};
}
function platformPicker() {
  const options = client.state.options;
  const active = client.platforms.filter(enabled);
  const invalid = [...new Set([...options.selections.map(s => String(s.platform_id)),...Object.keys(options.format_overrides)])]
    .filter(id => !active.some(p => String(p.id) === id));
  const choices = active.map(p => `<label><input type="checkbox" name="platform" value="${e(p.id)}" ${hasTaskPlatform(options,p.id)?'checked':''}><span>${e(p.name)}</span></label>`).join('');
  const stale = invalid.map(id => `<label><input type="checkbox" name="stale" value="${e(id)}"><span>移除已失效的 ${e(client.platforms.find(p => String(p.id) === id)?.name || '平台 '+id)}</span></label>`).join('');
  dialog('选择平台',`<div class="library-list">${choices}${stale}</div>`,async data => {
    const chosen = new Set(data.getAll('platform'));
    const removed = new Set(data.getAll('stale'));
    let draft = {...options,format_overrides:{...options.format_overrides}};
    for (const p of active) {
      const id = String(p.id);
      if (chosen.has(id) && !hasTaskPlatform(options,id)) {
        draft = togglePlatform(draft,p,true);
        draft.format_overrides[id] = [...p.formats];
      } else if (!chosen.has(id)) {
        draft = togglePlatform(draft,p,false);
        delete draft.format_overrides[id];
      }
    }
    draft.selections = draft.selections.filter(s => !removed.has(String(s.platform_id)));
    for (const id of removed) delete draft.format_overrides[id];
    client.setOptions({selections:draft.selections,format_overrides:draft.format_overrides});
    await client.saveDraft();
  },{label:'确认平台'});
}
modal.addEventListener('close', () => { $('#modal-body').onchange = null;$('#modal-body').onclick=null; });
const imageTypes = recognitionExtensions.filter(ext=>ext!=='.pdf');
const isTaskImage = filename => imageTypes.includes(filename.slice(filename.lastIndexOf('.')).toLowerCase());
const taskFileInput = document.createElement('input');
taskFileInput.type = 'file';
taskFileInput.multiple = taskFileInput.hidden = true;
taskFileInput.accept = ['.docx','.docm','.xlsx','.xlsm','.pptx','.txt','.md','.markdown','.csv','.tsv','.json','.html','.htm','.log','.pdf',...imageTypes].join(',');
document.body.append(taskFileInput);
function taskUploadContext() {
  const {conversation} = client.state;
  const navigation = navigationGeneration;
  return {
    cid:conversation.client_id,
    current:()=>client.state.conversation?.id === conversation.id && navigationGeneration === navigation && !entryView && !customerArea && !quickArea,
  };
}
async function refreshTaskLibrary(context) {
  const library = await customerService.documents(context.cid);
  if (!context.current()) return false;
  client.state.library = library;
  return true;
}
async function selectUploadedDocuments(docs) {
  const revisions = new Map(docs.map(doc=>[doc.group_id,doc]));
  const current = new Map(selectedDocs().map(doc=>[String(doc.id),doc]));
  const keep = client.state.documentIds.filter(id=>!revisions.has(current.get(String(id))?.group_id));
  client.state.documents = [...client.state.documents.filter(doc=>!revisions.has(doc.group_id)),...revisions.values()];
  client.selectDocuments([...keep,...[...revisions.values()].map(doc=>doc.id)]);
  await client.saveDraft();
}
async function openTaskRecognition(id) {
  if (client.state.batch?.frozen || !client.state.conversation) return;
  const context = taskUploadContext();
  const doc = client.state.library.find(item=>item.id===id && item.has_recognition && item.status==='pending');
  if (!doc) return;
  const report = await customerService.recognition(context.cid,id);
  if (!context.current()) return;
  const review = new RecognitionReview(customerService,context.cid,doc,report);
  await customers.showDocumentRecognition(review,{auto:true,label:'确认并选入本次资料',onConfirm:async confirmed=>{
    if (!await refreshTaskLibrary(context)) return;
    if (confirmed.text?.trim()) {
      await selectUploadedDocuments([confirmed]);
      if (context.current()) toast('识别文字已入库并选入本次任务');
    } else {
      render(); toast('已保存原图；图片没有可用于创作的文字');
    }
  }});
}
async function uploadFiles(files) {
  if (!files.length || importing) return;
  if(client.state.batch?.frozen){toast('本批安排已冻结，可复用为新任务调整');return;}
  if (!await requireTask()) return;
  const context = taskUploadContext(), failures = [], uploaded = new Set();
  let pending = [], added = 0;
  importing = true; render();
  try {
    for (const file of files) {
      if (!context.current()) return;
      try {
        const {outcome,document:doc} = await importCustomerFile(customerService,context.cid,file,
          info=>context.current() ? customers.resolveImport(info) : null,{recognize:isTaskImage(file.name)});
        if (outcome==='cancelled') continue;
        if (!doc || (!doc.has_recognition && doc.status!=='ready')) throw new Error(doc?.error || '原件已保存，资料尚待处理');
        if (doc.status!=='pending' && !doc.is_current) throw new Error('原件属于历史修订，请从资料库选当前版本');
        if (doc.status==='ready' && !doc.text?.trim()) throw new Error('原件已保存，没有可用于创作的文字');
        uploaded.add(doc.id);
      } catch(error) { failures.push(`${file.name}：${error.message}`); }
    }
    if (!context.current() || !await refreshTaskLibrary(context)) return;
    const docs = client.state.library.filter(doc=>uploaded.has(doc.id));
    pending = docs.filter(doc=>doc.status==='pending' && doc.has_recognition);
    const ready = docs.filter(doc=>doc.status==='ready' && doc.is_current && doc.text?.trim());
    added = ready.length;
    if (added) await selectUploadedDocuments(ready);
  } finally {
    importing = false;
    render();
  }
  if (!context.current()) return;
  if (failures.length) client.fail(new Error(failures.join('；')));
  if (pending.length) {
    if (mode==='chat') { panel='sources'; render(); }
    await openTaskRecognition(pending[0].id);
  }
  else if (added && !failures.length) toast(`已解析并添加 ${added} 份资料`);
}
function upload() {
  if (!client.state.conversation || standardEntry()) return requireTask();
  if (importing || client.state.batch?.frozen) return;
  const context = taskUploadContext();
  taskFileInput.value = '';
  taskFileInput.onchange=()=>{if(context.current())act(()=>uploadFiles([...taskFileInput.files]));};
  taskFileInput.click();
}
async function paste() {
  if (!await requireTask()) return;
  dialog('粘贴客户资料','<div class="form-grid"><label class="field wide"><span>资料名称</span><input type="text" name="filename" value="粘贴资料" required></label><label class="field wide"><span>资料正文</span><textarea class="input" name="text" rows="12" required placeholder="粘贴真实资料的正文"></textarea></label></div>',async data=>{ const text=String(data.get('text')).trim(); if(!text)throw new Error('资料正文不能为空'); await client.addDocument({ filename:String(data.get('filename')).trim() || '粘贴资料',kind:'粘贴文本',text }); toast('资料已入库并选入本次任务'); }, {label:'保存并选择'});
}
async function library() {
  if (!await requireTask()) return;
  dialog('客户资料库',`<p class="helper">${e(currentClient()?.name)} · 仅选择本次要使用的资料。</p><div class="library-list">${client.state.library.filter(doc=>!['pending','error','failed'].includes(doc.status)).map(doc=>`<label><input type="checkbox" name="documents" value="${e(doc.id)}" ${client.state.documentIds.some(id=>String(id)===String(doc.id)) ? 'checked' : ''}><span>${e(doc.filename)}<small>${e(doc.kind)} · ${(doc.text||'').length.toLocaleString()} 字</small></span></label>`).join('') || '<p class="empty">资料库为空，先上传文件或粘贴正文。</p>'}</div>`,async data=>{ client.selectDocuments(data.getAll('documents').map(id=>client.state.library.find(d=>String(d.id)===String(id))?.id ?? id)); await client.saveDraft(); },{label:'使用所选资料'});
}
function showDocument(id) {
  const doc=[...client.state.library,...client.state.documents].find(x=>String(x.id)===String(id)); if(!doc)return;
  const selected=client.state.documentIds.some(value=>String(value)===String(id));
  const guidance=client.state.batch?.frozen?'本批资料只读。后续资料更新请在客户区处理。':selected?'可直接修正解析文字。本次任务将使用保存后的修订。':'可直接修正解析文字。勾选资料后用于本次任务。';
  dialog(`核对资料：${doc.filename}`,`<p class="helper">${e(doc.kind)} · ${guidance}</p><label class="field"><span>资料正文</span><textarea class="input" id="document-text" name="text" rows="16">${e(doc.text)}</textarea></label><p class="helper" id="document-char-count">${doc.text.length.toLocaleString()} 字</p>`,client.state.batch?.frozen ? null : async data=>{await client.reviseDocument(id,String(data.get('text')));toast('资料修订已保存');},{label:'保存资料修订'});
  $('#document-text').readOnly=!!client.state.batch?.frozen;
  $('#document-text').oninput=event=>$('#document-char-count').textContent=`${event.target.value.length.toLocaleString()} 字`;
}
function addKeyword() {
  const input=$('#keyword-entry'),added=splitWords(input.value);if(!added.length)return;
  client.setOptions({keywords:[...new Set([...client.state.options.keywords,...added])]});$('#keyword-entry').value='';$('#keyword-entry').focus();
}
async function detectAliases() {
  clearTimeout(aliasTimer);
  const detected=await loadAliasCandidates();
  const groups=[],seen=new Set();for(const group of [...client.state.options.aliases,...detected]){const key=JSON.stringify([...group].sort());if(!seen.has(key)){seen.add(key);groups.push(group);}}
  dialog('确认别名分组',`<p class="helper">勾选属于同一实体的写法。确认后交由原 ZIP 分组，不改变关键词原文。</p><div class="library-list">${groups.map((group,index)=>`<label><input type="checkbox" name="alias" value="${index}" checked><span>${e(group.join(' / '))}</span></label>`).join('')||'<p class="empty">未发现疑似别名。仍可在完整选项中手工填写。</p>'}</div>`,async data=>{client.setOptions({aliases:data.getAll('alias').map(index=>groups[Number(index)])});await client.saveDraft();toast('别名分组已保存');},{label:'按勾选合并'});
}
async function recommendChatTopic() {
  if(topicPickerOpen||operationBusy||isOperationRunning())return;
  topicPickerOpen=true;
  try {
    if(!await requireTask())return;
    const currentTopic=client.writingTopic();
    const topic=await client.pickWritingTopic(recommend=>mode==='chat'&&!standardEntry()&&!quickArea&&!customerArea
      ?chooseArticleTopic(recommend,{submitLabel:'使用这个选题',expanded:true,currentTopic})
      :null);
    if(topic)client.setWritingTopic(topic);
  } finally {topicPickerOpen=false;}
}
async function start(confirmed=false,one=false) {
  if(topicPickerOpen||!await requireTask())return;
  pendingChat=mode==='chat'?{id:client.state.conversation.id,text:client.messageDraft()}:null;operationBusy=true;render();
  try {
    const options = {confirmed,one,chooseTopic:chooseArticleTopic};
    const done = mode==='chat' ? await client.submitMessage({start:true,...options}) : await client.start(options);
    if(done===null)return;
    surface='live';step=3;showDraft('live');
  }
  catch (error) {
    const gap = error.status === 400 && error.operationKind !== OPERATION_KIND.chat && writingGap();
    if (!gap) throw error;
    await fillWritingGap(gap);
  }
  finally {pendingChat=null;operationBusy=false;render();}
}
async function fillWritingGap(gap) {
  if (gap.kind === 'keywords') {
    if (mode === 'zip') await setStep(1);
    else { panel = 'arrangement'; render(); }
    $('#keyword-entry')?.focus();
    return;
  }
  if (gap.kind === 'targets') {
    const available = client.targets.filter(enabled).map(target=>target.name || target);
    const choices = available.map(name=>`<label><input type="checkbox" name="target" value="${e(name)}" ${client.state.options.models.includes(name)?'checked':''}>${e(name)}</label>`).join('');
    dialog('调整目标 AI',`<p class="helper">保存后会移除已停用的目标 AI。</p><div class="target-list">${choices}</div>`,async data => {
      client.setOptions({models:data.getAll('target')});
      await client.saveDraft();
    },{label:'保存目标 AI'});
    return;
  }
  const reset = mode === 'zip' && gap.kind === 'formats' && $('[data-action="reset-task-formats"]');
  if (reset) { reset.focus(); return; }
  platformDialog();
  $('#modal-body input:not(:disabled)')?.focus();
}
async function requestWriting(one = false) {
  if (!await requireTask()) return;
  const gap = writingGap(mode === 'chat');
  if (gap) return fillWritingGap(gap);
  return client.state.needsConfirmation ? confirmPlan(one) : start(false,one);
}
async function interview() {
  if(!await requireTask())return;
  if(messageTarget()==='article')return reviseFromChat();
  pendingChat={id:client.state.conversation.id,text:client.messageDraft()};operationBusy=true;render();
  try { const done=await client.submitMessage();if(done){surface='compose';} }
  finally {pendingChat=null;operationBusy=false;render();$('#message-input')?.focus();}
}
function confirmPlan(one=false) {
  const s=client.state, summary=planSummary(s.options,client.platforms);
  dialog('确认后续安排',`<dl class="plain-dl"><div><dt>客户</dt><dd>${e(currentClient()?.name)}</dd></div><div><dt>关键词</dt><dd>${e(s.options.keywords.join('、'))}</dd></div><div><dt>平台与账号</dt><dd>${e(summary.text)}</dd></div><div><dt>资料</dt><dd>${s.documentIds.length} 份</dd></div></dl><h3 class="section-title" style="margin-top:22px">本次要求</h3><p class="helper">${e(s.options.note)}</p><p class="helper">${one?'只执行现有安排中的下一篇，完成后停止。':'保留已有结果，按更新后的安排继续。'}</p>`,async()=>{await start(true,one);},{label:one?'确认并只写下一篇':'确认并继续写作'});
}
function newRequirement() {
  dialog('调整本次要求',`<p class="helper">这里保存本次完整的有效要求。写作中修改会暂停后续，当前篇继续收尾。</p><label class="field"><span>本次有效要求</span><textarea class="input" name="requirement" rows="6">${e(client.state.options.note)}</textarea></label>`,async data=>{client.setOptions({note:String(data.get('requirement')).trim()});await client.saveDraft();toast('本次要求已保存');},{label:'保存本次要求'});
}
function beginEdit(a) {
  client.assertEditable(a.id); let editor=localEditor(a);
  if(editor)editor.reading=!editor.reading;else client.state.editors[editorKey(a)]={title:a.title,body:articleBody(a),tags:(a.tags||[]).join(' '),decl:(a.decl||[]).join('\n'),base:a.current_version,dirty:false,reading:false};
  client.persist();render();
}
function endEdit() {
  const a = currentArticle(), key = editorKey(a);
  const discard = () => {
    delete client.state.editors[key];
    client.persist();
    render();
  };
  if (localEditor(a)?.dirty) {
    dialog('放弃稿件修改','<p>放弃这篇稿件的未保存编辑，回到当前采用稿。</p>',discard,{label:'放弃修改'});
  } else discard();
}
async function selectArticle(id) {
  selectedId=id;surface='articles';step=4;showDraft('article');render();
  if (panel === 'versions' && !versionsData[id] && !currentArticle()?.locked) await loadVersions();
}
async function saveArticle() {
  const a=currentArticle(), ed=localEditor(a); if(!ed)return;
  const key = editorKey(a);
  if (savingEditors.has(key)) return;
  const tags=String(ed.tags??(a.tags||[]).join(' ')).split(/[,，\s]+/).filter(Boolean).map(tag=>tag.startsWith('#')?tag:'#'+tag);
  const decl=String(ed.decl??(a.decl||[]).join('\n')).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  savingEditors.add(key);
  render();
  try {
    await client.saveArticle(a.id,editedBody(a,ed),ed.title,ed.base,{tags,decl});
    versionsData[a.id]=null;toast('已保存新工作版本；本版尚未核查');
  } finally {
    savingEditors.delete(key);
    render();
  }
}
async function loadVersions() { const a=currentArticle();if(!a)return;versionsData[a.id]=await client.versions(a.id);render(); }
function nativeActionDialog(kind) {
  const a=currentArticle();client.assertSettled();client.assertEditable(a.id);
  if(localEditor(a)?.dirty)throw new Error('请先保存人工编辑');
  const regenerate=kind==='regenerate';
  dialog(regenerate?'整篇重写并核查':'再核查一次',`<p>${regenerate?'按当前平台、账号身份、发布形态和角度重新写作，再核查事实。':'再次核查当前采用稿，可能按核查结果修正正文。'}</p><p class="helper">完成后采用新版本，当前版本保留，可从版本列表恢复。</p>${regenerate?'<label class="field"><span>本次重写补充要求 · 可选</span><textarea class="input" name="extra_note"></textarea></label>':''}`,async data=>{
    operationBusy=true;render();const cid=client.state.conversation.id;
    let operationId;
    try { operationId=await client.beginArticleOperation(a.id,kind,regenerate?{extra_note:String(data.get('extra_note')||'').trim()}:{}); }
    catch(error){operationBusy=false;render();throw error;}
    modal.close();
    act(async()=>{try {const result=await client.watchOperation(operationId);if(!result||client.state.conversation?.id!==cid)return;versionsData[a.id]=null;surface='articles';step=4;toast(regenerate?'已重新写作并核查，当前采用新版本':'再次核查已完成，请查看当前采用稿');}finally{operationBusy=false;render();}});
    return false;
  },{label:regenerate?'重新写作并核查':'开始再次核查'});
}
function deleteArticleDialog() {
  const a=currentArticle();client.assertSettled();
  dialog('删除这篇稿件',`<p>确认从本次稿件和导出中移除“${e(a.title)}”？</p><p class="helper">原安排会空出一篇，可再次写作。历史版本与已固定的视频来源保留。</p>`,async()=>{await client.deleteArticle(a.id);delete versionsData[a.id];selectedId=null;toast('稿件已移除');},{label:'确认删除稿件'});
}
function deleteTaskDialog() {
  client.assertSettled();
  dialog('删除任务',`<p>确认删除“${e(displayTaskTitle(client.state.conversation))}”？</p><p class="helper">任务将从历史列表移除。客户档案和已固定的视频来源保留，未保存的编辑也会移除。</p>`,async()=>{await client.deleteConversation();history.replaceState(null,'',location.pathname);panel=null;toast('任务已删除');},{label:'确认删除任务'});
}
async function downloadFile(url,filename) {
  const response=await fetch(url);if(!response.ok){let result;try{result=await response.json();}catch{}throw new Error(result?.error||'下载失败，请核对当前状态');}
  const blob=await response.blob(),link=document.createElement('a'),objectUrl=URL.createObjectURL(blob);link.href=objectUrl;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(objectUrl),2000);
}
async function archiveTask() {client.assertSettled();if(client.state.dirty)await client.saveDraft();await downloadFile(client.path('/archive'),`方立-任务归档-${client.state.conversation.id}.zip`);toast('本地归档已下载');}
function acceptedExpressionDialog() {
  const a=currentArticle();if(!a?.current_version)return;
  const path=client.articlePath(a.id,'/accepted-expressions');
  dialog('保存为认可表达',`<p class="helper">${e(a.title)} · 采用版本 ${e(a.current_version)}。后续创作可借鉴写法。</p>
    <label class="field"><span>认可范围</span><select name="selection"><option value="excerpt">选段</option><option value="article">整篇正文</option></select></label>
    <label class="field"><span>在正文原文中选中要保存的文字</span><textarea class="input" id="accepted-source" rows="8" readonly></textarea></label>
    <label class="field"><span>适用形式</span><select name="medium"><option value="article">${e(a.platform_name)} · ${e(a.fmt)}</option><option value="video">短视频 · 页面式口播</option></select></label>
    <label class="field"><span>写法用途</span><input name="purpose" maxlength="200" placeholder="例如用一个具体场景带出操作步骤" required></label>`,async data=>{
    const selection=data.get('selection'),source=$('#accepted-source',modal);
    const excerpt=source.value.slice(source.selectionStart,source.selectionEnd).trim();
    if(selection==='excerpt'&&!excerpt)throw new Error('请先在正文原文中选中要保存的文字');
    await client.api(path,'POST',{expected_version:a.current_version,selection,medium:data.get('medium'),
      purpose:data.get('purpose'),...(selection==='excerpt'?{excerpt}:{})});
    toast('认可表达已保存');
  });
  $('#accepted-source',modal).value=a.body_md||'';
  $('[name=selection]',modal).onchange=event=>{
    $('#accepted-source',modal).closest('label').hidden=event.target.value==='article';
  };
}
const editorialCache = new Map();
let editorialHistory;
const editorialKey = (article, version) => `${client.state.conversation?.id}:${article.id}:${version}`;
function loadEditorial(article, version) {
  const key = editorialKey(article,version);
  editorialCache.set(key,{});
  void client.api(client.articlePath(article.id,`/editorial?version_id=${version}`)).then(
    value=>editorialCache.set(key,{value}),
    error=>editorialCache.set(key,{error:error.message})
  ).then(()=>{if(panel==='editorial')render();});
}
function editorialVersion(article) {
  return editorialHistory?.key === editorialKey(article,article.current_version)
    ? editorialHistory.version : article.current_version;
}
function editorialPanel() {
  const article = currentArticle();
  if (!article?.current_version) return '<p class="empty">先打开一篇已保存的稿件。</p>';
  const version = editorialVersion(article);
  const key = editorialKey(article,version);
  if (!editorialCache.has(key)) loadEditorial(article,version);
  const entry = editorialCache.get(key);
  if (entry.error) return `<p class="error-text" role="alert">${e(entry.error)}</p>${button('reload-editorial','重新读取',null,'quiet sm')}`;
  if (!entry.value) return '<p class="helper" role="status">正在读取本版详情…</p>';
  const historical = version !== article.current_version;
  const blocked = article.locked || operationBusy || isOperationRunning() || Boolean(localEditor(article)?.dirty);
  const candidate = !historical && [...client.state.operations].reverse()
    .find(op=>op.kind==='fact_repair' && op.article_id===article.id && op.status==='done' && op.result?.base_version===version)?.result;
  const activity = activityMarkupForFacts();
  return `${historical ? button('article-editorial','查看当前版',null,'quiet sm') : ''}${articleEditorialMarkup(entry.value,e,{blocked,historical,candidate,activity})}
    <details class="inspector-disclosure" id="editorial-configuration"><summary>本版创作配置</summary>${generationContextMarkup(entry.value.generation_context)}</details>
    ${historical ? '' : nativeArticleInfo(article)}`;
}
function activityMarkupForFacts() {
  return client.state.operations.filter(op=>op.kind==='fact_repair' && running(op) && op.article_id===currentArticle()?.id)
    .map(op=>`<div class="operation-row" role="status"><span class="working-dot"></span><span>正在生成事实修订候选</span><button class="text-button" data-stop-operation="${e(op.id)}">请求停止</button></div>`).join('');
}
function openEditorial(version) {
  const article = currentArticle();
  if (!article?.current_version) return;
  editorialHistory = version ? {key:editorialKey(article,article.current_version),version} : null;
  panel='editorial';
  render();
}
async function repairFacts(number) {
  const article = currentArticle();
  if (!article?.current_version || editorialVersion(article)!==article.current_version || operationBusy) return;
  if (localEditor(article)?.dirty) throw new Error('请先保存当前编辑，再修正事实问题');
  const key = editorialKey(article,article.current_version);
  const issues = editorialCache.get(key)?.value?.fact_issues || [];
  const selected = number ? [number] : issues.filter(issue=>issue.repairable).map(issue=>issue.id);
  if (!selected.length) return;
  operationBusy=true;
  render();
  try {
    await client.articleOperation(article.id,'repair-facts',{selected});
  } finally {
    operationBusy=false;
    render();
  }
}
function locateFact(number) {
  const article = currentArticle();
  const issue = editorialCache.get(editorialKey(article,article.current_version))?.value?.fact_issues.find(item=>item.id===number);
  if (!issue?.quote) return;
  const editor = $('#article-body');
  if (editor) {
    const index = editor.value.indexOf(issue.quote);
    if (index >= 0) { editor.focus(); editor.setSelectionRange(index,index+issue.quote.length); return; }
  }
  const normalize = text => text.replace(/\s+/g,' ').trim();
  const line = normalize(issue.quote);
  const target = $$('#paper :is(p, li, h1, h2, h3, td, blockquote)').find(node=>normalize(node.textContent).includes(line));
  if (!target) { toast('显示稿中未找到完整原句，可对照正文核对。'); return; }
  $('.is-fact-target')?.classList.remove('is-fact-target');
  target.classList.add('is-fact-target');
  target.scrollIntoView({block:'center'});
}
async function articleOperation(kind) {
  const a=currentArticle();if(!a)return; if(localEditor(a)?.dirty)throw new Error('请先保存当前编辑，再处理这个版本');
  const cid=client.state.conversation.id;
  let selection;
  if(kind==='style-rewrite'){
    const r=reviewFor(a);if(!r||r.base_version!==a.current_version)throw new Error('当前版本需要先重新审阅');
    const material=$('#rewrite-material')?.value||client.articleDraft(a.id,reviewScope(r)).material||'';
    selection=reviewSelection(r,{selected:[...selectedSuggestions],conservative:[...conservativeSuggestions],mode:rewriteMode,material});
    if(!selection.selected.length||selection.invalid.length||selection.missing.length){reviewError=selection.invalid.length?`建议 ${selection.invalid.join('、')} 已变化，请重新选择`:!selection.selected.length?'请至少选择一项建议或观察项':`建议 ${selection.missing.join('、')} 选择了补充素材，请填写真实素材，或明确选择仅删减或收紧。`;$('#review-validation').textContent=reviewError;if(selection.missing.length)$('#rewrite-material')?.focus();return;}
    delete selection.missing;delete selection.invalid;reviewError='';
  }
  operationBusy=true;render();
  try {
    if(kind==='style-review') {
      const r=await client.articleOperation(a.id,kind);if(!r||client.state.conversation?.id!==cid)return; reviews[a.id]=r;const defaults=reviewDefaults(r);selectedSuggestions=new Set(defaults.selected);rewriteMode=defaults.mode;selectedReviewId=null; panel='review';
    } else if(kind==='style-rewrite') {
      const r=reviewFor(a);if(!r || r.base_version!==a.current_version)throw new Error('当前版本需要先重新审阅');
      const result=await client.articleOperation(a.id,kind,{review_id:r.review_id||r.operation_id,...selection});
      if(!result||client.state.conversation?.id!==cid)return;
      r.candidate=result.candidate_version; await compareDialog(a.id,result.candidate_version,result);
    } else {
      const instruction=revisionInstruction(a).trim();if(!instruction)throw new Error('请填写对当前稿的修改要求');
      const result=await client.articleOperation(a.id,'revise',{instruction});if(!result||client.state.conversation?.id!==cid)return;await compareDialog(a.id,result.candidate_version,result);
    }
  } finally {operationBusy=false;render();}
}
async function compareDialog(aid,candidate,result={}) {
  const data=await client.compare(aid,candidate), a=client.article(aid);
  const base=data.base?.article||data.base||{}, next=data.candidate?.article||data.candidate||{};
  const records=Array.isArray(data.review_records) ? data.review_records.find(x=>x.candidate_version===candidate)||{} : data.review_records||{};
  const fact=result.fact_check||data.review||data.candidate?.review||{};
  const changes=result.changes||data.candidate?.metadata?.changes||[],skipped=result.skipped||data.candidate?.metadata?.skipped||[];
  dialog('版本全文与差异',`${fontSizeControl('reading',client.state.ui)}<p class="helper">候选未采用前，默认查看与导出仍使用当前采用版 ${a.current_version}。</p><div class="compare-grid"><section><h3>原稿 · 版本 ${e(data.base?.id||data.base?.version_id||a.current_version)}</h3><div class="compare-copy rendered-copy"><h3>${e(base.title||a.title)}</h3>${markdown(readingBody(base))}</div></section><section><h3>候选 / 历史稿 · 版本 ${e(candidate)}</h3><div class="compare-copy rendered-copy"><h3>${e(next.title)}</h3>${markdown(readingBody(next))}</div></section></div><details id="compare-diff" open><summary>前后差异</summary><pre class="diff-text">${e(valueText(data.diff||result.changes||'服务端未提供差异摘要，请对照两侧全文。'))}</pre></details><details id="candidate-fact" open><summary>${fact.readonly===true?'一次只读模型复核':['zip','zip_initial','zip_regenerate','zip_regenerate_draft','zip_audit'].includes(data.candidate?.origin)?'原生事实核查 · 可修正正文':'此版本核查状态'}</summary><div class="fact-report">${factMarkup(fact)}</div></details>${changes.length?`<details id="candidate-changes"><summary>模型修改清单 · ${changes.length} 条</summary>${changes.map(text=>`<p>${e(text)}</p>`).join('')}</details>`:''}${skipped.length?`<details id="candidate-skipped"><summary>其他处理说明 · 原返回</summary>${skipped.map(text=>`<p>${e(text)}</p>`).join('')}</details>`:''}<section class="saved-review"><h3>实际审阅记录</h3><div class="review-text">${records.codex_review?markdown(records.codex_review):'<p class="helper">尚无 Codex 意见记录。</p>'}</div>${records.user_review?`<h4>用户意见</h4><div class="review-text">${markdown(records.user_review)}</div>`:'<p class="helper">用户尚未提交审阅意见。</p>'}</section><details id="edit-review-record"><summary>编辑意见记录</summary><div class="form-grid record-grid"><label class="field"><span>Codex 审阅意见 · 真实记录</span><textarea class="input" name="codex_review" placeholder="尚未提交 Codex 意见；有真实审阅后再记录。">${e(records.codex_review||'')}</textarea></label><label class="field"><span>你的意见</span><textarea class="input" name="user_review" placeholder="记录你认可或仍需调整的地方">${e(records.user_review||'')}</textarea></label></div><div class="inline-actions" style="margin-top:14px"><button type="button" class="button outline" id="save-review-record">保存双方意见</button><span id="record-status" class="helper">${records.codex_review ? '已有 Codex 意见记录' : '尚无 Codex 意见记录'}</span></div></details>`,a.current_version===candidate ? null : async()=>{if(localEditor(a)?.dirty)throw new Error('请先保存人工编辑，再采用版本');await client.selectVersion(aid,candidate);versionsData[aid]=null;toast('已明确采用，此版本用于默认导出');},{wide:true,label:'采用此版并用于导出'});
  $('#save-review-record').onclick=()=>act(async()=>{await client.reviewRecord(aid,{candidate_version:candidate,codex_review:$('[name=codex_review]',modal).value,user_review:$('[name=user_review]',modal).value});$('#record-status').textContent='双方意见已留档';});
}
async function exportDialog() {
  const articles=client.state.articles.filter(a=>a.current_version!=null&&!a.locked);
  const omitted=client.state.ui.exportOmitted?.[client.state.conversation.id]||[];
  const a=currentArticle();
  const videoHref=a && !a.locked && narratedVideoHref(client.state.conversation,a);
  const formats = `${articles.length?'<optgroup label="稿件正文"><option value="docx">Word（DOCX）</option><option value="md">Markdown</option><option value="txt">纯文本（TXT）</option></optgroup>':''}
    <optgroup label="任务数据与留档">${articles.length?'<option value="json">任务资料 JSON</option>':''}<option value="archive">任务记录 ZIP</option></optgroup>`;
  const descriptions = {docx:'交付用 Word，所选稿件每篇另起一页。',md:'保留标题、列表等 Markdown 排版。',txt:'适合复制粘贴，保留段落和列表。',json:'包含本次创作安排、资料信息及所选稿件。',archive:'打包本次安排、资料文字、稿件版本与核查记录。'};
  dialog('导出',`<label class="field"><span>下载内容</span><select name="fmt" aria-describedby="export-description">${formats}</select></label>
    <p id="export-description" class="helper">${descriptions[articles.length?'docx':'archive']}</p>
    <div id="export-article-picks" ${articles.length?'':'hidden'}><div class="inline-actions"><button type="button" class="button quiet sm" data-export-pick="all">全选</button><button type="button" class="button quiet sm" data-export-pick="none">全不选</button></div><div class="library-list">${articles.map(a=>`<label><input type="checkbox" name="ids" value="${a.id}" ${omitted.includes(String(a.id))?'':'checked'}><span>${e(a.title)}<small>${e(a.platform_name||a.platform||'')} · ${accountName(a.account_type)} · 版本 ${a.current_version}</small></span></label>`).join('')}</div></div>${videoHref?`<div class="inline-actions export-video"><a class="button quiet sm" href="${e(videoHref)}">${icon('video')}用当前采用稿制作视频</a></div>`:''}`,async data=>{
    const fmt=data.get('fmt');
    if(fmt==='archive')return archiveTask();
    const ids=data.getAll('ids');
    if(!ids.length)throw new Error('至少选择一篇稿件');
    const query=new URLSearchParams({fmt,ids:ids.join(',')});
    if(fmt!=='json')query.set('scope','delivery');
    const response=await fetch(client.path(`/export?${query}`));
    if(!response.ok){
      let detail;
      try{detail=await response.json();}catch{}
      throw new Error(detail?.error||'导出失败，请确认后台状态');
    }
    const blob=await response.blob();
    const link=document.createElement('a'),objectUrl=URL.createObjectURL(blob);
    link.href=objectUrl;
    const filename = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    link.download=filename ? decodeURIComponent(filename) : `方立-${client.state.conversation.id}.${fmt}`;
    link.click();
    setTimeout(()=>URL.revokeObjectURL(objectUrl),2000);
    toast('已导出所选采用版本');
  },{label:articles.length?'导出文件':'下载 ZIP'});
  $('[name=fmt]',modal).onchange=event=>{
    const format=event.target.value, archive=format==='archive';
    $('#export-article-picks').hidden=archive;
    $('#export-description').textContent=descriptions[format];
    $('#modal-submit').textContent=archive?'下载 ZIP':'导出文件';
  };
}
function rememberExportSelection() {
  const omitted=$$('input[name="ids"]',modal).filter(input=>!input.checked).map(input=>input.value);
  client.state.ui.exportOmitted={...client.state.ui.exportOmitted,[client.state.conversation.id]:omitted};client.persist();
}
async function reloadConfig() {client.state.config=await client.api('/api/workbench/zip-config');client.state.configError='';render();}
async function saveSettings() {
  const useApi = $('[name="writing-source"]:checked').value === 'api';
  const transport = useApi ? $('#setting-api-provider').value : 'workbuddy';
  if (useApi && $('#setting-api-model').disabled) throw new Error('请配置本机 API 后重启工作台，或选择 WorkBuddy');
  const model = $(useApi ? '#setting-api-model' : '#setting-model').value.trim();
  if (!model) throw new Error('请输入该 API 服务的模型 ID');
  const temperature=Number($('#setting-temperature').value),max_tokens=Number($('#setting-max-tokens').value),title_prefix=$('#setting-title-prefix').checked,brand=$('#setting-brand').value,disable_thinking=$('#setting-disable-thinking').checked;
  const limits=settingLimits();
  if(!Number.isFinite(temperature)||temperature<limits.temperature.min||temperature>limits.temperature.max||!Number.isInteger(max_tokens)||max_tokens<limits.max_tokens.min||max_tokens>limits.max_tokens.max)throw new Error(`请填写有效的温度（${limits.temperature.min}—${limits.temperature.max}）与最大 Token（${limits.max_tokens.min}—${limits.max_tokens.max}）`);
  const patch = {transport,model,temperature,max_tokens,title_prefix,brand,disable_thinking};
  const d=await client.api('/api/workbench/settings','POST',patch);
  client.state.bootstrap.settings={...client.state.bootstrap.settings,...patch,...d.settings};
  client.state.model=client.state.bootstrap.settings.model;client.emit();toast('写作设置已保存');
}
async function refreshWorkBuddyModels(trigger) {
  const select = $('#setting-model');
  trigger.disabled = true;
  try {
    const data = await client.api('/api/workbench/provider-models');
    client.state.bootstrap.provider_models = data.provider_models || [];
    const current = $('#setting-model');
    if (current) current.innerHTML = workBuddyModelOptions((select?.isConnected ? select : current).value);
    toast('模型目录已更新');
  } finally {
    trigger.disabled = false;
  }
}
function configAdmin() { openSettings('platforms'); }
function deleteCatalogue(kind,id) {
  const platform=kind==='platforms',item=(platform?client.platforms:client.targets).find(row=>String(row.id)===String(id));
  dialog(platform?'删除平台':'删除目标 AI',`<p>确认删除 ${e(item?.name||'此配置')}？</p><p class="helper">${platform?'关联的平台风险与抓取偏好配置也会删除。':'关联的抓取偏好配置也会删除。'}</p>`,async()=>{await client.api(`/api/${kind}/${id}`,'DELETE',{});await refreshCatalogue();toast('配置已删除');},{label:'确认删除'});
}
function editPlatform(id) {
  const p=client.platforms.find(x=>String(x.id)===String(id))||{name:'',formats:['图文'],account_type:'personal',enabled:true};
  dialog(id?'平台完整配置':'添加平台',`<div class="form-grid"><label class="field"><span>平台名称</span><input type="text" name="name" value="${e(p.name)}" required></label><label class="field"><span>默认账号</span><select name="account_type"><option value="personal" ${p.account_type==='personal'?'selected':''}>个人号</option><option value="official" ${p.account_type==='official'?'selected':''}>官方号</option></select></label><label class="field wide"><span>发布形态 · 逗号分隔</span><input type="text" name="formats" value="${e(p.formats.join('，'))}" required></label>${[['style','表达风格'],['length_hint','篇幅规则'],['structure_hint','结构规则'],['audience','平台受众']].map(([key,label])=>`<label class="field wide"><span>${label}</span><textarea class="input" name="${key}">${e(p[key]||'')}</textarea></label>`).join('')}${id?`<label class="check-label"><input type="checkbox" name="enabled" ${enabled(p)?'checked':''}>启用平台</label>`:'<p class="helper">新增平台默认启用，保存后可调整。</p>'}</div>`,async data=>{const body={...Object.fromEntries(data),formats:splitWords(data.get('formats')),...(id?{enabled:data.has('enabled')}:{})};if(!body.formats.length)throw new Error('至少保留一种形态');await client.api('/api/platforms'+(id?'/'+id:''),id?'PUT':'POST',body);await refreshCatalogue();toast('平台完整配置已保存');});
}
function editTarget(id) {
  const t=client.targets.find(x=>String(x.id)===String(id))||{};
  dialog(id?'编辑目标 AI':'添加目标 AI',`<div class="form-grid"><label class="field wide"><span>名称</span><input type="text" name="name" required value="${e(t.name||'')}"></label><label class="field wide"><span>备注</span><textarea class="input" name="note">${e(t.note||'')}</textarea></label>${id?`<label class="check-label"><input type="checkbox" name="enabled" ${enabled(t)?'checked':''}>启用目标</label>`:'<p class="helper">新增目标默认启用，保存后可调整。</p>'}</div>`,async data=>{await client.api('/api/models'+(id?'/'+id:''),id?'PUT':'POST',{name:data.get('name'),note:data.get('note'),...(id?{enabled:data.has('enabled')}:{})});await refreshCatalogue();toast('目标 AI 已保存');});
}
async function refreshCatalogue() {
  const b=await client.api('/api/workbench/bootstrap');client.state.bootstrap={...client.state.bootstrap,...b};client.state.clients=b.clients||client.state.clients;client.state.conversations=b.conversations||client.state.conversations;await reloadConfig();client.emit();
}
function editRisk(id) {
  const r=client.state.config?.risks?.find(x=>String(x.id)===String(id))||{level:'高',category:'通用风控',item:'',tip:'',platform_id:null};
  dialog(id?'编辑风险点':'添加风险点',`<div class="form-grid"><label class="field"><span>风险等级</span><select name="level">${['高','中','低'].map(v=>`<option ${r.level===v?'selected':''}>${v}</option>`).join('')}</select></label><label class="field"><span>适用平台</span><select name="platform_id"><option value="">全平台通用</option>${client.platforms.map(p=>`<option value="${p.id}" ${p.id===r.platform_id?'selected':''}>${e(p.name)}</option>`).join('')}</select></label><label class="field wide"><span>类型</span><input type="text" name="category" value="${e(r.category)}"></label><label class="field wide"><span>风险点</span><textarea class="input" name="item" required>${e(r.item)}</textarea></label><label class="field wide"><span>规避建议</span><textarea class="input" name="tip">${e(r.tip)}</textarea></label></div>`,async data=>{await client.api('/api/risks'+(id?'/'+id:''),id?'PUT':'POST',{...Object.fromEntries(data),platform_id:data.get('platform_id')?Number(data.get('platform_id')):null});await reloadConfig();toast('风险配置已保存');});
}
function deleteRisk(id) { dialog('删除风险点','<p class="helper">此操作修改后续写作使用的风险配置，当前在途任务沿用启动快照。</p>',async()=>{await client.api('/api/risks/'+id,'DELETE',{});await reloadConfig();},{label:'删除此风险点'}); }

document.addEventListener('click', event => {
  const settingsNav=event.target.closest('[data-settings-section]');if(settingsNav){event.preventDefault();openSettings(settingsNav.dataset.settingsSection);return;}
  for(const menu of $$('.toolbar-menu[open]'))if(!menu.contains(event.target))menu.open=false;
  const exportPick=event.target.closest('[data-export-pick]');
  if(exportPick){for(const input of $$('input[name="ids"]',modal))input.checked=exportPick.dataset.exportPick==='all';rememberExportSelection();return;}
  const evidence=event.target.closest('[data-editorial-source]');
  if(evidence){
    const source=$(`[data-editorial-document="${evidence.dataset.editorialSource}"]`,$('#inspector-body'));
    if(source){source.closest('[data-editorial-sources]').open=true;source.open=true;$('summary',source).focus();source.scrollIntoView({block:'nearest'});}
    return;
  }
  const taskState=event.target.closest('[data-task-state]');
  if(taskState){event.preventDefault();act(()=>changeTaskState(taskState));return;}
  const actionButton=event.target.closest('[data-action]');
  if(actionButton) {
    const action=actionButton.dataset.action;
    const actions={
      collapse:()=>client.setUI({collapsed:!client.state.ui.collapsed}),
      standard:()=>openCreationEntry('start'),customers:()=>openCustomersArea(),'open-quick-batch':()=>openCustomersArea(actionButton.dataset.batchId),
      'start-page':()=>openCreationEntry('start'),'new-task':()=>openCreationEntry('new'),'choose-client':()=>openCreationEntry('new'),
      'new-client':openCustomerImport,'add-customer':openCustomerSetup,profile:profileDialog,
      'find-task':()=>findTask(),quick:openQuickCreation,
      'mode-chat':()=>switchMode('chat'),'mode-zip':()=>switchMode('zip'),platforms:platformDialog,upload,paste,library,
      'recognize-document':()=>openTaskRecognition(actionButton.dataset.recognitionId),
      'reset-task-formats':()=>{
        const id = actionButton.dataset.platformId, platform = client.platforms.find(p => String(p.id) === id);
        client.setOptions({format_overrides:{...client.state.options.format_overrides,[id]:[...platform.formats]}});
      },
      sources:()=>{panel=panel==='sources'?null:'sources';render();},arrangement:()=>{panel=panel==='arrangement'?null:'arrangement';render();},review:()=>{panel=['review','versions','editorial'].includes(panel)?null:'review';render();},'show-review':()=>{panel='review';render();},settings:()=>{panel=null;render();openSettings();},'close-panel':()=>{panel=null;render();},
      compose:()=>{if(customerArea&&classicEnabled()){enterClassic();return;}customers.leave();customerArea=false;history.replaceState(null,'',location.pathname+(client.state.conversation?`?conversation=${encodeURIComponent(client.state.conversation.id)}`:''));surface='compose';step=1;render();},articles:()=>{surface='articles';step=4;showDraft('article');render();},live:()=>{surface='live';step=3;showDraft('live');render();},
      'open-draft':()=>{showDraft(client.activeJob?'live':'article');render();},'close-draft':()=>{draftPanelState().open=false;client.persist();render();$('.reopen-draft')?.focus();},'follow-stream':()=>{const scroll=$('#stream-scroll');if(scroll){scroll.dataset.follow='true';restoreReadingScroll(scroll,scroll.scrollHeight);$('.new-content').hidden=true;}},
      'step-1':()=>setStep(1),'step-2':()=>setStep(2),'step-4':()=>setStep(4),
      'add-keyword':addKeyword,'detect-aliases':detectAliases,'edit-keyword-links':editKeywordLinks,'narrated-from-materials':openMaterialsVideo,
      'recommend-topic':recommendChatTopic,'clear-writing-topic':()=>{client.setWritingTopic('');$('[data-action="recommend-topic"]')?.focus();},
      start:()=>requestWriting(),'write-one':()=>requestWriting(true),stop:async()=>{await client.stop();toast('已请求暂停后续，当前篇继续收尾');},'confirm-plan':()=>confirmPlan(),'new-requirement':newRequirement,
      'clone-task':()=>reuseTask(),'delete-task':deleteTaskDialog,
      'native-regenerate':()=>nativeActionDialog('regenerate'),'native-audit':()=>nativeActionDialog('audit'),'delete-article':deleteArticleDialog,
      interview:()=>interview(),'chat-candidate':()=>compareDialog(Number(actionButton.dataset.articleId),Number(actionButton.dataset.candidateVersion)),
      'dismiss-message-error':()=>{client.setMessageError('');render();},'dismiss-error':()=>{client.state.error='';render();},recover:async()=>{await client.reload();client.state.error='';client.resumeBackground();render();},
      'edit-article':()=>beginEdit(currentArticle()),'save-article':saveArticle,'end-edit':endEdit,
      versions:async()=>{panel='versions';render();await loadVersions();},'load-versions':loadVersions,'version-preview':()=>compareDialog(currentArticle().id,Number(actionButton.dataset.version)),
      'version-select':async()=>{const a=currentArticle();if(localEditor(a)?.dirty)throw new Error('请先保存人工编辑，再恢复或采用版本');await client.selectVersion(a.id,Number(actionButton.dataset.version));await loadVersions();toast('已采用所选版本');},
      'run-review':()=>articleOperation('style-review'),rewrite:()=>articleOperation('style-rewrite'),revise:()=>articleOperation('revise'),'open-candidate':()=>compareDialog(currentArticle().id,reviewFor(currentArticle()).candidate),
      'accept-expression':acceptedExpressionDialog,'article-editorial':()=>openEditorial(),
      'version-editorial':()=>openEditorial(Number(actionButton.dataset.version)),
      'reload-editorial':()=>{const a=currentArticle();editorialCache.delete(editorialKey(a,editorialVersion(a)));render();},
      'locate-fact':()=>locateFact(Number(actionButton.dataset.issue)),
      'repair-facts':()=>repairFacts(Number(actionButton.dataset.issue)),
      'adopt-fact-repair':async()=>{
        const a=currentArticle();
        if(localEditor(a)?.dirty)throw new Error('请先保存人工编辑，再采用修订');
        const version=Number(actionButton.dataset.version);
        await client.selectVersion(a.id,version);versionsData[a.id]=null;toast('已采用修订');
      },
      export:exportDialog,'reload-config':reloadConfig,'save-settings':saveSettings,'config-admin':configAdmin,'add-platform':()=>editPlatform(null),'add-target':()=>editTarget(null),'add-risk':()=>editRisk(null),
      'provider-models':()=>refreshWorkBuddyModels(actionButton),
    };
    if(actions[action]){event.preventDefault();act(actions[action]);const menu=actionButton.closest('.toolbar-menu');if(menu)menu.open=false;}
    return;
  }
  const task=event.target.closest('[data-task]'); if(task){event.preventDefault();act(()=>openStandardTask(task.dataset.task,task.dataset.guideIntent));return;}
  const doc=event.target.closest('[data-doc]');if(doc)showDocument(doc.dataset.doc);
  const answer=event.target.closest('[data-answer]');if(answer){client.setMessageDraft(answer.dataset.answerText);act(()=>interview());}
  const prompt=event.target.closest('[data-prompt]');if(prompt){const texts=['根据已选客户资料，介绍产品或服务的特点、适用对象与使用条件。','围绕资料中的产品或服务，解答目标读者关心的常见问题。','根据客户资料，介绍公司与品牌、产品或服务的真实业务关系。'];client.setMessageDraft(texts[Number(prompt.dataset.prompt)]);$('#message-input').value=client.messageDraft();$('#message-input').focus();fitMessageInput(true);}
  const stepButton=event.target.closest('[data-step]');if(stepButton)act(()=>setStep(Number(stepButton.dataset.step)));
  const article=event.target.closest('[data-select-article]');if(article){act(()=>selectArticle(Number(article.dataset.selectArticle)));}
  const stop=event.target.closest('[data-stop-operation]');if(stop)act(()=>client.stopOperation(stop.dataset.stopOperation));
  const risk=event.target.closest('[data-edit-risk]');if(risk)editRisk(risk.dataset.editRisk);
  const delRisk=event.target.closest('[data-delete-risk]');if(delRisk)deleteRisk(delRisk.dataset.deleteRisk);
  const platform=event.target.closest('[data-edit-platform]');if(platform)editPlatform(platform.dataset.editPlatform);
  const target=event.target.closest('[data-edit-target]');if(target)editTarget(target.dataset.editTarget);
  const removeTarget=event.target.closest('[data-remove-target]');if(removeTarget)client.setOptions({models:client.state.options.models.filter(name=>name!==removeTarget.dataset.removeTarget)});
  const deletePlatform=event.target.closest('[data-delete-platform]');if(deletePlatform)deleteCatalogue('platforms',deletePlatform.dataset.deletePlatform);
  const deleteTarget=event.target.closest('[data-delete-target]');if(deleteTarget)deleteCatalogue('models',deleteTarget.dataset.deleteTarget);
  const rival=event.target.closest('[data-remove-rival]');if(rival)client.setOptions({rivals:client.state.options.rivals.filter((_,index)=>index!==Number(rival.dataset.removeRival))});
});
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.dataset.taskCount){
    const platform = client.platforms.find(p => String(p.id) === el.dataset.taskCount);
    try {
      const options = setCount(client.state.options,platform.id,el.dataset.account,el.value);
      if (!hasTaskPlatform(options,platform.id)) options.format_overrides = {...options.format_overrides,[platform.id]:[...platform.formats]};
      client.setOptions({selections:options.selections,format_overrides:options.format_overrides});
    } catch(error) { client.fail(error); }
    return;
  }
  if(el.id==='message-input'){client.setMessageDraft(el.value);$('.composer-error')?.remove();fitMessageInput(true);}
  else if(el.dataset.option)client.setOptions({[el.dataset.option]:['keywords','rivals'].includes(el.dataset.option)?splitWords(el.value):el.value});
  else if(el.id==='option-aliases')client.setOptions({aliases:el.value.split(/\n/).map(splitWords).filter(g=>g.length>1)});
  else if(['article-title','article-body','article-tags','article-decl'].includes(el.id)){
    const a=currentArticle(),ed=localEditor(a);if(!ed||a.locked||savingEditors.has(editorKey(a)))return;
    const firstChange = !ed.dirty;
    ed[({'article-title':'title','article-body':'body','article-tags':'tags','article-decl':'decl'})[el.id]]=el.value;
    ed.dirty=true;client.persist();
    if(firstChange)render();
    else $('#article-word-count').textContent = articleWordCount(editedBody(a,ed));
  }
  else if(el.id==='chat-reply'){client.state.ui.reply=el.value;client.persist();}
  else if(el.id==='revise-instruction'){client.setArticleDraft(currentArticle().id,{instruction:el.value});}
  else if(el.id==='rewrite-material'){clearReviewValidation();storeReviewDraft();}
});
document.addEventListener('change',event=>{
  if(event.target.matches('[name="writing-source"],#setting-api-provider')){
    syncWritingSource(event.target.id === 'setting-api-provider');
    return;
  }
  if(event.target.matches('[data-workbench-palette-select]')){
    setWorkbenchPalette(event.target.value);
    return;
  }
  if(event.target.matches('[data-classic-view-toggle]')){
    const toggle=event.target,enabled=toggle.checked;
    toggle.disabled=true;
    act(async()=>{try {
      if(client.state.dirty&&client.state.conversation)await client.saveDraft();
      setClassicEnabled(enabled);
      if(enabled)enterClassic();
    } finally {toggle.disabled=false;toggle.checked=classicEnabled();}});
    return;
  }
  if(event.target.matches('[data-paper-motion-toggle]')){setPaperMotionEnabled(event.target.checked);return;}
  if(event.target.id==='message-target'){draftPanelState().target=event.target.value;client.persist();render();return;}
  const el=event.target;
  if(el.dataset.keywordChoice!=null){client.toggleKeyword(el.dataset.keywordChoice,el.checked);return;}
  if(el.dataset.docChoice){
    const id=el.dataset.docChoice;
    const doc=taskDocumentChoices().find(item=>String(item.id)===id);
    if(!doc)return;
    const replaced=new Set(selectedDocs().filter(item=>doc.group_id && item.group_id===doc.group_id).map(item=>String(item.id)));
    const ids=client.state.documentIds.filter(value=>el.checked ? !replaced.has(String(value)) : String(value)!==id);
    client.selectDocuments(el.checked ? [...ids,doc.id] : ids);
    return;
  }
  if(el.name==='ids'&&modal.contains(el))rememberExportSelection();
  if (event.target.matches('select[data-font-size]')) { changeFontSize(event.target, client); return; }
  if(el.dataset.taskFormat){const formats=$$('[data-task-format]').filter(x=>x.dataset.taskFormat===el.dataset.taskFormat&&x.checked).map(x=>x.value);if(!formats.length){el.checked=true;toast('每个平台至少保留一种形态');return;}client.setOptions({format_overrides:{...client.state.options.format_overrides,[el.dataset.taskFormat]:formats}});}
  if(el.dataset.target){const models=client.state.options.models.filter(m=>m!==el.dataset.target);if(el.checked)models.push(el.dataset.target);client.setOptions({models});}
  if(el.id==='followup-enabled')client.setUI({followup:el.checked});
  if(el.dataset.suggestion){if(el.checked)selectedSuggestions.add(el.dataset.suggestion);else selectedSuggestions.delete(el.dataset.suggestion);clearReviewValidation();storeReviewDraft();}
  if(el.id==='rewrite-mode'){rewriteMode=el.value;storeReviewDraft();}
  if(el.dataset.materialChoice){el.value==='conservative'?conservativeSuggestions.add(el.dataset.materialChoice):conservativeSuggestions.delete(el.dataset.materialChoice);clearReviewValidation();storeReviewDraft();}
  if(el.dataset.prefModel)act(async()=>{await client.api('/api/prefs','POST',{model_id:Number(el.dataset.prefModel),platform_id:Number(el.dataset.prefPlatform),level:el.value});const prefs=client.state.config.prefs||client.state.config.preferences||[];const pref=prefs.find(p=>String(p.model_id)===el.dataset.prefModel&&String(p.platform_id)===el.dataset.prefPlatform);if(pref)pref.level=el.value;else prefs.push({model_id:Number(el.dataset.prefModel),platform_id:Number(el.dataset.prefPlatform),level:el.value});toast('抓取偏好已保存');});
});
const modePath = value => value === 'zip' ? '/workbench/zip/index.html' : '/workbench/index.html';
function setModeChrome(value) {
  mode = value;
  document.body.dataset.mode = mode;
  document.title = (mode==='zip'?'分步创作':'对话创作')+' · 方立';
}
function syncTaskMode() {
  const saved = client.state.conversation?.mode;
  if (saved !== 'chat' && saved !== 'zip') return;
  if (saved !== mode) setModeChrome(saved);
  const path = modePath(saved);
  if (location.pathname !== path) history.replaceState(history.state,'',path+location.search+location.hash);
}
function applyMode(nextMode) {
  modeViews.set(mode,{step,surface,following:captureFollowing($('#root')),
    scrolls:['#workspace','.chat-pane','#article-scroll'].map(selector=>[selector,$(selector)?.scrollTop||0])});
  const saved=modeViews.get(nextMode)||{step:client.activeJob?3:client.state.articles.length?4:1,
    surface:client.activeJob?'live':client.state.articles.length?'articles':'compose'};
  setModeChrome(nextMode);
  quickArea=customerArea=false;customers.leave();panel=null;
  step=mode==='zip'&&client.activeJob?3:saved.step;surface=client.activeJob?'live':saved.surface;
  const path=modePath(mode);
  history.replaceState(history.state,'',path+(client.state.conversation?`?conversation=${encodeURIComponent(client.state.conversation.id)}`:''));
  render();
  for(const [selector,top] of saved.scrolls||[])if($(selector))restoreReadingScroll($(selector),top);
  restoreFollowing($('#root'),saved.following||[]);
}
async function switchMode(nextMode) {
  if (standardEntry() === 'new') {
    if (!creatingTask && nextMode !== entryMode) {
      entryMode = nextMode;
      render();
    }
    return;
  }
  return modeSwitcher.select(nextMode,{force:customerArea});
}
async function setStep(next) {
  if(![1,2,3,4].includes(next))return;
  if(next===step){
    if(panel==='arrangement'){panel=null;render();}
    return;
  }
  const request=++stepGeneration,task=client.state.conversation?.id;
  if(client.state.conversation&&client.state.dirty)await client.saveDraft();
  if(request!==stepGeneration||task!==client.state.conversation?.id||mode!=='zip')return;
  if(panel==='arrangement')panel=null;
  step=next;surface=next===4?'articles':next===3?'live':'compose';render();$('#workspace')?.scrollTo(0,0);
}
function bindResize() {
  const resizer=$('#sidebar-resizer');if(!resizer)return;
  const setWidth=width=>{client.state.ui.sidebarWidth=Math.round(Math.max(190,Math.min(380,width)));document.documentElement.style.setProperty('--sidebar',`${client.state.ui.sidebarWidth}px`);resizer.setAttribute('aria-valuenow',client.state.ui.sidebarWidth);};
  resizer.onpointerdown=event=>{if(event.button!==0)return;const start=event.clientX,width=client.state.ui.sidebarWidth;resizer.setPointerCapture(event.pointerId);document.body.classList.add('dragging');resizer.onpointermove=e=>setWidth(width+e.clientX-start);};
  resizer.onpointerup=resizer.onpointercancel=()=>{resizer.onpointermove=null;document.body.classList.remove('dragging');client.persist();};
  resizer.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setWidth(client.state.ui.sidebarWidth+(event.key==='ArrowLeft'?-10:10));client.persist();}};
}
let inspectorContainer;
const inspectorObserver = new ResizeObserver(() => updateInspectorSize());
function inspectorBounds(container) {
  const width = container.clientWidth;
  const max = Math.max(1,Math.min(720,width < 880 ? width - 24 : width - 560));
  return [Math.min(320,max),max];
}
function updateInspectorSize() {
  const handle = $('#inspector-resizer');
  if (!handle) return;
  const [min,max] = inspectorBounds(inspectorContainer);
  handle.setAttribute('aria-valuemin',min);
  handle.setAttribute('aria-valuemax',max);
  handle.setAttribute('aria-valuenow',Math.round(handle.parentElement.getBoundingClientRect().width));
}
function bindInspectorResize() {
  const container = $('.content-wrap'), handle = $('#inspector-resizer');
  if (container !== inspectorContainer) {
    inspectorObserver.disconnect();
    inspectorContainer = container;
    inspectorObserver.observe(container);
  }
  if (!handle) return;
  const width = () => handle.parentElement.getBoundingClientRect().width;
  const set = value => {
    const [min,max] = inspectorBounds(container);
    const next = Math.round(Math.max(min,Math.min(max,value)));
    client.state.ui.inspectorWidth = next;
    document.documentElement.style.setProperty('--inspector-width',`${next}px`);
    updateInspectorSize();
  };
  document.documentElement.style.setProperty('--inspector-width',`${client.state.ui.inspectorWidth || 420}px`);
  updateInspectorSize();
  handle.onpointerdown=event=>{if(event.button!==0)return;const start=event.clientX,initial=width();handle.setPointerCapture(event.pointerId);handle.onpointermove=e=>set(initial+start-e.clientX);};
  handle.onpointerup=handle.onpointercancel=()=>{handle.onpointermove=null;client.persist();};
  handle.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const [min,max]=inspectorBounds(container);set(event.key==='Home'?min:event.key==='End'?max:width()+(event.key==='ArrowLeft'?20:-20));client.persist();}};
}
function hideTooltip(){clearTimeout(tooltipTimer);$('#task-tooltip').hidden=true;}
function showTooltip(button) {
  clearTimeout(tooltipTimer);tooltipTimer=setTimeout(()=>{const t=client.state.conversations.find(x=>x.id===button.dataset.task);if(!t)return;const box=$('#task-tooltip'),rect=button.getBoundingClientRect();box.innerHTML=`<strong>${e(displayTaskTitle(t))}</strong><dl class="plain-dl"><div><dt>创建时间</dt><dd>${e(t.created_at||'未记录')}</dd></div><div><dt>状态</dt><dd>${statusText(t.status)}</dd></div><div><dt>客户</dt><dd>${e(client.state.clients.find(c=>c.id===t.client_id)?.name||'')}</dd></div></dl>`;box.hidden=false;box.style.left=`${Math.min(rect.right+12,innerWidth-box.offsetWidth-12)}px`;box.style.top=`${Math.max(12,Math.min(rect.top,innerHeight-box.offsetHeight-12))}px`;},320);
}
document.addEventListener('pointerover',event=>{const row=event.target.closest('.task-row');if(row)showTooltip(row);});
document.addEventListener('pointerout',event=>{if(event.target.closest('.task-row'))hideTooltip();});
document.addEventListener('focusin',event=>{const row=event.target.closest('.task-row');if(row)showTooltip(row);});
document.addEventListener('focusout',hideTooltip);
document.addEventListener('keydown',event=>{
  if(event.target.id==='message-input'&&event.key==='Enter'&&!event.isComposing){
    event.preventDefault();event.stopPropagation();
    const input=event.target;if(input.readOnly||input.disabled)return;
    if(event.shiftKey){input.setRangeText('\n',input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input',{bubbles:true}));}
    else if(!operationBusy&&!isOperationRunning())act(()=>interview());
    return;
  }
  if(event.target.id==='keyword-entry'&&event.key==='Enter'&&!event.isComposing){event.preventDefault();addKeyword();}
  if(event.target.matches('.article-tab[role=tab]')&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
    event.preventDefault();const list=client.state.articles,index=list.findIndex(a=>a.id===selectedId);
    const next=event.key==='Home'?0:event.key==='End'?list.length-1:(index+(event.key==='ArrowLeft'?-1:1)+list.length)%list.length;
    act(()=>selectArticle(list[next].id));$(`#article-tab-${selectedId}`)?.focus();
  }
  if(event.key==='Escape'){hideTooltip();const menu=$('.toolbar-menu[open]');if(!modal.open&&menu){menu.open=false;$('summary',menu).focus();event.preventDefault();return;}if(!modal.open&&panel){panel=null;render();}}
  if((event.ctrlKey||event.metaKey)&&event.key==='s'&&localEditor(currentArticle()||{})){event.preventDefault();act(saveArticle);}
});
document.addEventListener('dragover',event=>{if(![...(event.dataTransfer?.types||[])].includes('Files'))return;event.preventDefault();event.target.closest('[data-dropzone]')?.classList.add('drop-over');});
document.addEventListener('dragleave',event=>{const zone=event.target.closest('[data-dropzone]');if(zone&&!zone.contains(event.relatedTarget))zone.classList.remove('drop-over');});
document.addEventListener('drop',event=>{if(!event.dataTransfer?.files.length)return;event.preventDefault();const zone=event.target.closest('[data-dropzone]');$$('.drop-over').forEach(el=>el.classList.remove('drop-over'));if(!zone){toast('请把文件拖入客户资料区');return;}if(importing){toast('正在处理上一批文件，请稍候');return;}act(()=>uploadFiles([...event.dataTransfer.files]));});
window.addEventListener('resize',()=>{bindInspectorResize();fitMessageInput();setupLiveUI($('#root'),{persist:()=>client.persist(),ui:client.state.ui});});
const elapsedTimer=setInterval(()=>{if(!document.hidden)tickElapsed();},1000);
window.addEventListener('pagehide',()=>clearInterval(elapsedTimer));
window.addEventListener('pagehide',()=>taskPresentation.dispose());
window.addEventListener('pagehide',()=>{quick.dispose();customers.dispose();clearTimeout(aliasTimer);client.persist();client.dispose();});
window.matchMedia('(max-width:760px)').addEventListener('change',event=>{if(event.matches)client.setUI({collapsed:true});});
window.addEventListener('beforeunload',event=>{if(!intentionalNavigation&&(client.state.dirty||Object.values(client.state.editors).some(ed=>ed.dirty))){event.preventDefault();event.returnValue='';}});
await client.boot(entryView === 'new' ? null : initialRoute.get('conversation'), {resumeCached:false}).catch(()=>{});
if (quickArea && client.state.bootstrap) {
  const currentClientId = client.state.conversation?.client_id;
  const legacyClients = [...initialRoute.getAll('clients'), ...initialRoute.getAll('client')];
  const clientIds = legacyClients.length ? legacyClients : currentClientId ? [currentClientId] : [];
  await quick.enter({clientIds,batchId:initialRoute.get('batch')}).catch(error=>toast(error.message));
}
if(customerArea&&client.state.bootstrap){
  try {
    await customers.enter();
    const query = new URLSearchParams(location.search);
    if (query.get('batch')) await customers.showBatch(await customers.service.batch(query.get('batch')));
    else if (query.get('customer')) await customers.detail(query.get('customer'),query.get('tab'));
    else if (query.get('plan')) await customers.detail(query.get('plan'),'plan');
  } catch (error) { toast(error.message); }
}
if(innerWidth<=760)client.setUI({collapsed:true});
if(client.state.bootstrap){
  const entry=new URLSearchParams(location.search).get('entry');
  if(['tasks','review','export','settings'].includes(entry)){
    const url=new URL(location.href);url.searchParams.delete('entry');history.replaceState(null,'',url.pathname+url.search+url.hash);
    if(entry==='settings'){
      if(classicSettingsVisit){
        modal.addEventListener('close',()=>{if(classicEnabled())enterClassic();else delete document.documentElement.dataset.classicSettings;},{once:true});
      }
      openSettings(classicSettingsVisit?'appearance':'writing');
    }else findTask(entry==='tasks'?'':entry);
  }
}
