// Only the latest saved selection may change the current task's view.
export function createModeSwitcher({getMode, getTaskId, saveMode, applyMode}) {
  let generation = 0;
  let desired = getMode();
  return {
    reset() { generation++; desired = getMode(); },
    async select(next, {force = false} = {}) {
      if (!['chat', 'zip'].includes(next)) throw new Error('未知创作方式');
      if (!force && next === desired) return false;
      desired = next;
      const request = ++generation, task = getTaskId();
      try { await saveMode(next); }
      catch (error) {
        if (request === generation) desired = getMode();
        throw error;
      }
      if (request !== generation || task !== getTaskId()) {
        if (request === generation) desired = getMode();
        return false;
      }
      applyMode(next);
      return true;
    },
  };
}
