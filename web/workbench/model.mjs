export const DEFAULT_MODEL = 'deepseek-v4.1-flash';
// HTTP action paths and persisted operation kinds are separate contracts.
export const OPERATION_KIND = Object.freeze({ chat:'interview', review:'style_review', rewrite:'style_rewrite', revise:'revision', writing:'writing', regenerate:'zip_regenerate', audit:'zip_audit' });
export function latestOperation(operations, kind, articleId) {
  return operations.filter(op=>op.kind===kind&&op.status==='done'&&op.result&&(articleId==null||String(op.article_id)===String(articleId)))
    .sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))[0] || null;
}
export function reviewDefaults(review) {
  return { selected:(review.recommended||[]).map(String), mode:['full','standard','light'].includes(review.default_mode)?review.default_mode:'full' };
}
export function interviewMessageText(message) {
  const content=message.content??message.text;
  return message.role==='assistant'&&content&&typeof content==='object' ? content.understanding||'' : valueText(content);
}
export const PROFILE_FIELDS = [
  ['name', '客户 / 项目名称'], ['industry', '行业'], ['brand', '品牌'], ['company', '公司'],
  ['products', '产品或服务'], ['website', '官网'], ['phone', '电话'], ['address', '地址'],
];
export const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
export const enabled = item => item.enabled !== false && item.enabled !== 0;
export const running = item => ['running', 'queued', 'pending', 'stopping'].includes(item?.status);
export const accountName = type => type === 'official' ? '官方号' : '个人号';
export const splitWords = value => [...new Set(String(value).split(/[\n,，、;；]+/).map(s => s.trim()).filter(Boolean))];

export function normalizeOptions(value = {}, targets = []) {
  // Preserve every server-owned/unknown option. Defaults apply only to absent fields.
  return { keywords: [], selections: [], models: targets.filter(enabled).map(t => typeof t === 'string' ? t : t.name),
    rivals: [], aliases: [], note: '', format_overrides: {}, ...clone(value) };
}

export function selectionCounts(options, platformId) {
  return (options.selections || []).filter(s => String(s.platform_id) === String(platformId))
    .reduce((out, s) => ({ ...out, [s.account_type]: Number(s.count) || 0 }), { official: 0, personal: 0 });
}

export function setCount(options, platformId, accountType, raw) {
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 0 || count > 20) throw new Error('每种账号的篇数须为 0—20 的整数');
  const selections = (options.selections || []).filter(s => !(String(s.platform_id) === String(platformId) && s.account_type === accountType));
  if (count) selections.push({ platform_id: platformId, account_type: accountType, count });
  return { ...options, selections };
}

export function togglePlatform(options, platform, checked) {
  const selections = (options.selections || []).filter(s => String(s.platform_id) !== String(platform.id));
  if (checked) selections.push({ platform_id: platform.id, account_type: platform.account_type === 'official' ? 'official' : 'personal', count: 1 });
  return { ...options, selections };
}

export function planSummary(options, platforms = []) {
  const selections = options.selections || [];
  const count = selections.reduce((sum, s) => sum + (Number(s.count) || 0), 0);
  const ids = [...new Set(selections.filter(s => s.count > 0).map(s => String(s.platform_id)))];
  const labels = ids.map(id => {
    const p = platforms.find(p => String(p.id) === id);
    const c = selectionCounts(options, id);
    return `${p?.name || '平台 ' + id} ${c.official ? `官方${c.official}` : ''}${c.official && c.personal ? ' / ' : ''}${c.personal ? `个人${c.personal}` : ''}`;
  });
  return { count, platforms: ids.length, labels, text: labels.join(' · ') || '选择平台与篇数' };
}

