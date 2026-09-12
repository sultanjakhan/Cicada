import { IS_MOBILE, TAB_SETTINGS_DEFS, loadTabSetting, saveTabSetting } from './state.js';
import { createCalendarDialog } from './calendar-dialog.js';
import { escapeHtml } from './utils.js';

let settingsDialog = null;

export function showCalendarSettings(trigger) {
  if (settingsDialog || document.querySelector('dialog[open]')) return;
  let closed = false;
  const changes = {};
  const api = createCalendarDialog({
    document, title:'Настройки календаря', hint:'Изменения сохраняются автоматически.',
    returnFocus:() => {
      const target = IS_MOBILE ? document.getElementById('mobile-hamburger') : trigger;
      if (target?.isConnected) target.focus({ preventScroll:true });
    },
    onClose:() => {
      closed = true; settingsDialog = null;
      if (Object.keys(changes).length) window.dispatchEvent(new CustomEvent('hanni:calendar-settings-changed', { detail:changes }));
    },
  });
  settingsDialog = api;
  api.modal.classList.add('calendar-settings-dialog');
  api.modal.querySelector('.calendar-editor-actions [data-dialog-close]').textContent = 'Готово';
  const status = document.createElement('p');
  status.className = 'calendar-settings-status'; status.setAttribute('role', 'status');
  api.body.after(status);
  const current = () => !closed && api.modal.isConnected && api.modal.open;

  async function load() {
    status.textContent = 'Загрузка настроек…'; api.retry.hidden = true; api.showError('');
    try {
      const values = await Promise.all(TAB_SETTINGS_DEFS.calendar.map(async def => [def, (await loadTabSetting('calendar', def.key)) ?? def.default]));
      if (!current()) return;
      api.body.innerHTML = values.map(([def, value]) => `<fieldset class="calendar-setting"><legend>${escapeHtml(def.label)}</legend><div class="setting-pills" data-setting-key="${def.key}">${def.options.map(option => `<button class="setting-pill${value === option.value ? ' active' : ''}" type="button" data-value="${escapeHtml(option.value)}" aria-pressed="${value === option.value}">${escapeHtml(option.label)}</button>`).join('')}</div>${def.key === 'default_view' ? '<p class="calendar-settings-hint">При следующем запуске приложения.</p>' : ''}</fieldset>`).join('');
      status.textContent = '';
      api.body.querySelectorAll('.setting-pills').forEach(group => group.addEventListener('click', async event => {
        const pill = event.target.closest('[data-value]');
        if (!pill || api.pending || pill.getAttribute('aria-pressed') === 'true') return;
        api.setPending(true); api.showError(''); status.textContent = 'Сохранение…';
        try {
          await saveTabSetting('calendar', group.dataset.settingKey, pill.dataset.value);
          if (!current()) return;
          changes[group.dataset.settingKey] = pill.dataset.value;
          group.querySelectorAll('[data-value]').forEach(button => {
            button.classList.toggle('active', button === pill);
            button.setAttribute('aria-pressed', String(button === pill));
          });
          status.textContent = 'Сохранено';
        } catch {
          if (current()) { status.textContent = ''; api.showError('Не удалось сохранить настройку. Повтори выбор.'); }
        } finally { if (current()) api.setPending(false); }
      }));
    } catch {
      if (current()) { status.textContent = ''; api.showError('Не удалось загрузить настройки. Попробуй ещё раз.'); api.retry.hidden = false; }
    }
  }
  api.retry.addEventListener('click', load);
  api.open(); void load();
}
