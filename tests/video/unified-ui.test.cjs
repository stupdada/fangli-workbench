'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const UI=require('../../video/public/video-ui.js');
test('partial editorial metadata on reused media cannot break the history or article import view',()=>{
  const job={id:'protocol-reused-video',title:'既有样片',state:'completed',completedSegments:35,totalSegments:35,segments:[{text:'完整保留',durationSeconds:3}],audioTrackCount:0,durationSeconds:169.12,editorial:{origin:'protocol-media-reuse',originalBatchId:'old',newEncoding:false}};
  const html=UI.batchesMarkup({batches:[{id:'fixture',clientId:'client',mode:'silent',state:'completed',jobs:[job]}],draft:null});
  assert(html.includes('此制作记录未提供原稿'));assert(html.includes('此制作记录未提供分镜分类'));assert(html.includes('此制作记录未提供原生来源证据'));
  assert(html.includes('原制作批次 old'));
});
test('reopening a fixed article entry restores that exact edited draft and never reimports old structured text',async()=>{
  const make=(id,version,body)=>({id,title:id,width:720,height:1280,textStyle:{position:'bottom',preset:'white-outline',fontSize:48},segments:[{id:'s-'+id,text:body,media:'',durationSeconds:5}],originalText:body,source:{article_id:2,version_id:version},sourceInput:{article_id:2,version_id:version},editorial:{originalMarkdown:'固定版本'+version+'的原文'},revision:6,targetPreset:'free',minimumSeconds:3});
  const saved={clientId:'client',mode:'silent',jobs:[make('other-version',4,'另一个版本的草稿'),make('wanted-version',9,'用户已经编辑并保存的视频正文')],assets:[],snapshots:{}},calls=[];
  const fetcher=async url=>{calls.push(url);let body;if(url.startsWith('/api/video/config'))body={mode:'silent',rendererAvailable:true};else if(url==='/api/video/clients')body={clients:[{id:'client',name:'测试客户'}]};else if(url.startsWith('/api/video/context'))body={client:{id:'client',name:'测试客户',profile:{}},documents:[]};else if(url.startsWith('/api/video/batches'))body={batches:[]};else throw Error('Unexpected import or model request');return new Response(JSON.stringify(body));};
  const controller=UI.createController({fetch:fetcher,storage:{getItem:()=>JSON.stringify(saved),setItem(){}},initialSource:{requested:true,clientId:'client',article_id:2,version_id:9}});
  await controller.initialize();assert.equal(controller.job().id,'wanted-version');assert.equal(controller.job().originalText,'用户已经编辑并保存的视频正文');assert.equal(controller.job().source.version_id,9);assert.equal(controller.state.draft.jobs[0].originalText,'另一个版本的草稿');assert.equal(controller.job().editorial.originalMarkdown,'固定版本9的原文');assert(!calls.some(url=>url.includes('content-imports')||url.includes('content-layouts')));
});
