import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerClient, BatchMonitor, importCustomerFile } from '../../web/workbench/customers-client.mjs';
import { WorkbenchClient, ApiError } from '../../web/workbench/client.mjs';
import { validateStart } from '../../web/workbench/model.mjs';

function storage() { const data = new Map(); return {getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}; }
const items = [{client_id:'a',options:{keywords:['产品'],selections:[{platform_id:1,account_type:'official',count:2}]}}];

test('批次网络结果不确定时，刷新后的重发保留同一编号与快照；主动下一批另取编号', async () => {
  const cache = storage(), writes = []; let fail = true, count = 0;
  const api = async (path,method,body) => { writes.push(structuredClone(body)); if (fail) throw new ApiError('断线',0); return {batch:{id:'b'+writes.length,status:'queued'}}; };
  const service = new CustomerClient(api,{storage:cache,uuid:()=>`key-${++count}`});
  await assert.rejects(service.submit(items),/断线/);
  await assert.rejects(service.submit([{client_id:'b'}]),/尚未确认/); assert.equal(writes.length,1);
  fail = false; const restored = new CustomerClient(api,{storage:cache,uuid:()=>`key-${++count}`});
  await restored.retrySubmission(); assert.deepEqual(writes[0],writes[1]);
  await restored.submit(items); assert.notEqual(writes[1].request_key,writes[2].request_key);
});

test('批次预检只读无提交；已确认的400验证拒绝可修改后重新提交', async () => {
  const calls = [], cache = storage(); let reject = true;
  const service = new CustomerClient(async (path,method,body) => { calls.push({path,method,body}); if (path.endsWith('preflight')) return {ready:false,issues:[{client_id:'a',error:'缺资料'}]}; if (reject) throw new ApiError('安排失效',400); return {batch:{id:'new'}}; },{storage:cache,uuid:()=>crypto.randomUUID()});
  const check = await service.preflight(items); assert.equal(check.ready,false); assert.equal(service.pending,null); assert.equal(calls.length,1);
  await assert.rejects(service.submit(items),/安排失效/); assert.equal(service.pending,null);
  reject = false; await service.submit([{client_id:'b'}]); assert.equal(calls.at(-1).body.items[0].client_id,'b');
});

test('原文件先按哈希查重；重复PDF直接复用，不解析也不再传副本', async () => {
  const calls = []; const existing = {id:'doc-existing'};
  const service = new CustomerClient(async (path,method,body) => { calls.push({path,body}); assert.ok(path.endsWith('/documents/check')); assert.match(body.sha256,/^[a-f0-9]{64}$/); return {duplicate:existing}; },{storage:storage()});
  const result = await importCustomerFile(service,'a',new File(['same bytes'],'资料（1）.pdf'),()=>{throw Error('不得询问更新');});
  assert.equal(result.document.id,existing.id); assert.equal(calls.length,1);
});

test('复制后缀只触发用户决策；确认更新才上传原bytes；取消不写副本', async () => {
  const calls = [], source = '产品资料：参数由客户确认';
  const service = new CustomerClient(async (path,method,body) => { calls.push({path,body}); return path.endsWith('/check') ? {duplicate:null,candidates:[{id:'old',filename:'资料.txt'}]} : {outcome:'updated',document:{id:'revision-2'}}; },{storage:storage()});
  const file = new File([source],'资料（1）.txt');
  await importCustomerFile(service,'a',file,async ()=>null); assert.equal(calls.length,1);
  const result = await importCustomerFile(service,'a',file,async ()=>({update_document_id:'old'}));
  assert.equal(result.outcome,'updated'); const upload = calls.at(-1).body;
  assert.equal(Buffer.from(upload.content_b64,'base64').toString('utf8'),source); assert.equal(upload.update_document_id,'old'); assert.equal(upload.text,undefined);
});

test('新建任务沿用服务端常用方案和最新资料，不被空的前端默认覆盖', async () => {
  const options={keywords:['新方案词'],models:[],selections:[{platform_id:1,account_type:'official',count:2}],note:'长期要求'};
  const conversation={id:'new',client_id:'a',brief:options,document_ids:['latest'],mode:'chat'}; const calls=[];
  const client=new WorkbenchClient({storage:storage(),fetcher:async(path,request)=>{calls.push(path);const body=path.endsWith('/documents')?{documents:[{id:'latest'}]}:request.method==='POST'?{conversation}:{conversation,articles:[],documents:[{id:'latest'}],operations:[]};return new Response(JSON.stringify({ok:true,...body}));}});
  client.state.bootstrap={target_models:[],platforms:[]}; await client.createConversation('a');
  assert.deepEqual(client.state.options.selections,options.selections); assert.deepEqual(client.state.documentIds,['latest']); assert.equal(calls.some(path=>path.endsWith('/draft')),false); client.dispose();
});