export function validateStart(options, platforms, targets) {
  const errors = optionIssues(options,platforms,targets);
  if (!(options.keywords || []).some(k => String(k).trim())) errors.push('请添加至少一个目标关键词');
  if (!planSummary(options, platforms).count) errors.push('请给至少一个平台安排一篇稿件');
  for (const s of options.selections || []) {
    if (!['official', 'personal'].includes(s.account_type) || !Number.isInteger(s.count) || s.count < 1 || s.count > 20) errors.push('账号篇数配置无效');
  }
  if (!options.models?.length) errors.push('请选择希望被谁搜到的目标 AI');
  return [...new Set(errors)];
}
export function optionIssues(options,platforms,targets) {
  const errors=[],allowed=new Map(platforms.filter(enabled).map(p=>[String(p.id),p]));
  for(const selection of options.selections||[])if(!allowed.has(String(selection.platform_id)))errors.push(`平台 ${platforms.find(p=>String(p.id)===String(selection.platform_id))?.name||selection.platform_id} 已失效，请调整安排`);
  const known=new Set(targets.filter(enabled).map(t=>typeof t==='string'?t:t.name));
  for(const name of options.models||[])if(!known.has(name))errors.push(`目标 AI ${name} 已失效，请移除或重新选择`);
  for(const [id,formats] of Object.entries(options.format_overrides||{})) {
    const platform=allowed.get(id);
    if(!platform||!Array.isArray(formats)||!formats.length||formats.some(fmt=>!platform.formats.includes(fmt)))errors.push(`${platform?.name||'平台 '+id} 的发布形态已失效，请重新选择`);
  }
  return [...new Set(errors)];
}

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function markdown(value) {
  const inline = text => escapeHTML(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
  let out = [], paragraph = [], list = null, code = null;
  const flush = () => { if (paragraph.length) { out.push(`<p>${inline(paragraph.join(' '))}</p>`); paragraph = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of String(value || '').split(/\r?\n/)) {
    if (line.startsWith('```')) { flush(); closeList(); if (code) { out.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`); code = null; } else code = []; continue; }
    if (code) { code.push(line); continue; }
    if (!line.trim()) { flush(); closeList(); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { flush(); closeList(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
    const item = /^\s*(?:([-*+])|\d+\.)\s+(.+)$/.exec(line);
    if (item) { flush(); const kind = item[1] ? 'ul' : 'ol'; if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline(item[2])}</li>`); continue; }
    if (/^>\s?/.test(line)) { flush(); closeList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    if (/^---+$/.test(line.trim())) { flush(); closeList(); out.push('<hr>'); continue; }
    closeList(); paragraph.push(line);
  }
  flush(); closeList(); if (code) out.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`);
  return out.join('\n');
}

export function articleBody(article) { return article?.body_md ?? article?.body ?? article?.content_md ?? ''; }
export function valueText(value) { return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2); }
// Original ZIP `render.geo_check` output: {checks:[{name,ok,hint}],score,chars}. Read-only view of saved data.
export function selfCheck(article) {
  const geo = article?.geo || {};
  const checks = (Array.isArray(geo.checks) ? geo.checks : [])
    .filter(item => item && typeof item === 'object')
    .map(item => ({name: String(item.name ?? ''), ok: Boolean(item.ok), hint: String(item.hint ?? '')}));
  const raw = Number(geo.score);
  const score = Number.isFinite(raw) ? Math.round(raw) : null;
  const failed = checks.filter(item => !item.ok);
  return {score, chars: Number(geo.chars) || 0, checks, failed,
    total: checks.length, rated: score !== null || checks.length > 0,
    tone: score === null ? 'none' : score >= 88 ? 'good' : score >= 70 ? 'mid' : 'bad'};
}

export function streamReducer(previous = {}, event) {
  if (event.type === 'next') return { ...event, text: '', status: 'running', phase: '', message: '正在写作' };
  if (event.type === 'chunk') return { ...previous, text: (previous.text || '') + (event.text || ''), chars: event.chars };
  if (event.type === 'status') return { ...previous, ...event, type: previous.type };
  if (event.type === 'end') return { ...previous, ...event, finished: true };
  return previous;
}
