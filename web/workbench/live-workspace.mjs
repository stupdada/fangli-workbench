import {escapeHTML as e,markdown,running,accountName,articleBody} from './model.mjs';
import {activity,streamDocument,remainingCount} from './live-model.mjs';

const spinner='<svg class="activity-spinner" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 8 8"/></svg>';
const sessions=new Map();
export function activityMarkup(state,location='live') {
  const a=activity(state),scope=state.conversation?.id||'_new';
  let session=sessions.get(scope);if(!session){session={key:'',history:[]};sessions.set(scope,session);}
  if(session.key!==a.key){session.key=a.key;session.since=Date.now();if(session.history.at(-1)!==a.label)session.history.push(a.label);}
  const done=state.job?.done??state.stream?.done??0,total=state.job?.planned??state.stream?.planned??0;
  return `<details class="activity-strip ${a.active?'is-active':''}" id="task-activity-${location}"><summary><span class="activity-symbol">${a.active?spinner:'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>'}</span><span class="activity-label" role="status">${e(a.label)}</span>${a.active?`<time data-elapsed="${session.since}" aria-label="当前阶段耗时">0 秒</time>`:''}${total?`<span class="activity-count">${done} / ${total} 篇</span>`:''}</summary><ol>${session.history.slice(-8).map(label=>`<li>${e(label)}</li>`).join('')}</ol></details>`;
}
export function liveMarkup(state,platforms,button) {
  const active=running(state.job),remaining=remainingCount(state,platforms);
  const saved=state.articles.filter(a=>a.current_version!=null),stream=state.stream||{};
  const article=saved.at(-1);
  const preview=active?streamDocument(stream.text||state.job?.partial||''):article?{title:article.title,body:articleBody(article).replace(/^# [^\n]+\n/,'')}:streamDocument(stream.text||state.job?.partial||'');
  const meta=[stream.platform||state.job?.platform,stream.account_type?accountName(stream.account_type):'',(stream.words||[]).join('、')].filter(Boolean).join(' · ');
  const busy=(state.operations||[]).some(running);
  const controls=active?button('stop',state.job?.cancel?'正在收尾':'暂停后续','stop','quiet',state.job?.cancel):remaining?button('start',saved.length?'继续剩余安排':'开始写作','right','primary',busy)+button('write-one','只写下一篇',null,'quiet',busy):button('articles','编辑与导出','right','primary',!saved.length);
  return `<section class="live-workspace"><header class="live-toolbar"><h1>${active?'创作进行中':remaining?'本次创作':'稿件已就绪'}</h1><div class="inline-actions">${controls}</div></header>${activityMarkup(state)}<div class="live-columns"><section class="stream-preview"><div class="preview-meta">${e(meta||'当前稿件')}</div><div class="stream-scroll" id="stream-scroll" data-follow-scroll><article class="rendered-copy" id="stream-copy" data-stream-key="${e((state.job?.id||'')+':'+(stream.seg||0))}">${preview.title?`<h1>${e(preview.title)}</h1>`:''}${preview.body?markdown(preview.body):active?'<div class="writing-placeholder" aria-label="正在等待正文"><span></span><span></span><span></span></div>':'<p class="empty">从右侧选择已保存的稿件阅读。</p>'}</article></div><button class="new-content" data-action="follow-stream" hidden>有新内容 ↓</button></section><nav class="generation-list" aria-label="本次稿件"><h2>已保存 · ${saved.length} 篇</h2>${saved.map(a=>`<button data-select-article="${a.id}"><span>${e(a.title||'未命名稿件')}</span><small>${e(a.platform_name||a.platform||'')} · ${a.locked?'正在核查':'已保存'}</small></button>`).join('')||'<p class="empty">稿件保存后会出现在这里。</p>'}${remaining&&!active?`<p class="remaining-count">还有 ${remaining} 篇待完成</p>`:''}</nav></div><details class="process-details" id="process-original"><summary>查看过程原文</summary><pre id="live-text">${e(stream.text||state.job?.partial||'尚无过程记录')}</pre></details></section>`;
}

// Reconcile stable nodes instead of replacing the workspace on every token.
const persistentClasses=new Set(['chat-context','chat-compose-area','conversation-log','composer','composer-toolbar','composer-foot','chat-suggestions','chat-workbench','activity-strip','live-workspace','live-toolbar','live-columns','stream-preview','generation-list','draft-pane','draft-head','draft-content','chat-pane','chat-split','paper','editor-toolbar','revision-box','article-workspace','article-tabs']);
function key(node){if(node.nodeType!==1)return null;return node.id?'#'+node.id:node.dataset.key||[...node.classList].find(c=>persistentClasses.has(c))||null;}
function compatible(a,b){return a&&a.nodeType===b.nodeType&&(a.nodeType!==1||a.tagName===b.tagName)&&key(a)===key(b);}
export function reconcile(target,source) {
  const old=[...target.childNodes],keyed=new Map(old.map(n=>[key(n),n]).filter(([k])=>k));let cursor=target.firstChild;
  for(const desired of [...source.childNodes]){
    const id=key(desired);let node=id?keyed.get(id):cursor;
    if(!compatible(node,desired))node=desired.cloneNode(true);
    if(node!==cursor)target.insertBefore(node,cursor);
    if(node.nodeType===3){if(node.data!==desired.data)node.data=desired.data;}
    else if(node.nodeType===1){
      const focused=node===document.activeElement,details=node.tagName==='DETAILS',wasOpen=node.open;
      for(const attr of [...node.attributes])if(!desired.hasAttribute(attr.name)&&!['style','data-follow','data-follow-bound'].includes(attr.name))node.removeAttribute(attr.name);
      for(const attr of desired.attributes)if(node.getAttribute(attr.name)!==attr.value)node.setAttribute(attr.name,attr.value);
      if(!['TEXTAREA','INPUT','SELECT'].includes(node.tagName))reconcile(node,desired);
      else if(!focused||node.id==='message-input'){if(node.type==='checkbox'||node.type==='radio')node.checked=desired.checked;else if(node.value!==desired.value)node.value=desired.value;}
      if(details)node.open=wasOpen;
    }
    cursor=node.nextSibling;
  }
  while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
}

export function setupLiveUI(root,{persist,ui}) {
  const handle=root.querySelector('#draft-resizer'),split=root.querySelector('.chat-split');
  const chat=root.querySelector('.chat-pane'),draft=root.querySelector('.draft-pane');
  if(chat){chat.inert=innerWidth<=1050&&draft&&!draft.hidden;if(chat.inert&&(chat.contains(document.activeElement)||document.activeElement===document.body))draft.querySelector('[data-action=close-draft]')?.focus({preventScroll:true});}
  if(handle&&split&&innerWidth>1050){
    const set=ratio=>{const min=Math.min(.48,300/Math.max(split.clientWidth,1)),max=1-Math.min(.48,360/Math.max(split.clientWidth,1));ui.draftRatio=Math.max(min,Math.min(max,ratio));split.style.setProperty('--chat-fr',ui.draftRatio+'fr');split.style.setProperty('--draft-fr',(1-ui.draftRatio)+'fr');handle.setAttribute('aria-valuenow',Math.round(ui.draftRatio*100));handle.setAttribute('aria-valuemin',Math.round(min*100));handle.setAttribute('aria-valuemax',Math.round(max*100));};
    set(ui.draftRatio||.4);
    handle.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();handle.setPointerCapture(event.pointerId);split.classList.add('is-resizing');handle.onpointermove=move=>set((move.clientX-split.getBoundingClientRect().left)/split.clientWidth);};
    handle.onpointerup=handle.onpointercancel=()=>{handle.onpointermove=null;split.classList.remove('is-resizing');persist();};
    handle.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();set(event.key==='Home'?0:event.key==='End'?1:(ui.draftRatio||.4)+(event.key==='ArrowLeft'?-.03:.03));persist();};
  }
  for(const scroll of root.querySelectorAll('[data-follow-scroll],.conversation-log')){
    if(scroll.dataset.followBound)continue;scroll.dataset.followBound='true';
    scroll.addEventListener('scroll',()=>{scroll.dataset.follow=String(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<65);const jump=scroll.parentElement.querySelector('.new-content');if(jump&&scroll.dataset.follow==='true')jump.hidden=true;},{passive:true});
  }
  tickElapsed(root);
}
export function tickElapsed(root=document){for(const time of root.querySelectorAll('[data-elapsed]'))time.textContent=Math.max(0,Math.floor((Date.now()-Number(time.dataset.elapsed))/1000))+' 秒';}
export function captureFollowing(root){return [...root.querySelectorAll('[data-follow-scroll],.conversation-log')].map(el=>({id:el.id,follow:el.dataset.follow!=='false',top:el.scrollTop,content:el.textContent,unread:!!el.parentElement.querySelector('.new-content:not([hidden])')}));}
export function restoreFollowing(root,before){for(const row of before){const el=root.querySelector('#'+row.id);if(!el)continue;el.dataset.follow=String(row.follow);el.scrollTop=row.follow?el.scrollHeight:row.top;const jump=el.parentElement.querySelector('.new-content');if(jump)jump.hidden=row.follow||!(row.unread||el.textContent!==row.content);}}
