import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WorkbenchClient,ApiError} from '../../web/workbench/client.mjs';
import {OPERATION_KIND,PROFILE_FIELDS,optionIssues,validateStart} from '../../web/workbench/model.mjs';

const folder=new URL('../../../output/geo-merge-20261104/frontend/unified/',import.meta.url);
const baseline=JSON.parse(await readFile(new URL('industrial-before.json',folder),'utf8'));
const bootstrap=JSON.parse(await readFile(new URL('bootstrap-before.json',folder),'utf8'));
const cp=structuredClone;
const ok=(data,status=200)=>new Response(JSON.stringify({ok:status<400,...data}),{status,headers:{'Content-Type':'application/json'}});
function setup(route) {
  const requests=[];
  const client=new WorkbenchClient({storage:{getItem:()=>null,setItem:()=>{}},delay:async()=>{},eventSource:url=>({url,close(){this.closed=true;}}),fetcher:async(url,options)=>{
    const request={url,method:options.method,body:options.body?JSON.parse(options.body):undefined};requests.push(request);
    return route(request);
  }});
  client.state.bootstrap=cp(bootstrap);client.state.clients=cp(bootstrap.clients);client.hydrate(cp(baseline));
  return {client,requests};
}
const profileKeys=PROFILE_FIELDS.filter(([key])=>key!=='name').map(([key])=>key);

test('当前 brief 是唯一有效输入：隐藏 options 和全局档案不能回填空值或旧说明',()=>{
  const {client}=setup(()=>{throw Error('unexpected request');});
  const data=cp(baseline);data.conversation.options={brand:'隐藏旧品牌',note:'面向消费者'};
  Object.assign(data.conversation.brief,{brand:'',company:'工程公司',products:'',note:'仅面向工艺人员'});
  client.hydrate(data);
  assert.equal(client.state.options.brand,'');assert.equal(client.state.options.products,'');assert.equal(client.state.options.company,'工程公司');assert.equal(client.state.options.note,'仅面向工艺人员');
  assert.equal(client.state.conversation.messages.length,baseline.conversation.messages.length);client.dispose();
});

test('档案编辑单次 PUT 完整七字段；响应同时更新任务有效字段和客户默认值',async()=>{
  const profile=Object.fromEntries(profileKeys.map(key=>[key,key==='brand'?'新品牌':'']));
  const {client,requests}=setup(request=>{
    assert.ok(request.url.endsWith('/profile'));assert.equal(request.method,'PUT');assert.deepEqual(Object.keys(request.body.profile).sort(),[...profileKeys].sort());
    const conversation={...cp(baseline.conversation),brief:{...baseline.conversation.brief,client:request.body.name,...request.body.profile}};
    return ok({conversation,client:{...bootstrap.clients.find(c=>c.id===conversation.client_id),name:request.body.name,profile:request.body.profile}});
  });
  await client.updateProfile('新任务客户',profile);
  assert.equal(requests.length,1);assert.equal(client.state.options.client,'新任务客户');assert.equal(client.state.options.brand,'新品牌');assert.equal(client.state.options.company,'');assert.equal(client.state.dirty,false);
  assert.equal(client.state.clients.find(c=>c.id===client.state.conversation.client_id).profile.brand,'新品牌');client.dispose();
});

test('档案保存失败不乐观改写任何有效字段；新任务保留服务器档案默认和空平台',async()=>{
  let phase='fail';const newConversation={...cp(baseline.conversation),id:'only-frontend-test',plan_id:null,messages:[],document_ids:[],job_id:null,status:'draft',brief:{...baseline.conversation.brief,brand:'全局新默认',selections:[],keywords:[],note:''}};
  const {client,requests}=setup(request=>{
    if(phase==='fail')return ok({error:'模拟事务失败'},500);
    if(request.method==='POST')return ok({conversation:newConversation});
    if(request.url.endsWith('/documents'))return ok({documents:[]});
    return ok({conversation:newConversation,articles:[],operations:[],documents:[],job:null});
  });
  const before=cp(client.state.options);await assert.rejects(client.updateProfile('不会提交',Object.fromEntries(profileKeys.map(key=>[key,'']))),/模拟事务失败/);assert.deepEqual(client.state.options,before);assert.equal(requests.length,1);
  phase='new';await client.createConversation(newConversation.client_id);assert.equal(client.state.options.brand,'全局新默认');assert.deepEqual(client.state.options.selections,[]);assert.equal(requests.filter(r=>r.url.endsWith('/draft')).length,0);client.dispose();
});

test('元数据显式清空与正文同版保存；409 和锁阻止覆盖',async()=>{
  let conflict=false;const {client,requests}=setup(request=>{
    if(conflict)return ok({error:'当前正文版本已经变化'},409);
    return ok({article:{...baseline.articles[0],...request.body,current_version:901,review:{status:'unverified'},audit:{},geo:{}}});
  });
  const article=client.state.articles[0];await client.saveArticle(article.id,article.body_md,article.title,article.current_version,{tags:[],decl:[]});
  assert.deepEqual(requests[0].body.tags,[]);assert.deepEqual(requests[0].body.decl,[]);assert.equal(requests[0].body.expected_version,2);assert.equal(client.state.articles[0].review.status,'unverified');
  conflict=true;await assert.rejects(client.saveArticle(article.id,article.body_md,article.title,2,{tags:['#旧']}),error=>error instanceof ApiError&&error.status===409);assert.equal(client.state.articles[0].current_version,901);
  client.state.articles[0].locked=true;const count=requests.length;await assert.rejects(client.saveArticle(article.id,'x','x'),/正在处理/);assert.equal(requests.length,count);client.dispose();
});

