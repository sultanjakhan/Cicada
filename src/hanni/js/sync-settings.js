import { createUiCopy } from './ui-copy.js';
import { mountSyncConflicts } from './sync-conflicts.js';

export function mountSyncSettings(element, { invoke, setPending = () => {} }) {
  const document = element.ownerDocument, window = document.defaultView;
  const copy = createUiCopy(document);
  let status = null, busy = false, conflictBusy = false, disposed = false, dirty = false, revision = 0, errorFromStatus = false;
  element.className = 'calendar-sync-settings calendar-setting';
  element.innerHTML = `<h3>${copy("Синхронизация")}</h3>
    <p data-sync-status role="status">${copy("Загружаем состояние…")}</p><p data-sync-counts></p><p data-sync-success></p>
    <p class="calendar-sync-hint" data-sync-hint>${copy("Состояние этого устройства. Другое устройство получит изменения после своего подключения.")}</p>
    <p data-sync-error role="alert" hidden></p>
    <details data-sync-connect><summary>${copy("Код подключения")}</summary><label>${copy("Вставь код подключения устройства")}<input type="password" data-sync-code autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${copy("Код подключения устройства")}"></label><button type="button" data-sync-reveal aria-pressed="false">${copy("Показать код")}</button></details>
    <label class="calendar-settings-toggle"><input type="checkbox" data-sync-enabled disabled> ${copy("Синхронизация включена")}</label>
    <div class="calendar-sync-actions"><button type="button" data-sync-save disabled>${copy("Сохранить подключение")}</button><button type="button" data-sync-cancel disabled>${copy("Отменить изменения")}</button><button type="button" data-sync-now disabled>${copy("Синхронизировать сейчас")}</button><button type="button" data-sync-retry hidden>${copy("Повторить загрузку")}</button></div>
    <details data-sync-conflicts><summary>${copy("Разобрать сохранённые версии")}</summary><div data-sync-conflicts-host></div></details>`;
  const q = name => element.querySelector(`[data-sync-${name}]`);
  const code = q('code'), enabled = q('enabled'), error = q('error');
  const credentialError = copy("Нет доступа к сохранённому ключу синхронизации. Локальные данные сохранены. После восстановления доступа к хранилищу ключей перезапусти Cicada.");
  const credentialUnavailable = value => ['mvp_sync_credentials_unavailable', 'mvp_sync_credentials_write_failed'].includes(value);
  const updatePending = () => setPending(busy || conflictBusy);
  function clearCode() { code.value = ''; code.type = 'password'; q('reveal').textContent = copy("Показать код"); q('reveal').setAttribute('aria-pressed', 'false'); }
  function render() {
    if (disposed) return;
    const offline = window.navigator.onLine === false;
    const unpaired = status?.configured === false && !credentialUnavailable(status.last_error);
    q('connect').querySelector('summary').textContent = unpaired ? copy("Подключить устройство") : copy("Код подключения");
    q('counts').hidden = unpaired && !status.pending && !status.conflicts;
    q('success').hidden = unpaired && !status.last_success;
    q('hint').hidden = unpaired;
    enabled.closest('label').hidden = unpaired && !q('connect').open && !dirty;
    q('save').hidden = !dirty; q('cancel').hidden = !dirty;
    q('now').hidden = unpaired;
    q('conflicts').hidden = unpaired && !status.conflicts;
    q('status').textContent = !status ? copy("Состояние синхронизации недоступно.") : credentialUnavailable(status.last_error) ? copy("Синхронизация приостановлена: ключ подключения недоступен.") : !status.configured ? copy("Устройство ещё не подключено.") : !status.enabled ? copy("Синхронизация выключена.") : status.running || busy ? copy("Идёт обмен изменениями…") : offline ? copy("Нет сети. Изменения остаются на этом устройстве.") : status.last_error ? copy("Последний обмен не завершён. Изменения ожидают повторной попытки.") : copy("Подключение включено.");
    q('counts').textContent = status ? `${copy("Ожидают отправки: ")}${status.pending ?? 0}${copy(" · Конфликты: ")}${status.conflicts ?? 0}` : '';
    const errors = { content_sync_network_unavailable:copy("Сеть недоступна. Повторим обмен после подключения."), content_sync_http_401:copy("Код подключения больше не принят сервером."), content_sync_http_403:copy("Устройство не имеет доступа к обмену."), content_sync_http_426:copy("Для продолжения синхронизации обнови Cicada на этом устройстве."), content_sync_http_429:copy("Сервер просит повторить попытку позже."), content_sync_http_507:copy("На сервере не хватает места для изменений."), mvp_sync_pairing_changed:copy("Подключение изменилось. Повтори обмен с текущим подключением."), mvp_sync_invalid_config:copy("Проверь код подключения."), mvp_sync_backup_failed:copy("Не удалось создать резервную копию перед включением синхронизации."), mvp_sync_background_schedule_failed:copy("Не удалось включить фоновую синхронизацию. Повтори включение синхронизации.") };
    const statusError = status?.last_error || status?.background_error;
    if (statusError && (error.hidden || errorFromStatus)) { error.textContent = credentialUnavailable(statusError) ? credentialError : errors[statusError] || copy("Последний обмен завершился ошибкой. Локальные изменения сохранены."); error.hidden = false; errorFromStatus = true; }
    else if (!statusError && errorFromStatus) { error.hidden = true; errorFromStatus = false; }
    const success = status?.last_success ? new Date(status.last_success) : null;
    q('success').textContent = success && !Number.isNaN(success.getTime()) ? `${copy("Последний успешный обмен: ")}${success.toLocaleString(copy.locale)}` : copy("Успешный обмен ещё не подтверждён.");
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
    catch { if (!disposed && request === revision) { error.textContent = copy("Не удалось прочитать состояние синхронизации."); error.hidden = false; render(); } }
  }
  async function perform(save) {
    if (busy || conflictBusy || disposed || !status) return;
    let configJson;
    if (save && code.value.trim()) {
      try {
        const config = JSON.parse(code.value);
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('config');
        configJson = JSON.stringify({ ...config, enabled: enabled.checked });
      } catch { error.textContent = copy("Код подключения должен содержать JSON. Проверь, что он скопирован целиком."); error.hidden = false; return; }
    }
    if (save && !configJson && !status.configured) { error.textContent = copy("Вставь код подключения этого устройства."); error.hidden = false; return; }
    busy = true; ++revision; error.hidden = true; errorFromStatus = false; updatePending(); render();
    try {
      const next = save ? configJson ? await invoke('mvp_sync_configure', { configJson }) : await invoke('mvp_sync_set_enabled', { enabled: enabled.checked }) : await invoke('mvp_sync_now');
      if (disposed) return;
      if (save) { clearCode(); dirty = false; q('connect').open = false; }
      accept(next);
      window.dispatchEvent(new window.Event('hanni:sync-check-status'));
    } catch (cause) {
      if (!disposed) { errorFromStatus = false; error.textContent = credentialUnavailable(typeof cause === 'string' ? cause : cause?.message) ? credentialError : save ? copy("Не удалось сохранить подключение. Проверь код и повтори попытку.") : copy("Не удалось завершить обмен. Локальные изменения сохранены; повтори попытку при доступной сети."); error.hidden = false; }
    } finally { configJson = undefined; busy = false; if (!disposed) { updatePending(); render(); } }
  }
  const conflicts = mountSyncConflicts(q('conflicts-host'), { invoke, isBlocked:() => busy, setPending:value => { conflictBusy = value; if (!disposed) { updatePending(); render(); } } });
  q('connect').addEventListener('toggle', render);
  q('conflicts').addEventListener('toggle', () => { if (q('conflicts').open) void conflicts.refresh(); });
  code.addEventListener('input', () => { dirty = true; render(); });
  code.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
  enabled.addEventListener('change', () => { dirty = true; render(); });
  q('reveal').onclick = () => { const reveal = code.type === 'password'; code.type = reveal ? 'text' : 'password'; q('reveal').textContent = reveal ? copy("Скрыть код") : copy("Показать код"); q('reveal').setAttribute('aria-pressed', String(reveal)); };
  q('cancel').onclick = () => { clearCode(); dirty = false; error.hidden = true; if (status) enabled.checked = status.configured ? status.enabled : true; render(); };
  q('save').onclick = () => void perform(true); q('now').onclick = () => void perform(false); q('retry').onclick = () => void refresh();
  const onStatus = event => { if (disposed || busy) return; try { accept(event.detail); } catch { /* Ignore incomplete status events. */ } };
  window.addEventListener('hanni:sync-status', onStatus); window.addEventListener('online', render); window.addEventListener('offline', render);
  void refresh();
  const dispose = () => { disposed = true; ++revision; dirty = false; conflicts.dispose(); clearCode(); window.removeEventListener('hanni:sync-status', onStatus); window.removeEventListener('online', render); window.removeEventListener('offline', render); };
  dispose.isDirty = () => dirty;
  return dispose;
}
