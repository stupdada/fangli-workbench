import { workspaceRail, workbenchReturnPath } from './workspace-rail.mjs';
import { applyWorkbenchPalette } from './palette.mjs';

applyWorkbenchPalette();

const initial = new URLSearchParams(location.search);
const returnPath = workbenchReturnPath(initial.get('return_to')) || '/workbench/zip/index.html';
const area = new URL(returnPath,location.origin).searchParams.get('area');
const returnArea = ['quick','customers'].includes(area) ? area : 'standard';
document.querySelector('#video-navigation').innerHTML = workspaceRail('video',{
  links:{[returnArea]:returnPath,video:location.pathname + location.search},
});
document.querySelector('[data-video-return]').href = returnPath;

const client = document.querySelector('#client, #short-client');
const modeLinks = document.querySelectorAll('[data-video-mode]');
function updateModeLinks() {
  const id = client.options.length > 1 ? client.value : initial.get('client_id') || initial.get('clientId');
  for (const link of modeLinks) {
    const params = new URLSearchParams({return_to:returnPath});
    if (id) params.set('client_id',id);
    link.href = link.dataset.videoMode + '?' + params;
  }
}
updateModeLinks();
client.addEventListener('change',updateModeLinks);
for (const link of modeLinks) {
  for (const event of ['focus','click','auxclick','contextmenu']) link.addEventListener(event,updateModeLinks);
}
