const offeredPhases = new Set(['available', 'prepared', 'deferred', 'permission_required', 'confirmation_required', 'manual_required', 'installer_opened']);
export const isOfferableUpdate = status => status?.configured && typeof status.version === 'string' && status.version.length > 0 && offeredPhases.has(status.phase);

// The offer never requests focus. System windows require a button click.
export function createSoftUpdateNotice(window, { invoke, safe = () => true }) {
  let status, host, busy = false, nativeBusy = false, disposed = false;
  function hide() { host?.remove(); host = null; }
  async function install() {
    if (busy || nativeBusy || disposed || !safe()) return;
    busy = true; render();
    try {
      const command = status.phase === 'confirmation_required' ? 'mvp_update_confirm'
        : status.phase === 'permission_required' ? 'mvp_update_open_permission' : 'mvp_update_install';
      const result = await invoke(command, command === 'mvp_update_install' ? { expectedVersion: status.version } : undefined);
      if (disposed) return;
      if (result) status = result;
      else status = { ...status, phase: 'available' };
    } catch (error) {
      if (!disposed) status = { ...status, error: String(error?.message || error) };
    } finally { busy = false; if (!disposed) render(); }
  }
  function render() {
    if (!host || disposed) return;
    if (!isOfferableUpdate(status)) { hide(); return; }
    const text = status.error || (!safe() ? 'Сохрани изменения, чтобы обновиться.'
      : status.phase === 'prepared' ? 'Загружено и готово к установке.'
      : status.phase === 'permission_required' ? 'Разреши Android установить обновление.'
      : status.phase === 'confirmation_required' ? 'Подтверди установку в Android.'
      : 'Установи сейчас или вернись к этому позже.');
    const label = host.querySelector('[data-soft-update-text]');
    if (label.textContent !== text) label.textContent = text;
    const button = host.querySelector('[data-soft-update-install]');
    const version = host.querySelector('[data-soft-update-version]');
    if (version.textContent !== status.version) version.textContent = status.version;
    const action = busy || nativeBusy ? 'Подготовка…' : status.phase === 'confirmation_required' ? 'Подтвердить'
      : status.phase === 'permission_required' ? 'Разрешить' : status.error ? 'Повторить' : 'Обновить';
    if (button.textContent !== action) button.textContent = action;
    button.disabled = busy || nativeBusy || !safe();
    host.querySelector('[data-soft-update-later]').disabled = busy;
  }
  return {
    show(next) {
      if (disposed || window.document.visibilityState === 'hidden' || !isOfferableUpdate(next)) return false;
      status = next;
      if (!host) {
        host = window.document.createElement('section');
        host.className = 'calendar-soft-update';
        host.setAttribute('aria-label', 'Обновление Cicada');
        host.innerHTML = '<div class="calendar-soft-update-heading" role="status"><span class="calendar-soft-update-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 4v10m-4-4 4 4 4-4M5 16v4h14v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><div class="calendar-soft-update-title">Обновление Cicada <span data-soft-update-version></span></div><p data-soft-update-text></p></div><div class="calendar-soft-update-actions"><button type="button" data-soft-update-install>Обновить</button><button type="button" data-soft-update-later>Позже</button></div>';
        host.querySelector('[data-soft-update-install]').onclick = () => void install();
        host.querySelector('[data-soft-update-later]').onclick = hide;
        window.document.body.appendChild(host);
      }
      render(); return true;
    },
    update(next) {
      nativeBusy = ['checking', 'downloading', 'installing'].includes(next?.phase);
      if (host) {
        if (next?.phase === 'installing') { hide(); return; }
        if (!nativeBusy) status = next;
        render();
      }
    },
    refresh: render,
    hide,
    dispose() { disposed = true; hide(); },
  };
}
