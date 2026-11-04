'use strict';
const {createHash} = require('node:crypto');
const {fault} = require('./runtime/video-contract.js');
function localBase(value) {
  let url;try{url=new URL(value);}catch{throw new Error('需要有效的 --workspace-base 本机HTTP地址');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
    throw new Error('--workspace-base 仅允许本机HTTP服务根地址');
  return url.origin;
}
function contextFailure(status,value){
  const business={400:['INVALID_INPUT','文章来源参数不完整或无效，请检查客户、文章ID和版本ID'],404:['NOT_FOUND','指定稿件版本不存在或不属于当前客户'],409:['CONTENT_VERSION_CONFLICT','该稿件版本尚未采用或状态已变化，请先在文案工作台确认采用版本']};
  if(!business[status])return fault(503,'STORE_UNAVAILABLE','主工作台暂不可用');
  const [code,fallback]=business[status],reason=value?.ok===false&&typeof value.error==='string'?value.error.trim():'';
  // Only the workbench's bounded public JSON error may cross this boundary.
  // Tracebacks, local paths, credentials and unstructured responses stay private.
  const privateDetail=/[\x00-\x1f\x7f]|[a-z]:[\\/]|\\\\|file:\/\/|traceback|\b(?:authorization|bearer\s+|wbpk_|sk-[a-z0-9]|api[_ -]?key|secret|token\s*[:=])|(?:Error|Exception):/i;
  const readable=reason&&Array.from(reason).length<=240&&!privateDetail.test(reason)?reason:fallback;
  return fault(status,code,readable);
}
function createWorkspaceContext(base, fetchImpl=fetch) {
  const origin=localBase(base);
  async function read(clientId, source) {
    const url=new URL('/api/workbench/video-context',origin);
    if(clientId!==undefined){if(typeof clientId!=='string'||!clientId.trim()||clientId.length>100)throw fault(400,'CLIENT_INVALID');url.searchParams.set('client_id',clientId);}
    if(source){
      if(clientId===undefined)throw fault(400,'INVALID_INPUT','文章来源必须指定客户');
      if(!Number.isSafeInteger(source.article_id)||source.article_id<1||!Number.isSafeInteger(source.version_id)||source.version_id<1)throw fault(400,'INVALID_INPUT','文章来源必须指定article_id和version_id');
      url.searchParams.set('article_id',source.article_id);url.searchParams.set('version_id',source.version_id);
    }
    let response;
    try{response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(5000)});}catch{throw fault(503,'STORE_UNAVAILABLE','主工作台暂不可用');}
    let text;try{text=await response.text();}catch{throw fault(503,'STORE_UNAVAILABLE','主工作台暂不可用');}
    if(Buffer.byteLength(text)>2*1024*1024)throw fault(503,'STORE_UNAVAILABLE');
    let value;try{value=JSON.parse(text);}catch{}
    if(!response.ok)throw contextFailure(response.status,value);
    if(!value||value.ok===false)throw fault(503,'STORE_UNAVAILABLE');
    if(clientId===undefined){if(!Array.isArray(value.clients))throw fault(503,'STORE_UNAVAILABLE');return {clients:value.clients};}
    if(!value.client||value.client.id!==clientId||!Array.isArray(value.documents))throw fault(404,'NOT_FOUND');
    if(source&&(!value.article||value.article.article_id!==source.article_id||value.article.version_id!==source.version_id||typeof value.article.body_md!=='string'||typeof value.article.title!=='string'))throw fault(409,'CONTENT_VERSION_CONFLICT');
    return value;
  }
  return {read,async source(clientId,source){
    const {article}=await read(clientId,source);
    const value=snapshot(article);
    const identity={article_id:value.article_id,version_id:value.version_id,title:value.title,body_md:value.body_md};
    return {...value,digest:createHash('sha256').update(JSON.stringify(identity)).digest('hex')};
  }};
}
function snapshot(article){
  return {article_id:article.article_id,version_id:article.version_id,title:article.title,body_md:article.body_md,
    provenance:{structured:article.zip_data??article.structured??article.data??null,nativeAudit:article.native_audit??article.audit??null,
      bodyOriginal:article.body_original??null,rawGeneration:article.raw_generation??null,rawAudit:article.raw_audit??null}};
}
module.exports={createWorkspaceContext,localBase,snapshot,contextFailure};
