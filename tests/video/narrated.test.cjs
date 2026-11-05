'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {start}=require('../../video/server.cjs');
const {MODEL}=require('../../video/narrated/contract.cjs');

const draft={title:'访客到厂前的准备',script:{paragraphs:[
  {page_id:'p1',text:'访客到厂之前，先向接待人员说明来访日期、到场人数和计划参观的环节。'},
  {page_id:'p2',text:'再确认行程和到达时间，准备好有效证件，到了厂门口按指引登记。'},
  {page_id:'p3',text:'进入现场前，工作人员会发放安全帽，并介绍通行路线和集合地点。'},
  {page_id:'p4',text:'参观时跟随工作人员，结束后按原路线返回接待区，确认下一次沟通安排。'},
]},pages:[
  {id:'p1',heading:'提前沟通',points:['来访日期','到场人数']},
  {id:'p2',heading:'到门口登记',points:['带好有效证件']},
  {id:'p3',heading:'领取安全帽',points:['确认通行路线']},
  {id:'p4',heading:'返回接待区',points:['确认下次沟通']},
]};
function gate(){
  let release;
  const promise=new Promise(resolve=>{release=resolve;});
  return {promise,release};
}
async function fixture(t,hooks={}){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'fangli-narrated-'));
  const client={id:'sample',name:'示例客户',profile:{brand:'示例品牌',company:'示例公司',products:'示例产品'}};
  const other={id:'other',name:'其他客户',profile:{}};
  let documents=[{id:'sample-doc',revision:2,digest:'digest-2',filename:'来访资料.md',text:'进入现场前，工作人员会发放安全帽，并介绍通行路线和集合地点。'}];
  const inputs=[],renders=[];
  const fetchImpl=async url=>{
    assert.equal(url.pathname,'/api/workbench/video-context');
    if(!url.searchParams.has('client_id'))return Response.json({clients:[client,other]});
    if(url.searchParams.get('client_id')===other.id)return Response.json({client:other,documents});
    if(url.searchParams.get('client_id')!==client.id)return Response.json({ok:false,error:'客户不存在'},{status:404});
    await hooks.beforeContext?.();
    let article;
    if(url.searchParams.has('article_id')){
      if(url.searchParams.get('version_id')!=='11')return Response.json({ok:false,error:'视频来源需为明确采用过的稿件版本'},{status:409});
      article={article_id:4,version_id:11,title:'来访流程',body_md:'固定版本原文\n'};
    }
    return Response.json({client,documents,article,source_article:article,style:{version:'fixture-v1'}});
  };
  const workspace=http.createServer(async(req,res)=>{
    try{
      const response=await fetchImpl(new URL(req.url,'http://127.0.0.1'));
      res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());
    }catch{res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>workspace.listen(0,'127.0.0.1',resolve));
  const workspaceBase=`http://127.0.0.1:${workspace.address().port}`;
  const launch=()=>start({port:0,dataDir,workspaceBase,renderBatch:async()=>{},narrated:{
    callModel:async({model,messages,signal})=>{
      inputs.push({model,context:JSON.parse(messages[1].content)});
      await hooks.beforeModel?.({dataDir,signal});
      return {model,text:JSON.stringify({...draft,editorial:{claims:[
        {page_id:'p3',text:'工作人员会发放安全帽',source_id:'sample-doc',quote:'工作人员会发放安全帽'},
        {page_id:'p2',text:'准备好证件',source_id:'sample-doc',quote:'进入现场前，准备好证件'},
      ],issues:[]}}),finishReason:'stop'};
    },
    engine:async request=>{
      await fs.mkdir(request.output,{recursive:true});
      if(request.operation==='health')return {ready:true,narrationReady:true};
      if(request.operation==='asset-preview'){await fs.copyFile(request.asset.file,path.join(request.output,'asset.png'));return {width:1,height:1};}
      if(request.operation==='preview'){await fs.writeFile(path.join(request.output,'page-1.png'),'preview');return {pages:4};}
      renders.push(request);
      await hooks.beforeRender?.({dataDir});
      await fs.writeFile(path.join(request.output,'video.mp4'),'fixture-video');
      return {duration:36,audioStreams:Number(request.narration),actualMp4Encodes:1,actualTtsSegments:request.narration?4:0,captions:request.draft.script.paragraphs};
    },
  }});
  let service;
  const origin=()=>`http://127.0.0.1:${service.port}`;
  t.after(async()=>{if(service)await service.close();await new Promise(resolve=>workspace.close(resolve));
    const target=await fs.realpath(dataDir),temp=await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(target),temp);assert.match(path.basename(target),/^fangli-narrated-/);
    await fs.rm(target,{recursive:true,force:true});});
  service=await launch();
  const api='/api/video/narrated';
  async function request(route,method='GET',body){
    const host=origin();
    const response=await fetch(host+api+route,{method,signal:AbortSignal.timeout(8000),headers:{Origin:host,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,value:await response.json()};
  }
  async function complete(op){const {value}=await request(`/operations/${op.id}?wait=1`);assert.equal(value.status,'completed',value.error);return value;}
  async function create(fields){const {status,value}=await request('/productions','POST',{clientId:client.id,...fields});assert.equal(status,202);return (await complete(value)).production_id;}
  async function restart(beforeStart){
    await service.close();service=null;
    if(beforeStart)await beforeStart();
    service=await launch();
  }
  return {request,create,complete,inputs,renders,get origin(){return origin();},api,dataDir,restart,
    changeDocs(){documents=[{...documents[0],revision:3,text:'修改后的资料。'}];}};
}

test('客户资料只提交选定修订；修改口播另存后保留旧成片与独立下载',async t=>{
  const f=await fixture(t),id=await f.create({topic:'来访流程',document_ids:['sample-doc'],note:'突出到厂前准备',platform:'抖音'});
  assert.equal(f.inputs.length,1);
  assert.equal(f.inputs[0].model,MODEL);
  assert.equal(f.inputs[0].context.documents[0].revision,2);
  assert.equal(f.inputs[0].context.source_article,null);
  assert.equal(f.inputs[0].context.request.note,'突出到厂前准备');
  assert.equal(f.inputs[0].context.request.platform,'抖音');
  const original=(await f.request(`/productions/${id}`)).value;
  assert.equal(original.current.editorial.claims.length,1);
  assert.equal(original.point_max_characters,32);
  assert.deepEqual(original.current.editorial.unresolved.map(c=>[c.page_id,c.reason]),[['p2','来源引文需核对']]);
  f.changeDocs();
  const first=await f.complete((await f.request(`/productions/${id}/renders`,'POST',{expected_version:1})).value);
  const edited=structuredClone(draft);edited.script.paragraphs[0].text=edited.script.paragraphs[0].text.replace('先向','先和');
  const point='确认参观路线、会合地点、接待人员、到场人数、携带证件以及离开时间';
  assert.equal(Array.from(point).length,32);
  edited.pages[0].points=[point+'。'];
  assert.equal((await f.request(`/productions/${id}`,'PUT',{...edited,expected_version:1})).status,400);
  edited.pages[0].points=[point];
  const saved=await f.request(`/productions/${id}`,'PUT',{...edited,expected_version:1});
  assert.equal(saved.status,200);assert.equal(saved.value.version,2);
  assert.deepEqual(saved.value.current.pages[0].points,[point]);
  assert.equal(saved.value.documents[0].revision,2);
  assert.equal(saved.value.current.editorial.claims.length,0);
  assert.equal((await f.request(`/productions/${id}/renders`,'POST',{expected_version:1})).status,409);
  await f.complete((await f.request(`/productions/${id}/renders`,'POST',{expected_version:2,narration:false})).value);
  const {value}=await f.request(`/productions/${id}`);
  assert.equal(value.renders.length,2);assert.notEqual(value.renders[0].script_digest,value.renders[1].script_digest);
  assert.equal(value.renders[1].audioStreams,0);assert.equal(f.renders[1].narration,false);
  const range=await fetch(`${f.origin}${f.api}/productions/${id}/renders/${first.render_id}/video.mp4`,{headers:{Range:'bytes=0-6'}});
  assert.equal(range.status,206);assert.equal(await range.text(),'fixture');
});

test('已采用文章才可生成，后续制作固定文章版本且原始返回仅写本机档案',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/productions','POST',{clientId:'sample',source:{article_id:4,version_id:12}})).status,409);
  assert.equal(f.inputs.length,0);
  const id=await f.create({source:{article_id:4,version_id:11}});
  assert.equal(f.inputs[0].context.source_article.body_md,'固定版本原文\n');
  const {value}=await f.request(`/productions/${id}`);
  assert.deepEqual(value.source,{article_id:4,version_id:11,title:'来访流程'});
  assert.equal(value.raw,undefined);
  const [operation]=await fs.readdir(path.join(f.dataDir,'narrated','operations'));
  const generation=JSON.parse(await fs.readFile(path.join(f.dataDir,'narrated','operations',operation,'generation.json'),'utf8'));
  assert.equal(generation.actualCallCount,1);assert.equal(generation.finishReason,'stop');
  assert.equal(JSON.parse(generation.raw).title,draft.title);
});

