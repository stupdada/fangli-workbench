'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {start}=require('../../video/server.cjs');
const Content=require('../../video/public/content.js');
const UI=require('../../video/public/video-ui.js');
const {startFixture,fixtures,evidence}=require('./product-fixture.cjs');
const traces=[];
test('ZIP line classification preserves complete 580/709-character bodies and all editorial rows',async()=>{
  for(const [index,f] of fixtures.entries()){
    const partition=Content.partition(f.article.body_md);
    assert.equal(partition.displayCharacters,[580,709][index]);assert(partition.allNonblankLinesClassified);
    assert(!partition.displayBody.includes('画面：'));assert(!partition.displayBody.includes('声明：'));
    assert(partition.rows.some(r=>r.kind==='visual_instruction'));assert(partition.rows.some(r=>r.kind==='publication_declaration'));
    if(index===0)assert(Content.relations(partition.displayBody,f).some(n=>n.includes('客户/品牌关系')));
    else assert(Content.relations(partition.displayBody,f).some(n=>n.includes('工位安排')));
  }
  assert.equal(Content.partition('## 资料\n- 一般用途15—20微米\n- 画面：展示样件\n声明：含AI生成内容').displayBody,'一般用途15—20微米');
});
test('real HTTP/controller/font pagination: complete long ZIP imports, consent, source provenance and changed immutable versions',async()=>{
  const fixture=await startFixture(),dataDir=path.join(evidence,'productization/offline/data-'+Date.now());
  let signalStart;const rendererStarted=new Promise(r=>{signalStart=r;});
  const renderer=async options=>{signalStart();return new Promise(resolve=>{const finish=()=>resolve({success:false,mode:'silent',jobs:[{id:'irrelevant',state:'cancelled',errorCode:'CANCELLED'}]});options.signal.addEventListener('abort',finish,{once:true});if(options.signal.aborted)finish();});};
  const service=await start({port:0,dataDir,workspaceBase:fixture.url,renderBatch:renderer});
  const base='http://127.0.0.1:'+service.port;
  const fetcher=(url,init={})=>fetch(base+url,{...init,headers:{Origin:base,...init.headers}});
  const records=new Map(),controller=UI.createController({fetch:fetcher,storage:{getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v)}});
  try{
    await controller.initialize();assert.equal(controller.state.clients.length,2);
    const config=controller.state.config;assert.equal(config.contentGeneration.state,'zip-workbench');assert.equal(config.contentPresets.short.maxCharacters,250);
    const old=await fetcher('/api/video/content-generations',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(old.status,410);assert.equal((await old.json()).authoringUrl,'/workbench/zip/index.html');
    for(const [index,f] of fixtures.entries()){
      await controller.switchClient(f.client.id);controller.editJob('article_id',f.article.article_id);controller.editJob('version_id',f.article.version_id);
      await controller.importArticle();const job=controller.job();
      assert.equal(Content.count(job.originalText),[580,709][index]);assert.equal(Content.canon(job.segments.map(s=>s.text).join('')),Content.canon(job.originalText));
      assert(job.segments.length<=100);assert(UI.duration(job).seconds>75&&UI.duration(job).seconds<600);assert(job.segments.every(s=>s.durationSeconds>=3));
      assert.deepEqual(job.editorial.provenance.structured,f.article.zip_data);assert.equal(job.editorial.provenance.rawAudit,f.article.raw_audit);assert(!job.targetAcknowledged);
      traces.push({type:'import-layout',clientId:f.client.id,article_id:f.article.article_id,version_id:f.article.version_id,characters:Content.count(job.originalText),screens:job.segments.length,durationSeconds:UI.duration(job).seconds,completeDisplay:true,provenance:true,relationNotes:Content.relations(job.originalText,controller.state.context)});
    }
    const f=fixtures[1],job=controller.job();assert.throws(()=>controller.payload(),/未满足/);
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6V1sAAAAASUVORK5CYII=','base64');
    await controller.upload([new File([bytes],'stub.png',{type:'image/png'})]);controller.fillScreens();controller.editJob('targetAcknowledged',true);
    const originalBody=job.originalText;await controller.submit();await rendererStarted;
    const first=controller.state.batches[0];assert.equal(first.jobs[0].source.version_id,f.article.version_id);assert.equal(first.jobs[0].editorial.originalMarkdown,f.article.body_md);assert.equal(first.jobs[0].source.provenance.rawGeneration,f.article.raw_generation);
    fixture.setCurrentVersion(999);
    await controller.batchAction(first.id,'stop');await service.handle.whenIdle();
    controller.editJob('originalText',originalBody+'请结合实际零件安排。');await controller.relayoutGeo();controller.fillScreens();assert(!job.targetAcknowledged);controller.editJob('targetAcknowledged',true);
    await controller.submit();const second=controller.state.batches[0];assert.notEqual(second.id,first.id);assert.notEqual(second.version,first.version);assert.equal(second.jobs[0].source.version_id,f.article.version_id);assert(second.jobs[0].editorial.currentEdited);
    await controller.batchAction(second.id,'stop');await service.handle.whenIdle();
    const check=await fetcher('/api/video/batches/'+first.id+'/status?clientId='+f.client.id);const firstAgain=await check.json();assert.equal(firstAgain.jobs[0].originalText,originalBody);assert.equal(firstAgain.version,first.version);
    const forged=controller.payload();forged.jobs[0].segments.pop();const missing=await fetcher('/api/video/batches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(forged)});assert.equal(missing.status,400);
    const view=UI.editorMarkup(controller);assert(view.includes('ZIP原生核查'));assert(!view.includes('生成GEO文案'));assert(!view.includes('选宠消费者'));
    const before=fixture.requests.length;const redirect=await fetch(base+'/workbench/zip/index.html',{redirect:'manual'});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),fixture.url+'/workbench/zip/index.html');assert.equal(fixture.requests.length,before);
    traces.push({type:'new-versions',firstId:first.id,secondId:second.id,firstVersion:first.version,secondVersion:second.version,sourceVersion:f.article.version_id,oldBodyUnchanged:true,partialSubtitleRejected:true,modelCalls:0,actualRenders:0});
    assert(fixture.requests.every(r=>r.method==='GET'));
  }finally{controller.destroy();await service.close();await fixture.close();}
});
test.after(async()=>{const directory=path.join(evidence,'productization/offline');await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify({status:'completed',traces,modelCalls:0,actualRenders:0,method:'new productization boundaries only; renderer stub and strict read-only context fixture'},null,2)+'\n','utf8');});
