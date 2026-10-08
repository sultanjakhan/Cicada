import { applySavedLanguage } from './language-preference.js';
import { createUiCopy } from './ui-copy.js';
import { IS_MOBILE, S, invoke, setTheme } from './state.js';
import { createCalendarDialog } from './calendar-dialog.js';
import { escapeHtml } from './utils.js';
import { loadCalendarPreferences, saveCalendarPreferences, saveRecommendationPreferences } from './calendar-display-preferences.js';
import { mountSyncSettings } from './sync-settings.js';
import { mountSleepSettings } from './health-sleep.js';
import { mountHealthActivitySettings } from './health-activity.js';
import { mountAppUpdates } from './app-updates.js';
import { mountProcessSettings } from './calendar-process-settings.js';
import { mountWorkRegistry } from './work-registry-view.js';
import { mountDataSources } from './data-sources.js';
import { mountPersonalTaskImport } from './personal-task-import-view.js';
import { mountDataLocation } from './data-location.js';

let settingsDialog = null;

const OPTIONS = {
  language: [['ru', 'Русский'], ['en', 'English']],
  first_day: [['mon', 'Понедельник'], ['sun', 'Воскресенье']],
  default_view: [['Месяц', 'Месяц'], ['Неделя', 'Неделя'], ['День', 'День']],
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

export function showCalendarSettings(trigger, { section, returnFocus, recommendationsOnly = false } = {}) {
  if (settingsDialog || document.querySelector('dialog[open]')) return;
  const copy = createUiCopy(document);
  const preferenceErrorCopy = value => {
    const match = /^Настройка «([^»]+)» изменилась(?: на другом устройстве)?\. Закрой и открой настройки, чтобы загрузить актуальные значения\.$/.exec(value);
    return match ? copy.format('Настройка «{0}» изменилась. Закрой и открой настройки, чтобы загрузить актуальные значения.', copy(match[1])) : copy(value);
  };

  let original = null, draft = null, closed = false, disposeSync = null;
  let disposeUpdates = null, disposeSleep = null, disposeActivity = null, disposeRegistry = null, disposeSources = null, disposePersonalImport = null, disposeDataLocation = null;
  let processSettings = null, processObserver = null, preferencesLoading = true, preferencesLoadBusy = false;
  let savedLanguageChanged = false;
  const requestedSection = recommendationsOnly ? 'today' : sectionFor(section);
  const title = recommendationsOnly ? copy("Выбор следующего действия") : copy("Настройки Cicada");
  const window = document.defaultView;

  const api = createCalendarDialog({
    document,
    title,
    hint: '',
    submitLabel: recommendationsOnly ? copy("Сохранить") : copy("Сохранить календарь"),
    returnFocus: () => {
      if (returnFocus) { returnFocus(); return; }
      const target = IS_MOBILE ? document.getElementById('mobile-hamburger') : trigger;
      if (target?.isConnected) target.focus({ preventScroll: true });
    },
    onClose: () => {
      closed = true;
      document.removeEventListener('keydown', onSettingsEscape);
      processObserver?.disconnect();
      processSettings?.dispose();
      disposeSync?.(); disposeUpdates?.(); disposeSleep?.(); disposeActivity?.(); disposeRegistry?.(); disposeSources?.(); disposePersonalImport?.(); disposeDataLocation?.();
      settingsDialog = null;
      if (savedLanguageChanged) window.dispatchEvent(new window.Event('hanni:language-changed'));
    },
  });

  settingsDialog = api;
  api.modal.classList.add('calendar-settings-dialog');
  api.modal.querySelector('#' + api.modal.getAttribute('aria-labelledby')).textContent = title;
  api.modal.querySelector('#' + api.modal.getAttribute('aria-describedby')).textContent = '';

  const nav = document.createElement('div');
  nav.className = 'calendar-settings-tabs';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', copy("Разделы настроек"));
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
    tab.textContent = copy(item.label);
    nav.append(tab); tabs[item.id] = tab;

    const panel = document.createElement('section');
    panel.id = `calendar-settings-panel-${item.id}`;
    panel.className = 'calendar-settings-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.tabIndex = 0;
    panel.hidden = true;
    if (!recommendationsOnly || item.id === 'today') panels.append(panel);
    hosts[item.id] = panel;
  }

  api.body.classList.add('calendar-settings-body');
  if (!recommendationsOnly) api.body.append(nav);
  else {
    api.modal.classList.add('calendar-settings-dialog--recommendations');
    hosts.today.removeAttribute('aria-labelledby');
    hosts.today.setAttribute('role', 'region');
    hosts.today.setAttribute('aria-label', title);
  }
  api.body.append(panels);
  api.form.classList.add('calendar-settings-form');
  api.modal.querySelector('.calendar-editor-header').classList.add('calendar-settings-header');
  api.modal.querySelector('.calendar-editor-feedback').classList.add('calendar-settings-feedback');
  api.modal.querySelector('.calendar-editor-actions').classList.add('calendar-settings-actions');
  const saveButton = api.submit;
  const cancelButton = api.modal.querySelector('.calendar-editor-actions [data-dialog-close]');
  const closeButtons = [...api.modal.querySelectorAll('[data-dialog-close]')];
  const footerButtons = [...api.modal.querySelectorAll('.calendar-editor-actions button')];
  const feedback = api.modal.querySelector('.calendar-editor-feedback');
  cancelButton.textContent = copy("Отмена");
  cancelButton.setAttribute('aria-label', copy("Отмена и закрыть настройки"));
  const prefsError = document.createElement('p');
  prefsError.className = 'calendar-settings-error';
  prefsError.dataset.prefsError = '';
  prefsError.setAttribute('role', 'alert');
  prefsError.hidden = true;
  const prefsRetry = document.createElement('button');
  prefsRetry.type = 'button'; prefsRetry.textContent = copy("Повторить загрузку");
  prefsRetry.className = 'calendar-settings-retry'; prefsRetry.hidden = true;
  prefsRetry.dataset.prefsRetry = '';
  const prefsLoading = document.createElement('p');
  prefsLoading.className = 'calendar-settings-loading';
  prefsLoading.textContent = recommendationsOnly ? copy("Загружаем настройки выбора…") : copy("Загружаем настройки календаря…");
  prefsLoading.setAttribute('role', 'status'); prefsLoading.setAttribute('aria-live', 'polite');
  const prefsLoadState = document.createElement('div');
  prefsLoadState.className = 'calendar-settings-load-state';
  prefsLoadState.append(prefsLoading, prefsError, prefsRetry);
  let closeIntent = null, focusAfterConfirmation = null;
  const closeConfirmation = document.createElement('div');
  closeConfirmation.className = 'calendar-settings-confirmation';
  closeConfirmation.dataset.closeConfirmation = '';
  closeConfirmation.setAttribute('role', 'group');
  closeConfirmation.setAttribute('aria-label', copy("Подтверждение закрытия с несохранёнными изменениями"));
  closeConfirmation.hidden = true;
  const closeMessage = document.createElement('p');
  closeMessage.textContent = copy("Есть несохранённые изменения.");
  const continueEditing = document.createElement('button');
  continueEditing.type = 'button'; continueEditing.textContent = copy("Продолжить редактирование");
  const discardAndClose = document.createElement('button');
  discardAndClose.type = 'button'; discardAndClose.textContent = copy("Закрыть без сохранения");
  closeConfirmation.append(closeMessage, continueEditing, discardAndClose);
  feedback.prepend(closeConfirmation);

  function setActive(id, focus = false) {
    if (!tabs[id]) return;
    for (const item of SECTIONS) {
      const selected = item.id === id;
      tabs[item.id].setAttribute('aria-selected', String(selected));
      tabs[item.id].tabIndex = selected ? 0 : -1;
      hosts[item.id].hidden = !selected;
    }
    if (id === 'today' || id === 'calendar') hosts[id].append(prefsLoadState);
    tabs[id].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (focus) tabs[id].focus();
  }

  function preferenceDirty() { return !!draft && !samePreferences(draft, original); }
  function hasUnsavedChanges() { return preferenceDirty() || !!processSettings?.isDirty() || !!disposeSync?.isDirty?.(); }
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
    saveButton.disabled = api.pending || !original || !closeConfirmation.hidden;
    saveButton.textContent = recommendationsOnly ? copy("Сохранить") : copy("Сохранить календарь");
    cancelButton.textContent = hasUnsavedChanges() ? copy("Отмена") : copy("Закрыть");
    api.modal.querySelector('.calendar-settings-actions').dataset.dirty = String(hasUnsavedChanges());
    if (!settingsStatus.hidden && !processSettings?.isDirty() && !disposeSync?.isDirty?.()) settingsStatus.hidden = true;
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

  function finishClose(intent) {
    if (api.pending) return;
    closeConfirmation.hidden = true;
    closeIntent = null;
    api.body.removeAttribute('inert');
    closeButtons.forEach(button => { button.disabled = api.pending; });
    footerButtons.forEach(button => { button.disabled = api.pending; });
    const openRoutines = intent === 'routines';
    api.close({ skipBeforeClose: true });
    if (openRoutines) window.dispatchEvent(new window.CustomEvent('hanni:open-recurring-settings'));
  }
  function dismissCloseConfirmation() {
    if (closeConfirmation.hidden) return false;
    closeConfirmation.hidden = true;
    closeIntent = null;
    api.body.removeAttribute('inert');
    closeButtons.forEach(button => { button.disabled = api.pending; });
    footerButtons.forEach(button => { button.disabled = api.pending; });
    const target = focusAfterConfirmation;
    focusAfterConfirmation = null;
    if (target?.isConnected && !target.disabled) target.focus({ preventScroll: true });
    else tabs[SECTIONS.find(item => tabs[item.id].getAttribute('aria-selected') === 'true')?.id]?.focus();
    return true;
  }
  function requestClose(intent = 'close') {
    if (api.pending) return;
    if (!closeConfirmation.hidden) { dismissCloseConfirmation(); return; }
    const dirty = hasUnsavedChanges();
    if (!dirty) { finishClose(intent); return; }
    closeIntent = intent;
    focusAfterConfirmation = document.activeElement;
    closeMessage.textContent = copy("Есть несохранённые изменения.");
    closeConfirmation.hidden = false;
    api.body.setAttribute('inert', '');
    closeButtons.forEach(button => { button.disabled = true; });
    footerButtons.forEach(button => { button.disabled = true; });
    continueEditing.focus({ preventScroll: true });
  }
  const scheduleFooterRefresh = () => window.queueMicrotask(() => { if (!closed) refreshFooter(); });
  // Prevent Escape's native close request before the browser can send a
  // noncancelable second cancel event. Listen on document because pending
  // controls may leave focus on body; nested dialogs keep their own Escape.
  function onSettingsEscape(event) {
    if (closed || !api.modal.open || event.key !== 'Escape' || event.defaultPrevented) return;
    if ([...document.querySelectorAll('dialog[open]')].some(dialog => dialog !== api.modal)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.repeat || event.isComposing || api.pending) return;
    if (!dismissCloseConfirmation()) requestClose();
  }
  document.addEventListener('keydown', onSettingsEscape);
  // Keep cancel as a fallback for close requests that are not keyboard events.
  api.modal.addEventListener('cancel', event => {
    if (event.target !== api.modal) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!dismissCloseConfirmation()) requestClose();
  }, true);
  api.modal.addEventListener('click', event => {
    const close = event.target.closest('[data-dialog-close]');
    if (!close || close.closest('dialog') !== api.modal) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!dismissCloseConfirmation()) requestClose();
  }, true);
  continueEditing.addEventListener('click', dismissCloseConfirmation);
  discardAndClose.addEventListener('click', () => finishClose(closeIntent));

  const today = hosts.today;
  today.innerHTML = `<section data-next-action-settings>
    <h3>${copy("Рекомендация в «Сегодня»")}</h3>
    <p class="calendar-setting-hint">${copy("Учитываем текущую работу, даты и важность задач, время суток и отметки рутин. Запуск — только по твоему нажатию.")}</p>
    <label class="calendar-setting calendar-settings-toggle"><input type="checkbox" data-key="recommendationsEnabled"> ${copy("Предлагать, чем заняться")}</label>
    <div class="calendar-settings-option-group" data-recommendation-sources>
      <label class="calendar-setting calendar-settings-toggle"><input type="checkbox" data-key="recommendTasks"> ${copy("Задачи")}</label>
      <label class="calendar-setting calendar-settings-toggle"><input type="checkbox" data-key="recommendRoutines"> ${copy("Рутины")}</label>
    </div>
  </section>
  <section class="calendar-settings-subsection">
    <h3>${copy("Отметки рутин")}</h3>
    <label class="calendar-setting calendar-settings-toggle"><input type="checkbox" data-key="showCompleted"> ${copy("Раскрывать отмеченные рутины")}</label>
    <button type="button" class="text-button" data-recurring>${copy("Рутины и правила")}</button>
  </section>`;
  if (recommendationsOnly) {
    today.querySelector('h3').remove();
    today.querySelector('.calendar-settings-subsection').remove();
  }
  let lastEditedSection = requestedSection === 'today' ? 'today' : 'calendar';
  const settingsStatus = document.createElement('p');
  settingsStatus.className = 'calendar-settings-status';
  settingsStatus.dataset.settingsStatus = '';
  settingsStatus.setAttribute('role', 'status');
  settingsStatus.setAttribute('aria-live', 'polite');
  settingsStatus.hidden = true;
  today.querySelector('[data-next-action-settings]').append(prefsLoadState);

  const calendar = hosts.calendar;
  calendar.innerHTML = `<h3>${copy("Вид календаря")}</h3>
    <p class="calendar-setting-hint">${copy("Эти изменения сохраняются кнопкой «Сохранить календарь».")}</p>
    ${[['language',copy("Язык интерфейса")],['first_day',copy("Первый день недели")],['default_view',copy("Вид при запуске")]].map(([key,label]) => `<fieldset class="calendar-setting"><legend>${label}</legend><div class="setting-pills" data-key="${key}">${OPTIONS[key].map(([value,text]) => `<button type="button" class="setting-pill" data-value="${value}" aria-pressed="false">${escapeHtml(copy(text))}</button>`).join('')}</div></fieldset>`).join('')}`;

  hosts.processes.classList.add('calendar-settings-processes-host');
  hosts.connections.classList.add('calendar-settings-connections');
  hosts.about.classList.add('calendar-settings-about');
  const sync = document.createElement('section'), sleep = document.createElement('section'), activity = document.createElement('section');
  const health = document.createElement('details'); health.className = 'calendar-settings-health';
  const healthTitle = document.createElement('summary'); healthTitle.textContent = copy("Здоровье: сон, прогулки и шаги");
  health.append(healthTitle, sleep, activity);
  hosts.connections.append(sync, health);
  // This checkout has no Jira backend. Do not imply that device sync is Jira activity.
  const jira = document.createElement('section');
  const jiraTitle = document.createElement('h3'); jiraTitle.textContent = 'Jira';
  const jiraStatus = document.createElement('p');
  jiraStatus.textContent = copy("В этой сборке интеграция Jira недоступна. Здесь нет данных о подключении или импорте. Подключение на другом устройстве нужно проверить на том устройстве.");
  jira.append(jiraTitle, jiraStatus); hosts.connections.append(jira);
  disposeRegistry = mountWorkRegistry(hosts.connections, { invoke });
  disposeSources = mountDataSources(hosts.connections, { invoke });
  const updates = document.createElement('section');
  const buildInfo = document.createElement('p'); buildInfo.textContent = `Cicada ${S.APP_VERSION} • ${document.documentElement.lang.toLowerCase().startsWith('en') ? 'build' : 'сборка'} ${S.APP_BUILD_ID}`;
  hosts.about.append(buildInfo);
  const themeCopy = document.documentElement.lang.toLowerCase().startsWith('en')
    ? { label: 'Theme', light: 'Light', dark: 'Dark', hint: 'Applied and saved immediately on this device.' }
    : { label: 'Тема', light: 'Светлая', dark: 'Тёмная', hint: 'Применяется и сохраняется сразу на этом устройстве.' };
  const themeLabel = document.createElement('label');
  themeLabel.className = 'calendar-settings-theme';
  themeLabel.textContent = themeCopy.label;
  const themeSelect = document.createElement('select');
  themeSelect.dataset.themeSetting = '';
  for (const value of ['light', 'dark']) {
    const option = document.createElement('option');
    option.value = value; option.textContent = themeCopy[value]; themeSelect.append(option);
  }
  themeSelect.value = S.theme === 'dark' ? 'dark' : 'light';
  themeSelect.addEventListener('change', () => setTheme(themeSelect.value));
  const themeHint = document.createElement('p');
  themeHint.className = 'calendar-setting-hint';
  themeHint.id = 'calendar-settings-theme-hint'; themeHint.textContent = themeCopy.hint;
  themeSelect.setAttribute('aria-describedby', themeHint.id);
  themeLabel.append(themeSelect); hosts.about.append(themeLabel, themeHint);
  hosts.about.append(updates);
  disposeDataLocation = mountDataLocation(hosts.about, { invoke });

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
  today.querySelector('[data-recurring]')?.addEventListener('click', () => {
    requestClose('routines');
  });
  prefsRetry.addEventListener('click', () => { void loadPreferences(); });

  api.form.addEventListener('submit', async event => {
    event.preventDefault();
    if (api.pending || !draft || !preferenceDirty()) return;
    api.setPending(true); prefsError.hidden = true;
    try {
      const changedRecommendations = Object.fromEntries(['recommendationsEnabled','recommendTasks','recommendRoutines'].filter(key => draft[key] !== original[key]).map(key => [key,draft[key]]));
      const saved = await (recommendationsOnly ? saveRecommendationPreferences(changedRecommendations) : saveCalendarPreferences(draft, undefined, { base: original }));
      if (closed) return;
      original = saved; draft = { ...saved };
      savedLanguageChanged = applySavedLanguage(document, saved) || savedLanguageChanged;
      window.dispatchEvent(new window.CustomEvent('hanni:calendar-settings-changed', { detail: { changes: saved } }));
      api.setPending(false);
      if (processSettings?.isDirty()) {
        hosts.processes.append(settingsStatus);
        settingsStatus.textContent = copy("Настройки календаря сохранены. Черновик этапов ещё не сохранён — сохрани его во вкладке «Этапы задач» или закрой настройки с отменой.");
        settingsStatus.hidden = false;
        setActive('processes', true);
      } else if (disposeSync?.isDirty?.()) {
        hosts.connections.prepend(settingsStatus);
        settingsStatus.textContent = copy("Настройки календаря сохранены. Изменения подключения ещё не сохранены.");
        settingsStatus.hidden = false;
        setActive('connections', true);
      } else {
        api.close({ skipBeforeClose: true });
      }
    } catch (error) {
      if (closed) return;
      prefsError.textContent = `${preferenceErrorCopy(error?.message || "Ошибка сохранения.")}${copy(" Сохранение ")}${recommendationsOnly ? copy("настроек выбора") : copy("календаря")}${copy(" не подтверждено; черновик остался в форме.")}`;
      prefsError.hidden = false; setActive(lastEditedSection, true); prefsError.tabIndex = -1; prefsError.focus();
    } finally {
      if (!closed) { api.setPending(false); refreshFooter(); }
    }
  });

  setActive(requestedSection);
  saveButton.hidden = true;
  api.open(recommendationsOnly ? null : tabs[requestedSection]);
  if (!recommendationsOnly) {
    disposePersonalImport = mountPersonalTaskImport(hosts.calendar, { invoke, setPending: value => api.setPending(value), onChanged: () => window.dispatchEvent(new window.Event('hanni:calendar-refresh')) });
    processSettings = mountProcessSettings(hosts.processes, {
      invoke,
      setPending: value => { api.setPending(value); refreshFooter(); },
    });
    hosts.processes.classList.add('calendar-settings-panel');
    hosts.processes.append(settingsStatus);
    hosts.processes.addEventListener('input', scheduleFooterRefresh);
    hosts.processes.addEventListener('click', scheduleFooterRefresh);
    processObserver = new window.MutationObserver(scheduleFooterRefresh);
    processObserver.observe(hosts.processes, { childList: true, subtree: true, attributes: true });
    disposeSync = mountSyncSettings(sync, { invoke, setPending: value => { api.setPending(value); refreshFooter(); } });
    sync.addEventListener('input', scheduleFooterRefresh);
    sync.addEventListener('change', scheduleFooterRefresh);
    sync.addEventListener('click', scheduleFooterRefresh);
    disposeSleep = mountSleepSettings(sleep, { invoke, setPending: value => api.setPending(value) });
    disposeActivity = mountHealthActivitySettings(activity, { invoke, setPending: value => api.setPending(value) });
    disposeUpdates = mountAppUpdates(updates, { invoke });
  }
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
      prefsError.textContent = copy(error?.message || "Не удалось загрузить настройки календаря.");
      prefsError.hidden = false; prefsRetry.hidden = false;
      saveButton.hidden = true; saveButton.disabled = true;
      setActive(['today', 'calendar'].includes(requestedSection) ? requestedSection : 'calendar');
      prefsError.tabIndex = -1; prefsError.focus();
    }
  }
  void loadPreferences();
}