function journalFile(dataDir,id){
  return path.join(dataDir,'narrated','operations',id,'operation.json');
}
async function journal(dataDir,id){
  return JSON.parse(await fs.readFile(journalFile(dataDir,id),'utf8'));
}

test('相同键的并发首提、忙时重发和重启后重发共用已持久化操作',async t=>{
  const contexts=gate(),model=gate(),encoder=gate();
  let lookups=0;
  const f=await fixture(t,{
    async beforeContext(){if(++lookups===2)contexts.release();await contexts.promise;},
    beforeModel:()=>model.promise,
    beforeRender:()=>encoder.promise,
  });
  const input={clientId:'sample',topic:'到厂流程',request_key:'batch:item:script:1'};
  let gen,render,productionId;
  try{
    const [a,b]=await Promise.all([
      f.request('/productions','POST',input),
      f.request('/productions','POST',{request_key:input.request_key,topic:input.topic,clientId:input.clientId}),
    ]);
    assert.equal(a.status,202);assert.equal(b.status,202);assert.equal(a.value.id,b.value.id);
    gen=a.value;
    const reserved=await journal(f.dataDir,gen.id);
    assert.equal(reserved.status,'running');
    assert.equal(reserved.request_hash.length,64);
    assert.ok(reserved.planned_result.production_id);
    assert.equal(gen.request_hash,undefined);
    assert.equal(gen.planned_result,undefined);
    assert.equal((await f.request('/productions','POST',input)).value.id,gen.id);
    const changed=await f.request('/productions','POST',{...input,topic:'另一个主题'});
    assert.equal(changed.status,409);assert.match(changed.value.error,/用于不同/);
    const busy=await f.request('/productions','POST',{...input,request_key:'different-key'});
    assert.equal(busy.status,409);assert.match(busy.value.error,/仍在处理/);
    assert.equal((await f.request('/productions','POST',{...input,request_key:null})).status,400);
    assert.equal(lookups,2);
    model.release();
    productionId=(await f.complete(gen)).production_id;

    const renderRoute=`/productions/${productionId}/renders`;
    const media={expected_version:1,narration:true,request_key:'batch:item:render:1'};
    const [first,duplicate]=await Promise.all([
      f.request(renderRoute,'POST',media),
      f.request(renderRoute,'POST',{request_key:media.request_key,narration:true,expected_version:1}),
    ]);
    assert.equal(first.status,202);assert.equal(duplicate.status,202);
    render=first.value;
    assert.equal(duplicate.value.id,render.id);
    assert.ok((await journal(f.dataDir,render.id)).planned_result.render_id);
    const conflict=await f.request(renderRoute,'POST',{...media,narration:false});
    assert.equal(conflict.status,409);assert.match(conflict.value.error,/用于不同/);
    assert.equal((await f.request(renderRoute,'POST',{...media,request_key:input.request_key})).status,409);
    encoder.release();
    const completed=await f.complete(render);
    assert.ok(completed.render_id);
    assert.equal((await f.request(`/productions/${productionId}`,'PUT',{...draft,expected_version:1})).status,200);
    assert.deepEqual((await f.request(renderRoute,'POST',media)).value,completed);

    // Recreate the on-disk states after publication and before journal completion.
    await f.restart(async()=>{
      const {production_id,finished_at,...written}=await journal(f.dataDir,gen.id);
      assert.equal(production_id,productionId);
      await fs.writeFile(journalFile(f.dataDir,gen.id),JSON.stringify({...written,status:'running'}),'utf8');
      const stored=await journal(f.dataDir,render.id);
      assert.equal(stored.render_id,completed.render_id);
      delete stored.render_id;
      delete stored.finished_at;
      await fs.writeFile(journalFile(f.dataDir,render.id),JSON.stringify({...stored,status:'running'}),'utf8');
    });
    const recovered=await f.request('/productions','POST',input);
    assert.equal(recovered.status,202);assert.equal(recovered.value.id,gen.id);
    assert.equal(recovered.value.status,'completed');assert.equal(recovered.value.production_id,productionId);
    const replayed=await f.request(renderRoute,'POST',media);
    assert.equal(replayed.status,202);assert.equal(replayed.value.status,'completed');
    assert.equal(replayed.value.id,completed.id);assert.equal(replayed.value.render_id,completed.render_id);
    assert.equal((await f.request(`/operations/${render.id}`)).value.render_id,completed.render_id);
    assert.equal(f.inputs.length,1);assert.equal(f.renders.length,1);
  }finally{
    contexts.release();model.release();encoder.release();
  }
});

