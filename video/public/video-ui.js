(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.FangliVideo = api; document.addEventListener('DOMContentLoaded', () => api.mount(document)); }
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const Content = typeof module === 'object' && module.exports ? require('./content.js') : globalThis.FangliVideoContent;
  const Authoring = typeof module === 'object' && module.exports ? require('./authoring-view.js') : globalThis.FangliVideoAuthoring;
  const ACTIVE = new Set(['queued', 'running', 'stopping']);
  const STATES = { queued: '排队中', running: '合成中', stopping: '正在停止', cancelled: '已停止', interrupted: '服务中断', completed: '已完成', failed: '失败' };
  const PHASES = { render: '画面合成', concat: '拼接' };
  const KEY = 'fangli.workbench.video.drafts.v2:';
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = () => typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const segment = (media = '') => ({ id: uid(), text: '', media, durationSeconds: 5 });
  const newJob = n => ({ id: uid(), title: '视频 ' + n, width: 720, height: 1280, motion: 'gentle', textStyle: { position: 'bottom', preset: 'white-outline', fontSize: 48 }, segments: [segment()], originalText: '', manualMarkdown: '', source: null, sourceInput: {article_id:'',version_id:''}, editorial: null, targetPreset:'short', minimumSeconds:3, targetAcknowledged:false, bodyNeedsPagination:false, revision: 1 });
  function configDetails(config) {
    return { ready: config?.mode === 'silent' && (config.rendererReady ?? config.rendererAvailable ?? config.engineReady) === true, reason: typeof config?.rendererError === 'string' ? config.rendererError : '', maxJobs: config?.maxJobs || 30, maxSegments: config?.maxSegments || 100, maxSegmentCharacters: config?.maxSegmentCharacters || 500, maxUploadBytes: config?.maxUploadBytes || 32 * 1024 * 1024, maxDuration: config?.maxJobDurationSeconds || 600 };
  }
  function duration(job) {
    const values = job.segments.map(s => Number(s.durationSeconds));
    return { seconds: values.reduce((a, b) => a + b, 0), valid: values.length > 0 && values.every(n => Number.isFinite(n) && n >= 1 && n <= 60) };
  }
  const secondsLabel = n => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  // Estimate at output resolution. The renderer owns final font metrics.
  function textLayout(text, job) {
    const size = Number(job.textStyle.fontSize), maxWidth = job.width * .84 - size * .16;
    const maxLines = Math.min(2, Math.floor(job.height * .32 / (size * 1.35)));
    const lines = []; let line = '', width = 0;
    for (const char of Array.from(text)) {
      if (char === '\n') { lines.push(line); line = ''; width = 0; continue; }
      const advance = size * (/\p{Mark}/u.test(char) ? 0 : /\s/u.test(char) ? .4 : char.codePointAt(0) >= 0x2e80 ? 1.1 : .7);
      if (line && width + advance > maxWidth) { lines.push(line); line = ''; width = 0; }
      line += char; width += advance;
    }
    lines.push(line);
    const valid = Number.isInteger(size) && size >= Math.max(16, Math.ceil(Math.min(job.width, job.height) / 40)) && size <= Math.min(128, Math.floor(Math.min(job.width, job.height) / 3)) && maxLines >= 1;
    return { lines, maxLines, issue: !valid ? '字号需为 16–128 的整数像素，并与当前画幅匹配。' : lines.length > maxLines ? '文字超出当前画幅的两行展示区，请拆成更多画面或精简短句。' : '' };
  }
  function safeFileUrl(value) {
    if (typeof value !== 'string' || !value.startsWith('/api/video/') || value.includes('\\') || value.includes('#')) return '';
    try { const url = new URL(value, 'http://localhost'); if (url.origin !== 'http://localhost' || /(?:^|\/)\.\.(?:\/|$)/.test(decodeURIComponent(value))) return ''; return /^\/api\/video\/batches\/[^/]+\/files\/[^/]+\/(video\.mp4|subtitles\.srt)$/.test(url.pathname) ? url.pathname + url.search : ''; } catch { return ''; }
  }
  function createBlobStore(indexedDB) {
    let opening;
    const db = () => opening ||= new Promise((resolve, reject) => {
      if (!indexedDB) { reject(new Error('本机预览存储不可用')); return; }
      const request = indexedDB.open('fangli-video-previews-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('assets');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    async function access(clientId, id, blob) {
      const database = await db(); return new Promise((resolve, reject) => {
        const transaction = database.transaction('assets', blob === undefined ? 'readonly' : 'readwrite');
        const store = transaction.objectStore('assets'), key = clientId + ':' + id;
        const request = blob === undefined ? store.get(key) : store.put(blob, key);
        transaction.oncomplete = () => resolve(request.result); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
      });
    }
    return { get: (clientId, id) => access(clientId, id), put: (clientId, id, blob) => access(clientId, id, blob) };
  }
  function createController(options = {}) {
    const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
    const storage = options.storage || { getItem() { return null; }, setItem() {} }, previewUrls = new Map();
    const state = { clients: [], clientId: '', context:null, config: null, draft: null, batches: [], archived:false, removed:false, removedAssets:[], busy: false, generating: false, message: '', error: false, storageError: false, fixture: Boolean(options.fixture) };
    let selectedJob = '', selectedSegment = '', epoch = 0;
    const notify = (message = '', error = false) => { state.message = message; state.error = error; options.onChange?.(state); };
    async function request(url, init = {}) {
      let response;
      try { response = await fetcher(url, { credentials: 'same-origin', ...init }); } catch { throw new Error('本机服务连接失败。输入已保留，请确认服务运行后再试。'); }
      let value; try { value = await response.json(); } catch { throw new Error('本机服务未返回有效 JSON，请检查视频 API 是否已接入。'); }
      if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : value.error?.message || value.message || '请求失败（' + response.status + '）');
      return value;
    }
    const post = (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const put = (url, body) => request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    function persist() { if (state.clientId && state.draft) try { storage.setItem(KEY + state.clientId, JSON.stringify(state.draft)); state.storageError = false; } catch { state.storageError = true; } }
    const job = () => state.draft?.jobs.find(j => j.id === selectedJob);
    const selected = () => job()?.segments.find(s => s.id === selectedSegment) || job()?.segments[0];
    function changed(current) { if (current) {current.revision++;current.targetAcknowledged=false;} persist(); }
    function rememberPreview(asset, blob) {
      if (!blob || !options.makeObjectURL) return;
      const old = previewUrls.get(asset.id); if (old) options.revokeObjectURL?.(old);
      try { previewUrls.set(asset.id, options.makeObjectURL(blob)); } catch {}
    }
    async function loadHistory() {
      const clientId = state.clientId, token = epoch, archived=state.archived; if (!clientId) return;
      const result = await request('/api/video/batches?clientId=' + encodeURIComponent(clientId) + '&archived=' + Number(archived)); if (token !== epoch || archived!==state.archived) return;
      state.batches = (Array.isArray(result) ? result : result.batches || []).filter(b => b.clientId === clientId); notify();
    }
    async function loadAssets(removed=false) {
      const clientId=state.clientId, token=epoch;
      const {assets}=await request('/api/video/assets?clientId='+encodeURIComponent(clientId)+(removed?'&removed=1':''));
      if(token!==epoch)return;
      if(removed)state.removedAssets=assets;
      else {
        const prior=new Map(state.draft.assets.map(a=>[a.id,a]));
        state.draft.assets=assets.map(a=>({...a,clientId,selected:prior.get(a.id)?.selected??false}));
        persist();
      }
      options.onChange?.(state);
    }
    async function lifecycle(action) {
      if(state.busy||state.generating||!state.clientId)return;
      state.busy=true;options.onChange?.(state);
      try{await action(state.clientId);}
      finally{state.busy=false;options.onChange?.(state);}
    }
    async function switchClient(clientId) {
      if (state.busy) throw new Error('请等待本次操作完成后切换客户。');
      if (clientId && !state.clients.some(c => c.id === clientId)) throw new Error('请选择已有客户。');
      persist(); epoch++; state.clientId = clientId; state.context=null; state.batches = []; state.archived=false;state.removed=false;state.removedAssets=[]; selectedSegment = '';
      for (const url of previewUrls.values()) options.revokeObjectURL?.(url); previewUrls.clear();
      if (!clientId) { state.draft = null; selectedJob = ''; notify(); return; }
      let saved; try { saved = JSON.parse(storage.getItem(KEY + clientId) || 'null'); } catch {}
      state.draft = saved?.clientId === clientId && saved.mode === 'silent' && Array.isArray(saved.jobs) && saved.jobs.every(j => Array.isArray(j.segments) && j.textStyle) ? saved : { clientId, mode: 'silent', jobs: [newJob(1)], assets: [], snapshots: {} };
      state.draft.assets ||= []; state.draft.snapshots ||= {}; selectedJob = state.draft.jobs[0]?.id || ''; persist(); notify();
      const token = epoch, assets = [...state.draft.assets];
      await Promise.all([loadHistory(), loadAssets(), (async()=>{const context=await request('/api/video/context?clientId='+encodeURIComponent(clientId));if(token===epoch){state.context=context;options.onChange?.(state);}})(), (async () => {
        if (!options.blobStore) return;
        for (const asset of assets) { try { const blob = await options.blobStore.get(clientId, asset.id); if (token !== epoch) return; rememberPreview(asset, blob); } catch { break; } }
        if (token === epoch) options.onChange?.(state);
      })()]);
    }
    async function loadConfig(refresh = false) { state.config = await request('/api/video/config' + (refresh ? '?refresh=1' : '')); notify(); }
    async function initialize() {
      const results = await Promise.allSettled([loadConfig(), request('/api/video/clients')]);
      if (results[1].status === 'fulfilled') state.clients = Array.isArray(results[1].value) ? results[1].value : results[1].value.clients || [];
      const failures = results.filter(r => r.status === 'rejected').map(r => r.reason.message); notify(failures.join('；'), failures.length > 0);
      if(options.initialSource?.requested&&(!options.initialSource.clientId||![options.initialSource.article_id,options.initialSource.version_id].every(n=>Number.isSafeInteger(n)&&n>0)))throw new Error('文章视频入口必须完整指定客户、文章ID和版本ID；请从已采用稿件重新进入。');
      if(!failures.length&&options.initialSource?.clientId){
        await switchClient(options.initialSource.clientId);
        const source=options.initialSource;
        if(source.article_id&&source.version_id){
          const saved=state.draft.jobs.find(item=>item.source?.article_id===source.article_id&&item.source?.version_id===source.version_id);
          if(saved){selectedJob=saved.id;selectedSegment='';notify('已恢复文章 '+source.article_id+' · 固定版本 '+source.version_id+' 的视频草稿。');}
          else{
            const current=job();
            if(current&&(current.source||current.originalText?.trim()||current.segments.some(s=>s.media||s.text.trim())))addJob();
            if(!job())addJob();
            job().sourceInput={article_id:source.article_id,version_id:source.version_id};await importArticle();
          }
        }
      }
    }
    function addJob() {
      if (!state.draft) throw new Error('请先选择客户。'); if (state.draft.jobs.length >= 30) throw new Error('每批最多 30 条视频。');
      const next = newJob(state.draft.jobs.length + 1); state.draft.jobs.push(next); selectedJob = next.id; selectedSegment = ''; changed(); notify(); return next;
    }
    function editJob(field, value) {
      const current = job(); if (!current) return;
      if (field === 'format') { current.width = value === 'landscape' ? 1280 : 720; current.height = value === 'landscape' ? 720 : 1280; }
      else if (['position', 'preset', 'fontSize'].includes(field)) current.textStyle[field] = field === 'fontSize' ? Number(value) : value;
      else if (['article_id','version_id'].includes(field)) {current.sourceInput ||= {};current.sourceInput[field]=value;}
      else if (field==='minimumSeconds') current.minimumSeconds=Number(value);
      else if (field==='targetAcknowledged'){current.targetAcknowledged=Boolean(value);current.revision++;persist();return;}
      else if (['title', 'originalText', 'motion', 'manualMarkdown','targetPreset'].includes(field)) current[field] = value;
      else throw new Error('未知编辑字段。'); changed(current);
      if (['originalText','fontSize','format','minimumSeconds'].includes(field)) {current.bodyNeedsPagination=true;persist();}
    }
    function editSegment(id, field, value) {
      const current = job(), item = current?.segments.find(s => s.id === id); if (!item) return;
      if (!['text', 'media', 'durationSeconds'].includes(field)) throw new Error('未知画面字段。');
      if (field === 'media' && value && !state.draft.assets.some(a => a.id === value && a.clientId === state.clientId)) throw new Error('素材不属于当前客户。');
      item[field] = field === 'durationSeconds' ? Number(value) : value; selectedSegment = id; changed(current);
      if (field==='text') { current.originalText=current.segments.map(s=>s.text).join('\n');current.bodyNeedsPagination=false;persist(); }
    }
    function addSegment(media = '') {
      const current = job(); if (!current) throw new Error('请先添加视频。');
      if (current.segments.length >= configDetails(state.config).maxSegments) throw new Error('每条视频最多 100 个画面。');
      const next = segment(media); current.segments.push(next); selectedSegment = next.id; changed(current); notify(); return next;
    }
    function assignAsset(asset, arrangement) {
      let current = job();
      if (arrangement === 'separate' && (!current || current.segments.length !== 1 || current.segments[0].media || current.segments[0].text)) current = addJob();
      const empty = current?.segments.find(s => !s.media);
      if (empty) { empty.media = asset.id; selectedSegment = empty.id; } else addSegment(asset.id);
      if (arrangement === 'separate') current.title = asset.name.replace(/\.[^.]+$/, ''); changed(current);
    }
    async function upload(files, arrangement = 'sequence') {
      if (!state.clientId || !job()) throw new Error('请先选择客户并添加视频。');
      const clientId = state.clientId, limits = configDetails(state.config), failures = []; state.busy = true; notify('正在添加素材…');
      try {
        for (const file of files) {
          if (!/^(image\/(jpeg|png|webp)|video\/(mp4|quicktime|webm))$/.test(file.type)) { failures.push(file.name + '：请选择 JPG、PNG、WebP、MP4、MOV 或 WebM'); continue; }
          if (!file.size || file.size > limits.maxUploadBytes) { failures.push(file.name + '：单文件须大于 0 且不超过 ' + Math.floor(limits.maxUploadBytes / 1024 / 1024) + ' MB'); continue; }
          try {
            const value = await request('/api/video/upload?clientId=' + encodeURIComponent(clientId) + '&name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
            const id = value.assetId || value.id; if (!id || value.clientId && value.clientId !== clientId) throw new Error('上传返回的素材归属无效');
            const asset = { id, name: file.name, type: file.type, clientId, selected: true }; state.draft.assets.push(asset); rememberPreview(asset, file); persist();
            if (options.blobStore) try { await options.blobStore.put(clientId, id, file); } catch { failures.push(file.name + '：已上传，浏览器无法保存预览；素材关联仍保留'); }
            assignAsset(asset, arrangement);
          } catch (error) { failures.push(file.name + '：' + error.message); }
        }
      } finally { state.busy = false; persist(); notify(failures.length ? failures.join('；') : '素材已按顺序加入画面，接着填写展示文字。', failures.length > 0); }
    }
    function useSelected() { const assets = state.draft.assets.filter(a => a.selected && a.clientId === state.clientId); if (!assets.length) throw new Error('请先勾选素材。'); for (const asset of assets) assignAsset(asset, 'sequence'); notify('已按素材列表顺序加入当前视频。'); }
    function fillScreens() {
      const current=job(), assets=state.draft?.assets.filter(a=>a.selected&&a.clientId===state.clientId)||[];
      if (!current||!assets.length) throw new Error('请先上传并勾选当前客户的图片。');
      current.segments.forEach((s,i)=>{s.media=assets[i%assets.length].id;});changed(current);notify('已用勾选素材轮换填充全部分屏。');
    }
    function applyContent(current,result) {
      if(result.clientId!==state.clientId||!Array.isArray(result.segments)||!result.segments.length||Content.canon(result.segments.map(s=>s.text).join(''))!==Content.canon(result.body)) throw new Error('分屏未完整覆盖正文，原稿已保留。');
      for(const s of result.segments)if(typeof s.text!=='string'||textLayout(s.text,current).issue||!Number.isFinite(s.durationSeconds)||s.durationSeconds<1||s.durationSeconds>60)throw new Error('分屏无法在当前画幅清晰展示，原稿已保留。');
      const assets=state.draft.assets.filter(a=>a.selected&&a.clientId===state.clientId);
      const media=current.segments.map(s=>s.media).filter(id=>state.draft.assets.some(a=>a.id===id&&a.clientId===state.clientId));
      const available=media.length?media:assets.map(a=>a.id);
      current.originalText=result.body;current.segments=result.segments.map((s,i)=>({id:uid(),text:s.text,durationSeconds:s.durationSeconds,media:available.length?available[i%available.length]:''}));
      current.bodyNeedsPagination=false;selectedSegment=current.segments[0].id;changed(current);notify('完整正文已分屏。预计 '+secondsLabel(result.durationSeconds)+' 秒，可选择图片后制作。');
    }
    async function relayoutGeo(){
      if(state.generating||state.busy)return;
      const current=job();if(!current)throw new Error('请先选择客户并添加视频。');
      const token=epoch,revision=current.revision,jobId=current.id,clientId=state.clientId;
      state.generating=true;notify('正在按真实字体对全文分屏…');
      try{
        const result=await post('/api/video/content-layouts',{clientId,body:current.originalText,width:current.width,height:current.height,textStyle:clone(current.textStyle),motion:current.motion,targetPreset:current.targetPreset,minimumSeconds:current.minimumSeconds,protectedNames:[state.context?.client?.profile?.brand].filter(Boolean)});
        if(token!==epoch||state.clientId!==clientId)return;
        const target=state.draft.jobs.find(j=>j.id===jobId);if(!target||target.revision!==revision)throw new Error('分屏期间草稿已修改，请重新分屏。');
        applyContent(target,result);return result;
      }catch(e){if(token===epoch)notify(e.message,true);throw e;}
      finally{state.generating=false;options.onChange?.(state);}
    }
    async function importContent(source){
      if(state.generating||state.busy)return;
      const current=job();if(!current)throw new Error('请先选择客户并添加视频。');
      const token=epoch,revision=current.revision,jobId=current.id,clientId=state.clientId;
      state.generating=true;notify(source?'正在导入指定文章版本…':'正在区分正文与画面说明…');
      try{
        const result=await post('/api/video/content-imports',{clientId,...(source?{source}:{body_md:current.manualMarkdown,title:current.title})});
        if(token!==epoch||state.clientId!==clientId)return;
        const target=state.draft.jobs.find(j=>j.id===jobId);if(!target||target.revision!==revision)throw new Error('导入期间草稿已修改，请重新导入。');
        target.title=result.title;target.source=result.source?{article_id:result.source.article_id,version_id:result.source.version_id}:null;
        target.editorial=result.editorial;target.originalText=result.body;target.bodyNeedsPagination=true;state.context=result.context;changed(target);notify('原稿与编辑信息已保存，正在对完整正文分屏…');
        const layout=await post('/api/video/content-layouts',{clientId,body:target.originalText,width:target.width,height:target.height,textStyle:clone(target.textStyle),motion:target.motion,targetPreset:target.targetPreset,minimumSeconds:target.minimumSeconds,protectedNames:[state.context?.client?.profile?.brand].filter(Boolean)});
        if(token===epoch&&state.clientId===clientId)applyContent(target,layout);return result;
      }catch(e){if(token===epoch)notify(e.message+' 原稿已保留。',true);throw e;}
      finally{state.generating=false;options.onChange?.(state);}
    }
    async function importArticle(){
      const values=job()?.sourceInput||{},source={article_id:Number(values.article_id),version_id:Number(values.version_id)};
      if(!Object.values(source).every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('请填写正整数文章ID和版本ID。');
      return importContent(source);
    }
    function payload() {
      const limits = configDetails(state.config);
      if (!limits.ready) throw new Error(limits.reason || '本地图文视频引擎尚未就绪，请检查本机环境后重新读取配置。');
      if (!state.clientId || !state.draft?.jobs.length || state.draft.jobs.length > 30) throw new Error('请选择客户，并添加 1–30 条视频。');
      const jobs = state.draft.jobs.map(current => {
        if(current.bodyNeedsPagination)throw new Error(current.title+'：正文、字号或停留设置已修改，请先按全文重新分屏。');
        const displayed=current.segments.map(s=>s.text).join('');if(Content.canon(current.originalText)!==Content.canon(displayed))throw new Error('分屏须完整承载正文，请重新分屏。');
        const assessment=Content.assessment(current.originalText,current.segments,Content.targets(current.targetPreset));if(!assessment.met&&!current.targetAcknowledged)throw new Error(current.title+'：'+assessment.reasons.join('；')+'。请确认按当前稿制作，或返回编辑。');
        if (!current.title.trim() || Array.from(current.title).length > 200) throw new Error('每条视频的标题须为 1–200 字。');
        if (![current.width, current.height].every(n => Number.isInteger(n) && n >= 128 && n <= 1920 && n % 2 === 0)) throw new Error('请重新选择有效画幅。');
        const total = duration(current); if (!total.valid || total.seconds > limits.maxDuration) throw new Error(current.title + '：每幅停留 1–60 秒，单条总时长不超过 600 秒。');
        if (!current.segments.length || current.segments.length > limits.maxSegments) throw new Error(current.title + '：每条需要 1–100 个画面。');
        if (!['top', 'bottom'].includes(current.textStyle.position) || !['white-outline', 'yellow-outline'].includes(current.textStyle.preset) || !['none', 'gentle'].includes(current.motion)) throw new Error('请选择有效的文字样式和画面运动。');
        const segments = current.segments.map((s, i) => {
          if (!s.text.trim() || Array.from(s.text).length > limits.maxSegmentCharacters) throw new Error(current.title + '：第 ' + (i + 1) + ' 幅请填写 1–500 字的展示文字。');
          if (/[\x00-\x09\x0b-\x1f\x7f]/.test(s.text.replace(/\r\n?/g, '\n'))) throw new Error('展示文字包含不可显示的控制字符，请清理后提交。');
          const issue = textLayout(s.text, current).issue; if (issue) throw new Error(current.title + '：第 ' + (i + 1) + ' 幅' + issue);
          if (!s.media || !state.draft.assets.some(a => a.id === s.media && a.clientId === state.clientId)) throw new Error(current.title + '：每幅画面都需选择当前客户的素材。');
          return { id: s.id, text: s.text, media: s.media, durationSeconds: Number(s.durationSeconds) };
        });
        let source;
        if(current.source){const value=current.source;if(!Number.isSafeInteger(value.article_id)||!Number.isSafeInteger(value.version_id))throw new Error('文章来源版本不正确。');source={article_id:value.article_id,version_id:value.version_id};}
        return {id:current.id,title:current.title.trim(),width:current.width,height:current.height,originalText:current.originalText||segments.map(s=>s.text).join('\n'),...(source?{source}:{}),manualMarkdown:current.editorial?.originalMarkdown||current.manualMarkdown||current.originalText,targetPreset:current.targetPreset,targetAcknowledged:current.targetAcknowledged===true,motion:current.motion,textStyle:clone(current.textStyle),segments};
      });
      return { clientId: state.clientId, mode: 'silent', jobs };
    }
    async function submit() {
      if (state.busy) return; const body = payload(), revisions = state.draft.jobs.map(j => ({ id: j.id, revision: j.revision })); state.busy = true; notify('正在提交本批视频…');
      try { const batch = await post('/api/video/batches', body); if (!batch.id || batch.clientId !== state.clientId || batch.mode !== 'silent') throw new Error('服务端返回了无效的图文任务'); state.draft.snapshots[batch.id] = { jobs: body.jobs, revisions, createdAt: new Date().toISOString() }; persist(); if (!state.archived) state.batches = [batch, ...state.batches.filter(b => b.id !== batch.id)]; notify('已提交，本机将按顺序合成。'); }
      catch (error) { error.message += ' 输入已保留，请先刷新制作记录确认任务状态。'; notify(error.message, true); throw error; }
      finally { state.busy = false; options.onChange?.(state); }
    }
    async function refreshBatch(id) {
      const token = epoch, clientId = state.clientId; if (!state.batches.some(b => b.id === id && b.clientId === clientId)) return;
      const result = await request('/api/video/batches/' + encodeURIComponent(id) + '/status?clientId=' + encodeURIComponent(clientId));
      if (token !== epoch || result.clientId !== clientId || state.archived) return;
      const index = state.batches.findIndex(b => b.id === id); if (index >= 0) state.batches[index] = result; options.onChange?.(state);
    }
    async function batchAction(id, action) {
      const batch = state.batches.find(b => b.id === id && b.clientId === state.clientId);
      if (!batch || state.busy || !['stop', 'retry'].includes(action)) throw new Error('任务不可操作。');
      if (batch.mode !== 'silent') throw new Error('历史配音任务仅供查看，请新建图文视频。');
      if (action === 'stop' && !ACTIVE.has(batch.state) || action === 'retry' && (ACTIVE.has(batch.state) || batch.canRetry === false || batch.state === 'completed')) throw new Error('当前任务不可执行此操作。');
      state.busy = true; notify();
      try { const result = await post('/api/video/batches/' + encodeURIComponent(id) + '/' + action, { clientId: state.clientId }); if (result.clientId && result.clientId !== state.clientId) throw new Error('任务归属异常'); if (result.id === id && result.jobs) state.batches[state.batches.indexOf(batch)] = { ...batch, ...result }; else await refreshBatch(id); notify(action === 'stop' ? '已请求停止本地合成；已完成的视频保留，等待服务端确认。' : '已恢复同一批次，保留原提交版本并复用有效缓存。'); }
      finally { state.busy = false; options.onChange?.(state); }
    }
    return { state, initialize, loadConfig, switchClient, loadHistory, job, selected, addJob, addSegment, editJob, editSegment, upload, useSelected, fillScreens, importArticle, importText:()=>importContent(null), relayoutGeo, payload, submit, refreshBatch, batchAction, persist, notify,
      toggleArchive: () => lifecycle(async()=>{state.archived=!state.archived;try{await loadHistory();}catch(error){state.archived=!state.archived;throw error;}}),
      toggleRemoved: () => lifecycle(async()=>{if(!state.removed)await loadAssets(true);state.removed=!state.removed;}),
      setAssetRemoved: id => lifecycle(async clientId=>{
        const meta=await put('/api/video/assets/'+encodeURIComponent(id)+'/lifecycle',{clientId,removed:!state.removed});
        if(meta.removed_at)state.draft.assets=state.draft.assets.filter(a=>a.id!==id);
        else {state.removedAssets=state.removedAssets.filter(a=>a.id!==id);if(!state.draft.assets.some(a=>a.id===id))state.draft.assets.push({...meta,clientId,selected:false});}
        persist();notify(meta.removed_at?'素材已移出，已有作品仍保留原素材。':'素材已恢复到素材库。');
      }),
      archiveJob: (batch,id) => lifecycle(async clientId=>{
        await put('/api/video/batches/'+encodeURIComponent(batch)+'/jobs/'+encodeURIComponent(id)+'/archive',{clientId,archived:!state.archived});
        await loadHistory();notify(state.archived?'作品已恢复到制作列表。':'作品已归档，可在「已归档作品」中恢复。');
      }),
      previewUrl(id) { return previewUrls.get(id) || ''; },
      selectJob(id) { selectedJob = id; selectedSegment = ''; notify(); }, selectSegment(id) { selectedSegment = id; notify(); },
      removeJob() { state.draft.jobs = state.draft.jobs.filter(j => j.id !== selectedJob); selectedJob = state.draft.jobs[0]?.id || ''; selectedSegment = ''; changed(); notify(); },
      removeSegment(id) { const current = job(); current.segments = current.segments.filter(s => s.id !== id);current.originalText=current.segments.map(s=>s.text).join('\n');current.bodyNeedsPagination=false; selectedSegment = ''; changed(current); notify(); },
      moveSegment(id, direction) { const current = job(), index = current.segments.findIndex(s => s.id === id), next = index + direction; if (index < 0 || next < 0 || next >= current.segments.length) return; [current.segments[index], current.segments[next]] = [current.segments[next], current.segments[index]];current.originalText=current.segments.map(s=>s.text).join('\n');current.bodyNeedsPagination=false; changed(current); notify(); },
      selectAsset(id, value) { const asset = state.draft.assets.find(a => a.id === id); if (asset) asset.selected = value; persist(); },
      destroy() { for (const url of previewUrls.values()) options.revokeObjectURL?.(url); previewUrls.clear(); }
    };
  }
  function previewMarkup(controller) {
    const current = controller.job(), s = controller.selected(); if (!current || !s) return '';
    const asset = controller.state.draft.assets.find(a => a.id === s.media), url = asset && controller.previewUrl(asset.id), layout = textLayout(s.text, current);
    const image = url ? asset.type.startsWith('image/') ? '<img src="' + esc(url) + '" alt="' + esc(asset.name) + '">' : '<video muted playsinline preload="metadata" src="' + esc(url) + '" aria-label="' + esc(asset.name) + '"></video>' : '<span class="preview-placeholder">' + (asset ? esc(asset.name) + '<br>素材已关联，当前会话未载入图片预览' : '添加图片后查看布局') + '</span>';
    return '<div class="preview-frame" style="aspect-ratio:' + current.width + '/' + current.height + '">' + image + '<div class="overlay-text ' + esc(current.textStyle.position) + ' ' + esc(current.textStyle.preset) + '" style="font-size:' + (Number(current.textStyle.fontSize) / current.width * 100) + 'cqw">' + esc(layout.lines.join('\n')) + '</div></div><p class="meta">编辑预览 · ' + current.width + ' × ' + current.height + ' · ' + secondsLabel(Number(s.durationSeconds) || 0) + ' 秒<br>文字按输出像素等比显示，最终排版以成片为准。</p>' + (layout.issue ? '<p class="error">' + esc(layout.issue) + '</p>' : '');
  }
  function geoMarkup(controller) { return Authoring.markup(controller); }
  function editorMarkup(controller) {
    const { state } = controller, current = controller.job(); if (!current) return '<div class="empty"><h2>让图片成为视频</h2><p>选择客户并添加视频，再为画面配上短句。</p></div>';
    const assets = state.draft.assets, source = current.source || {};
    const select = (field, label, values, value) => '<div><label for="setting-' + field + '">' + label + '</label><select id="setting-' + field + '" data-job-field="' + field + '">' + values.map(([id, name]) => '<option value="' + id + '"' + (id === value ? ' selected' : '') + '>' + name + '</option>').join('') + '</select></div>';
    return '<div class="editor-heading"><h2>安排画面</h2><span class="save-state">草稿 v' + current.revision + '</span><button data-action="remove-job">移除此视频</button></div><div class="field-row"><div><label for="job-title">视频标题</label><input id="job-title" data-job-field="title" value="' + esc(current.title) + '" maxlength="200"></div>' + select('format', '画幅', [['portrait', '竖版 9:16'], ['landscape', '横版 16:9']], current.width === 1280 ? 'landscape' : 'portrait') + '</div>' +
      geoMarkup(controller) + '<section class="editor-section"><h3>添加素材</h3><div class="upload-row"><div><label for="arrangement">多选文件时</label><select id="arrangement"><option value="sequence">按顺序加入当前视频</option><option value="separate">每个文件单独一条视频</option></select></div><div><label for="media-files">选择图片或视频 · 单个最多 ' + Math.floor(configDetails(state.config).maxUploadBytes / 1024 / 1024) + ' MB</label><input id="media-files" type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"></div></div>' +
      '<details class="asset-library"' + (state.removed ? ' open' : '') + '><summary>本客户素材库 · ' + assets.length + ' 份</summary><button data-action="toggle-removed" class="text-button" aria-pressed="' + state.removed + '">' + (state.removed?'返回素材库':'已移出素材') + '</button>' +
      ((state.removed?state.removedAssets:assets).map(a => '<div class="asset">' + (state.removed?'':'<input type="checkbox" aria-label="选择素材 ' + esc(a.name) + '" data-asset="' + esc(a.id) + '"' + (a.selected ? ' checked' : '') + '>') + '<div><strong>' + esc(a.name) + '</strong><span class="meta">' + esc(a.type) + '</span></div><button data-action="asset-lifecycle" data-id="' + esc(a.id) + '" class="text-button">' + (state.removed?'恢复素材':'移出素材') + '</button></div>').join('') || '<p class="muted">' + (state.removed?'暂无移出的素材。':'暂无素材。') + '</p>') +
      (!state.removed && assets.length ? '<button data-action="use-selected" class="text-button">按列表顺序添加勾选素材</button>' : '') + '</details></section>' +
      '<div class="settings-preview"><section><h3>画面与文字样式</h3><div class="style-fields">' + select('position', '文字位置', [['bottom', '画面下方'], ['top', '画面上方']], current.textStyle.position) + select('preset', '文字样式', [['white-outline', '白字黑边'], ['yellow-outline', '黄字黑边']], current.textStyle.preset) + '<div><label for="font-size">字号 · 输出像素</label><input id="font-size" type="number" min="16" max="128" step="1" data-job-field="fontSize" value="' + Number(current.textStyle.fontSize) + '"></div>' + select('motion', '图片运动', [['gentle', '轻微推拉'], ['none', '保持静止']], current.motion) + '</div><p class="meta">自动分屏依据全文安排阅读时长；手动添加的画面默认停留5秒。</p><p id="job-duration" class="duration-summary"></p></section><section class="composition-preview" aria-label="画面文字编辑预览"><div id="composition-preview">' + previewMarkup(controller) + '</div></section></div>' +
      '<section class="editor-section"><div class="section-head"><h3>播放顺序与展示文字</h3><button data-action="add-segment" class="secondary">添加画面</button></div>' + current.segments.map((s, index) => '<div class="segment" data-segment-row="' + esc(s.id) + '"><div class="section-head"><h3>画面 ' + (index + 1) + '</h3><div class="actions"><button data-action="view-segment" data-segment="' + esc(s.id) + '">查看预览</button><button data-action="move-up" data-segment="' + esc(s.id) + '"' + (!index ? ' disabled' : '') + '>上移</button><button data-action="move-down" data-segment="' + esc(s.id) + '"' + (index === current.segments.length - 1 ? ' disabled' : '') + '>下移</button><button data-action="remove-segment" data-segment="' + esc(s.id) + '">移除</button></div></div><div class="field-row"><div><label for="media-' + esc(s.id) + '">图片或视频</label><select id="media-' + esc(s.id) + '" data-segment="' + esc(s.id) + '" data-segment-field="media"><option value="">选择本客户素材</option>' + assets.map(a => '<option value="' + esc(a.id) + '"' + (s.media === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('') + '</select></div><div><label for="duration-' + esc(s.id) + '">停留秒数</label><input id="duration-' + esc(s.id) + '" type="number" min="1" max="60" step="0.1" data-segment="' + esc(s.id) + '" data-segment-field="durationSeconds" value="' + Number(s.durationSeconds) + '"></div></div><label for="text-' + esc(s.id) + '">展示文字</label><textarea id="text-' + esc(s.id) + '" data-segment="' + esc(s.id) + '" data-segment-field="text" rows="3" placeholder="一两句醒目的短文字，可手动换行">' + esc(s.text) + '</textarea><p class="layout-message meta" data-layout-for="' + esc(s.id) + '"></p></div>').join('') + '</section>' +
      '<footer>提交后保存独立制作版本。修改草稿、文章或素材不会替换已经完成的视频。</footer>';
  }
  function batchesMarkup(state) {
    return state.batches.map(batch => {
      const jobs = batch.jobs.filter(j=>Boolean(j.archivedAt)===Boolean(state.archived));if(!jobs.length)return '';
      const silent = batch.mode === 'silent', active = !state.archived && ACTIVE.has(batch.state), completed = jobs.filter(j => j.state === 'completed').length, snapshot = state.draft?.snapshots?.[batch.id];
      return '<article class="batch' + (active ? ' is-active' : '') + '"><header><strong>' + esc(state.archived?'已归档':STATES[batch.state] || batch.state) + '</strong><span class="meta">' + completed + ' / ' + jobs.length + ' 条</span></header><p class="meta">' + (silent ? '图文视频' : '历史配音任务 · 仅供查看') + ' · ' + esc(batch.id) + '</p>' + (batch.error ? '<p class="error">' + esc(batch.error) + '</p>' : '') +
        (silent && active ? '<button class="secondary" data-action="stop" data-batch="' + esc(batch.id) + '"' + (batch.state === 'stopping' || state.busy ? ' disabled' : '') + '>停止本地合成</button><p class="meta">已完成的视频保留，等待服务端确认停止。</p>' : silent && !state.archived && ['failed', 'cancelled', 'interrupted'].includes(batch.state) && batch.canRetry !== false ? '<button class="secondary" data-action="retry" data-batch="' + esc(batch.id) + '"' + (state.busy ? ' disabled' : '') + '>恢复同一批次</button><p class="meta">保留原提交版本，复用有效缓存。</p>' : '') +
        (silent && !state.archived && batch.canRetry === false && batch.retryUnavailableReason ? '<p class="meta">' + esc(batch.retryUnavailableReason) + '</p>' : '') +
        jobs.map(j => {
          const video = safeFileUrl(j.videoUrl), subtitles = safeFileUrl(j.subtitlesUrl), original = snapshot?.jobs.find(s => s.id === j.id) || j, revision = snapshot?.revisions.find(s => s.id === j.id)?.revision;
          return '<section class="batch-job"><h3>' + esc(j.title || j.id) + '</h3><p class="meta">' + esc(STATES[j.state] || j.state) + (silent && PHASES[j.phase] ? ' · ' + PHASES[j.phase] : '') + ' · 已完成画面 ' + Number(j.completedSegments || 0) + ' / ' + Number(j.totalSegments || 0) + '</p>' +
            (j.state === 'completed' ? '<button class="text-button" data-action="archive-job" data-batch="' + esc(batch.id) + '" data-id="' + esc(j.id) + '"' + (state.busy?' disabled':'') + '>' + (state.archived?'恢复作品':'归档作品') + '</button>' : '') +
            (silent ? '<progress value="' + Number(j.completedSegments || 0) + '" max="' + Math.max(1, Number(j.totalSegments || 0)) + '" aria-label="' + esc(j.title) + ' 画面完成数"></progress>' : '') + (j.error ? '<p class="error">' + esc(j.error) + '</p>' : '') +
            (silent && j.state === 'completed' ? '<p class="meta">' + (state.fixture ? '离线结果展示，时长与音轨待实际文件验证' : (j.audioTrackCount === 0 ? '无声合成 · 0 音轨合同' : '音轨验证信息待确认') + (Number.isFinite(j.durationSeconds) ? ' · 成片 ' + secondsLabel(j.durationSeconds) + ' 秒' : '')) + '</p>' : '') +
            (video ? '<video controls preload="metadata" playsinline' + (silent ? ' muted' : '') + ' src="' + esc(video + (video.includes('?') ? '&' : '?') + 'inline=1') + '" aria-label="' + esc(j.title) + '成片预览"></video>' : '') + '<div class="downloads">' + (video ? '<a download href="' + esc(video) + '">下载视频</a>' : '') + (subtitles ? '<a download href="' + esc(subtitles) + '">下载字幕</a>' : '') + '</div><details><summary>制作版本' + (revision ? ' · 草稿 v' + revision : j.version ? ' · ' + esc(String(j.version).slice(0, 12)) : '') + '</summary><p class="meta">当前草稿修改不会替换本片。</p>' + (Array.isArray(original.segments) ? '<pre>' + esc(original.segments.map(s => s.text + (silent ? '（' + s.durationSeconds + ' 秒）' : '')).join('\n\n')) + '</pre>' : '<p class="meta">版本以服务端批次记录为准。</p>') + (j.source ? '<p class="meta">来源 ' + esc(j.source.article_id) + ' · 版本 ' + esc(j.source.version_id) + '</p>' : '') + Authoring.archive(j) + '</details></section>';
        }).join('') + '</article>';
    }).join('');
  }
  function mount(doc, options = {}) {
    const $ = selector => doc.querySelector(selector);
    let timer, polling = false, failures = 0, structure = '';
    let storage; try { storage = options.storage || globalThis.localStorage; } catch { storage = { getItem() { return null; }, setItem() { throw new Error('storage unavailable'); } }; }
    const params=new URLSearchParams(globalThis.location?.search||'');
    const initialSource={clientId:params.get('client_id')||params.get('clientId'),article_id:Number(params.get('article_id')),version_id:Number(params.get('version_id')),requested:params.has('article_id')||params.has('version_id')};
    const controller = createController({ ...options, initialSource:options.initialSource||initialSource, storage, blobStore: options.blobStore || createBlobStore(globalThis.indexedDB), makeObjectURL: options.makeObjectURL || (globalThis.URL?.createObjectURL ? blob => URL.createObjectURL(blob) : null), revokeObjectURL: options.revokeObjectURL || (url => globalThis.URL?.revokeObjectURL?.(url)), onChange: render });
    function render() {
      const { state } = controller, current = controller.job(), limits = configDetails(state.config);
      $('#notice').textContent = state.message || (state.storageError ? '浏览器无法保存草稿，请保留本页并另行备份文字。' : ''); $('#notice').dataset.error = String(state.error || state.storageError); $('#fixture-banner').hidden = !state.fixture;
      const clients = '<option value="">选择客户</option>' + state.clients.map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join(''); if ($('#client').innerHTML !== clients) $('#client').innerHTML = clients;
      $('#client').value = state.clientId; $('#client').disabled = state.busy; $('#job-count').textContent = (state.draft?.jobs.length || 0) + ' / 30';
      $('#jobs').innerHTML = (state.draft?.jobs || []).map(j => { const total = duration(j); return '<button class="job-tab" data-action="select-job" data-job="' + esc(j.id) + '" aria-current="' + (j.id === current?.id ? 'page' : 'false') + '">' + esc(j.title) + '<span class="meta">' + j.segments.length + ' 幅 · ' + (total.valid ? secondsLabel(total.seconds) + ' 秒' : '时长待填写') + '</span></button>'; }).join('');
      $('#add-job').disabled = !state.clientId || state.busy || state.draft.jobs.length >= 30; $('#start-batch').disabled = !state.clientId || state.busy || state.generating || !limits.ready || !state.draft.jobs.length;
      $('#refresh-history').disabled = !state.clientId || state.busy; $('#reload-config').disabled = state.busy;
      $('#archived-works').disabled = !state.clientId || state.busy || state.generating;
      $('#archived-works').setAttribute('aria-pressed',String(state.archived));
      $('#archived-works').textContent=state.archived?'返回制作列表':'已归档作品';
      $('#renderer-info').textContent = state.config ? limits.ready ? '本地合成已就绪 · 25 帧/秒' : limits.reason || '本地图文视频引擎尚未就绪，请检查本机环境后重新读取。' : '正在读取本地合成配置…';
      const totals = (state.draft?.jobs || []).map(duration); $('#batch-duration').textContent = totals.length ? totals.every(t => t.valid) ? '本批预计总时长 ' + secondsLabel(totals.reduce((sum, t) => sum + t.seconds, 0)) + ' 秒' : '请填写有效的停留时长' : '';
      const nextStructure = current ? state.clientId + ':' + current.id + ':' + current.segments.map(s => s.id).join(',') + ':' + state.draft.assets.map(a => a.id).join(',') + ':' + (state.context?.client?.id||'') + ':' + state.removed + ':' + state.removedAssets.map(a=>a.id).join(',') : state.clientId;
      if (structure !== nextStructure) { $('#editor').innerHTML = editorMarkup(controller); structure = nextStructure; }
      // Preserve editable nodes and their caret during status updates.
      const preview = $('#composition-preview'); if (preview) { const html = previewMarkup(controller); if (preview.innerHTML !== html) preview.innerHTML = html; }
      const geoBody=$('#geo-body');if(geoBody&&current&&doc.activeElement!==geoBody&&geoBody.value!==current.originalText)geoBody.value=current.originalText;
      const geoSummary=$('#geo-summary');if(geoSummary&&current)geoSummary.textContent=Content.count(current.originalText)+'字（去空白，含标点，不含标题） · '+current.segments.length+'屏'+(current.bodyNeedsPagination?' · 待按全文重新分屏':' · 预计'+secondsLabel(duration(current).seconds)+'秒');
      if(current&&$('#target-warning')){const assessment=Content.assessment(current.originalText,current.segments,Content.targets(current.targetPreset));$('#target-warning').hidden=assessment.met||current.bodyNeedsPagination;$('#target-message').textContent=assessment.reasons.join('；');$('#target-ack').checked=current.targetAcknowledged===true;const notes=Content.relations(current.originalText,state.context);$('#content-notes').hidden=!notes.length;$('#content-notes').innerHTML=notes.map(n=>'<p>'+esc(n)+'</p>').join('');}
      const save = $('#editor .save-state'); if (save) save.textContent = state.storageError ? '草稿未保存' : '草稿 v' + current.revision;
      const total = current && duration(current); if ($('#job-duration')) $('#job-duration').textContent = current.bodyNeedsPagination ? '正文或布局已修改，重新分屏后显示预计时长' : total.valid ? current.segments.length + ' 幅画面 · 预计 ' + secondsLabel(total.seconds) + ' 秒' : '每幅停留时间请填写 1–60 秒';
      $('#editor').querySelectorAll('button,input,select,textarea').forEach(el => { const action = el.dataset.action, index = current?.segments.findIndex(s => s.id === el.dataset.segment); el.disabled = state.busy || state.generating || action === 'move-up' && index === 0 || action === 'move-down' && index === current?.segments.length - 1; });
      for (const s of current?.segments || []) {
        for(const [field,value] of [['media',s.media],['text',s.text],['durationSeconds',s.durationSeconds]]){const input=doc.querySelector('[data-segment="'+s.id+'"][data-segment-field="'+field+'"]');if(input&&doc.activeElement!==input&&input.value!==String(value))input.value=String(value);}
        const message = doc.querySelector('[data-layout-for="' + s.id + '"]'); if (message) { const issue = textLayout(s.text, current).issue; message.textContent = issue || '最多两行展示文字，长句可拆成更多画面。'; message.classList.toggle('error', Boolean(issue)); }
      }
      $('#history-note').textContent = state.clientId ? state.archived ? state.batches.length?'可下载原成片，或恢复到制作列表。':'暂无归档作品。' : state.batches.length ? '保存提交版本，完成后可预览和下载。' : '当前客户暂无制作记录。' : '选择客户后读取已保存的任务。';
      const batches = batchesMarkup(state); if ($('#batches').innerHTML !== batches) $('#batches').innerHTML = batches; schedule();
    }
    function schedule() {
      if (timer || polling || failures >= 3 || doc.hidden || controller.state.archived || !controller.state.batches.some(b => b.mode === 'silent' && ACTIVE.has(b.state))) return;
      timer = setTimeout(async () => { timer = null; polling = true;
        try { for (const batch of [...controller.state.batches]) if (batch.mode === 'silent' && ACTIVE.has(batch.state)) await controller.refreshBatch(batch.id); failures = 0; }
        catch (error) { failures++; controller.notify(error.message + (failures >= 3 ? ' 自动更新已暂停，请手动刷新。' : ''), true); }
        finally { polling = false; schedule(); }
      }, 5000);
    }
    async function run(action) { try { await action(); } catch (error) { controller.notify(error.message, true); } }
    doc.addEventListener('input', event => { const el = event.target; if (el.tagName === 'SELECT') return; if (el.dataset.jobField) controller.editJob(el.dataset.jobField, el.value); else if (el.dataset.segmentField) controller.editSegment(el.dataset.segment, el.dataset.segmentField, el.value); else return; render(); });
    doc.addEventListener('change', event => run(async () => {
      const el = event.target;
      if (el.id === 'client') { structure = ''; failures = 0; await controller.switchClient(el.value); }
      else if (el.id === 'media-files') { await controller.upload([...el.files], $('#arrangement').value); el.value = ''; }
      else if (el.tagName === 'SELECT' && el.dataset.jobField) { controller.editJob(el.dataset.jobField, el.value); render(); }
      else if (el.tagName === 'SELECT' && el.dataset.segmentField) { controller.editSegment(el.dataset.segment, el.dataset.segmentField, el.value); render(); }
      else if (el.id === 'target-ack') {controller.editJob('targetAcknowledged',el.checked);render();}
      else if (el.dataset.asset) controller.selectAsset(el.dataset.asset, el.checked);
    }));
    doc.addEventListener('click', event => { const el = event.target.closest('button'); if (!el || el.disabled) return; run(async () => {
      if (el.id === 'add-job') controller.addJob();
      else if (el.id === 'reload-config') await controller.loadConfig(true);
      else if (el.id === 'refresh-history') { failures = 0; await controller.loadHistory(); }
      else if (el.id === 'archived-works') await controller.toggleArchive();
      else if (el.id === 'start-batch') await controller.submit();
      else { const action = el.dataset.action;
        if (action === 'select-job') controller.selectJob(el.dataset.job);
        if (action === 'remove-job') controller.removeJob();
        if (action === 'add-segment') controller.addSegment();
        if (action === 'remove-segment') controller.removeSegment(el.dataset.segment);
        if (action === 'move-up' || action === 'move-down') controller.moveSegment(el.dataset.segment, action === 'move-up' ? -1 : 1);
        if (action === 'view-segment') controller.selectSegment(el.dataset.segment);
        if (action === 'use-selected') controller.useSelected();
        if (action === 'toggle-removed') await controller.toggleRemoved();
        if (action === 'asset-lifecycle') await controller.setAssetRemoved(el.dataset.id);
        if (action === 'archive-job') await controller.archiveJob(el.dataset.batch,el.dataset.id);
        if (action === 'import-article') await controller.importArticle();
        if (action === 'import-text') await controller.importText();
        if (action === 'relayout-geo') await controller.relayoutGeo();
        if (action === 'fill-screens') controller.fillScreens();
        if (action === 'stop' || action === 'retry') await controller.batchAction(el.dataset.batch, action);
      }
    }); });
    doc.addEventListener('visibilitychange', () => { if (doc.hidden) { clearTimeout(timer); timer = null; } else schedule(); });
    render(); const ready = controller.initialize().catch(error=>controller.notify(error.message,true));
    return { controller, render, ready, destroy() { clearTimeout(timer); failures = 3; controller.destroy(); } };
  }
  return { createController, createBlobStore, configDetails, duration, textLayout, safeFileUrl, previewMarkup, editorMarkup, batchesMarkup, mount, ACTIVE };
});
