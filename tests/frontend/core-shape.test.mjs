import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WorkbenchClient} from '../../web/workbench/client.mjs';
import {OPERATION_KIND,latestOperation,reviewDefaults,interviewMessageText} from '../../web/workbench/model.mjs';

const folder=new URL('../../../output/geo-merge-20261104/frontend/live/',import.meta.url);
const load=async name=>JSON.parse(await readFile(new URL(name,folder),'utf8').then(s=>s.replace(/^\uFEFF/,'')));
const industrial=await load('industrial-before.json'),shop=await load('shop-before.json'),bootstrap=await load('bootstrap-before.json');
const cp=value=>structuredClone(value);
const storage=()=>({getItem:()=>null,setItem:()=>{}});
function fresh(fetcher=()=>{throw new Error('Unexpected request');}){const c=new WorkbenchClient({storage:storage(),fetcher});c.state.bootstrap=bootstrap;c.state.clients=cp(bootstrap.clients);return c;}
const response=value=>({ok:true,status:200,json:async()=>({ok:true,...value})});

test('真实持久化 kind、最新审阅与推荐档位恢复；访谈 JSON 不进入显示或写作字段',()=>{
  const c=fresh();c.hydrate(cp(industrial));
  assert.deepEqual(Object.values(OPERATION_KIND),['interview','style_review','style_rewrite','revision','writing','zip_regenerate','zip_audit']);
  const review=latestOperation(c.state.operations,OPERATION_KIND.review,1);assert.equal(review.result.base_version,2);assert.equal(review.result.suggestions.length,8);
  assert.deepEqual(reviewDefaults(review.result),{selected:['1','2','3','4','5','6','7'],mode:'full'});
  assert.equal(latestOperation(c.state.operations,OPERATION_KIND.rewrite,1).result.candidate_version,5);
  const newer={...review,id:'newer',created_at:'2099-01-01 00:00:00'};
  assert.equal(latestOperation([newer,review],OPERATION_KIND.review,1).id,'newer');
  c.hydrate(cp(shop));assert.equal(c.state.results.interview.questions.length,1);
  const assistant=shop.conversation.messages.find(m=>m.role==='assistant');assert.equal(interviewMessageText(assistant),assistant.content.understanding);assert.ok(!interviewMessageText(assistant).includes('"options"'));
  assert.equal(c.state.options.note,shop.conversation.brief.note);c.dispose();
});

test('服务端追问状态和暂停标志恢复；只切模式或追问开关不请求暂停生成',async()=>{
  const requests=[];const c=fresh(async(url,opt)=>{requests.push({url,...opt});return response({conversation:industrial.conversation});});
  const data=cp(industrial);data.conversation.followup=false;data.conversation.needs_confirmation=true;c.hydrate(data);assert.equal(c.state.ui.followup,false);assert.equal(c.state.needsConfirmation,true);
  c.state.job={id:'running-fixture',status:'running'};c.setUI({followup:true});await c.saveDraft('zip');
  assert.equal(requests.length,1);assert.ok(requests[0].url.endsWith('/draft'));const body=JSON.parse(requests[0].body);assert.equal(body.mode,'zip');assert.equal(body.followup,true);assert.equal(body.options.note,industrial.conversation.brief.note);assert.deepEqual(body.document_ids,industrial.conversation.document_ids);c.dispose();
});

test('核对资料后保存不可变修订并替换本次选择，保留原资料，不走原生写入接口',async()=>{
  const requests=[],source=industrial.documents[0],revised={...source,id:'revised-document',text:source.text+'\n前端修订验收标记',digest:'new-digest'};
  const c=fresh(async(url,opt)=>{requests.push({url,...opt});const body=JSON.parse(opt.body);return response(url.endsWith('/documents')?{document:revised}:{conversation:{...industrial.conversation,brief:body.options,document_ids:body.document_ids}});});c.hydrate(cp(industrial));c.state.library=[cp(source)];
  await c.reviseDocument(source.id,revised.text);assert.deepEqual(c.state.documentIds,[revised.id]);assert.equal(c.state.library.find(d=>d.id===source.id).text,source.text);assert.equal(c.state.documents[0].text,revised.text);
  assert.deepEqual(requests.map(r=>r.method),['POST','PUT']);assert.ok(requests[0].url.startsWith('/api/workbench/clients/'));assert.deepEqual(JSON.parse(requests[1].body).document_ids,[revised.id]);c.dispose();
});

test('从已有任务新建任务仍以 ZIP 空平台开始',async()=>{
  const newConversation={...cp(shop.conversation),id:'new-task',brief:{...shop.conversation.brief,selections:[],keywords:[],note:''},messages:[],document_ids:[],job_id:null,status:'draft'};const requests=[];
  const c=fresh(async(url,opt)=>{requests.push({url,...opt});if(url==='/api/workbench/conversations')return response({conversation:newConversation});if(url.endsWith('/documents'))return response({documents:[]});if(opt.method==='GET')return response({conversation:newConversation,articles:[],documents:[],operations:[]});if(url==='/api/workbench/clients')return response({client:{...bootstrap.clients[0],profile:{...bootstrap.clients[0].profile,brand:'修订品牌'}}});return response({conversation:newConversation});});
  c.hydrate(cp(industrial));await c.createConversation(newConversation.client_id);assert.deepEqual(c.state.options.selections,[]);assert.equal(requests.filter(r=>r.url.endsWith('/start')).length,0);
  assert.equal(requests.some(r=>r.url.endsWith('/draft')),false);c.dispose();
});
