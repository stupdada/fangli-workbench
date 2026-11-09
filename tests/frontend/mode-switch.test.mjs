import test from 'node:test';
import assert from 'node:assert/strict';
import {createModeSwitcher} from '../../web/workbench/mode-switch.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return {promise, resolve, reject};
}
function runtime() {
  let mode = 'chat', task = 'a';
  const saves = [], applied = [];
  const switcher = createModeSwitcher({getMode:()=>mode, getTaskId:()=>task,
    saveMode:next=>{const pending=deferred();saves.push({next,...pending});return pending.promise;},
    applyMode:next=>{mode=next;applied.push(next);}});
  return {switcher,saves,applied,setTask:next=>task=next,setMode:next=>mode=next,get mode(){return mode;}};
}

test('保存成功后切换；重复点击同一待选模式只写一次',async()=>{
  const r=runtime(), first=r.switcher.select('zip');
  assert.equal(r.mode,'chat');
  assert.equal(await r.switcher.select('zip'),false);
  assert.equal(r.saves.length,1);
  r.saves[0].resolve();
  assert.equal(await first,true);assert.equal(r.mode,'zip');
});

test('快速切回当前模式会保存最后选择，迟到结果不能把视图切走',async()=>{
  const r=runtime(), first=r.switcher.select('zip'), latest=r.switcher.select('chat');
  assert.deepEqual(r.saves.map(s=>s.next),['zip','chat']);
  r.saves[1].resolve();assert.equal(await latest,true);
  r.saves[0].resolve();assert.equal(await first,false);
  assert.deepEqual(r.applied,['chat']);assert.equal(r.mode,'chat');
});

test('切换任务期间到达的模式保存结果不影响新任务，并允许重新选择',async()=>{
  const r=runtime(), old=r.switcher.select('zip');
  r.setTask('b');r.saves[0].resolve();
  assert.equal(await old,false);assert.deepEqual(r.applied,[]);
  const retry=r.switcher.select('zip');r.saves[1].resolve();
  assert.equal(await retry,true);
});

test('保存失败保留当前视图；重试、客户页返回和未知模式有明确边界',async()=>{
  const r=runtime(), failed=r.switcher.select('zip');
  r.saves[0].reject(new Error('保存失败'));
  await assert.rejects(failed,/保存失败/);assert.equal(r.mode,'chat');
  const retry=r.switcher.select('zip');r.saves[1].resolve();await retry;
  const same=r.switcher.select('zip',{force:true});r.saves[2].resolve();assert.equal(await same,true);
  await assert.rejects(r.switcher.select('unknown'),/未知/);assert.equal(r.saves.length,3);
});

test('任务状态重置使同任务中尚未完成的模式请求失效',async()=>{
  const r=runtime(), pending=r.switcher.select('zip');
  r.switcher.reset();r.saves[0].resolve();
  assert.equal(await pending,false);assert.equal(r.mode,'chat');
});

test('沿用安排新建后，首次点对话会从分步切回',async()=>{
  const r=runtime();
  r.setTask('new-task');
  r.switcher.reset();
  r.setMode('zip');
  const click=r.switcher.select('chat');
  assert.equal(r.saves[0]?.next,'chat');
  r.saves[0].resolve();
  assert.equal(await click,true);
  assert.equal(r.mode,'chat');
});