test('实验目标AI不再是日常开始的必填项',()=>{
  assert.deepEqual(validateStart({keywords:['产品'],models:[],selections:[{platform_id:1,account_type:'official',count:1}],format_overrides:{}},[{id:1,name:'平台',enabled:true,formats:['图文']}],[]),[]);
});

test('批次终态停止计时；隐藏页面不请求；显示后继续',async()=>{
  let callback, reads=0, updated=0; const handlers=new Map();
  const visibility={hidden:true,addEventListener:(k,f)=>handlers.set(k,f),removeEventListener:k=>handlers.delete(k)};
  const monitor=new BatchMonitor({batch:async()=>{reads++;return {id:'b',status:'done'};}},()=>updated++,error=>{throw error;},{visibility,schedule:fn=>{callback=fn;return 1;},cancel:()=>{callback=null;}});
  monitor.start({id:'b',status:'running'}); assert.equal(reads,0);
  visibility.hidden=false; await handlers.get('visibilitychange')(); await new Promise(setImmediate);
  assert.equal(reads,1); assert.equal(updated,1); assert.equal(monitor.id,null); assert.equal(callback,null); monitor.dispose();
});

test('切换批次时，旧的在途响应不阻塞新批次，也不能覆盖其结果',async()=>{
  let finishOld; const updates=[], callbacks=[];
  const monitor=new BatchMonitor({batch:async id=>id==='old'?new Promise(resolve=>{finishOld=resolve;}):{id,status:'done'}},b=>updates.push(b.id),error=>{throw error;},{visibility:{hidden:false,addEventListener(){},removeEventListener(){}},schedule:fn=>{callbacks.push(fn);return fn;},cancel:()=>{}});
  monitor.start({id:'old',status:'running'}); const old=monitor.tick();
  monitor.start({id:'new',status:'running'}); await monitor.tick();
  finishOld({id:'old',status:'done'}); await old;
  assert.deepEqual(updates,['new']); assert.equal(monitor.id,null); monitor.dispose();
});

test('重复历史原件保留历史标记，任务不能据此回退当前资料选择',async()=>{
  const existing={id:'old',is_current:false};
  const service=new CustomerClient(async()=>({duplicate:existing,is_current:false}),{storage:storage()});
  const result=await importCustomerFile(service,'a',new File(['old bytes'],'资料.txt'),()=>{throw Error('不得自动另存');});
  assert.equal(result.is_current,false);
  const client=new WorkbenchClient({storage:storage(),fetcher:async()=>new Response(JSON.stringify({ok:true,outcome:'duplicate',document:existing,is_current:false}))});
  client.state.conversation={id:'task',client_id:'a'};client.state.documentIds=['current'];
  await assert.rejects(client.addDocument({filename:'资料.txt',text:'old'}),/历史修订/);
  assert.deepEqual(client.state.documentIds,['current']);client.dispose();
});

test('任务读取保留批次冻结标识，忽略旧本地需求；模式可切换，复用普通任务后恢复编辑',async()=>{
  const brief={keywords:['原方向'],models:[],selections:[],note:'冻结要求'}, batch={id:'batch',status:'done',item_id:'item',item_status:'done',frozen:true};
  const frozen={id:'frozen',client_id:'a',brief,document_ids:['source'],mode:'chat'}, ordinary={...frozen,id:'copy',mode:'zip'};
  const calls=[];
  const client=new WorkbenchClient({storage:storage(),fetcher:async(path,request)=>{
    calls.push({path,method:request.method});
    const data=path.endsWith('/clone')?{conversation:ordinary}:path.endsWith('/draft')?{conversation:{...frozen,mode:'zip'}}:path.endsWith('/documents')?{documents:[]}:{conversation:ordinary,batch:null,articles:[],documents:[],operations:[]};
    return new Response(JSON.stringify({ok:true,...data}));
  }});
  client.cache.pending={id:'frozen',options:{...brief,note:'旧本地修改'},documentIds:[]};
  client.hydrate({conversation:frozen,batch,articles:[],documents:[],operations:[]});
  assert.deepEqual(client.state.batch,batch);assert.equal(client.state.options.note,'冻结要求');assert.equal(client.state.dirty,false);
  assert.throws(()=>client.setOptions({note:'改动'}),/已冻结/);assert.throws(()=>client.selectDocuments([]),/已冻结/);assert.equal(calls.length,0);
  await client.saveDraft('zip');assert.equal(client.state.conversation.mode,'zip');assert.deepEqual(client.state.batch,batch);
  await client.cloneConversation();assert.equal(client.state.batch,null);assert.equal(client.state.conversation.id,'copy');
  assert.doesNotThrow(()=>client.setOptions({note:'普通任务新要求'}));assert.equal(client.state.options.note,'普通任务新要求');client.dispose();
});
