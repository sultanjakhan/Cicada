// Adapted from Hanni's content-sync trigger: coalesce writes without blocking IPC.
export function createSyncTrigger({ invoke, setTimeout, clearTimeout, now = Date.now, afterSync = () => {} }) {
  let timer = null, first = null, running = false, again = false, disposed = false;
  async function fire() {
    if (disposed) return;
    if (running) { again = true; return; }
    running = true;
    try { await invoke('mvp_sync_now'); }
    catch { /* Native status retains the failure; local saves remain acknowledged. */ }
    finally {
      running = false;
      if (!disposed) afterSync();
      if (again && !disposed) { again = false; request(); }
    }
  }
  function request() {
    if (disposed) return;
    if (first === null) first = now();
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; first = null; void fire(); }, Math.min(120, Math.max(0, 150 - (now() - first))));
  }
  return { request, dispose() { disposed = true; if (timer !== null) clearTimeout(timer); } };
}

export const isSyncWrite = command => command === 'mvp_sync_conflict_resolve'
  || /^(add|create|delete|update|save|set|toggle|archive|start|stop|pause|finish|complete|restore|link|unlink)_/.test(command) && command !== 'create_backup';
