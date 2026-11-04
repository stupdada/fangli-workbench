'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {createWorkspaceContext}=require('../../video/workspace-context.cjs');
const base='http://127.0.0.1:60128',shop='34847c7e-debc-4839-b680-2f5b51d36fae',industry='584dd9da-3ede-42d6-b754-ef924b523df4';
const out=path.resolve(__dirname,'../../../output/geo-merge-20261104/video/unified-004');
const receipts=[];
test('fresh video adapter preserves actual workbench 409, ownership404 and parameter400 with public reasons',async()=>{
  const transport=async(url,options)=>{const response=await fetch(url,options),body=await response.clone().json();receipts.push({url:String(url),status:response.status,publicError:body.error});return response;};
  const context=createWorkspaceContext(base,transport);
  await assert.rejects(()=>context.read(industry,{article_id:1,version_id:8}),error=>error.status===409&&error.code==='CONTENT_VERSION_CONFLICT'&&error.message===receipts.at(-1).publicError);
  await assert.rejects(()=>context.read(shop,{article_id:1,version_id:8}),error=>error.status===404&&error.code==='NOT_FOUND'&&error.message===receipts.at(-1).publicError);
  const missing=createWorkspaceContext(base,(url,options)=>{const changed=new URL(url);changed.searchParams.delete('version_id');return transport(changed,options);});
  await assert.rejects(()=>missing.read(shop,{article_id:2,version_id:9}),error=>error.status===400&&error.code==='INVALID_INPUT'&&error.message===receipts.at(-1).publicError);
  assert.equal(receipts.length,3);
});
test('unstructured or private diagnostics stay private; unknown failures remain closed without retries',async()=>{
  const cases=[
    {status:409,body:'<html>Traceback C:\\private\\config.json</html>',want:409},
    {status:400,body:JSON.stringify({ok:false,error:'Traceback C:\\private\\config.json wbpk_test_not_a_real_key'}),want:400},
    {status:500,body:JSON.stringify({ok:false,error:'内部调用失败 token=private-test-value'}),want:503},
    {status:200,body:'not-json',want:503}
  ];
  for(const item of cases){let calls=0;const context=createWorkspaceContext(base,async()=>{calls++;return new Response(item.body,{status:item.status});});await assert.rejects(()=>context.read(shop),error=>error.status===item.want&&!/private|Traceback|wbpk_|token=/i.test(error.message));assert.equal(calls,1);}
  let calls=0;const network=createWorkspaceContext(base,async()=>{calls++;throw new Error('private network diagnostic');});await assert.rejects(()=>network.read(shop),error=>error.status===503&&!error.message.includes('private'));assert.equal(calls,1);
});
test.after(async()=>{await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'adapter-errors.json'),JSON.stringify({method:'newly loaded video workspace adapter against the existing main service; no service restart',receipts,modelCalls:0,encoderCalls:0,automaticRetries:0},null,2)+'\n','utf8');});
