import { mountSyncConflicts } from './sync-conflicts.js';

export function mountSyncSettings(element, { invoke, setPending = () => {} }) {
  const document = element.ownerDocument, window = document.defaultView;
  let status = null, busy = false, conflictBusy = false, disposed = false, dirty = false, revision = 0, errorFromStatus = false;
  element.className = 'calendar-sync-settings calendar-setting';
  element.innerHTML = `<h3>Синхронизация</h3>
    <p data-sync-status role="status">Загружаем состояние…</p><p data-sync-counts></p><p data-sync-success></p>
    <p class="calendar-sync-hint">Состояние этого устройства. Другое устройство получит изменения после своего подключения.</p>
    <p data-sync-error role="alert" hidden></p>
    <details data-sync-connect><summary>Код подключения</summary><label>Вставь код подключения устройства<input type="password" data-sync-code autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Код подключения устройства"></label><button type="button" data-sync-reveal aria-pressed="false">Показать код</button></details>
    <label class="calendar-settings-toggle"><input type="checkbox" data-sync-enabled disabled> Синхронизация включена</label>
    <div class="calendar-sync-actions"><button type="button" data-sync-save disabled>Сохранить подключение</button><button type="button" data-sync-cancel disabled>Отменить изменения</button><button type="button" data-sync-now disabled>Синхронизировать сейчас</button><button type="button" data-sync-retry hidden>Повторить загрузку</button></div>
    <details data-sync-conflicts><summary>Разобрать сохранённые версии</summary><div data-sync-conflicts-host></div></details>`;
  const q = name => element.querySelector(`[data-sync-${name}]`);
  const code = q('code'), enabled = q('enabled'), error = q('error');
  const updatePending = () => setPending(busy || conflictBusy);
  function clearCode() { code.value = ''; code.type = 'password'; q('reveal').textContent = 'Показать код'; q('reveal').setAttribute('aria-pressed', 'false'); }
  function render() {
    if (disposed) return;
    const offline = window.navigator.onLine === false;
    q('status').textContent = !status ? 'Состояние синхронизации недоступно.' : !status.configured ? 'Устройство ещё не подключено.' : !status.enabled ? 'Синхронизация выключена.' : status.running || busy ? 'Идёт обмен изменениями…' : offline ? 'Нет сети. Изменения остаются на этом устройстве.' : status.last_error ? 'Последний обмен не завершён. Изменения ожидают повторной попытки.' : 'Подключение включено.';
    q('counts').textContent = status ? `Ожидают отправки: ${status.pending ?? 0} · Конфликты: ${status.conflicts ?? 0}` : '';
    const errors = { content_sync_network_unavailable:'Сеть недоступна. Повторим обмен после подключения.', content_sync_http_401:'Код подключения больше не принят сервером.', content_sync_http_403:'Устройство не имеет доступа к обмену.', content_sync_http_426:'Для продолжения синхронизации обнови Hanni MVP на этом устройстве.', content_sync_http_429:'Сервер просит повторить попытку позже.', content_sync_http_507:'На сервере не хватает места для изменений.', mvp_sync_pairing_changed:'Подключение изменилось. Повтори обмен с текущим подключением.', mvp_sync_invalid_config:'Проверь код подключения.', mvp_sync_backup_failed:'Не удалось создать резервную копию перед включением синхронизации.' };
    if (status?.last_error && (error.hidden || errorFromStatus)) { error.textContent = errors[status.last_error] || 'Последний обмен завершился ошибкой. Локальные изменения сохранены.'; error.hidden = false; errorFromStatus = true; }
    else if (!status?.last_error && errorFromStatus) { error.hidden = true; errorFromStatus = false; }
    const success = status?.last_success ? new Date(status.last_success) : null;
    q('success').textContent = success && !Number.isNaN(success.getTime()) ? `Последний успешный обмен: ${success.toLocaleString('ru-RU')}` : 'Успешный обмен ещё не подтверждён.';
    const blocked = busy || conflictBusy;
    enabled.disabled = blocked || !status;
    q('save').disabled = blocked || !status || !dirty;
    q('cancel').disabled = blocked || !dirty;
    q('now').disabled = blocked || !status?.configured || !status.enabled || status.running === true;
    q('retry').hidden = !!status;
    code.disabled = blocked; q('reveal').disabled = blocked;
  }
  function accept(next) {
    if (!next || typeof next.configured !== 'boolean' || typeof next.enabled !== 'boolean') throw Error('status');
    status = next;
    if (!dirty) enabled.checked = status.configured ? status.enabled : true;
    render();
  }
  async function refresh() {
    const request = ++revision;
    try { const next = await invoke('mvp_sync_status'); if (!disposed && request === revision) accept(next); }
    catch { if (!disposed && request === revision) { error.textContent = 'Не удалось прочитать состояние синхронизации.'; error.hidden = false; render(); } }
  }
  async function perform(save) {
    if (busy || conflictBusy || disposed || !status) return;
    let configJson;
    if (save && code.value.trim()) {
      try {
        const config = JSON.parse(code.value);
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('config');
        configJson = JSON.stringify({ ...config, enabled: enabled.checked });
      } catch { error.textContent = 'Код подключения должен содержать JSON. Проверь, что он скопирован целиком.'; error.hidden = false; return; }
    }
    if (save && !configJson && !status.configured) { error.textContent = 'Вставь код подключения этого устройства.'; error.hidden = false; return; }
    busy = true; ++revision; error.hidden = true; errorFromStatus = false; updatePending(); render();
    try {
      const next = save ? configJson ? await invoke('mvp_sync_configure', { configJson }) : await invoke('mvp_sync_set_enabled', { enabled: enabled.checked }) : await invoke('mvp_sync_now');
      if (disposed) return;
      if (save) { clearCode(); dirty = false; q('connect').open = false; }
      accept(next);
      window.dispatchEvent(new window.Event('hanni:sync-check-status'));
    } catch {
      if (!disposed) { errorFromStatus = false; error.textContent = save ? 'Не удалось сохранить подключение. Проверь код и повтори попытку.' : 'Не удалось завершить обмен. Локальные изменения сохранены; повтори попытку при доступной сети.'; error.hidden = false; }
    } finally { configJson = undefined; busy = false; if (!disposed) { updatePending(); render(); } }
  }
  const conflicts = mountSyncConflicts(q('conflicts-host'), { invoke, isBlocked:() => busy, setPending:value => { conflictBusy = value; if (!disposed) { updatePending(); render(); } } });
  q('conflicts').addEventListener('toggle', () => { if (q('conflicts').open) void conflicts.refresh(); });
  code.addEventListener('input', () => { dirty = true; render(); });
  code.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
  enabled.addEventListener('change', () => { dirty = true; render(); });
  q('reveal').onclick = () => { const reveal = code.type === 'password'; code.type = reveal ? 'text' : 'password'; q('reveal').textContent = reveal ? 'Скрыть код' : 'Показать код'; q('reveal').setAttribute('aria-pressed', String(reveal)); };
  q('cancel').onclick = () => { clearCode(); dirty = false; error.hidden = true; if (status) enabled.checked = status.configured ? status.enabled : true; render(); };
  q('save').onclick = () => void perform(true); q('now').onclick = () => void perform(false); q('retry').onclick = () => void refresh();
  const onStatus = event => { if (disposed || busy) return; try { accept(event.detail); } catch { /* Ignore incomplete status events. */ } };
  window.addEventListener('hanni:sync-status', onStatus); window.addEventListener('online', render); window.addEventListener('offline', render);
  void refresh();
  return () => { disposed = true; ++revision; conflicts.dispose(); clearCode(); window.removeEventListener('hanni:sync-status', onStatus); window.removeEventListener('online', render); window.removeEventListener('offline', render); };
}
