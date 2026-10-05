import { createUiCopy, copyForLanguage } from './ui-copy.js';
export function sleepStatusText(status, language = 'ru') {
  const copy=copyForLanguage(language);
  if (!status) return copy("Не удалось проверить импорт сна. Повтори попытку.");
  if (status.status === 'unsupported') return copy("Сон импортируется из Health Connect на телефоне Android и приходит сюда через синхронизацию.");
  if (status.status === 'provider_unavailable') return copy("Health Connect недоступен. Установи или обнови его на телефоне.");
  if (status.status === 'permission_required') return copy("Разреши Cicada читать сон в Health Connect. Импортированные ранее записи сохранены.");
  if (status.status === 'permission_requested') return copy("Заверши системный запрос Health Connect, затем проверь сон. Разрешение ещё не подтверждено.");
  if (status.status === 'foreground_required') return copy("Для чтения сна открой Cicada на телефоне.");
  if (status.status !== 'ready' || status.lastError) return copy("Последний импорт сна не завершён. Сохранённые записи не потеряны; повтори попытку.");
  if (!status.lastSuccess) return copy("Доступ разрешён. Первый импорт сна ещё не подтверждён.");
  if (!status.records) return copy("В Health Connect не найдено записей сна. Проверь, что Samsung Health или другое приложение передаёт туда сон.");
  return `${copy("Импортировано записей сна: ")}${status.records}.`;
}

function announce(window, status) {
  window.dispatchEvent(new window.CustomEvent('hanni:sleep-status', { detail: status }));
  if (status?.changed > 0) window.dispatchEvent(new window.Event('hanni:sleep-imported'));
}

export function mountSleepSettings(element, { invoke, setPending = () => {} }) {
  const window = element.ownerDocument.defaultView;
  const copy=createUiCopy(element.ownerDocument);
  let disposed = false, busy = false, status = null;
  element.className = 'calendar-setting';
  element.innerHTML = `<h3>${copy("Сон")}</h3><p data-sleep-status role="status">${copy("Проверяем Health Connect…")}</p>
    <p data-sleep-background></p><p data-sleep-success></p><p data-sleep-history hidden></p>
    <div class="calendar-sync-actions"><button type="button" data-sleep-connect hidden>${copy("Разрешить чтение сна")}</button>
    <button type="button" data-sleep-import hidden>${copy("Проверить сон сейчас")}</button><button type="button" data-sleep-retry hidden>${copy("Повторить проверку")}</button></div>`;
  const q = key => element.querySelector(`[data-sleep-${key}]`);
  function render() {
    if (disposed) return;
    q('status').textContent = busy ? copy("Проверяем записи сна…") : sleepStatusText(status, copy.locale);
    const ready = status?.status === 'ready', permission = status?.status === 'permission_required';
    q('connect').hidden = !permission && !(ready && status.backgroundAvailable && !status.backgroundGranted);
    q('connect').textContent = ready ? copy("Разрешить чтение в фоне") : copy("Разрешить чтение сна");
    q('import').hidden = !ready && !['error', 'foreground_required', 'permission_requested'].includes(status?.status);
    q('retry').hidden = !!status && !['provider_unavailable', 'error'].includes(status.status);
    q('background').textContent = !ready ? '' : status.backgroundGranted
      ? copy("Фоновое чтение разрешено. Android определяет время запуска; обновление может задерживаться.")
      : status.backgroundAvailable ? copy("Фоновое чтение не разрешено. Пока сон проверяется при открытом приложении.")
      : copy("На этом телефоне Health Connect не поддерживает чтение в фоне. Сон проверяется при открытом Cicada.");
    const date = status?.lastSuccess ? new Date(status.lastSuccess) : null;
    q('success').textContent = date && Number.isFinite(date.getTime()) ? `${copy("Последняя проверка сна: ")}${date.toLocaleString(copy.locale)}` : '';
    q('history').hidden = !status?.historyLimited;
    q('history').textContent = copy("После перерыва повторно проверены последние 30 дней. Более ранние записи сохранены, но изменения в них пока не подтверждены источником.");
    element.querySelectorAll('button').forEach(button => { button.disabled = busy; });
  }
  async function perform(command) {
    if (busy || disposed) return;
    busy = true; setPending(true); render();
    try { const next = await invoke(command); if (!disposed) { status = next; announce(window, next); } }
    catch { if (!disposed) status = null; }
    finally { busy = false; if (!disposed) { setPending(false); render(); } }
  }
  q('connect').onclick = () => void perform('health_sleep_connect');
  q('import').onclick = () => void perform('health_sleep_import');
  q('retry').onclick = () => void perform('health_sleep_status');
  const onStatus = event => { if (!busy && !disposed) { status = event.detail; render(); } };
  window.addEventListener('hanni:sleep-status', onStatus);
  // Initial status lookup must not lock the surrounding settings form.
  void invoke('health_sleep_status').then(next => { if (!disposed && !busy) { status = next; render(); } })
    .catch(() => { if (!disposed && !busy) render(); });
  return () => { disposed = true; window.removeEventListener('hanni:sleep-status', onStatus); };
}

export function startSleepImport({ window, invoke, requestSync, requestRefresh }) {
  let busy = false, stopped = false, timer = null;
  const imported = () => { requestRefresh(); requestSync(); };
  async function check() {
    if (busy || stopped || window.document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const status = await invoke('health_sleep_import');
      if (stopped) return;
      announce(window, status);
      if (status?.status === 'unsupported') { dispose(); return; }
    } catch { if (!stopped) announce(window, { status: 'error' }); }
    finally { busy = false; }
  }
  const visible = () => { if (window.document.visibilityState === 'visible') void check(); };
  function dispose() {
    stopped = true; window.clearInterval(timer);
    window.document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('focus', visible);
    window.removeEventListener('hanni:sleep-imported', imported);
  }
  window.addEventListener('hanni:sleep-imported', imported);
  window.document.addEventListener('visibilitychange', visible);
  window.addEventListener('focus', visible);
  timer = window.setInterval(check, 60_000);
  void check();
  return dispose;
}
