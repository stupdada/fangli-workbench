import assert from 'node:assert/strict';
import test from 'node:test';
import { CustomerClient } from '../../web/workbench/customers-client.mjs';
import { CustomersWorkspace } from '../../web/workbench/customers.mjs';
import { assertBatchVideoLimit } from '../../web/workbench/customer-batch-video.mjs';
import { createTopicHistory, TopicChoice } from '../../web/workbench/topic-recommendation.mjs';

test('资料视频的主题推荐在提交之外进行，批次条数限制照常生效', async () => {
  const item = {client_id:'客户', videos:[{source:'documents'}]};
  const calls = [];
  const service = new CustomerClient(async (path, method, body) => {
    calls.push({path, method, body});
    return {topics:{'video:1':['推荐题一','推荐题二']}};
  }, {storage:null});
  const seen = ['上一批题目'];
  const topics = await service.batchTopics(item,'revision',['video:1'],seen,2);
  assert.deepEqual(calls,[{path:'/api/workbench/batches/topics',method:'POST',
    body:{item,revision:'revision',rows:['video:1'],seen,count:2}}]);
  assert.deepEqual(topics.topics['video:1'],['推荐题一','推荐题二']);
  assert.equal(service.pending,null);
  assert.throws(() => assertBatchVideoLimit([item,item,item,item]), /最多安排 3 条/);
});

test('推荐历史拒绝重复题目，更新推荐保留手选和取消状态', async () => {
  const history = createTopicHistory(), choice = new TopicChoice();
  const first = await history(async (seen,count) => {
    assert.deepEqual([seen,count],[[],3]);
    return {'1':['默认题','备选甲','备选乙']};
  },['1'],3);
  choice.setRecommended(first['1']);
  assert.deepEqual([choice.topic,choice.options],['默认题',['默认题','备选甲','备选乙']]);
  choice.select(choice.options[1]);
  const more = await history(async (seen,count) => {
    assert.deepEqual([seen,count],[['默认题','备选乙','备选甲'],2]);
    return {'1':['新备选甲','新备选乙']};
  },['1'],2,[choice.topic]);
  choice.setAlternatives(more['1']);
  assert.deepEqual(choice.options,['备选甲','新备选甲','新备选乙']);
  choice.excluded = true;
  assert.deepEqual([choice.topic,choice.excluded],['备选甲',true]);
  await assert.rejects(history(async () => ({'1':'默认题？'}),['1'],1),/已看过/);
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
