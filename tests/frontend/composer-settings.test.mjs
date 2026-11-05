import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkbenchClient,ApiError} from '../../web/workbench/client.mjs';
import {reviewDefaults,reviewSelection} from '../../web/workbench/model.mjs';

function storage(){const values=new Map();return {getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};}
const options={keywords:['产品'],selections:[{platform_id:1,account_type:'official',count:1}],models:[],note:'当前条件：保留工序限制，已撤销价格要求。'};
const conversation=(id='a')=>({id,client_id:'customer',brief:structuredClone(options),document_ids:['source'],followup:true,mode:'chat'});
function hydrate(client,c=conversation()){client.hydrate({conversation:c,batch:null,articles:[],documents:[],operations:[]});}
function runtime({failCompile=false,failStart=false}={}){
  const cache=storage(),calls=[];let current=conversation(),compileCount=0,startCount=0;
  const client=new WorkbenchClient({storage:cache,delay:async()=>{},eventSource:url=>{const source={closed:false,close(){this.closed=true;}};queueMicrotask(async()=>{const d=await client.api(url.replace(/\/stream$/,''));if(!source.closed)source.onmessage?.({data:JSON.stringify({operation:{...d.operation,conversation_id:current.id}})});});return source;},fetcher:async(path,request)=>{
    const body=request.body?JSON.parse(request.body):null;calls.push({path,body});
    let value;
    if(path.endsWith('/draft')){current={...current,brief:body.options??current.brief,document_ids:body.document_ids??current.document_ids,followup:body.followup};value={conversation:current};}
    else if(path.endsWith('/chat')){compileCount++;assert.equal(body.followup,false);assert.equal(body.options.note,options.note);if(failCompile)return new Response(JSON.stringify({ok:false,error:'整理失败'}),{status:400});current={...current,brief:{...current.brief,note:body.options.note+'\n'+body.text,keywords:['新方向']}};value={operation_id:'compile'};}
    else if(path.includes('/operations/'))value={operation:{id:'compile',kind:'interview',status:'done',result:{ready:true,stale:false}}};
    else if(path.endsWith('/start')){startCount++;if(failStart&&startCount===1)return new Response(JSON.stringify({ok:false,error:'启动暂不可用'}),{status:409});assert.match(body.options.note,/本次讲选型/);assert.deepEqual(body.options.keywords,['新方向']);value={job_id:'job',planned:1,total:1};}
    else value={conversation:current,batch:null,articles:[],documents:[],operations:[]};
    return new Response(JSON.stringify({ok:true,...value}));
  }});
  client.state.bootstrap={target_models:[],platforms:[{id:1,name:'平台',enabled:true,formats:['图文']}]};hydrate(client);
  return {client,cache,calls,snapshot:()=>structuredClone(current),get counts(){return {compileCount,startCount};}};
}

test('消息默认空，与有效说明独立；草稿按任务隔离并跨实例恢复',()=>{
  const cache=storage(),client=new WorkbenchClient({storage:cache});hydrate(client);
  assert.equal(client.messageDraft(),'');client.setMessageDraft('A未发送');assert.equal(client.state.options.note,options.note);assert.equal(client.state.dirty,false);
  hydrate(client,conversation('b'));assert.equal(client.messageDraft(),'');client.setMessageDraft('B未发送');
  const restored=new WorkbenchClient({storage:cache});hydrate(restored);assert.equal(restored.messageDraft(),'A未发送');hydrate(restored,conversation('b'));assert.equal(restored.messageDraft(),'B未发送');client.dispose();restored.dispose();
});

test('未发送消息直接开始：只整理一次，继承当前条件，恢复追问偏好，成功后清空',async()=>{
  const run=runtime();run.client.setMessageDraft('本次讲选型');await run.client.submitMessage({start:true});
  assert.deepEqual(run.counts,{compileCount:1,startCount:1});assert.equal(run.client.state.ui.followup,true);assert.equal(run.client.messageDraft(),'');assert.match(run.client.state.options.note,/已撤销价格要求/);assert.equal(run.calls.some(c=>c.path.includes('generation-plan')),false);run.client.dispose();
});

test('整理失败保留消息并阻止启动；启动失败后显式重试复用已整理要求',async()=>{
  const failed=runtime({failCompile:true});failed.client.setMessageDraft('本次讲选型');await assert.rejects(failed.client.submitMessage({start:true}),/整理失败/);assert.equal(failed.client.messageDraft(),'本次讲选型');assert.equal(failed.counts.startCount,0);assert.equal(failed.client.state.ui.followup,true);assert.equal(failed.snapshot().followup,true);failed.client.dispose();
  const retry=runtime({failStart:true});retry.client.setMessageDraft('本次讲选型');await assert.rejects(retry.client.submitMessage({start:true}),/启动暂不可用/);assert.equal(retry.client.messageDraft(),'本次讲选型');await retry.client.submitMessage({start:true});assert.deepEqual(retry.counts,{compileCount:1,startCount:2});retry.client.dispose();
});

