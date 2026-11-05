// Isolated HTTP contract substitute. Never imported by production pages.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { PROFILE_FIELDS, normalizeOptions, validateStart } from '../../web/workbench/model.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)), root=path.resolve(here,'../..');
const seed=JSON.parse(await readFile(path.join(here,'fixtures/native-config.json'),'utf8'));
const cp=value=>JSON.parse(JSON.stringify(value));
const now=()=>new Date().toISOString();
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.woff2':'font/woff2','.png':'image/png','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.ttf':'font/ttf'};
class HttpError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export async function createPreview({persistPath=null,segmentDelay=350,operationDelay=200,failAt=null}={}) {
  let state={...cp(seed),clients:[],conversations:[],documents:[],articles:[],versions:[],operations:[],jobs:[],records:[],requests:[],model_calls:0,
    settings:{model:'deepseek-v4.1-flash',temperature:0.7,max_tokens:8192,title_prefix:false}};
  if(persistPath)try{state=JSON.parse(await readFile(persistPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  // An interrupted fixture process never resurrects fake model work.
  state.jobs.forEach(j=>{if(j.status==='running'){j.status='interrupted';j.message='离线预览进程已重启，请明确继续';}});
  state.operations.forEach(o=>{if(o.status==='running'){o.status='interrupted';o.error='离线预览进程已重启';}});
  state.articles.forEach(a=>a.locked=false);
  const channels=new Map(),timers=new Set();let persistQueue=Promise.resolve();
  const persist=()=>{if(!persistPath)return Promise.resolve();const data=JSON.stringify(state,null,2);persistQueue=persistQueue.catch(()=>{}).then(async()=>{await mkdir(path.dirname(persistPath),{recursive:true});await writeFile(persistPath,data,'utf8');});return persistQueue;};
  const later=(fn,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);return timer;};
  const findConversation=id=>{const c=state.conversations.find(c=>c.id===id);if(!c)throw new HttpError('任务不存在',404);return c;};
  const findArticle=(c,id)=>{const a=state.articles.find(a=>a.id===Number(id)&&a.conversation_id===c.id);if(!a)throw new HttpError('稿件不存在',404);return a;};
  const assertVersion=(a,b)=>{if(a.locked)throw new HttpError('这篇稿件正在处理',409);if(a.current_version!==b.expected_version)throw new HttpError('版本已变化，请保留编辑并核对最新版本',409);};
  const addVersion=(a,origin,label,body,title=a.title,review=null,parent=a.current_version)=>{
    const v={id:state.versions.length+1,article_id:a.id,parent_id:parent||null,origin,label,article:{...cp(a),body_md:body,title,locked:false},review,created_at:now()};state.versions.push(v);return v;
  };
  const adopt=(a,v)=>{Object.assign(a,{title:v.article.title,body_md:v.article.body_md,current_version:v.id,version_label:v.label,origin:v.origin,review:v.review,locked:false});};
  const emit=(job,event)=>{channels.get(job.id)?.emit('data',event);};
  const endJob=(job,status,error='')=>{
    job.status=status;job.error=error;job.message=status==='done'?'离线示例已保存':status==='paused'?'当前篇已收尾，后续已暂停':'离线示例写作失败，已有稿件保留';
    findConversation(job.conversation_id).status=status;
    const active=state.articles.find(a=>a.id===job.article_id);if(active)active.locked=false;
    emit(job,{type:'end',status,title:active?.title||'',message:job.message,error,article_id:active?.id||null,items:job.items,done:job.done,planned:job.planned,remaining:job.total-job.done,total_all:job.total,canceled:job.cancel,chars:job.partial.length});persist();
  };
  function runJob(job,queue,index=0) {
    if(index>=queue.length){endJob(job,'done');return;}
    if(job.cancel){endJob(job,'paused');return;}
    const selected=queue[index],platform=state.platforms.find(p=>p.id===selected.platform_id);
    const aid=state.articles.length+1;
    const a={id:aid,conversation_id:job.conversation_id,title:`离线示例 · ${job.options.keywords.join('、')}的用途与选型 ${index+1}`,body_md:'',platform_name:platform.name,platform_id:platform.id,account_type:selected.account_type,fmt:(job.options.format_overrides[platform.id]||platform.formats)[index%(job.options.format_overrides[platform.id]||platform.formats).length],angle:'疑问型',keyword:job.options.keywords[0],keywords:job.options.keywords,tags:[],decl:[],locked:true,current_version:null,origin:'zip',version_label:'处理中',review:null};
    state.articles.push(a);job.seg=index+1;job.article_id=aid;job.platform=platform.name;job.account_type=selected.account_type;job.index=index+1;job.words=job.options.keywords;job.partial='';
    emit(job,{type:'next',seg:job.seg,platform:platform.name,account_type:a.account_type,words:job.words,index:index+1,count:queue.length,done:job.done,planned:job.planned,total_all:job.total,prev:job.items.at(-1)||null});
    const body=`【离线接口替身示例；未调用模型】\n\n了解 ${job.options.keywords.join('、')}，可以先从用途和使用场景开始。将需求与现有资料放在一起，更容易把产品介绍清楚。\n\n## 先看用途，再看条件\n\n客户资料描述了产品或服务的基本信息。这份示例用来演示原生写作状态、已成稿编辑和版本采用，不代表真实业务结论。\n\n## 把选型问题说明白\n\n- 明确当前的使用场景。\n- 阅读资料中的规格与适用条件。\n- 围绕读者关心的问题组织内容。\n\n选择时，可以先列出实际用途，再结合资料逐项比较。`;
    const chunks=body.match(/[\s\S]{1,90}/g);let n=0;
    const tick=()=>{
      if(job.status!=='running')return;
      if(failAt===index && n===2){state.articles=state.articles.filter(x=>x.id!==aid);endJob(job,'error','替身故障注入：响应在正文中途失败');return;}
      if(n<chunks.length){job.partial+=chunks[n];emit(job,{type:'chunk',text:chunks[n++],chars:job.partial.length});later(tick,segmentDelay);return;}
      job.phase='audit';job.message='正在完成原生核查（离线替身）';emit(job,{type:'status',message:job.message,phase:job.phase,done:job.done,planned:job.planned});
      later(()=>{
        const draft=addVersion(a,'zip_draft','原生初稿（离线示例）',body,a.title,null,null);
        const complete=addVersion(a,'zip','ZIP 成稿（离线示例）',body,a.title,{preview:true,assessment:'离线演示核查记录，不是真实模型核查。'},draft.id);adopt(a,complete);
        job.done++;job.items.push({article_id:a.id,title:a.title,platform:a.platform_name,account_type:a.account_type});job.message='本篇已保存';persist();
        if(job.cancel)endJob(job,'paused');else runJob(job,queue,index+1);
      },segmentDelay);
    };later(tick,segmentDelay);
  }
  function beginOperation(c,kind,body,a=null) {
    if(a)assertVersion(a,body);
    const persistedKind={chat:'interview','style-review':'style_review','style-rewrite':'style_rewrite',revise:'revision'}[kind];
    const op={id:'op_'+randomUUID(),kind:persistedKind,status:'running',conversation_id:c.id,article_id:a?.id||null,created_at:now(),result:null,error:null};state.operations.push(op);if(a)a.locked=true;
    channels.set(op.id,new EventEmitter());
    later(()=>{
      if(op.status!=='running')return;
      try {
        if(kind==='chat') {
          c.messages.push({role:'user',content:body.text,created_at:now()});
          const q=body.followup?{question:'这次主要写给谁看？',options:['初次了解产品的读者','已经在比较方案的人','现有客户']}:null;
          const understanding='已保留你的原文要求。离线预览可继续补充，也可直接开始写作。';
          c.messages.push({role:'assistant',content:q?q.question:understanding,created_at:now()});
          if(body.options)c.options={...c.options,...body.options};
          op.result={understanding,questions:q?[q]:[],ready:!q};
        } else if(kind==='style-review') {
          op.result={review_id:op.id,article_id:a.id,base_version:a.current_version,reviewer:'离线替身',assessment:'离线示例：建议把介绍写得更直接。',recommended:['opening','ending'],default_mode:'full',suggestions:[{id:'opening',tier:1,signal:'让开头更直接',quote:articleBody(a).split('\n')[2],problem:'开篇可以更直接。',proposal:'从读者要了解的用途进入。',scope:'段'},{id:'ending',tier:2,signal:'收紧结尾',problem:'结尾比较宽泛。',proposal:'将概括结论收束为可执行的选型步骤。',scope:'句'}],observations:[{id:'O1',signal:'结构参考',position:'全文',quote:'',reason:'平台结构和篇幅可作为参考。',proposal:'按需要判断。'}]};
        } else {
          if(kind==='style-rewrite') {
            const r=state.operations.find(x=>x.id===body.review_id&&x.kind==='style_review');
            if(!r||r.result.base_version!==a.current_version)throw new HttpError('审阅对应的原稿版本已变化',409);
          }
          const next=articleBody(a).replace('了解 ','选择之前，先了解 ').replace('选择时，可以先列出实际用途，再结合资料逐项比较。','先列出用途，再对照适用条件，逐项比较。');
          const fact={preview:true,status:'pass',attempts:1,readonly:true,independently_verified:false,findings:[],assessment:'离线示例：一次只读复核；未执行真实模型核查。'};
          const v=addVersion(a,kind==='revise'?'revision':'style',kind==='revise'?'当前稿修改候选':'去味候选',next,a.title,fact);
          op.result={article_id:a.id,candidate_version:v.id,base_version:a.current_version,changes:['示例修改：收紧开头和结尾。'],fact_check:fact};
        }
        op.status='done';
      } catch(error) {op.status='error';op.error=error.message;}
      if(a)a.locked=false;channels.get(op.id).emit('operation',op);persist();
    },operationDelay);
    return op;
  }
  function snapshot(c) {return {conversation:c,articles:state.articles.filter(a=>a.conversation_id===c.id),documents:state.documents.filter(d=>c.document_ids.includes(d.id)),job:state.jobs.find(j=>j.id===c.job_id)||null,operations:state.operations.filter(o=>o.conversation_id===c.id)};}
  async function readJSON(req) {let data='';for await(const chunk of req){data+=chunk;if(data.length>12*1024*1024)throw new HttpError('请求内容过大',413);}try{return JSON.parse(data||'{}');}catch{throw new HttpError('JSON 格式无效');}}
  const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({ok:status<400,...data}));};
  async function handle(req,res) {
    const url=new URL(req.url,'http://localhost'),p=decodeURIComponent(url.pathname),method=req.method;
    if(p==='/__preview__/health')return json(res,{preview:true,model_calls:0});
    if(p==='/__preview__/audit')return json(res,{requests:state.requests,model_calls:0});
    if(p.startsWith('/api/'))state.requests.push({method,path:p,at:now()});
    if(method==='GET'&&p==='/api/workbench/bootstrap')return json(res,{preview:true,clients:state.clients,conversations:state.conversations,platforms:state.platforms,target_models:state.target_models,settings:state.settings,provider_models:[{id:'deepseek-v4.1-flash'}],capabilities:{video:false}});
    if(method==='GET'&&p==='/api/workbench/zip-config')return json(res,{platforms:state.platforms,target_models:state.target_models,prefs:state.prefs,risks:state.risks,settings:state.settings});
    if(method==='GET'&&p==='/api/workbench/clients')return json(res,{clients:state.clients});
    if(method==='GET'&&p==='/api/workbench/provider-models')return json(res,{models:[{id:'deepseek-v4.1-flash'}],preview:true});
    if(method==='POST'&&p==='/api/aliases') {
      const b=await readJSON(req);
      if(!Array.isArray(b.keywords))throw new HttpError('keywords 须为数组');
      return json(res,await python('import json,sys\nfrom app.grouping import find_aliases\nb=json.load(sys.stdin)\njson.dump({"aliases":find_aliases(b["keywords"])},sys.stdout,ensure_ascii=False)',b));
    }
    if(method==='GET'&&p==='/api/workbench/video-context') {
      const c=state.clients.find(c=>c.id===url.searchParams.get('client_id'));if(!url.searchParams.has('client_id'))return json(res,{clients:state.clients});if(!c)throw new HttpError('客户不存在',404);
      const aid=Number(url.searchParams.get('article_id')),vid=Number(url.searchParams.get('version_id'));const a=state.articles.find(a=>a.id===aid),v=state.versions.find(v=>v.id===vid&&v.article_id===aid);
      if(aid&&(!a||!v||findConversation(a.conversation_id).client_id!==c.id))throw new HttpError('指定文章版本不属于这个客户',404);
      return json(res,{client:c,documents:state.documents.filter(d=>d.client_id===c.id),...(a?{article:{article_id:aid,version_id:vid,title:v.article.title,body_md:v.article.body_md,platform_name:a.platform_name,account_type:a.account_type}}:{})});
    }
    let m;
    if((m=/^\/api\/jobs\/([^/]+)\/stream$/.exec(p))&&method==='GET') {
      const job=state.jobs.find(j=>j.id===m[1]);if(!job)throw new HttpError('任务不存在',404);
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive'});
      const send=event=>{res.write('data: '+JSON.stringify(event)+'\n\n');if(event.type==='end')res.end();};
      if(job.status==='running') {
        send({type:'next',seg:job.seg,platform:job.platform,account_type:job.account_type,words:job.words,index:job.index,done:job.done,planned:job.planned,prev:job.items.at(-1)||null});
        if(job.partial)send({type:'chunk',text:job.partial,chars:job.partial.length});send({type:'status',message:job.message,done:job.done,planned:job.planned});
        const events=channels.get(job.id);events.on('data',send);req.on('close',()=>events.off('data',send));
      }else send({type:'end',status:job.status,error:job.error,message:job.message,items:job.items,done:job.done,planned:job.planned});return;
    }
    if(method==='GET'&&(m=/^\/api\/workbench\/operations\/([^/]+)\/stream$/.exec(p))){
      const op=state.operations.find(o=>o.id===m[1]);if(!op)throw new HttpError('操作不存在',404);
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache'});
      const send=value=>{res.write('data: '+JSON.stringify({operation:value})+'\n\n');if(value.status!=='running')res.end();};
      send(op);if(op.status==='running'){const events=channels.get(op.id);events.on('operation',send);req.on('close',()=>events.off('operation',send));}return;
    }
    if(method==='GET'&&(m=/^\/api\/workbench\/operations\/([^/]+)$/.exec(p))){const op=state.operations.find(o=>o.id===m[1]);if(!op)throw new HttpError('操作不存在',404);return json(res,{operation:op});}
    if(method==='GET'&&(m=/^\/api\/workbench\/clients\/([^/]+)\/documents$/.exec(p)))return json(res,{documents:state.documents.filter(d=>d.client_id===m[1])});
    if((m=/^\/api\/workbench\/conversations\/([^/]+)(.*)$/.exec(p))) {
      const c=findConversation(m[1]),tail=m[2];
      if(method==='GET'&&!tail)return json(res,snapshot(c));
      if(method==='PUT'&&tail==='/draft'){const b=await readJSON(req);c.options=normalizeOptions({...c.brief,...b.options},state.target_models);if(b.document_ids)c.document_ids=cp(b.document_ids);if(b.mode)c.mode=b.mode;if(typeof b.followup==='boolean')c.followup=b.followup;c.brief=cp(c.options);c.updated_at=now();await persist();return json(res,{conversation:c});}
      if(method==='PUT'&&tail==='/profile'){const b=await readJSON(req),keys=PROFILE_FIELDS.filter(([key])=>key!=='name').map(([key])=>key);if(!b.name?.trim()||!b.profile||keys.some(key=>typeof b.profile[key]!=='string')||Object.keys(b.profile).length!==keys.length)throw new HttpError('需填写名称并提供完整七项档案字段');const record=state.clients.find(row=>row.id===c.client_id);Object.assign(record,{name:b.name.trim(),profile:cp(b.profile)});c.brief={...c.brief,client:record.name,...cp(b.profile)};c.options=cp(c.brief);await persist();return json(res,{client:record,conversation:c});}
      if(method==='POST'&&tail==='/chat'){const b=await readJSON(req);if(!b.text?.trim())throw new HttpError('需求不能为空');const op=beginOperation(c,'chat',b);await persist();return json(res,{operation_id:op.id});}
      if(method==='POST'&&tail==='/start') {
        if(state.jobs.some(j=>j.conversation_id===c.id&&j.status==='running'))throw new HttpError('任务正在写作',409);
        const b=await readJSON(req);const options={...c.options,...b.options};const errors=validateStart(options,state.platforms,state.target_models);if(errors.length)throw new HttpError(errors.join('；'));
        const already=state.articles.filter(a=>a.conversation_id===c.id&&a.current_version);
        const queue=options.selections.flatMap(s=>Array.from({length:s.count},(_,index)=>({...s,index}))).filter((s,index)=>index>=already.length);
        if(!queue.length)throw new HttpError('当前安排已全部完成，请调整篇数后再开始');
        const job={id:'job_'+randomUUID(),conversation_id:c.id,status:'running',options:cp(options),partial:'',seg:0,total:options.selections.reduce((n,s)=>n+s.count,0),planned:queue.length,done:0,message:'离线示例准备中',cancel:false,items:[],error:''};state.jobs.push(job);channels.set(job.id,new EventEmitter());c.job_id=job.id;c.status='running';c.title=options.keywords[0]+' · 内容创作';await persist();later(()=>runJob(job,queue),segmentDelay);return json(res,{job_id:job.id,operation_id:'generation_'+job.id,planned:queue.length,total:job.total});
      }
      if(method==='POST'&&tail==='/stop'){const job=state.jobs.find(j=>j.id===c.job_id);if(job&&job.status==='running')job.cancel=true;await persist();return json(res,{message:'已请求暂停，当前篇按原生流程收尾'});}
      if(method==='GET'&&tail==='/export') {
        const fmt=url.searchParams.get('fmt'),ids=(url.searchParams.get('ids')||'').split(',').map(Number),articles=state.articles.filter(a=>a.conversation_id===c.id&&ids.includes(a.id));
        if(!articles.length||articles.some(a=>a.locked))throw new HttpError('请选择已完成的稿件');
        if(!['md','txt','json','docx'].includes(fmt))throw new HttpError('不支持的导出格式');
        const plan={...c,title:c.title,keyword:c.options.keywords[0],brief:c.options,articles,materials:state.documents.filter(d=>c.document_ids.includes(d.id))};
        const data=await python("import sys,json,base64\nfrom app import render\nb=json.load(sys.stdin)\nplan=b['plan']\nplan=render.ensure_plan_prefix(plan) if b['prefix'] else render.strip_plan_prefix(plan)\nresult=getattr(render,'export_plan_'+b['fmt'])(plan,b['ids'])\nraw=result if isinstance(result,bytes) else result.encode('utf-8')\nprint(json.dumps({'content':base64.b64encode(raw).decode('ascii')}))",{plan,fmt,ids,prefix:state.settings.title_prefix});
        res.writeHead(200,{'Content-Type':fmt==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':fmt==='json'?'application/json; charset=utf-8':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="fangli.${fmt}"`});res.end(Buffer.from(data.content,'base64'));return;
      }
      let art;
      if((art=/^\/articles\/(\d+)(.*)$/.exec(tail))) {
        const a=findArticle(c,art[1]),at=art[2];
        if(method==='GET'&&at==='/versions')return json(res,{current_version:a.current_version,versions:state.versions.filter(v=>v.article_id===a.id),review_records:state.records.filter(r=>r.article_id===a.id)});
        if(method==='GET'&&at==='/compare') {
          const v=state.versions.find(v=>v.id===Number(url.searchParams.get('candidate_version'))&&v.article_id===a.id);if(!v)throw new HttpError('候选版本不存在',404);
          const base=state.versions.find(x=>x.id===v.parent_id)||state.versions.find(x=>x.id===a.current_version);return json(res,{base,candidate:v,diff:`--- 原稿\n+++ 候选\n${v.article.body_md===base.article.body_md?'正文相同':'示例调整了开头与结尾，请对照全文。'}`,review:{fact_check:v.review},review_records:state.records.filter(r=>r.article_id===a.id)});
        }
        const b=await readJSON(req);
        if(method==='PUT'&&!at){assertVersion(a,b);if(typeof b.body_md!=='string')throw new HttpError('正文无效');const v=addVersion(a,'manual','人工编辑',b.body_md,b.title??a.title);adopt(a,v);await persist();return json(res,{article:a});}
        if(method==='POST'&&at==='/select-version'){assertVersion(a,b);const v=state.versions.find(v=>v.id===b.version_id&&v.article_id===a.id);if(!v)throw new HttpError('版本归属不匹配',409);if(['style','revision'].includes(v.origin)&&v.parent_id!==a.current_version)throw new HttpError('候选已过期，原稿版本已变化',409);adopt(a,v);await persist();return json(res,{article:a});}
        if(method==='POST'&&['/style-review','/style-rewrite','/revise'].includes(at)){const op=beginOperation(c,at.slice(1),b,a);await persist();return json(res,{operation_id:op.id});}
        if(method==='PUT'&&at==='/review-record'){if(a.locked)throw new HttpError('稿件正在处理',409);const v=state.versions.find(v=>v.id===b.candidate_version&&v.article_id===a.id);if(!v)throw new HttpError('候选归属不匹配',409);const r={...b,article_id:a.id,created_at:now()};state.records=state.records.filter(x=>!(x.article_id===a.id&&x.candidate_version===b.candidate_version));state.records.push(r);await persist();return json(res,{review_record:r});}
      }
    }
    if(method==='POST') {
      const b=await readJSON(req);
      if(p==='/api/workbench/clients') {if(!b.name?.trim())throw new HttpError('客户名称不能为空');if(b.id)throw new HttpError('已有客户请使用任务档案接口');const c={id:'client_'+randomUUID(),created_at:now(),name:b.name,profile:Object.fromEntries(PROFILE_FIELDS.filter(([key])=>key!=='name').map(([key])=>[key,b.profile?.[key]??'']))};state.clients.push(c);await persist();return json(res,{client:c});}
      if(p==='/api/workbench/conversations') {const record=state.clients.find(c=>c.id===b.client_id);if(!record)throw new HttpError('客户不存在',404);const options=normalizeOptions({client:record.name,...cp(record.profile)},state.target_models);const c={id:'conversation_'+randomUUID(),client_id:b.client_id,title:'新建内容',plan_id:null,messages:[],brief:cp(options),document_ids:[],job_id:null,status:'draft',mode:'chat',followup:true,needs_confirmation:false,options,created_at:now()};state.conversations.push(c);await persist();return json(res,{conversation:c});}
      if((m=/^\/api\/workbench\/clients\/([^/]+)\/documents$/.exec(p))){if(!state.clients.some(c=>c.id===m[1]))throw new HttpError('客户不存在',404);if(!b.text?.trim())throw new HttpError('资料正文不能为空');const d={...b,id:'doc_'+randomUUID(),client_id:m[1],digest:createHash('sha256').update(b.text).digest('hex')};state.documents.push(d);await persist();return json(res,{document:d});}
      if((m=/^\/api\/workbench\/operations\/([^/]+)\/stop$/.exec(p))){const op=state.operations.find(o=>o.id===m[1]);if(!op)throw new HttpError('操作不存在',404);op.status='stopped';channels.get(op.id)?.emit('operation',op);const a=state.articles.find(a=>a.id===op.article_id);if(a)a.locked=false;await persist();return json(res,{operation:op,message:'仅停止本地离线替身'});}
      if(p==='/api/workbench/settings'){for(const key of ['model','temperature','max_tokens','title_prefix','brand','disable_thinking'])if(key in b)state.settings[key]=b[key];await persist();return json(res,{settings:state.settings});}
      if(p==='/api/parse') {const d=await python("import sys,json,base64\nfrom app.parsers import parse_file\nb=json.load(sys.stdin)\ntry: print(json.dumps(parse_file(b['filename'],base64.b64decode(b['content_b64'])),ensure_ascii=True))\nexcept Exception as e: print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=True))",b);return json(res,d,d.ok?200:400);}
      if(p==='/api/prefs'){let pref=state.prefs.find(x=>x.model_id===b.model_id&&x.platform_id===b.platform_id);if(pref)Object.assign(pref,b);else state.prefs.push(b);await persist();return json(res,{});}
      if(p==='/api/platforms'||p==='/api/models'||p==='/api/risks'){const key=p.endsWith('platforms')?'platforms':p.endsWith('models')?'target_models':'risks';state[key].push({...b,id:Math.max(0,...state[key].map(x=>x.id))+1,enabled:b.enabled??true});await persist();return json(res,{});}
    }
    if(['PUT','DELETE'].includes(method)&&(m=/^\/api\/(platforms|models|risks)\/(\d+)$/.exec(p))){const key=m[1]==='models'?'target_models':m[1],i=state[key].findIndex(x=>x.id===Number(m[2]));if(i<0)throw new HttpError('配置不存在',404);if(method==='DELETE')state[key].splice(i,1);else Object.assign(state[key][i],await readJSON(req));await persist();return json(res,{});}
    if(p.startsWith('/api/'))throw new HttpError('离线替身未实现此合同路径',404);
    if(p.startsWith('/video')) {res.writeHead(503,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>视频模块待接入</title><body style="font-family:system-ui;padding:8vw"><h1>视频模块待接入</h1><p>本阶段只验收文章前端，未执行视频生成。</p><a href="/workbench/index.html">返回工作台</a></body></html>');return;}
    const relative=p==='/'?'index.html':p.replace(/^\//,'');const file=path.resolve(root,'web',relative);const webRoot=path.resolve(root,'web');
    if(file!==webRoot&&!file.startsWith(webRoot+path.sep))throw new HttpError('无效路径',400);
    try{const bytes=await readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(bytes);}catch(error){if(error.code==='ENOENT')throw new HttpError('页面不存在',404);throw error;}
  }
  function python(code,body) {return new Promise((resolve,reject)=>{const proc=spawn('python',['-B','-c',code],{cwd:root,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'}});let output='',error='';proc.stdout.on('data',b=>output+=b);proc.stderr.on('data',b=>error+=b);proc.on('error',reject);proc.on('close',status=>{if(status)return reject(new Error(error||'本机解析器失败'));try{resolve(JSON.parse(output));}catch{reject(new Error('本机解析器响应无效'));}});proc.stdin.end(JSON.stringify(body));});}
  const server=http.createServer((req,res)=>handle(req,res).catch(error=>{if(!res.headersSent)json(res,{error:error.message},error.status||500);else res.end();}));
  server.on('close',()=>{timers.forEach(clearTimeout);});
  return {server,state,persist,close:async()=>{timers.forEach(clearTimeout);for(const channel of channels.values())channel.removeAllListeners();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await persistQueue;}};
}
function articleBody(a){return a.body_md||'';}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return [a.slice(2,i),a.slice(i+1)];}));
  const preview=await createPreview({persistPath:args.state||null,segmentDelay:Number(args.delay)||500});
  preview.server.listen(Number(args.port)||0,'127.0.0.1',()=>{const record={type:'ready',preview:true,pid:process.pid,url:`http://127.0.0.1:${preview.server.address().port}`,model_calls:0};console.log(JSON.stringify(record));});
  process.on('SIGINT',async()=>{await preview.close();process.exit(0);});
}
