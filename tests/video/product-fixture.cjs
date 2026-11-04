'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {once}=require('node:events');
const evidence=path.resolve(__dirname,'../../../output/geo-merge-20261104/video');
const inputs=JSON.parse(fs.readFileSync(path.join(evidence,'common-inputs.json'),'utf8'));
const fixtures=inputs.cases.map((c,index)=>{
  const directory=path.join(evidence,'comparison',c.id,'zip');
  const audited=JSON.parse(fs.readFileSync(path.join(directory,'audited-article.json'),'utf8'));
  return {client:{id:c.clientId,name:c.name,profile:{brand:c.name,company:c.company,products:c.products,industry:c.industry}},
    documents:c.documents.map(d=>({id:d.id,filename:d.name,kind:d.role,text:d.content,digest:d.contentDigest})),
    article:{article_id:17+index,version_id:7+index*2,title:audited.title,body_md:audited.body_md,platform_name:'抖音',account_type:'official',
      zip_data:audited.data,native_audit:audited.audit,body_original:audited.body_original||null,
      raw_generation:fs.readFileSync(path.join(directory,'raw-generation.txt'),'utf8'),raw_audit:fs.readFileSync(path.join(directory,'raw-audit.txt'),'utf8')}};
});
async function startFixture(){
  const requests=[];let currentVersion=7;
  const server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://localhost');requests.push({method:req.method,url:req.url,time:new Date().toISOString()});
    res.setHeader('Content-Type','application/json; charset=utf-8');
    if(req.method!=='GET'){res.writeHead(405);return res.end('{}');}
    if(u.pathname==='/workbench/zip/index.html'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><meta charset="utf-8"><title>ZIP入口合同替身</title><p>此页仅确认视频工作区正确指向主服务ZIP路径；未实现主工作台。</p>');}
    if(u.pathname!=='/api/workbench/video-context'){res.writeHead(404);return res.end('{}');}
    const id=u.searchParams.get('client_id');
    if(!id)return res.end(JSON.stringify({ok:true,clients:fixtures.map(c=>c.client)}));
    const match=fixtures.find(f=>f.client.id===id);
    if(!match){res.writeHead(404);return res.end('{}');}
    const value={ok:true,client:match.client,documents:match.documents};
    if(u.searchParams.has('article_id')){
      if(Number(u.searchParams.get('article_id'))!==match.article.article_id||Number(u.searchParams.get('version_id'))!==match.article.version_id){res.writeHead(404);return res.end('{}');}
      value.article=match.article;
    }
    value.currentVersion=currentVersion;res.end(JSON.stringify(value));
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  return {server,url:'http://127.0.0.1:'+server.address().port,requests,setCurrentVersion:v=>{currentVersion=v;},close:()=>new Promise(resolve=>server.close(resolve))};
}
module.exports={startFixture,fixtures,evidence};
