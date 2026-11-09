export const railIcons = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  edit: '<path d="m16 3 5 5M4 20l4-1L21 6a2 2 0 0 0-5-3L3 16l-1 6z"/>',
  library: '<path d="M4 4h16v16H4zM4 9h16M9 9v11M7 6.5h.1M10 6.5h.1"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  geo: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4M8 12l1.5-2 1.5 1.5L13 9"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6"/>',
  settings: '<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
};

const areas = [
  ['standard', '标准创作', 'home'],
  ['quick', '快速创作', 'edit'],
  ['customers', '客户', 'library'],
  ['video', '视频', 'video'],
  ['geo', 'GEO 检测', 'geo'],
];
const tools = [['guide', '使用指南', 'file'], ['settings', '设置', 'settings']];
export const shortVideoPath = '/video/narrated/';
const defaults = {
  standard: '/workbench/zip/index.html',
  quick: '/workbench/zip/index.html?area=quick',
  customers: '/workbench/zip/index.html?area=customers',
  video: shortVideoPath,
  geo: '/workbench/geo/',
  guide: '/guide/index.html',
  settings: '/workbench/zip/index.html?entry=settings',
};

export function workspaceRail(active, {actions = [], links = {}} = {}) {
  const item = ([name,label,icon]) => {
    const attrs = `class="rail-button" aria-label="${label}" data-rail-label="${label}" data-rail-area="${name}" ${active === name ? 'aria-current="page"' : ''}`;
    const svg = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${railIcons[icon]}</svg>`;
    if (actions.includes(name)) return `<button type="button" ${attrs} data-action="${name}">${svg}</button>`;
    const href = (links[name] || defaults[name]).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    return `<a ${attrs} href="${href}">${svg}</a>`;
  };
  return `<div class="workbench-rail"><nav class="rail-areas" aria-label="工作区">${areas.map(item).join('')}</nav><div class="rail-tools">${tools.map(item).join('')}</div></div>`;
}
