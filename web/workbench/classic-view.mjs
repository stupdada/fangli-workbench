export const CLASSIC_PATH = '/workbench/classic/index.html';
const key = 'fangli.workbench.classic-view';

export function classicEnabled() {
  try { return localStorage.getItem(key) === '1'; }
  catch { return false; }
}

export function setClassicEnabled(enabled) {
  if (enabled) localStorage.setItem(key, '1');
  else localStorage.removeItem(key);
}

export function classicURL(taskId, search = '') {
  const params = new URLSearchParams(search);
  if (taskId) params.set('conversation', taskId);
  params.delete('area');
  if (!['tasks', 'review', 'export'].includes(params.get('entry'))) params.delete('entry');
  return CLASSIC_PATH + (params.size ? '?' + params : '');
}
