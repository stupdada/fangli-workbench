const minimumSize = 14;
const maximumSize = 24;
const defaultSize = 17;

export function fontSizeControl(kind, ui) {
  const label = kind === 'editor' ? '编辑字号' : '阅读字号';
  const key = kind === 'editor' ? 'editorFontSize' : 'readingFontSize';
  const size = ui[key] ?? '';
  const options = Array.from({length: maximumSize - minimumSize + 1}, (_, i) => {
    const value = minimumSize + i;
    return `<option value="${value}" ${size === value ? 'selected' : ''}>${value} px</option>`;
  }).join('');
  return `<label class="reading-font-control">字号 <select aria-label="${label}" data-font-size="${kind}"><option value="" ${size === '' ? 'selected' : ''}>默认 · ${defaultSize}</option>${options}</select></label>`;
}

export function applyFontSizes(ui) {
  for (const [kind, size] of [['reading', ui.readingFontSize], ['editor', ui.editorFontSize]]) {
    const property = `--${kind}-font-size`;
    if (Number.isInteger(size) && size >= minimumSize && size <= maximumSize) {
      document.documentElement.style.setProperty(property, `${size}px`);
    } else document.documentElement.style.removeProperty(property);
  }
}

export function changeFontSize(control, client) {
  const kind = control.dataset.fontSize;
  const key = kind === 'editor' ? 'editorFontSize' : 'readingFontSize';
  const size = Number(control.value);
  if (Number.isInteger(size) && size >= minimumSize && size <= maximumSize) client.state.ui[key] = size;
  else delete client.state.ui[key];
  applyFontSizes(client.state.ui);
  client.persist();
  for (const select of document.querySelectorAll('select[data-font-size]')) {
    if (select.dataset.fontSize === kind) select.value = client.state.ui[key] ?? '';
  }
}

const programmatic = new WeakMap();
export function restoreReadingScroll(node, top) {
  if (node.scrollTop === top) return;
  node.scrollTop = top;
  programmatic.set(node, node.scrollTop);
}

export function installReadingLayout(root) {
  let scope, workspace, scroller, lastTop = 0, travel = 0;
  function setCompact(compact) {
    workspace.toggleAttribute('data-reading-compact', compact);
    const toggle = workspace.querySelector('[data-expand-reading]');
    if (!compact && toggle?.contains(document.activeElement)) {
      const focus = workspace.querySelector('.stepper [aria-current="step"], .live-toolbar select');
      (focus || scroller).focus({preventScroll:true});
    }
    lastTop = scroller.scrollTop;
    travel = 0;
  }
  root.addEventListener('scroll', event => {
    if (event.target !== scroller) return;
    const top = Math.max(0, scroller.scrollTop);
    const expected = programmatic.get(scroller);
    programmatic.delete(scroller);
    const delta = top - lastTop;
    lastTop = top;
    if (top === expected || !delta) return;
    travel = Math.sign(travel) === Math.sign(delta) ? travel + delta : delta;
    const compact = workspace.hasAttribute('data-reading-compact');
    if (compact && (top <= 4 || travel <= -22)) setCompact(false);
    if (!compact && top > 48 && travel >= 48 && !workspace.querySelector('.stepper:focus-within')) {
      setCompact(true);
    }
  }, {capture:true, passive:true});
  root.addEventListener('click', event => {
    if (scroller && event.target.closest('[data-expand-reading]')) setCompact(false);
  });
  return (nextWorkspace, articleId) => {
    const view = nextWorkspace.dataset.workspaceView;
    const live = nextWorkspace.querySelector('.live-workspace') && !nextWorkspace.querySelector('.draft-pane[hidden]');
    const next = live ? nextWorkspace.querySelector('#stream-scroll')
      : view === 'zip-4' ? nextWorkspace.querySelector('#article-scroll') : null;
    const nextScope = `${nextWorkspace.dataset.taskId}:${view}:${next?.id}:${next?.id === 'article-scroll' ? articleId : ''}`;
    if (next === scroller && scope === nextScope) return;
    workspace = nextWorkspace;
    scroller = next;
    scope = nextScope;
    workspace.removeAttribute('data-reading-compact');
    lastTop = scroller?.scrollTop ?? 0;
    travel = 0;
  };
}
