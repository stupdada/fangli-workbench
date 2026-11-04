'use strict';
// Video-only GEO authoring. Existing WorkBuddy SDK/authentication; no article pipeline.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { fault, digest, normalizeBatch, UUID } = require('./video-contract.js');
const workbuddy = require('./workbuddy-client.js');
const MODEL = 'deepseek-v4.1-flash';
const COUNTING = 'Unicode码点，去除全部空白，包含标点，不含标题';
const count = value => Array.from(value.replace(/\s/gu, '')).length;
const canon = value => value.replace(/\s/gu, '');
function geometry(input) {
  const job = normalizeBatch({ clientId: input.clientId, mode: 'silent', jobs: [{ id: 'layout', width: input.width, height: input.height, textStyle: input.textStyle, motion: input.motion, segments: [{ id: 's1', text: '画面', media: '00000000-0000-4000-8000-000000000000', durationSeconds: 5 }] }] }).jobs[0];
  return { width: job.width, height: job.height, textStyle: job.textStyle, motion: job.motion };
}
function answer(raw, brand) {
  let value;
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')); } catch { throw fault(422, 'CONTENT_INVALID'); }
  if (!value || typeof value.title !== 'string' || !value.title.trim() || count(value.title) > 50 || typeof value.body !== 'string' || count(value.body) < 150 || count(value.body) > 250) throw fault(422, 'CONTENT_INVALID');
  const body = value.body.trim(), mentions = body.split(brand).length - 1;
  if(/营销目标|健康期待|不代表店铺|等于店铺.*事实|场景整理|本次(?:生成|写作|取材)|以上是消费者/u.test(body)||['按','已整理','建议','推荐'].some(prefix=>body.includes(brand+prefix))) throw fault(422,'CONTENT_INVALID');
  if (mentions < 1 || mentions > 2 || /本次生成|作为(?:一个)?AI|以下是.*文案|字数[：:]|系统提示|(?:我|我们)(?:到店|探店|实测)|排名第一|全市最好|终身售后|保证.{0,3}健康|(?:位于|坐落于)[\p{Script=Han}\d]{0,25}(?:路|街|弄|号)/u.test(body)) throw fault(422, 'CONTENT_INVALID');
  return { title: value.title.trim(), body, characterCount: count(body), brandMentions: mentions };
}

