import { IS_MOBILE, invoke } from './state.js';
import { createCalendarDialog } from './calendar-dialog.js';
import { escapeHtml } from './utils.js';
import { loadCalendarPreferences, saveCalendarPreferences } from './calendar-display-preferences.js';
import { mountSyncSettings } from './sync-settings.js';
import { mountSleepSettings } from './health-sleep.js';
import { mountHealthActivitySettings } from './health-activity.js';
import { mountAppUpdates } from './app-updates.js';
import { mountProcessSettings } from './calendar-process-settings.js';

let settingsDialog = null;

const OPTIONS = {
  first_day: [['mon', 'Понедельник'], ['sun', 'Воскресенье']],
  default_view: [['Месяц', 'Месяц'], ['Неделя', 'Неделя'], ['День', 'День']],
  density: [['comfortable', 'Обычная'], ['compact', 'Компактная']],
};

const SECTIONS = [
  { id: 'today', label: 'Сегодня' },
  { id: 'calendar', label: 'Календарь' },
  { id: 'processes', label: 'Этапы задач' },
  { id: 'connections', label: 'Подключения' },
  { id: 'about', label: 'О приложении' },
];

function samePreferences(a, b) {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

function sectionFor(section) {
  if (section === 'next-action') return 'today';
  if (section === 'processes') return 'processes';
  return SECTIONS.some(item => item.id === section) ? section : 'today';
}

export function showCalendarSettings(trigger, { section, returnFocus } = {}) {
  if (settingsDialog || document.querySelector('dialog[open]')) return;

  let original = null, draft = null, closed = false, disposeSync = null;
  let disposeUpdates = null, disposeSleep = null, disposeActivity = null;
  let processSettings = null, processObserver = null, preferencesLoading = true, preferencesLoadBusy = false;
  const requestedSection = sectionFor(section);
  const window = document.defaultView;

  const api = createCalendarDialog({
    document,
    title: 'Настройки Cicada',
    hint: 'Рекомендации и вид календаря сохраняются вместе. Этапы и подключения настраиваются отдельно.',
    submitLabel: 'Сохранить календарь',
    returnFocus: () => {
      if (returnFocus) { returnFocus(); return; }
      const target = IS_MOBILE ? document.getElementById('mobile-hamburger') : trigger;
      if (target?.isConnected) target.focus({ preventScroll: true });
    },
    onClose: () => {
      closed = true;
      processObserver?.disconnect();
      processSettings?.dispose();
      disposeSync?.(); disposeUpdates?.(); disposeSleep?.(); disposeActivity?.();
      settingsDialog = null;
    },
  });

  settingsDialog = api;
  api.modal.classList.add('calendar-settings-dialog');
  api.modal.querySelector('#' + api.modal.getAttribute('aria-labelledby')).textContent = 'Настройки Cicada';
  api.modal.querySelector('#' + api.modal.getAttribute('aria-describedby')).textContent = 'Рекомендации и вид календаря сохраняются вместе. Этапы и подключения настраиваются отдельно.';

  const nav = document.createElement('div');
  nav.className = 'calendar-settings-tabs';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', 'Разделы настроек');
  nav.setAttribute('aria-orientation', 'horizontal');

  const panels = document.createElement('div');
  panels.className = 'calendar-settings-panels';
  const hosts = {};
  const tabs = {};

  for (const item of SECTIONS) {
    const tab = document.createElement('button');
    tab.type = 'button'; tab.className = 'calendar-settings-tab';
    tab.id = `calendar-settings-tab-${item.id}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `calendar-settings-panel-${item.id}`);
    tab.textContent = item.label;
    nav.append(tab); tabs[item.id] = tab;

    const panel = document.createElement('section');
    panel.id = `calendar-settings-panel-${item.id}`;
    panel.className = 'calendar-settings-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.tabIndex = 0;
    panel.hidden = true;
    panels.append(panel); hosts[item.id] = panel;
  }

  api.body.classList.add('calendar-settings-body');
  api.body.append(nav, panels);
  api.form.classList.add('calendar-settings-form');
  api.modal.querySelector('.calendar-editor-header').classList.add('calendar-settings-header');
  api.modal.querySelector('.calendar-editor-feedback').classList.add('calendar-settings-feedback');
  api.modal.querySelector('.calendar-editor-actions').classList.add('calendar-settings-actions');
  const saveButton = api.submit;
  const cancelButton = api.modal.querySelector('.calendar-editor-actions [data-dialog-close]');
  cancelButton.textContent = 'Отмена';
  cancelButton.setAttribute('aria-label', 'Отмена и закрыть настройки');
  const prefsError = document.createElement('p');
  prefsError.className = 'calendar-settings-error';
  prefsError.dataset.prefsError = '';
  prefsError.setAttribute('role', 'alert');
  prefsError.hidden = true;
  const prefsRetry = document.createElement('button');
  prefsRetry.type = 'button'; prefsRetry.textContent = 'Повторить загрузку';
  prefsRetry.className = 'calendar-settings-retry'; prefsRetry.hidden = true;
  prefsRetry.dataset.prefsRetry = '';
  const prefsLoading = document.createElement('p');
  prefsLoading.className = 'calendar-settings-loading';
  prefsLoading.textContent = 'Загружаем настройки календаря…';
  prefsLoading.setAttribute('role', 'status'); prefsLoading.setAttribute('aria-live', 'polite');
  const prefsLoadState = document.createElement('div');
  prefsLoadState.className = 'calendar-settings-load-state';
  prefsLoadState.append(prefsLoading, prefsError, prefsRetry);

  function setActive(id, focus = false) {
    if (!tabs[id]) return;
    for (const item of SECTIONS) {
      const selected = item.id === id;
      tabs[item.id].setAttribute('aria-selected', String(selected));
      tabs[item.id].tabIndex = selected ? 0 : -1;
      hosts[item.id].hidden = !selected;
    }
    if (id === 'today' || id === 'calendar') hosts[id].append(prefsLoadState);
    if (focus) tabs[id].focus();
  }

  function preferenceDirty() { return !!draft && !samePreferences(draft, original); }
  function setPreferenceControlsEnabled(enabled) {
    preferencesLoading = !enabled;
    for (const root of [hosts.today, hosts.calendar]) {
      root.setAttribute('aria-busy', String(!enabled));
      root.querySelectorAll('input[data-key], .setting-pills [data-value]').forEach(control => { control.disabled = !enabled; });
    }
  }
  function updateRecommendationSources() {
    today.querySelector('[data-recommendation-sources]').querySelectorAll('input').forEach(source => {
      source.disabled = preferencesLoading || !draft?.recommendationsEnabled;
    });
  }
  function refreshFooter() {
    const dirty = preferenceDirty();
    saveButton.hidden = !dirty;
    saveButton.disabled = api.pending || !original;
    saveButton.textContent = 'Сохранить календарь';
    cancelButton.textContent = dirty || processSettings?.isDirty() ? 'Отмена' : 'Закрыть';
    api.modal.querySelector('.calendar-settings-actions').dataset.dirty = String(dirty || !!processSettings?.isDirty());
  }

  nav.addEventListener('click', event => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab || !nav.contains(tab)) return;
    setActive(tab.id.replace('calendar-settings-tab-', ''), false);
  });
  nav.addEventListener('keydown', event => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab) return;
    const index = SECTIONS.findIndex(item => tabs[item.id] === tab);
    let next = null;
    if (event.key === 'ArrowRight') next = SECTIONS[(index + 1) % SECTIONS.length].id;
    else if (event.key === 'ArrowLeft') next = SECTIONS[(index - 1 + SECTIONS.length) % SECTIONS.length].id;
    else if (event.key === 'Home') next = SECTIONS[0].id;
    else if (event.key === 'End') next = SECTIONS.at(-1).id;
    if (next) { event.preventDefault(); setActive(next, true); }
  });

  function requestClose() {
    if (api.pending) return;
    const dirty = preferenceDirty() || !!processSettings?.isDirty();
    if (dirty && !window.confirm('Есть несохранённые настройки. Закрыть и отбросить их?')) return;
    api.close({ skipBeforeClose: true });
  }
  const scheduleFooterRefresh = () => window.setTimeout(refreshFooter, 0);
  // Intercept both Escape and shell close buttons so dirty drafts are never silently lost.
  api.modal.addEventListener('cancel', event => {
    event.preventDefault(); event.stopImmediatePropagation(); requestClose();
  }, true);
  api.modal.addEventListener('click', event => {
    const close = event.target.closest('[data-dialog-close]');
    if (!close) return;
    event.preventDefault(); event.stopImmediatePropagation(); requestClose();
  }, true);

  const today = hosts.today;
  today.innerHTML = `<section data-next-action-settings>
    <h3>Рекомендация в «Сегодня»</h3>
    <p class="calendar-setting-hint">Одно действие по текущему времени, задачам и отметкам рутин. Запуск — только по твоему нажатию.</p>
    <label class="calendar-setting calendar-settings-toggle"><input type="checkbox" data-key="recommendationsEnabled"> Предлагать, чем заняться</label>
    <div class="calendar-settings-option-group" data-recommendation-sources>
      <label class="calendar-setting calendar-settings-toggle"><input type="checkbox" data-key="recommendTasks"> Задачи</label>
      <label class="calendar-setting calendar-settings-toggle"><input type="checkbox" data-key="recommendRoutines"> Рутины</label>
    </div>
  </section>
  <section class="calendar-settings-subsection">
    <h3>Отметки рутин</h3>
    <label class="calendar-setting calendar-settings-toggle"><input type="checkbox" data-key="showCompleted"> Раскрывать отмеченные рутины</label>
    <button type="button" class="text-button" data-recurring>Рутины и правила</button>
  </section>`;
  let lastEditedSection = requestedSection === 'today' ? 'today' : 'calendar';
  const settingsStatus = document.createElement('p');
  settingsStatus.className = 'calendar-settings-status';
  settingsStatus.dataset.settingsStatus = '';
  settingsStatus.setAttribute('role', 'status');
  settingsStatus.setAttribute('aria-live', 'polite');
  settingsStatus.hidden = true;
  today.querySelector('[data-next-action-settings]').append(prefsLoadState);

  const calendar = hosts.calendar;
  calendar.innerHTML = `<h3>Вид календаря</h3>
    <p class="calendar-setting-hint">Эти изменения сохраняются кнопкой «Сохранить календарь».</p>
    ${[['first_day','Первый день недели'],['default_view','Вид при запуске'],['density','Плотность интерфейса']].map(([key,label]) => `<fieldset class="calendar-setting"><legend>${label}</legend><div class="setting-pills" data-key="${key}">${OPTIONS[key].map(([value,text]) => `<button type="button" class="setting-pill" data-value="${value}" aria-pressed="false">${escapeHtml(text)}</button>`).join('')}</div></fieldset>`).join('')}`;

  hosts.processes.classList.add('calendar-settings-processes-host');
  hosts.connections.classList.add('calendar-settings-connections');
  hosts.about.classList.add('calendar-settings-about');
  const connectionsIntro = document.createElement('p');
  connectionsIntro.className = 'calendar-setting-hint';
  connectionsIntro.textContent = 'Каждое подключение применяется своими кнопками. Кнопка сохранения календаря на них не влияет.';
  hosts.connections.append(connectionsIntro);
  const sync = document.createElement('section'), sleep = document.createElement('section'), activity = document.createElement('section');
  hosts.connections.append(sync, sleep, activity);
  const updates = document.createElement('section');
  hosts.about.append(updates);

  const setInput = (key, value) => { const input = today.querySelector(`[data-key="${key}"]`); if (input) input.checked = value; };
  function drawPreferences() {
    for (const [key, value] of Object.entries(draft)) if (key !== 'version') setInput(key, value);
    for (const group of [today, calendar].flatMap(root => [...root.querySelectorAll('.setting-pills')])) {
      group.querySelectorAll('[data-value]').forEach(button => {
        const selected = draft[group.dataset.key] === button.dataset.value;
        button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
      });
    }
    setPreferenceControlsEnabled(true);
    updateRecommendationSources();
    refreshFooter();
  }

  today.querySelectorAll('input[data-key]').forEach(input => input.addEventListener('change', () => {
    if (!draft || preferencesLoading) return;
    lastEditedSection = 'today';
    draft[input.dataset.key] = input.checked;
    updateRecommendationSources();
    prefsError.hidden = true; refreshFooter();
  }));
  for (const group of [today, calendar].flatMap(root => [...root.querySelectorAll('.setting-pills')])) {
    group.addEventListener('click', event => {
      const button = event.target.closest('[data-value]');
      if (!button) return;
      if (!draft || preferencesLoading || button.disabled) return;
      lastEditedSection = group.closest('#calendar-settings-panel-today') ? 'today' : 'calendar';
      draft[group.dataset.key] = button.dataset.value;
      group.querySelectorAll('[data-value]').forEach(item => {
        const selected = item === button;
        item.classList.toggle('active', selected); item.setAttribute('aria-pressed', String(selected));
      });
      prefsError.hidden = true; refreshFooter();
    });
  }
  today.querySelector('[data-recurring]').addEventListener('click', () => {
    if ((preferenceDirty() || processSettings?.isDirty()) && !window.confirm('Есть несохранённые настройки. Закрыть и отбросить их?')) return;
    api.close({ skipBeforeClose: true });
    window.dispatchEvent(new window.CustomEvent('hanni:open-recurring-settings'));
  });
  prefsRetry.addEventListener('click', () => { void loadPreferences(); });

  api.form.addEventListener('submit', async event => {
    event.preventDefault();
    if (api.pending || !draft || !preferenceDirty()) return;
    api.setPending(true); prefsError.hidden = true;
    try {
      const saved = await saveCalendarPreferences(draft);
      if (closed) return;
      original = saved; draft = { ...saved };
      window.dispatchEvent(new window.CustomEvent('hanni:calendar-settings-changed', { detail: { changes: saved } }));
      api.setPending(false);
      if (processSettings?.isDirty()) {
        settingsStatus.textContent = 'Настройки календаря сохранены. Черновик этапов ещё не сохранён — сохрани его во вкладке «Этапы задач» или закрой настройки с отменой.';
        settingsStatus.hidden = false;
        setActive('processes', true);
      } else {
        api.close({ skipBeforeClose: true });
      }
    } catch (error) {
      if (closed) return;
      prefsError.textContent = `${error?.message || 'Ошибка сохранения.'} Сохранение календаря не подтверждено; черновик остался в форме.`;
      prefsError.hidden = false; setActive(lastEditedSection, true); prefsError.tabIndex = -1; prefsError.focus();
    } finally {
      if (!closed) { api.setPending(false); refreshFooter(); }
    }
  });

  setActive(requestedSection);
  saveButton.hidden = true;
  api.open(tabs[requestedSection]);
  processSettings = mountProcessSettings(hosts.processes, {
    invoke,
    setPending: value => { api.setPending(value); refreshFooter(); },
  });
  hosts.processes.append(settingsStatus);
  hosts.processes.addEventListener('input', scheduleFooterRefresh);
  hosts.processes.addEventListener('click', scheduleFooterRefresh);
  processObserver = new window.MutationObserver(scheduleFooterRefresh);
  processObserver.observe(hosts.processes, { childList: true, subtree: true, attributes: true });
  disposeSync = mountSyncSettings(sync, { invoke, setPending: value => api.setPending(value) });
  disposeSleep = mountSleepSettings(sleep, { invoke, setPending: value => api.setPending(value) });
  disposeActivity = mountHealthActivitySettings(activity, { invoke, setPending: value => api.setPending(value) });
  disposeUpdates = mountAppUpdates(updates, { invoke });
  setPreferenceControlsEnabled(false);
  async function loadPreferences() {
    if (closed || preferencesLoadBusy) return;
    preferencesLoadBusy = true;
    prefsError.hidden = true; prefsRetry.hidden = true; prefsLoading.hidden = false;
    saveButton.hidden = true; saveButton.disabled = true;
    setPreferenceControlsEnabled(false);
    try {
      const value = await loadCalendarPreferences();
      if (closed) return;
      original = { ...value }; draft = { ...value };
      preferencesLoadBusy = false;
      prefsLoading.hidden = true;
      prefsError.hidden = true; prefsRetry.hidden = true;
      preferencesLoading = false;
      drawPreferences();
    } catch (error) {
      if (closed) return;
      preferencesLoadBusy = false;
      preferencesLoading = true;
      prefsLoading.hidden = true;
      prefsError.textContent = error?.message || 'Не удалось загрузить настройки календаря.';
      prefsError.hidden = false; prefsRetry.hidden = false;
      saveButton.hidden = true; saveButton.disabled = true;
      setActive(['today', 'calendar'].includes(requestedSection) ? requestedSection : 'calendar');
      prefsError.tabIndex = -1; prefsError.focus();
    }
  }
  void loadPreferences();
}
