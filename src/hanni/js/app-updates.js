import { createSoftUpdateNotice, isOfferableUpdate } from './app-update-notice.js';
const busyPhases = new Set(['checking', 'downloading', 'installing']);
const EDITORS = 'dialog[open], [role="dialog"], .modal-overlay, [contenteditable="true"], [contenteditable=""]';

// Native code owns background scheduling; entry checks do not install anything.
export function updateActivity(window, { getPendingOperations = () => 0, hasUnsavedDrafts = () => false } = {}) {
  const document = window.document;
  const hasEditor = [...document.querySelectorAll(EDITORS)].some(node =>
    !node.hidden && !node.closest('[hidden], [aria-hidden="true"]'));
  return { hidden: document.visibilityState === 'hidden',
    safeToInstall: !hasEditor && !getPendingOperations() && !hasUnsavedDrafts() };
}

export function startAppUpdates({ window, invoke, listen, getPendingOperations, hasUnsavedDrafts }) {
  let disposed = false, polling = false, checkingEntry = false, reporting = false, reportAgain = false, latest;
  let entryPending = window.document.visibilityState !== 'hidden';
  const offered = new Set();
  const notice = createSoftUpdateNotice(window, { invoke,
    safe: () => updateActivity(window, { getPendingOperations, hasUnsavedDrafts }).safeToInstall });
  const offer = () => {
    if (!entryPending || window.document.visibilityState === 'hidden' || !isOfferableUpdate(latest)) return;
    if (!offered.has(latest.version) && notice.show(latest)) {
      offered.add(latest.version);
    }
    entryPending = false;
  };
  const subscriptions = [];
  const accept = status => {
    if (disposed) return;
    latest = status;
    window.dispatchEvent(new window.CustomEvent('hanni:update-status', { detail: status }));
    notice.update(status); offer();
    if (status.phase === 'current') entryPending = false;
  };
  async function report() {
    if (disposed) return;
    if (reporting) { reportAgain = true; return; }
    reporting = true;
    try {
      do {
        reportAgain = false;
        notice.refresh();
        await invoke('mvp_update_activity', { activity: updateActivity(window, { getPendingOperations, hasUnsavedDrafts }) });
      } while (reportAgain && !disposed);
    } catch { /* The native lease expires if the UI cannot report. */ }
    finally { reporting = false; }
  }
  async function poll() {
    if (disposed || polling) return;
    polling = true;
    try { accept(await invoke('mvp_update_status')); } catch { /* An IPC failure is not installation success. */ }
    finally { polling = false; }
  }
  for (const [event, handler] of [['hanni:update-status', event => accept(event.payload)], ['hanni:update-activity-probe', report]]) {
    Promise.resolve(listen(event, handler)).then(stop => { if (disposed) stop(); else subscriptions.push(stop); }).catch(() => {});
  }
  const foreground = () => { void report(); void poll(); };
  const entered = () => {
    if (window.document.visibilityState === 'hidden') { notice.hide(); return; }
    if (checkingEntry) return;
    entryPending = true; checkingEntry = true; void report();
    void (async () => {
      try { accept(await invoke('mvp_update_check')); }
      catch { await poll(); }
      finally { entryPending = false; checkingEntry = false; }
    })();
  };
  const observer = new window.MutationObserver(report);
  observer.observe(window.document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['open', 'hidden', 'aria-hidden', 'contenteditable'] });
  window.addEventListener('hanni:update-activity-probe', report);
  window.addEventListener('focus', entered); window.addEventListener('blur', report);
  window.addEventListener('online', foreground);
  window.document.addEventListener('visibilitychange', entered);
  const interval = window.setInterval(foreground, 15_000);
  if (window.document.visibilityState === 'hidden') foreground(); else entered();
  return () => {
    disposed = true; notice.dispose(); subscriptions.forEach(stop => stop()); observer.disconnect(); window.clearInterval(interval);
    window.removeEventListener('hanni:update-activity-probe', report);
    window.removeEventListener('focus', entered); window.removeEventListener('blur', report);
    window.removeEventListener('online', foreground); window.document.removeEventListener('visibilitychange', entered);
    void invoke('mvp_update_activity', { activity: { hidden: false, safeToInstall: false } }).catch(() => {});
  };
}

