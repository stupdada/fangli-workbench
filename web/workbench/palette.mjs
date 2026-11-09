export const WORKBENCH_PALETTES = [
  { value: 'default', label: '默认' },
  { value: 'blue', label: '经典蓝' },
];

const STORAGE_KEY = 'fangli.workbench.palette';
const normalize = value => WORKBENCH_PALETTES.some(option => option.value === value) ? value : 'default';

export function applyWorkbenchPalette() {
  let stored;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* Use the default when browser storage is unavailable. */ }
  showPalette(normalize(stored));
}

export function currentWorkbenchPalette() {
  return document.documentElement.dataset.workbenchPalette || 'default';
}

function showPalette(value) {
  const { dataset } = document.documentElement;
  if (value === 'default') delete dataset.workbenchPalette;
  else dataset.workbenchPalette = value;
}

export function setWorkbenchPalette(value) {
  const palette = normalize(value);
  showPalette(palette);
  try { localStorage.setItem(STORAGE_KEY, palette); } catch { /* Keep the selection for this page. */ }
}
