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
  const text = (ru, en) => element.ownerDocument.documentElement.lang.toLowerCase().startsWith('en') ? en : ru;
  let status, busy = false, disposed = false;
  element.className = 'calendar-setting calendar-app-updates';
  element.innerHTML = `<h3>${text('Обновления приложения', 'App updates')}</h3>
    <p data-update-status role="status">${text('Проверяем версию приложения…', 'Checking the app version…')}</p>
    <p data-update-notes></p><p data-update-error role="alert" hidden></p>
    <progress data-update-progress hidden aria-label="${text('Загрузка обновления', 'Update download')}"></progress>
    <div class="calendar-sync-actions"><button type="button" data-update-check>${text('Проверить обновления', 'Check for updates')}</button>
    <button type="button" data-update-install hidden></button>
    <button type="button" data-update-permission hidden>${text('Разрешить установку', 'Allow installation')}</button></div>
    <p class="calendar-sync-hint" data-update-hint></p>`;
  const q = name => element.querySelector(`[data-update-${name}]`);
  function render() {
    if (disposed) return;
    const phase = status?.phase, android = status?.platform === 'android-aarch64';
    const messages = {
      checking:text('Проверяем обновления…', 'Checking for updates…'), current:text('Установлена последняя версия.', 'The latest version is installed.'),
      available:text(`Доступна версия ${status?.version}. Установка начнётся, когда ты выберешь обновление.`, `Version ${status?.version} is available. Installation starts when you choose to update.`), downloading:text('Загружаем и проверяем обновление…', 'Downloading and verifying the update…'),
      prepared:text('Обновление загружено. Можно установить его сейчас или позже.', 'Update downloaded. You can install it now or later.'),
      deferred:text('Обновление доступно. Сначала сохрани изменения.', 'An update is available. Save your changes first.'),
      installing:text('Устанавливаем обновление…', 'Installing the update…'),
      permission_required:text('Разреши Cicada устанавливать обновления в настройках Android.', 'Allow Cicada to install updates in Android settings.'),
      confirmation_required:text('Android просит подтвердить установку обновления.', 'Android asks you to confirm the update installation.'),
      manual_required:text('Эта версия Android требует подтверждения установки.', 'This Android version requires installation confirmation.'),
      installer_opened:android ? text('Подтверди обновление в системном окне Android. Если закрыл его, можно повторить.', 'Confirm the update in the Android system dialog. If you closed it, you can try again.') : text('Установщик запущен. Приложение будет перезапущено.', 'The installer has started. The app will restart.'),
      error:text('Проверка или установка не завершена. Повторим позже.', 'The check or installation did not finish. We will try again later.'), idle:text('Фоновые проверки обновлений включены.', 'Background update checks are enabled.'),
    };
    const installedVersion = typeof status?.installed_version === 'string' ? status.installed_version.trim() : '';
    const appLabel = installedVersion ? `Cicada ${installedVersion}.` : text('Cicada. Версия не сообщена.', 'Cicada. Version not reported.');
    q('status').textContent = status ? `${appLabel} ${!status.configured ? text('Канал обновлений недоступен в этой сборке.', 'The update channel is unavailable in this build.') : messages[phase] || ''}` : text('Не удалось прочитать состояние обновлений.', 'Could not read the update status.');
    q('notes').textContent = status?.notes || '';
    q('error').textContent = [status?.error, status?.background_error].filter(Boolean).join(' ');
    q('error').hidden = !q('error').textContent;
    q('hint').textContent = android ? text('Cicada проверяет обновления в фоне и предлагает установить при открытии. Системное подтверждение появится только после твоего действия. Данные сохраняются.', 'Cicada checks for updates in the background and offers installation when you open it. System confirmation appears after your action. Your data is preserved.') : text('Cicada проверяет обновления в фоне и предлагает установить при открытии. Установка и перезапуск — только по твоему действию. Данные сохраняются.', 'Cicada checks for updates in the background and offers installation when you open it. Installation and restart require your action. Your data is preserved.');
    if (!status?.configured) q('hint').textContent = status
      ? text('Канал обновлений недоступен в этой сборке. Фоновые проверки недоступны.', 'The update channel is unavailable in this build. Background checks are unavailable.')
      : text('Состояние канала обновлений не получено.', 'The update channel status has not been received.');
    const blocked = busy || busyPhases.has(phase);
    q('check').disabled = blocked || (status && !status.configured);
    q('install').hidden = !status?.version || !['available', 'prepared', 'deferred', 'permission_required', 'confirmation_required', 'manual_required', 'installer_opened'].includes(phase);
    q('install').disabled = blocked;
    q('install').textContent = phase === 'confirmation_required' ? text('Подтвердить установку', 'Confirm installation') : android ? text('Обновить сейчас', 'Update now') : text('Обновить и перезапустить', 'Update and restart');
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
