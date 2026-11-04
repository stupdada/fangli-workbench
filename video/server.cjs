'use strict';
const http=require('node:http');
const path=require('node:path');
const fs=require('node:fs/promises');
const {createHandler}=require('./runtime/video-api.js');
const {createWorkspaceContext,localBase}=require('./workspace-context.cjs');
const content=require('./public/content.js');
const {fault}=require('./runtime/video-contract.js');
function args(argv){
  const result={port:0};const allowed=new Set(['--port','--workspace-base','--data-dir']);
  for(let i=0;i<argv.length;i+=2){if(!allowed.has(argv[i])||argv[i+1]===undefined)throw new Error('参数仅支持 --port --workspace-base --data-dir');result[argv[i].slice(2)]=argv[i+1];}
  const port=Number(result.port);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('--port 需为0—65535');
  if(!result['data-dir']||!path.isAbsolute(result['data-dir']))throw new Error('--data-dir 需为绝对路径');
  const dataDir=path.resolve(result['data-dir']),relative=path.relative(__dirname,dataDir);
  if(relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))throw new Error('视频数据目录须位于模块目录外');
  return {port,dataDir,workspaceBase:localBase(result['workspace-base'])};
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
async function inputJson(req){
  if(String(req.headers['content-type']||'').split(';')[0]!=='application/json')throw fault(415,'INVALID_INPUT','需要application/json');
  const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>2*1024*1024)throw fault(413,'INVALID_INPUT','请求内容过长');chunks.push(part);}
  try{const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!v||Array.isArray(v)||typeof v!=='object')throw new Error();return v;}catch{throw fault(400,'INVALID_INPUT','JSON格式不正确');}
}
async function start(options){
  const workspace=createWorkspaceContext(options.workspaceBase,options.fetchImpl);
  const handle=createHandler({dataDir:options.dataDir,env:{...process.env,FANGLI_WORKSPACE_BASE:options.workspaceBase},
    resolveSource:workspace.source,...(options.renderBatch!==undefined?{renderBatch:options.renderBatch}:{})});
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost');
      const sameOrigin=`http://${req.headers.host}`;
      if(!['127.0.0.1','localhost'].includes((req.headers.host||'').split(':')[0])||req.headers.origin&&req.headers.origin!==sameOrigin||!['GET','HEAD'].includes(req.method)&&req.headers.origin!==sameOrigin||req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))return json(res,403,{errorCode:'INVALID_INPUT',error:'仅允许本机同源访问'});
      if(req.method==='GET'&&url.pathname==='/api/video/clients')return json(res,200,await workspace.read());
      if(req.method==='GET'&&['/','/workbench/index.html','/workbench/zip/index.html'].includes(url.pathname)){
        res.writeHead(302,{Location:new URL(url.pathname+url.search,options.workspaceBase).href,'Cache-Control':'no-store'});return res.end();
      }
      if(req.method==='GET'&&url.pathname==='/api/video/context'){
        const aid=url.searchParams.get('article_id'),vid=url.searchParams.get('version_id');
        if(Boolean(aid)!==Boolean(vid))return json(res,400,{errorCode:'INVALID_INPUT',error:'文章来源必须同时指定文章和版本'});
        return json(res,200,await workspace.read(url.searchParams.get('clientId')||undefined,aid?{article_id:Number(aid),version_id:Number(vid)}:undefined));
      }
      if(req.method==='POST'&&url.pathname==='/api/video/content-imports'){
        const input=await inputJson(req);if(typeof input.clientId!=='string'||!input.clientId.trim())throw fault(400,'CLIENT_INVALID');
        const context=await workspace.read(input.clientId,input.source),article=context.article;
        const markdown=input.source?article.body_md:input.body_md;
        if(typeof markdown!=='string'||!markdown.trim()||Array.from(markdown).length>60000)throw fault(400,'CONTENT_INVALID','请提供1—60000字原稿');
        const editorial=content.partition(markdown);
        if(!editorial.displayBody)throw fault(400,'CONTENT_INVALID','原稿没有可展示正文，请编辑正文后再导入');
        const source=input.source?await workspace.source(input.clientId,input.source):null;
        json(res,200,{clientId:input.clientId,title:article?.title||input.title||'独立视频',body:editorial.displayBody,source,editorial:{...editorial,origin:source?'zip-article':'manual',provenance:source?.provenance||null},notes:content.relations(editorial.displayBody,context),context});return;
      }
      if(await handle(req,res))return;
      const staticFiles={'/video/':['index.html','text/html; charset=utf-8'],'/video/index.html':['index.html','text/html; charset=utf-8'],'/video/video-ui.js':['video-ui.js','text/javascript; charset=utf-8'],'/video/content.js':['content.js','text/javascript; charset=utf-8'],'/video/authoring-view.js':['authoring-view.js','text/javascript; charset=utf-8'],'/video/video-ui.css':['video-ui.css','text/css; charset=utf-8']};
      if(['GET','HEAD'].includes(req.method)&&staticFiles[url.pathname]){
        const [file,type]=staticFiles[url.pathname],bytes=await fs.readFile(path.join(__dirname,'public',file));
        res.writeHead(200,{'Content-Type':type,'Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(req.method==='HEAD'?undefined:bytes);
      }
      if(['GET','HEAD'].includes(req.method)&&url.pathname==='/video/fangli-sans.woff2'){
        const bytes=await fs.readFile(path.join(__dirname,'public/fangli-sans.woff2'));res.writeHead(200,{'Content-Type':'font/woff2','Content-Length':bytes.length,'Cache-Control':'public, max-age=86400'});return res.end(req.method==='HEAD'?undefined:bytes);
      }
      json(res,404,{errorCode:'NOT_FOUND',error:'入口不存在'});
    }catch(e){if(!res.headersSent)json(res,e.status||503,{errorCode:e.code||'STORE_UNAVAILABLE',error:e.status?e.message:'视频服务暂不可用'});else res.end();}
  });
  try{await handle.ready();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.port,'127.0.0.1',resolve);});}
  catch(e){await handle.close();throw e;}
  const close=async()=>{const closing=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();await handle.close();await closing;};
  return {server,handle,close,port:server.address().port};
}
if(require.main===module){
  let service;start(args(process.argv.slice(2))).then(value=>{service=value;process.stdout.write(JSON.stringify({type:'ready',port:value.port,pid:process.pid})+'\n');
    let closing=false;const stop=()=>{if(closing)return;closing=true;service.close().catch(()=>{process.exitCode=1;});};process.once('SIGINT',stop);process.once('SIGTERM',stop);process.once('disconnect',stop);
  }).catch(()=>{process.stderr.write('视频服务启动失败：检查参数、数据目录锁与本地依赖。\n');process.exitCode=1;});
}
module.exports={start,args};
