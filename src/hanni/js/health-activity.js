function kindStatus(status, kind) {
  if (!status) return 'Не удалось проверить импорт. Повтори попытку.';
  if (status.status === 'unsupported') return 'Прогулки и шаги импортируются из Health Connect на телефоне Android и приходят сюда через синхронизацию.';
  if (status.status === 'provider_unavailable') return 'Health Connect недоступен. Установи или обнови его на телефоне.';
  if (status.status === 'permission_requested') return 'Заверши системный запрос Health Connect, затем проверь импорт. Разрешение ещё не подтверждено.';
  if (status.status === 'foreground_required') return `Для чтения ${kind === 'walking' ? 'прогулок' : 'шагов'} открой Hanni MVP на телефоне.`;
  if (status.status === 'error' || status.lastError) return `Последний импорт ${kind === 'walking' ? 'прогулок' : 'шагов'} не завершён. Сохранённые записи не потеряны; повтори попытку.`;
  const granted = kind === 'walking' ? status.walkingPermissionGranted : status.stepsPermissionGranted;
  const label = kind === 'walking' ? 'прогулки' : 'шаги';
  if (!granted) return `Разреши Hanni MVP читать ${label} в Health Connect. Ранее импортированные записи сохранены.`;
  if (status.status !== 'ready') return `Последний импорт ${label} не завершён. Сохранённые записи не потеряны; повтори попытку.`;
  const count = kind === 'walking' ? status.walkingRecords : status.stepsRecords;
  if (!status.lastSuccess) return `Доступ к ${label} разрешён. Первый импорт ещё не подтверждён.`;
  if (!count) return kind === 'walking'
    ? 'В Health Connect не найдено прогулок с типом walking. Hanni MVP не выводит прогулки из одних шагов.'
    : 'В Health Connect не найдено дневных итогов шагов. Пустой день не считается нулевым итогом.';
  return kind === 'walking' ? `Импортировано прогулок: ${count}.` : `Импортировано дневных итогов шагов: ${count}.`;
}

export function walkingStatusText(status) { return kindStatus(status, 'walking'); }
export function stepsStatusText(status) { return kindStatus(status, 'steps'); }

function announce(window, status) {
  window.dispatchEvent(new window.CustomEvent('hanni:health-activity-status', { detail: status }));
  if (status?.changed > 0) window.dispatchEvent(new window.Event('hanni:health-activity-imported'));
}

export function mountHealthActivitySettings(element, { invoke, setPending = () => {} }) {
  const window = element.ownerDocument.defaultView;
  let disposed = false, busy = false, status = null;
  element.className = 'calendar-setting';
  element.innerHTML = `<h3>Прогулки и шаги</h3>
    <section><h4>Прогулки</h4><p data-activity-walking-status role="status">Проверяем Health Connect…</p></section>
    <section><h4>Шаги</h4><p data-activity-steps-status role="status">Проверяем Health Connect…</p></section>
    <p data-activity-background></p><p data-activity-success></p><p data-activity-history hidden></p>
    <div class="calendar-sync-actions"><button type="button" data-activity-connect hidden>Разрешить чтение прогулок и шагов</button>
    <button type="button" data-activity-import hidden>Проверить прогулки и шаги сейчас</button><button type="button" data-activity-retry hidden>Повторить проверку</button></div>`;
  const q = key => element.querySelector(`[data-activity-${key}]`);
  function render() {
    if (disposed) return;
    q('walking-status').textContent = busy ? 'Проверяем прогулки…' : walkingStatusText(status);
    q('steps-status').textContent = busy ? 'Проверяем шаги…' : stepsStatusText(status);
    const ready = status?.status === 'ready', permission = status?.status === 'permission_required';
    const partial = ready && (!status.walkingPermissionGranted || !status.stepsPermissionGranted);
    q('connect').hidden = !permission && !partial && !(ready && status.backgroundAvailable && !status.backgroundGranted);
    q('connect').textContent = ready ? 'Разрешить недостающий доступ' : 'Разрешить чтение прогулок и шагов';
    q('import').hidden = !ready && !['error', 'foreground_required', 'permission_requested'].includes(status?.status);
    q('retry').hidden = !!status && !['provider_unavailable', 'error'].includes(status.status);
    q('background').textContent = !ready ? '' : status.backgroundGranted
      ? 'Фоновое чтение разрешено. Android определяет время запуска; обновление может задерживаться.'
      : status.backgroundAvailable ? 'Фоновое чтение не разрешено. Пока данные проверяются при открытом приложении.'
      : 'На этом телефоне Health Connect не поддерживает чтение в фоне. Данные проверяются при открытом Hanni MVP.';
    const date = status?.lastSuccess ? new Date(status.lastSuccess) : null;
    q('success').textContent = date && Number.isFinite(date.getTime()) ? `Последняя проверка прогулок и шагов: ${date.toLocaleString('ru-RU')}` : '';
    q('history').hidden = !status?.historyLimited;
    q('history').textContent = 'После перерыва повторно проверены последние 30 дней. Более ранние записи сохранены, но изменения в них пока не подтверждены источником.';
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
