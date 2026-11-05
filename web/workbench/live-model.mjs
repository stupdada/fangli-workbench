import { running } from './model.mjs';

// A prefix reader, not JSON repair: only consumed JSON tokens become preview data.
// Incomplete strings are decoded up to their last complete escape sequence.
export function partialObject(raw) {
  const text=String(raw||'').trim().replace(/^```(?:json)?\s*/i,'');let pos=0;
  const space=()=>{while(/\s/.test(text[pos]||'')&&pos<text.length)pos++;};
  function string() {
    const start=++pos;let end=start;
    while(pos<text.length){
      if(text[pos]==='"'){const value=JSON.parse('"'+text.slice(start,pos)+'"');pos++;return {value,complete:true};}
      if(text[pos]==='\\'){
        const escape=text[pos+1];if(!escape)break;
        if(escape==='u'){if(!/^[0-9a-f]{4}$/i.test(text.slice(pos+2,pos+6)))break;pos+=6;}
        else {if(!'"\\/bfnrt'.includes(escape))throw Error('escape');pos+=2;}
      }else{if(text.charCodeAt(pos)<32)throw Error('string');pos++;}
      end=pos;
    }
    return {value:JSON.parse('"'+text.slice(start,end)+'"'),complete:false};
  }
  function value(depth=0){
    if(depth>48)throw Error('depth');space();const c=text[pos];
    if(c==='"')return string();
    if(c==='{'||c==='['){
      const object=c==='{',result=object?{}:[],close=object?'}':']';pos++;space();
      while(pos<text.length&&text[pos]!==close){
        let key;if(object){if(text[pos]!=='"')break;const token=string();if(!token.complete)break;key=token.value;space();if(text[pos++]!==':')break;}
        space();if(pos>=text.length)break;const token=value(depth+1);
        if(token.value!==undefined){if(object)Object.defineProperty(result,key,{value:token.value,enumerable:true,configurable:true});else result.push(token.value);}
        if(!token.complete)return {value:result,complete:false};space();if(text[pos]!==',')break;pos++;space();
      }
      const complete=text[pos]===close;if(complete)pos++;return {value:result,complete};
    }
    const token=/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos));
    if(!token)return {complete:false};pos+=token[0].length;return {value:JSON.parse(token[0]),complete:true};
  }
  try{if(!text.startsWith('{'))return null;return value().value;}catch{return null;}
}
const strings=value=>Array.isArray(value)?value.filter(x=>typeof x==='string'):[];
export function streamDocument(raw) {
  const text=String(raw||'');
  if(!text.trim())return {title:'',body:''};
  if(!text.trim().replace(/^```(?:json)?\s*/i,'').startsWith('{'))return {title:'',body:/^\s*```(?:json)?\s*$/i.test(text)?'':text};
  const data=partialObject(text);if(!data)return {title:'',body:''};
  const title=typeof data.title==='string'?data.title:'';
  if(typeof data.body_md==='string')return {title,body:data.body_md};
  const blocks=[];if(typeof data.summary==='string')blocks.push(data.summary);
  for(const section of Array.isArray(data.sections)?data.sections:[]){
    if(!section||typeof section!=='object')continue;
    if(typeof section.heading==='string'&&section.heading)blocks.push('## '+section.heading);
    blocks.push(...strings(section.paragraphs));
  }
  if(strings(data.key_facts).length)blocks.push('## 关键信息',strings(data.key_facts).map(s=>'- '+s).join('\n'));
  const faq=(Array.isArray(data.faq)?data.faq:[]).filter(x=>x&&typeof x.q==='string');
  if(faq.length)blocks.push('## 常见问题',...faq.map(x=>'### '+x.q+'\n\n'+(typeof x.a==='string'?x.a:'')));
  return {title,body:blocks.join('\n\n')};
}

export function remainingCount(state,platforms=[]) {
  const articles=(state.articles||[]).filter(a=>a.current_version!=null);
  return (state.options?.selections||[]).reduce((sum,selection)=>{
    const written=articles.filter(a=>String(a.platform_id)===String(selection.platform_id)&&(a.account_type||'personal')===selection.account_type).length;
    return sum+Math.max(0,(Number(selection.count)||0)-written);
  },0);
}
const labels={interview:'正在整理本次要求',style_review:'正在通读稿件并审阅',style_rewrite:'正在生成候选并复核',revision:'正在修改当前稿',zip_regenerate:'正在重新生成并核查',zip_audit:'正在对照客户资料核查'};
export function activity(state) {
  const op=(state.operations||[]).find(o=>running(o)&&o.kind!=='writing');
  if(op)return {active:true,key:op.id+':'+op.kind,label:labels[op.kind]||'正在处理本次任务',since:op.created_at};
  const job=state.job||{},stream=state.stream||{};
  if(running(job)){
    const phase=stream.phase||job.phase||'',message=stream.message||job.message||'';
    const label=job.cancel?'正在收尾，之后暂停':phase==='audit'?'正在对照客户资料核查':message||'正在等待模型返回';
    return {active:true,key:job.id+':'+(stream.seg||0)+':'+phase,label,since:job.created_at};
  }
  return {active:false,key:job.id+':'+job.status,label:({done:'本次生成已完成',paused:'后续已暂停',stopped:'任务已停止',interrupted:'连接中断，等待确认',error:'本次生成未完成'})[job.status]||'准备开始创作'};
}
