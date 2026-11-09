// Presentation only: native input, click handlers and request timing stay with the workbench.
export function installAppearance(doc = document) {
  const root = doc.getElementById('root');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const activeAnimations = new Set();
  const presses = new Map();
  const buttonAnimations = new WeakMap();
  let viewAnimation = null;
  const groups = ['.mode-switch', '.article-tabs'];
  const scrollers = '.workspace,.chat-pane,.conversation-log,.article-scroll,.stream-scroll,.inspector-body,#settings-content';
  let previous = null;
  let disposed = false;

  function animate(node, frames, options, done = () => {}) {
    if (!node || reduce.matches || doc.hidden || doc.documentElement.hasAttribute('data-task-transition')) { done(); return null; }
    const animation = node.animate(frames, options);
    activeAnimations.add(animation);
    const finish = () => { activeAnimations.delete(animation); done(); };
    animation.finished.then(finish, finish);
    return animation;
  }
  function cancelButton(button) { buttonAnimations.get(button)?.cancel(); }
  function control(event) {
    const button = event.target.closest?.('button');
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' ? button : null;
  }
  function press(button) {
    if (reduce.matches || doc.hidden) return;
    const from = getComputedStyle(button).scale;
    cancelButton(button);
    const small = button.matches('.send-button,.icon-button,.composer-platform');
    const scale = small ? .94 : button.offsetWidth > 220 ? .99 : .97;
    const animation = animate(button, [{scale: from === 'none' ? '1' : from}, {scale}], {duration: 80, fill: 'forwards', easing: 'ease-out'});
    buttonAnimations.set(button, animation);
  }
  function release(button) {
    const from = button.isConnected ? getComputedStyle(button).scale : '1';
    cancelButton(button);
    if (!button.isConnected) return;
    const small = button.matches('.send-button,.icon-button,.composer-platform');
    const animation = animate(button, [
      {scale: from === 'none' ? '1' : from, offset: 0},
      {scale: small ? 1.035 : 1.015, offset: .45},
      {scale: .998, offset: .78},
      {scale: 1, offset: 1},
    ], {duration: 260, easing: 'ease-out'});
    buttonAnimations.set(button, animation);
  }
  function pointerDown(event) {
    if (event.button !== 0 || event.isPrimary === false) return;
    const button = control(event);
    if (button) { presses.set(event.pointerId, button); press(button); }
  }
  function pointerUp(event) {
    const button = presses.get(event.pointerId);
    presses.delete(event.pointerId);
    if (button) release(button);
  }
  function keyDown(event) {
    if (event.repeat || !['Enter', ' '].includes(event.key)) return;
    const button = control(event);
    if (button) { presses.set('keyboard', button); press(button); }
  }
  function keyUp(event) {
    if (!['Enter', ' '].includes(event.key)) return;
    const button = presses.get('keyboard');
    presses.delete('keyboard');
    if (button) release(button);
  }
  function syncScroll() {
    for (const el of root.querySelectorAll(scrollers)) el.classList.toggle('is-scrolled', el.scrollTop > 4);
    root.querySelector('.main')?.classList.toggle('has-content-scroll', !!root.querySelector('.workspace.is-scrolled,.chat-pane.is-scrolled,.conversation-log.is-scrolled,.article-scroll.is-scrolled,.stream-scroll.is-scrolled'));
  }
  function panelState(selector) {
    const node = root.querySelector(selector);
    if (!node) return null;
    return {node, rect: node.getBoundingClientRect(), title: node.querySelector('h2')?.textContent};
  }
  function syncIndicator(selector) {
    const group = root.querySelector(selector);
    const selected = group?.querySelector('.active');
    if (!selected) return null;
    const label = selector === '.mode-switch' ? selected : selected.querySelector('.mode-label') || selected;
    const x = selected.offsetLeft + (label === selected ? 0 : label.offsetLeft);
    const width = label.offsetWidth;
    const key = selected.id || selected.textContent;
    const before = previous?.indicators.get(selector);
    if (!group.style.getPropertyValue('--indicator-width')) {
      group.style.setProperty('--indicator-time', '0ms');
      group.style.setProperty('--indicator-x', `${before && before.key !== key ? before.x : x}px`);
      group.style.setProperty('--indicator-width', `${before && before.key !== key ? before.width : width}px`);
      // Commit the starting position before transitioning a replaced toolbar.
      getComputedStyle(group, '::after').transform;
    }
    group.style.setProperty('--indicator-time', reduce.matches ? '0ms' : '280ms');
    group.style.setProperty('--indicator-x', `${x}px`);
    group.style.setProperty('--indicator-width', `${width}px`);
    return {node: group, selected, label, key, x, width};
  }
  function exitPanel(panel) {
    if (!panel || reduce.matches || doc.hidden || panel.rect.width === 0) return;
    const ghost = panel.node.cloneNode(true);
    for (const el of [ghost, ...ghost.querySelectorAll('[id],[name],[autofocus]')]) {
      el.removeAttribute('id'); el.removeAttribute('name'); el.removeAttribute('autofocus');
    }
    ghost.inert = true;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.classList.add('appearance-exit');
    Object.assign(ghost.style, {position:'fixed', left:`${panel.rect.left}px`, top:`${panel.rect.top}px`, width:`${panel.rect.width}px`, height:`${panel.rect.height}px`, margin:'0', zIndex:'60', animation:'none'});
    doc.body.append(ghost);
    animate(ghost, [{opacity:1, transform:'translateX(0)'}, {opacity:0, transform:'translateX(16px)'}], {duration:140, easing:'ease-in'}, () => ghost.remove());
  }
  function refresh() {
    if (disposed) return;
    syncScroll();
    const indicators = new Map(groups.map(selector => [selector, syncIndicator(selector)]).filter(([,value]) => value));
    const measured = new Set([...indicators.values()].flatMap(group => [group.node, group.selected, group.label]));
    for (const node of measuredNodes) if (!measured.has(node)) { sizeObserver.unobserve(node); measuredNodes.delete(node); }
    for (const node of measured) if (!measuredNodes.has(node)) { measuredNodes.add(node); sizeObserver.observe(node); }
    const inspector = panelState('.inspector');
    const draft = panelState('.draft-pane:not([hidden])');
    const activity = root.querySelector('.activity-strip');
    const label = activity?.querySelector('.activity-label')?.textContent;
    const active = activity?.classList.contains('is-active');
    const workspace = root.querySelector('#workspace');
    const task = workspace?.dataset.taskId;
    const view = workspace?.dataset.workspaceView;
    const article = root.querySelector('.article-tab.active')?.id;
    if (previous) {
      if (task !== previous.task) stopMotion();
      const enteringNewTask = previous.view === 'new' && task && (view === 'chat' || view === 'zip-1');
      if (view && previous.view && view !== previous.view && (enteringNewTask || task === previous.task) &&
          view !== 'customers' && previous.view !== 'customers') {
        const enteringCreation = previous.view === 'start' && view === 'new';
        const nextStep = Number(view.slice(4)) > Number(previous.view.slice(4));
        const direction = enteringNewTask || enteringCreation || view === 'chat' || previous.view !== 'chat' && nextStep ? -1 : 1;
        const distance = Math.min(64, Math.max(28, workspace.clientWidth * .06));
        viewAnimation?.cancel();
        viewAnimation = animate(workspace, [
          {opacity:.45, transform:`translateX(${-direction * distance}px)`},
          {opacity:1, transform:'translateX(0)'},
        ], {duration:260, easing:'cubic-bezier(.16,1,.3,1)'});
      }
      if (inspector && !previous.inspector) {
        animate(inspector.node, [{opacity:0, transform:'translateX(14px)'}, {opacity:1, transform:'translateX(-1px)', offset:.72}, {opacity:1, transform:'none'}], {duration:260, easing:'ease-out'});
      } else if (!inspector && previous.inspector) exitPanel(previous.inspector);
      else if (inspector && inspector.title !== previous.inspector?.title) animate(inspector.node.querySelector('.inspector-body'), [{opacity:.45}, {opacity:1}], {duration:140});
      if (draft && !previous.draft) animate(draft.node, [{opacity:0, transform:'translateX(12px)'}, {opacity:1, transform:'none'}], {duration:260, easing:'cubic-bezier(.22,.9,.28,1.08)'});
      if (label && label !== previous.label) {
        animate(activity.querySelector('.activity-label'), [{opacity:.35}, {opacity:1}], {duration:160});
        if (previous.active && !active && !activity.classList.contains('is-uncertain')) animate(activity.querySelector('.activity-symbol'), [{scale:.85}, {scale:1.12,offset:.55}, {scale:1}], {duration:260});
      }
      if (article && previous.article && article !== previous.article && task === previous.task) animate(root.querySelector('.paper'), [{opacity:.5}, {opacity:1}], {duration:160});
    }
    previous = {indicators, inspector, draft, label, active, task, article, view};
  }
  function stopMotion() {
    presses.clear();
    for (const animation of activeAnimations) animation.cancel();
    activeAnimations.clear();
  }
  function preferenceChanged() { stopMotion(); refresh(); }
  function visibilityChanged() {
    doc.documentElement.toggleAttribute('data-motion-hidden', doc.hidden);
    if (doc.hidden) stopMotion();
  }
  const measuredNodes = new Set();
  const sizeObserver = new ResizeObserver(refresh);
  const observer = new MutationObserver(refresh);
  observer.observe(root, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['class','hidden','aria-selected','aria-current','data-workspace-view','data-task-id']});
  doc.addEventListener('pointerdown', pointerDown, {capture:true, passive:true});
  doc.addEventListener('pointerup', pointerUp, {capture:true, passive:true});
  doc.addEventListener('pointercancel', pointerUp, {capture:true, passive:true});
  doc.addEventListener('keydown', keyDown, true);
  doc.addEventListener('keyup', keyUp, true);
  doc.addEventListener('visibilitychange', visibilityChanged);
  root.addEventListener('scroll', syncScroll, true);
  window.addEventListener('resize', refresh);
  window.addEventListener('blur', stopMotion);
  reduce.addEventListener('change', preferenceChanged);
  visibilityChanged();
  refresh();
  function dispose() {
    disposed = true; observer.disconnect(); sizeObserver.disconnect(); stopMotion();
    doc.removeEventListener('pointerdown', pointerDown, true);
    doc.removeEventListener('pointerup', pointerUp, true);
    doc.removeEventListener('pointercancel', pointerUp, true);
    doc.removeEventListener('keydown', keyDown, true);
    doc.removeEventListener('keyup', keyUp, true);
    doc.removeEventListener('visibilitychange', visibilityChanged);
    root.removeEventListener('scroll', syncScroll, true);
    window.removeEventListener('resize', refresh);
    window.removeEventListener('blur', stopMotion);
    reduce.removeEventListener('change', preferenceChanged);
  }
  window.addEventListener('pagehide', dispose, {once:true});
  return {dispose};
}

if (typeof document !== 'undefined') installAppearance(document);
