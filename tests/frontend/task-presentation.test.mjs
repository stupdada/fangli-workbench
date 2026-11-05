import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskPresentation} from '../../web/workbench/task-presentation.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function runtime({reduced=false,native=true}={}) {
  const attributes=new Set(),transitions=[],errors=[];let measurements=0;
  const doc={hidden:false,documentElement:{setAttribute:name=>attributes.add(name),removeAttribute:name=>attributes.delete(name)},getElementById:()=>({getBoundingClientRect(){measurements++;}})};
  if(native)doc.startViewTransition=callback=>{
    const ready=deferred(),updated=deferred(),finished=deferred();
    const transition={ready:ready.promise,updateCallbackDone:updated.promise,finished:finished.promise,
      skipTransition(){this.skipped=true;finished.resolve();},
      async apply(){try{await callback();updated.resolve();ready.resolve();}catch(error){updated.reject(error);ready.reject(error);finished.reject(error);}},
      complete(){finished.resolve();}};
    transitions.push(transition);return transition;
  };
  const presentation=createTaskPresentation(doc,{reduced:()=>reduced,onError:error=>errors.push(error)});
  return {doc,attributes,transitions,errors,presentation,get measurements(){return measurements;}};
}

test('快照回调前的连续请求合并为最新界面，提交期间锁定最终布局',async()=>{
  const r=runtime(),seen=[];
  r.presentation.present(()=>seen.push('过时任务'));
  r.presentation.present(()=>{assert.ok(r.attributes.has('data-task-transition'));assert.ok(r.presentation.applying);seen.push('最新任务');});
  assert.deepEqual(seen,[]);assert.equal(r.transitions.length,1);
  await r.transitions[0].apply();assert.deepEqual(seen,['最新任务']);assert.equal(r.measurements,1);
  r.transitions[0].complete();await r.transitions[0].finished;assert.equal(r.attributes.size,0);
});

test('快速切换中断旧动画，旧完成事件不解除新任务的布局锁',async()=>{
  const r=runtime();r.presentation.present(()=>{});await r.transitions[0].apply();
  r.presentation.present(()=>{});await r.transitions[1].apply();
  assert.equal(r.transitions[0].skipped,true);assert.ok(r.attributes.has('data-task-transition'));
  r.transitions[0].complete();await Promise.resolve();assert.ok(r.attributes.has('data-task-transition'));
  r.transitions[1].complete();await r.transitions[1].finished;assert.equal(r.attributes.size,0);
});

test('减少动态效果和缺少快照能力时仍一次提交最终布局',()=>{
  for(const options of [{reduced:true},{native:false}]){
    const r=runtime(options);let updates=0;
    r.presentation.present(()=>{updates++;assert.ok(r.attributes.has('data-task-transition'));});
    assert.equal(updates,1);assert.equal(r.transitions.length,0);assert.equal(r.measurements,1);assert.equal(r.attributes.size,0);
  }
});

test('渲染异常和页面退出均释放锁，过期回调不再修改界面',async()=>{
  const r=runtime();r.presentation.present(()=>{throw new Error('渲染失败');});await r.transitions[0].apply();
  await Promise.resolve();assert.equal(r.attributes.size,0);assert.equal(r.errors[0].message,'渲染失败');
  let changed=false;r.presentation.present(()=>{changed=true;});r.presentation.dispose();await r.transitions[1].apply();
  assert.equal(changed,false);assert.equal(r.attributes.size,0);
});
