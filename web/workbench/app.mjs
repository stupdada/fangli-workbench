import { WorkbenchClient } from './client.mjs';
import { PROFILE_FIELDS, clone, enabled, running, accountName, splitWords, normalizeOptions, selectionCounts, setCount,
  togglePlatform, planSummary, optionIssues, escapeHTML as e, markdown, articleBody, valueText,OPERATION_KIND,latestOperation,reviewDefaults,interviewMessageText } from './model.mjs';
import { parseFile } from './files.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const mode = document.body.dataset.mode;
const client = new WorkbenchClient();
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
function nativeArticleInfo(a) {
  if(!a)return '';
  const rows=[['写作角度',a.angle],['关键词',(a.keywords||[]).join('、')||a.keyword],['标签',(a.tags||[]).join('、')],['声明',(a.decl||[]).join('、')]];
  return `<details id="native-article-info"><summary>ZIP 稿件信息与检查</summary><dl class="plain-dl">${rows.filter(([,value])=>value).map(([key,value])=>`<div><dt>${key}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>${a.risk_tips?.length?`<h3>风险提示</h3>${a.risk_tips.map(t=>`<p>${e(valueText(t))}</p>`).join('')}`:''}${a.audit&&Object.keys(a.audit).length?`<h3>原生核查</h3>${factMarkup(a.audit)}`:''}${a.geo&&Object.keys(a.geo).length?`<h3>原生自检</h3><pre class="diff-text">${e(valueText(a.geo))}</pre>`:''}</details>`;
}
let panel = null, surface = 'compose', step = 1, selectedId = null, composing = false, renderPending = false;
let selectedSuggestions = new Set(),selectedReviewId=null, rewriteMode = 'full', reviews = {}, versionsData = {}, modalSubmit = null, lastTask = null;
let tooltipTimer, toastTimer, importing = false, operationBusy = false, lastFocus, lastFocusAction, intentionalNavigation = false;
let aliasTimer, aliasState = { key: '', groups: [], status: 'idle' };
const aliasCache = new Map();
const modal = $('#modal');
$('.dialog-head [data-close]').innerHTML = icon('close');
$$('[data-close]', modal).forEach(b => b.onclick = () => modal.close());
modal.addEventListener('close', () => { modalSubmit = null; if(lastFocus?.isConnected)lastFocus.focus();else if(lastFocusAction)$(`[data-action="${CSS.escape(lastFocusAction)}"]`)?.focus(); });
$('#modal-form').onsubmit = async event => {
  event.preventDefault(); if (!modalSubmit) return;
  const submit = $('#modal-submit'); submit.disabled = true; $('#modal-error').textContent = '';
  try { const close = await modalSubmit(new FormData($('#modal-form'))); if (close !== false) modal.close(); }
  catch (error) { $('#modal-error').textContent = error.message; }
  finally { submit.disabled = false; }
};
function dialog(title, html, submit, { label = '保存', wide = false } = {}) {
  if(!modal.open){lastFocus = document.activeElement?.closest('.toolbar-menu')?.querySelector('summary')||document.activeElement;lastFocusAction=lastFocus?.dataset.action;} modal.classList.toggle('wide', wide);
  $('#modal-body').onchange = null;$('#modal-body').onclick=null;
  $('#platform-summary')?.remove();
  $('#modal-title').textContent = title; $('#modal-body').innerHTML = html; $('#modal-error').textContent = '';
  $('#modal-submit').textContent = label; $('#modal-submit').hidden = !submit; modalSubmit = submit;
  if (!modal.open) modal.showModal();
}
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 4200); }
async function act(fn) {
  try { client.state.error = ''; await fn(); }
  catch (error) { client.fail(error); toast(error.message); }
}
function currentClient() { const c=client.state.clients.find(c=>c.id===client.state.conversation?.client_id);if(!c)return null;const o=client.state.options;return {...c,name:o.client??'',profile:Object.fromEntries(PROFILE_FIELDS.filter(([key])=>key!=='name').map(([key])=>[key,o[key]??'']))}; }
function moreMenu(id,label,items) { return `<details class="toolbar-menu" id="${id}"><summary class="icon-button" aria-label="${label}" title="${label}">${icon('more')}</summary><div class="menu-items">${items}</div></details>`; }
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
  return `<aside class="sidebar" aria-label="任务导航"><div class="side-head"><a class="brand-link" href="/">${icon('logo')}<span>方立</span></a><button class="icon-button" id="sidebar-toggle" data-action="collapse" aria-label="${s.ui.collapsed ? '展开' : '折叠'}侧栏" aria-expanded="${!s.ui.collapsed}">${icon('menu')}</button></div>
    <nav class="nav"><button class="nav-button" data-action="new-task" title="新建内容">${icon('plus')}<span class="nav-text">新建内容</span></button><button class="nav-button" data-action="find-task" title="查找任务">${icon('search')}<span class="nav-text">查找任务</span></button><button class="nav-button" data-action="library" title="客户资料库">${icon('library')}<span class="nav-text">客户资料库</span></button><a class="nav-button" href="/video/" title="独立视频工作区">${icon('video')}<span class="nav-text">视频工作区</span></a></nav>
    <div class="recent" id="recent"><h2>最近任务</h2>${tasks.length ? tasks.map(t => `<button class="task-row ${t.id === s.conversation?.id ? 'active' : ''}" data-task="${e(t.id)}" aria-describedby="task-tooltip">${e(t.title || '未命名内容')}</button>`).join('') : '<p class="empty-tasks">从一份资料开始。<br>创建后，任务会保存在这里。</p>'}</div>
    <div class="side-foot"><span class="local-avatar">方</span><span class="account">本机工作区<small>客户与稿件保存在本机</small></span>${iconButton('settings', '工作台设置', 'settings')}</div>
    <div class="resizer" id="sidebar-resizer" role="separator" aria-label="调整任务侧栏宽度" aria-orientation="vertical" tabindex="0" aria-valuemin="190" aria-valuemax="380" aria-valuenow="${s.ui.sidebarWidth}"></div></aside>`;
}
function topbar(s) {
  const a = currentArticle();
  return `<header class="topbar"><div class="task-heading"><strong>${e(s.conversation?.title || '新建内容')}</strong><span class="save-status" role="status">${s.dirty ? '草稿待保存' : s.saved ? '草稿已保存' : s.conversation ? '已从后台恢复' : '先选择客户，开始本次创作'}</span></div>
    <div class="mode-switch" role="group" aria-label="创作方式"><button data-action="mode-chat" class="${mode === 'chat' ? 'active' : ''}" aria-pressed="${mode === 'chat'}">对话创作</button><button data-action="mode-zip" class="${mode === 'zip' ? 'active' : ''}" aria-pressed="${mode === 'zip'}">分步创作</button></div>
    <div class="top-actions">${button('sources', '<span class="action-label">资料</span>', 'file', 'quiet', false, `aria-expanded="${panel === 'sources'}"`)}${button('review', '<span class="action-label">审阅</span>', 'review', 'quiet', !a, `aria-expanded="${panel === 'review'}"`)}${s.conversation?moreMenu('task-menu','任务更多操作',button('clone-task','复用为新任务',null,'quiet sm',client.activeJob||isOperationRunning())+button('archive-task','下载本地归档',null,'quiet sm',client.activeJob||isOperationRunning())+button('delete-task','删除任务',null,'quiet sm danger',client.activeJob||isOperationRunning())):''}${button('export', '导出', 'download', 'primary', !s.articles.some(a => !a.locked))}</div></header>`;
}
function notices(s) {
  const issues=optionIssues(s.options,client.platforms,client.targets);
  return `${s.bootstrap?.preview ? '<div class="preview-banner">离线接口预览 · 示例操作由本机替身响应 · 真实模型调用 0</div>' : ''}
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
function selectedDocs() { return client.state.library.filter(d => client.state.documentIds.some(id=>String(id)===String(d.id))); }
function sourceBlock() {
  return `<div class="sources-preview" id="source-dropzone" data-dropzone><div class="spread"><h2 class="section-title">客户资料</h2><div class="inline-actions">${button('upload', '上传文件', 'plus', 'quiet sm', importing)}${button('paste', '粘贴', null, 'quiet sm')}${button('library', '从库中选择', null, 'quiet sm')}</div></div>${docRows(selectedDocs(), { removable: true })}<p class="helper drop-hint">可拖入多个文件 · 点击每份资料核对和编辑正文 · 单份 8 MB</p></div>`;
}
function keywordEditor() {
  return `<section class="keyword-editor"><label class="field" for="keyword-entry"><span>目标搜索关键词</span></label><div class="reply-row"><input type="text" id="keyword-entry" placeholder="输入关键词，逗号可分隔多个">${button('add-keyword','添加关键词','plus','outline')}</div><div class="keyword-list">${client.state.options.keywords.map((word,index)=>`<div class="keyword-row"><input type="text" id="keyword-${index}" data-keyword-index="${index}" value="${e(word)}" aria-label="关键词 ${index+1}"><button type="button" class="button quiet sm" data-remove-keyword="${index}">移除</button></div>`).join('')}</div>${aliasHint()}<p class="helper">别名只在确认后合并，分组仍由原 ZIP 处理。</p>${button('detect-aliases','识别并确认别名',null,'quiet sm')}</section>`;
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
  const o = client.state.options;
  return `<details class="advanced" id="advanced-options" ${open ? 'open' : ''}><summary>完整选项</summary><div class="details-content">${mode==='chat'?keywordEditor():''}<div class="form-grid">
    <label class="field"><span>搜索后同时出现的品牌 / 公司</span><textarea class="input" id="option-rivals" data-option="rivals" placeholder="每行一个">${e((o.rivals || []).join('\n'))}</textarea><small>自家品牌与公司单独标记，仍按原 ZIP 规则从避用名单中排除。</small><div class="rival-list">${(o.rivals||[]).map((name,index)=>`<span class="rival-chip">${e(name)}${[currentClient()?.profile?.brand,currentClient()?.profile?.company].includes(name)?'（我方）':''}<button type="button" data-remove-rival="${index}" aria-label="移除 ${e(name)}">${icon('close')}</button></span>`).join('')}</div></label>
    <label class="field"><span>别名合并</span><textarea class="input" id="option-aliases" placeholder="每行一组，同组用逗号分隔">${e((o.aliases || []).map(g => Array.isArray(g) ? g.join('，') : g).join('\n'))}</textarea><small>例如：Cilbond 24，西邦24。由你确认后保存，不自动清空。</small>${aliasHint()}${button('detect-aliases','识别并确认别名',null,'quiet sm')}</label>
    <div class="field wide"><span>希望被谁搜到</span>${targetsBlock()}<small>目标 AI 的抓取偏好，与负责写作的模型分开。</small></div>
    <div class="field wide"><span>平台与篇数</span>${button('platforms', e(planSummary(o, client.platforms).text), 'settings', 'outline')}<small>官方号可使用档案中的联系方式；个人号沿用 ZIP 的身份规则。</small></div>
    <div class="field wide"><span>客户档案</span>${button('profile', currentClient() ? '编辑八项客户资料' : '创建客户档案', 'edit', 'quiet')}</div>
    <div class="field wide"><span>写作模型</span><div class="spread"><span>${e(client.state.model || 'deepseek-v4.1-flash')}</span>${button('settings', '写作设置', 'settings', 'quiet sm')}</div></div></div>
    <details id="inline-config"><summary>抓取偏好与风险清单</summary><div class="details-content">${configBlock()}</div></details></div></details>`;
}
function chatHistory() {
  const s = client.state, messages = s.conversation?.messages || [], result = s.results[OPERATION_KIND.chat];
  const question = result?.ready ? null : result?.questions?.[0];
  const qText = typeof question === 'string' ? question : question?.question || question?.text || question?.title;
  const choices = question?.options || question?.suggestions || [];
  return `${messages.length || result ? `<section class="conversation-log" aria-label="需求访谈"><h2>需求访谈</h2>${messages.filter(m => m.role !== 'system' && m.role !== 'tool').map(m => `<div class="message ${m.role === 'user' ? 'user' : 'assistant'}"><span class="message-label">${m.role === 'user' ? '你' : '需求助手'}</span>${e(interviewMessageText(m))}</div>`).join('')}
    ${result?.understanding&&!messages.some(m=>m.role==='assistant'&&interviewMessageText(m)===result.understanding) ? `<p class="message assistant">${e(valueText(result.understanding))}</p>` : ''}
    ${s.ui.followup && qText ? `<section class="question"><h3>${e(qText)}</h3><div class="question-options">${choices.map((opt, i) => {const label=typeof opt==='string'?opt:opt.text||opt.label||opt.value;return `<button data-answer="${i}" data-answer-text="${e(label)}">${e(label)}${label===question.recommended||opt.recommended===true?' · 推荐':''}</button>`;}).join('')}</div></section>` : result?.ready ? '<p class="helper">方向已清楚，可以开始写作，也可以继续补充。</p>' : ''}
    <div class="reply-row"><textarea class="input" id="chat-reply" aria-label="补充需求" placeholder="补充一句，或回答上面的问题">${e(s.ui.reply || '')}</textarea>${button('send-reply', '发送', 'arrow', 'primary', isOperationRunning() || operationBusy)}</div></section>` : ''}${operationRows()}`;
}
function operationRows(kinds=null) {
  return client.state.operations.filter(o => running(o) && o.kind!==OPERATION_KIND.writing&&(!kinds||kinds.includes(o.kind))).map(o => `<div class="operation-row" role="status"><span class="working-dot"></span><span>${e(({ interview:'正在理解需求',style_review:'正在通读审阅',style_rewrite:'正在生成候选并做一次只读复核',revision:'正在生成修改候选',zip_regenerate:'正在整篇重写并核查',zip_audit:'正在核查当前稿，可能修正正文' })[o.kind] || '后台正在处理')}</span><button class="text-button" data-stop-operation="${e(o.id)}">请求本地停止</button></div>`).join('');
}
function composeView() {
  const s = client.state, summary = planSummary(s.options, client.platforms);
  return `<section class="intro ${(s.conversation?.messages?.length || 0) ? 'has-messages' : ''}"><div class="intro-mark">${icon('logo')}</div><h1>这次想写什么？</h1><p class="intro-sub">放入资料，说说想介绍的产品、服务或问题。</p>${clientLine()}${sourceBlock()}
    <div class="composer"><textarea id="initial-input" aria-label="这次想写什么" placeholder="例如：根据客户资料，介绍产品用途与常见选型问题。">${e(s.options.note)}</textarea><div class="prompt-examples"><button data-prompt="0">产品或服务介绍</button><button data-prompt="1">常见问题解答</button><button data-prompt="2">客户与业务关系</button></div><div class="composer-toolbar">${iconButton('upload', '上传客户资料', 'plus')}<button class="platform-trigger" data-action="platforms">${icon('settings')}<span>${e(summary.text)}</span>${icon('chevron')}</button><span class="spacer"></span><button class="send-button" data-action="interview" aria-label="发送要求，继续聊聊" title="发送要求，继续聊聊" ${operationBusy || isOperationRunning() ? 'disabled' : ''}>${icon('arrow')}</button></div></div>
    <div class="composer-foot"><label class="check-label"><input type="checkbox" id="followup-enabled" ${s.ui.followup ? 'checked' : ''}>允许继续追问</label><div class="inline-actions">${s.articles.length ? button('articles', `查看 ${s.articles.length} 篇稿件`, null, 'quiet') : ''}${button('start', '直接开始写作', 'right', 'primary', client.activeJob || isOperationRunning() || operationBusy)}</div></div>
    <p class="file-hint">支持 DOCX、XLSX、PPTX、TXT、Markdown、CSV、JSON、HTML 与文字型 PDF · 单个文件 8 MB${importing ? ' · 正在解析上传…' : ''}</p>${expandedOptions()}${chatHistory()}</section>`;
}
function configBlock() {
  const cfg = client.state.config;
  if (!cfg) return `<p class="error-text">${e(client.state.configError || '配置尚未加载')}。${button('reload-config', '加载配置', null, 'quiet sm')}</p>`;
  const prefs = cfg.prefs || cfg.preferences || [], selectedP = client.platforms.filter(p => (client.state.options.selections || []).some(s => String(s.platform_id) === String(p.id)));
  const models = client.targets.filter(t => client.state.options.models.includes(t.name || t));
  const risks = cfg.risks || [];
  return `<p class="helper">原 ZIP 的有效抓取偏好与风险配置。调整用于后续写作；后台按启动快照处理在途任务。</p><details id="preference-matrix"><summary>目标 AI × 平台抓取偏好</summary><div class="matrix-scroll"><table class="matrix"><thead><tr><th scope="col">目标 AI</th>${selectedP.map(p => `<th scope="col">${e(p.name)}</th>`).join('')}</tr></thead><tbody>${models.map(m => `<tr><th scope="row">${e(m.name || m)}</th>${selectedP.map(p => { const pref = prefs.find(x => String(x.model_id) === String(m.id) && String(x.platform_id) === String(p.id)); return `<td><select aria-label="${e(m.name)} 对 ${e(p.name)} 的抓取偏好" data-pref-model="${e(m.id)}" data-pref-platform="${e(p.id)}">${[['high','高优先抓取'],['mid','中等抓取'],['low','低抓取']].map(([v,t]) => `<option value="${v}" ${(pref?.level || 'mid') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td>`; }).join('')}</tr>`).join('')}</tbody></table>${!selectedP.length ? '<p class="helper">选择平台后显示对应列。</p>' : ''}</div></details>
    <details id="risk-matrix"><summary>风险清单 · ${risks.length} 条</summary>${risks.filter(r => r.platform_id == null || selectedP.some(p => String(p.id) === String(r.platform_id))).map(r => `<div class="risk-row"><span class="risk-level">${e(r.level)}</span><div class="risk-main"><strong>${e(r.item)}</strong><p>${e(r.category)} · ${e(client.platforms.find(p => p.id === r.platform_id)?.name || '全平台通用')}</p><p>${e(r.tip)}</p></div><div class="risk-actions"><button data-edit-risk="${e(r.id)}">编辑</button><button data-delete-risk="${e(r.id)}">删除</button></div></div>`).join('')}${button('add-risk', '添加风险点', 'plus', 'quiet sm')}</details>
    ${button('config-admin', '管理平台、形态与目标 AI', 'settings', 'quiet sm')}`;
}
function stepper() { return `<ol class="stepper" aria-label="分步创作进度">${['资料与关键词','配置与风险','原生生成','编辑与导出'].map((title, i) => `<li class="${step === i + 1 ? 'active' : ''}"><button data-step="${i+1}" ${step === i + 1 ? 'aria-current="step"' : ''}><b>${i+1}</b><span>${title}</span></button></li>`).join('')}</ol>`; }
function zipView() {
  const s = client.state;
  if (step === 4) return stepper() + articleView();
  if (step === 3) return stepper() + liveView(true);
  if (step === 2) {
    const summary = planSummary(s.options, client.platforms);
    return `${stepper()}<section class="step-surface"><h1>确认安排，再开始写。</h1><p>目标 AI、平台和风险规则沿用原 ZIP 配置。</p><section class="step-section"><h2>发布平台与账号身份</h2><div class="spread"><div class="plan-summary"><strong>共 ${summary.count} 篇</strong>${e(summary.text)}</div>${button('platforms', '选择平台与形态', 'settings', 'outline')}</div></section><section class="step-section"><h2>希望被谁搜到</h2>${targetsBlock('zip-target')}<p class="helper">负责写作：${e(s.model)} ${button('settings','写作设置',null,'quiet sm')}</p></section>${configBlock()}<div class="step-actions">${button('step-1','上一步','back','quiet')}${button('start','开始原生写作','right','primary',client.activeJob || isOperationRunning() || operationBusy)}</div></section>`;
  }
  return `${stepper()}<section class="step-surface"><h1>先放资料，再定关键词。</h1><p>选择客户档案，保留这次创作所需的资料。</p>${clientLine()}<section class="step-section">${sourceBlock()}<p class="file-hint">原 ZIP 支持的文件走原生解析；PDF 在本机读取文字。单个文件 8 MB。</p></section>${keywordEditor()}<label class="field"><span>本次补充要求</span><textarea class="input" id="zip-note" data-option="note" placeholder="例如：重点介绍用途，面向初次了解的读者。">${e(s.options.note)}</textarea></label>${expandedOptions()}<div class="step-actions"><span class="helper">资料、参数、访谈与稿件在两种模式间共享。</span>${button('step-2','下一步：配置与风险','right','primary')}</div></section>`;
}
function liveView(inStep = false) {
  const s = client.state, stream = s.stream, job = s.job;
  const savedArticles=s.articles.filter(a=>a.current_version!=null);
  return `<section class="live-area"><div class="live-head"><span class="working-dot ${client.activeJob ? '' : 'idle'}"></span><strong>${client.activeJob ? '正在处理当前篇' : statusText(job?.status || 'idle')}</strong><span class="muted small">${Number(job?.done || stream.done || 0)} / ${Number(job?.planned || stream.planned || job?.total || planSummary(s.options,client.platforms).count)} 篇</span>${client.activeJob ? button('stop','暂停后续','stop','outline sm',job?.cancel) : button('start',s.articles.length ? '继续未完成安排' : '开始写作','right','primary',isOperationRunning() || operationBusy)+button('write-one','只写下一篇',null,'outline sm',isOperationRunning()||operationBusy)}</div><p class="live-status" role="status">${e(stream.message || job?.message || '确认资料与配置后，后台会逐篇写作。')}</p>${stream.platform ? `<p class="helper">${e(stream.platform)} · ${accountName(stream.account_type)} · ${e((stream.words || []).join('、'))}</p>` : ''}
    <div class="live-text" id="live-text" aria-label="当前篇只读原文">${e(stream.text || job?.partial || '等待后台原文…')}</div><p class="live-warning">${client.activeJob ? '当前篇只读，正在写作或核查。后台结束后解锁；已完成稿可单独编辑。' : stream.text && job?.status !== 'done' ? '以上是过程原文，请以稿件列表中已保存的成稿为准。' : '稿件与核查结果以后台保存状态为准。'}</p>${operationRows()}<div class="inline-actions">${button('new-requirement','补充后续要求',null,'quiet')}${button('compose','查看资料与安排',null,'quiet')}</div><section class="completed-list"><h2 class="section-title">已保存稿件 · ${savedArticles.length} 篇</h2>${savedArticles.length ? savedArticles.map(a => `<button data-select-article="${a.id}"><span>${e(a.title || '未命名稿件')}</span><small>${e(a.platform_name || a.platform || '')} · ${a.locked ? '处理中' : '可编辑'}</small></button>`).join('') : '<p class="empty">成稿保存后会出现在这里，过程原文不会冒充完成稿。</p>'}</section>${inStep ? `<div class="step-actions">${button('step-2','返回配置','back','quiet')}${button('step-4','编辑与导出','right','primary',!savedArticles.length)}</div>` : ''}</section>`;
}
function articleView() {
  const s = client.state, a = currentArticle();
  if (!a) return `<section class="empty large"><h2>还没有稿件。</h2><p>从资料与关键词开始，后台完成后在这里编辑和导出。</p>${button('compose','开始创作','plus','primary')}</section>`;
  selectedId = a.id; const editor = localEditor(a);
  const bodyLines=articleBody(a).split(/\r?\n/);if(bodyLines[0]?.replace(/^#\s+/,'').trim()===a.title?.trim()&&/^#\s+/.test(bodyLines[0]))bodyLines.shift();
  return `<div class="article-tabs" role="tablist" aria-label="本次稿件">${s.articles.map((art,i) => `<button class="article-tab ${art.id === a.id ? 'active' : ''}" id="article-tab-${art.id}" role="tab" tabindex="${art.id === a.id ? 0 : -1}" aria-controls="paper" aria-selected="${art.id === a.id}" data-select-article="${art.id}"><span class="article-dot ${art.locked ? 'locked' : ''}"></span>${e(art.platform_name || art.platform || '稿件')} · ${i+1}</button>`).join('')}${client.activeJob ? `<button class="article-tab" data-action="live"><span class="working-dot"></span>写作状态</button>` : ''}</div>
    <div class="editor-toolbar"><span class="muted">${e(a.version_label || `工作版本 ${a.current_version}`)}${a.locked ? ' · 正在处理，只读' : ''}</span><div class="inline-actions">${button('compose','需求与安排',null,'quiet sm')}${button('versions','版本','clock','quiet sm',a.locked)}${button('sources','资料','file','quiet sm')}${button('review','去 AI 味审阅','review','quiet sm',a.locked)}${button('edit-article',editor && !editor.reading ? '阅读正文' : '编辑正文','edit','quiet sm',a.locked)}${moreMenu('article-menu','稿件更多操作',button('native-regenerate','整篇重写并核查',null,'quiet sm',a.locked||client.activeJob||isOperationRunning()||operationBusy||editor?.dirty)+button('native-audit','再核查一次',null,'quiet sm',a.locked||client.activeJob||isOperationRunning()||operationBusy||editor?.dirty)+button('delete-article','删除这篇稿件',null,'quiet sm danger',a.locked||client.activeJob||isOperationRunning()||operationBusy||editor?.dirty))}</div></div>
    ${operationRows([OPERATION_KIND.regenerate,OPERATION_KIND.audit])}<article class="paper" id="paper" role="tabpanel" aria-labelledby="article-tab-${a.id}"><div class="paper-meta"><span>${e(a.platform_name || a.platform || '')} · ${accountName(a.account_type)}${a.fmt ? ` · ${e(a.fmt)}` : ''}</span><span>${a.review ? (a.review.status==='unverified'?'本版本尚未模型核查':a.origin?.startsWith('zip')?'原生模型核查记录可查看':'模型复核记录可查看') : '此版本无核查记录'}</span></div>
    ${editor && !editor.reading ? `<label class="field"><span class="small muted">标题</span><input type="text" id="article-title" class="title-input" value="${e(editor.title)}" ${a.locked ? 'disabled' : ''}></label><label class="field"><span class="small muted">正文 · Markdown</span><textarea id="article-body" class="body-input" ${a.locked ? 'readonly' : ''}>${e(editor.body)}</textarea></label><details id="article-metadata"><summary>标签与声明</summary><div class="details-content"><label class="field"><span>标签 · 空格或逗号分隔</span><input type="text" id="article-tags" value="${e(editor.tags??(a.tags||[]).join(' '))}" ${a.locked?'disabled':''}></label><label class="field"><span>声明 · 每行一条</span><textarea class="input" id="article-decl" ${a.locked?'readonly':''}>${e(editor.decl??(a.decl||[]).join('\n'))}</textarea><small>清空后保存即可移除此版本的标签或声明。</small></label></div></details>` : `<h1>${e(a.title || '未命名稿件')}</h1><div>${markdown(bodyLines.join('\n'))}</div>`}
    <footer class="paper-foot"><span>${editor?.dirty ? '有未保存的人工编辑' : '当前采用版 · 用于默认导出'}</span><span>${(editor?.body ?? articleBody(a)).replace(/\s/g,'').length.toLocaleString()} 字</span></footer></article>
    ${editor ? `<div class="editor-save"><p>${editor.base !== a.current_version ? '后台版本已改变，请先保留编辑并核对版本。' : '保存为新工作版本；原 ZIP 生成参考仍保留。'}</p>${button('save-article','保存新版本','check','primary',a.locked || !editor.dirty)}${button('end-edit','结束编辑',null,'quiet')}</div>` : ''}
    <div class="revision-box"><div class="reply-row"><textarea class="input" id="revise-instruction" aria-label="对当前稿的修改要求" placeholder="修改当前稿，例如：开头直接说明用途。">${e(s.ui.revisionInstruction || '')}</textarea>${button('revise','修改当前稿','arrow','primary',a.locked || isOperationRunning() || operationBusy || !!editor?.dirty)}</div><p class="revision-note">生成修改候选，明确采用后切换正文与导出版本。${button('new-requirement','调整后续生成要求',null,'quiet sm')}</p></div>`;
}
function sourcesPanel() {
  const s = client.state, c = currentClient(), a = currentArticle(), summary = planSummary(s.options, client.platforms);
  return `<h3>本次资料</h3>${docRows(selectedDocs())}<div class="inline-actions">${button('upload','上传','plus','quiet sm')}${button('paste','粘贴',null,'quiet sm')}${button('library','资料库',null,'quiet sm')}</div><h3>客户档案</h3>${c ? `<dl class="plain-dl">${PROFILE_FIELDS.map(([key,label]) => `<div><dt>${label}</dt><dd>${e(key === 'name' ? c.name : c.profile?.[key] || '未填写')}</dd></div>`).join('')}</dl>${button('profile','编辑档案',null,'quiet sm')}` : button('choose-client','选择客户',null,'outline')}<h3>本次要求</h3><p>${e(s.options.note || '尚未填写')}</p><h3>任务安排</h3><dl class="plain-dl"><div><dt>关键词</dt><dd>${e(s.options.keywords.join('、') || '未填写')}</dd></div><div><dt>平台</dt><dd>${e(summary.text)}</dd></div><div><dt>计划篇数</dt><dd>${summary.count}</dd></div><div><dt>目标 AI</dt><dd>${e(s.options.models.join('、'))}</dd></div><div><dt>写作模型</dt><dd>${e(s.model)}</dd></div></dl>${a?.review ? `<details id="native-review"><summary>当前版本核查记录</summary><div class="fact-report">${e(valueText(a.review))}</div></details>` : ''}${nativeArticleInfo(a)}${a ? `<h3>视频</h3><a class="button outline" href="/video/?client_id=${encodeURIComponent(c?.id || '')}&article_id=${a.id}&version_id=${a.current_version}">${icon('video')}制作视频</a><p class="helper">绑定当前采用版本 ${a.current_version}。使用此版本进入独立视频工作区。</p>` : ''}`;
}
function reviewPanel() {
  const a=currentArticle();if(!a)return '<p class="empty">成稿完成后，可在这里手动审阅。</p>';
  const r=reviewFor(a),stale=r&&r.base_version!==a.current_version;
  if(r&&selectedReviewId!==r.operation_id){const defaults=reviewDefaults(r);selectedSuggestions=new Set(defaults.selected);rewriteMode=defaults.mode;selectedReviewId=r.operation_id;}
  const suggestions=r?.suggestions||[];
  const tiers={1:'第 1 档 · 优先修改',2:'第 2 档 · 建议修改',3:'第 3 档 · 可选斟酌'};
  return `<p>通读当前稿，选择建议后生成候选。</p>${button('run-review',r?'重新通读当前版':'开始文风审阅','review','primary',a.locked||isOperationRunning()||operationBusy)}${operationRows([OPERATION_KIND.review,OPERATION_KIND.rewrite,OPERATION_KIND.revise])}
    ${r?`<p class="helper">${e(r.reviewer)} · 基于版本 ${e(r.base_version)}${stale?'；当前版本已变化，请重新审阅。':''}</p><p>${e(r.assessment)}</p><h3>修改建议 · ${suggestions.length} 条</h3>${suggestions.map((item,index)=>{const id=String(item.id??index);return `<section class="suggestion"><label><input type="checkbox" data-suggestion="${e(id)}" ${selectedSuggestions.has(id)?'checked':''} ${stale?'disabled':''}><span><h4>${e(item.signal)}</h4><small>${e(tiers[item.tier]||item.tier)} · ${e(item.scope)}${item.requires_material?' · 需补充资料':''}</small><blockquote>${e(item.quote)}</blockquote><p><strong>问题：</strong>${e(item.problem)}</p><p><strong>建议：</strong>${e(item.proposal)}</p></span></label></section>`;}).join('')||'<p class="helper">当前未列出具体修改建议。</p>'}
    <div class="observations"><h3>观察项 · 不默认勾选</h3>${(r.observations||[]).map(item=>`<section class="suggestion"><h4>${e(item.id)} · ${e(item.signal)}</h4><small>${e(item.position)}</small><blockquote>${e(item.quote)}</blockquote><p>${e(item.reason)}</p><p>${e(item.proposal)}</p></section>`).join('')||'<p>没有额外观察项。</p>'}</div><hr><label class="field"><span>修改范围</span><select id="rewrite-mode"><option value="full" ${rewriteMode==='full'?'selected':''}>允许全文重组（默认）</option><option value="standard" ${rewriteMode==='standard'?'selected':''}>标准调整</option><option value="light" ${rewriteMode==='light'?'selected':''}>轻量修改</option></select></label><label class="field" style="margin-top:16px"><span>补充材料 / 编辑意见</span><textarea class="input" id="rewrite-material" placeholder="可补充认可的表达或真实资料">${e(client.state.ui.rewriteMaterial||'')}</textarea></label><p class="helper">候选完成后自动做一次只读模型复核。是否采用，由你决定。</p>${button('rewrite','生成候选并做模型复核',null,'primary',a.locked||stale||isOperationRunning()||operationBusy)}
    ${r.candidate?button('open-candidate','查看已有候选与差异',null,'outline'):''}`:'<p class="helper">审阅按需开始，不会自动修改或覆盖成稿。</p>'}`;
}
function versionsPanel() {
  const a = currentArticle(), data = a && versionsData[a.id];
  return `${a ? `<p>原生初稿、ZIP 成稿、人工版本与候选均保留。当前导出采用版本 ${a.current_version}。</p>${button('load-versions','刷新版本',null,'quiet sm')}${data ? (data.versions || []).map(v => `<section class="version-row"><h3>${e(v.label || v.origin || '工作版本')} ${v.id === a.current_version ? '<span class="version-current">当前采用</span>' : ''}</h3><small>版本 ${v.id} · ${e(v.created_at || '')}</small><div class="inline-actions">${button('version-preview','查看全文与差异',null,'quiet sm',false,`data-version="${v.id}"`)}${v.id !== a.current_version ? button('version-select',['style','revision'].includes(v.origin) ? '采用候选' : '恢复此版',null,'outline sm',a.locked,`data-version="${v.id}"`) : ''}</div></section>`).join('') : '<p class="helper">正在加载版本…</p>'}` : '<p class="empty">还没有稿件。</p>'}`;
}
function settingsPanel() {
  const s = client.state, settings = s.bootstrap?.settings || {}, models = s.bootstrap?.provider_models || [];
  const names = models.map(m => typeof m === 'string' ? m : m.id || m.name);
  if (!names.includes(s.model)) names.unshift(s.model);
  return `<h3>写作模型</h3><label class="field"><span>WorkBuddy 模型</span><select id="setting-model">${names.map(name => `<option ${name === s.model ? 'selected' : ''} value="${e(name)}">${e(name)}${models.length && !models.some(m => (typeof m === 'string' ? m : m.id || m.name) === name) ? '（当前目录未确认）' : ''}</option>`).join('')}</select></label><p class="helper">默认 DeepSeek V4.1 Flash。模型可用性由后台核对，不会静默换模型。</p>${button('provider-models','查询可用模型',null,'quiet sm')}<div class="form-grid" style="margin-top:20px"><label class="field"><span>Temperature</span><input type="number" id="setting-temperature" min="0" max="2" step="0.1" value="${e(settings.temperature ?? 0.7)}"></label><label class="field"><span>最大输出 Token</span><input type="number" id="setting-max-tokens" min="256" max="65536" step="1" value="${e(settings.max_tokens || 8192)}"></label><label class="check-label field wide"><span><input type="checkbox" id="setting-title-prefix" ${settings.title_prefix ? 'checked' : ''}>标题附平台与账号前缀</span></label></div><div class="inline-actions" style="margin-top:20px">${button('save-settings','保存写作设置',null,'primary')}</div><label class="field" style="margin-top:20px"><span>默认品牌</span><input type="text" id="setting-brand" value="${e(settings.brand||'')}" placeholder="客户品牌未填时沿用原 ZIP 默认值"></label><label class="check-label" style="margin-top:14px"><input type="checkbox" id="setting-disable-thinking" ${settings.disable_thinking?'checked':''}>关闭模型深度思考</label><h3>ZIP 完整配置</h3>${button('config-admin','管理平台与目标 AI','settings','outline')}<p class="helper">平台形态、身份、风格、篇幅、结构与受众均可查看和修改。抓取偏好与风险清单在创作选项中展开。</p><h3>能力状态</h3><p class="unavailable">本机客户与文稿管理已接线。联网补充、账户注册、支付、自动发布尚未开放。</p>`;
}
function inspector() {
  if (!panel) return '';
  const titles = { sources: '资料与要求', review: '文风审阅', versions: '稿件版本', settings: '工作台设置' };
  return `<aside class="inspector" aria-label="${titles[panel]}"><header class="inspector-head"><h2>${titles[panel]}</h2>${iconButton('close-panel','关闭辅助面板','close')}</header><div class="inspector-body" id="inspector-body">${({ sources:sourcesPanel, review:reviewPanel, versions:versionsPanel, settings:settingsPanel })[panel]()}</div></aside>`;
}

function render() {
  if (composing) { renderPending = true; return; }
  const active = document.activeElement, focusId = active?.id, focusAction=active?.dataset.action;
  const rawValue=active?.matches('textarea,input[type=text]')?active.value:null;
  const selection = active?.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
  const scrolls = ['workspace','recent','inspector-body'].map(id => [id,$('#'+id)?.scrollTop || 0]);
  const details = new Map($$('details[id]', $('#root')).map(d => [d.id,d.open]));
  const s = client.state;
  if (s.conversation?.id !== lastTask) {
    lastTask = s.conversation?.id; reviews = {}; versionsData = {}; selectedId = null;selectedReviewId=null;
    surface = client.activeJob ? 'live' : s.articles.length ? 'articles' : 'compose';
    step = client.activeJob ? 3 : s.articles.length ? 4 : 1;
  }
  if (!s.bootstrap) {
    $('#root').innerHTML = `<div class="boot-state"><h1>方立</h1><p>${e(s.error || '正在打开工作台…')}</p>${s.loaded ? '<p>请确认本机工作台服务已启动，然后刷新页面。</p>' : ''}</div>`; return;
  }
  document.documentElement.style.setProperty('--sidebar', `${s.ui.sidebarWidth}px`);
  $('#root').innerHTML = `<div class="app ${s.ui.collapsed ? 'collapsed' : ''}">${sidebar(s)}<button class="mobile-scrim" data-action="collapse" aria-label="关闭任务导航"></button><main class="main">${topbar(s)}${notices(s)}<div class="content-wrap"><div class="workspace" id="workspace" tabindex="-1">${mode === 'zip' ? zipView() : surface === 'live' ? liveView() : surface === 'articles' ? articleView() : composeView()}</div>${inspector()}</div></main></div>`;
  for (const [id, open] of details) if ($('#'+id)) $('#'+id).open = open;
  for (const [id, top] of scrolls) if ($('#'+id)) $('#'+id).scrollTop = top;
  const focusTarget=focusId?$('#'+CSS.escape(focusId)):focusAction?$(`[data-action="${CSS.escape(focusAction)}"]`):null;
  if (focusTarget) {
    const next = focusTarget;if(rawValue!==null)next.value=rawValue; next.focus({ preventScroll: true });
    if (selection && next.setSelectionRange && !['number','checkbox'].includes(next.type)) try { next.setSelectionRange(...selection); } catch {}
  }
  bindResize();
}
client.subscribe(()=>{syncAliasCandidates();render();});
document.addEventListener('compositionstart', () => composing = true);
document.addEventListener('compositionend', () => { composing = false; if (renderPending) { renderPending = false; render(); } });

async function requireTask() {
  if (client.state.conversation) return true;
  chooseClient(); return false;
}
function chooseClient() {
  const clients = client.state.clients;
  dialog('选择本次客户', `<p class="helper">一个任务对应一个客户。选择后创建新的内容任务。</p>${clients.length ? `<label class="field"><span>已有客户</span><select name="client_id">${clients.map(c => `<option value="${e(c.id)}">${e(c.name)}</option>`).join('')}</select></label>` : '<p class="empty">还没有客户档案，先创建第一位客户。</p>'}<div style="margin-top:20px">${button('new-client','创建客户档案','plus','outline')}</div>`, clients.length ? async data => { const c = await client.createConversation(data.get('client_id')); history.replaceState(null,'',`${location.pathname}?conversation=${encodeURIComponent(c.id)}`); panel = null; render(); } : null, { label:'创建任务' });
}
function profileDialog(edit = false) {
  const c = edit ? currentClient() : null;
  const fields = PROFILE_FIELDS.map(([key,label]) => `<label class="field ${['products','address'].includes(key) ? 'wide' : ''}"><span>${label}${key === 'name' ? ' *' : ''}</span><input type="text" name="${key}" value="${e(key === 'name' ? c?.name || '' : c?.profile?.[key] || '')}" ${key === 'name' ? 'required maxlength="160"' : 'maxlength="2000"'}></label>`).join('');
  dialog(c ? '客户档案' : '创建客户档案', `<p class="helper">品牌、公司与产品分别填写；未填写的业务事实保持为空。</p><div class="form-grid">${fields}</div>`, async data => {
    const name = String(data.get('name')).trim(); if (!name) throw new Error('请填写客户或项目名称');
    const profile = Object.fromEntries(PROFILE_FIELDS.filter(([key]) => key !== 'name').map(([key]) => [key, String(data.get(key)||'').trim()]));
    const saved = c ? await client.updateProfile(name,profile) : await client.createClient(name, profile);
    if (!c) { const task = await client.createConversation(saved.id); history.replaceState(null,'',`${location.pathname}?conversation=${encodeURIComponent(task.id)}`); }
    toast('客户档案已保存');
  }, { label:c ? '保存档案' : '保存并创建任务' });
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
  if (!await requireTask()) return;
  importing = true; render(); const failures = [];
  for (const file of files) {
    try { const document = await parseFile(file, client.api.bind(client)); await client.addDocument(document); }
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
  dialog('客户资料库',`<p class="helper">${e(currentClient()?.name)} · 仅选择本次要使用的资料。</p><div class="library-list">${client.state.library.map(doc=>`<label><input type="checkbox" name="documents" value="${e(doc.id)}" ${client.state.documentIds.some(id=>String(id)===String(doc.id)) ? 'checked' : ''}><span>${e(doc.filename)}<small>${e(doc.kind)} · ${(doc.text||'').length.toLocaleString()} 字</small></span></label>`).join('') || '<p class="empty">资料库为空，先上传文件或粘贴正文。</p>'}</div>`,async data=>{ client.selectDocuments(data.getAll('documents').map(id=>client.state.library.find(d=>String(d.id)===String(id))?.id ?? id)); await client.saveDraft(); },{label:'使用所选资料'});
}
function showDocument(id) {
  const doc=client.state.library.find(x=>String(x.id)===String(id)); if(!doc)return;
  dialog(`核对资料：${doc.filename}`,`<p class="helper">${e(doc.kind)} · 可直接修正解析文字。保存修订后，本次任务改用修订文本；旧资料与已冻结的生成输入保留。</p><label class="field"><span>资料正文</span><textarea class="input" id="document-text" name="text" rows="16">${e(doc.text)}</textarea></label><p class="helper" id="document-char-count">${doc.text.length.toLocaleString()} 字</p>`,async data=>{await client.reviseDocument(id,String(data.get('text')));toast('资料修订已保存，本次任务已使用修订正文');},{label:'保存资料修订'});
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
  await client.start({confirmed,one}); surface='live'; step=3; render();
}
async function interview(text) {
  if(!await requireTask())return;
  const cid=client.state.conversation.id;
  operationBusy=true; render();
  try { const result=await client.chat(text);if(!result||client.state.conversation?.id!==cid)return; client.state.ui.reply=''; toast('需求已保存，可继续补充或直接开始'); }
  finally {operationBusy=false;render();}
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
  operationBusy=true;render();
  try {
    if(kind==='style-review') {
      const r=await client.articleOperation(a.id,kind);if(!r||client.state.conversation?.id!==cid)return; reviews[a.id]=r;const defaults=reviewDefaults(r);selectedSuggestions=new Set(defaults.selected);rewriteMode=defaults.mode;selectedReviewId=r.operation_id; panel='review';
    } else if(kind==='style-rewrite') {
      const r=reviewFor(a);if(!r || r.base_version!==a.current_version)throw new Error('当前版本需要先重新审阅');
      const selected=[...selectedSuggestions].map(id=>{const index=(r.suggestions||[]).findIndex((item,i)=>String(item.id??i)===id);return r.suggestions[index]?.id??index;});
      const result=await client.articleOperation(a.id,kind,{ review_id:r.review_id||r.operation_id,selected,mode:rewriteMode,material:client.state.ui.rewriteMaterial||'' });
      if(!result||client.state.conversation?.id!==cid)return;
      r.candidate=result.candidate_version; await compareDialog(a.id,result.candidate_version,result);
    } else {
      const instruction=client.state.ui.revisionInstruction?.trim();if(!instruction)throw new Error('请填写对当前稿的修改要求');
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
  dialog('版本全文与差异',`<p class="helper">候选未采用前，默认查看与导出仍使用当前采用版 ${a.current_version}。</p><div class="compare-grid"><section><h3>原稿 · 版本 ${e(data.base?.id||data.base?.version_id||a.current_version)}</h3><div class="compare-copy">${e(base.title||a.title)}\n\n${e(articleBody(base))}</div></section><section><h3>候选 / 历史稿 · 版本 ${e(candidate)}</h3><div class="compare-copy">${e(next.title)}\n\n${e(articleBody(next))}</div></section></div><details id="compare-diff" open><summary>前后差异</summary><pre class="diff-text">${e(valueText(data.diff||result.changes||'服务端未提供差异摘要，请对照两侧全文。'))}</pre></details><details id="candidate-fact" open><summary>${fact.readonly===true?'一次只读模型复核':['zip','zip_initial','zip_regenerate','zip_regenerate_draft','zip_audit'].includes(data.candidate?.origin)?'原生事实核查 · 可修正正文':'此版本核查状态'}</summary><div class="fact-report">${factMarkup(fact)}</div></details>${changes.length?`<details id="candidate-changes"><summary>模型修改清单 · ${changes.length} 条</summary>${changes.map(text=>`<p>${e(text)}</p>`).join('')}</details>`:''}${skipped.length?`<details id="candidate-skipped"><summary>其他处理说明 · 原返回</summary>${skipped.map(text=>`<p>${e(text)}</p>`).join('')}</details>`:''}<section class="saved-review"><h3>实际审阅记录</h3><div class="review-text">${records.codex_review?markdown(records.codex_review):'<p class="helper">尚无 Codex 意见记录。</p>'}</div>${records.user_review?`<h4>用户意见</h4><div class="review-text">${markdown(records.user_review)}</div>`:'<p class="helper">用户尚未提交审阅意见。</p>'}</section><details id="edit-review-record"><summary>编辑意见记录</summary><div class="form-grid record-grid"><label class="field"><span>Codex 审阅意见 · 真实记录</span><textarea class="input" name="codex_review" placeholder="尚未提交 Codex 意见；有真实审阅后再记录。">${e(records.codex_review||'')}</textarea></label><label class="field"><span>你的意见</span><textarea class="input" name="user_review" placeholder="记录你认可或仍需调整的地方">${e(records.user_review||'')}</textarea></label></div><div class="inline-actions" style="margin-top:14px"><button type="button" class="button outline" id="save-review-record">保存双方意见</button><span id="record-status" class="helper">${records.codex_review ? '已有 Codex 意见记录' : '尚无 Codex 意见记录'}</span></div></details>`,a.current_version===candidate ? null : async()=>{if(localEditor(a)?.dirty)throw new Error('请先保存人工编辑，再采用版本');await client.selectVersion(aid,candidate);versionsData[aid]=null;toast('已明确采用，此版本用于默认导出');},{wide:true,label:'采用此版并用于导出'});
  $('#save-review-record').onclick=()=>act(async()=>{await client.reviewRecord(aid,{candidate_version:candidate,codex_review:$('[name=codex_review]',modal).value,user_review:$('[name=user_review]',modal).value});$('#record-status').textContent='双方意见已留档';});
}
async function exportDialog() {
  const articles=client.state.articles.filter(a=>!a.locked);
  const omitted=client.state.ui.exportOmitted?.[client.state.conversation.id]||[];
  dialog('导出当前采用稿',`<p class="helper">导出默认使用 ZIP 成稿；人工保存或明确采用候选后，使用相应采用版。</p><label class="field"><span>格式</span><select name="fmt"><option value="docx">Word（DOCX）</option><option value="md">Markdown</option><option value="txt">纯文本</option><option value="json">JSON</option></select></label><div class="inline-actions"><button type="button" class="button quiet sm" data-export-pick="all">全选</button><button type="button" class="button quiet sm" data-export-pick="none">全不选</button><button type="button" class="button quiet sm" data-export-pick="good">仅选自检 ≥85 分</button></div><div class="library-list">${articles.map(a=>`<label><input type="checkbox" name="ids" value="${a.id}" ${omitted.includes(String(a.id))?'':'checked'}><span>${e(a.title)}<small>${e(a.platform_name||a.platform||'')} · ${accountName(a.account_type)} · 版本 ${a.current_version} · 自检 ${Number(a.geo?.score)||0} 分</small></span></label>`).join('')}</div>`,async data=>{const ids=data.getAll('ids');if(!ids.length)throw new Error('至少选择一篇稿件');const fmt=data.get('fmt');const url=client.path(`/export?fmt=${encodeURIComponent(fmt)}&ids=${ids.map(encodeURIComponent).join(',')}`);const response=await fetch(url);if(!response.ok){let d;try{d=await response.json();}catch{}throw new Error(d?.error||'导出失败，请确认后台状态');}const blob=await response.blob();const link=document.createElement('a'),objectUrl=URL.createObjectURL(blob);link.href=objectUrl;link.download=`方立-${client.state.conversation.id}.${fmt}`;link.click();setTimeout(()=>URL.revokeObjectURL(objectUrl),2000);toast('已导出所选采用版本');},{label:'导出文件'});
}
function rememberExportSelection() {
  const omitted=$$('input[name="ids"]',modal).filter(input=>!input.checked).map(input=>input.value);
  client.state.ui.exportOmitted={...client.state.ui.exportOmitted,[client.state.conversation.id]:omitted};client.persist();
}
async function reloadConfig() {client.state.config=await client.api('/api/workbench/zip-config');client.state.configError='';render();}
async function saveSettings() {
  const model=$('#setting-model').value,temperature=Number($('#setting-temperature').value),max_tokens=Number($('#setting-max-tokens').value),title_prefix=$('#setting-title-prefix').checked,brand=$('#setting-brand').value,disable_thinking=$('#setting-disable-thinking').checked;
  if(!Number.isFinite(temperature)||temperature<0||temperature>2||!Number.isInteger(max_tokens)||max_tokens<256||max_tokens>65536)throw new Error('请填写有效的温度（0—2）与最大 Token（256—65536）');
  const d=await client.api('/api/workbench/settings','POST',{model,temperature,max_tokens,title_prefix,brand,disable_thinking});client.state.bootstrap.settings={...client.state.bootstrap.settings,...d.settings,model,temperature,max_tokens,title_prefix,brand,disable_thinking};client.state.model=model;client.emit();toast('写作设置已保存');
}
function configAdmin() {
  const platforms=client.platforms,targets=client.targets;
  dialog('平台与目标 AI 配置',`<details id="admin-platforms" open><summary>分发平台 · ${platforms.length}</summary>${platforms.map(p=>`<div class="admin-row spread"><div><strong>${e(p.name)}</strong><p class="helper">${accountName(p.account_type)} · ${e((p.formats||[]).join(' / '))} · ${enabled(p)?'已启用':'已停用'}</p></div><div class="inline-actions"><button type="button" class="button quiet sm" data-edit-platform="${p.id}">编辑完整配置</button><button type="button" class="button quiet sm" data-delete-platform="${p.id}">删除</button></div></div>`).join('')}<button type="button" class="button outline" data-action="add-platform">添加平台</button></details><details id="admin-targets"><summary>希望被谁搜到 · 目标 AI</summary>${targets.map(t=>`<div class="admin-row spread"><div><strong>${e(t.name||t)}</strong><small> ${enabled(t)?'已启用':'已停用'}</small></div><div class="inline-actions"><button type="button" class="button quiet sm" data-edit-target="${t.id}">编辑</button><button type="button" class="button quiet sm" data-delete-target="${t.id}">删除</button></div></div>`).join('')}<button type="button" class="button outline" data-action="add-target">添加目标 AI</button></details>`,null);
}
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
  for(const menu of $$('.toolbar-menu[open]'))if(!menu.contains(event.target))menu.open=false;
  const exportPick=event.target.closest('[data-export-pick]');
  if(exportPick){for(const input of $$('input[name="ids"]',modal))input.checked=exportPick.dataset.exportPick==='all'||exportPick.dataset.exportPick==='good'&&Number(client.article(input.value)?.geo?.score)>=85;rememberExportSelection();return;}
  const actionButton=event.target.closest('[data-action]');
  if(actionButton) {
    const action=actionButton.dataset.action;
    const actions={
      collapse:()=>client.setUI({collapsed:!client.state.ui.collapsed}),
      'new-task':chooseClient,'choose-client':chooseClient,'new-client':()=>profileDialog(false),profile:()=>currentClient()?profileDialog(true):profileDialog(false),
      'find-task':()=>{dialog('查找任务',`<label class="field"><span>任务标题</span><input type="text" id="task-search" placeholder="输入标题关键词"></label><div id="task-search-results" class="library-list">${client.state.conversations.map(t=>`<button type="button" class="task-row" data-task="${e(t.id)}">${e(t.title||'未命名内容')}</button>`).join('')||'<p class="empty">还没有已保存任务。</p>'}</div>`,null);$('#task-search').oninput=event=>{$$('[data-task]',$('#task-search-results')).forEach(b=>b.hidden=!b.textContent.toLowerCase().includes(event.target.value.toLowerCase()));};},
      'mode-chat':()=>switchMode('chat'),'mode-zip':()=>switchMode('zip'),platforms:platformDialog,upload,paste,library,
      sources:()=>{panel=panel==='sources'?null:'sources';render();},review:()=>{panel=panel==='review'?null:'review';render();},settings:()=>{panel='settings';render();},'close-panel':()=>{panel=null;render();},
      compose:()=>{surface='compose';step=1;render();},articles:()=>{surface='articles';step=4;render();},live:()=>{surface='live';step=3;render();},
      'step-1':()=>setStep(1),'step-2':()=>setStep(2),'step-4':()=>setStep(4),
      'add-keyword':addKeyword,'detect-aliases':detectAliases,
      start:()=>client.state.needsConfirmation?confirmPlan():start(),'write-one':()=>client.state.needsConfirmation?confirmPlan(true):start(false,true),stop:async()=>{await client.stop();toast('已请求暂停后续，当前篇继续收尾');},'confirm-plan':()=>confirmPlan(),'new-requirement':newRequirement,
      'clone-task':async()=>{const task=await client.cloneConversation();history.replaceState(null,'',`${location.pathname}?conversation=${encodeURIComponent(task.id)}`);panel=null;toast('已复用当前安排，创建未生成的新任务');},'delete-task':deleteTaskDialog,'archive-task':archiveTask,
      'native-regenerate':()=>nativeActionDialog('regenerate'),'native-audit':()=>nativeActionDialog('audit'),'delete-article':deleteArticleDialog,
      interview:()=>interview(client.state.options.note),'send-reply':()=>interview(client.state.ui.reply||''),
      'dismiss-error':()=>{client.state.error='';render();},recover:async()=>{await client.reload();client.state.error='';client.resumeBackground();render();},
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
  const task=event.target.closest('[data-task]'); if(task)act(async()=>{if(client.state.dirty)await client.saveDraft();await client.load(task.dataset.task);history.replaceState(null,'',`${location.pathname}?conversation=${encodeURIComponent(task.dataset.task)}`);modal.close();if(innerWidth<=760)client.setUI({collapsed:true});});
  const doc=event.target.closest('[data-doc]');if(doc)showDocument(doc.dataset.doc);
  const remove=event.target.closest('[data-remove-doc]');if(remove)client.selectDocuments(client.state.documentIds.filter(id=>String(id)!==remove.dataset.removeDoc));
  const answer=event.target.closest('[data-answer]');if(answer)act(()=>interview(answer.dataset.answerText));
  const prompt=event.target.closest('[data-prompt]');if(prompt){const texts=['根据已选客户资料，介绍产品或服务的特点、适用对象与使用条件。','围绕资料中的产品或服务，解答目标读者关心的常见问题。','根据客户资料，介绍公司与品牌、产品或服务的真实业务关系。'];client.setOptions({note:texts[Number(prompt.dataset.prompt)]});$('#initial-input')?.focus();}
  const stepButton=event.target.closest('[data-step]');if(stepButton)act(()=>setStep(Number(stepButton.dataset.step)));
  const article=event.target.closest('[data-select-article]');if(article){selectedId=Number(article.dataset.selectArticle);surface='articles';step=4;panel=null;render();}
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
  if(el.dataset.keywordIndex!=null){const keywords=[...client.state.options.keywords];keywords[Number(el.dataset.keywordIndex)]=el.value;client.setOptions({keywords});}
  else if(el.id==='initial-input')client.setOptions({note:el.value});
  else if(el.dataset.option)client.setOptions({[el.dataset.option]:['keywords','rivals'].includes(el.dataset.option)?splitWords(el.value):el.value});
  else if(el.id==='option-aliases')client.setOptions({aliases:el.value.split(/\n/).map(splitWords).filter(g=>g.length>1)});
  else if(['article-title','article-body','article-tags','article-decl'].includes(el.id)){const a=currentArticle(),ed=localEditor(a);if(!ed||a.locked)return;ed[({'article-title':'title','article-body':'body','article-tags':'tags','article-decl':'decl'})[el.id]]=el.value;ed.dirty=true;client.persist();const save=$('[data-action=save-article]');if(save)save.disabled=false;}
  else if(el.id==='chat-reply'){client.state.ui.reply=el.value;client.persist();}
  else if(el.id==='revise-instruction'){client.state.ui.revisionInstruction=el.value;client.persist();}
  else if(el.id==='rewrite-material'){client.state.ui.rewriteMaterial=el.value;client.persist();}
});
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.name==='ids'&&modal.contains(el))rememberExportSelection();
  if(el.dataset.target){const models=client.state.options.models.filter(m=>m!==el.dataset.target);if(el.checked)models.push(el.dataset.target);client.setOptions({models});}
  if(el.id==='followup-enabled')client.setUI({followup:el.checked});
  if(el.dataset.suggestion){if(el.checked)selectedSuggestions.add(el.dataset.suggestion);else selectedSuggestions.delete(el.dataset.suggestion);}
  if(el.id==='rewrite-mode')rewriteMode=el.value;
  if(el.dataset.prefModel)act(async()=>{await client.api('/api/prefs','POST',{model_id:Number(el.dataset.prefModel),platform_id:Number(el.dataset.prefPlatform),level:el.value});const prefs=client.state.config.prefs||client.state.config.preferences||[];const pref=prefs.find(p=>String(p.model_id)===el.dataset.prefModel&&String(p.platform_id)===el.dataset.prefPlatform);if(pref)pref.level=el.value;else prefs.push({model_id:Number(el.dataset.prefModel),platform_id:Number(el.dataset.prefPlatform),level:el.value});toast('抓取偏好已保存');});
});
async function switchMode(nextMode) {
  if(nextMode===mode)return;
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
function hideTooltip(){clearTimeout(tooltipTimer);$('#task-tooltip').hidden=true;}
function showTooltip(button) {
  clearTimeout(tooltipTimer);tooltipTimer=setTimeout(()=>{const t=client.state.conversations.find(x=>x.id===button.dataset.task);if(!t)return;const box=$('#task-tooltip'),rect=button.getBoundingClientRect();box.innerHTML=`<strong>${e(t.title||'未命名内容')}</strong><dl class="plain-dl"><div><dt>创建时间</dt><dd>${e(t.created_at||'未记录')}</dd></div><div><dt>状态</dt><dd>${statusText(t.status)}</dd></div><div><dt>客户</dt><dd>${e(client.state.clients.find(c=>c.id===t.client_id)?.name||'')}</dd></div></dl>`;box.hidden=false;box.style.left=`${Math.min(rect.right+12,innerWidth-box.offsetWidth-12)}px`;box.style.top=`${Math.max(12,Math.min(rect.top,innerHeight-box.offsetHeight-12))}px`;},320);
}
document.addEventListener('pointerover',event=>{const row=event.target.closest('.task-row');if(row)showTooltip(row);});
document.addEventListener('pointerout',event=>{if(event.target.closest('.task-row'))hideTooltip();});
document.addEventListener('focusin',event=>{const row=event.target.closest('.task-row');if(row)showTooltip(row);});
document.addEventListener('focusout',hideTooltip);
document.addEventListener('keydown',event=>{
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
window.addEventListener('pagehide',()=>{clearTimeout(aliasTimer);client.persist();client.dispose();});
window.matchMedia('(max-width:760px)').addEventListener('change',event=>{if(event.matches)client.setUI({collapsed:true});});
window.addEventListener('beforeunload',event=>{if(!intentionalNavigation&&(client.state.dirty||Object.values(client.state.editors).some(ed=>ed.dirty))){event.preventDefault();event.returnValue='';}});
await client.boot(new URLSearchParams(location.search).get('conversation')).catch(()=>{});
if(innerWidth<=760)client.setUI({collapsed:true});
