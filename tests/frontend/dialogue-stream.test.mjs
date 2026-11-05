import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkbenchClient} from '../../web/workbench/client.mjs';
import {liveReplyMarkup} from '../../web/workbench/dialogue-view.mjs';

function runtime() {
  let conversation={id:'a',client_id:'customer',brief:{note:'原来的完整说明',keywords:['产品'],selections:[]},document_ids:[]};
  let operation={id:'reply',conversation_id:'a',kind:'interview',status:'running',result:{},created_at:'2026-11-05T00:00:00Z'};
  const sources=[],requests=[];
  const client=new WorkbenchClient({storage:{getItem:()=>null,setItem:()=>{}},eventSource:url=>{
    const source={url,closed:false,close(){this.closed=true;},send(op){this.onmessage?.({data:JSON.stringify({operation:op})});}};
    sources.push(source);return source;
  },fetcher:async(url,options)=>{
    requests.push({url,method:options.method});
    const value=url.includes('/operations/')?{operation}:url.endsWith('/documents')?{documents:[]}:{conversation,operations:[operation],articles:[],documents:[]};
    return new Response(JSON.stringify({ok:true,...value}),{headers:{'Content-Type':'application/json'}});
  }});
  client.state.bootstrap={target_models:[],platforms:[]};
  client.hydrate({conversation,operations:[operation],articles:[],documents:[]});client.setMessageDraft('原始消息');
  return {client,sources,requests,set(op,brief){operation=op;if(brief)conversation={...conversation,brief:{...conversation.brief,...brief}};if(op.status==='done')conversation={...conversation,messages:[{role:'assistant',content:{...op.result,operation_id:op.id}}]};},switchTask(){conversation={...conversation,id:'b',brief:{note:'B任务说明'}};},get operation(){return operation;}};
}

test('SSE片段立即可见，结构化安排仅在终态重载后变化',async()=>{
  const r=runtime(),pending=r.client.watchInterview('reply');
  const partial={...r.operation,result:{understanding:'可以，我们先聊聊你的方向。',partial:true,reply_complete:false}};
  r.sources[0].send(partial);
  assert.equal(r.client.state.options.note,'原来的完整说明');
  assert.match(liveReplyMarkup(r.client.state),/可以，我们先聊聊/);
  assert.match(liveReplyMarkup(r.client.state),/is-streaming/);
  const done={...partial,status:'done',result:{understanding:'可以，我们就按这个方向来。',questions:[],ready:true}};
  r.set(done,{note:'完整校验后的说明'});r.sources[0].send(done);
  assert.match(liveReplyMarkup(r.client.state),/可以，我们就按这个方向来/,'终态到达与历史重载之间保留原回复');
  assert.doesNotMatch(liveReplyMarkup(r.client.state),/停止回复|回复未完成|is-streaming/);
  assert.equal((await pending).understanding,done.result.understanding);
  assert.equal(r.client.state.options.note,'完整校验后的说明');
  assert.equal(liveReplyMarkup(r.client.state),'');assert.equal(r.sources[0].closed,true);r.client.dispose();
});

test('校验失败保留原输入及未完成回复，不应用新说明',async()=>{
  const r=runtime(),pending=r.client.watchInterview('reply');
  const failed={...r.operation,status:'error',error:'需求整理缺少完整说明',result:{understanding:'可以，我们先讨论这个方向。',partial:true,error_status:400}};
  r.set(failed);r.sources[0].send(failed);
  await assert.rejects(pending,error=>error.status===400);
  assert.equal(r.client.messageDraft(),'原始消息');assert.equal(r.client.state.options.note,'原来的完整说明');
  assert.match(liveReplyMarkup(r.client.state),/回复未完成/);r.client.dispose();
});

test('断线只确认一次状态；显式恢复重新接事件，不重发模型请求',async()=>{
  const r=runtime(),pending=r.client.watchInterview('reply');
  const partial={...r.operation,result:{understanding:'可以，我们先聊聊。',partial:true}};r.set(partial);r.sources[0].send(partial);
  r.sources[0].onerror();r.sources[0].onerror();
  await assert.rejects(pending,/回复连接中断/);
  assert.equal(r.requests.filter(x=>x.url.includes('/operations/')).length,1);
  assert.match(liveReplyMarkup(r.client.state),/连接中断/);assert.doesNotMatch(liveReplyMarkup(r.client.state),/is-streaming/);
  assert.equal(r.client.messageDraft(),'原始消息');
  r.client.resumeBackground();const recovered=r.client.watchers.get('reply');
  assert.equal(r.sources.length,2);
  const done={...partial,status:'done',result:{understanding:'可以，就这样安排。',ready:true,questions:[]}};
  r.set(done,{note:'恢复后确认的说明'});r.sources[1].send(done);await recovered;
  assert.equal(r.client.state.options.note,'恢复后确认的说明');assert.ok(r.requests.every(x=>x.method==='GET'));r.client.dispose();
});

test('终态包丢失后通过一次读取确认成功，不误报中断',async()=>{
  const r=runtime(),pending=r.client.watchInterview('reply');
  r.set({...r.operation,status:'done',result:{understanding:'好的，就按这个来。',ready:true,questions:[]}},{note:'已确认说明'});
  r.sources[0].onerror();assert.equal((await pending).ready,true);assert.equal(r.client.state.options.note,'已确认说明');r.client.dispose();
});

test('切换任务关闭旧事件连接，迟到片段不污染新任务',async()=>{
  const r=runtime(),pending=r.client.watchInterview('reply');r.switchTask();
  await r.client.load('b');assert.equal(await pending,null);assert.equal(r.sources[0].closed,true);
  r.sources[0].send({...r.operation,result:{understanding:'旧任务的迟到回复',partial:true}});
  assert.equal(r.client.state.conversation.id,'b');assert.equal(r.client.state.options.note,'B任务说明');
  assert.equal(liveReplyMarkup(r.client.state),'');r.client.dispose();
});

test('部分回复沿用安全Markdown，内部安排及其他任务回复不进入对话',()=>{
  const r=runtime();r.client.state.operations=[{...r.operation,result:{understanding:'**可以** <img src=x onerror=alert(1)>',partial:true,options:{note:'内部写作说明'}}}];
  const html=liveReplyMarkup(r.client.state);assert.match(html,/<strong>可以<\/strong>/);assert.ok(!html.includes('<img'));assert.ok(!html.includes('内部写作说明'));
  r.client.state.operations[0].conversation_id='other';assert.equal(liveReplyMarkup(r.client.state),'');r.client.dispose();
});
