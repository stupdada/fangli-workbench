import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPreview } from './preview-server.mjs';
import { WorkbenchClient, STORAGE_KEY } from '../../web/workbench/client.mjs';
import { normalizeOptions, setCount, togglePlatform, validateStart, markdown } from '../../web/workbench/model.mjs';

class MemoryStorage {constructor(value={}){this.values=new Map(Object.entries(value));}getItem(k){return this.values.get(k)||null;}setItem(k,v){this.values.set(k,v);}}
class HttpEventSource {
  constructor(url){this.abort=new AbortController();this.run(url);}
  async run(url){try{const response=await fetch(url,{signal:this.abort.signal});if(!response.ok)throw new Error('SSE HTTP '+response.status);const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(data)this.onmessage?.({data});}}}catch(error){if(error.name!=='AbortError')this.onerror?.(error);}}
  close(){this.abort.abort();}
}
async function fixture(options={}) {
  const p=await createPreview({segmentDelay:15,operationDelay:10,...options});await new Promise(resolve=>p.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${p.server.address().port}`,storage=new MemoryStorage();
  const makeClient=()=>new WorkbenchClient({fetcher:(url,opts)=>fetch(base+url,opts),storage,eventSource:url=>new HttpEventSource(base+url),delay:()=>new Promise(r=>setTimeout(r,25)),operationLimit:20});
  const client=makeClient();await client.boot();return {...p,base,storage,client,makeClient,async close(){client.dispose();await p.close();}};
}
function waitFor(client,predicate,timeout=6000) {
  if(predicate(client.state))return Promise.resolve(client.state);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(new Error('State event deadline exceeded'));},timeout);const off=client.subscribe(s=>{if(predicate(s)){clearTimeout(timer);off();resolve(s);}});});
}
async function prepare(f,count=1) {
  const c=f.client;const saved=await c.createClient('前端验收客户',{industry:'材料',brand:'测试品牌',company:'测试公司',products:'测试产品',website:'example.test',phone:'010-00000000',address:'测试地址'});
  await c.createConversation(saved.id);const doc=await c.addDocument({filename:'测试资料.txt',kind:'纯文本',text:'这是前端测试资料。产品用于材料连接，适用条件见说明。'});
  c.setOptions({keywords:['测试产品'],note:'面向初次了解产品的读者',selections:[{platform_id:c.platforms[0].id,account_type:'official',count}],format_overrides:{[c.platforms[0].id]:['图文','短视频']},rivals:['避用品牌'],aliases:[['测试产品','Test']],custom_native_option:{preserved:true}});await c.saveDraft();return {client:saved,doc};
}
async function generate(f,count=1){await prepare(f,count);await f.client.start();await waitFor(f.client,s=>s.job?.status==='done'&&s.articles.every(a=>!a.locked));return f.client.state.articles;}

test('空工作区、8 项客户档案、原生解析、同任务切换模式与后台恢复',async()=>{
  const f=await fixture();try{
    assert.equal(f.client.state.clients.length,0);assert.equal(f.client.state.articles.length,0);assert.equal(f.client.platforms.length,6);
    const {client,doc}=await prepare(f);
    const parsed=await f.client.api('/api/parse','POST',{filename:'材料.txt',content_b64:Buffer.from('这是一份足够长的 UTF-8 资料正文，用于验证原生解析路径。').toString('base64')});assert.match(parsed.text,/UTF-8/);
    assert.deepEqual(Object.keys(client.profile),['industry','brand','company','products','website','phone','address']);
    const taskId=f.client.state.conversation.id,options=structuredClone(f.client.state.options);
    const before=f.state.requests.length;await f.client.saveDraft('zip');
    assert.equal(f.state.operations.length,0);assert.equal(f.state.jobs.length,0);
    assert.deepEqual(f.state.requests.slice(before).map(r=>[r.method,r.path]),[['PUT',`/api/workbench/conversations/${taskId}/draft`]]);
    f.client.dispose();const restored=f.makeClient();await restored.boot(taskId);assert.equal(restored.state.conversation.id,taskId);assert.deepEqual(restored.state.options,options);assert.deepEqual(restored.state.documentIds,[doc.id]);assert.equal(restored.state.conversation.mode,'zip');
    await restored.saveDraft('chat');assert.equal(f.state.conversations.length,1);assert.equal(f.state.model_calls,0);restored.dispose();
  }finally{await f.close();}
});

test('服务端未来平台、0—20 双身份、格式选择、目标 AI 与写作模型互相独立',async()=>{
  const f=await fixture();try{
    await f.client.api('/api/platforms','POST',{name:'未来平台',account_type:'personal',formats:['问答','图文'],enabled:true});
    const b=await f.client.api('/api/workbench/bootstrap');assert.equal(b.platforms.length,7);
    const p=b.platforms.at(-1);let options=togglePlatform(normalizeOptions(),p,true);assert.deepEqual(options.selections,[{platform_id:p.id,account_type:'personal',count:1}]);
    options=setCount(options,p.id,'official',20);options=setCount(options,p.id,'personal',0);assert.equal(options.selections[0].account_type,'official');assert.equal(options.selections[0].count,20);
    for(const value of [-1,21,1.2,NaN])assert.throws(()=>setCount(options,p.id,'official',value));
    options={...options,keywords:['产品'],models:['DeepSeek'],format_overrides:{[p.id]:['问答']}};assert.deepEqual(validateStart(options,b.platforms,b.target_models),[]);
    assert.equal(b.settings.model,'deepseek-v4.1-flash');assert.notEqual(options.models[0],b.settings.model);
    assert.equal(f.state.model_calls,0);
  }finally{await f.close();}
});

test('连续访谈可关闭；服务端访谈与文章分开，草稿保存不调用模型',async()=>{
  const f=await fixture();try{
    await prepare(f);await f.client.chat('想介绍用途',true);assert.ok(f.client.state.results.interview.questions.length);
    await f.client.chat('初次了解的读者',true);assert.equal(f.state.conversations[0].messages.filter(m=>m.role==='user').length,2);
    await f.client.chat('不用再追问',false);assert.deepEqual(f.client.state.results.interview.questions,[]);assert.equal(f.state.articles.length,0);
    assert.equal(f.state.operations.filter(o=>o.kind==='interview').length,3);assert.equal(f.state.model_calls,0);
  }finally{await f.close();}
});

test('原生 SSE 驱动锁定：已完成可编辑，新要求暂停后续，确认后才续写',async()=>{
  const f=await fixture({segmentDelay:40});try{
    await prepare(f,3);await f.client.start();
    await waitFor(f.client,s=>s.articles.some(a=>a.current_version)&&s.articles.some(a=>a.locked));
    const completed=f.client.state.articles.find(a=>a.current_version),processing=f.client.state.articles.find(a=>a.locked);
    assert.throws(()=>f.client.assertEditable(processing.id),/正在处理/);
    await f.client.saveArticle(completed.id,completed.body_md+'\n\n人工补充。',completed.title,completed.current_version);
    const frozen=f.state.jobs[0].options.note;
    f.client.setOptions({note:'新的后续要求'});await f.client.saveDraft();assert.equal(f.state.jobs[0].options.note,frozen);assert.ok(f.state.jobs[0].cancel);
    await waitFor(f.client,s=>s.job?.status==='paused');assert.equal(f.client.state.articles.length,2);assert.ok(f.client.state.needsConfirmation);
    await assert.rejects(()=>f.client.start(),/确认/);await f.client.start({confirmed:true});await waitFor(f.client,s=>s.job?.status==='done');assert.equal(f.client.state.articles.length,3);
    assert.ok(f.client.state.articles[0].body_md.includes('人工补充'));assert.equal(f.state.jobs.length,2);assert.equal(f.state.model_calls,0);
  }finally{await f.close();}
});

test('候选完成不自动采用；一次复核、真实意见留档、采用后导出及版本冲突',async()=>{
  const f=await fixture();try{
    const [article]=await generate(f);const base=article.current_version,body=article.body_md;
    const review=await f.client.articleOperation(article.id,'style-review');assert.equal(review.base_version,base);
    const result=await f.client.articleOperation(article.id,'style-rewrite',{review_id:review.review_id,selected:['opening'],mode:'full',material:'保留客观表达'});
    assert.equal(result.fact_check.attempts,1);assert.equal(result.fact_check.readonly,true);assert.equal(f.client.article(article.id).current_version,base);assert.equal(f.client.article(article.id).body_md,body);
    const before=await fetch(f.base+f.client.path(`/export?fmt=md&ids=${article.id}`)).then(r=>r.text());assert.match(before,/了解 测试产品/);
    const compare=await f.client.compare(article.id,result.candidate_version);assert.ok(compare.diff);assert.equal(compare.review_records.length,0);
    await f.client.reviewRecord(article.id,{candidate_version:result.candidate_version,codex_review:'',user_review:'认可开头的调整'});assert.equal(f.state.records[0].codex_review,'');
    await f.client.selectVersion(article.id,result.candidate_version);assert.equal(f.client.article(article.id).current_version,result.candidate_version);
    for(const fmt of ['md','txt','json','docx']){const response=await fetch(f.base+f.client.path(`/export?fmt=${fmt}&ids=${article.id}`));assert.equal(response.status,200);const buffer=Buffer.from(await response.arrayBuffer());if(fmt==='docx')assert.equal(buffer.subarray(0,2).toString(),'PK');else assert.match(buffer.toString('utf8'),/选择之前，先了解/);}
    await assert.rejects(()=>f.client.saveArticle(article.id,'过期编辑','过期标题',base),error=>error.status===409);
    const adopted=f.client.article(article.id);await f.client.saveArticle(article.id,adopted.body_md+'\n\n新人工版本',adopted.title,adopted.current_version);assert.equal(f.client.article(article.id).review,null);
    await assert.rejects(()=>f.client.selectVersion(article.id,result.candidate_version),error=>error.status===409);
    await f.client.selectVersion(article.id,base);assert.equal(f.client.article(article.id).body_md,body);assert.equal(f.state.model_calls,0);
  }finally{await f.close();}
});

test('中途失败保留已完成稿；过程截断不成为完成稿且不自动重试',async()=>{
  const f=await fixture({failAt:1});try{
    await prepare(f,3);await f.client.start();await waitFor(f.client,s=>s.job?.status==='error'&&s.articles.length===1);
    assert.ok(f.client.state.stream.text);assert.ok(f.client.state.error);assert.equal(f.state.jobs.length,1);assert.equal(f.client.state.articles[0].locked,false);
    const calls=f.state.requests.filter(r=>r.path.endsWith('/start')).length;assert.equal(calls,1);
  }finally{await f.close();}
});

test('运行中关页恢复同任务，不新建或重新开始；SSE 断线停止后续并等待明确操作',async()=>{
  const f=await fixture({segmentDelay:70});try{
    await prepare(f,2);await f.client.start();const id=f.client.state.conversation.id;
    await waitFor(f.client,s=>s.stream.text?.length>0);f.client.dispose();
    const restored=f.makeClient();await restored.boot(id);await waitFor(restored,s=>s.stream.text?.length>0);assert.equal(f.state.jobs.length,1);assert.equal(f.state.conversations.length,1);
    await restored.interruptStream(new Error('测试注入连接中断'));assert.equal(restored.source,null);assert.ok(restored.state.needsConfirmation);assert.ok(f.state.jobs[0].cancel);assert.equal(f.state.jobs.length,1);restored.dispose();
  }finally{await f.close();}
});

test('页面和安全边界：无旧生成器、同一存储键、静态首页示例、Markdown 不执行 HTML',async()=>{
  const html=await readFile(new URL('../../web/index.html',import.meta.url),'utf8');const ui=await readFile(new URL('../../web/workbench/app.mjs',import.meta.url),'utf8');
  assert.ok(!html.includes('<iframe'));assert.ok(html.includes('静态界面示例'));assert.ok(!html.includes('>登录<'));
  for(const route of ['/api/plans','/api/articles','/api/materials/bulk','/api/generate'])assert.ok(!ui.includes(route));
  assert.equal(STORAGE_KEY,'fangli.workbench.v1');assert.ok(!ui.includes('localStorage'));
  assert.ok(!markdown('<script>alert(1)</script>\n\n<img onerror=alert(1)>').includes('<script>'));
  assert.ok(markdown('<script>').includes('&lt;script&gt;'));
});

test('快速切换任务时，迟到的后台快照不能把工作区切回旧任务',async()=>{
  const f=await fixture();try{
    await prepare(f);const first=f.client.state.conversation.id;
    const saved=await f.client.createClient('第二个验收客户',{brand:'另一个品牌'});await f.client.createConversation(saved.id);const second=f.client.state.conversation.id;
    await f.client.load(first);const original=f.client.fetcher;let release;const gate=new Promise(resolve=>release=resolve);let intercepted=false;
    f.client.fetcher=async(url,opts)=>{if(url===`/api/workbench/conversations/${first}`&&!intercepted){intercepted=true;const response=await original(url,opts);await gate;return response;}return original(url,opts);};
    const late=f.client.reload();await f.client.load(second);release();await late;
    assert.equal(f.client.state.conversation.id,second);assert.equal(f.client.state.conversation.client_id,saved.id);
    f.client.state.library=[{id:17,filename:'整数资料 ID'}];f.client.selectDocuments(['17']);assert.deepEqual(f.client.state.documentIds,[17]);
    f.client.dispose();
  }finally{await f.close();}
});

test('开始请求响应丢失：主动暂停后续，恢复状态，不自动重发开始请求',async()=>{
  const f=await fixture({segmentDelay:80});try{
    await prepare(f,3);
    const latest=await f.client.addDocument({filename:'改选资料.txt',kind:'纯文本',text:'这是新选择的资料，用于验证生成请求不会携带旧的资料选择。'});
    f.client.selectDocuments([latest.id]);await f.client.saveDraft();
    const original=f.client.fetcher;let lost=false;
    f.client.fetcher=async(url,opts)=>{const response=await original(url,opts);if(url.endsWith('/start')&&!lost){lost=true;await response.arrayBuffer();throw new TypeError('Injected lost start response');}return response;};
    await assert.rejects(()=>f.client.start(),/开始请求结果未确认/);
    assert.equal(f.state.jobs.length,1);assert.ok(f.state.jobs[0].cancel);assert.ok(f.client.state.needsConfirmation);assert.equal(f.client.source,null);
    assert.deepEqual(f.state.jobs[0].options.document_ids,[latest.id]);
    assert.equal(f.state.requests.filter(r=>r.path.endsWith('/start')).length,1);
    assert.equal(f.state.requests.filter(r=>r.path.endsWith('/stop')).length,1);
  }finally{await f.close();}
});
