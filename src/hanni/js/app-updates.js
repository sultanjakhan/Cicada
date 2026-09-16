const busyPhases = new Set(['checking', 'downloading', 'installing']);
const EDITORS = 'dialog[open], [role="dialog"], .modal-overlay, [contenteditable="true"], [contenteditable=""]';

// Native code owns scheduling and installation. No fresh, safe UI lease means
// no automatic restart of an open application.
export function updateActivity(window, { getPendingOperations = () => 0, hasUnsavedDrafts = () => false } = {}) {
  const document = window.document;
  const hasEditor = [...document.querySelectorAll(EDITORS)].some(node =>
    !node.hidden && !node.closest('[hidden], [aria-hidden="true"]'));
  return { hidden: document.visibilityState === 'hidden',
    safeToInstall: !hasEditor && !getPendingOperations() && !hasUnsavedDrafts() };
}

export function startAppUpdates({ window, invoke, listen, notify = () => {}, getPendingOperations, hasUnsavedDrafts }) {
  let disposed = false, polling = false, reporting = false, reportAgain = false, announced;
  const subscriptions = [];
  const accept = status => {
    if (disposed) return;
    window.dispatchEvent(new window.CustomEvent('hanni:update-status', { detail: status }));
    if (['permission_required', 'confirmation_required'].includes(status.phase) && status.version !== announced) {
      announced = status.version;
      notify('Android просит подтвердить обновление Hanni. Открой настройки приложения.');
    }
  };
  async function report() {
    if (disposed) return;
    if (reporting) { reportAgain = true; return; }
    reporting = true;
    try {
      do {
        reportAgain = false;
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
  const observer = new window.MutationObserver(report);
  observer.observe(window.document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['open', 'hidden', 'aria-hidden', 'contenteditable'] });
  window.addEventListener('hanni:update-activity-probe', report);
  window.addEventListener('focus', report); window.addEventListener('blur', report);
  window.addEventListener('online', foreground);
  window.document.addEventListener('visibilitychange', foreground);
  const interval = window.setInterval(foreground, 15_000);
  foreground();
  return () => {
    disposed = true; subscriptions.forEach(stop => stop()); observer.disconnect(); window.clearInterval(interval);
    window.removeEventListener('hanni:update-activity-probe', report);
    window.removeEventListener('focus', report); window.removeEventListener('blur', report);
    window.removeEventListener('online', foreground); window.document.removeEventListener('visibilitychange', foreground);
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
      available:`Доступна версия ${status?.version}. Она загрузится автоматически.`, downloading:'Загружаем и проверяем обновление…',
      prepared:'Обновление загружено. Установится автоматически, когда ты закончишь работу.',
      deferred:'Обновление ждёт окончания работы. Сохрани изменения и сверни или закрой приложение.',
      installing:'Устанавливаем обновление…',
      permission_required:'Разреши Hanni устанавливать обновления в настройках Android.',
      confirmation_required:'Android просит подтвердить установку обновления.',
      installer_opened:android ? 'Подтверди обновление в системном окне Android. Если закрыл его, можно повторить.' : 'Установщик запущен. Приложение будет перезапущено.',
      error:'Проверка или установка не завершена. Повторим позже.', idle:'Автоматические обновления включены.',
    };
    q('status').textContent = status ? `Hanni MVP ${status.installed_version}. ${!status.configured ? 'Канал обновлений недоступен в этой сборке.' : messages[phase] || ''}` : 'Не удалось прочитать состояние обновлений.';
    q('notes').textContent = status?.notes || '';
    q('error').textContent = status?.error || '';
    q('error').hidden = !status?.error;
    q('hint').textContent = android ? 'Hanni сама загружает и устанавливает новые версии. Если Android потребует подтверждение, здесь появится кнопка. Данные сохраняются.' : 'Hanni сама загружает и устанавливает новые версии, когда ты не работаешь в приложении. Данные сохраняются.';
    const blocked = busy || busyPhases.has(phase);
    q('check').disabled = blocked || (status && !status.configured);
    q('install').hidden = !status?.version || !['available', 'prepared', 'deferred', 'permission_required', 'confirmation_required', 'installer_opened'].includes(phase);
    q('install').disabled = blocked;
    q('install').textContent = phase === 'confirmation_required' ? 'Подтвердить установку' : android ? 'Обновить сейчас' : 'Обновить и перезапустить';
    q('permission').hidden = phase !== 'permission_required'; q('permission').disabled = busy;
    q('progress').hidden = phase !== 'downloading'; q('progress').max = status?.size || 1;
    q('progress').value = status?.downloaded || 0;
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
