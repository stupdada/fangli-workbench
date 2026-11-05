import {canPlayPaperMotion, createPaperAnimations, observePaperMotion, paperMotionEnabled} from '../assets/paper-motion.mjs';

const paper = '<svg viewBox="0 0 28 32" width="28" height="32"><path d="M5 1.5h12l7.5 7.5V27a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V4.5a3 3 0 0 1 3-3Z" fill="#fff" stroke="#596273" stroke-width="1.5"/><path d="M17 2v7h7M7 14h11M7 19h6" fill="none" stroke="#596273" stroke-width="1.35" stroke-linecap="round"/><path d="m15 23 2.5 2.5L23 20" fill="none" stroke="#315dc0" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const landing = [{scale: '1'}, {scale: '1.08', offset: .55}, {scale: '1'}];
const arrangementSpeed = .7;
const arrangementDuration = milliseconds => Math.round(milliseconds / arrangementSpeed);

function visibleRect(node, viewport) {
  if (!node?.getClientRects().length) return null;
  const box = node.getBoundingClientRect();
  const clip = viewport?.getBoundingClientRect();
  const left = Math.max(0, box.left, clip?.left ?? 0);
  const top = Math.max(0, box.top, clip?.top ?? 0);
  const right = Math.min(innerWidth, box.right, clip?.right ?? innerWidth);
  const bottom = Math.min(innerHeight, box.bottom, clip?.bottom ?? innerHeight);
  return right > left && bottom > top ? {left, right, top, bottom} : null;
}

export function createWorkbenchPaperFeedback() {
  const motion = createPaperAnimations();
  let previous;
  let token;
  let queuedFlight;
  function stop() {
    cancelAnimationFrame(queuedFlight);
    motion.stop();
    token?.remove();
    token = null;
  }
  observePaperMotion(() => {
    if (!canPlayPaperMotion()) stop();
    const control = document.querySelector('[data-paper-motion-toggle]');
    if (control) control.checked = paperMotionEnabled();
  });
  window.addEventListener('resize', stop);
  window.addEventListener('pagehide', stop);
  document.addEventListener('scroll', () => { if (token) stop(); }, {capture:true, passive:true});

  function arrange(workspace, id) {
    const target = workspace.querySelector('[data-paper-arrangement]');
    const destination = visibleRect(target);
    if (!destination || target.closest('[inert]')) return;
    const copy = workspace.querySelector(`[data-key="reply-${CSS.escape(id)}"] .message-copy`);
    const source = visibleRect(copy, workspace.querySelector('.conversation-log'));
    if (!source) {
      motion.play(target, landing, {duration:arrangementDuration(220), easing:'ease-out'});
      return;
    }
    token?.remove();
    const originX = source.right - 18, originY = source.bottom - 14;
    const x = destination.left + 17 - originX, y = (destination.top + destination.bottom) / 2 - originY;
    const note = document.createElement('div');
    note.className = 'paper-arrival-token';
    note.setAttribute('aria-hidden', 'true');
    note.style.left = `${originX - 14}px`;
    note.style.top = `${originY - 16}px`;
    note.innerHTML = paper;
    document.body.append(note);
    token = note;
    motion.play(note, [
      {transform:'translate(0, 5px) rotate(-7deg) scale(.78)', opacity:0},
      {transform:'translate(0, -7px) rotate(-5deg) scale(1)', opacity:1, offset:.23},
      {transform:`translate(${x * .86 + 10}px, ${y * .86 - 12}px) rotate(5deg) scale(.83)`, opacity:1, offset:.78},
      {transform:`translate(${x}px, ${y}px) rotate(0) scale(.52)`, opacity:0},
    ], {duration:arrangementDuration(470), easing:'cubic-bezier(.3,.03,.25,1)'}, () => {
      const landed = token === note && note.isConnected && target.isConnected;
      note.remove();
      if (token === note) token = null;
      if (landed) motion.play(target, landing, {duration:arrangementDuration(210), easing:'ease-out'});
    });
  }

  return function update(state, workspace) {
    const conversation = state.conversation;
    const task = conversation?.id;
    const view = workspace.dataset.workspaceView;
    const saved = new Set(state.articles.filter(article => article.current_version != null && !article.locked).map(article => String(article.id)));
    const reply = conversation?.messages?.findLast(message => message.role === 'assistant' && message.content?.operation_id)?.content;
    const operation = reply && state.operations.find(item => item.id === reply.operation_id);
    const arrangement = operation?.status === 'done' && reply.ready === true && reply.stale === false ? reply.operation_id : null;
    const before = previous;
    const sameTask = task && task === before?.task;
    const seen = sameTask ? new Set([...before.saved, ...saved]) : saved;
    previous = {task, view, saved:seen, arrangement:arrangement || (sameTask ? before.arrangement : null)};
    if (!task || task !== before?.task || view !== before.view) { stop(); return; }
    if (!canPlayPaperMotion()) return;
    if (view === 'chat' && arrangement && arrangement !== before.arrangement) {
      cancelAnimationFrame(queuedFlight);
      queuedFlight = requestAnimationFrame(() => {
        if (canPlayPaperMotion() && !document.querySelector('dialog[open]')) arrange(workspace, arrangement);
      });
    }
    for (const id of saved) {
      if (before.saved.has(id)) continue;
      const entry = workspace.querySelector(`.draft-pane:not([hidden]) [data-select-article="${CSS.escape(id)}"]`);
      if (!visibleRect(entry, entry?.closest('.draft-pane'))) continue;
      motion.play(entry, [
        {transform:'translateY(-6px)', opacity:.6, boxShadow:'inset 0 -2px #315dc0'},
        {transform:'translateY(1px)', opacity:1, offset:.62, boxShadow:'inset 0 -2px #315dc0'},
        {transform:'translateY(0)', opacity:1, boxShadow:'inset 0 -2px transparent'},
      ], {duration:490, easing:'ease-out'});
    }
  };
}
