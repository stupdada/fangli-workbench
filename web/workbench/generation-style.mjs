import { escapeHTML as e } from './model.mjs';

const levels = {high:'高',mid:'中',low:'低'};
const lengthSources = {request:'本次要求',customer_preference:'客户偏好',platform_default:'平台默认'};
const lengthStates = {below:'低于目标',above:'超过目标',within:'在目标内'};

export function articleWordCount(body) {
  const lines = body.trim().split(/\r\n?|\n/);
  if (/^#[ \t]+/.test(lines[0])) lines.shift();
  let count = 0;
  for (let line of lines) {
    line = line.trim();
    if (/^#[^#\s]+(?:\s+#[^#\s]+)*$|^声明\s*[:：]/u.test(line)) continue;
    if (/^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/u.test(line)) continue;
    line = line.replace(/^(?:#{1,6}\s+|[-*+]\s+|\p{Nd}+[.)]\s+|>\s*)+/u, '');
    line = line.replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/gu, '$1');
    if (line.startsWith('|') && line.endsWith('|')) {
      if (/^[|:\s-]+$/u.test(line)) continue;
      line = line.replaceAll('|', '');
    }
    line = line.replaceAll('**', '').replaceAll('__', '').replace(/(\*|_)([^*_]+)\1/gu, '$2');
    count += Array.from(line.replace(/[\s`]/gu, '')).length;
  }
  return count.toLocaleString() + ' 字';
}

export function generationLengthField(options = {}) {
  return `<label class="field wide"><span>本次篇幅</span><input class="input" data-option="length_hint" value="${e(options.length_hint || '')}" placeholder="例如：正文600—800字"><small>本次明确要求优先；未填写时采用客户偏好或平台默认。</small></label>`;
}

export function generationContextMarkup(context) {
  const applied = context.style?.applied;
  const variants = applied ? [applied] : Object.values(context.style?.variants || {});
  const length = context.editorial?.length || applied?.length;
  const words = [length?.hint && `目标 ${length.hint}`, Number.isInteger(length?.actual) && `实测 ${length.actual} 字`,
    lengthStates[length?.status], lengthSources[length?.source]].filter(Boolean).join(' · ');
  return `<dl class="plain-dl">
    <div><dt>客户</dt><dd>${e(context.client?.name || '')}</dd></div>
    <div><dt>资料版本</dt><dd>${(context.documents || []).map(d => `${e(d.filename)} · 修订 ${e(d.revision ?? '未记录')}`).join('<br>') || '未选资料'}</dd></div>
    ${words ? `<div><dt>正文篇幅</dt><dd>${e(words)}</dd></div>` : ''}
  </dl>` + variants.map(v => {
    const preference = v.retrieval_preference;
    const targets = preference?.targets.map(t => `${t.name} ${levels[t.level]}档`).join('、');
    const profiles = v.profiles || [];
    return `<h3>${e(v.platform_name)} · ${e(v.fmt)}</h3>
      ${!applied && v.length?.hint ? `<p>${e(v.length.hint)} · ${e(lengthSources[v.length.source] || '')}</p>` : ''}
      ${preference ? `<p>抓取偏好 · ${levels[preference.level]}档${targets ? `（${e(targets)}）` : ''}</p>` : ''}
      <p>${profiles.map(p => e([p.intent,p.voice].filter(Boolean).join(' '))).join('<br>') || '使用平台基础配置'}</p>
      <small>风格版本 ${e(v.version || '未记录')} · ${e(profiles.map(p => p.id).join('、'))}</small>`;
  }).join('') + `<h3>本次要求</h3><p>${e(context.request?.note || '未填写')}</p>`;
}