test('持久化后中断且无成品时，旧键保留中断状态并由新尝试明确恢复',async t=>{
  const entered=gate();
  let modelAttempts=0;
  const f=await fixture(t,{
    beforeModel({signal}){
      if(++modelAttempts>1)return;
      entered.release();
      return new Promise((resolve,reject)=>{
        const interrupted=()=>reject(new Error('fixture interrupted'));
        if(signal.aborted)interrupted();
        else signal.addEventListener('abort',interrupted,{once:true});
      });
    },
  });
  const input={clientId:'sample',topic:'到厂流程',request_key:'batch:interrupted:script:1'};
  const initial=await f.request('/productions','POST',input);
  assert.equal(initial.status,202);
  await entered.promise;
  const original=await journal(f.dataDir,initial.value.id);
  await f.restart(async()=>{
    const interrupted=await journal(f.dataDir,initial.value.id);
    assert.equal(interrupted.status,'interrupted');
    await fs.writeFile(journalFile(f.dataDir,initial.value.id),JSON.stringify(original),'utf8');
  });
  const replay=await f.request('/productions','POST',input);
  assert.equal(replay.status,202);
  assert.equal(replay.value.id,initial.value.id);
  assert.equal(replay.value.status,'interrupted');
  assert.equal(replay.value.production_id,undefined);
  assert.equal((await f.request(`/operations/${initial.value.id}`)).value.status,'interrupted');
  assert.equal(f.inputs.length,1);
  const next=await f.request('/productions','POST',{...input,request_key:'batch:interrupted:script:2'});
  assert.equal(next.status,202);assert.notEqual(next.value.id,initial.value.id);
  await f.complete(next.value);
  assert.equal(f.inputs.length,2);
});