test('需求整理晚到时不能启动切换后的任务；执行期间新输入不被清除',async()=>{
  const client=new WorkbenchClient({storage:storage()});hydrate(client);client.setMessageDraft('A未发送');let finish;
  client.chat=()=>new Promise(resolve=>{finish=resolve;});client.start=()=>{throw Error('不得启动B');};
  const pending=client.submitMessage({start:true});hydrate(client,conversation('b'));client.setMessageDraft('B未发送');finish({ready:true});assert.equal(await pending,null);assert.equal(client.messageDraft(),'B未发送');assert.equal(client.messageDraft('a'),'A未发送');
  hydrate(client);let finishNext;client.chat=()=>new Promise(resolve=>{finishNext=resolve;});const next=client.submitMessage();client.setMessageDraft('执行期间的新内容');finishNext({ready:true});await next;assert.equal(client.messageDraft(),'执行期间的新内容');client.dispose();
});

test('审阅观察项默认不选；用户选择保留真实O编号，素材与保守分支明确区分',()=>{
  const review={recommended:['1','3','O1'],suggestions:[{id:'1'},{id:'3',requires_material:true}],observations:[{id:'O1'}]};
  assert.deepEqual(reviewDefaults(review).selected,['1','3']);
  assert.deepEqual(reviewSelection(review,{selected:['3','O1']}).missing,['3']);
  const safe=reviewSelection(review,{selected:['3','O1'],conservative:['3','1']});assert.deepEqual(safe.selected,['3','O1']);assert.deepEqual(safe.conservative,['3']);assert.deepEqual(safe.missing,[]);
  const material=reviewSelection(review,{selected:['3'],material:'客户提供的真实案例'});assert.deepEqual(material.conservative,[]);assert.deepEqual(material.missing,[]);
  const changed=reviewSelection(review,{selected:['O1','old']});assert.deepEqual(changed.selected,['O1','old']);assert.deepEqual(changed.invalid,['old']);
});

test('稿件修改指令与审阅选择/素材按任务、文章、审阅基版隔离并恢复',()=>{
  const cache=storage(),client=new WorkbenchClient({storage:cache});hydrate(client);
  const scope={review_id:'review-1',base_version:2};client.setArticleDraft(1,{instruction:'只调整这篇开头'});
  client.setArticleDraft(1,{selected:['3','O1'],conservative:['3'],mode:'light',material:'这篇的真实素材'},scope);
  assert.deepEqual(client.articleDraft(2),{});assert.deepEqual(client.articleDraft(1,{...scope,base_version:3}),{});assert.deepEqual(client.articleDraft(1,{...scope,review_id:'review-2'}),{});
  hydrate(client,conversation('b'));assert.deepEqual(client.articleDraft(1),{});assert.deepEqual(client.articleDraft(1,scope),{});
  const restored=new WorkbenchClient({storage:cache});hydrate(restored);assert.equal(restored.articleDraft(1).instruction,'只调整这篇开头');assert.deepEqual(restored.articleDraft(1,scope),{selected:['3','O1'],conservative:['3'],mode:'light',material:'这篇的真实素材'});client.dispose();restored.dispose();
});

test('冻结任务的新消息入口阻止需求整理与开始请求',async()=>{
  let requests=0;const client=new WorkbenchClient({storage:storage(),fetcher:()=>{requests++;throw Error('不得写入');}});
  client.hydrate({conversation:conversation(),batch:{id:'batch',frozen:true},articles:[],documents:[],operations:[]});client.setMessageDraft('未发送内容');
  await assert.rejects(client.submitMessage(),/已冻结/);await assert.rejects(client.submitMessage({start:true}),/已冻结/);assert.equal(requests,0);assert.equal(client.messageDraft(),'未发送内容');client.dispose();
});

test('后台需求校验失败保留400语义与消息，错误按任务保存而非连接故障',async()=>{
  const cache=storage(),c=conversation(),op={id:'failed',kind:'interview',status:'error',error:'需求整理没有返回当前有效写作说明',result:{error_status:400}};
  const client=new WorkbenchClient({storage:cache,eventSource:()=>{const source={close(){}};queueMicrotask(()=>source.onmessage?.({data:JSON.stringify({operation:{...op,conversation_id:c.id}})}));return source;},fetcher:async(path,request)=>{
    const value=path.endsWith('/chat')?{operation_id:op.id}:path.includes('/operations/')?{operation:op}:{conversation:c,batch:null,articles:[],documents:[],operations:[op]};
    return new Response(JSON.stringify({ok:true,...value}));
  }});hydrate(client,c);client.setMessageDraft('待整理消息');
  await assert.rejects(client.submitMessage(),error=>{assert.equal(error.status,400);assert.equal(error.operationKind,'interview');assert.equal(error.conversationId,'a');client.setMessageError(error.message,error.conversationId);return true;});
  assert.equal(client.messageDraft(),'待整理消息');assert.equal(client.state.options.note,options.note);assert.equal(client.state.error,'');
  const restored=new WorkbenchClient({storage:cache});hydrate(restored,c);assert.match(restored.messageError(),/有效写作说明/);hydrate(restored,conversation('b'));assert.equal(restored.messageError(),'');client.dispose();restored.dispose();
});
