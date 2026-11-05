const preferenceKey = 'fangli.paper-motion.v1';
const preferenceEvent = 'fangli:paper-motion';
const releaseEnabled = true;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

export function paperMotionEnabled() {
  if (!releaseEnabled) return false;
  try { return localStorage.getItem(preferenceKey) !== 'off'; }
  catch { return sessionEnabled; }
}

let sessionEnabled = true;
export function setPaperMotionEnabled(enabled) {
  sessionEnabled = enabled;
  try { localStorage.setItem(preferenceKey, enabled ? 'on' : 'off'); } catch {}
  window.dispatchEvent(new Event(preferenceEvent));
}

export function observePaperMotion(refresh) {
  window.addEventListener(preferenceEvent, refresh);
  window.addEventListener('storage', event => {
    if (event.key === preferenceKey || event.key === null) refresh();
  });
  reduced.addEventListener('change', refresh);
  document.addEventListener('visibilitychange', refresh);
}

export function canPlayPaperMotion() {
  return paperMotionEnabled() && !reduced.matches && !document.hidden;
}

export function createPaperAnimations() {
  const animations = new Set();
  return {
    play(node, frames, options, cleanup = () => {}) {
      if (!node?.animate || !canPlayPaperMotion()) { cleanup(); return null; }
      const animation = node.animate(frames, options);
      animations.add(animation);
      const finish = () => { animations.delete(animation); cleanup(); };
      animation.finished.then(finish, finish);
      return animation;
    },
    stop() {
      for (const animation of animations) animation.cancel();
      animations.clear();
    },
  };
}
