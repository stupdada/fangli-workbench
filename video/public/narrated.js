'use strict';
(() => {
  const base='/api/video/narrated';
  const $=id=>document.getElementById(`short-${id}`);
  const params=new URLSearchParams(location.search);
  const article=Number(params.get('article_id')),version=Number(params.get('version_id'));
  let source=article&&version?{article_id:article,version_id:version}:null;
  let conversationId=params.get('conversation_id')||'';
  let record=null,context=null,health=null,busy=false,dirty=false,page=1,render=null;
  let libraryClient='',library=[],selectedAssets=[];
  const mediaTypes={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',mp4:'video/mp4',
    mov:'video/quicktime',webm:'video/webm',mkv:'video/x-matroska'};
  const pendingKey='fangli.short-video.operation';
  function el(tag,text,css){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(css)node.className=css;return node;}
  async function api(url,method='GET',body,type='application/json'){
    const response=await fetch(url,{method,...(body===undefined?{}:{headers:{'Content-Type':type},body:type==='application/json'?JSON.stringify(body):body})});
    let value;try{value=await response.json();}catch{throw new Error('短视频服务暂不可用');}
    if(!response.ok)throw new Error(value.error||'本次操作未完成');return value;
  }
  function status(message='',error=false){$('status').textContent=message;$('status').dataset.error=error;}
  function updateActions(){
    const client=$('client').value;
    $('client').disabled=busy||dirty;
    $('new').disabled=busy||dirty||!client||!record;
    $('generate').disabled=busy||!client||!context||!$('topic').value.trim();
    $('topic').readOnly=busy;
    $('upload').disabled=busy||!client;
    $('template').disabled=busy;
    $('draft-template').disabled=busy;
    for(const e of $('document-list').querySelectorAll('input'))e.disabled=busy;
    for(const e of $('library').querySelectorAll('input'))e.disabled=busy;
    for(const button of $('history').querySelectorAll('button'))button.disabled=busy||dirty;
    $('save').disabled=busy||!dirty;
    $('revert').disabled=busy||!dirty;
    $('render').disabled=busy||dirty||!record||!health?.ready||$('narration').checked&&!health.narrationReady;
    $('narration').disabled=busy;
    for(const e of [$('title'),$('publish-title'),$('publish-description'),...$('pages').querySelectorAll('input,textarea')])e.readOnly=busy;
    for(const e of $('pages').querySelectorAll('select'))e.disabled=busy;
  }
  async function run(action,message){
    if(busy)return;busy=true;status(message);updateActions();
    try{await action();}catch(error){status(error.message,true);}
    finally{busy=false;updateActions();}
  }
  function viewLocation(){
    const next=new URL(location.href);next.search='';
    if($('client').value)next.searchParams.set('client_id',$('client').value);
    if(source)for(const [k,v] of Object.entries(source))next.searchParams.set(k,v);
    else if(conversationId)next.searchParams.set('conversation_id',conversationId);
    if(record)next.searchParams.set('production_id',record.id);
    history.replaceState(null,'',next);
  }
  async function showHistory(){
    const target=$('history');target.replaceChildren();
    if(!$('client').value)return;
    const {productions}=await api(`${base}/productions?clientId=${encodeURIComponent($('client').value)}`);
    if(!productions.length){target.append(el('p','还没有短视频。','muted'));return;}
    for(const p of productions){
      const item=el('button',p.title,'job-tab');item.type='button';
      if(p.id===record?.id)item.setAttribute('aria-current','page');
      item.append(el('span',`第 ${p.version} 版 · ${p.source?'文章来源':'客户资料'}`,'meta'));
      item.addEventListener('click',()=>run(async()=>{await load(p.id);status();},'正在打开制作记录…'));
      target.append(item);
    }
    updateActions();
  }
  function templateOptions(){return Object.entries(health?.template_labels||{process:'流程说明',intro:'图文介绍',qa:'问题解答'});}
  function setOptions(select,pairs,value){
    select.replaceChildren();
    for(const [id,name] of pairs){const option=el('option',name);option.value=id;select.append(option);}
    select.value=value;
  }
  function assetChoices(){
    const items=new Map((record?.current.assets||[]).map(asset=>[asset.id,asset.name]));
    for(const asset of library)items.set(asset.id,asset.name);
    return [['','仅显示文字'],...items];
  }
  function clearMediaPreview(){
    $('media-preview').hidden=true;
    $('media-image').hidden=true;
    $('media-image').removeAttribute('src');
  }
  function previewMedia(asset){
    const client=$('client').value;
    if(!client)return;
    clearMediaPreview();
    const preview=$('media-image');
    preview.src=`${base}/asset-previews/${encodeURIComponent(asset.id)}?client_id=${encodeURIComponent(client)}`;
    preview.alt=asset.type.startsWith('video/')?`视频代表帧 ${asset.name}`:`图片 ${asset.name}`;
    preview.hidden=false;
    $('media-name').textContent=asset.type.startsWith('video/')?`${asset.name} · 视频代表帧`:asset.name;
    $('media-preview').hidden=false;
  }
  function showLibrary(){
    $('library').replaceChildren();
    $('library-note').textContent=!$('client').value?'选择客户后查看素材。':!library.length?'此客户还没有素材。':
      record?`${library.length} 份素材，可在各页选择。`:`${library.length} 份素材 · 已选 ${selectedAssets.length} / 6`;
    for(const asset of library){
      const row=el('div',undefined,'short-material');
      if(!record){
        const check=el('input');check.type='checkbox';check.checked=selectedAssets.includes(asset.id);
        check.setAttribute('aria-label',`选择素材 ${asset.name}`);
        check.addEventListener('change',()=>{
          if(check.checked&&selectedAssets.length>=6){check.checked=false;status('每条视频最多选择 6 份素材。',true);return;}
          selectedAssets=check.checked?[...selectedAssets,asset.id]:selectedAssets.filter(id=>id!==asset.id);
          $('library-note').textContent=`${library.length} 份素材 · 已选 ${selectedAssets.length} / 6`;
        });
        row.append(check);
      }
      const button=el('button',asset.name);button.type='button';button.setAttribute('aria-label',`预览素材 ${asset.name}`);
      button.addEventListener('click',()=>previewMedia(asset));row.append(button);$('library').append(row);
    }
  }
  async function loadLibrary(clientId){
    if(libraryClient!==clientId){
      libraryClient='';library=[];selectedAssets=[];clearMediaPreview();showLibrary();
      library=clientId?(await api(`/api/video/assets?clientId=${encodeURIComponent(clientId)}`)).assets:[];
      libraryClient=clientId;
    }
    showLibrary();
  }
  function uploadFiles(files){
    if(!files.length||busy)return;
    const client=$('client').value;
    if(!client){status('请先选择客户。',true);return;}
    return run(async()=>{
      let uploaded=0;
      let firstAsset;
      const errors=[];
      for(const file of files){
        try{
          const extension=file.name.split('.').at(-1).toLowerCase();
          const type=Object.values(mediaTypes).includes(file.type)?file.type:Object.hasOwn(mediaTypes,extension)?mediaTypes[extension]:'';
          if(!type)throw new Error('请选择支持的图片或视频文件');
          const asset=await api(`/api/video/upload?clientId=${encodeURIComponent(client)}&name=${encodeURIComponent(file.name)}`,'POST',file,type);
          library.unshift(asset);uploaded++;
          firstAsset??=asset;
          if(!record&&selectedAssets.length<6)selectedAssets.push(asset.id);
        }catch(error){errors.push(`${file.name} ${error.message}`);}
      }
      showLibrary();
      if(firstAsset)previewMedia(firstAsset);
      for(const p of record?.current.pages||[]){const select=$(`asset-${p.id}`);setOptions(select,assetChoices(),select.value);}
      status([uploaded?`已上传 ${uploaded} 份素材。`:'',...errors].filter(Boolean).join(' '),errors.length>0);
    },'正在上传素材…');
  }
  async function sourceForm({reset=false}={}){
    record=null;render=null;dirty=false;context=null;
    clearPlayer();
    $('source').hidden=false;$('draft').hidden=true;$('preview').hidden=true;
    $('document-list').replaceChildren();$('documents').hidden=true;
    $('source-name').textContent='客户资料';
    if(reset){$('topic').value='';$('template').value='process';selectedAssets=[];}
    const clientId=$('client').value;
    await loadLibrary(clientId);
    if(clientId){
      const q=new URLSearchParams({clientId});
      if(source)for(const [k,v] of Object.entries(source))q.set(k,v);
      else if(conversationId)q.set('conversation_id',conversationId);
      context=await api(`/api/video/context?${q}`);
      if(source){
        const title=context.article.title;
        $('source-name').textContent=`采用的文章 · ${title} · 版本 ${source.version_id}`;
        if(!$('topic').value)$('topic').value=title;
      }else{
        $('documents').hidden=false;
        if(!context.documents.length)$('document-list').append(el('p','请先在文案工作台添加客户资料。','muted'));
        for(const d of context.documents){
          const label=el('label',undefined,'check-row'),input=el('input');
          input.type='checkbox';input.checked=true;input.value=d.id;
          label.append(input,el('span',d.filename));$('document-list').append(label);
        }
      }
    }
    viewLocation();await showHistory();updateActions();
  }
  function field(parent,label,value,id,{multi=false,max}={}){
    const l=el('label',label);l.htmlFor=id;
    const input=el(multi?'textarea':'input');input.id=id;input.value=value;
    if(max)input.maxLength=max;
    if(multi)input.rows=2;
    input.addEventListener('input',edited);parent.append(l,input);return input;
  }
  function choice(parent,label,id,pairs,value,onChange){
    const group=el('div'),l=el('label',label),select=el('select');
    select.id=id;l.htmlFor=id;setOptions(select,pairs,value);
    select.addEventListener('change',onChange);group.append(l,select);parent.append(group);
  }
  function edited(){if(!record)return;const refresh=!dirty||render;dirty=true;render=null;characters();if(refresh){updatePreview();status('有未保存的修改。');}updateActions();}
  const voiceLength=text=>Array.from(text.replace(/\s/gu,'')).length;
  function characters(){
    const total=record.current.pages.reduce((n,p)=>n+voiceLength($(`voice-${p.id}`).value),0);
    $('character-count').textContent=`口播 ${total} 字 / 100—160 字 · ${record.current.pages.length} 页`;
  }
  function editingPayload(){
    const current=record.current;
    const max=record.point_max_characters;
    const pages=current.pages.map((p,i)=>{
      const points=$(`points-${p.id}`).value.split(/\r?\n/).map(text=>text.trim()).filter(Boolean);
      if(max&&points.some(text=>Array.from(text).length>max))throw new Error(`第 ${i+1} 页画面要点每项最多 ${max} 字。`);
      const layout=$(`layout-${p.id}`).value,assetId=$(`asset-${p.id}`).value;
      return {id:p.id,heading:$(`heading-${p.id}`).value,points,...(layout?{layout}:{}),...(assetId?{asset_id:assetId}:{})};
    });
    return {expected_version:record.version,title:$('title').value,template:$('draft-template').value,
      publish:{title:$('publish-title').value,description:$('publish-description').value},
      script:{paragraphs:current.pages.map((p,i)=>{
        const text=$(`voice-${p.id}`).value;
        if(voiceLength(text)>36)throw new Error(`第 ${i+1} 页口播最多 36 个有效字符（空白不计）。`);
        return {page_id:p.id,text};
      })},pages};
  }
  function editRecord(){
    const target=$('editorial');target.replaceChildren();
    if(record.source)target.append(el('p',`文章 ${record.source.article_id} · 版本 ${record.source.version_id} · ${record.source.title}`));
    const names=new Map(record.documents.map(d=>[String(d.id),d.filename]));
    if(record.documents.length)target.append(el('p',`本次资料：${record.documents.map(d=>d.filename).join('、')}`));
    if(record.current.assets?.length)target.append(el('p',`画面素材：${record.current.assets.map(asset=>asset.name).join('、')}`));
    const editorial=record.current.editorial;
    for(const c of editorial?.claims||[])target.append(el('p',`第 ${c.page_id.slice(1)} 页 · ${c.text} — ${c.source_id==='article'?record.source?.title:names.get(c.source_id)}：「${c.quote}」`));
    for(const c of editorial?.unresolved||[])target.append(el('p',`第 ${c.page_id.slice(1)} 页 · ${c.reason}：${c.text}`));
    for(const issue of editorial?.issues||[])target.append(el('p',issue));
  }
  function clearPlayer(){
    const player=$('player');player.hidden=true;
    if(player.hasAttribute('src')){player.pause();player.removeAttribute('src');player.load();}
  }
  function updatePreview(){
    if(!record)return;
    const player=$('player'),image=$('preview-image'),downloads=$('downloads');
    downloads.replaceChildren();
    const release=$('release');release.replaceChildren();release.hidden=true;
    for(const button of $('preview-tabs').querySelectorAll('button'))button.setAttribute('aria-pressed',String(!render&&Number(button.dataset.page)===page));
    if(render){
      const path=`${base}/productions/${record.id}/renders/${render.id}/`;
      image.hidden=true;player.hidden=false;
      if(player.getAttribute('src')!==path+'video.mp4'){player.src=path+'video.mp4';player.poster=path+'cover.png';}
      $('preview-label').textContent=`第 ${render.version} 版成片 · ${render.duration.toFixed(2)} 秒 · ${render.audioStreams?'普通话配音':'图文播放'}`;
      const files=[['video.mp4?download=1','MP4'],['captions.srt','SRT'],['cover.png','封面'],['script.json','口播'],['pages.json','页面']];
      if(render.publish){
        release.append(el('h3',render.publish.title),el('p',render.publish.description));release.hidden=false;
        files.push(['publish.txt','发布标题与简介']);
      }
      if(render.audioStreams)files.push(['narration.wav?download=1','配音']);
      for(const [file,label] of files){const link=el('a',label);link.href=path+file;link.download='';downloads.append(link);}
    }else{
      clearPlayer();
      image.src=`${base}/productions/${record.id}/versions/${record.version}/page-${page}.png`;
      image.alt=`第 ${page} 页：${record.current.pages[page-1].heading}`;image.hidden=false;
      $('preview-label').textContent=dirty?`第 ${record.version} 版页面 · 保存后更新`:`第 ${record.version} 版页面 · ${page} / ${record.current.pages.length}`;
    }
  }
  function showDraft(value,{focusRender=false}={}){
    record=value;source=value.source?{article_id:value.source.article_id,version_id:value.source.version_id}:null;
    $('source').hidden=true;$('draft').hidden=false;$('preview').hidden=false;
    $('origin-label').textContent=value.source?`采用的文章 · 版本 ${value.source.version_id}`:'客户资料';
    $('revision').textContent=`第 ${value.version} 版`;
    $('title').value=value.current.title;dirty=false;page=1;
    setOptions($('draft-template'),templateOptions(),value.current.template);
    const publication=value.current.publish||{title:value.current.title,description:value.current.script.paragraphs[0].text};
    $('publish-title').value=publication.title;$('publish-description').value=publication.description;
    showLibrary();
    render=focusRender?value.renders.filter(r=>r.version===value.version).at(-1)||null:null;
    $('pages').replaceChildren();$('preview-tabs').replaceChildren();$('renders').replaceChildren();
    for(let i=0;i<value.current.pages.length;i++){
      const p=value.current.pages[i],section=el('section',undefined,'short-page');
      section.append(el('h3',`第 ${i+1} 页`));
      field(section,'口播（最多 36 个有效字符，空白不计）',value.current.script.paragraphs[i].text,`short-voice-${p.id}`,{multi:true});
      field(section,'画面标题',p.heading,`short-heading-${p.id}`,{max:16});
      const pointsLabel=value.point_max_characters?`画面要点（每行一项，最多 ${value.point_max_characters} 字）`:'画面要点（每行一项）';
      field(section,pointsLabel,p.points.join('\n'),`short-points-${p.id}`,{multi:true});
      const settings=el('div',undefined,'short-page-settings');
      choice(settings,'页面排版',`short-layout-${p.id}`,[['','跟随默认模板'],...templateOptions()],p.layout||'',edited);
      choice(settings,'页面素材',`short-asset-${p.id}`,assetChoices(),p.asset_id||'',event=>{
        page=i+1;edited();updatePreview();
        const asset=library.find(item=>item.id===event.target.value);
        if(asset)previewMedia(asset);
      });
      section.append(settings);
      $('pages').append(section);
      const button=el('button',`${i+1}`);button.type='button';button.dataset.page=i+1;button.setAttribute('aria-label',`第 ${i+1} 页`);
      button.addEventListener('click',()=>{render=null;page=i+1;updatePreview();});$('preview-tabs').append(button);
    }
    if(value.renders.length){
      $('renders').append(el('h3','成片历史'));
      for(const r of [...value.renders].reverse()){
        const button=el('button',`第 ${r.version} 版 · ${r.duration.toFixed(2)} 秒${r.audioStreams?' · 配音':''}`,'text-button');
        button.type='button';button.addEventListener('click',()=>{render=r;updatePreview();});$('renders').append(button);
      }
    }
    characters();editRecord();updatePreview();viewLocation();updateActions();
  }
  async function load(id,clientId=$('client').value){
    if(!id||!clientId)throw new Error('制作详情需同时指定客户和制作记录。');
    const value=await api(`${base}/productions/${encodeURIComponent(id)}?client_id=${encodeURIComponent(clientId)}`);
    if(value.client.id!==clientId)throw new Error('制作记录不存在。');
    $('client').value=value.client.id;
    await loadLibrary(clientId);
    showDraft(value,{focusRender:true});await showHistory();
  }
  async function finish(op){
    sessionStorage.setItem(pendingKey,op.id);
    while(op.status==='running')op=await api(`${base}/operations/${op.id}?wait=1`);
    sessionStorage.removeItem(pendingKey);
    if(op.status!=='completed')throw new Error(op.error||'本次制作未完成');
    await load(op.production_id,op.client_id);status(op.kind==='render'?'成片已完成，可以播放或下载。':'短脚本已生成，可以编辑或制作成片。');
  }
  $('source').addEventListener('submit',event=>{
    event.preventDefault();if($('generate').disabled)return;
    const body={clientId:$('client').value,topic:$('topic').value,template:$('template').value};
    if(selectedAssets.length)body.asset_ids=[...selectedAssets];
    if(source)body.source=source;
    else{
      body.document_ids=[...$('document-list').querySelectorAll('input:checked')].map(input=>input.value);
      if(conversationId)body.conversation_id=conversationId;
      if(!body.document_ids.length){status('请至少选择一份客户资料。',true);$('documents').open=true;return;}
    }
    run(async()=>finish(await api(`${base}/productions`,'POST',body)),'正在生成口播和页面…');
  });
  $('client').addEventListener('change',()=>run(async()=>{source=null;conversationId='';await sourceForm({reset:true});status();},'正在读取客户资料…'));
  $('new').addEventListener('click',()=>run(async()=>{source=null;conversationId='';await sourceForm({reset:true});status();$('topic').focus();},'正在打开新建短视频…'));
  $('topic').addEventListener('input',updateActions);
  $('title').addEventListener('input',edited);
  $('draft-template').addEventListener('change',edited);
  $('publish-title').addEventListener('input',edited);
  $('publish-description').addEventListener('input',edited);
  $('upload').addEventListener('change',event=>{const files=[...event.target.files];event.target.value='';uploadFiles(files);});
  $('drop').addEventListener('dragover',event=>{event.preventDefault();$('drop').dataset.over=true;});
  $('drop').addEventListener('dragleave',()=>$('drop').dataset.over=false);
  $('drop').addEventListener('drop',event=>{event.preventDefault();$('drop').dataset.over=false;uploadFiles([...event.dataTransfer.files]);});
  $('narration').addEventListener('change',updateActions);
  $('revert').addEventListener('click',()=>{showDraft(record,{focusRender:true});status('已恢复到保存版本。');});
  $('save').addEventListener('click',()=>run(async()=>{
    showDraft(await api(`${base}/productions/${record.id}`,'PUT',editingPayload()));await showHistory();status('新版本已保存，可以重新制作。');
  },'正在保存新版本…'));
  $('render').addEventListener('click',()=>run(async()=>finish(await api(`${base}/productions/${record.id}/renders`,'POST',{
    expected_version:record.version,narration:$('narration').checked
  })), $('narration').checked?'正在配音并合成视频…':'正在合成图文视频…'));
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  return run(async()=>{
    const [{clients},ready]=await Promise.all([api('/api/video/clients'),api(`${base}/health`).catch(()=>null)]);
    health=ready;
    setOptions($('template'),templateOptions(),'process');
    $('voice').textContent=health?.narrationReady?'Microsoft Huihui Desktop · 本机音色':health?.ready?'本机普通话音色不可用':'本机视频引擎未就绪';
    for(const c of clients){const option=el('option',c.name);option.value=c.id;$('client').append(option);}
    const requestedClient=params.get('client_id')||'';
    const requestedProduction=params.get('production_id');
    $('client').value=requestedClient;
    if(params.has('article_id')!==params.has('version_id')||params.has('article_id')&&!source)throw new Error('文章来源需同时指定文章和版本。');
    if(requestedProduction!==null)await load(requestedProduction,requestedClient);
    else await sourceForm();
    const active=sessionStorage.getItem(pendingKey);
    if(active){
      const pending=`${base}/operations/${encodeURIComponent(active)}`;
      if(requestedProduction===null){await finish(await api(`${pending}?wait=1`));return;}
      const op=await api(pending).catch(()=>null);
      if(op?.production_id===requestedProduction&&op.client_id===requestedClient){await finish(op);return;}
    }
    status();
  },'正在读取短视频工作区…');
})();
