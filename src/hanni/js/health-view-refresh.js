// Upstream refresh lifecycle, restricted to Calendar and MVP content changes.
import { S } from './state.js';

let started = false, pending = false, scheduled = false, pointerDown = false;
let errorRetry = null;
let pendingRemote = false;
const rendered = new WeakMap();
const reads = new WeakMap();

export function beginHealthViewRead(el) {
  const version = (reads.get(el) || 0) + 1;
  reads.set(el, version);
  return () => el.isConnected && reads.get(el) === version;
}

function visibleTarget() {
  if (document.visibilityState !== 'visible') return null;
  const view = document.getElementById(`view-${S.activeTab}`);
  if (!view?.classList.contains('active') || S.activeSubTab[S.activeTab] === 'Настройки') return null;
  if (S.activeTab === 'calendar') return view.querySelector('#uni-pane-calendar, [data-calendar-records], #calendar-inner-content');
  return null;
}

export function canRefreshHealthView(el) {
  const target = visibleTarget();
  if (!target || !el?.isConnected || (!target.contains(el) && !el.contains(target))) return false;
  if (pointerDown || document.querySelector('dialog[open], .modal-overlay, .cal-event-pop, .dragging')) return false;
  if (target.querySelector('[contenteditable="true"], .block-editor, .calendar-now__picker:not([hidden])')) return false;
  return !document.activeElement?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

// Check again after asynchronous reads: an editor may have opened meanwhile.
export function mayCommitHealthView(el, fingerprint, quiet = false) {
  if (quiet && !canRefreshHealthView(el)) { requestHealthViewRefresh(); return false; }
  if (quiet && rendered.get(el) === fingerprint) return false;
  rendered.set(el, fingerprint);
  return true;
}

export function requestHealthViewRefresh({ remote = false } = {}) {
  pending = true;
  pendingRemote ||= remote;
  schedule();
}

export function retryHealthViewRefresh() {
  if (errorRetry !== null) return;
  errorRetry = window.setTimeout(() => { errorRetry = null; pending = true; schedule(); }, 15_000);
}

function schedule() {
  if (!pending || scheduled) return;
  scheduled = true;
  window.setTimeout(() => {
    scheduled = false;
    const target = visibleTarget();
    if (!pending || !target || !canRefreshHealthView(target)) return;
    pending = false;
    const remoteSync = pendingRemote; pendingRemote = false;
    const canCommit = () => {
      if (canRefreshHealthView(target)) return true;
      requestHealthViewRefresh({ remote: remoteSync }); return false;
    };
    const detail = { quietHealth: true, remoteSync, canCommit };
    window.dispatchEvent(new CustomEvent('hanni:calendar-refresh', { detail }));
    if (remoteSync) window.dispatchEvent(new CustomEvent('task-state-changed', { detail }));
  }, 0);
}

export function startHealthViewRefresh() {
  if (started) return;
  started = true;
  document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
  const released = () => { pointerDown = false; schedule(); };
  document.addEventListener('pointerup', released, true);
  document.addEventListener('pointercancel', released, true);
  document.addEventListener('focusout', schedule, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule();
    else pointerDown = false;
  });
  window.addEventListener('focus', schedule);
  // Closing an editor releases a deferred refresh without polling.
  new MutationObserver(() => { if (pending) schedule(); }).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'class', 'hidden'],
  });
}
