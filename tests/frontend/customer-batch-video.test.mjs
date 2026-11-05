import assert from 'node:assert/strict';
import test from 'node:test';
import { CustomerClient } from '../../web/workbench/customers-client.mjs';
import { CustomersWorkspace } from '../../web/workbench/customers.mjs';
import { assertBatchVideoLimit, batchConfirmation, collectBatchVideos } from '../../web/workbench/customer-batch-video.mjs';

function formRows(...rows) {
  return {querySelectorAll:() => rows.map(({topic, source, index = '', narration = true}) => ({
    querySelector:selector => ({
      '[data-batch-video-topic]':{value:topic},
      '[data-batch-video-source]':{value:source},
      '[data-batch-video-index]':{value:index},
      '[data-batch-video-narration]':{checked:narration},
    })[selector],
  }))};
}

test('资料视频可单独安排，文章来源只接受本客户本批次的有效篇序', () => {
  const documents = {topic:' 预约流程 ', source:'documents', index:'4', narration:false};
  const article = {topic:'样件流程', source:'article', index:'2'};
  assert.deepEqual(collectBatchVideos(formRows(documents),0), [{topic:'预约流程',source:'documents',narration:false}]);
  assert.deepEqual(collectBatchVideos(formRows(documents,article),2)[1], {topic:'样件流程',source:'article',article_index:2,narration:true});
  assert.throws(() => collectBatchVideos(formRows(article),0), /需要本批文章/);
  assert.throws(() => collectBatchVideos(formRows(article),1), /第 1 到第 1 篇文章/);
  assert.throws(() => collectBatchVideos(formRows({...article,index:''}),2), /请选择/);
  assert.throws(() => assertBatchVideoLimit([{videos:[documents,article]},{videos:[documents,article]}]), /最多安排 3 条/);
});

test('从预检回执确认两类数量与视频来源，旧版文章回执仍可确认', () => {
  const item = {name:'客户', planned:2, videos:[
    {topic:'<预约流程>',source:'documents',narration:false},
    {topic:'试用准备',source:'article',article_index:2,narration:true},
  ]};
  const check = {ready:true,total:2,video_total:2,items:[item]};
  const result = batchConfirmation(check,() => '客户',[]);
  for (const text of ['2 篇文章、2 条视频','&lt;预约流程&gt;','客户资料直出 · 无配音','本批第 2 篇文章 · 普通话配音']) assert.ok(result.includes(text));
  const old = batchConfirmation({ready:true,total:2,items:[{name:'原客户',planned:2}]},() => '',[]);
  assert.match(old,/2 篇文章、0 条视频/);
});

test('批次详情分开显示进度，已完成视频可下载，单条失败和中断分别重试', async () => {
  const batch = {id:'b/1', status:'partial', total:2, completed:1, video_total:3, video_completed:1, items:[{
    name:'客户', client_id:'客户 1', planned:2, completed:1, videos:[
      {id:'done',topic:'成片',source:'article',article_index:1,status:'done',stage:'done',production_id:'p-1',preview_url:'/api/video/narrated/video.mp4'},
      {id:'failed/2',topic:'失败片',source:'documents',status:'error',stage:'render',production_id:'p-2',error:'合成失败 <详情>'},
      {id:'uncertain',topic:'中断片',source:'article',article_index:2,status:'interrupted',stage:'waiting_article'},
    ],
  }]};
  const requests = [];
  const service = new CustomerClient(async (path,method,payload) => {
    requests.push({path,method,payload});
    return {batch:{...batch,status:'queued'}};
  },{storage:null});
  const ui = Object.create(CustomersWorkspace.prototype);
  Object.assign(ui,{batch,service,showBatch:async value => { ui.batch = value; },modal:(_,html,submit) => { ui.confirm = {html,submit}; }});
  const html = ui.batchView();
  for (const part of ['文章 <strong>1</strong> / 2 篇','视频 <strong>1</strong> / 3 条','等待文章','合成失败 &lt;详情&gt;',
    'href="/api/video/narrated/video.mp4"','production_id=p-2','/api/workbench/batches/b%2F1/video-download','下载已完成视频']) assert.ok(html.includes(part),part);
  assert.equal(html.match(/重试此视频/g).length,2);
  await ui.perform('batch-video-retry',{dataset:{id:'done'}});
  await ui.perform('batch-video-retry',{dataset:{id:'failed/2'}});
  assert.deepEqual(requests,[{path:'/api/workbench/batches/b%2F1/videos/failed%2F2/retry',method:'POST',payload:{}}]);
  await ui.perform('batch-video-retry',{dataset:{id:'uncertain'}});
  assert.match(ui.confirm.html,/处理中断|处理时中断/);
  await assert.rejects(ui.confirm.submit(new FormData()),/请先确认/);
  assert.equal(requests.length,1);
  const acknowledged = new FormData();
  acknowledged.set('ack','on');
  await ui.confirm.submit(acknowledged);
  assert.deepEqual(requests[1].payload,{acknowledge_uncertain:true});
  ui.batch = {...batch,total:0,completed:0,video_completed:0,items:[{...batch.items[0],planned:0}]};
  const videoOnly = ui.batchView();
  assert.doesNotMatch(videoOnly,/下载已完成视频|aria-label="文章进度"/);
  assert.match(videoOnly,/视频 <strong>0<\/strong> \/ 3 条/);
});
