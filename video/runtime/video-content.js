'use strict';
// ZIP/manual text is supplied by the user. This module only lays out existing text.
const path=require('node:path');
const {spawn}=require('node:child_process');
const {fault,normalizeBatch}=require('./video-contract.js');
const content=require('../public/content.js');
function geometry(input){
  const job=normalizeBatch({clientId:input.clientId,mode:'silent',jobs:[{id:'layout',width:input.width,height:input.height,textStyle:input.textStyle,motion:input.motion,segments:[{id:'s1',text:'画面',media:'00000000-0000-4000-8000-000000000000',durationSeconds:5}]}]}).jobs[0];
  return {width:job.width,height:job.height,textStyle:job.textStyle,motion:job.motion};
}
function paginate(body,settings,env=process.env,protectedNames=[],minimumSeconds=3){
  if(typeof body!=='string'||!body.trim()||Array.from(body).length>60000)throw fault(400,'CONTENT_INVALID','完整展示正文须为1—60000字；实际制作还受100屏/600秒限制');
  if(!Number.isFinite(minimumSeconds)||minimumSeconds<1||minimumSeconds>60)throw fault(400,'INVALID_INPUT','每屏最短停留须为1—60秒；自动分屏仍保留每屏至少3秒阅读时间');
  return new Promise((resolve,reject)=>{
    const local={PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'};
    for(const key of ['PATH','Path','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(env[key])local[key]=env[key];
    const child=spawn(env.FANGLI_PYTHON||'python',['-B',path.join(__dirname,'layout.py')],{windowsHide:true,env:local,stdio:['pipe','pipe','pipe']});
    let raw='';child.stdout.setEncoding('utf8');child.stdout.on('data',s=>raw+=s);child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.once('error',()=>reject(fault(503,'ENGINE_START_FAILED')));
    child.once('close',()=>{try{const result=JSON.parse(raw);if(!result.ok)throw fault(422,result.errorCode==='FONT_MISSING'?'FONT_MISSING':'TEXT_TOO_LONG',result.error);if(content.canon(result.segments.map(s=>s.text).join(''))!==content.canon(body))throw fault(422,'CONTENT_INVALID');resolve(result);}catch(e){reject(e.status?e:fault(422,'CONTENT_INVALID'));}});
    child.stdin.end(JSON.stringify({body,...settings,protectedNames,minimumSeconds}));
  });
}
function createVideoContent({store,env=process.env}={}){
  return {async relayout(input){
    await store('client.check',{clientId:input.clientId});
    const settings=geometry(input),pages=await paginate(input.body,settings,env,input.protectedNames||[],input.minimumSeconds??3);
    return {clientId:input.clientId,body:input.body,characterCount:content.count(input.body),counting:'Unicode码点，去空白，含标点，不含标题',...settings,...pages,
      targetAssessment:content.assessment(input.body,pages.segments,content.targets(input.targetPreset))};
  }};
}
module.exports={createVideoContent,paginate,geometry};
