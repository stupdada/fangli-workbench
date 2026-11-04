'use strict';
// Explicit local acceptance host. Read-only fixture + production CLI; no model libraries.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {startFixture,fixtures,evidence}=require('./product-fixture.cjs');
const out=path.join(evidence,'productization'),dataDir=path.join(out,'real-data');
fs.mkdirSync(out,{recursive:true});
const save=(file,value)=>fs.writeFileSync(path.join(out,file),JSON.stringify(value,null,2)+'\n','utf8');
let timer,child,fixture,closing=false,buffer='',ready;
const stdout=fs.createWriteStream(path.join(out,'server.stdout.log'),{flags:'a'}),stderr=fs.createWriteStream(path.join(out,'server.stderr.log'),{flags:'a'});
async function resource(){
  const local={};for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP'])if(process.env[key])local[key]=process.env[key];
  const script="[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $os=Get-CimInstance Win32_OperatingSystem; $p=Get-Process -Id "+process.pid+","+child.pid+" -ErrorAction SilentlyContinue; [pscustomobject]@{time=(Get-Date).ToUniversalTime().ToString('o');freePhysicalBytes=([double]$os.FreePhysicalMemory*1024);freeVirtualBytes=([double]$os.FreeVirtualMemory*1024);processes=@($p | Select-Object Id,WorkingSet64,PrivateMemorySize64)} | ConvertTo-Json -Compress -Depth 4";
  const proc=spawn('pwsh',['-NoProfile','-Command',script],{windowsHide:true,env:local,stdio:['ignore','pipe','ignore']});let raw='';proc.stdout.on('data',s=>raw+=s);proc.once('close',()=>{try{const value=JSON.parse(raw);fs.appendFileSync(path.join(out,'resources.jsonl'),JSON.stringify(value)+'\n','utf8');}catch{}});
}
async function close(){
  if(closing)return;closing=true;clearInterval(timer);
  if(child?.connected)child.disconnect();
  if(child&&child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));
  if(fixture)await fixture.close();
  save('host-closed.json',{time:new Date().toISOString(),helperPid:process.pid,videoPid:child?.pid,exitCode:child?.exitCode});stdout.end();stderr.end();
}
async function main(){
  if(fs.existsSync(path.join(out,'service.json')))throw new Error('Acceptance service record exists; do not create a duplicate host.');
  fixture=await startFixture();
  const command=[path.resolve(__dirname,'../../video/server.cjs'),'--port','0','--workspace-base',fixture.url,'--data-dir',dataDir];
  const env={};for(const key of ['PATH','Path','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH'])if(process.env[key])env[key]=process.env[key];
  child=spawn(process.execPath,command,{windowsHide:true,env,stdio:['ignore','pipe','pipe','ipc']});
  child.stderr.pipe(stderr);child.stdout.on('data',s=>{stdout.write(s);buffer+=s;});
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('CLI not ready')),10000);child.stdout.on('data',()=>{if(buffer.includes('\n')){clearTimeout(timeout);try{ready=JSON.parse(buffer.split('\n')[0]);resolve();}catch(e){reject(e);}}});child.once('error',reject);});
  const url='http://127.0.0.1:'+ready.port+'/video/?client_id='+fixtures[0].client.id+'&article_id=17&version_id=7';
  save('service.json',{startedAt:new Date().toISOString(),helperPid:process.pid,helperCommand:[process.execPath,__filename],videoPid:child.pid,command:[process.execPath,...command],fixtureUrl:fixture.url,dataDir,url,stdout:path.join(out,'server.stdout.log'),stderr:path.join(out,'server.stderr.log'),environmentNames:Object.keys(env),scope:'video productization boundary against strict read-only fixture; not full-site integration'});
  timer=setInterval(resource,30000);await resource();
  process.stdout.write(JSON.stringify({type:'ready',helperPid:process.pid,videoPid:child.pid,url})+'\n');
  process.on('message',message=>{if(message==='close')close().catch(()=>{process.exitCode=1;});});
  process.once('SIGINT',()=>close());process.once('SIGTERM',()=>close());
  // A single stdin line ends this owned fixture and video service without killing unrelated processes.
  process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{if(s.includes('close'))close();});
}
main().catch(async e=>{process.stderr.write(String(e.message)+'\n');await close();process.exitCode=1;});
