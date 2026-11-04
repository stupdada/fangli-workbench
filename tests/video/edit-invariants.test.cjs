'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const UI=require('../../video/public/video-ui.js'),Content=require('../../video/public/content.js');
test('editing, reordering and removing screens preserves exact body coverage and original article evidence',()=>{
  const batch=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../output/geo-merge-20261104/video/productization/submitted-batch.json'),'utf8'));
  const job=structuredClone(batch.jobs[0]),controller=UI.createController();job.targetPreset='free';job.revision=1;
  controller.state.clientId=batch.clientId;controller.state.config={mode:'silent',rendererAvailable:true};
  controller.state.draft={clientId:batch.clientId,mode:'silent',jobs:[job],assets:[...new Set(job.segments.map(s=>s.media))].map(id=>({id,clientId:batch.clientId})),snapshots:{}};controller.selectJob(job.id);
  const source=JSON.stringify(job.source),original=job.editorial.originalMarkdown;
  const equal=()=>assert.equal(Content.canon(job.originalText),Content.canon(job.segments.map(s=>s.text).join('')));
  controller.editSegment(job.segments[0].id,'text','这是用户修改的画面。');equal();
  controller.moveSegment(job.segments[0].id,1);equal();
  controller.removeSegment(job.segments.at(-1).id);equal();
  assert.equal(JSON.stringify(job.source),source);assert.equal(job.editorial.originalMarkdown,original);
  assert.equal(controller.payload().jobs[0].source.version_id,7);
});
test('incomplete article entry is rejected before loading another source or independent draft',async()=>{
  const calls=[],controller=UI.createController({initialSource:{requested:true,clientId:'customer',article_id:17,version_id:0},fetch:async url=>{calls.push(url);return new Response(JSON.stringify(url==='/api/video/clients'?{clients:[{id:'customer',name:'客户'}]}:{mode:'silent',rendererAvailable:true}));}});
  await assert.rejects(()=>controller.initialize(),/必须完整指定/);assert.equal(controller.state.draft,null);assert(!calls.some(url=>url.includes('context')||url.includes('content-imports')));
});
