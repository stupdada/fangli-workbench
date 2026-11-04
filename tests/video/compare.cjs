'use strict';
// Explicitly invoked, bounded real WorkBuddy experiment. Never run as an automated test.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const base = path.resolve(__dirname, '../..');
const out = path.resolve(base, '../output/geo-merge-20261104/video');
const common = JSON.parse(fs.readFileSync(path.join(out, 'common-inputs.json'), 'utf8'));
const native = require('../../video/upstream/video-content.js');
const wb = require('../../video/upstream/workbuddy-client.js');
const config = JSON.parse(fs.readFileSync(path.join(base, 'config/workbuddy.json'), 'utf8'));
const save = (file, obj) => {fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(obj,null,2)+'\n','utf8');};
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const counters = {logicalContentCalls:0, sdkContentRequests:0, serviceContentRequests:0, directoryRequests:0, otherRequests:0};
const events = [], activeBodies = new Set();
let current = '', directoryPromise;
function python(action, id) {
  const r=spawnSync('python',['-B',path.join(__dirname,'zip_flow.py'),action,...(id?[id]:[])],
    {encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'}});
  if(r.status!==0)throw new Error('ZIP local processing failed: '+r.stderr.slice(0,600));
}
function release(){ for(const body of activeBodies){try{Promise.resolve(body.cancel()).catch(()=>{});}catch{}}activeBodies.clear(); }
const sdkFetch = async (url, init={}) => {
  let body;try{body=JSON.parse(init.body);}catch{}
  const isContent=Boolean(body?.model&&body?.messages), isDirectory=/\/models(?:\?|$)/.test(String(url));
  if(isContent){if(counters.serviceContentRequests>=6)throw new Error('Content budget exhausted');counters.serviceContentRequests++;}
  else if(isDirectory){if(counters.directoryRequests>=1)throw new Error('Directory budget exhausted');counters.directoryRequests++;}
  else counters.otherRequests++;
  const headers=new Headers(init.headers);headers.set('Origin','http://127.0.0.1');
  const event={lane:current,kind:isContent?'content':isDirectory?'directory':'other',startedAt:new Date().toISOString(),
    requestSha256:isContent?sha(JSON.stringify(body)):undefined};events.push(event);
  try{const response=await fetch(url,{...init,headers});event.status=response.status;event.headersAt=new Date().toISOString();if(response.body)activeBodies.add(response.body);return response;}
  catch(e){event.errorName=e.name;throw e;}
};
function cloud(){
  const memory=new Map(),storage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)};
  const ctx=vm.createContext({fetch:sdkFetch,Headers,Request,Response,URL,URLSearchParams,TextDecoder,TextEncoder,ReadableStream,AbortController,DOMException,crypto:crypto.webcrypto,setTimeout,clearTimeout,localStorage:storage,sessionStorage:storage,console:{log(){},warn(){},error(){}}});ctx.window=ctx;ctx.self=ctx;
  vm.runInContext(fs.readFileSync(path.join(base,'vendor/workbuddy-sdk.js'),'utf8'),ctx);
  const sdk=ctx.WorkBuddyCloud.createWorkBuddyCloud({...config,fetch:sdkFetch});
  return {llm:{models:{list:()=>directoryPromise??=(sdk.llm.models.list())},chat:{completions:{create:params=>{
    counters.sdkContentRequests++;return sdk.llm.chat.completions.create(params);
  }}}}};
}
async function callZip(actual, file, rawFile, label){
  const request=JSON.parse(fs.readFileSync(file,'utf8'));current=label;
  const meta={origin:'unmodified_model_output',startedAt:new Date().toISOString(),requestSha256:sha(fs.readFileSync(file)),finishReason:'',usage:null};
  let raw='';counters.logicalContentCalls++;
  try{for await(const chunk of wb.modelCall(actual,request,{releaseStreams:release,timeouts:{firstByteMs:60000,idleMs:60000}})){
    const c=chunk.choices?.[0];raw+=c?.delta?.content||'';if(c?.finish_reason)meta.finishReason=c.finish_reason;if(chunk.usage)meta.usage=chunk.usage;
  }if(meta.finishReason!=='stop')throw new Error('Incomplete model output');meta.status='completed';}
  catch(e){meta.status='failed';meta.error={name:e.name,code:e.code||e.error?.code||'',message:String(e.message).replaceAll(config.publishableKey||'__none__','[redacted]').slice(0,250)};throw e;}
  finally{fs.writeFileSync(rawFile,raw,'utf8');meta.endedAt=new Date().toISOString();save(rawFile+'.meta.json',meta);release();}
}
async function video(actual, c, mode){
  const directory=path.join(out,'comparison',c.id,'video');fs.mkdirSync(directory,{recursive:true});
  const source={clientId:c.clientId,name:c.name,documents:c.documents};let saved;
  const store=async(op,data)=>{
    if(op==='content.sources')return source;
    if(op==='content.begin')return {created:true,id:data.id};
    if(op==='content.finish'){saved=data;return true;}
    throw new Error('unexpected store operation');
  };
  const input={clientId:c.clientId,requestId:crypto.randomUUID(),topic:c.topic+'\n'+common.requirement};
  if(mode==='capture'){
    let captured;
    const mock={llm:{models:{list:async()=>[{id:common.model,maxInputTokens:10000,maxOutputTokens:1000}]},chat:{completions:{create:async function*(params){captured=params;yield{choices:[{delta:{content:JSON.stringify({title:'捕获原生提示词',body:c.name+'。'.repeat(195)})},finish_reason:'stop'}]};}}}}};
    try{await native.createVideoContent({store,cloud:mock,layout:async()=>({})}).generate(input);}catch{}
    save(path.join(directory,'request.json'),captured);
    save(path.join(directory,'selection.json'),saved?.data?.audit||{error:'capture unavailable'});return;
  }
  current=c.id+'/video';const startedAt=new Date().toISOString();counters.logicalContentCalls++;
  let result,error;
  try{result=await native.createVideoContent({store,cloud:actual,layout:async(body,settings,env,brand)=>{
    // Font pagination only. This does not start FFmpeg or render frames.
    return native.paginate(body,settings,{...process.env,PYTHONDONTWRITEBYTECODE:'1'},brand);
  }}).generate(input);}
  catch(e){error={code:e.code||'',status:e.status||0};}
  finally{release();}
  const data=saved?.data||{};
  fs.writeFileSync(path.join(directory,'raw-generation.txt'),data.responseText||'','utf8');
  save(path.join(directory,'result.json'),{origin:'unmodified_model_output',startedAt,endedAt:new Date().toISOString(),state:saved?.state,error,result,audit:data.audit,finishReason:data.finishReason,usage:data.usage});
}
async function main(){
  if(fs.existsSync(path.join(out,'calls.json')))throw new Error('Experiment already has call evidence; no automatic repeat.');
  python('prepare');for(const c of common.cases)await video(null,c,'capture');
  const files=common.cases.flatMap(c=>['zip','video'].map(flow=>path.join(out,'comparison',c.id,flow,'request.json')));
  save(path.join(out,'prompt-freeze.json'),files.map(file=>({file,sha256:sha(fs.readFileSync(file))})));
  const actual=cloud();current='model-directory';
  const models=wb.usableModels(await actual.llm.models.list());
  save(path.join(out,'model-directory.json'),{queriedAt:new Date().toISOString(),model:common.model,available:models.some(m=>m.id===common.model),sdkSha256:sha(fs.readFileSync(path.join(base,'vendor/workbuddy-sdk.js')))});
  if(!models.some(m=>m.id===common.model))throw new Error('Required WorkBuddy model unavailable');
  // Alternate order per case to avoid always favouring a warmer service path.
  for(const c of common.cases){
    const dir=path.join(out,'comparison',c.id,'zip');
    if(c.id==='industrial')await video(actual,c);
    await callZip(actual,path.join(dir,'request.json'),path.join(dir,'raw-generation.txt'),c.id+'/zip/generation');
    python('finalize',c.id);
    await callZip(actual,path.join(dir,'audit-request.json'),path.join(dir,'raw-audit.txt'),c.id+'/zip/native-audit');
    python('audit',c.id);
    if(c.id==='pet')await video(actual,c);
  }
}
main().then(()=>{save(path.join(out,'calls.json'),{status:'completed',model:common.model,counters,events,actualRenders:0,ttsCalls:0,imageCalls:0,cloudVideoCalls:0});process.stdout.write(JSON.stringify({status:'completed',counters})+'\n');})
.catch(e=>{save(path.join(out,'calls.json'),{status:'failed',model:common.model,counters,events,actualRenders:0,error:{name:e.name,message:String(e.message).replaceAll(config.publishableKey||'__none__','[redacted]').slice(0,300)}});process.stderr.write('Bounded comparison stopped; see calls.json\n');process.exitCode=1;}).finally(release);
