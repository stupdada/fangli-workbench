// Task changes replace the whole composition; settle its layout before showing it.
export function createTaskPresentation(doc, {reduced = () => false, onError = error => console.error(error)} = {}) {
  let current = null, applying = false;
  const release = entry => {
    if (current !== entry) return;
    current = null;
    doc.documentElement.removeAttribute('data-task-transition');
  };
  return {
    get applying() { return applying; },
    present(update) {
      if (current && !current.applied) { current.update = update; return; }
      current?.transition?.skipTransition();
      const entry = current = {update, applied:false};
      const apply = () => {
        if (current !== entry) return;
        entry.applied = true;
        applying = true;
        doc.documentElement.setAttribute('data-task-transition', '');
        try {
          entry.update();
          // Commit final grid tracks while their CSS transition is suppressed.
          doc.getElementById('workspace')?.getBoundingClientRect();
        } finally { applying = false; }
      };
      if (!doc.startViewTransition || reduced() || doc.hidden) {
        try { apply(); } finally { release(entry); }
        return;
      }
      try { entry.transition = doc.startViewTransition(apply); }
      catch { try { apply(); } finally { release(entry); } return; }
      entry.transition.ready.catch(() => {});
      entry.transition.updateCallbackDone.catch(onError);
      entry.transition.finished.then(() => release(entry), () => release(entry));
    },
    dispose() {
      const entry = current;
      current = null;
      entry?.transition?.skipTransition();
      doc.documentElement.removeAttribute('data-task-transition');
    },
  };
}