test('短视频详情按指定客户打开目标制作，忽略其他制作的待处理操作',async t=>{
  const f=await fixture(t);
  const productionId=await f.create({topic:'到厂流程'});
  const render=await f.complete((await f.request(`/productions/${productionId}/renders`,'POST',{expected_version:1,narration:false})).value);
  const ui=await fs.readFile(path.join(__dirname,'../../video/public/narrated.js'),'utf8');
  async function open(query){
    const nodes=new Map(),requests=[];
    const location=new URL(`/video/narrated/?${query}`,f.origin);
    const element=()=>({
      value:'',textContent:'',dataset:{},children:[],attributes:new Map(),
      set id(id){nodes.set(id,this);},
      append(...children){this.children.push(...children);},
      replaceChildren(){this.children=[];},
      querySelectorAll(){return [];},
      setAttribute(key,value){this.attributes.set(key,value);},
      getAttribute(key){return this.attributes.get(key)||null;},
      hasAttribute(key){return this.attributes.has(key);},
      removeAttribute(key){this.attributes.delete(key);},
      addEventListener(){},
    });
    const getElementById=id=>{
      if(!nodes.has(id))nodes.set(id,element());
      return nodes.get(id);
    };
    await vm.runInNewContext(ui,{
      URL,URLSearchParams,location,
      document:{getElementById,createElement:element},
      window:{addEventListener(){}},
      history:{replaceState(_data,_unused,url){location.href=url.href;}},
      sessionStorage:{getItem:()=> 'previous',removeItem(){assert.fail('应保留其他制作的操作');}},
      fetch:async route=>{
        requests.push(route);
        if(route===`${f.api}/operations/previous`){
          return Response.json({id:'previous',client_id:'sample',production_id:'a-different-production',status:'completed'});
        }
        return fetch(new URL(route,f.origin));
      },
    });
    return {nodes,requests,location};
  }
  const correct=await open(`client_id=sample&production_id=${productionId}`);
  assert.equal(correct.nodes.get('short-title').value,draft.title);
  assert.equal(correct.nodes.get('short-status').textContent,'');
  assert.equal(correct.nodes.get('short-release').hidden,false);
  assert.ok(correct.nodes.get('short-downloads').children.some(link=>link.href.endsWith(`/renders/${render.render_id}/publish.txt`)));
  assert.equal(correct.location.searchParams.get('production_id'),productionId);
  assert.ok(correct.requests.includes(`${f.api}/productions/${productionId}?client_id=sample`));
  assert.ok(correct.requests.includes(`${f.api}/operations/previous`));
  assert.ok(!correct.requests.some(route=>route.includes('a-different-production')));
  const wrong=await open(`client_id=other&production_id=${productionId}`);
  assert.equal(wrong.nodes.get('short-title').value,'');
  assert.match(wrong.nodes.get('short-status').textContent,/制作记录不存在/);
  assert.equal((await f.request(`/productions/${productionId}?client_id=other`)).status,404);
  const unscoped=await open(`production_id=${productionId}`);
  assert.match(unscoped.nodes.get('short-status').textContent,/同时指定客户/);
  assert.ok(!unscoped.requests.some(route=>route.includes(productionId)));
});

