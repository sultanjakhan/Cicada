import { createUiCopy, copyForLanguage } from './ui-copy.js';
function kindStatus(status, kind, language = 'ru') {
  const copy=copyForLanguage(language);
  if (!status) return copy("Не удалось проверить импорт. Повтори попытку.");
  if (status.status === 'unsupported') return copy("Прогулки и шаги импортируются из Health Connect на телефоне Android и приходят сюда через синхронизацию.");
  if (status.status === 'provider_unavailable') return copy("Health Connect недоступен. Установи или обнови его на телефоне.");
  if (status.status === 'permission_requested') return copy("Заверши системный запрос Health Connect, затем проверь импорт. Разрешение ещё не подтверждено.");
  if (status.status === 'foreground_required') return `${copy("Для чтения ")}${kind === 'walking' ? copy("прогулок") : copy("шагов")}${copy(" открой Cicada на телефоне.")}`;
  if (status.status === 'error' || status.lastError) return `${copy("Последний импорт ")}${kind === 'walking' ? copy("прогулок") : copy("шагов")}${copy(" не завершён. Сохранённые записи не потеряны; повтори попытку.")}`;
  const granted = kind === 'walking' ? status.walkingPermissionGranted : status.stepsPermissionGranted;
  const label = kind === 'walking' ? copy("прогулки") : copy("шаги");
  if (!granted) return `${copy("Разреши Cicada читать ")}${label}${copy(" в Health Connect. Ранее импортированные записи сохранены.")}`;
  if (status.status !== 'ready') return `${copy("Последний импорт ")}${label}${copy(" не завершён. Сохранённые записи не потеряны; повтори попытку.")}`;
  const count = kind === 'walking' ? status.walkingRecords : status.stepsRecords;
  const lastSuccess = kind === 'walking' ? status.walkingLastSuccess : status.stepsLastSuccess;
  if (!lastSuccess) return `${copy("Доступ к ")}${label}${copy(" разрешён. Первый импорт ещё не подтверждён.")}`;
  if (!count) return kind === 'walking'
    ? copy("В Health Connect не найдено прогулок с типом walking. Cicada не выводит прогулки из одних шагов.")
    : copy("В Health Connect не найдено дневных итогов шагов. Пустой день не считается нулевым итогом.");
  return kind === 'walking' ? `${copy("Импортировано прогулок: ")}${count}.` : `${copy("Импортировано дневных итогов шагов: ")}${count}.`;
}

export function walkingStatusText(status, language = 'ru') { return kindStatus(status, 'walking', language); }
export function stepsStatusText(status, language = 'ru') { return kindStatus(status, 'steps', language); }

function announce(window, status) {
  window.dispatchEvent(new window.CustomEvent('hanni:health-activity-status', { detail: status }));
  if (status?.changed > 0) window.dispatchEvent(new window.Event('hanni:health-activity-imported'));
}

export function mountHealthActivitySettings(element, { invoke, setPending = () => {} }) {
  const window = element.ownerDocument.defaultView;
  const copy=createUiCopy(element.ownerDocument);
  let disposed = false, busy = false, status = null;
  element.className = 'calendar-setting';
  element.innerHTML = `<h3>${copy("Прогулки и шаги")}</h3>
    <p data-activity-remote role="status" hidden></p>
    <section data-activity-walking><h4>${copy("Прогулки")}</h4><p data-activity-walking-status role="status">${copy("Проверяем Health Connect…")}</p></section>
    <section data-activity-steps><h4>${copy("Шаги")}</h4><p data-activity-steps-status role="status">${copy("Проверяем Health Connect…")}</p></section>
    <p data-activity-background></p><p data-activity-success></p><p data-activity-history hidden></p>
    <div class="calendar-sync-actions"><button type="button" data-activity-connect hidden>${copy("Разрешить чтение прогулок и шагов")}</button>
    <button type="button" data-activity-import hidden>${copy("Проверить прогулки и шаги сейчас")}</button><button type="button" data-activity-retry hidden>${copy("Повторить проверку")}</button></div>`;
  const q = key => element.querySelector(`[data-activity-${key}]`);
  function render() {
    if (disposed) return;
    const remote = status?.status === 'unsupported';
    q('remote').hidden = !remote;
    q('remote').textContent = remote ? walkingStatusText(status, copy.locale) : '';
    q('walking').hidden = remote; q('steps').hidden = remote;
    q('walking-status').textContent = busy ? copy("Проверяем прогулки…") : walkingStatusText(status, copy.locale);
    q('steps-status').textContent = busy ? copy("Проверяем шаги…") : stepsStatusText(status, copy.locale);
    const ready = status?.status === 'ready', permission = status?.status === 'permission_required';
    const partial = ready && (!status.walkingPermissionGranted || !status.stepsPermissionGranted);
    q('connect').hidden = !permission && !partial && !(ready && status.backgroundAvailable && !status.backgroundGranted);
    q('connect').textContent = ready ? copy("Разрешить недостающий доступ") : copy("Разрешить чтение прогулок и шагов");
    q('import').hidden = !ready && !['error', 'foreground_required', 'permission_requested'].includes(status?.status);
    q('retry').hidden = !!status && !['provider_unavailable', 'error'].includes(status.status);
    q('background').textContent = !ready ? '' : status.backgroundGranted
      ? copy("Фоновое чтение разрешено. Android определяет время запуска; обновление может задерживаться.")
      : status.backgroundAvailable ? copy("Фоновое чтение не разрешено. Пока данные проверяются при открытом приложении.")
      : copy("На этом телефоне Health Connect не поддерживает чтение в фоне. Данные проверяются при открытом Cicada.");
    const date = status?.lastSuccess ? new Date(status.lastSuccess) : null;
    q('success').textContent = date && Number.isFinite(date.getTime()) ? `${copy("Последняя проверка прогулок и шагов: ")}${date.toLocaleString(copy.locale)}` : '';
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
  q('connect').onclick = () => void perform('health_activity_connect');
  q('import').onclick = () => void perform('health_activity_import');
  q('retry').onclick = () => void perform('health_activity_status');
  const onStatus = event => { if (!busy && !disposed) { status = event.detail; render(); } };
  window.addEventListener('hanni:health-activity-status', onStatus);
  void invoke('health_activity_status').then(next => { if (!disposed && !busy) { status = next; render(); } })
    .catch(() => { if (!disposed && !busy) render(); });
  return () => { disposed = true; window.removeEventListener('hanni:health-activity-status', onStatus); };
}

export function startHealthActivityImport({ window, invoke, requestSync, requestRefresh }) {
  let busy = false, stopped = false, timer = null;
  const imported = () => { requestRefresh(); requestSync(); };
  async function check() {
    if (busy || stopped || window.document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const status = await invoke('health_activity_import');
      if (stopped) return;
      announce(window, status);
      if (status?.status === 'unsupported') dispose();
    } catch { if (!stopped) announce(window, { status: 'error' }); }
    finally { busy = false; }
  }
  const visible = () => { if (window.document.visibilityState === 'visible') void check(); };
  function dispose() {
    stopped = true; window.clearInterval(timer);
    window.document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible);
    window.removeEventListener('hanni:health-activity-imported', imported);
  }
  window.addEventListener('hanni:health-activity-imported', imported);
  window.document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible);
  timer = window.setInterval(check, 60_000); void check();
  return dispose;
}