test('原生重写/再核查 kind、CAS 和成功采用状态；失败不重复提交或替换正文',async()=>{
  for(const action of ['regenerate','audit','failure']) {
    const operation={id:'fixture-'+action,kind:action==='regenerate'?OPERATION_KIND.regenerate:OPERATION_KIND.audit,status:action==='failure'?'error':'done',error:'模拟核查失败',result:{article_id:1,base_version:2,adopted_version:902}};
    const {client,requests}=setup(request=>{
      if(request.method==='POST')return ok({operation_id:operation.id});
      if(request.url.includes('/operations/'))return ok({operation});
      return ok({...cp(baseline),operations:[operation],articles:action==='failure'?cp(baseline.articles):[{...baseline.articles[0],current_version:902,origin:operation.kind,locked:false}]});
    });
    const promise=client.articleOperation(1,action==='failure'?'audit':action,action==='regenerate'?{extra_note:'保留技术条件'}:{});
    if(action==='failure'){await assert.rejects(promise,/模拟核查失败/);assert.equal(client.state.articles[0].current_version,2);}else{const result=await promise;assert.equal(result.adopted_version,902);assert.equal(client.state.articles[0].current_version,902);assert.equal(client.state.operations[0].kind,operation.kind);}
    const posts=requests.filter(r=>r.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].body.expected_version,2);assert.ok(!posts[0].url.startsWith('/api/articles/'));client.dispose();
  }
});

test('只写下一篇使用 write-one，保持原配额、单篇计划和结束停止',async()=>{
  const {client,requests}=setup(request=>{
    if(request.url.endsWith('/draft'))return ok({conversation:{...baseline.conversation,brief:request.body.options,document_ids:request.body.document_ids}});
    if(request.url.endsWith('/write-one'))return ok({job_id:'one-job',operation_id:'one-operation',planned:1,total:4});
    return ok({...cp(baseline),job:{id:'one-job',status:'done',planned:1,done:1}});
  });
  client.state.options.selections=[{platform_id:4,account_type:'official',count:4}];
  await client.start({one:true});assert.equal(client.state.job.planned,1);assert.equal(requests.at(-1).url.endsWith('/write-one'),true);assert.equal(requests.at(-1).body.options.selections[0].count,4);
  const source=client.source;source.onmessage({data:JSON.stringify({type:'end',status:'done'})});await new Promise(setImmediate);assert.equal(source.closed,true);assert.equal(client.state.job.status,'done');assert.equal(requests.filter(r=>r.url.endsWith('/write-one')).length,1);client.dispose();
});

test('稿件删除携带 CAS；历史复用/删除在收尾后使用工作台路径并清理当前视图',async()=>{
  let deletedArticle=false;const clone={...cp(baseline.conversation),id:'frontend-clone',parent_conversation_id:baseline.conversation.id,plan_id:null,messages:[],job_id:null,status:'draft'};
  const {client,requests}=setup(request=>{
    if(request.method==='DELETE'&&request.url.includes('/articles/')){deletedArticle=true;return ok({deleted_id:1});}
    if(request.url.endsWith('/clone'))return ok({conversation:clone});
    if(request.method==='DELETE')return ok({deleted_id:clone.id});
    if(request.url.endsWith('/documents'))return ok({documents:[]});
    if(request.url.includes(clone.id))return ok({conversation:clone,articles:[],documents:[],operations:[],job:null});
    return ok({...cp(baseline),articles:deletedArticle?[]:baseline.articles});
  });
  client.state.job={status:'running'};await assert.rejects(client.cloneConversation(),/等待收尾/);assert.equal(requests.length,0);client.state.job=null;
  await client.deleteArticle(1);assert.deepEqual(requests[0].body,{expected_version:2});assert.deepEqual(client.state.articles,[]);
  await client.cloneConversation();assert.equal(client.state.conversation.id,clone.id);assert.deepEqual(client.state.articles,[]);
  await client.deleteConversation();assert.equal(client.state.conversation,null);assert.ok(requests.filter(r=>r.method==='DELETE'&&!r.url.includes('/articles/')).every(r=>JSON.stringify(r.body)==='{}'));client.dispose();
});

test('任意已配置形态有效；删除/停用/移除形态均提示待调整',()=>{
  const platforms=[{id:100,name:'仅验收平台',formats:['技术问答'],enabled:true}],targets=[{name:'仅验收AI',enabled:true}];
  const options={keywords:['产品'],selections:[{platform_id:100,account_type:'official',count:4}],models:['仅验收AI'],format_overrides:{100:['技术问答']}};
  assert.deepEqual(validateStart(options,platforms,targets),[]);assert.ok(optionIssues(options,[{...platforms[0],formats:['图文']}],targets).some(s=>s.includes('发布形态')));assert.ok(optionIssues(options,[],targets).some(s=>s.includes('平台')));assert.ok(optionIssues(options,platforms,[]).some(s=>s.includes('目标 AI')));
});
