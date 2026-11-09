export const railIcons = {
  home: '<path d="M3.3 10.4 10.6 4a2.1 2.1 0 0 1 2.8 0l7.3 6.4a.8.8 0 0 1-.5 1.4H19v6.7a2 2 0 0 1-2 2h-2.5v-4.6a1.4 1.4 0 0 0-1.4-1.4h-2.2a1.4 1.4 0 0 0-1.4 1.4v4.6H7a2 2 0 0 1-2-2v-6.7H3.8a.8.8 0 0 1-.5-1.4Z"/>',
  edit: '<path d="m5.4 15.9 11-11a2.5 2.5 0 0 1 3.54 0l.16.16a2.5 2.5 0 0 1 0 3.54l-11 11-4.2 1.02a.85.85 0 0 1-1.02-1.02l1.52-3.7Z"/><path d="m14.6 6.7 3.7 3.7"/>',
  library: '<path d="m9.4 7.6.6-2.2a2.2 2.2 0 0 1 2.7-1.55l6.1 1.65a2.2 2.2 0 0 1 1.55 2.7l-2.1 7.85a2.2 2.2 0 0 1-1.5 1.55"/><path d="M3.2 10a2.4 2.4 0 0 1 2.4-2.4h3.2c.6 0 1.2.26 1.6.7l1.15 1.2h2.7a2.4 2.4 0 0 1 2.4 2.4v6.2a2.4 2.4 0 0 1-2.4 2.4H5.6a2.4 2.4 0 0 1-2.4-2.4Z"/>',
  video: '<rect x="3" y="5.6" width="12.8" height="12.8" rx="3.2"/><path d="m15.8 10 3.6-2.1a1.05 1.05 0 0 1 1.6.9v6.4a1.05 1.05 0 0 1-1.6.9L15.8 14"/>',
  geo: '<circle cx="10.6" cy="10.6" r="6.8"/><path d="m15.4 15.4 4.7 4.7M7.4 12.1l2-2.1a.7.7 0 0 1 1 0l1 1a.7.7 0 0 0 1 0l1.5-1.7"/>',
  lab: '<rect x="3.2" y="4.5" width="7.2" height="15" rx="1.8"/><rect x="13.6" y="4.5" width="7.2" height="15" rx="1.8"/><path d="m15.6 12.2 1.3 1.3 2.2-2.7"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6"/>',
  guide: '<path d="M12 6.1C9.9 4.7 7.4 4.3 5 4.8a1.9 1.9 0 0 0-1.5 1.9v10.4a1.5 1.5 0 0 0 1.8 1.5c2.4-.4 4.7.1 6.7 1.6 2-1.5 4.3-2 6.7-1.6a1.5 1.5 0 0 0 1.8-1.5V6.7A1.9 1.9 0 0 0 19 4.8c-2.4-.5-4.9-.1-7 1.3Zm0 0v14.1"/><path d="M6.8 9.1c.8 0 1.6.15 2.3.44m5.8 0c.7-.3 1.5-.44 2.3-.44"/>',
  settings: '<path d="M3.8 7.5h3.7m4.6 0h8.1M3.8 16.5h8.1m4.6 0h3.7"/><circle cx="9.8" cy="7.5" r="2.3"/><circle cx="14.2" cy="16.5" r="2.3"/>',
};

const areas = [
  ['standard', '标准创作', 'home'],
  ['quick', '快速创作', 'edit'],
  ['customers', '客户', 'library'],
  ['video', '视频', 'video'],
  ['geo', 'GEO 检测', 'geo'],
  ['writing-lab', '文案训练台', 'lab'],
];
const tools = [['guide', '使用指南', 'guide'], ['settings', '设置', 'settings']];
export const shortVideoPath = '/video/narrated/';
export const geoPath = '/workbench/geo/';
export const guidePath = '/guide/index.html';
const workbenchPaths = new Set(['/workbench/zip/index.html','/workbench/index.html','/workbench/classic/index.html']);
export function workbenchReturnPath(value) {
  return workbenchPaths.has(value?.split(/[?#]/,1)[0]) ? value : null;
}
const defaults = {
  standard: '/workbench/zip/index.html',
  quick: '/workbench/zip/index.html?area=quick',
  customers: '/workbench/zip/index.html?area=customers',
  video: shortVideoPath,
  geo: geoPath,
  'writing-lab': '/workbench/writing-lab/',
  guide: guidePath,
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
