import { escapeHTML as e } from './model.mjs';

export function generationLengthField(options = {}) {
  return `<label class="field wide"><span>本次篇幅</span><input class="input" data-option="length_hint" value="${e(options.length_hint || '')}" placeholder="例如：正文600—800字"><small>本次明确要求优先；未填写时采用客户偏好或平台默认。</small></label>`;
}

export function generationContextMarkup(context) {
  const variants = context.style?.applied ? [context.style.applied] : Object.values(context.style?.variants || {});
  const measured = context.editorial?.length?.actual;
  return `<dl class="plain-dl"><div><dt>客户</dt><dd>${e(context.client?.name || '')}</dd></div><div><dt>资料版本</dt><dd>${(context.documents || []).map(d => `${e(d.filename)} · 修订 ${e(d.revision ?? '未记录')}`).join('<br>') || '未选资料'}</dd></div>${Number.isInteger(measured) ? `<div><dt>正文实测</dt><dd>${measured} 字</dd></div>` : ''}</dl>${variants.map(v => `<h3>${e(v.platform_name)} · ${e(v.fmt)}</h3><p>${e(v.length?.hint || '')} · ${{request:'本次要求',customer_preference:'客户偏好',platform_default:'平台默认'}[v.length?.source] || ''}</p><p>${(v.profiles || []).map(p => e(p.voice)).join('<br>') || '使用平台基础配置'}</p><small>风格版本 ${e(v.version || '未记录')} · ${e((v.profiles || []).map(p => p.id).join('、'))}</small>`).join('')}<h3>本次要求</h3><p>${e(context.request?.note || '未填写')}</p>`;
}