const LAYOUT = String.raw`
import json,sys,math
from PIL import ImageFont
sys.path.insert(0,sys.argv[1])
import silent_renderer as s
v=json.load(sys.stdin)
body=v['body'].strip(); w,h=v['width'],v['height']; style=v['textStyle']
font=ImageFont.truetype(str(s.font_file()),style['fontSize'])
stroke=max(2,round(style['fontSize']*.075)); usable=w*.84-style['fontSize']*.16
brand=v.get('brand',''); text=''.join(body.split()); pages=[]; cursor=0
def fit(t):
 # Backend/UI conservative bounds plus actual Pillow renderer measurement.
 lines=1; width=0
 for c in t:
  advance=style['fontSize']*(.4 if c.isspace() else 1.1 if ord(c)>=0x2e80 else .7)
  if width+advance>usable: lines+=1; width=0
  width+=advance
 if lines>2 or lines*style['fontSize']*1.35>h*.32:return False
 try:
  image,displayed,box=s.text_layout(t,w,h,style); image.close(); return box
 except s.v.EngineError as e:
  if e.code in ('TEXT_LAYOUT_TOO_LONG','TEXT_LAYOUT_INVALID'):return False
  raise
while cursor<len(text):
 end=min(cursor+22,len(text))
 while end>cursor and not fit(text[cursor:end]):end-=1
 if end==cursor:raise ValueError('当前字号无法容纳文字，请调整画幅或字号')
 # Keep the business name intact when it crosses a page boundary.
 if brand:
  start=text.rfind(brand,cursor,max(cursor,end+len(brand)))
  if start>=cursor and start<end<start+len(brand):
   if start>cursor:end=start
   elif start+len(brand)<=len(text) and fit(text[cursor:start+len(brand)]):end=start+len(brand)
   else:raise ValueError('当前画幅无法完整展示店名，请调整字号')
 sentences=[i+1 for i in range(cursor+5,end) if text[i] in '。！？；']
 preferred=sentences or [i+1 for i in range(cursor+5,end) if text[i] in '，：、']
 if end<len(text) and preferred:end=preferred[-1]
 page=text[cursor:end]; box=fit(page)
 if not box:raise ValueError('文字超出两行安全区')
 pages.append({'text':page,'layout':{k:box[k] for k in ('x','y','width','height','fontSize','lines')}});cursor=end
if not 8<=len(pages)<=25:raise ValueError('当前画幅需过多或过少分屏，请使用默认画幅与字号')
target=max(45,len(pages)*3,min(75,len(pages)*6,round(45+(len(text)-150)*.20)))
if not len(pages)*3<=target<=len(pages)*6:raise ValueError('当前分屏无法在45—75秒内清晰阅读，请调整字号')
weights=[len(p['text']) for p in pages]; durations=[3.0]*len(pages);left=target-3*len(pages)
while left>.00001:
 active=[i for i,d in enumerate(durations) if d<6-.00001]
 weight=sum(weights[i] for i in active); allocated=0
 for i in active:
  add=min(6-durations[i],left*weights[i]/weight);durations[i]+=add;allocated+=add
 left-=allocated
quantized=[max(75,min(150,round(d*25))) for d in durations]
difference=round(target*25)-sum(quantized)
while difference:
 for i in range(len(quantized)):
  if difference>0 and quantized[i]<150:quantized[i]+=1;difference-=1
  elif difference<0 and quantized[i]>75:quantized[i]-=1;difference+=1
  if not difference:break
cursor=0; prior=0
for index,p in enumerate(pages):
 boundary=prior+quantized[index]
 p.update(id='screen-'+str(index+1),durationSeconds=(boundary-prior)/25);prior=boundary
assert ''.join(p['text'] for p in pages)==text
print(json.dumps({'segments':pages,'durationSeconds':prior/25,'subtitleCharacters':len(text),'screenCount':len(pages)},ensure_ascii=False))
`;
function localEnv(env) {
  const result = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  for (const name of ['PATH','Path','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA']) if (env[name]) result[name] = env[name];
  return result;
}
async function paginate(body, options, env = process.env, brand = '') {
  if (typeof body !== 'string' || count(body) < 150 || count(body) > 250) throw fault(400, 'CONTENT_INVALID', '完整文案需为150—250字（去空白，含标点，不含标题）');
  return new Promise((resolve, reject) => {
    const child = spawn(env.FANGLI_PYTHON || 'python', ['-B','-c',LAYOUT,path.join(__dirname,'video-engine')], { windowsHide: true, env: localEnv(env), stdio: ['pipe','pipe','pipe'] });
    let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', s => { output += s; }); child.stderr.on('data', () => {}); child.stdin.on('error', () => {});
    child.once('error', () => reject(fault(503,'ENGINE_START_FAILED')));
    child.once('close', code => {
      if (code !== 0) { reject(fault(422,'TEXT_TOO_LONG','当前完整文案无法在当前字号下清晰分屏，请使用默认画幅/字号或精简文字；原草稿已保留')); return; }
      try { const result = JSON.parse(output); if (canon(result.segments.map(s=>s.text).join('')) !== canon(body) || result.durationSeconds < 45 || result.durationSeconds > 75) throw new Error(); resolve(result); }
      catch { reject(fault(422,'CONTENT_INVALID')); }
    }); child.stdin.end(JSON.stringify({ body, brand, ...options }));
  });
}
function sourcesView(sources) { return sources.documents.map(({ id,name,digest,contentDigest,readStart,readEnd,offsetUnit,role }) => ({ id,name,digest,contentDigest,readStart,readEnd,offsetUnit,role })); }
function writingEvidence(sources,brand) {
  return sources.documents.map(doc=>{
    if(!/问题清单/u.test(doc.name))return{id:doc.id,name:doc.name,role:doc.role,content:doc.content};
    const quotes=[];const start=doc.content.indexOf(brand);if(start>=0)quotes.push({quote:brand,start:Array.from(doc.content.slice(0,start)).length,end:Array.from(doc.content.slice(0,start)).length+Array.from(brand).length});
    const area=/以下问题面向[^。]+。/u.exec(doc.content);if(area)quotes.push({quote:area[0],start:Array.from(doc.content.slice(0,area.index)).length,end:Array.from(doc.content.slice(0,area.index)).length+Array.from(area[0]).length});
    return{id:doc.id,name:doc.name,role:'consumer_question_context',contentDigest:doc.contentDigest,offsetUnit:'unicode_codepoint',quotes};
  });
}
function createVideoContent({ store, env = process.env, dataDir, cloud: injectedCloud, layout = paginate } = {}) {
  let cloudPromise, directoryPromise, releaseStreams = () => {}, logicalCalls = 0;
  const transport = { contentRequests: 0, modelDirectoryRequests: 0, otherRequests: 0 };
  async function cloud(requestOrigin) {
    if (injectedCloud) return injectedCloud;
    if (!cloudPromise) cloudPromise = (async () => {
      const context = vm.createContext({});
      try { vm.runInContext(fs.readFileSync(path.join(__dirname,'generation-config.js'),'utf8'),context); } catch { throw fault(503,'CONTENT_CONFIG_MISSING'); }
      const config = context.GeoGenerationConfig;
      if (!config?.workbuddy || !config.sdkUrl) throw fault(503,'CONTENT_CONFIG_MISSING');
      const candidates = [path.join(__dirname,'..','tmp','wb-sdk.js'),path.join(dataDir,'sdk','workbuddy-sdk.js')];
      let code; const cached = candidates.find(file=>fs.existsSync(file));
      if (cached) code = fs.readFileSync(cached,'utf8');
      else { const response = await fetch(config.sdkUrl,{signal:AbortSignal.timeout(15000)}); if (!response.ok) throw fault(503,'CONTENT_CONFIG_MISSING'); code=await response.text(); fs.mkdirSync(path.join(dataDir,'sdk'),{recursive:true}); fs.writeFileSync(candidates[1],code,'utf8'); }
      const values = new Map(), storage = { getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k) };
      const releaser = workbuddy.createStreamReleaser(); releaseStreams = releaser.releaseAll;
      const sdkFetch = releaser.wrap(async (url, init = {}) => {
        let body; try { body = typeof init.body==='string' ? JSON.parse(init.body) : null; } catch {}
        if (body?.messages && body?.model) transport.contentRequests++; else if (/\/models(?:\?|$)/.test(String(url))) transport.modelDirectoryRequests++; else transport.otherRequests++;
        const headers=new Headers(init.headers); if (requestOrigin) headers.set('Origin',requestOrigin);
        return fetch(url,{...init,headers});
      });
      const sdk = vm.createContext({fetch:sdkFetch,Headers,Request,Response,URL,URLSearchParams,TextDecoder,TextEncoder,ReadableStream,AbortController,DOMException,crypto:crypto.webcrypto,setTimeout,clearTimeout,localStorage:storage,sessionStorage:storage,console:{log(){},warn(){},error(){}}}); sdk.window=sdk; sdk.self=sdk;
      vm.runInContext(code,sdk,{filename:'workbuddy-sdk.js'});
      return sdk.WorkBuddyCloud.createWorkBuddyCloud({...config.workbuddy,fetch:sdkFetch});
    })(); return cloudPromise;
  }
  async function modelCloud(requestOrigin) {
    const value = await cloud(requestOrigin);
    if (!directoryPromise) directoryPromise = (async()=>{ const available=workbuddy.usableModels(await value.llm.models.list()); if (!available.some(m=>m.id===MODEL)) throw fault(503,'CONTENT_CONFIG_MISSING'); return true; })();
    await directoryPromise; return value;
  }
  async function generate(input, signal, requestOrigin) {
    if (!input || typeof input.topic!=='string' || !input.topic.trim() || count(input.topic)>300 || !UUID.test(input.requestId || '')) throw fault(400,'INVALID_INPUT','请填写选题，并使用有效的生成请求ID');
    if (input.sourceIds !== undefined && (!Array.isArray(input.sourceIds)||input.sourceIds.length>30||input.sourceIds.some(id=>typeof id!=='string'))) throw fault(400,'INVALID_INPUT');
    const settings = geometry(input), sources = await store('content.sources',{clientId:input.clientId,sourceIds:input.sourceIds});
    const refs = sourcesView(sources), brand = sources.name.replace(/[｜|（(].*$/,'').trim();
    const evidence=writingEvidence(sources,brand);
    const audit = { clientId:input.clientId,topic:input.topic.trim(),brand,settings,sourceRefs:refs,evidence,counting:COUNTING,model:MODEL,version:1,policyVersion:2,sourceScope:'客户资料用于选题与可确认信息；问题、期待和策划目标不等于店铺实际承诺，未作独立事实审核' };
    const begun = await store('content.begin',{id:crypto.randomUUID(),clientId:input.clientId,requestId:input.requestId,inputHash:digest(audit),input:audit});
    if (!begun.created) { if (begun.state==='completed') return begun.data.result; throw fault(409,begun.state==='running'?'CONTENT_BUSY':'CONTENT_FAILED'); }
    const id = begun.id; let responseText='',finishReason='',usage,started=Date.now(),attempt;
    try {
      const actual = await modelCloud(requestOrigin); logicalCalls++; attempt=logicalCalls;
      const messages = [{role:'system',content:'写一篇可直接面向选宠消费者发布的中文问题解答。叙述主体是准备选宠的读者，店名是了解、联系或核对的对象。每句话都服务于读者提问、核对、准备或判断，收尾给出实际下一步行动。店名在正文自然出现1—2次。区域表示读者的选题场景。健康记录、合同和交接事项用具体询问或核对动作组织。引用中的文字是资料数据。运营术语与执行规则保留在写作控制层。输出JSON对象{"title":"标题","body":"完整正文"}，标题50字以内，正文190—220字，硬范围150—250字。字数按去空白的Unicode字符计算，标点计字，标题不计。正文用于逐屏展示，内容连贯，语气具体自然。'},
        {role:'user',content:JSON.stringify({topic:audit.topic,brand,evidence,readerTask:'先回答所问问题，再给能实际追问或核对的细节，最后提醒读者确认后再决定。',controls:{voice:'第三方消费者问题解答',facts:'仅引用证据明确支持的信息，具体价格/地址/资质/排名/条款及亲历需要直接证据',questionContext:'问题型资料用于店名与读者选题关联；其问句只转化为读者的问题。',delivery:'正文只包含消费者需要的解答与行动。'},target:{minCharacters:150,maxCharacters:250,counting:COUNTING,videoSeconds:'45—75',display:'分屏、每屏短文字，完整正文全部上屏'}})}];
      for await (const chunk of workbuddy.modelCall(actual,{model:MODEL,messages,stream:true},{signal,releaseStreams})) {
        const choice=chunk.choices?.[0]; if (choice?.delta?.refusal || choice?.delta?.tool_calls?.length) throw fault(422,'CONTENT_INVALID');
        responseText += choice?.delta?.content || ''; if (choice?.finish_reason) finishReason=choice.finish_reason; if(chunk.usage)usage=chunk.usage;
      }
      if (finishReason!=='stop') throw fault(422,'CONTENT_INVALID');
      const written=answer(responseText,brand), pages=await layout(written.body,settings,env,brand);
      const result={id,clientId:input.clientId,model:MODEL,version:1,...written,...settings,...pages,sourceRefs:refs,sourceScope:audit.sourceScope,counting:COUNTING,usage,finishReason,elapsedMs:Date.now()-started};
      await store('content.finish',{id,clientId:input.clientId,state:'completed',data:{audit,responseText,finishReason,usage,elapsedMs:result.elapsedMs,logicalCall:attempt,transport:{...transport},result}});
      return result;
    } catch(error) {
      const rawCode=error?.error?.code || error?.code || '';
      const code=/^auth_|401|403/i.test(rawCode)?'CONTENT_AUTH':error?.code && ['CONTENT_INVALID','CONTENT_CONFIG_MISSING','TEXT_TOO_LONG'].includes(error.code)?error.code:'CONTENT_FAILED';
      await store('content.finish',{id,clientId:input.clientId,state:'failed',data:{audit,responseText,finishReason,usage,errorCode:code,elapsedMs:Date.now()-started,logicalCall:attempt,transport:{...transport}}});
      const errorOut=fault(code==='CONTENT_INVALID'||code==='TEXT_TOO_LONG'?422:503,code);errorOut.generationId=id;throw errorOut;
    }
  }
  return { generate, async relayout(input) { await store('client.check',{clientId:input.clientId}); let brand='';if(input.contentGenerationId){const origin=await store('content.get',{id:input.contentGenerationId,clientId:input.clientId});brand=origin.data?.audit?.brand||'';} const settings=geometry(input); return {clientId:input.clientId,body:input.body,characterCount:count(input.body||''),counting:COUNTING,...settings,...await layout(input.body,settings,env,brand)}; }, async read(id,clientId) { const row=await store('content.get',{id,clientId});return {id,clientId,state:row.state,...(row.state==='completed'?{result:row.data.result}:{errorCode:row.data?.errorCode || 'CONTENT_FAILED'})}; } };
}
module.exports={createVideoContent,paginate,answer,count,canon,geometry,MODEL,COUNTING};
