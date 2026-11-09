import { clone, enabled, escapeHTML as e, selectionCounts, setCount } from './model.mjs';

const planKeys = ['keywords','keyword_links','selections','format_overrides','note','rivals','aliases','models'];
export const planOptions = options => Object.fromEntries(planKeys.filter(k => options?.[k] !== undefined).map(k => [k, clone(options[k])]));

export function platformFields(platforms, options, draft) {
  const rows = [], choices = [];
  for (const platform of platforms.filter(enabled)) {
    const {id,name,formats,account_type} = platform;
    const counts = selectionCounts(options,id);
    const fields = ['official','personal'].map(type => {
      const label = type === 'official' ? '官方号' : '个人号';
      const value = draft?.counts[id + ':' + type] ?? counts[type];
      return `<label class="platform-amount">${label}<input type="number" min="0" max="20" step="1" value="${e(value)}" data-plan-platform="${e(id)}" data-plan-account="${type}" aria-label="${e(name)}${label}篇数"></label>`;
    }).join('');
    const selectedFormats = draft?.formats[id] ?? options.format_overrides?.[id] ?? formats;
    const picks = formats.map(fmt => `<label><input type="checkbox" data-plan-format="${e(id)}" value="${e(fmt)}" ${selectedFormats.includes(fmt) ? 'checked' : ''}>${e(fmt === '短视频' ? '短视频文案' : fmt)}</label>`).join('');
    const row = `<div class="task-platform-fields">${fields}<div class="format-picks">${picks}</div></div>`;
    const selected = ['official','personal'].some(type => Number(draft?.counts[id + ':' + type] ?? counts[type]) !== 0);
    rows.push(`<section class="task-platform-row" data-plan-platform-row="${e(id)}" aria-label="${e(name)}" ${selected?'':'hidden'}><h3>${e(name)}</h3>${row}</section>`);
    if (!selected) {
      const account = account_type === 'official' ? 'official' : 'personal';
      choices.push(`<button type="button" class="button outline" data-customer-action="add-plan-platform" data-id="${e(id)}" data-account="${account}" aria-label="添加 ${e(name)}"><span aria-hidden="true">＋</span>${e(name)}</button>`);
    }
  }
  const add = choices.length ? `<div class="plan-add-platforms">
    <h3>添加平台</h3><div class="inline-actions">${choices.join('')}</div>
  </div>` : '';
  return rows.length ? `<div class="task-platforms">${add}${rows.join('')}</div>` : '<p class="empty">暂无已启用的发布平台。</p>';
}
export function collectPlatforms(platforms, root, options = {}) {
  let result = { ...clone(options), selections:[], format_overrides:{} };
  for (const input of root.querySelectorAll('[data-plan-platform]')) result = setCount(result, input.dataset.planPlatform.match(/^\d+$/) ? Number(input.dataset.planPlatform) : input.dataset.planPlatform, input.dataset.planAccount, input.value);
  for (const p of platforms.filter(enabled)) {
    const formats = [...root.querySelectorAll('[data-plan-format]')].filter(input => String(p.id) === input.dataset.planFormat && input.checked).map(input => input.value);
    if (result.selections.some(s => String(s.platform_id) === String(p.id)) && !formats.length) throw new Error(`${p.name}至少选择一种发布形态`);
    if (formats.length) result.format_overrides[p.id] = formats;
  }
  return result;
}
