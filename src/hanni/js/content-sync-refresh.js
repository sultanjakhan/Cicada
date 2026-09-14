// Adapted from Hanni's content refresh: native revisions invalidate local views.
export function startMvpSyncRefresh({ window, invoke, listen, requestSync, requestRefresh }) {
  const document = window.document;
  let disposed = false, checking = false, checkAgain = false, revision = null, unlisten;
  async function check() {
    if (disposed || document.visibilityState !== 'visible') return;
    if (checking) { checkAgain = true; return; }
    checking = true;
    try {
      const status = await invoke('mvp_sync_status');
      if (disposed) return;
      window.dispatchEvent(new window.CustomEvent('hanni:sync-status', { detail: status }));
      if (status?.revision != null) {
        if (revision !== null && revision !== String(status.revision)) requestRefresh({ remote: true });
        revision = String(status.revision);
      }
    } catch { /* Settings show a status read failure when the user opens them. */ }
    finally { checking = false; if (checkAgain && !disposed) { checkAgain = false; void check(); } }
  }
  const wake = () => { if (document.visibilityState === 'visible') { requestSync(); requestRefresh({ remote: true }); void check(); } };
  const received = event => {
    if (disposed) return;
    const payload = event?.payload;
    if (payload?.views_changed === true) {
      if (payload.revision != null) revision = String(payload.revision);
      requestRefresh({ remote: true });
    }
    void check();
  };
  Promise.resolve().then(() => listen('mvp-sync-updated', received)).then(stop => { if (disposed) stop?.(); else unlisten = stop; }).catch(() => {});
  window.addEventListener('focus', wake);
  window.addEventListener('pageshow', wake);
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('hanni:sync-check-status', check);
  const timer = window.setInterval(wake, 30_000);
  void check(); requestSync();
  return () => {
    if (disposed) return;
    disposed = true; unlisten?.(); window.clearInterval(timer);
    window.removeEventListener('focus', wake); window.removeEventListener('pageshow', wake);
    document.removeEventListener('visibilitychange', wake); window.removeEventListener('hanni:sync-check-status', check);
  };
}
