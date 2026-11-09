import { classicEnabled, classicURL } from './classic-view.mjs';
import { applyWorkbenchPalette } from './palette.mjs';

const query = new URLSearchParams(location.search);
if (classicEnabled() && !['customers', 'quick'].includes(query.get('area')) && query.get('entry') !== 'settings') {
  location.replace(classicURL(query.get('conversation'), query));
} else {
  applyWorkbenchPalette();
  if (classicEnabled() && query.get('entry') === 'settings') {
    document.documentElement.dataset.classicSettings = '';
  }
  await import('./app.mjs');
  await import('./appearance.mjs');
}