test('同客户素材绑定制作版本，模板和发布信息随指定成片导出',async t=>{
  const f=await fixture(t);
  const picture=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X+1sAAAAASUVORK5CYII=','base64');
  const response=await fetch(f.origin+'/api/video/upload?clientId=sample&name=photo.png',{
    method:'POST',headers:{Origin:f.origin,'Content-Type':'image/png'},body:picture,
  });
  assert.equal(response.status,201);
  const image=await response.json();
  const listed=await fetch(f.origin+'/api/video/assets?clientId=sample').then(r=>r.json());
  assert.deepEqual(listed.assets,[{id:image.id,name:'photo.png',type:'image/png',size:picture.length}]);
  const other=await fetch(f.origin+'/api/video/assets?clientId=other').then(r=>r.json());
  assert.deepEqual(other.assets,[]);
  const file=`${f.origin}${f.api}/asset-previews/${image.id}`;
  assert.equal((await fetch(file+'?client_id=other')).status,400);
  const preview=await fetch(file+'?client_id=sample');
  assert.equal(preview.status,200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()),picture);
  const denied=await f.request('/productions','POST',{clientId:'other',topic:'测试客户隔离',asset_ids:[image.id]});
  assert.equal(denied.status,202);
  assert.equal((await f.request(`/operations/${denied.value.id}?wait=1`)).value.status,'failed');
  assert.equal(f.inputs.length,0);

  const id=await f.create({topic:'到厂流程',template:'intro',asset_ids:[image.id]});
  const route=`/productions/${id}`;
  const first=(await f.request(route)).value.current;
  assert.equal(first.template,'intro');
  assert.equal(f.inputs[0].context.request.template,'intro');
  assert.ok(first.pages.every(page=>page.asset_id===image.id));
  assert.deepEqual(Object.keys(first.assets[0]).sort(),['id','name','sha256','type']);
  const made=await f.complete((await f.request(route+'/renders','POST',{expected_version:1,narration:false})).value);
  assert.equal(f.renders[0].media[image.id].type,'image/png');

  const second=structuredClone(first);
  second.template='qa';
  second.publish={title:'到厂参观前怎么准备',description:'提前确认行程与登记要求。'};
  second.pages[0].layout='process';
  delete second.pages[0].asset_id;
  const saved=await f.request(route,'PUT',{...second,expected_version:1});
  assert.equal(saved.status,200);assert.equal(saved.value.version,2);
  assert.equal(saved.value.current.template,'qa');
  assert.equal(saved.value.current.pages[0].layout,'process');
  assert.equal(saved.value.current.pages[0].asset_id,undefined);
  assert.deepEqual(saved.value.current.publish,second.publish);
  assert.deepEqual(saved.value.renders[0].publish,first.publish);
  const publish=await fetch(`${f.origin}${f.api}${route}/renders/${made.render_id}/publish.txt`);
  assert.equal(publish.status,200);
  assert.match(publish.headers.get('content-disposition'),/publish\.txt/);
  assert.equal(await publish.text(),`发布标题\n${first.publish.title}\n\n发布简介\n${first.publish.description}\n`);
});
