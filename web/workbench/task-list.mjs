import { escapeHTML as e } from './model.mjs';

const paths = {
  pinned:'<path d="M9 3h6l-1 7 4 4H6l4-4-1-7m3 11v7"/>',
  archived:'<path d="M4 9v11h16V9M3 4h18v5H3zm6 9h6"/>',
};
const icon = field => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[field]}</svg>`;

export function recentTasks(tasks) {
  return tasks.filter(task => !task.archived_at && !task.deleted_at)
    .sort((a,b) => (b.pinned_at || '').localeCompare(a.pinned_at || ''));
}

export function taskDisplayTitle(task, {brief = task.brief, topic = '', customerName = ''} = {}) {
  const name = brief?.client?.trim() || customerName;
  const savedTitle = task.title?.trim();
  if (topic && name) return `${name} · ${topic}`;
  if (savedTitle && !/^(?:新建内容|未命名内容)(?: · 复用)*$/.test(savedTitle)) return savedTitle;
  const keyword = brief?.keywords?.[0]?.trim();
  return name ? `${name} · ${keyword || '创作草稿'}` : '创作草稿';
}

export function compactTaskTitle(title, customerName, brand) {
  const prefix = `${customerName} · `;
  if (!customerName || !title.startsWith(prefix)) return title;

  const shortBrand = brand?.trim();
  const companyStem = customerName.replace(/(?:股份有限公司|有限责任公司|有限公司)$/, '').trim();
  const name = shortBrand && shortBrand.length < customerName.length ? shortBrand : companyStem || customerName;
  const subject = title.slice(prefix.length);
  return `${name} · ${subject === '创作草稿' ? '草稿' : subject}`;
}

export function taskStateButton(task, field, compact = false) {
  const label = field === 'pinned' ? (task.pinned_at ? '取消置顶' : '置顶') : (task.archived_at ? '恢复任务' : '归档');
  return `<button type="button" class="${compact ? 'task-row-icon' : 'button quiet sm'}" data-task-state="${field}" data-task-id="${e(task.id)}"${compact ? ` aria-label="${label}" title="${label}"` : ''}>${compact ? icon(field) : label}</button>`;
}

export function recentTaskMarkup(task, active, title) {
  return `<div class="recent-task" data-recent-task="${e(task.id)}"><button type="button" class="task-row ${active ? 'active' : ''}" data-task="${e(task.id)}" aria-describedby="task-tooltip">${task.pinned_at ? icon('pinned') : ''}<span class="task-row-title">${e(title)}</span></button><div class="task-row-actions">${taskStateButton(task,'pinned',true)}${taskStateButton(task,'archived',true)}</div></div>`;
}

export function installTaskContext(getTasks, beforeOpen) {
  let menu;
  function close(restoreFocus = false) {
    if (!menu) return;
    const id = menu.dataset.row;
    menu.remove();
    menu = null;
    if (restoreFocus) document.querySelector(`#recent [data-task="${CSS.escape(id)}"]`)?.focus();
  }
  function open(event) {
    const row = event.target.closest('[data-recent-task]');
    const task = getTasks().find(value => value.id === row?.dataset.recentTask);
    if (!task) return;
    event.preventDefault();
    close();
    beforeOpen();
    menu = document.createElement('div');
    menu.className = 'task-context';
    menu.dataset.row = task.id;
    menu.setAttribute('role','group');
    menu.setAttribute('aria-label','任务快捷操作');
    menu.innerHTML = taskStateButton(task,'pinned') + taskStateButton(task,'archived');
    document.body.append(menu);
    const bounds = row.getBoundingClientRect();
    const pointer = event.type === 'contextmenu' && (event.clientX || event.clientY);
    menu.style.left = `${Math.max(8, Math.min(pointer ? event.clientX : bounds.right, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(pointer ? event.clientY : bounds.bottom, innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button').focus();
  }
  document.addEventListener('contextmenu',open);
  document.addEventListener('pointerdown',event=>{if(menu && !menu.contains(event.target))close();});
  document.addEventListener('keydown',event=>{
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') open(event);
    else if (event.key === 'Escape' && menu) { event.preventDefault(); close(true); }
  });
  return close;
}
