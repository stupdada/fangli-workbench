// Only the latest saved selection may change the current task's view.
export function createModeSwitcher({getMode, getTaskId, saveMode, applyMode}) {
  let generation = 0;
  let pending = null;
  return {
    reset() { generation++; pending = null; },
    async select(next, {force = false} = {}) {
      if (!['chat', 'zip'].includes(next)) throw new Error('未知创作方式');
      if (!force && next === (pending ?? getMode())) return false;
      pending = next;
      const request = ++generation, task = getTaskId();
      try { await saveMode(next); }
      catch (error) {
        if (request === generation) pending = null;
        throw error;
      }
      if (request !== generation) return false;
      pending = null;
      if (task !== getTaskId()) return false;
      applyMode(next);
      return true;
    },
  };
}
