const INTERVAL = 6 * 60 * 60 * 1000;
const busyPhases = new Set(['checking', 'downloading']);

// One check on startup and after returning online/foreground. Never install
// automatically: the user can be editing a task or running its timer.
export function startAppUpdates({ window, invoke, listen, notify = () => {} }) {
  let disposed = false, checking = false, lastAttempt = 0, unlisten, announced;
  const accept = status => {
    if (disposed) return;
    window.dispatchEvent(new window.CustomEvent('hanni:update-status', { detail: status }));
    if (status.phase === 'available' && status.version !== announced) {
      announced = status.version;
      notify(`Доступна Hanni MVP ${status.version}. Обновление — в настройках.`);
    }
  };
  async function check() {
    if (disposed || checking || window.navigator.onLine === false || Date.now() - lastAttempt < INTERVAL) return;
    checking = true;
    try {
      const status = await invoke('mvp_update_status');
      if (!status.configured || busyPhases.has(status.phase) || ['permission_required', 'installer_opened'].includes(status.phase)) return;
      lastAttempt = Date.now();
      accept(await invoke('mvp_update_check'));
    } catch {
      // A failed request may retry when connectivity returns, without flooding
      // the service on repeated foreground events.
      lastAttempt = Date.now() - INTERVAL + 60_000;
    }
    finally { checking = false; }
  }
  Promise.resolve(listen('hanni:update-status', event => accept(event.payload))).then(stop => {
    if (disposed) stop(); else unlisten = stop;
  }).catch(() => {});
  const foreground = () => { if (window.document.visibilityState !== 'hidden') void check(); };
  const startup = window.setTimeout(check, 8000);
  const interval = window.setInterval(foreground, INTERVAL);
  window.addEventListener('online', foreground);
  window.document.addEventListener('visibilitychange', foreground);
  return () => {
    disposed = true; unlisten?.(); window.clearTimeout(startup); window.clearInterval(interval);
    window.removeEventListener('online', foreground); window.document.removeEventListener('visibilitychange', foreground);
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
      available:`Доступна версия ${status?.version}.`, downloading:'Загружаем и проверяем обновление…',
      permission_required:'Разреши Hanni устанавливать обновления, затем нажми «Скачать и обновить».',
      installer_opened:android ? 'Подтверди обновление в системном окне Android. Если закрыл его, можно повторить.' : 'Установщик запущен. Приложение будет перезапущено.',
      error:'Проверка или установка не завершена.', idle:'Проверка при запуске включена.',
    };
    q('status').textContent = status ? `Hanni MVP ${status.installed_version}. ${!status.configured ? 'Канал обновлений недоступен в этой сборке.' : messages[phase] || ''}` : 'Не удалось прочитать состояние обновлений.';
    q('notes').textContent = status?.notes || '';
    q('error').textContent = status?.error || '';
    q('error').hidden = !status?.error;
    q('hint').textContent = android ? 'Новые версии проверяются при открытии приложения. Установку подтверждает Android; данные сохраняются.' : 'Новые версии проверяются при открытии приложения. Перезапуск — после нажатия кнопки обновления.';
    const blocked = busy || busyPhases.has(phase);
    q('check').disabled = blocked || (status && !status.configured);
    q('install').hidden = !status?.version || !['available', 'permission_required', 'installer_opened'].includes(phase);
    q('install').disabled = blocked;
    q('install').textContent = android ? 'Скачать и обновить' : 'Обновить и перезапустить';
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
  q('install').onclick = () => void perform('mvp_update_install', { expectedVersion:status.version });
  q('permission').onclick = () => void perform('mvp_update_open_permission');
  const changed = event => { if (!disposed) { status = event.detail; render(); } };
  window.addEventListener('hanni:update-status', changed);
  void perform('mvp_update_status');
  return () => { disposed = true; window.removeEventListener('hanni:update-status', changed); };
}
