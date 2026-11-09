'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {once}=require('node:events');
const {spawn}=require('node:child_process');
const {start}=require('../../video/server.cjs');
const {createWorkspaceContext,localBase}=require('../../video/workspace-context.cjs');
const root=path.resolve(__dirname,'../../../output/geo-merge-20261104/video/offline');
const traces=[];
const clientId='test-client',otherId='other-client';
const article={article_id:17,version_id:7,title:'冻结稿件',body_md:'这是版本七的正文。',platform_name:'抖音',account_type:'official'};
async function fixture(){
  let adopted=7;
  const server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://localhost');traces.push({type:'workspace-read',method:req.method,url:req.url});
    res.setHeader('Content-Type','application/json; charset=utf-8');
    if(req.method!=='GET'||u.pathname!=='/api/workbench/video-context'){res.writeHead(405);return res.end('{}');}
    const c=u.searchParams.get('client_id');
    if(!c)return res.end(JSON.stringify({ok:true,clients:[{id:clientId,name:'测试客户'},{id:otherId,name:'另一客户'}]}));
    if(![clientId,otherId].includes(c)){res.writeHead(404);return res.end('{}');}
    const value={ok:true,client:{id:c,name:'测试客户',profile:{brand:'测试品牌',company:'测试公司',products:'测试产品'}},documents:[{id:'doc-a',filename:'客户资料.txt',kind:'text',text:'原始资料。',digest:'fixture-digest'}]};
    if(u.searchParams.has('article_id')){
      if(c!==clientId||u.searchParams.get('article_id')!=='17'||u.searchParams.get('version_id')!=='7'){res.writeHead(404);return res.end('{}');}
      value.article=article;
    }
    value.adopted_version=adopted;res.end(JSON.stringify(value));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {url:'http://127.0.0.1:'+server.address().port,setAdopted:v=>{adopted=v;},close:()=>new Promise(r=>server.close(r))};
}
async function freshData(name){const p=path.join(root,name+'-'+Date.now());await fs.mkdir(p,{recursive:true});return p;}
async function json(base,url,method='GET',body){
  const res=await fetch(base+url,{method,headers:{Origin:base,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:res.status,body:await res.json()};
}
function pendingRenderer(){
  let resolveCall;const calls=[];
  let next=new Promise(r=>{resolveCall=r;});
  return {calls,get next(){return next;},render:async options=>{
    const manifest=JSON.parse(await fs.readFile(options.manifest,'utf8'));calls.push(manifest);
    const done=resolveCall;next=new Promise(r=>{resolveCall=r;});done(manifest);
    return new Promise(resolve=>{
      const finish=()=>resolve({success:false,mode:'silent',jobs:[{id:manifest.jobs[0].id,state:'cancelled',mode:'silent',errorCode:'CANCELLED'}]});
      options.signal.addEventListener('abort',finish,{once:true});if(options.signal.aborted)finish();
    });
  }};
}
test('new workspace source contract, immutable versions, manual video, stop/retry and same-origin gate',async()=>{
  const work=await fixture(), renderer=pendingRenderer(), dataDir=await freshData('api');
  const service=await start({port:0,dataDir,workspaceBase:work.url,renderBatch:renderer.render});
  const base='http://127.0.0.1:'+service.port;
  try{
    const config=await json(base,'/api/video/config');assert.equal(config.status,200);assert.equal(config.body.mode,'silent');assert.equal(config.body.contentGeneration.enabled,false);
    const pending=await json(base,'/api/video/content-generations','POST',{});assert.equal(pending.status,410);assert.equal(pending.body.errorCode,'CONTENT_AUTHORING_MOVED');
    const voice=await json(base,'/api/video/voice-previews','POST',{});assert.equal(voice.status,409);assert.equal(voice.body.errorCode,'PREVIEW_DISABLED');
    const clients=await json(base,'/api/video/clients');assert.equal(clients.body.clients.length,2);
    const missingVersion=await json(base,'/api/video/context?clientId='+clientId+'&article_id=17');assert.equal(missingVersion.status,400);
    const missingClient=await json(base,'/api/video/context?article_id=17&version_id=7');assert.equal(missingClient.status,400);
    const context=await json(base,'/api/video/context?clientId='+clientId+'&article_id=17&version_id=7');assert.deepEqual(context.body.article,article);
    const wrongOwner=await json(base,'/api/video/context?clientId='+otherId+'&article_id=17&version_id=7');assert.equal(wrongOwner.status,404);
    const invalidClient=await json(base,'/api/video/batches?clientId=missing');assert.equal(invalidClient.status,404);
    const forbidden=await fetch(base+'/api/video/clients',{headers:{Origin:'http://127.0.0.1:1'}});assert.equal(forbidden.status,403);
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6V1sAAAAASUVORK5CYII=','base64');
    const upload=await fetch(base+'/api/video/upload?clientId='+clientId+'&name=test.png',{method:'POST',headers:{Origin:base,'Content-Type':'image/png'},body:png});assert.equal(upload.status,201);const asset=await upload.json();
    const spec={clientId,mode:'silent',jobs:[{id:'clip-1',title:'新任务',source:{article_id:17,version_id:7},originalText:'画面文字',segments:[{id:'screen-1',text:'画面文字',media:asset.id,durationSeconds:5}]}]};
    const next=renderer.next,created=await json(base,'/api/video/batches','POST',spec);assert.equal(created.status,202);const manifest=await next;
    assert.equal(manifest.mode,'silent');assert.equal(manifest.jobs[0].source.version_id,7);assert.equal(manifest.jobs[0].source.body_md,article.body_md);
    const originalVersion=created.body.version,batchId=created.body.id;
    work.setAdopted(8);
    const status=await json(base,'/api/video/batches/'+batchId+'/status?clientId='+clientId);assert.equal(status.body.jobs[0].source.version_id,7);assert.equal(status.body.version,originalVersion);
    const stopped=await json(base,'/api/video/batches/'+batchId+'/stop','POST',{clientId});assert.equal(stopped.status,200);assert.equal(stopped.body.state,'stopping');await service.handle.whenIdle();
    const cancelled=await json(base,'/api/video/batches/'+batchId+'/status?clientId='+clientId);assert.equal(cancelled.body.state,'cancelled');
    const retriedNext=renderer.next,retried=await json(base,'/api/video/batches/'+batchId+'/retry','POST',{clientId});assert.equal(retried.status,202);await retriedNext;assert.equal(retried.body.id,batchId);assert.equal(retried.body.version,originalVersion);
    await json(base,'/api/video/batches/'+batchId+'/stop','POST',{clientId});await service.handle.whenIdle();
    const duplicate=await json(base,'/api/video/batches','POST',spec);assert.equal(duplicate.status,200);assert.equal(duplicate.body.id,batchId);
    const wrongSpec=structuredClone(spec);wrongSpec.jobs[0].source.version_id=8;assert.equal((await json(base,'/api/video/batches','POST',wrongSpec)).status,404);
    const oldSource=structuredClone(spec);oldSource.jobs[0].source={runId:'old',artifactId:'old',contentVersion:1};assert.equal((await json(base,'/api/video/batches','POST',oldSource)).status,400);
    const standalone=structuredClone(spec);delete standalone.jobs[0].source;standalone.jobs[0].id='independent';const nextIndependent=renderer.next;
    const independent=await json(base,'/api/video/batches','POST',standalone);assert.equal(independent.status,202);await nextIndependent;
    await json(base,'/api/video/batches/'+independent.body.id+'/stop','POST',{clientId});await service.handle.whenIdle();
    const files=await fs.readdir(dataDir);assert(!files.includes('workspace.sqlite3'));assert.equal(renderer.calls.length,3);
    traces.push({type:'api-verification',dataDir,storePid:service.handle.storePid,batchId,version:originalVersion,rendererStubCalls:renderer.calls.length,actualRenders:0,source:created.body.jobs[0].source});
  }finally{await service.close();await work.close();}
});
test('full-text video archive and shared asset removal preserve saved files and job identity',async()=>{
  const work=await fixture(),dataDir=await freshData('recovery');
  const service=await start({port:0,dataDir,workspaceBase:work.url,renderBatch:async ({manifest,output})=>{
    const {jobs:[job]}=JSON.parse(await fs.readFile(manifest,'utf8'));
    const dir=path.join(output,job.id);await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,'video.mp4'),'fixture bytes');
    await fs.writeFile(path.join(dir,'subtitles.srt'),'冻结字幕');
    return {success:true,mode:'silent',jobs:[{id:job.id,state:'completed',mode:'silent',audioTrackCount:0,durationSeconds:5}]};
  }});
  const base='http://127.0.0.1:'+service.port;
  try{
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6V1sAAAAASUVORK5CYII=','base64');
    const upload=await fetch(base+'/api/video/upload?clientId='+clientId+'&name=test.png',{method:'POST',headers:{Origin:base,'Content-Type':'image/png'},body:png});
    assert.equal(upload.status,201);const asset=await upload.json();
    const spec={clientId,mode:'silent',jobs:['one','two'].map(id=>({id,title:id,originalText:'画面文字',segments:[{id:'screen-1',text:'画面文字',media:asset.id,durationSeconds:5}]}))};
    const made=await json(base,'/api/video/batches','POST',spec);assert.equal(made.status,202);
    await service.handle.whenIdle();
    const batch='/api/video/batches/'+made.body.id, query='?clientId='+clientId;
    const before=await json(base,batch+'/status'+query);
    assert.equal(before.body.state,'completed');
    const jobRoute=batch+'/jobs/one/archive',assetRoute='/api/video/assets/'+asset.id+'/lifecycle',assetList='/api/video/assets'+query;
    assert.equal((await json(base,jobRoute,'PUT',{clientId:otherId,archived:true})).status,404);
    assert.equal((await json(base,assetRoute,'PUT',{clientId:otherId,removed:true})).status,400);
    const archived=await json(base,jobRoute,'PUT',{clientId,archived:true});
    assert.ok(archived.body.jobs[0].archivedAt);assert.equal(archived.body.jobs[1].archivedAt,null);
    assert.equal((await json(base,'/api/video/batches'+query+'&archived=1')).body.batches[0].id,made.body.id);
    assert.equal((await json(base,assetRoute,'PUT',{clientId,removed:true})).status,200);
    assert.deepEqual((await json(base,assetList)).body.assets,[]);
    assert.equal((await json(base,assetList+'&removed=1')).body.assets[0].id,asset.id);
    const changed=structuredClone(spec);changed.jobs[0].title='新作品';
    assert.equal((await json(base,'/api/video/batches','POST',changed)).body.errorCode,'ASSET_REMOVED');
    assert.equal(await (await fetch(base+before.body.jobs[0].subtitlesUrl)).text(),'冻结字幕');
    assert.equal((await json(base,assetRoute,'PUT',{clientId,removed:false})).body.id,asset.id);
    assert.equal((await json(base,assetList)).body.assets[0].id,asset.id);
    const restored=await json(base,jobRoute,'PUT',{clientId,archived:false});
    assert.equal(restored.body.jobs[0].archivedAt,null);
    assert.equal(restored.body.jobs[0].version,before.body.jobs[0].version);
    assert.deepEqual((await json(base,'/api/video/batches'+query+'&archived=1')).body.batches,[]);
  }finally{await service.close();await work.close();}
});
test('context rejects wrong returned version and remote endpoints; failure stays closed',async()=>{
  assert.throws(()=>localBase('https://example.com'));assert.throws(()=>localBase('http://localhost/path'));assert.throws(()=>localBase('http://u:p@localhost'));
  const context=createWorkspaceContext('http://127.0.0.1',async()=>new Response(JSON.stringify({client:{id:clientId},documents:[],article:{...article,version_id:8}})));
  await assert.rejects(()=>context.source(clientId,{article_id:17,version_id:7}),e=>e.code==='CONTENT_VERSION_CONFLICT');
  const failed=createWorkspaceContext('http://127.0.0.1',async()=>{throw new Error('offline');});
  await assert.rejects(()=>failed.read(clientId),e=>e.status===503);
});
test('CLI binds loopback and emits exactly one ready JSON, then closes through IPC',async()=>{
  const work=await fixture(),dataDir=await freshData('cli');
  const command=[path.resolve(__dirname,'../../video/server.cjs'),'--port','0','--workspace-base',work.url,'--data-dir',dataDir];
  const child=spawn(process.execPath,command,{windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,FANGLI_VIDEO_ENGINE_ENABLED:'0'}});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stderr.on('data',s=>stderr+=s);
  const exited=once(child,'exit');
  try{
    const ready=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('CLI readiness timed out')),10000);
      child.stdout.on('data',s=>{stdout+=s;if(stdout.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(stdout.split('\n')[0]));}catch(e){reject(e);}}});
      child.once('error',e=>{clearTimeout(timer);reject(e);});
    });assert.equal(ready.type,'ready');assert.equal(ready.pid,child.pid);assert(ready.port>0);
    const config=await json('http://127.0.0.1:'+ready.port,'/api/video/config');assert.equal(config.body.rendererAvailable,false);assert.equal(config.body.mode,'silent');
    child.disconnect();const [code]=await exited;assert.equal(code,0);assert.equal(stdout.trim().split('\n').length,1);assert.equal(stderr,'');
    traces.push({type:'cli',pid:child.pid,command:[process.execPath,...command],dataDir,ready,stdout,stderr,exitCode:code,actualRenders:0});
  }finally{if(child.exitCode===null)child.kill();await work.close();}
});
test.after(async()=>{await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'verification.json'),JSON.stringify({status:'completed',traces,actualRenders:0,modelRequests:0,source:'strict local contract fixture, renderer stub only; outcome is reported by node:test'},null,2)+'\n','utf8');});
