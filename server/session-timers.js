'use strict';
// One timer per task, armed for the exact moment the approved window ends.
// The 15-second sweep in server.js stays as a safety net, but this is what makes the cut-off precise.

const MAX_DELAY = 2 ** 31 - 1; // setTimeout overflows above ~24.8 days

module.exports = function createSessionTimers({ db, parseDbDate, onExpire }) {
  const timers = new Map(); // taskId -> Timeout

  function cancel(taskId) {
    const t = timers.get(taskId);
    if (t) clearTimeout(t);
    timers.delete(taskId);
  }

  function schedule(taskId, endMs) {
    cancel(taskId);
    if (!Number.isFinite(endMs)) return;
    const arm = () => {
      const left = endMs - Date.now();
      if (left <= 0) {
        timers.delete(taskId);
        Promise.resolve(onExpire(taskId)).catch((e) => console.error('[TIMER] expiry failed for task', taskId, e.message));
        return;
      }
      timers.set(taskId, setTimeout(arm, Math.min(left, MAX_DELAY)));
    };
    arm();
  }

  // After a server restart, re-arm every task that is still open
  async function restoreAll() {
    const rows = await db.all("SELECT id, window_end FROM tasks WHERE status IN ('pending', 'active')");
    rows.forEach((r) => schedule(r.id, parseDbDate(r.window_end).getTime()));
    return rows.length;
  }

  return { schedule, cancel, restoreAll };
};
