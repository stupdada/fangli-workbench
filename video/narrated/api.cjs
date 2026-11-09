'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {POINT_MAX_CHARACTERS,DAILY,DAILY_SHOTS,TYPOGRAPHY,TEMPLATES,assetSelection,validateDailyPhotos,publishing,freezeContext,validateDraft,problem,hash}=require('./contract.cjs');
const {author,createLocalModel}=require('./author.cjs');
const {runEngine}=require('./engine.cjs');
const {sendFile}=require('../runtime/video-api.js');
const UUID='[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const ID=new RegExp(`^${UUID}$`);
const BASE='/api/video/narrated';
const VOICE='Microsoft Huihui Desktop';
const assets={
  'video.mp4':['video/mp4',true], 'captions.srt':['application/x-subrip; charset=utf-8'],
  'cover.png':['image/png'], 'script.json':['application/json; charset=utf-8'],
  'pages.json':['application/json; charset=utf-8'], 'narration.wav':['audio/wav',true],
};
const now=()=>new Date().toISOString();
async function atomic(file,value){
  const temp=`${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp,JSON.stringify(value,null,2),{encoding:'utf8',mode:0o600});
  try{await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}
}
async function read(file){
  try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')throw problem(404,'制作记录不存在');throw error;}
}
async function readOptional(file){
  try{return await read(file);}catch(error){if(error.status===404)return null;throw error;}
}
function requestBinding(route,input){
  const {request_key:key,...body}=input;
  if(key===undefined)return null;
  if(typeof key!=='string'||!key.trim()||key.length>256||/[\x00-\x1f\x7f]/u.test(key))throw problem(400,'请求标识需为1—256字的有效文本');
  const hex=hash(['fangli.narrated.request.v1',key]);
  const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
  const canonical=JSON.stringify([route,body],(_,value)=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return value;
    return Object.fromEntries(Object.keys(value).sort().map(name=>[name,value[name]]));
  });
  return {id,request_hash:hash(canonical)};
}
function operationView({request_hash,planned_result,...operation}){return operation;}
function sourceView(context){
  const a=context.source_article;
  return a?{article_id:a.article_id,version_id:a.version_id,title:a.title}:null;
}
function createNarrated({dataDir,workspace,workspaceBase,fetchImpl,callModel,engine=runEngine,resolveAsset}){
  callModel??=createLocalModel(workspaceBase,fetchImpl);
  const root=path.join(dataDir,'narrated'),productions=path.join(root,'productions'),operations=path.join(root,'operations');
  const ready=()=>Promise.all([fs.mkdir(productions,{recursive:true}),fs.mkdir(operations,{recursive:true})]);
  const productionDir=id=>path.join(productions,id);
  const productionFile=id=>path.join(productionDir(id),'production.json');
  const operationDir=id=>path.join(operations,id);
  const operationFile=id=>path.join(operationDir(id),'operation.json');
  const versionDir=(id,v)=>path.join(productionDir(id),'versions',String(v));
  const renderDir=(id,r)=>path.join(productionDir(id),'renders',r);
  const active=new Map();
  const assetPreviews=new Map();
  const controller=new AbortController();
  let saving=false,healthPromise,admission=Promise.resolve();
  const health=()=>healthPromise??=engine({operation:'health',output:path.join(root,'health')},{signal:controller.signal}).catch(error=>{
    healthPromise=undefined;throw error;
  });
  function idle(){if(controller.signal.aborted||saving||active.size)throw problem(409,'当前制作仍在处理，请稍候');}
  function admit(action){
    // Serialize only the journal check and first publication. Work runs outside admission.
    const result=admission.then(action);
    admission=result.catch(()=>{});
    return result;
  }
  async function currentOperation(op,wasActive){
    if(op.status!=='running'||wasActive)return operationView(op);
    const planned=op.planned_result;
    if(planned){
      const record=await readOptional(productionFile(planned.production_id));
      const committed=op.kind==='generate'?record?.generation_id===op.id:
        record?.renders.some(render=>render.id===planned.render_id&&render.version===op.version);
      if(committed)return {...operationView(op),...planned,status:'completed'};
    }
    return {...operationView(op),status:'interrupted',error:'上次制作已中断，请检查记录后重新操作'};
  }
  async function lookup(binding){
    if(!binding)return null;
    const wasActive=active.has(binding.id);
    const op=await readOptional(operationFile(binding.id));
    if(!op)return null;
    if(op.request_hash!==binding.request_hash)throw problem(409,'请求标识已用于不同的制作请求');
    return currentOperation(op,wasActive);
  }
  function preflight(binding){
    return admit(async()=>{
      const previous=await lookup(binding);
      if(!previous)idle();
      return previous;
    });
  }
  function start(kind,details,binding,plannedResult,action){
    return admit(async()=>{
      // The workspace lookup between preflight and admission may race a duplicate submission.
      const previous=await lookup(binding);
      if(previous)return previous;
      idle();
      const id=binding?.id||randomUUID();
      const op={id,kind,status:'running',started_at:now(),...details,planned_result:plannedResult};
      if(binding)op.request_hash=binding.request_hash;
      let resolveDone;
      const done=new Promise(resolve=>{resolveDone=resolve;});
      active.set(id,done);
      try{
        await fs.mkdir(operationDir(id),{recursive:true});
        await atomic(operationFile(id),op);
      }catch(error){active.delete(id);resolveDone();throw error;}
      void (async()=>{
        try{
          if(controller.signal.aborted)throw problem(503,'本地制作已中断');
          Object.assign(op,await action(id),{status:'completed'});
        }catch(error){
          if(controller.signal.aborted)Object.assign(op,{status:'interrupted',error:'本地制作已中断，请检查记录后重新操作'});
          else Object.assign(op,{status:'failed',error:error.status?error.message:'本地制作未完成，请查看制作记录'});
        }
        op.finished_at=now();
        try{await atomic(operationFile(id),op);}
        catch{
          // A committed production or render can still be recovered from the running journal.
          if(op.status!=='completed')Object.assign(op,{status:'interrupted',error:'无法保存处理状态，请检查本地数据目录'});
        }finally{active.delete(id);resolveDone(operationView(op));}
      })();
      return operationView(op);
    });
  }
  async function operation(id,wait){
    const done=active.get(id);
    if(wait&&done){
      let timer;try{const result=await Promise.race([done,new Promise(resolve=>{timer=setTimeout(resolve,25000);})]);if(result)return result;}
      finally{clearTimeout(timer);}
    }
    const wasActive=active.has(id);
    return currentOperation(await read(operationFile(id)),wasActive);
  }
  function publicView(record){
    const current=record.versions.at(-1);
    return {id:record.id,client:record.context.client,source:sourceView(record.context),
      documents:record.context.documents.map(({id,revision,digest,filename})=>({id,revision,digest,filename})),
      topic:record.context.request.topic,version:record.version,updated_at:record.updated_at,archived_at:record.archived_at||null,point_max_characters:POINT_MAX_CHARACTERS,
      current:{...current,publish:publishing(current)},versions:record.versions.map(({version,title,created_at})=>({version,title,created_at})),
      renders:record.renders.map(render=>({...render,publish:publishing(record.versions.find(version=>version.version===render.version))}))};
  }
  function revision(record,input){
    if(record.version!==input.expected_version)throw problem(409,'制作版本已更新，请重新打开后编辑');
  }
  function editable(record){
    if(record.archived_at)throw problem(409,'请先恢复作品，再编辑或制作成片');
  }
  async function mediaFor(clientId,ids,pinned=[]){
    const previous=new Map(pinned.map(asset=>[asset.id,asset.sha256]));
    const sources={},snapshots=[];
    for(const id of ids){
      const {file,sha256,name,type}=await resolveAsset(clientId,id,previous.get(id),controller.signal);
      sources[id]={file,type};snapshots.push({id,name,type,sha256});
    }
    return {sources,snapshots};
  }
  function pageAssetIds(pages){return [...new Set(pages.flatMap(page=>page.asset_id?[page.asset_id]:[]))];}
  async function preview(id,version,draft,client,media){
    return engine({operation:'preview',output:versionDir(id,version),draft,client,media},{signal:controller.signal});
  }
  async function assetPreview(clientId,id){
    if(!clientId)throw problem(400,'请选择客户');
    const {file,type,sha256}=await resolveAsset(clientId,id,undefined,controller.signal,true);
    const output=path.join(root,'asset-previews',id,sha256);
    let pending=assetPreviews.get(output);
    if(!pending){
      pending=fs.access(path.join(output,'asset.png')).catch(error=>{
        if(error.code!=='ENOENT')throw error;
        return engine({operation:'asset-preview',output,asset:{file,type}},{signal:controller.signal});
      }).finally(()=>assetPreviews.delete(output));
      assetPreviews.set(output,pending);
    }
    await pending;
    return output;
  }
  async function handle(req,res,url,{json,inputJson}){
    const p=url.pathname;
    if(!p.startsWith(`${BASE}/`))return false;
    const method=req.method;
    if(method==='GET'&&p===`${BASE}/health`){json(res,200,{...await health(),templates:Object.keys(TEMPLATES),template_labels:TEMPLATES});return true;}
    const assetMatch=new RegExp(`^${BASE}/asset-previews/(${UUID})$`).exec(p);
    if(['GET','HEAD'].includes(method)&&assetMatch){
      const dir=await assetPreview(url.searchParams.get('client_id'),assetMatch[1]);
      await sendFile(req,res,dir,path.join(dir,'asset.png'),{type:'image/png',name:'asset.png',inline:true});return true;
    }
    if(method==='GET'&&p===`${BASE}/productions`){
      const client=url.searchParams.get('clientId');if(!client)throw problem(400,'请选择客户');
      const items=[],archived=url.searchParams.get('archived')==='1';
      for(const id of await fs.readdir(productions))if(ID.test(id)){
        let record;try{record=await read(productionFile(id));}catch(error){if(error.status===404)continue;throw error;}
        if(record.context.client.id===client&&Boolean(record.archived_at)===archived)items.push({id,title:record.versions.at(-1).title,source:sourceView(record.context),version:record.version,updated_at:record.updated_at,archived_at:record.archived_at||null});
      }
      items.sort((a,b)=>b.updated_at.localeCompare(a.updated_at));json(res,200,{productions:items});return true;
    }
    if(method==='POST'&&p===`${BASE}/productions`){
      const input=await inputJson(req),source=input.source||null;
      const binding=requestBinding(p,input),previous=await preflight(binding);
      if(previous){json(res,202,previous);return true;}
      if(typeof input.clientId!=='string'||!input.clientId.trim())throw problem(400,'请选择客户');
      if(source&&(input.document_ids!==undefined||input.conversation_id!==undefined))throw problem(400,'文章版本使用自身的冻结资料');
      if(input.document_ids!==undefined&&(!Array.isArray(input.document_ids)||input.document_ids.some(i=>typeof i!=='string'||!i||i.length>100||i.includes(','))||new Set(input.document_ids).size!==input.document_ids.length))throw problem(400,'资料选择格式不正确');
      if(input.conversation_id!==undefined&&(typeof input.conversation_id!=='string'||input.conversation_id.length>100))throw problem(400,'任务ID格式不正确');
      const shared=await workspace.read(input.clientId,source,{document_ids:input.document_ids,conversation_id:input.conversation_id});
      if(input.document_ids) {
        const ids=new Set(input.document_ids);
        shared.documents=shared.documents.filter(d=>ids.has(String(d.id)));
        if(shared.documents.length!==ids.size)throw problem(404,'所选资料不属于当前客户或已不可用');
      }
      const selected=assetSelection(input.asset_ids);
      const context=freezeContext(shared,{source,topic:input.topic,note:input.note,platform:input.platform,template:input.template,shotNotes:input.shot_notes});
      const daily=context.request.template===DAILY;
      if(daily&&selected.length!==DAILY_SHOTS)throw problem(400,'门店日常需要 5 张不同的图片');
      if(context.request.template===TYPOGRAPHY&&selected.length)throw problem(400,'大字讲解只用文字，请取消素材勾选或换一个模板');
      const dailyMedia=daily?await mediaFor(context.client.id,selected):null;
      if(daily)validateDailyPhotos(dailyMedia.snapshots);
      const id=randomUUID();
      const op=await start('generate',{client_id:context.client.id},binding,{production_id:id},async operationId=>{
        const archive=path.join(operationDir(operationId),'generation.json');
        const media=dailyMedia??await mediaFor(context.client.id,selected);
        const generated=await author(context,{callModel,persist:value=>atomic(archive,value),signal:controller.signal});
        const created_at=now();
        const pages=selected.length?generated.pages.map((page,index)=>({...page,asset_id:selected[index%selected.length]})):generated.pages;
        const assigned=new Set(pageAssetIds(pages));
        const draft={...generated,pages,assets:media.snapshots.filter(asset=>assigned.has(asset.id)),version:1,created_at,script_digest:hash(generated.script.paragraphs)};
        await preview(id,1,draft,context.client,media.sources);
        await atomic(productionFile(id),{id,context,context_digest:hash(context),version:1,updated_at:created_at,versions:[draft],renders:[],generation_id:operationId});
        return {production_id:id};
      });
      json(res,202,op);return true;
    }
    let match=new RegExp(`^${BASE}/operations/(${UUID})$`).exec(p);
    if(method==='GET'&&match){json(res,200,await operation(match[1],url.searchParams.get('wait')==='1'));return true;}
    match=new RegExp(`^${BASE}/productions/(${UUID})(.*)$`).exec(p);
    if(!match)throw problem(404,'短视频入口不存在');
    const [,id,tail]=match;
    if(!tail&&method==='GET'){
      const record=await read(productionFile(id));
      if(url.searchParams.has('client_id')&&url.searchParams.get('client_id')!==record.context.client.id)throw problem(404,'制作记录不存在');
      json(res,200,publicView(record));return true;
    }
    if(tail==='/archive'&&method==='PUT'){
      const input=await inputJson(req);
      if(typeof input.archived!=='boolean'||!input.clientId)throw problem(400,'请选择客户和归档状态');
      idle();saving=true;
      try{
        const record=await read(productionFile(id));
        if(input.clientId!==record.context.client.id)throw problem(404,'制作记录不存在');
        if(input.archived!==Boolean(record.archived_at)){
          record.archived_at=input.archived?now():null;
          await atomic(productionFile(id),record);
        }
        json(res,200,publicView(record));return true;
      }finally{saving=false;}
    }
    if(!tail&&method==='PUT'){
      idle();saving=true;
      try{
        const input=await inputJson(req),record=await read(productionFile(id));editable(record);revision(record,input);
        const validated=validateDraft(input),created_at=now(),version=record.version+1;
        const previous=record.versions.at(-1);
        const daily=validated.template===DAILY;
        if(daily!==(previous.template===DAILY))throw problem(400,'请从新建短视频切换门店日常模板');
        if((validated.template===TYPOGRAPHY)!==(previous.template===TYPOGRAPHY))throw problem(400,'请从新建短视频切换大字讲解模板');
        const media=await mediaFor(record.context.client.id,pageAssetIds(validated.pages),previous.assets);
        if(daily)validateDailyPhotos(media.snapshots);
        const unchanged=hash(validated.script)===hash(previous.script)&&hash(validated.pages)===hash(previous.pages)&&
          hash(validated.publish)===hash(publishing(previous));
        const editorial=unchanged?previous.editorial:{claims:[],issues:['内容已编辑，请核对本版事实与资料。'],factual_entailment:'待人工阅读核对'};
        const draft={...validated,assets:media.snapshots,editorial,created_at,version,script_digest:hash(validated.script.paragraphs)};
        await preview(id,version,draft,record.context.client,media.sources);
        record.version=version;record.updated_at=created_at;record.versions.push(draft);
        await atomic(productionFile(id),record);json(res,200,publicView(record));return true;
      }finally{saving=false;}
    }
    if(tail==='/renders'&&method==='POST'){
      const input=await inputJson(req);
      const binding=requestBinding(p,input),previous=await preflight(binding);
      if(previous){json(res,202,previous);return true;}
      const record=await read(productionFile(id));editable(record);revision(record,input);
      if(input.narration!==undefined&&typeof input.narration!=='boolean')throw problem(400,'配音开关格式不正确');
      const renderId=randomUUID(),draft=record.versions.at(-1),output=renderDir(id,renderId);
      const narration=![DAILY,TYPOGRAPHY].includes(draft.template)&&input.narration!==false;
      const op=await start('render',{client_id:record.context.client.id,production_id:id,version:draft.version},binding,{production_id:id,render_id:renderId},async()=>{
        // A save may have happened while reading the incoming render request.
        const latest=await read(productionFile(id));editable(latest);revision(latest,input);
        if(narration&&!(await health()).narrationReady)throw problem(503,'本机未找到 Microsoft Huihui Desktop 普通话音色');
        const media=await mediaFor(latest.context.client.id,pageAssetIds(draft.pages),draft.assets);
        const result=await engine({operation:'render',output,draft,client:latest.context.client,media:media.sources,narration,voice:VOICE},{signal:controller.signal});
        if(!result||!Array.isArray(result.captions)||result.captions.length!==draft.pages.length||result.actualMp4Encodes!==1)throw problem(502,'本地制作未返回完整结果');
        const render={id:renderId,version:draft.version,script_digest:draft.script_digest,created_at:now(),...result};
        latest.renders.push(render);latest.updated_at=now();await atomic(productionFile(id),latest);
        return {render_id:renderId};
      });
      json(res,202,op);return true;
    }
    const versionAsset=/^\/versions\/(\d+)\/(page-[1-6](?:-(?:title|detail))?\.png|cover\.png)$/.exec(tail);
    const renderAsset=new RegExp(`^/renders/(${UUID})/([a-z0-9.]+)$`).exec(tail);
    if(['GET','HEAD'].includes(method)&&(versionAsset||renderAsset)){
      const record=await read(productionFile(id));
      if(versionAsset){
        const v=record.versions.find(v=>v.version===Number(versionAsset[1]));if(!v)throw problem(404,'制作版本不存在');
        const base=versionDir(id,v.version),name=versionAsset[2];
        await sendFile(req,res,base,path.join(base,name),{type:'image/png',name,inline:true});
      }else{
        const [,rid,name]=renderAsset,render=record.renders.find(r=>r.id===rid),spec=Object.hasOwn(assets,name)&&assets[name];
        if(render&&name==='publish.txt'){
          const release=publishing(record.versions.find(v=>v.version===render.version));
          const tags=release.tags?.length?`\n话题标签\n${release.tags.map(tag=>'#'+tag).join(' ')}\n`:'';
          const body=Buffer.from(`发布标题\n${release.title}\n\n发布简介\n${release.description}\n${tags}`,'utf8');
          res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Length':body.length,
            'Content-Disposition':'attachment; filename="publish.txt"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
          res.end(method==='HEAD'?undefined:body);return true;
        }
        if(!render||!spec||name==='narration.wav'&&(!render.audioStreams||render.audio?.kind==='music'))throw problem(404,'导出文件不存在');
        const base=renderDir(id,rid);
        await sendFile(req,res,base,path.join(base,name),{type:spec[0],name,inline:Boolean(spec[1])&&url.searchParams.get('download')!=='1',range:Boolean(spec[1])});
      }
      return true;
    }
    throw problem(404,'短视频入口不存在');
  }
  return {ready,handle,async close(){controller.abort();await admission;await Promise.allSettled([...active.values(),...assetPreviews.values()]);}};
}
module.exports={createNarrated};
