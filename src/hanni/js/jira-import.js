// Only titles and status names cross the Jira import boundary; credentials stay native.
const ERRORS = {
  jira_token_unavailable: 'Токен недоступен — введите заново.',
  jira_token_required: 'Введи API-токен.',
  jira_token_required_for_site: 'При смене сайта или типа токена введи API-токен заново.',
  jira_token_required_for_mode: 'При смене типа токена введи API-токен заново.',
  jira_token_mode_invalid: 'Выбери тип API-токена.',
  jira_cloud_id_invalid: 'Не удалось определить сайт Jira. Проверь адрес и попробуй снова.',
  jira_token_invalid: 'API-токен выглядит неполным. Скопируй его целиком.',
  jira_token_write_failed: 'Не удалось сохранить токен в хранилище ключей. Повтори попытку.',
  jira_token_delete_failed: 'Импорт остановлен, но токен не удалось удалить из хранилища ключей.',
  jira_site_invalid: 'Укажи адрес сайта Jira Cloud вида example.atlassian.net.',
  jira_project_invalid: 'Ключ проекта — латинские заглавные буквы и цифры, например DEMO.',
  jira_email_invalid: 'Проверь email.',
  jira_title_invalid: 'Введи непустое название до 500 символов, без переносов строк.',
  jira_not_configured: 'Сначала заполни и сохрани подключение к Jira.',
  jira_unauthorized: 'Jira не приняла email или API-токен. Проверь их и сохрани снова.',
  jira_forbidden: 'Jira отказала в доступе. Проверь права на проект или войди в Jira в браузере.',
  jira_not_found: 'По этому адресу Jira не найдена. Проверь адрес сайта.',
  jira_bad_request: 'Jira не приняла запрос. Проверь ключ проекта.',
  jira_redirected: 'Сайт Jira перенаправляет запрос. Проверь адрес сайта.',
  jira_rate_limited: 'Jira просит подождать. Повторим загрузку позже.',
  jira_server_error: 'Jira временно недоступна. Повторим загрузку позже.',
  jira_network_unavailable: 'Нет связи с Jira. Повторим загрузку позже.',
  jira_timeout: 'Jira не ответила вовремя. Повторим загрузку позже.',
  jira_response_invalid: 'Не удалось разобрать ответ Jira. Задачи не изменены.',
  jira_storage_failed: 'Не удалось сохранить результат импорта. Повтори попытку.',
  jira_import_busy: 'Операция с Jira ещё выполняется. Дождись завершения и попробуй снова.',
  jira_task_not_found: 'Задача недоступна в подключённом проекте Jira. Проверь подключение и обнови список.',
  jira_task_conflict: 'Задача изменилась в Jira. Обнови состояние, проверь изменения и отправь ещё раз.',
  jira_transition_invalid: 'Этот переход больше недоступен. Обнови состояние Jira и выбери доступный статус.',
  jira_write_outcome_unknown: 'Jira могла принять изменение, но подтверждение не получено. Нажми «Обновить из Jira» перед следующей попыткой.',
  jira_unsupported: 'На телефоне импорт из Jira недоступен.',
};
const errorCode = cause => typeof cause === 'string' ? cause : cause?.message;
export const jiraErrorText = code => ERRORS[code] || 'Не удалось выполнить запрос к Jira. Повтори попытку позже.';

export function jiraStatusText(status) {
  if (!status) return 'Состояние импорта из Jira недоступно.';
  if (status.running) return 'Загружаем задачи из Jira…';
  if (!status.enabled) return 'Jira не подключена. Уже загруженные задачи остаются в Cicada.';
  const date = status.lastSuccess ? new Date(status.lastSuccess) : null;
  if (!date || !Number.isFinite(date.getTime())) return 'Подключено. Задачи ещё не загружались.';
  return `Последняя загрузка: ${date.toLocaleString('ru-RU')} · задач: ${status.lastCount ?? 0}${status.truncated ? ' (первые 500)' : ''}.`;
}

function announce(window, status) {
  window.dispatchEvent(new window.CustomEvent('hanni:jira-status', { detail: status }));
  if (status?.changed > 0) window.dispatchEvent(new window.Event('hanni:jira-imported'));
}

