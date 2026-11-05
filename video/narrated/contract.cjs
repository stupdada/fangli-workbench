'use strict';
const {createHash}=require('node:crypto');
const MODEL='deepseek-v4.1-flash';
const POINT_MAX_CHARACTERS=32;
const TEMPLATES=Object.freeze({process:'流程说明',intro:'图文介绍',qa:'问题解答'});
const ASSET_ID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const count=text=>Array.from(text.replace(/\s/gu,'')).length;
function problem(status,message){return Object.assign(new Error(message),{status,code:'NARRATED_INVALID'});}
function text(value,label,max,empty=false){if(typeof value!=='string'||!empty&&!value.trim()||Array.from(value).length>max||value.includes('\0'))throw problem(400,`${label}格式或长度不正确`);return value.trim();}
function line(value,label,max){const s=text(value,label,max);if(/[\r\n\t]/u.test(s))throw problem(400,`${label}请使用连续文本`);return s;}
function templateId(value){
  if(typeof value!=='string'||!Object.hasOwn(TEMPLATES,value))throw problem(400,'请选择有效的页面模板');
  return value;
}
function assetId(value){
  if(typeof value!=='string'||!ASSET_ID.test(value))throw problem(400,'画面素材标识不正确');
  return value;
}
function assetSelection(value=[]){
  if(!Array.isArray(value)||value.length>6||new Set(value).size!==value.length)throw problem(400,'每条视频最多选择6份不同素材');
  return value.map(assetId);
}
function publishing(draft){
  return draft.publish??{title:draft.title,description:draft.script.paragraphs[0].text};
}
function freezeContext(value,{topic,source,note,platform,template='process'}={}){
  if(!value?.client||!Array.isArray(value.documents))throw problem(400,'请先选择客户与资料');
  const client={id:text(value.client.id,'客户ID',100),name:text(value.client.name,'客户名称',200),profile:clone(value.client.profile||{})};
  let size=0;
  const documents=value.documents.map(d=>{text(d.text,'资料正文',80000,true);size+=d.text.length;return {id:d.id,revision:d.revision??d.revision_id??null,filename:text(d.filename,'资料名称',300),text:d.text,digest:d.digest||createHash('sha256').update(d.text).digest('hex')};});
  if(size>120000)throw problem(400,'本次资料超过12万字，请缩小资料范围');
  const article=source?(value.source_article||value.article):null;
  if(source&&(!article||article.article_id!==source.article_id||article.version_id!==source.version_id))throw problem(409,'指定文章版本与来源不一致');
  if(article)text(article.body_md,'文章正文',60000);
  const source_article=article?{article_id:article.article_id,version_id:article.version_id,title:text(article.title,'文章标题',500),body_md:article.body_md}:null;
  if(!documents.some(d=>d.text)&&!source_article)throw problem(400,'请为本次制作选择业务资料或采用的文章');
  const request={...clone(value.request||{}),topic:text(topic||value.request?.topic||source_article?.title,'视频主题',500),
    ...(note===undefined?{}:{note:text(note,'本次要求',4000,true)}),platform:platform===undefined?'短视频':text(platform,'发布平台',100),
    format:'页面式口播',template:templateId(template),target_seconds:[30,45],target_characters:[100,160]};
  return {client,documents,request,style:clone(value.style||{}),source_article,editorial:clone(value.editorial||{})};
}
function validateDraft(input){
  const title=line(input?.title,'视频标题',40);
  if(!Array.isArray(input.pages)||input.pages.length<3||input.pages.length>6)throw problem(400,'短视频需要3—6个页面');
  if(!Array.isArray(input.script?.paragraphs)||input.script.paragraphs.length!==input.pages.length)throw problem(400,'每个页面需要一段连续口播');
  const pages=input.pages.map((p,i)=>{
    const id=`p${i+1}`;
    if(p?.id!==id)throw problem(400,'页面编号须按p1、p2顺序排列');
    if(!Array.isArray(p.points)||p.points.length<1||p.points.length>3)throw problem(400,'每页展示1—3个简短要点');
    return {id,heading:line(p.heading,'页面标题',16),points:p.points.map(s=>line(s,`画面要点（最多${POINT_MAX_CHARACTERS}字）`,POINT_MAX_CHARACTERS)),
      ...(p.layout==null?{}:{layout:templateId(p.layout)}),...(p.asset_id==null?{}:{asset_id:assetId(p.asset_id)})};
  });
  const paragraphs=input.script.paragraphs.map((p,i)=>{
    if(p?.page_id!==pages[i].id)throw problem(400,'口播与页面编号不一致');
    const label=`第${i+1}页口播`,spoken=line(p.text,label,144);
    if(count(spoken)>36)throw problem(400,`${label}最多36个有效字符`);
    return {page_id:p.page_id,text:spoken};
  });
  const full=paragraphs.map(p=>p.text).join(''),characters=count(full);
  if(characters<100||characters>160)throw problem(400,`口播共${characters}字，请调整为100—160字`);
  const template=templateId(input.template??'process');
  const result={title,template,script:{text:full,paragraphs,characters},pages};
  if(input.publish!==undefined){
    result.publish={title:line(input.publish?.title,'发布标题',80),description:text(input.publish?.description,'发布简介',300)};
  }else result.publish=publishing(result);
  return result;
}
function issueText(issue){
  if(typeof issue==='string')return text(issue,'编辑事项',1000);
  if(!issue||Array.isArray(issue)||typeof issue!=='object'||Object.keys(issue).length!==2||
      !Object.hasOwn(issue,'text')||!Object.hasOwn(issue,'reason'))throw problem(400,'编辑事项格式不正确');
  const statement=text(issue.text,'编辑事项',1000),reason=text(issue.reason,'编辑事项原因',1000);
  return text(`${statement} 原因：${reason}`,'编辑事项',1000);
}
function validateEditorial(value,context,draft){
  if(!value||!Array.isArray(value.claims)||value.claims.length>40||!Array.isArray(value.issues)||value.issues.length>20)throw problem(400,'脚本缺少编辑侧来源记录或超出数量限制');
  const sources=new Map(context.documents.map(d=>[String(d.id),d.text]));
  if(context.source_article)sources.set('article',context.source_article.body_md);
  const claims=[],unresolved=[];
  for(const c of value.claims){
    const quote=text(c?.quote,'来源引文',1000),statement=text(c.text,'采用事实',500),source_id=String(c.source_id);
    if(!draft.pages.some(p=>p.id===c.page_id))throw problem(400,'事实记录需对应一个页面');
    const entry={text:statement,page_id:c.page_id,source_id};
    if(sources.get(source_id)?.includes(quote))claims.push({...entry,quote});
    else unresolved.push({...entry,reason:'来源引文需核对'});
  }
  return {claims,unresolved,issues:value.issues.map(issueText),factual_entailment:'待人工阅读核对'};
}
module.exports={MODEL,POINT_MAX_CHARACTERS,TEMPLATES,assetSelection,publishing,clone,hash,count,problem,freezeContext,validateDraft,validateEditorial};
