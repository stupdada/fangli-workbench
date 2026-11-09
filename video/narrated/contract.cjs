'use strict';
const {createHash}=require('node:crypto');
const MODEL='deepseek-v4.1-flash';
const POINT_MAX_CHARACTERS=32;
const DAILY='daily';
const TYPOGRAPHY='typography';
const DAILY_CAPTION_MAX=24;
const DAILY_SHOTS=5;
const TYPOGRAPHY_SECONDS=22;
const TYPOGRAPHY_PAGES=5;
const TYPOGRAPHY_TITLE_MAX=16;
const TYPOGRAPHY_DETAIL_MAX=28;
const TEMPLATES=Object.freeze({[TYPOGRAPHY]:'大字讲解',process:'流程说明',intro:'图文介绍',qa:'问题解答',[DAILY]:'门店日常'});
const ASSET_ID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const count=text=>Array.from(text.replace(/\s/gu,'')).length;
const captionCount=text=>count(text)-((text.match(/[A-Za-z0-9]/g)?.length??0)/2);
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
  return draft.publish??{title:draft.title,description:draft.template===TYPOGRAPHY?draft.pages[0].points[0]:draft.script.paragraphs[0].text};
}
function validateDailyPhotos(photos){
  if(photos.length!==DAILY_SHOTS||photos.some(photo=>!photo.type.startsWith('image/')))
    throw problem(400,'门店日常需要 5 张不同的图片');
}
function freezeContext(value,{topic,source,note,platform,template='process',shotNotes}={}){
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
  template=templateId(template);
  const daily=template===DAILY, typography=template===TYPOGRAPHY;
  const targetSeconds=daily?[22,22]:typography?[TYPOGRAPHY_SECONDS,TYPOGRAPHY_SECONDS]:[30,45];
  const request={...clone(value.request||{}),topic:text(topic||value.request?.topic||source_article?.title,'视频主题',500),
    ...(note===undefined?{}:{note:text(note,'本次要求',4000,true)}),platform:platform===undefined?(daily?'抖音':'短视频'):text(platform,'发布平台',100),
    format:daily?'实拍图与字幕':typography?'大字讲解':'页面式口播',template,target_seconds:targetSeconds,
    target_characters:daily?[60,110]:typography?[60,160]:[100,160]};
  if(daily){
    if(!Array.isArray(shotNotes)||shotNotes.length!==DAILY_SHOTS)throw problem(400,'请按图片顺序填写 5 条镜头说明');
    request.shot_notes=shotNotes.map((note,i)=>line(note,`第${i+1}张图的镜头说明`,80));
  }
  return {client,documents,request,style:clone(value.style||{}),source_article,editorial:clone(value.editorial||{})};
}
function validateDraft(input){
  const title=line(input?.title,'视频标题',40);
  const template=templateId(input.template??'process'),daily=template===DAILY,typography=template===TYPOGRAPHY;
  if(!Array.isArray(input.pages)||input.pages.length<3||input.pages.length>6)throw problem(400,'短视频需要3—6个页面');
  if(daily&&input.pages.length!==DAILY_SHOTS)throw problem(400,'门店日常需要 5 屏字幕');
  if(typography&&input.pages.length!==TYPOGRAPHY_PAGES)throw problem(400,'大字讲解需要 5 幕');
  if(!typography&&(!Array.isArray(input.script?.paragraphs)||input.script.paragraphs.length!==input.pages.length))
    throw problem(400,daily?'每个镜头需要一条字幕':'每个页面需要一段连续口播');
  const pages=input.pages.map((p,i)=>{
    const id=`p${i+1}`;
    if(p?.id!==id)throw problem(400,'页面编号须按p1、p2顺序排列');
    if(daily)return {id,heading:line(p.heading,'镜头名称',16),points:[],...(p.asset_id==null?{}:{asset_id:assetId(p.asset_id)})};
    if(typography){
      if(p.asset_id!=null||p.layout!=null)throw problem(400,'大字讲解只使用统一文字排版');
      if(!Array.isArray(p.points)||p.points.length!==1)throw problem(400,`第 ${i+1} 幕需要一句小字说明`);
      const heading=line(p.heading,`第 ${i+1} 幕大字`,TYPOGRAPHY_TITLE_MAX);
      const detail=line(p.points[0],`第 ${i+1} 幕小字`,TYPOGRAPHY_DETAIL_MAX);
      if(heading===detail)throw problem(400,`第 ${i+1} 幕小字需要补充标题信息`);
      return {id,heading,points:[detail]};
    }
    if(!Array.isArray(p.points)||p.points.length<1||p.points.length>3)throw problem(400,'每页展示1—3个简短要点');
    if([DAILY,TYPOGRAPHY].includes(p.layout))throw problem(400,'请选择适用于单页的排版');
    return {id,heading:line(p.heading,'页面标题',16),points:p.points.map(s=>line(s,`画面要点（最多${POINT_MAX_CHARACTERS}字）`,POINT_MAX_CHARACTERS)),
      ...(p.layout==null?{}:{layout:templateId(p.layout)}),...(p.asset_id==null?{}:{asset_id:assetId(p.asset_id)})};
  });
  const paragraphs=typography?pages.map(p=>({page_id:p.id,text:`${p.heading}\n${p.points[0]}`})):input.script.paragraphs.map((p,i)=>{
    if(p?.page_id!==pages[i].id)throw problem(400,'字幕或口播与画面编号不一致');
    const label=daily?`第${i+1}屏字幕`:`第${i+1}页口播`,spoken=line(p.text,label,144);
    const maximum=daily?DAILY_CAPTION_MAX:36;
    if((daily?count(spoken):captionCount(spoken))>maximum)throw problem(400,`${label}最多${maximum}个有效字符`);
    return {page_id:p.page_id,text:spoken};
  });
  const full=paragraphs.map(p=>p.text).join(''),characters=count(full);
  if(!daily&&!typography&&(characters<100||characters>160))throw problem(400,`口播共${characters}字，请调整为100—160字`);
  const result={title,template,script:{text:full,paragraphs,characters},pages};
  if(daily||input.publish!==undefined){
    result.publish={title:line(input.publish?.title,'发布标题',80),description:text(input.publish?.description,'发布简介',300)};
    if(daily){
      const tags=input.publish.tags;
      if(!Array.isArray(tags)||tags.length<3||tags.length>6)throw problem(400,'请填写 3—6 个话题标签');
      result.publish.tags=tags.map(tag=>line(tag,'话题标签',24).replace(/^#/u,''));
      if(new Set(result.publish.tags).size!==tags.length||result.publish.tags.some(tag=>!/^[-_\p{L}\p{N}]{2,23}$/u.test(tag)))
        throw problem(400,'话题标签须互不相同，且仅包含文字、数字、短横线或下划线');
    }
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
    const publication=[DAILY,TYPOGRAPHY].includes(draft.template)&&c.page_id==='publish';
    if(!publication&&!draft.pages.some(p=>p.id===c.page_id))throw problem(400,'事实记录需对应画面或发布简介');
    const entry={text:statement,page_id:c.page_id,source_id};
    if(sources.get(source_id)?.includes(quote))claims.push({...entry,quote});
    else unresolved.push({...entry,reason:'来源引文需核对'});
  }
  return {claims,unresolved,issues:value.issues.map(issueText),factual_entailment:'待人工阅读核对'};
}
module.exports={MODEL,POINT_MAX_CHARACTERS,DAILY,DAILY_SHOTS,DAILY_CAPTION_MAX,TYPOGRAPHY,TYPOGRAPHY_SECONDS,TYPOGRAPHY_PAGES,TYPOGRAPHY_TITLE_MAX,TYPOGRAPHY_DETAIL_MAX,TEMPLATES,assetSelection,validateDailyPhotos,publishing,clone,hash,count,problem,freezeContext,validateDraft,validateEditorial};