export function mountAppUpdates(element, { invoke }) {
  const window = element.ownerDocument.defaultView;
  let status, busy = false, disposed = false;
  element.className = 'calendar-setting calendar-app-updates';
  element.innerHTML = `<h3>Обновления приложения</h3>
    <p data-update-status role="status">Проверяем версию приложения…</p>
    <p data-update-notes></p><p data-update-error role="alert" hidden></p>
    <progress data-update-progress hidden aria-label="Загрузка обновления"></progress>
    <div class="calendar-sync-actions"><button type="button" data-update-check>Проверить обновления</button>
    <button type="button" data-update-install hidden></button>
    <button type="button" data-update-permission hidden>Разрешить установку</button></div>
    <p class="calendar-sync-hint" data-update-hint></p>`;
  const q = name => element.querySelector(`[data-update-${name}]`);
  function render() {
    if (disposed) return;
    const phase = status?.phase, android = status?.platform === 'android-aarch64';
    const messages = {
      checking:'Проверяем обновления…', current:'Установлена последняя версия.',
      available:`Доступна версия ${status?.version}. Установка начнётся, когда ты выберешь обновление.`, downloading:'Загружаем и проверяем обновление…',
      prepared:'Обновление загружено. Можно установить его сейчас или позже.',
      deferred:'Обновление доступно. Сначала сохрани изменения.',
      installing:'Устанавливаем обновление…',
      permission_required:'Разреши Cicada устанавливать обновления в настройках Android.',
      confirmation_required:'Android просит подтвердить установку обновления.',
      manual_required:'Эта версия Android требует подтверждения установки.',
      installer_opened:android ? 'Подтверди обновление в системном окне Android. Если закрыл его, можно повторить.' : 'Установщик запущен. Приложение будет перезапущено.',
      error:'Проверка или установка не завершена. Повторим позже.', idle:'Фоновые проверки обновлений включены.',
    };
    const installedVersion = typeof status?.installed_version === 'string' ? status.installed_version.trim() : '';
    const appLabel = installedVersion ? `Cicada ${installedVersion}.` : 'Cicada. Версия не сообщена.';
    q('status').textContent = status ? `${appLabel} ${!status.configured ? 'Канал обновлений недоступен в этой сборке.' : messages[phase] || ''}` : 'Не удалось прочитать состояние обновлений.';
    q('notes').textContent = status?.notes || '';
    q('error').textContent = [status?.error, status?.background_error].filter(Boolean).join(' ');
    q('error').hidden = !q('error').textContent;
    q('hint').textContent = android ? 'Cicada проверяет обновления в фоне и предлагает установить при открытии. Системное подтверждение появится только после твоего действия. Данные сохраняются.' : 'Cicada проверяет обновления в фоне и предлагает установить при открытии. Установка и перезапуск — только по твоему действию. Данные сохраняются.';
    if (!status?.configured) q('hint').textContent = status
      ? 'Канал обновлений недоступен в этой сборке. Фоновые проверки недоступны.'
      : 'Состояние канала обновлений не получено.';
    const blocked = busy || busyPhases.has(phase);
    q('check').disabled = blocked || (status && !status.configured);
    q('install').hidden = !status?.version || !['available', 'prepared', 'deferred', 'permission_required', 'confirmation_required', 'manual_required', 'installer_opened'].includes(phase);
    q('install').disabled = blocked;
    q('install').textContent = phase === 'confirmation_required' ? 'Подтвердить установку' : android ? 'Обновить сейчас' : 'Обновить и перезапустить';
    q('permission').hidden = phase !== 'permission_required'; q('permission').disabled = busy;
    q('progress').hidden = phase !== 'downloading'; q('progress').max = status?.size || 1;
    q('progress').value = status?.downloaded || 0;
    if (!status?.configured) {
      q('install').hidden = true; q('permission').hidden = true; q('progress').hidden = true;
    }
  }
  async function perform(command, args) {
    if (busy || disposed) return;
    busy = true; render();
    try {
      const result = await invoke(command, args);
      if (!disposed && result) status = result;
    } catch (error) {
      if (!disposed) status = { ...status, error:String(error?.message || error), phase:'error' };
    } finally { busy = false; render(); }
  }
  q('check').onclick = () => void perform('mvp_update_check');
  q('install').onclick = () => void (status.phase === 'confirmation_required'
    ? perform('mvp_update_confirm') : perform('mvp_update_install', { expectedVersion:status.version }));
  q('permission').onclick = () => void perform('mvp_update_open_permission');
  const changed = event => { if (!disposed) { status = event.detail; render(); } };
  window.addEventListener('hanni:update-status', changed);
  void perform('mvp_update_status');
  return () => { disposed = true; window.removeEventListener('hanni:update-status', changed); };
}
