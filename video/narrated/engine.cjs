'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const {problem}=require('./contract.cjs');
async function runEngine(request,{signal}={}){
  await fs.mkdir(request.output,{recursive:true});
  const manifest=path.join(request.output,'engine-request.json');
  await fs.writeFile(manifest,JSON.stringify(request,null,2),'utf8');
  if(signal?.aborted)throw problem(409,'本地制作已停止');
  return new Promise((resolve,reject)=>{
    const child=spawn(process.env.FANGLI_PYTHON||'python',['-B',path.join(__dirname,'renderer.py'),'--request',manifest,'--watch-parent'],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',startError=false;
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',part=>stdout=(stdout+part).slice(-256000));
    child.stderr.on('data',part=>stderr=(stderr+part).slice(-32000));
    child.on('error',()=>{startError=true;});child.stdin.on('error',()=>{});
    const abort=()=>child.stdin.end();
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.once('close',async code=>{
      signal?.removeEventListener('abort',abort);
      if(stderr)await fs.writeFile(path.join(request.output,'engine-stderr.log'),stderr,'utf8').catch(()=>{});
      if(signal?.aborted)return reject(problem(409,'本地制作已停止'));
      if(startError)return reject(problem(503,'无法启动本地视频引擎'));
      let result;try{result=JSON.parse(stdout);}catch{}
      if(code===0&&result?.ok)return resolve(result.result);
      const detail=result?.error;
      return reject(problem(422,typeof detail==='string'&&/^[\u3000-\u9fffA-Za-z0-9，。、；：—－（） ]{2,110}$/u.test(detail)?detail:'本地制作未完成，请查看制作记录'));
    });
  });
}
module.exports={runEngine};