export function mountJiraSettings(element, { invoke, setPending = () => {} }) {
  const window = element.ownerDocument.defaultView;
  let status = null, busy = false, disposed = false, dirty = false, failure = '', statusRevision = 0;
  element.className = 'calendar-jira calendar-setting';
  element.innerHTML = `<h3>Jira</h3>
    <p class="calendar-jira-hint">Загружаются все задачи выбранного проекта, включая завершённые. Сохраняются названия и статусы: без описаний, комментариев, вложений, ключей и ссылок Jira.</p>
    <p class="calendar-jira-hint">Название и статус можно изменить из карточки задачи по кнопке «Изменить в Jira». Если включена синхронизация Cicada, названия и статусы передаются на твои устройства.</p>
    <p data-jira-status role="status">Загружаем состояние…</p><p class="calendar-jira-error" data-jira-error role="alert" hidden></p>
    <p class="calendar-jira-hint" data-jira-unsupported hidden>На телефоне импорт недоступен: задачи из Jira приходят сюда через синхронизацию с Mac или ПК.</p>
    <div class="calendar-jira-form" data-jira-form>
      <div class="calendar-jira-pair">
        <label>Сайт Jira<input type="text" data-jira-site placeholder="example.atlassian.net" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url"></label>
        <label>Ключ проекта<input type="text" data-jira-project placeholder="DEMO" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
      </div>
      <div class="calendar-jira-pair">
        <label>Email<input type="email" data-jira-email autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <label>Тип API-токена<select data-jira-token-mode><option value="scoped">С правами (scopes)</option><option value="classic">Без scopes</option></select></label>
      </div>
      <label>API-токен<input type="password" data-jira-token autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <details class="calendar-jira-help"><summary>Как получить токен и где он хранится</summary>
        <p class="calendar-jira-hint">Токен создаётся на id.atlassian.com → Security → API tokens. Для чтения нужен read:jira-work; для изменения названия и статуса — также write:issue:jira и write:issue.property:jira. Email и токен хранятся в защищённом хранилище этого компьютера и отправляются только в Atlassian для подключения к выбранному сайту.</p>
        <p class="calendar-jira-hint">Подключай Jira только на одном компьютере — иначе переименования из Jira попадут в разбор версий.</p>
      </details>
      <div class="calendar-sync-actions"><button type="button" data-jira-save>Сохранить подключение</button><button type="button" data-jira-now>Загрузить сейчас</button><button type="button" data-jira-disable>Отключить</button></div>
    </div>`;
  const q = name => element.querySelector(`[data-jira-${name}]`);
  const fields = { site: q('site'), email: q('email'), tokenMode: q('token-mode'), token: q('token'), project: q('project') };
  function render() {
    if (disposed) return;
    const unsupported = status?.supported === false;
    q('form').hidden = unsupported; q('unsupported').hidden = !unsupported;
    q('status').hidden = unsupported;
    q('status').textContent = busy ? 'Подключаемся к Jira…' : jiraStatusText(status);
    const text = failure || (status?.enabled && status.lastError ? jiraErrorText(status.lastError) : '');
    q('error').textContent = text; q('error').hidden = !text;
    fields.token.placeholder = status?.tokenSaved ? 'Сохранён — оставь пустым, чтобы не менять' : 'Вставь API-токен';
    if (!dirty && status) { fields.site.value = status.site || ''; fields.email.value = status.email || ''; fields.project.value = status.project || ''; fields.tokenMode.value = status.tokenMode || 'scoped'; }
    Object.values(fields).forEach(field => { field.disabled = busy; });
    q('save').disabled = busy || !status || status.running === true;
    q('now').disabled = busy || !status?.enabled || status.running === true;
    q('disable').disabled = busy || !(status?.enabled || status?.tokenSaved);
  }
  function accept(next) { if (next && typeof next === 'object') { status = next; statusRevision++; } }
  async function perform(steps) {
    if (busy || disposed) return;
    busy = true; statusRevision++; failure = ''; setPending(true); render();
    try {
      for (const step of steps) { const next = await step(); if (disposed) return; accept(next); announce(window, next); }
    } catch (cause) { if (!disposed) failure = jiraErrorText(errorCode(cause)); }
    finally { busy = false; if (!disposed) { setPending(false); render(); } }
  }
  function save() {
    if (busy || disposed || status?.running) return;
    const site = fields.site.value.trim(), email = fields.email.value.trim(), project = fields.project.value.trim(), token = fields.token.value.trim();
    if (!site || !email || !project) { failure = 'Заполни сайт, email и ключ проекта.'; render(); return; }
    if (!token && !status?.tokenSaved) { failure = jiraErrorText('jira_token_required'); render(); fields.token.focus(); return; }
    // A saved connection is checked at once, so a wrong token shows up here.
    void perform([
      async () => { const next = await invoke('jira_import_configure', { site, project, email, token: token || null, tokenMode: fields.tokenMode.value }); fields.token.value = ''; dirty = false; return next; },
      () => invoke('jira_import_now'),
    ]);
  }
  Object.values(fields).forEach(field => {
    field.addEventListener('input', () => { dirty = true; });
    field.addEventListener('change', () => { dirty = true; });
    // Enter must not submit the surrounding settings form.
    field.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); save(); } });
  });
  q('save').onclick = save;
  q('now').onclick = () => void perform([() => invoke('jira_import_now')]);
  q('disable').onclick = () => void perform([async () => { const next = await invoke('jira_import_disable'); fields.token.value = ''; dirty = false; return next; }]);
  const onStatus = event => { if (!busy && !disposed) { accept(event.detail); render(); } };
  window.addEventListener('hanni:jira-status', onStatus);
  // The initial lookup must not lock the surrounding settings form.
  const initialRevision = statusRevision;
  void Promise.resolve().then(() => invoke('jira_import_status')).then(next => { if (!disposed && !busy && statusRevision === initialRevision) { accept(next); render(); } })
    .catch(() => { if (!disposed && !busy && statusRevision === initialRevision) { failure = 'Не удалось прочитать состояние импорта из Jira.'; render(); } });
  render();
  const dispose = () => { disposed = true; fields.token.value = ''; window.removeEventListener('hanni:jira-status', onStatus); };
  dispose.isDirty = () => dirty;
  return dispose;
}

/** The periodic check, like the sleep import: every minute and on return to the window. The native side imports at most every 15 minutes. */
export function startJiraImport({ window, invoke, requestSync, requestRefresh }) {
  let busy = false, stopped = false, timer = null;
  const imported = () => { requestRefresh(); requestSync(); };
  async function check() {
    if (busy || stopped || window.document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const status = await invoke('jira_import_tick');
      if (stopped) return;
      announce(window, status);
      if (status?.supported === false) dispose();
    } catch { /* The native state keeps the failure; the next tick retries. */ }
    finally { busy = false; }
  }
  const visible = () => { if (window.document.visibilityState === 'visible') void check(); };
  function dispose() {
    stopped = true; window.clearInterval(timer);
    window.document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('focus', visible);
    window.removeEventListener('hanni:jira-imported', imported);
  }
  window.addEventListener('hanni:jira-imported', imported);
  window.document.addEventListener('visibilitychange', visible);
  window.addEventListener('focus', visible);
  timer = window.setInterval(check, 60_000);
  void check();
  return dispose;
}
