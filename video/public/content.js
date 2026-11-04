(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FangliVideoContent=api;})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const canon=value=>String(value||'').replace(/\s/gu,'');
  const count=value=>Array.from(canon(value)).length;
  const presets={short:{label:'短稿目标 · 150—250字 / 45—75秒',minCharacters:150,maxCharacters:250,minDurationSeconds:45,maxDurationSeconds:75},free:{label:'按完整稿制作',minCharacters:0,maxCharacters:60000,minDurationSeconds:0,maxDurationSeconds:600}};
  const clean=value=>String(value||'').replace(/\*\*/g,'').replace(/`([^`]+)`/g,'$1').trim();
  function partition(markdown){
    if(typeof markdown!=='string')throw new Error('请提供稿件正文');
    const rows=[];
    for(const raw of markdown.replace(/\r\n?/g,'\n').split('\n')){
      const line=raw.trim();if(!line)continue;
      let kind='display_text';
      if(/^#\s/.test(line))kind='title';
      else if(/^#{2,6}\s/.test(line))kind='timeline_or_heading';
      else if(/^声明[:：]/.test(line))kind='publication_declaration';
      else if(/^#[^\s#]/.test(line))kind='publication_tags';
      else if(/^(?:[-*]\s*)?(?:画面|字幕(?:提示)?|口播提示|镜头|分镜|配乐|音效)[:：]/.test(line))kind='visual_instruction';
      rows.push({kind,raw,text:kind==='display_text'?clean(line.replace(/^[-*]\s+/,'')):line});
    }
    const displayBody=rows.filter(r=>r.kind==='display_text').map(r=>r.text).join('\n');
    return {originalMarkdown:markdown,rows,displayBody,displayCharacters:count(displayBody),allNonblankLinesClassified:rows.length===markdown.split(/\r\n?|\n/).filter(s=>s.trim()).length,
      policy:'summary + all section narration + rendered key facts; title, headings, storyboard, tags and declarations are separately retained'};
  }
  function targets(key){return {...(presets[key]||presets.short)};}
  function assessment(body,segments,target){
    const desired=target||targets('short'),characters=count(body),durationSeconds=(segments||[]).reduce((n,s)=>n+Number(s.durationSeconds||0),0),reasons=[];
    if(characters<desired.minCharacters||characters>desired.maxCharacters)reasons.push('正文'+characters+'字，未满足'+desired.minCharacters+'—'+desired.maxCharacters+'字目标');
    if(durationSeconds<desired.minDurationSeconds||durationSeconds>desired.maxDurationSeconds)reasons.push('当前稿预计'+Number(durationSeconds.toFixed(2))+'秒，未满足'+desired.minDurationSeconds+'—'+desired.maxDurationSeconds+'秒目标');
    return {characters,durationSeconds,target:desired,met:reasons.length===0,reasons};
  }
  function relations(body,context){
    const profile=context?.client?.profile||{},names=[context?.client?.name,profile.brand,profile.company].filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim());
    const notes=[];
    if(names.length&&!names.some(n=>canon(body).includes(canon(n))))notes.push('本稿尚未体现所选客户/品牌关系。可在“完整展示正文”中编辑；普通建议也可继续使用。');
    if(/(?:西邦\s*24|Cilbond\s*24)/i.test(body)&&/工件转运|两次施涂|两次干燥/.test(body))notes.push('工艺复核：确认“少一次工件转运”是否适用于实际工位安排；“两次施涂、两次干燥”描述的是底涂与面涂环节，不能误解为施工遍数。');
    return notes;
  }
  return {canon,count,partition,presets,targets,assessment,relations};
});
