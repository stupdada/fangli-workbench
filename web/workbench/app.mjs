import { activityMarkup, liveMarkup, reconcile, setupLiveUI, tickElapsed, captureFollowing, restoreFollowing } from './live-workspace.mjs';
import { remainingCount } from './live-model.mjs';
import { WorkbenchClient } from './client.mjs';
import { PROFILE_FIELDS, clone, enabled, running, accountName, splitWords, normalizeOptions, selectionCounts, setCount,
  togglePlatform, planSummary, optionIssues, escapeHTML as e, markdown, articleBody, valueText, selfCheck, OPERATION_KIND,latestOperation,reviewDefaults,reviewSelection,interviewMessageText } from './model.mjs';
import { CustomersWorkspace } from './customers.mjs';
import { CustomerClient, importCustomerFile } from './customers-client.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const mode = document.body.dataset.mode;
const client = new WorkbenchClient();
const customerService = new CustomerClient(client.api.bind(client));
let pendingChat=null;
let customerArea = new URLSearchParams(location.search).get('area') === 'customers', wasWriting = false;
const paths = {
  logo: '<circle cx="12" cy="12" r="10"/><path d="M8.5 18V6h9M8.5 12h6M13 18h3"/>',
  menu: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6"/>',
  edit: '<path d="m16 3 5 5M4 20l4-1L21 6a2 2 0 0 0-5-3L3 16l-1 6z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  library: '<path d="M4 4h16v16H4zM4 9h16M9 9v11M7 6.5h.1M10 6.5h.1"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  settings: '<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
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
// 逐项展示原 ZIP geo_check 的 results；本视图跟随本轮远程取向，不展示总分。
function selfCheckMarkup(a) {
  const check = selfCheck(a);
  if (!check.rated) return '';
  const passed = check.total - check.failed.length;
  return `<p class="helper">${check.total} 项中 ${passed} 项通过${check.chars ? ` · ${check.chars.toLocaleString('zh-CN')} 字` : ''}</p><ul class="selfcheck-list">${check.checks.map(item => `<li class="${item.ok ? 'pass' : 'fail'}"><span class="ck" aria-hidden="true">${item.ok ? '✓' : '!'}</span><span class="ct"><strong>${e(item.name)}</strong>${item.ok ? '' : `<span class="hint">${e(item.hint || '这一项未通过，请按平台规则调整。')}</span>`}</span></li>`).join('')}</ul>`;
}
function nativeArticleInfo(a) {
  if(!a)return '';
  const rows=[['写作角度',a.angle],['关键词',(a.keywords||[]).join('、')||a.keyword],['标签',(a.tags||[]).join('、')],['声明',(a.decl||[]).join('、')]];
  return `<details id="native-article-info"><summary>ZIP 稿件信息与检查</summary><dl class="plain-dl">${rows.filter(([,value])=>value).map(([key,value])=>`<div><dt>${key}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>${a.risk_tips?.length?`<h3>风险提示</h3>${a.risk_tips.map(t=>`<p>${e(valueText(t))}</p>`).join('')}`:''}${a.audit&&Object.keys(a.audit).length?`<h3>原生核查</h3>${factMarkup(a.audit)}`:''}${a.geo&&Object.keys(a.geo).length?`<h3>具体检查项</h3>${selfCheckMarkup(a)}<details id="native-selfcheck-raw"><summary>查看原始检查返回</summary><pre class="diff-text">${e(valueText(checksOnly(a.geo)))}</pre></details>`:''}</details>`;
}
let panel = null, surface = 'compose', step = 1, selectedId = null, composing = false, renderPending = false;
let selectedSuggestions = new Set(),conservativeSuggestions=new Set(),reviewError='',selectedReviewId=null, rewriteMode = 'full', reviews = {}, versionsData = {}, modalSubmit = null, lastTask = null;
let tooltipTimer, toastTimer, importing = false, operationBusy = false, lastFocus, lastFocusAction, intentionalNavigation = false;
let settingsSession=null, renderParts=new Map(), lastInspectorKey='', renderedArticleId=null;
let aliasTimer, aliasState = { key: '', groups: [], status: 'idle' };
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
  $('#modal-title').textContent = title; $('#modal-body').innerHTML = html; $('#modal-error').textContent = '';
  $('#modal-submit').disabled=false;$('#modal-submit').textContent = label; $('#modal-submit').hidden = !submit; modalSubmit = submit;
  if (!modal.open) modal.showModal();
}
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 4200); }
function findTask(intent='') {
  const titles={review:'选择要审阅的任务',export:'选择要导出的任务'};
  dialog(titles[intent]||'查找任务',`<label class="field"><span>任务标题</span><input type="search" id="task-search" placeholder="输入标题关键词"></label><div id="task-search-results" class="library-list">${client.state.conversations.map(t=>`<button type="button" class="task-row" data-task="${e(t.id)}" data-guide-intent="${e(intent)}">${e(t.title||'未命名内容')}</button>`).join('')||'<p class="empty">还没有已保存任务。创建内容并保存稿件后，可以从这里继续。</p>'}</div>`,null);
  $('#task-search').oninput=event=>{$$('[data-task]',$('#task-search-results')).forEach(b=>b.hidden=!b.textContent.toLowerCase().includes(event.target.value.toLowerCase()));};
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
  catch (error) { if(error.status===400){if(error.operationKind===OPERATION_KIND.chat){client.setMessageError(error.message,error.conversationId);if(client.state.conversation?.id===error.conversationId){surface='compose';render();}}else if(panel==='review'){reviewError=error.message;render();if(/素材/.test(error.message))$('#rewrite-material')?.focus();}else if(mode==='chat'&&/关键词|平台|安排/.test(error.message)){panel='sources';render();}if(error.operationKind!==OPERATION_KIND.chat)toast(error.message);}else{client.fail(error);toast(error.message);} }
}
function currentClient() { const c=client.state.clients.find(c=>c.id===client.state.conversation?.client_id);if(!c)return null;const o=client.state.options;return {...c,name:o.client??'',profile:Object.fromEntries(PROFILE_FIELDS.filter(([key])=>key!=='name').map(([key])=>[key,o[key]??'']))}; }
function moreMenu(id,label,items) { return `<details class="toolbar-menu" id="${id}"><summary class="icon-button" aria-label="${label}" title="${label}">${icon('more')}</summary><div class="menu-items">${items}</div></details>`; }
function readingBody(article) {
  const lines=articleBody(article).split(/\r?\n/);
  if(/^#\s+/.test(lines[0]||'')&&lines[0].replace(/^#\s+/,'').trim()===article.title?.trim())lines.shift();
  return lines.join('\n');
}
function currentArticle() { return client.article(selectedId) || client.state.articles[0]; }
function editorKey(a) { return `${client.state.conversation?.id}:${a.id}`; }
function localEditor(a) { return client.state.editors[editorKey(a)]; }
function isOperationRunning() { return client.state.operations.some(o => running(o) && o.kind!==OPERATION_KIND.writing); }
function reviewFor(a) {
  if (reviews[a.id]) return reviews[a.id];
  const op = latestOperation(client.state.operations,OPERATION_KIND.review,a.id);
  const rewrite=latestOperation(client.state.operations,OPERATION_KIND.rewrite,a.id);
  return op ? { ...op.result, operation_id: op.id,...(rewrite?.result.base_version===op.result.base_version?{candidate:rewrite.result.candidate_version}:{}) } : null;
}

function sidebar(s) {
  const tasks = s.conversations;
  return `<aside class="sidebar" aria-label="任务导航"><div class="side-head"><a class="brand-link" href="/guide/index.html">${icon('logo')}<span>方立</span></a><button class="icon-button" id="sidebar-toggle" data-action="collapse" aria-label="${s.ui.collapsed ? '展开' : '折叠'}侧栏" aria-expanded="${!s.ui.collapsed}">${icon('menu')}</button></div>
    <nav class="nav"><button class="nav-button" data-action="new-task" title="新建内容">${icon('plus')}<span class="nav-text">新建内容</span></button><button class="nav-button" data-action="find-task" title="查找任务">${icon('search')}<span class="nav-text">查找任务</span></button><button class="nav-button" data-action="customers" title="客户">${icon('library')}<span class="nav-text">客户</span></button><a class="nav-button" href="/video/" title="独立视频工作区">${icon('video')}<span class="nav-text">视频工作区</span></a></nav>
    <div class="recent" id="recent"><h2>最近任务</h2>${tasks.length ? tasks.map(t => `<button class="task-row ${!customerArea && t.id === s.conversation?.id ? 'active' : ''}" data-task="${e(t.id)}" aria-describedby="task-tooltip">${e(t.title || '未命名内容')}</button>`).join('') : '<p class="empty-tasks">从一份资料开始。<br>创建后，任务会保存在这里。</p>'}</div>
    <a class="nav-button" href="/guide/index.html" title="使用指南">${icon('file')}<span class="nav-text">使用指南</span></a>
    <div class="side-foot"><span class="local-avatar">方</span><span class="account">本机工作区</span>${iconButton('settings', '工作台设置', 'settings')}</div>
    <div class="resizer" id="sidebar-resizer" role="separator" aria-label="调整任务侧栏宽度" aria-orientation="vertical" tabindex="0" aria-valuemin="190" aria-valuemax="380" aria-valuenow="${s.ui.sidebarWidth}"></div></aside>`;
}
function topbar(s) {
  if(customerArea)return `<header class="topbar"><div class="task-heading"><strong>客户</strong><span class="save-status">档案、资料、常用方案与批次</span></div>${button('compose','返回创作',null,'quiet')}</header>`;
  const a = currentArticle();
  return `<header class="topbar"><div class="task-heading"><strong>${e(s.conversation?.title || '新建内容')}</strong><span class="save-status" role="status">${s.dirty ? '草稿待保存' : s.saved ? '草稿已保存' : s.conversation ? '已从后台恢复' : '先选择客户，开始本次创作'}</span></div>
    <div class="mode-switch" role="group" aria-label="创作方式"><button data-action="mode-chat" class="${mode === 'chat' ? 'active' : ''}" aria-pressed="${mode === 'chat'}">对话创作</button><button data-action="mode-zip" class="${mode === 'zip' ? 'active' : ''}" aria-pressed="${mode === 'zip'}">分步创作</button></div>
    <div class="top-actions">${button('sources', '<span class="action-label">资料</span>', 'file', 'quiet', false, `aria-expanded="${panel === 'sources'}"`)}${button('review', '<span class="action-label">审阅</span>', 'review', 'quiet', !a, `aria-expanded="${panel === 'review'}"`)}${s.conversation?moreMenu('task-menu','任务更多操作',button('clone-task','复用为新任务',null,'quiet sm',client.activeJob||isOperationRunning())+button('archive-task','下载本地归档',null,'quiet sm',client.activeJob||isOperationRunning())+button('delete-task','删除任务',null,'quiet sm danger',client.activeJob||isOperationRunning())):''}${button('export', '导出', 'download', 'quiet', !s.articles.some(a => !a.locked))}</div></header>`;
}
function notices(s) {
  const issues=optionIssues(s.options,client.platforms,client.targets);
  return `${s.batch?.frozen ? `<div class="notice" role="status"><span>本批安排已冻结，可复用为新任务调整</span>${button('clone-task','复用为新任务',null,'outline sm',client.activeJob||isOperationRunning())}</div>` : ''}${s.bootstrap?.preview ? '<div class="preview-banner">离线接口预览 · 示例操作由本机替身响应 · 真实模型调用 0</div>' : ''}
    ${issues.length?`<div class="notice" role="status"><span>安排待调整：${issues.map(e).join('；')}</span>${button('compose','查看安排',null,'quiet sm')}</div>`:''}
    ${s.error ? `<div class="notice error" role="alert"><span>${e(s.error)}</span>${button('recover', '恢复后台状态', null, 'outline', !s.conversation)}${button('dismiss-error', '关闭提示', null, 'quiet')}</div>` : ''}
    ${s.needsConfirmation ? `<div class="notice"><span>已更新后续要求。${client.activeJob ? '当前篇仍在收尾，后续已请求暂停。' : '确认新的资料、平台与要求后再继续。'}</span>${button('confirm-plan', '确认并继续', null, 'outline', client.activeJob)}${button('compose', '查看要求', null, 'quiet')}</div>` : ''}`;
}
function clientLine() {
  const c = currentClient();
  return `<div class="client-line"><span>本次客户</span>${c ? `<strong>${e(c.name)}</strong>${button('profile', '查看档案', null, 'quiet sm')}` : '<strong>尚未选择</strong>'}${button('choose-client', c ? '切换 / 新建任务' : '选择或创建客户', null, c ? 'quiet sm' : 'outline sm')}</div>`;
}
function docRows(docs, { removable = false } = {}) {
  return docs.length ? docs.map(doc => `<div class="doc-row">${icon('file')}<div class="doc-info"><strong>${e(doc.filename)}</strong><small>${e(doc.kind || '资料')} · ${(doc.text || '').length.toLocaleString()} 字${doc.digest ? ' · 已入库' : ''}</small></div><button class="icon-button" data-doc="${e(doc.id)}" aria-label="查看 ${e(doc.filename)}" title="核对正文">${icon('search')}</button>${removable ? `<button class="icon-button" data-remove-doc="${e(doc.id)}" aria-label="取消选择 ${e(doc.filename)}" title="仅从本次选择移除">${icon('close')}</button>` : ''}</div>`).join('') : '<p class="empty">添加客户资料，开始这次创作。</p>';
}
function selectedDocs() { const docs=new Map([...client.state.documents,...client.state.library].map(d=>[String(d.id),d]));return client.state.documentIds.map(id=>docs.get(String(id))).filter(Boolean); }
function sourceBlock() {
  return `<div class="sources-preview" id="source-dropzone" data-dropzone><div class="spread"><h2 class="section-title">客户资料</h2><div class="inline-actions">${button('upload', '上传文件', 'plus', 'quiet sm', importing)}${button('paste', '粘贴', null, 'quiet sm')}${button('library', '从库中选择', null, 'quiet sm')}</div></div>${docRows(selectedDocs(), { removable: true })}${importing?'<p role="status">正在保存原件并解析…</p>':''}</div>`;
}
function keywordEditor() {
  return `<section class="keyword-editor"><div class="spread"><label class="field" for="keyword-entry"><span>目标搜索关键词</span></label>${button('detect-aliases','别名分组',null,'quiet sm')}</div><div class="reply-row"><input type="text" id="keyword-entry" placeholder="输入关键词，回车添加">${button('add-keyword','添加','plus','outline')}</div><div class="keyword-list">${client.state.options.keywords.map((word,index)=>`<div class="keyword-row"><input type="text" id="keyword-${index}" data-keyword-index="${index}" value="${e(word)}" aria-label="关键词 ${index+1}"><button type="button" class="icon-button" data-remove-keyword="${index}" aria-label="移除关键词 ${e(word)}">${icon('close')}</button></div>`).join('')}</div>${aliasHint()}</section>`;
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
function expandedOptions({ open = false } = {}) {
  const o=client.state.options;
  return `<details class="advanced" id="advanced-options" ${open?'open':''}><summary>本次可选调整</summary><div class="details-content"><div class="form-grid"><label class="field"><span>同现品牌 / 公司 <span title="自家品牌与公司仍按原规则排除。">ⓘ</span></span><textarea class="input" id="option-rivals" data-option="rivals" rows="2">${e((o.rivals||[]).join('\n'))}</textarea></label><label class="field"><span>别名分组 <span title="每行一组，同组用逗号分隔；只在确认后生效。">ⓘ</span></span><textarea class="input" id="option-aliases" rows="2">${e((o.aliases||[]).map(g=>g.join('，')).join('\n'))}</textarea></label></div></div></details>`;
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
  const note={id:crypto.randomUUID(),text,anchor:(s.conversation.messages||[]).filter(m=>m.role!=='system'&&m.role!=='tool').length,articleId:a.id,number:s.articles.findIndex(row=>row.id===a.id)+1};chatRevisionMessages().push(note);
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
  const question=result?.ready?null:result?.questions?.[0],qText=question?.text||question?.question||question?.title,choices=question?.options||[];
  const history=messages.map((m,index)=>`<div data-key="message-${index}" class="message ${m.role==='user'?'user':'assistant'}"><span class="message-label">${m.role==='user'?'你':'方立'}</span><div class="rendered-copy message-copy">${m.role==='user'?e(interviewMessageText(m)):markdown(interviewMessageText(m))}</div></div>${revisionMessagesMarkup(index+1)}`).join('');
  return `<section class="conversation-log" id="conversation-log" aria-label="创作对话">${revisionMessagesMarkup(0)}${history}${pendingChat&&pendingChat.id===s.conversation?.id&&pendingChat.text&&interviewMessageText(messages.at(-1)||{})!==pendingChat.text?`<div class="message user" data-key="pending-message"><span class="message-label">你</span><div class="message-copy">${e(pendingChat.text)}</div></div>`:''}${s.ui.followup&&qText?`<section class="question"><h3>${e(qText)}</h3><div class="question-options">${choices.map((opt,i)=>{const label=typeof opt==='string'?opt:opt.text||opt.label;return `<button data-answer="${i}" data-answer-text="${e(label)}">${e(label)}</button>`;}).join('')}</div></section>`:''}</section>`;
}

function operationRows(kinds=null) {
  return client.state.operations.filter(o => running(o) && o.kind!==OPERATION_KIND.writing&&(!kinds||kinds.includes(o.kind))).map(o => `<div class="operation-row" role="status"><span class="working-dot"></span><span>${e(({ interview:'正在理解需求',style_review:'正在通读审阅',style_rewrite:'正在生成候选并做一次只读复核',revision:'正在生成修改候选',zip_regenerate:'正在整篇重写并核查',zip_audit:'正在核查当前稿，可能修正正文' })[o.kind] || '后台正在处理')}</span><button class="text-button" data-stop-operation="${e(o.id)}">请求本地停止</button></div>`).join('');
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
}
function composeView() {
  const s=client.state,c=currentClient(),target=messageTarget(),hasMessages=!!s.conversation?.messages?.length||client.activeJob||!!s.articles.length||isOperationRunning()||operationBusy,plan=planSummary(s.options,client.platforms).text;
  return `<section class="chat-workbench ${hasMessages?'is-conversation':'is-first'}">${!hasMessages?'<h1>这次想写什么？</h1>':''}<div class="chat-context">${button('choose-client',c?e(c.name):'选择客户','chevron','context-chip')}${button('sources',`资料 ${s.documentIds.length} 份`,'file','context-chip')}${button('sources','本次安排','settings','context-chip')}</div>${chatHistory()}${s.job||s.operations.some(running)?activityMarkup(s,'chat'):''}<div class="chat-compose-area"><div class="composer"><textarea id="message-input" rows="1" aria-label="创作消息" placeholder="${target==='article'?'说说这篇稿件需要怎样修改':'说说这次想写什么'}">${e(client.messageDraft())}</textarea><div class="composer-toolbar">${iconButton('upload','添加资料','plus')}<span class="spacer"></span><button type="button" class="context-chip composer-platform" data-action="platforms" aria-label="平台与篇数：${e(plan)}" title="${e(plan)}">${icon('settings')}<span>${e(plan)}</span></button><button class="send-button" data-action="interview" aria-label="发送消息" ${operationBusy||isOperationRunning()?'disabled':''}>${icon('arrow')}</button></div></div><div class="composer-foot"><div class="composer-followup">${s.articles.some(a=>a.current_version)?`<label class="message-target"><span class="sr-only">本条消息用途</span><select id="message-target" aria-label="本条消息用途"><option value="requirements" ${target==='requirements'?'selected':''} ${s.batch?.frozen?'disabled':''}>调整本次要求</option><option value="article" ${target==='article'?'selected':''} ${client.activeJob?'disabled':''}>修改第 ${s.articles.findIndex(a=>a.id===currentArticle()?.id)+1} 篇</option></select></label>`:''}<label class="check-label" ${target==='article'?'hidden':''}><input type="checkbox" id="followup-enabled" ${s.ui.followup?'checked':''}>追问</label></div><div class="inline-actions">${s.articles.length?button('articles',`查看 ${s.articles.length} 篇稿件`,null,'quiet'):''}${target==='requirements'&&!client.activeJob&&remainingCount(s,client.platforms)>0?button('start','开始写作','right','primary',isOperationRunning()||operationBusy):''}</div></div>${client.messageError()?`<div class="composer-error" role="alert"><span>${e(client.messageError())}</span><div>${button('sources','查看本次安排',null,'quiet sm')}${button('dismiss-message-error','关闭提示',null,'quiet sm')}</div></div>`:''}${!hasMessages?'<div class="prompt-examples chat-suggestions"><button data-prompt="0">介绍产品或服务</button><button data-prompt="1">解答常见问题</button><button data-prompt="2">介绍客户与业务</button></div>':''}</div></section>`;
}
function configBlock(section) {
  const cfg = client.state.config;
  if (!cfg) return `<p class="error-text">${e(client.state.configError || '配置尚未加载')}。${button('reload-config', '加载配置', null, 'quiet sm')}</p>`;
  const prefs = cfg.prefs || cfg.preferences || [], selectedP = client.platforms;
  const models = client.targets;
  const risks = cfg.risks || [];
  const html=`<p class="helper">原 ZIP 的有效抓取偏好与风险配置。调整用于后续写作；后台按启动快照处理在途任务。</p><details id="preference-matrix"><summary>目标 AI × 平台抓取偏好</summary><div class="matrix-scroll"><table class="matrix"><thead><tr><th scope="col">目标 AI</th>${selectedP.map(p => `<th scope="col">${e(p.name)}</th>`).join('')}</tr></thead><tbody>${models.map(m => `<tr><th scope="row">${e(m.name || m)}</th>${selectedP.map(p => { const pref = prefs.find(x => String(x.model_id) === String(m.id) && String(x.platform_id) === String(p.id)); return `<td><select aria-label="${e(m.name)} 对 ${e(p.name)} 的抓取偏好" data-pref-model="${e(m.id)}" data-pref-platform="${e(p.id)}">${[['high','高优先抓取'],['mid','中等抓取'],['low','低抓取']].map(([v,t]) => `<option value="${v}" ${(pref?.level || 'mid') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td>`; }).join('')}</tr>`).join('')}</tbody></table>${!selectedP.length ? '<p class="helper">选择平台后显示对应列。</p>' : ''}</div></details>
    <details id="risk-matrix"><summary>风险清单 · ${risks.length} 条</summary>${risks.filter(r => r.platform_id == null || selectedP.some(p => String(p.id) === String(r.platform_id))).map(r => `<div class="risk-row"><span class="risk-level">${e(r.level)}</span><div class="risk-main"><strong>${e(r.item)}</strong><p>${e(r.category)} · ${e(client.platforms.find(p => p.id === r.platform_id)?.name || '全平台通用')}</p><p>${e(r.tip)}</p></div><div class="risk-actions"><button data-edit-risk="${e(r.id)}">编辑</button><button data-delete-risk="${e(r.id)}">删除</button></div></div>`).join('')}${button('add-risk', '添加风险点', 'plus', 'quiet sm')}</details>
    ${button('config-admin', '管理平台、形态与目标 AI', 'settings', 'quiet sm')}`;
  const template=document.createElement('template');template.innerHTML=html;
  const content=template.content.querySelector(section==='risks'?'#risk-matrix':'#preference-matrix');content.open=true;return content.outerHTML;
}
function stepper() { return `<ol class="stepper" aria-label="分步创作进度">${['资料与关键词','平台安排','生成','编辑与导出'].map((title, i) => `<li class="${step === i + 1 ? 'active' : ''}"><button data-step="${i+1}" ${step === i + 1 ? 'aria-current="step"' : ''}><b>${i+1}</b><span>${title}</span></button></li>`).join('')}</ol>`; }
function taskPlatforms() {
  const options=client.state.options, platforms=client.platforms.filter(p=>options.selections.some(s=>String(s.platform_id)===String(p.id)));
  return `<div class="customer-table-scroll"><table class="customer-table"><thead><tr><th>平台</th><th>官方号 / 篇</th><th>个人号 / 篇</th><th>发布形态</th></tr></thead><tbody>${platforms.map(p=>{const c=selectionCounts(options,p.id);return `<tr><th>${e(p.name)}</th>${['official','personal'].map(type=>`<td><input id="task-count-${p.id}-${type}" type="number" min="0" max="20" step="1" data-task-count="${p.id}" data-account="${type}" value="${c[type]}" aria-label="${e(p.name)}${accountName(type)}篇数"></td>`).join('')}<td><div class="format-picks">${p.formats.map(fmt=>`<label><input type="checkbox" data-task-format="${p.id}" value="${e(fmt)}" ${(options.format_overrides[p.id]||p.formats).includes(fmt)?'checked':''}>${e(fmt)}</label>`).join('')}</div></td></tr>`;}).join('')}</tbody></table></div>`;
}
function zipView() {
  const s=client.state;
  if(step===4)return stepper()+articleView();
  if(step===3)return stepper()+liveView(true);
  if(step===2)return `${stepper()}<section class="step-surface"><div class="spread"><div><h1>平台安排</h1><p>${e(planSummary(s.options,client.platforms).text)}</p></div>${button('platforms','选择平台与形态','settings','outline')}</div>${taskPlatforms()}<div class="step-actions">${button('step-1','上一步','back','quiet')}${button('start','开始写作','right','primary',client.activeJob||isOperationRunning()||operationBusy)}</div></section>`;
  return `${stepper()}<section class="step-surface"><h1>创作准备</h1>${clientLine()}<div class="preparation-grid">${sourceBlock()}${keywordEditor()}</div><label class="field task-note"><span>本次方向与补充要求</span><textarea class="input" id="zip-note" data-option="note" rows="3" placeholder="说明本次想表达的重点">${e(s.options.note)}</textarea></label>${expandedOptions()}<div class="step-actions"><span></span>${button('step-2','下一步：平台安排','right','primary')}</div></section>`;
}
function liveView(inStep = false) {
  return liveMarkup(client.state,client.platforms,button)+(inStep?`<div class="step-actions">${button('step-2','返回配置','back','quiet')}<span></span></div>`:'');
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
  const bodyLines=articleBody(a).split(/\r?\n/);if(bodyLines[0]?.replace(/^#\s+/,'').trim()===a.title?.trim()&&/^#\s+/.test(bodyLines[0]))bodyLines.shift();
  return `<section class="article-workspace"><div id="article-scroll" class="article-scroll"><div class="article-tabs" role="tablist" aria-label="本次稿件">${s.articles.map((art,i) => `<button class="article-tab ${art.id === a.id ? 'active' : ''}" id="article-tab-${art.id}" role="tab" tabindex="${art.id === a.id ? 0 : -1}" aria-controls="paper" aria-selected="${art.id === a.id}" data-select-article="${art.id}"><span class="article-dot ${art.locked ? 'locked' : ''}"></span>${e(art.platform_name || art.platform || '稿件')} · ${i+1}</button>`).join('')}${client.activeJob ? `<button class="article-tab" data-action="live"><span class="working-dot"></span>写作状态</button>` : ''}</div>
    <div class="editor-toolbar"><span class="muted">${e(a.version_label || `工作版本 ${a.current_version}`)}${a.locked ? ' · 正在处理，只读' : ''}</span><div class="inline-actions">${button('compose','需求与安排',null,'quiet sm')}${button('versions','版本','clock','quiet sm',a.locked)}${button('sources','资料','file','quiet sm')}${button('review','去 AI 味审阅','review','quiet sm',a.locked)}${button('edit-article',editor && !editor.reading ? '阅读正文' : '编辑正文','edit','quiet sm',a.locked)}${moreMenu('article-menu','稿件更多操作',button('native-regenerate','整篇重写并核查',null,'quiet sm',a.locked||client.activeJob||isOperationRunning()||operationBusy||editor?.dirty)+button('native-audit','再核查一次',null,'quiet sm',a.locked||client.activeJob||isOperationRunning()||operationBusy||editor?.dirty)+button('delete-article','删除这篇稿件',null,'quiet sm danger',a.locked||client.activeJob||isOperationRunning()||operationBusy||editor?.dirty))}</div></div>
    ${operationRows([OPERATION_KIND.regenerate,OPERATION_KIND.audit])}<article class="paper" id="paper" role="tabpanel" aria-labelledby="article-tab-${a.id}"><div class="paper-meta"><span>${e(a.platform_name || a.platform || '')} · ${accountName(a.account_type)}${a.fmt ? ` · ${e(a.fmt)}` : ''}</span><span>${a.review ? (a.review.status==='unverified'?'本版本尚未模型核查':a.origin?.startsWith('zip')?'原生模型核查记录可查看':'模型复核记录可查看') : '此版本无核查记录'}</span></div>
    ${editor && !editor.reading ? `<label class="field"><span class="small muted">标题</span><input type="text" id="article-title" class="title-input" value="${e(editor.title)}" ${a.locked ? 'disabled' : ''}></label><label class="field"><span class="small muted">正文 · Markdown</span><textarea id="article-body" class="body-input" ${a.locked ? 'readonly' : ''}>${e(editor.body)}</textarea></label><details id="article-metadata"><summary>标签与声明</summary><div class="details-content"><label class="field"><span>标签 · 空格或逗号分隔</span><input type="text" id="article-tags" value="${e(editor.tags??(a.tags||[]).join(' '))}" ${a.locked?'disabled':''}></label><label class="field"><span>声明 · 每行一条</span><textarea class="input" id="article-decl" ${a.locked?'readonly':''}>${e(editor.decl??(a.decl||[]).join('\n'))}</textarea><small>清空后保存即可移除此版本的标签或声明。</small></label></div></details>` : `<h1>${e(a.title || '未命名稿件')}</h1><div>${markdown(bodyLines.join('\n'))}</div>`}
    <footer class="paper-foot"><span>${editor?.dirty ? '有未保存的人工编辑' : '当前采用版 · 用于默认导出'}</span><span>${(editor?.body ?? articleBody(a)).replace(/\s/g,'').length.toLocaleString()} 字</span></footer></article>
    ${editor ? `<div class="editor-save">${editor.base !== a.current_version ? '<p>后台版本已改变，请先保留编辑并核对版本。</p>' : ''}${button('save-article','保存新版本','check','primary',a.locked || !editor.dirty)}${button('end-edit','结束编辑',null,'quiet')}</div>` : ''}
    </div>${mode==='zip'?`<div class="revision-box"><div class="reply-row"><textarea class="input" id="revise-instruction" aria-label="对当前稿的修改要求" placeholder="修改当前稿，例如：开头直接说明用途。">${e(revisionInstruction(a))}</textarea><button class="send-button" data-action="revise" aria-label="修改当前稿" title="修改当前稿" ${a.locked||isOperationRunning()||operationBusy||editor?.dirty?'disabled':''}>${icon('arrow')}</button></div></div>`:''}</section>`;
}
function sourcesPanel() {
  const s = client.state, c = currentClient(), a = currentArticle(), summary = planSummary(s.options, client.platforms);
  return `<h3>本次资料</h3>${docRows(selectedDocs())}<div class="inline-actions">${button('upload','上传','plus','quiet sm')}${button('paste','粘贴',null,'quiet sm')}${button('library','资料库',null,'quiet sm')}</div><h3>客户档案</h3>${c ? `<dl class="plain-dl">${PROFILE_FIELDS.map(([key,label]) => `<div><dt>${label}</dt><dd>${e(key === 'name' ? c.name : c.profile?.[key] || '未填写')}</dd></div>`).join('')}</dl>${button('profile','编辑档案',null,'quiet sm')}` : button('choose-client','选择客户',null,'outline')}<h3>本次要求</h3><p>${e(s.options.note || '尚未填写')}</p><h3>任务安排</h3><dl class="plain-dl"><div><dt>关键词</dt><dd>${e(s.options.keywords.join('、') || '未填写')}</dd></div><div><dt>平台</dt><dd>${e(summary.text)}</dd></div><div><dt>计划篇数</dt><dd>${summary.count}</dd></div><div><dt>目标 AI</dt><dd>${e(s.options.models.join('、'))}</dd></div><div><dt>写作模型</dt><dd>${e(s.model)}</dd></div></dl>${a?.review ? `<details id="native-review"><summary>当前版本核查记录</summary><div class="fact-report">${e(valueText(a.review))}</div></details>` : ''}${mode==='chat'?`<h3>关键词与有效要求</h3>${keywordEditor()}<label class="field"><span>当前有效写作要求</span><textarea class="input" id="context-note" data-option="note" rows="6">${e(s.options.note)}</textarea></label>${button('platforms','调整平台与篇数',null,'outline sm')}${expandedOptions()}<h3>本次实验目标</h3>${targetsBlock('task-target')}`:''}${nativeArticleInfo(a)}${a ? `<h3>视频</h3><a class="button outline" href="/video/?client_id=${encodeURIComponent(c?.id || '')}&article_id=${a.id}&version_id=${a.current_version}">${icon('video')}制作视频</a><p class="helper">绑定当前采用版本 ${a.current_version}。使用此版本进入独立视频工作区。</p>` : ''}`;
}
function reviewScope(r) { return {review_id:r?.operation_id||r?.review_id,base_version:r?.base_version}; }
function reviewKey(a,r) { return client.articleDraftKey(a?.id,reviewScope(r)); }
function clearReviewValidation() { reviewError='';const message=$('#review-validation');if(message)message.textContent=''; }
function storeReviewDraft() {
  if(!selectedReviewId)return;
  const a=currentArticle(),r=reviewFor(a);client.setArticleDraft(a.id,{selected:[...selectedSuggestions],conservative:[...conservativeSuggestions],mode:rewriteMode,material:$('#rewrite-material')?.value??client.articleDraft(a.id,reviewScope(r)).material??''},reviewScope(r));
}
function revisionInstruction(a=currentArticle()) { return client.articleDraft(a.id).instruction||''; }
function reviewPanel() {
  const a=currentArticle();if(!a)return '<p class="empty">成稿完成后，可在这里手动审阅。</p>';
  const r=reviewFor(a),stale=r&&r.base_version!==a.current_version,key=reviewKey(a,r);
  if(r&&selectedReviewId!==key){const saved=client.articleDraft(a.id,reviewScope(r)),draft=saved.selected?saved:reviewDefaults(r);selectedSuggestions=new Set(draft.selected);conservativeSuggestions=new Set(draft.conservative||[]);rewriteMode=draft.mode;selectedReviewId=key;reviewError='';}
  const material=client.articleDraft(a.id,reviewScope(r)).material||'';
  const itemMarkup=(item,index,observation=false)=>{
    const id=String(item.id??index),inputId=`suggestion-${id}`;
    return `<section class="suggestion" data-review-item="${e(id)}"><div class="suggestion-select"><input id="${e(inputId)}" type="checkbox" data-suggestion="${e(id)}" ${selectedSuggestions.has(id)?'checked':''} ${stale?'disabled':''}><label for="${e(inputId)}"><strong>${e(id)} · ${e(item.signal)}</strong></label></div><div class="suggestion-body"><small>${e(observation?item.position:item.scope||'')}${item.requires_material?' · 需要新增真实素材':''}</small><blockquote>${e(item.quote||'')}</blockquote><p>${e(item.problem||item.reason||'')}</p><p>${e(item.proposal||'')}</p>${item.requires_material?`<fieldset class="material-choice"><legend>这条如何处理</legend><label><input type="radio" name="material-${e(id)}" data-material-choice="${e(id)}" value="material" ${conservativeSuggestions.has(id)?'':'checked'} ${stale?'disabled':''}>补充素材</label><label><input type="radio" name="material-${e(id)}" data-material-choice="${e(id)}" value="conservative" ${conservativeSuggestions.has(id)?'checked':''} ${stale?'disabled':''}>仅删减或收紧</label><p class="helper">保守处理只删除或收紧现有表述，不补充经历、案例或数字。</p></fieldset>`:''}</div></section>`;
  };
  return `${button('run-review',r?'重新通读当前版':'开始文风审阅','review','primary',a.locked||isOperationRunning()||operationBusy)}${operationRows([OPERATION_KIND.review,OPERATION_KIND.rewrite,OPERATION_KIND.revise])}${r?`<p class="helper">${e(r.reviewer||'文风审阅')} · 基于版本 ${e(r.base_version)}${stale?'；当前版本已变化，请重新审阅。':''}</p><p>${e(r.assessment)}</p><h3>修改建议 · ${(r.suggestions||[]).length}</h3>${(r.suggestions||[]).map((item,i)=>itemMarkup(item,i)).join('')}<div class="observations"><h3>观察项 · 可手动选择</h3>${(r.observations||[]).map((item,i)=>itemMarkup(item,i,true)).join('')||'<p>暂无观察项。</p>'}</div><hr><label class="field"><span>修改范围</span><select id="rewrite-mode">${[['full','允许全文重组'],['standard','标准调整'],['light','轻量修改']].map(([v,t])=>`<option value="${v}" ${rewriteMode===v?'selected':''}>${t}</option>`).join('')}</select></label><label class="field" style="margin-top:16px"><span>真实补充素材</span><textarea class="input" id="rewrite-material" placeholder="填写可用于正文的真实经历、数据或原文">${e(material)}</textarea><small>用于支持选择“补充素材”的建议。一般修改指令请使用正文下方“修改当前稿”。</small></label><p id="review-validation" class="error-text" role="alert">${e(reviewError)}</p>${button('rewrite','生成候选并做模型复核',null,'primary',a.locked||stale||isOperationRunning()||operationBusy)}${r.candidate?button('open-candidate','查看已有候选与差异',null,'outline'):''}`:'<p class="helper">审阅按需开始，保留当前正文。</p>'}`;
}
function versionsPanel() {
  const a = currentArticle(), data = a && versionsData[a.id];
  return `${a ? `<p>原生初稿、ZIP 成稿、人工版本与候选均保留。当前导出采用版本 ${a.current_version}。</p>${button('load-versions','刷新版本',null,'quiet sm')}${data ? (data.versions || []).map(v => `<section class="version-row"><h3>${e(v.label || v.origin || '工作版本')} ${v.id === a.current_version ? '<span class="version-current">当前采用</span>' : ''}</h3><small>版本 ${v.id} · ${e(v.created_at || '')}</small><div class="inline-actions">${button('version-preview','查看全文与差异',null,'quiet sm',false,`data-version="${v.id}"`)}${v.id !== a.current_version ? button('version-select',['style','revision'].includes(v.origin) ? '采用候选' : '恢复此版',null,'outline sm',a.locked,`data-version="${v.id}"`) : ''}</div></section>`).join('') : '<p class="helper">正在加载版本…</p>'}` : '<p class="empty">还没有稿件。</p>'}`;
}
function settingLimits() { return client.state.bootstrap?.setting_limits || {temperature:{min:0,max:1.5},max_tokens:{min:800,max:8000}}; }
function settingsPanel() {
  const s = client.state, settings = s.bootstrap?.settings || {}, models = s.bootstrap?.provider_models || [], limits=settingLimits();
  const names = models.map(m => typeof m === 'string' ? m : m.id || m.name);
  if (!names.includes(s.model)) names.unshift(s.model);
  return `<h3>写作模型</h3><label class="field"><span>WorkBuddy 模型</span><select id="setting-model">${names.map(name => `<option ${name === s.model ? 'selected' : ''} value="${e(name)}">${e(name)}${models.length && !models.some(m => (typeof m === 'string' ? m : m.id || m.name) === name) ? '（当前目录未确认）' : ''}</option>`).join('')}</select></label>${button('provider-models','查询可用模型',null,'quiet sm')}<div class="form-grid" style="margin-top:20px"><label class="field"><span>Temperature</span><input type="number" id="setting-temperature" min="${e(limits.temperature.min)}" max="${e(limits.temperature.max)}" step="0.1" value="${e(settings.temperature ?? 0.7)}"></label><label class="field"><span>最大输出 Token</span><input type="number" id="setting-max-tokens" min="${e(limits.max_tokens.min)}" max="${e(limits.max_tokens.max)}" step="1" value="${e(settings.max_tokens || 8000)}"></label><label class="check-label field wide"><span><input type="checkbox" id="setting-title-prefix" ${settings.title_prefix ? 'checked' : ''}>标题附平台与账号前缀</span></label></div><label class="field" style="margin-top:20px"><span>默认品牌</span><input type="text" id="setting-brand" value="${e(settings.brand||'')}" placeholder="新建客户时预填，可在档案中清空"></label><label class="check-label" style="margin-top:14px"><input type="checkbox" id="setting-disable-thinking" ${settings.disable_thinking?'checked':''}>关闭模型深度思考</label>`;
}
const settingsSections=[['writing','写作模型'],['platforms','发布平台'],['targets','目标 AI'],['preferences','抓取偏好'],['risks','风险清单']];
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
  if(reset)settingsSession.views.delete(section);
  const saved=settingsSession.views.get(section);
  if(saved){settingsDisplay(saved.title,saved.html,saved.submit,saved.options);$$('input,textarea,select',$('#settings-content')).forEach((el,i)=>{if(saved.values?.[i]){el.value=saved.values[i].value;el.checked=saved.values[i].checked;}});return;}
  const title=settingsSections.find(([key])=>key===section)?.[1]||'写作模型';
  const html=section==='writing'?settingsPanel():['platforms','targets'].includes(section)?catalogueMarkup(section):configBlock(section);
  settingsDisplay(title,html,section==='writing'?saveSettings:null,{settingsMain:true,label:'保存设置'});
}
function inspector() {
  if (!panel) return '';
  const titles = { sources: '资料与本次安排', review: '文风审阅', versions: '稿件版本', settings: '工作台设置' };
  return `<aside class="inspector" aria-label="${titles[panel]}"><div id="inspector-resizer" class="inspector-resizer" role="separator" aria-label="调整辅助面板宽度" aria-orientation="vertical" tabindex="0"></div><header class="inspector-head"><h2>${titles[panel]}</h2>${iconButton('close-panel','关闭辅助面板','close')}</header><div class="inspector-body" id="inspector-body">${({ sources:sourcesPanel, review:reviewPanel, versions:versionsPanel, settings:settingsPanel })[panel]()}</div></aside>`;
}

function freezeTaskInputs() {
  if(!client.state.batch?.frozen)return;
  const writes=new Set(['upload','paste','library','platforms','detect-aliases','add-keyword','start','write-one','confirm-plan','new-requirement','interview','send-reply']);
  for(const el of $$('[data-action]', $('#root')))if(writes.has(el.dataset.action)&&!(el.dataset.action==='interview'&&messageTarget()==='article'))el.disabled=true;
  for(const el of $$('[data-option],[data-keyword-index],[data-remove-keyword],[data-remove-doc],[data-task-count],[data-task-format],[data-target],[data-remove-target],[data-prompt],[data-answer],#message-input,#keyword-entry,#followup-enabled,#option-aliases', $('#root'))){
    if(el.id==='message-input'&&messageTarget()==='article')continue;
    if(el.matches('textarea,input[type=text],input[type=number]'))el.readOnly=true;else el.disabled=true;
  }
}

function render() {
  if (composing) { renderPending = true; return; }
  const previousTask=lastTask,previousArticle=renderedArticleId;
  const following=captureFollowing($('#root')),oldComposer=$('.chat-compose-area')?.getBoundingClientRect();
  const active = document.activeElement, focusId = active?.id, focusAction=active?.dataset.action;
  const rawValue=active?.matches('textarea,input[type=text],input[type=number],input[type=search]')?active.value:null;
  const selection = active?.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
  const scrolls = ['workspace','recent','inspector-body','article-scroll'].map(id => [id,$('#'+id)?.scrollTop || 0]);
  const details = new Map($$('details[id]', $('#root')).map(d => [d.id,d.open]));
  const s = client.state;
  if(wasWriting&&!client.activeJob&&s.job?.status==='done'&&s.articles.length&&draftPanelState().view==='live'){selectedId=s.articles.filter(a=>a.current_version!=null&&!a.locked).at(-1)?.id??selectedId;}
  wasWriting=client.activeJob;
  if (s.conversation?.id !== lastTask) {
    lastTask = s.conversation?.id; reviews = {}; versionsData = {}; selectedId = null;selectedReviewId=null;
    surface = client.activeJob ? 'live' : s.articles.length ? 'articles' : 'compose';
    step = client.activeJob ? 3 : s.articles.length ? 4 : 1;
  }
  if (!s.bootstrap) {
    $('#root').innerHTML = `<div class="boot-state"><h1>方立</h1><p>${e(s.error || '正在打开工作台…')}</p>${s.loaded ? '<p>请确认本机工作台服务已启动，然后刷新页面。</p>' : ''}</div>`; return;
  }
  document.documentElement.style.setProperty('--sidebar', `${s.ui.sidebarWidth}px`);
  const html = `<div class="app ${s.ui.collapsed ? 'collapsed' : ''}">${sidebar(s)}<button class="mobile-scrim" data-action="collapse" aria-label="关闭任务导航"></button><main class="main">${topbar(s)}<div class="workspace-notices">${customerArea?'':notices(s)}</div><div class="content-wrap"><div class="workspace" id="workspace" tabindex="-1">${customerArea ? customers.view() : mode === 'zip' ? zipView() : chatWorkspace()}</div>${!customerArea||panel==='settings'?inspector():''}</div></main></div>`;
  const template=document.createElement('template');template.innerHTML=html;
  const desiredParts=new Map(['.sidebar','.topbar','.workspace-notices','.workspace','.inspector'].map(selector=>[selector,$(selector,template.content)?.outerHTML]));
  const fresh=template.content,oldApp=$('#root>.app');
  const reviewKey=panel==='review'?JSON.stringify([s.conversation?.id,currentArticle()?.id,currentArticle()?.current_version,currentArticle()?.locked,operationBusy,reviewError,reviewFor(currentArticle()||{}),s.operations.map(o=>[o.id,o.status])]):'';
  if(!oldApp){$('#root').replaceChildren(fresh);renderParts.clear();}
  else {
    oldApp.className=$('.app',fresh).className;
    for(const selector of ['.sidebar','.topbar','.workspace-notices','.workspace']){
      const next=$(selector,fresh),old=$(selector,$('#root')),key=next?.outerHTML;
      if(old&&next&&renderParts.get(selector)!==key){if(selector==='.workspace')reconcile(old,next);else old.replaceWith(next);}
    }
    const next=$('.inspector',fresh),old=$('.inspector',$('#root'));
    if(next&&!(old&&panel==='review'&&reviewKey===lastInspectorKey)){
      if(!old||renderParts.get('.inspector')!==next.outerHTML){if(old)old.replaceWith(next);else $('.content-wrap').append(next);}
    } else if(!next&&old)old.remove();
  }
  renderParts=desiredParts;
  lastInspectorKey=reviewKey;renderedArticleId=currentArticle()?.id;
  freezeTaskInputs();
  for (const [id, open] of details) if ($('#'+id)) $('#'+id).open = open;
  for (const [id, top] of scrolls) if ($('#'+id)) $('#'+id).scrollTop = top;
  const focusTarget=focusId?$('#'+CSS.escape(focusId)):focusAction?$(`[data-action="${CSS.escape(focusAction)}"]`):null;
  if (focusTarget && previousTask===s.conversation?.id && (!['article-title','article-body','revise-instruction'].includes(focusId)||previousArticle===currentArticle()?.id)) {
    const next = focusTarget;if(rawValue!==null&&focusId!=='message-input')next.value=rawValue; next.focus({ preventScroll: true });
    if (selection && next.setSelectionRange && !['number','checkbox'].includes(next.type)) try { next.setSelectionRange(...selection); } catch {}
  }
  bindResize();bindInspectorResize();fitMessageInput();setupLiveUI($('#root'),{persist:()=>client.persist(),ui:s.ui});restoreFollowing($('#root'),previousTask===s.conversation?.id?following:[]);
  if(oldComposer&&previousTask===s.conversation?.id&&!matchMedia('(prefers-reduced-motion: reduce)').matches){const next=$('.chat-compose-area'),rect=next?.getBoundingClientRect();if(rect&&Math.abs(oldComposer.top-rect.top)>40&&oldComposer.width===rect.width)next.animate([{transform:`translateY(${oldComposer.top-rect.top}px)`},{transform:'translateY(0)'}],{duration:280,easing:'cubic-bezier(.16,1,.3,1)'});}
  if(!modal.open&&mode==='chat'&&surface==='compose'&&(previousTask!==s.conversation?.id||document.activeElement===document.body))$('#message-input')?.focus({preventScroll:true});
}
const customers=new CustomersWorkspace(client,{render,toast,openTask:async id=>{if(client.state.dirty)await client.saveDraft();customerArea=false;await client.load(id);history.replaceState(null,'',`${location.pathname}?conversation=${encodeURIComponent(id)}`);render();},newTask:async id=>{customerArea=false;await client.createConversation(id);surface='compose';step=1;history.replaceState(null,'',`${location.pathname}?conversation=${encodeURIComponent(client.state.conversation.id)}`);render();}});
client.subscribe(()=>render());
document.addEventListener('compositionstart', () => composing = true);
document.addEventListener('compositionend', () => { composing = false; if (renderPending) { renderPending = false; render(); } });

async function requireTask() {
  if (client.state.conversation) return true;
  chooseClient(); return false;
}
function chooseClient() {
  const clients = client.state.clients;
  dialog('选择本次客户', `<p class="helper">一个任务对应一个客户。选择后创建新的内容任务。</p>${clients.length ? `<label class="field"><span>已有客户</span><select name="client_id">${clients.map(c => `<option value="${e(c.id)}">${e(c.name)}</option>`).join('')}</select></label>` : '<p class="empty">还没有客户档案，先创建第一位客户。</p>'}<div style="margin-top:20px">${button('new-client','创建客户档案','plus','outline')}</div>`, clients.length ? async data => { customerArea=false;customers.leave();const c = await client.createConversation(data.get('client_id')); history.replaceState(null,'',`${location.pathname}?conversation=${encodeURIComponent(c.id)}`); panel = null; render(); } : null, { label:'创建任务' });
}
function profileDialog(edit = false) {
  const c = edit ? currentClient() : null, frozen=!!c&&!!client.state.batch?.frozen;
  const initialProfile=c?.profile||{brand:client.state.bootstrap?.settings?.brand||''};
  const fields = PROFILE_FIELDS.map(([key,label]) => `<label class="field ${['products','address'].includes(key) ? 'wide' : ''}"><span>${label}${key === 'name' ? ' *' : ''}</span><input type="text" name="${key}" value="${e(key === 'name' ? c?.name || '' : initialProfile[key]??'')}" ${key === 'name' ? 'required maxlength="100"' : 'maxlength="4000"'}></label>`).join('');
  dialog(c ? '本次任务档案' : '创建客户档案', `<p class="helper">${frozen?'本批客户档案只读。':''}品牌、公司与产品分别填写。此处临时调整只用于当前任务；永久档案请在客户区编辑。</p><div class="form-grid">${fields}</div>`, frozen ? null : async data => {
    const name = String(data.get('name')).trim(); if (!name) throw new Error('请填写客户或项目名称');
    const profile = Object.fromEntries(PROFILE_FIELDS.filter(([key]) => key !== 'name').map(([key]) => [key, String(data.get(key)||'').trim()]));
    const saved = c ? await client.updateProfile(name,profile) : await client.createClient(name, profile);
    if (!c) { const task = await client.createConversation(saved.id); history.replaceState(null,'',`${location.pathname}?conversation=${encodeURIComponent(task.id)}`); }
    toast(c?'本次任务档案已保存，客户永久档案保持原值':'客户档案已创建');
  }, { label:c ? '保存档案' : '保存并创建任务' });
  if(frozen)for(const input of $$('input',modal))input.readOnly=true;
}
function platformDialog() {
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
modal.addEventListener('close', () => { $('#modal-body').onchange = null;$('#modal-body').onclick=null; });
async function uploadFiles(files) {
  if(client.state.batch?.frozen){toast('本批安排已冻结，可复用为新任务调整');return;}
  if (!await requireTask()) return;
  importing = true; render(); const failures = [];
  for (const file of files) {
    try { const cid=client.state.conversation.client_id,taskId=client.state.conversation.id;const result=await importCustomerFile(customerService,cid,file,info=>customers.resolveImport(info));if(result.outcome==='cancelled')continue;if(result.is_current===false){failures.push(`${file.name}：原件属于历史修订，请在客户资料中选择当前版本`);continue;}if(!result.document||result.outcome==='pending'||result.outcome==='needs_resolution')throw new Error(result.document?.error||'原件已保存，资料尚待处理');if(client.state.conversation?.id!==taskId)continue;const doc=result.document;client.state.library=await customerService.documents(cid);client.state.documents=[...client.state.documents.filter(d=>d.id!==doc.id),doc];client.selectDocuments([...new Set([...client.state.documentIds,doc.id])]);await client.saveDraft(); }
    catch(error) { failures.push(`${file.name}：${error.message}`); }
  }
  importing = false; render(); if (failures.length) client.fail(new Error(failures.join('；'))); else toast(`已解析并添加 ${files.length} 份资料`);
}
async function upload() {
  if (!await requireTask()) return;
  const input = document.createElement('input'); input.type='file'; input.multiple=true;
  input.accept='.docx,.docm,.xlsx,.xlsm,.pptx,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.log,.pdf';
  input.onchange=()=>uploadFiles([...input.files]); input.click();
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
  dialog(`核对资料：${doc.filename}`,`<p class="helper">${e(doc.kind)} · ${client.state.batch?.frozen?'本批资料只读。后续资料更新请在客户区处理。':'可直接修正解析文字。保存修订后，本次任务改用修订文本；旧资料与已冻结的生成输入保留。'}</p><label class="field"><span>资料正文</span><textarea class="input" id="document-text" name="text" rows="16">${e(doc.text)}</textarea></label><p class="helper" id="document-char-count">${doc.text.length.toLocaleString()} 字</p>`,client.state.batch?.frozen ? null : async data=>{await client.reviseDocument(id,String(data.get('text')));toast('资料修订已保存，本次任务已使用修订正文');},{label:'保存资料修订'});
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
async function start(confirmed=false,one=false) {
  if(!await requireTask())return;
  pendingChat=mode==='chat'?{id:client.state.conversation.id,text:client.messageDraft()}:null;operationBusy=true;render();
  try { const done=mode==='chat'?await client.submitMessage({start:true,confirmed,one}):await client.start({confirmed,one});if(done===null)return;surface='live';step=3;showDraft('live'); }
  finally {pendingChat=null;operationBusy=false;render();}
}
async function interview() {
  if(!await requireTask())return;
  if(messageTarget()==='article')return reviseFromChat();
  pendingChat={id:client.state.conversation.id,text:client.messageDraft()};operationBusy=true;render();
  try { const done=await client.submitMessage();if(done){surface='compose';toast('需求已整理，可继续补充或开始写作');} }
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
async function saveArticle() {
  const a=currentArticle(), ed=localEditor(a); if(!ed)return;
  const lines=ed.body.split(/\r?\n/);if(ed.title!==a.title&&lines[0]?.replace(/^#\s+/,'').trim()===a.title?.trim()&&/^#\s+/.test(lines[0])){lines[0]='# '+ed.title;ed.body=lines.join('\n');}
  const tags=String(ed.tags??(a.tags||[]).join(' ')).split(/[,，\s]+/).filter(Boolean).map(tag=>tag.startsWith('#')?tag:'#'+tag);
  const decl=String(ed.decl??(a.decl||[]).join('\n')).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  await client.saveArticle(a.id,ed.body,ed.title,ed.base,{tags,decl});versionsData[a.id]=null;toast('已保存新工作版本；本版尚未核查');
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
    act(async()=>{try {const result=await client.watchOperation(operationId);if(!result||client.state.conversation?.id!==cid)return;versionsData[a.id]=null;surface='articles';step=4;panel='sources';toast(regenerate?'已重新写作并核查，当前采用新版本':'再次核查已完成，请查看当前采用稿');}finally{operationBusy=false;render();}});
    return false;
  },{label:regenerate?'重新写作并核查':'开始再次核查'});
}
function deleteArticleDialog() {
  const a=currentArticle();client.assertSettled();
  dialog('删除这篇稿件',`<p>确认从本次稿件和导出中移除“${e(a.title)}”？</p><p class="helper">原安排会空出一篇，可再次写作。历史版本与已固定的视频来源保留。</p>`,async()=>{await client.deleteArticle(a.id);delete versionsData[a.id];selectedId=null;toast('稿件已移除');},{label:'确认删除稿件'});
}
function deleteTaskDialog() {
  client.assertSettled();
  dialog('删除任务',`<p>确认删除“${e(client.state.conversation.title)}”？</p><p class="helper">任务将从历史列表移除。客户档案和已固定的视频来源保留，未保存的编辑也会移除。</p>`,async()=>{await client.deleteConversation();history.replaceState(null,'',location.pathname);panel=null;toast('任务已删除');},{label:'确认删除任务'});
}
async function downloadFile(url,filename) {
  const response=await fetch(url);if(!response.ok){let result;try{result=await response.json();}catch{}throw new Error(result?.error||'下载失败，请核对当前状态');}
  const blob=await response.blob(),link=document.createElement('a'),objectUrl=URL.createObjectURL(blob);link.href=objectUrl;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(objectUrl),2000);
}
async function archiveTask() {client.assertSettled();if(client.state.dirty)await client.saveDraft();await downloadFile(client.path('/archive'),`方立-任务归档-${client.state.conversation.id}.zip`);toast('本地归档已下载');}
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
  dialog('版本全文与差异',`<p class="helper">候选未采用前，默认查看与导出仍使用当前采用版 ${a.current_version}。</p><div class="compare-grid"><section><h3>原稿 · 版本 ${e(data.base?.id||data.base?.version_id||a.current_version)}</h3><div class="compare-copy rendered-copy"><h3>${e(base.title||a.title)}</h3>${markdown(readingBody(base))}</div></section><section><h3>候选 / 历史稿 · 版本 ${e(candidate)}</h3><div class="compare-copy rendered-copy"><h3>${e(next.title)}</h3>${markdown(readingBody(next))}</div></section></div><details id="compare-diff" open><summary>前后差异</summary><pre class="diff-text">${e(valueText(data.diff||result.changes||'服务端未提供差异摘要，请对照两侧全文。'))}</pre></details><details id="candidate-fact" open><summary>${fact.readonly===true?'一次只读模型复核':['zip','zip_initial','zip_regenerate','zip_regenerate_draft','zip_audit'].includes(data.candidate?.origin)?'原生事实核查 · 可修正正文':'此版本核查状态'}</summary><div class="fact-report">${factMarkup(fact)}</div></details>${changes.length?`<details id="candidate-changes"><summary>模型修改清单 · ${changes.length} 条</summary>${changes.map(text=>`<p>${e(text)}</p>`).join('')}</details>`:''}${skipped.length?`<details id="candidate-skipped"><summary>其他处理说明 · 原返回</summary>${skipped.map(text=>`<p>${e(text)}</p>`).join('')}</details>`:''}<section class="saved-review"><h3>实际审阅记录</h3><div class="review-text">${records.codex_review?markdown(records.codex_review):'<p class="helper">尚无 Codex 意见记录。</p>'}</div>${records.user_review?`<h4>用户意见</h4><div class="review-text">${markdown(records.user_review)}</div>`:'<p class="helper">用户尚未提交审阅意见。</p>'}</section><details id="edit-review-record"><summary>编辑意见记录</summary><div class="form-grid record-grid"><label class="field"><span>Codex 审阅意见 · 真实记录</span><textarea class="input" name="codex_review" placeholder="尚未提交 Codex 意见；有真实审阅后再记录。">${e(records.codex_review||'')}</textarea></label><label class="field"><span>你的意见</span><textarea class="input" name="user_review" placeholder="记录你认可或仍需调整的地方">${e(records.user_review||'')}</textarea></label></div><div class="inline-actions" style="margin-top:14px"><button type="button" class="button outline" id="save-review-record">保存双方意见</button><span id="record-status" class="helper">${records.codex_review ? '已有 Codex 意见记录' : '尚无 Codex 意见记录'}</span></div></details>`,a.current_version===candidate ? null : async()=>{if(localEditor(a)?.dirty)throw new Error('请先保存人工编辑，再采用版本');await client.selectVersion(aid,candidate);versionsData[aid]=null;toast('已明确采用，此版本用于默认导出');},{wide:true,label:'采用此版并用于导出'});
  $('#save-review-record').onclick=()=>act(async()=>{await client.reviewRecord(aid,{candidate_version:candidate,codex_review:$('[name=codex_review]',modal).value,user_review:$('[name=user_review]',modal).value});$('#record-status').textContent='双方意见已留档';});
}
async function exportDialog() {
  const articles=client.state.articles.filter(a=>!a.locked);
  const omitted=client.state.ui.exportOmitted?.[client.state.conversation.id]||[];
  dialog('导出当前采用稿',`<p class="helper">导出默认使用 ZIP 成稿；人工保存或明确采用候选后，使用相应采用版。</p><label class="field"><span>格式</span><select name="fmt"><option value="docx">Word（DOCX）</option><option value="md">Markdown</option><option value="txt">纯文本</option><option value="json">JSON</option></select></label><div class="inline-actions"><button type="button" class="button quiet sm" data-export-pick="all">全选</button><button type="button" class="button quiet sm" data-export-pick="none">全不选</button></div><div class="library-list">${articles.map(a=>`<label><input type="checkbox" name="ids" value="${a.id}" ${omitted.includes(String(a.id))?'':'checked'}><span>${e(a.title)}<small>${e(a.platform_name||a.platform||'')} · ${accountName(a.account_type)} · 版本 ${a.current_version}</small></span></label>`).join('')}</div>`,async data=>{const ids=data.getAll('ids');if(!ids.length)throw new Error('至少选择一篇稿件');const fmt=data.get('fmt');const url=client.path(`/export?fmt=${encodeURIComponent(fmt)}&ids=${ids.map(encodeURIComponent).join(',')}`);const response=await fetch(url);if(!response.ok){let d;try{d=await response.json();}catch{}throw new Error(d?.error||'导出失败，请确认后台状态');}const blob=await response.blob();const link=document.createElement('a'),objectUrl=URL.createObjectURL(blob);link.href=objectUrl;link.download=`方立-${client.state.conversation.id}.${fmt}`;link.click();setTimeout(()=>URL.revokeObjectURL(objectUrl),2000);toast('已导出所选采用版本');},{label:'导出文件'});
}
function rememberExportSelection() {
  const omitted=$$('input[name="ids"]',modal).filter(input=>!input.checked).map(input=>input.value);
  client.state.ui.exportOmitted={...client.state.ui.exportOmitted,[client.state.conversation.id]:omitted};client.persist();
}
async function reloadConfig() {client.state.config=await client.api('/api/workbench/zip-config');client.state.configError='';render();}
async function saveSettings() {
  const model=$('#setting-model').value,temperature=Number($('#setting-temperature').value),max_tokens=Number($('#setting-max-tokens').value),title_prefix=$('#setting-title-prefix').checked,brand=$('#setting-brand').value,disable_thinking=$('#setting-disable-thinking').checked;
  const limits=settingLimits();
  if(!Number.isFinite(temperature)||temperature<limits.temperature.min||temperature>limits.temperature.max||!Number.isInteger(max_tokens)||max_tokens<limits.max_tokens.min||max_tokens>limits.max_tokens.max)throw new Error(`请填写有效的温度（${limits.temperature.min}—${limits.temperature.max}）与最大 Token（${limits.max_tokens.min}—${limits.max_tokens.max}）`);
  const d=await client.api('/api/workbench/settings','POST',{model,temperature,max_tokens,title_prefix,brand,disable_thinking});client.state.bootstrap.settings={...client.state.bootstrap.settings,...d.settings,model,temperature,max_tokens,title_prefix,brand,disable_thinking};client.state.model=model;client.emit();toast('写作设置已保存');
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
  const actionButton=event.target.closest('[data-action]');
  if(actionButton) {
    const action=actionButton.dataset.action;
    const actions={
      collapse:()=>client.setUI({collapsed:!client.state.ui.collapsed}),
      customers:async()=>{if(client.state.dirty)await client.saveDraft();panel=null;customerArea=true;history.replaceState(null,'',`${location.pathname}?area=customers`);await customers.enter();},'new-task':chooseClient,'choose-client':chooseClient,'new-client':()=>profileDialog(false),profile:()=>currentClient()?profileDialog(true):profileDialog(false),
      'find-task':()=>findTask(),
      'mode-chat':()=>switchMode('chat'),'mode-zip':()=>switchMode('zip'),platforms:platformDialog,upload,paste,library,
      sources:()=>{panel=panel==='sources'?null:'sources';render();},review:()=>{panel=panel==='review'?null:'review';render();},settings:()=>{panel=null;render();openSettings();},'close-panel':()=>{panel=null;render();},
      compose:()=>{customers.leave();customerArea=false;history.replaceState(null,'',location.pathname+(client.state.conversation?`?conversation=${encodeURIComponent(client.state.conversation.id)}`:''));surface='compose';step=1;render();},articles:()=>{surface='articles';step=4;showDraft('article');render();},live:()=>{surface='live';step=3;showDraft('live');render();},
      'open-draft':()=>{showDraft(client.activeJob?'live':'article');render();},'close-draft':()=>{draftPanelState().open=false;client.persist();render();$('.reopen-draft')?.focus();},'follow-stream':()=>{const scroll=$('#stream-scroll');if(scroll){scroll.dataset.follow='true';scroll.scrollTop=scroll.scrollHeight;$('.new-content').hidden=true;}},
      'step-1':()=>setStep(1),'step-2':()=>setStep(2),'step-4':()=>setStep(4),
      'add-keyword':addKeyword,'detect-aliases':detectAliases,
      start:()=>client.state.needsConfirmation?confirmPlan():start(),'write-one':()=>client.state.needsConfirmation?confirmPlan(true):start(false,true),stop:async()=>{await client.stop();toast('已请求暂停后续，当前篇继续收尾');},'confirm-plan':()=>confirmPlan(),'new-requirement':newRequirement,
      'clone-task':async()=>{const task=await client.cloneConversation();history.replaceState(null,'',`${location.pathname}?conversation=${encodeURIComponent(task.id)}`);panel=null;toast('已复用当前安排，创建未生成的新任务');},'delete-task':deleteTaskDialog,'archive-task':archiveTask,
      'native-regenerate':()=>nativeActionDialog('regenerate'),'native-audit':()=>nativeActionDialog('audit'),'delete-article':deleteArticleDialog,
      interview:()=>interview(),'chat-candidate':()=>compareDialog(Number(actionButton.dataset.articleId),Number(actionButton.dataset.candidateVersion)),
      'dismiss-message-error':()=>{client.setMessageError('');render();},'dismiss-error':()=>{client.state.error='';render();},recover:async()=>{await client.reload();client.state.error='';client.resumeBackground();render();},
      'edit-article':()=>beginEdit(currentArticle()),'save-article':saveArticle,'end-edit':()=>{const a=currentArticle();if(localEditor(a)?.dirty)throw new Error('仍有未保存编辑，请先保存新版本；编辑已在本机暂存');delete client.state.editors[editorKey(a)];client.emit();},
      versions:async()=>{panel='versions';render();await loadVersions();},'load-versions':loadVersions,'version-preview':()=>compareDialog(currentArticle().id,Number(actionButton.dataset.version)),
      'version-select':async()=>{const a=currentArticle();if(localEditor(a)?.dirty)throw new Error('请先保存人工编辑，再恢复或采用版本');await client.selectVersion(a.id,Number(actionButton.dataset.version));await loadVersions();toast('已采用所选版本');},
      'run-review':()=>articleOperation('style-review'),rewrite:()=>articleOperation('style-rewrite'),revise:()=>articleOperation('revise'),'open-candidate':()=>compareDialog(currentArticle().id,reviewFor(currentArticle()).candidate),
      export:exportDialog,'reload-config':reloadConfig,'save-settings':saveSettings,'config-admin':configAdmin,'add-platform':()=>editPlatform(null),'add-target':()=>editTarget(null),'add-risk':()=>editRisk(null),
      'provider-models':async()=>{const d=await client.api('/api/workbench/provider-models');client.state.bootstrap.provider_models=d.models||d.provider_models||[];client.emit();toast('模型目录已更新');},
    };
    if(actions[action]){act(actions[action]);const menu=actionButton.closest('.toolbar-menu');if(menu)menu.open=false;}
    return;
  }
  const task=event.target.closest('[data-task]'); if(task)act(async()=>{if(client.state.dirty)await client.saveDraft();customerArea=false;customers.leave();await client.load(task.dataset.task);history.replaceState(null,'',`${location.pathname}?conversation=${encodeURIComponent(task.dataset.task)}`);modal.close();if(innerWidth<=760)client.setUI({collapsed:true});await openGuideTarget(task.dataset.guideIntent);});
  const doc=event.target.closest('[data-doc]');if(doc)showDocument(doc.dataset.doc);
  const remove=event.target.closest('[data-remove-doc]');if(remove)client.selectDocuments(client.state.documentIds.filter(id=>String(id)!==remove.dataset.removeDoc));
  const answer=event.target.closest('[data-answer]');if(answer){client.setMessageDraft(answer.dataset.answerText);act(()=>interview());}
  const prompt=event.target.closest('[data-prompt]');if(prompt){const texts=['根据已选客户资料，介绍产品或服务的特点、适用对象与使用条件。','围绕资料中的产品或服务，解答目标读者关心的常见问题。','根据客户资料，介绍公司与品牌、产品或服务的真实业务关系。'];client.setMessageDraft(texts[Number(prompt.dataset.prompt)]);$('#message-input').value=client.messageDraft();$('#message-input').focus();fitMessageInput(true);}
  const stepButton=event.target.closest('[data-step]');if(stepButton)act(()=>setStep(Number(stepButton.dataset.step)));
  const article=event.target.closest('[data-select-article]');if(article){selectedId=Number(article.dataset.selectArticle);surface='articles';step=4;showDraft('article');panel=null;render();}
  const stop=event.target.closest('[data-stop-operation]');if(stop)act(()=>client.stopOperation(stop.dataset.stopOperation));
  const risk=event.target.closest('[data-edit-risk]');if(risk)editRisk(risk.dataset.editRisk);
  const delRisk=event.target.closest('[data-delete-risk]');if(delRisk)deleteRisk(delRisk.dataset.deleteRisk);
  const platform=event.target.closest('[data-edit-platform]');if(platform)editPlatform(platform.dataset.editPlatform);
  const target=event.target.closest('[data-edit-target]');if(target)editTarget(target.dataset.editTarget);
  const removeTarget=event.target.closest('[data-remove-target]');if(removeTarget)client.setOptions({models:client.state.options.models.filter(name=>name!==removeTarget.dataset.removeTarget)});
  const deletePlatform=event.target.closest('[data-delete-platform]');if(deletePlatform)deleteCatalogue('platforms',deletePlatform.dataset.deletePlatform);
  const deleteTarget=event.target.closest('[data-delete-target]');if(deleteTarget)deleteCatalogue('models',deleteTarget.dataset.deleteTarget);
  const keyword=event.target.closest('[data-remove-keyword]');if(keyword){client.setOptions({keywords:client.state.options.keywords.filter((_,index)=>index!==Number(keyword.dataset.removeKeyword))});$('#keyword-entry')?.focus();}
  const rival=event.target.closest('[data-remove-rival]');if(rival)client.setOptions({rivals:client.state.options.rivals.filter((_,index)=>index!==Number(rival.dataset.removeRival))});
});
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.dataset.taskCount){try{client.state.options=setCount(client.state.options,Number(el.dataset.taskCount),el.dataset.account,el.value);client.markDirty();}catch(error){client.fail(error);}return;}
  if(el.dataset.keywordIndex!=null){const keywords=[...client.state.options.keywords];keywords[Number(el.dataset.keywordIndex)]=el.value;client.setOptions({keywords});}
  else if(el.id==='message-input'){client.setMessageDraft(el.value);$('.composer-error')?.remove();fitMessageInput(true);}
  else if(el.dataset.option)client.setOptions({[el.dataset.option]:['keywords','rivals'].includes(el.dataset.option)?splitWords(el.value):el.value});
  else if(el.id==='option-aliases')client.setOptions({aliases:el.value.split(/\n/).map(splitWords).filter(g=>g.length>1)});
  else if(['article-title','article-body','article-tags','article-decl'].includes(el.id)){const a=currentArticle(),ed=localEditor(a);if(!ed||a.locked)return;ed[({'article-title':'title','article-body':'body','article-tags':'tags','article-decl':'decl'})[el.id]]=el.value;ed.dirty=true;client.persist();const save=$('[data-action=save-article]');if(save)save.disabled=false;}
  else if(el.id==='chat-reply'){client.state.ui.reply=el.value;client.persist();}
  else if(el.id==='revise-instruction'){client.setArticleDraft(currentArticle().id,{instruction:el.value});}
  else if(el.id==='rewrite-material'){clearReviewValidation();storeReviewDraft();}
});
document.addEventListener('change',event=>{
  if(event.target.id==='message-target'){draftPanelState().target=event.target.value;client.persist();render();return;}
  const el=event.target;
  if(el.name==='ids'&&modal.contains(el))rememberExportSelection();
  if(el.dataset.taskFormat){const formats=$$('[data-task-format]').filter(x=>x.dataset.taskFormat===el.dataset.taskFormat&&x.checked).map(x=>x.value);if(!formats.length){el.checked=true;toast('每个平台至少保留一种形态');return;}client.setOptions({format_overrides:{...client.state.options.format_overrides,[el.dataset.taskFormat]:formats}});}
  if(el.dataset.target){const models=client.state.options.models.filter(m=>m!==el.dataset.target);if(el.checked)models.push(el.dataset.target);client.setOptions({models});}
  if(el.id==='followup-enabled')client.setUI({followup:el.checked});
  if(el.dataset.suggestion){if(el.checked)selectedSuggestions.add(el.dataset.suggestion);else selectedSuggestions.delete(el.dataset.suggestion);clearReviewValidation();storeReviewDraft();}
  if(el.id==='rewrite-mode'){rewriteMode=el.value;storeReviewDraft();}
  if(el.dataset.materialChoice){el.value==='conservative'?conservativeSuggestions.add(el.dataset.materialChoice):conservativeSuggestions.delete(el.dataset.materialChoice);clearReviewValidation();storeReviewDraft();}
  if(el.dataset.prefModel)act(async()=>{await client.api('/api/prefs','POST',{model_id:Number(el.dataset.prefModel),platform_id:Number(el.dataset.prefPlatform),level:el.value});const prefs=client.state.config.prefs||client.state.config.preferences||[];const pref=prefs.find(p=>String(p.model_id)===el.dataset.prefModel&&String(p.platform_id)===el.dataset.prefPlatform);if(pref)pref.level=el.value;else prefs.push({model_id:Number(el.dataset.prefModel),platform_id:Number(el.dataset.prefPlatform),level:el.value});toast('抓取偏好已保存');});
});
async function switchMode(nextMode) {
  if(nextMode===mode&&!customerArea)return;
  await client.saveDraft(nextMode);client.persist();
  const path=nextMode==='zip'?'/workbench/zip/index.html':'/workbench/index.html';
  intentionalNavigation=true;
  location.href=path+(client.state.conversation?`?conversation=${encodeURIComponent(client.state.conversation.id)}`:'');
}
async function setStep(next) { if(client.state.conversation && client.state.dirty)await client.saveDraft();step=next;surface=next===4?'articles':next===3?'live':'compose';render();$('#workspace')?.scrollTo(0,0); }
function bindResize() {
  const resizer=$('#sidebar-resizer');if(!resizer)return;
  const setWidth=width=>{client.state.ui.sidebarWidth=Math.round(Math.max(190,Math.min(380,width)));document.documentElement.style.setProperty('--sidebar',`${client.state.ui.sidebarWidth}px`);resizer.setAttribute('aria-valuenow',client.state.ui.sidebarWidth);};
  resizer.onpointerdown=event=>{if(event.button!==0)return;const start=event.clientX,width=client.state.ui.sidebarWidth;resizer.setPointerCapture(event.pointerId);document.body.classList.add('dragging');resizer.onpointermove=e=>setWidth(width+e.clientX-start);};
  resizer.onpointerup=resizer.onpointercancel=()=>{resizer.onpointermove=null;document.body.classList.remove('dragging');client.persist();};
  resizer.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setWidth(client.state.ui.sidebarWidth+(event.key==='ArrowLeft'?-10:10));client.persist();}};
}
function bindInspectorResize() {
  const handle=$('#inspector-resizer');if(!handle)return;
  const min=Math.min(320,innerWidth-32),max=innerWidth<=760?innerWidth-32:Math.max(min,Math.min(720,(innerWidth-client.state.ui.sidebarWidth)*.58));
  const set=width=>{const next=Math.round(Math.max(min,Math.min(max,width)));client.state.ui.inspectorWidth=next;document.documentElement.style.setProperty('--inspector-width',`${next}px`);handle.setAttribute('aria-valuenow',next);};
  handle.setAttribute('aria-valuemin',min);handle.setAttribute('aria-valuemax',Math.floor(max));set(client.state.ui.inspectorWidth||420);
  handle.onpointerdown=event=>{if(event.button!==0)return;const start=event.clientX,width=client.state.ui.inspectorWidth;handle.setPointerCapture(event.pointerId);handle.onpointermove=e=>set(width+start-e.clientX);};
  handle.onpointerup=handle.onpointercancel=()=>{handle.onpointermove=null;client.persist();};
  handle.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();set(event.key==='Home'?min:event.key==='End'?max:client.state.ui.inspectorWidth+(event.key==='ArrowLeft'?20:-20));client.persist();}};
}
function hideTooltip(){clearTimeout(tooltipTimer);$('#task-tooltip').hidden=true;}
function showTooltip(button) {
  clearTimeout(tooltipTimer);tooltipTimer=setTimeout(()=>{const t=client.state.conversations.find(x=>x.id===button.dataset.task);if(!t)return;const box=$('#task-tooltip'),rect=button.getBoundingClientRect();box.innerHTML=`<strong>${e(t.title||'未命名内容')}</strong><dl class="plain-dl"><div><dt>创建时间</dt><dd>${e(t.created_at||'未记录')}</dd></div><div><dt>状态</dt><dd>${statusText(t.status)}</dd></div><div><dt>客户</dt><dd>${e(client.state.clients.find(c=>c.id===t.client_id)?.name||'')}</dd></div></dl>`;box.hidden=false;box.style.left=`${Math.min(rect.right+12,innerWidth-box.offsetWidth-12)}px`;box.style.top=`${Math.max(12,Math.min(rect.top,innerHeight-box.offsetHeight-12))}px`;},320);
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
    selectedId=list[next].id;render();$(`#article-tab-${selectedId}`)?.focus();
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
window.addEventListener('pagehide',()=>{customers.dispose();clearTimeout(aliasTimer);client.persist();client.dispose();});
window.matchMedia('(max-width:760px)').addEventListener('change',event=>{if(event.matches)client.setUI({collapsed:true});});
window.addEventListener('beforeunload',event=>{if(!intentionalNavigation&&(client.state.dirty||Object.values(client.state.editors).some(ed=>ed.dirty))){event.preventDefault();event.returnValue='';}});
await client.boot(new URLSearchParams(location.search).get('conversation')).catch(()=>{});
if(customerArea&&client.state.bootstrap)await customers.enter().catch(error=>client.fail(error));
if(innerWidth<=760)client.setUI({collapsed:true});
if(client.state.bootstrap){
  const entry=new URLSearchParams(location.search).get('entry');
  if(['tasks','review','export','settings'].includes(entry)){
    const url=new URL(location.href);url.searchParams.delete('entry');history.replaceState(null,'',url.pathname+url.search+url.hash);
    if(entry==='settings')openSettings();else findTask(entry==='tasks'?'':entry);
  }
}
