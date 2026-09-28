// Only titles and status names cross the Jira import boundary; credentials stay native.
const ERRORS = {
  jira_token_unavailable: 'Сохранённый API-токен недоступен этой версии Cicada. Вставь новый токен и нажми «Сохранить и подключить».',
  jira_token_required: 'Введи API-токен.',
  jira_token_required_for_site: 'При смене сайта или типа токена введи API-токен заново.',
  jira_token_required_for_mode: 'При смене типа токена введи API-токен заново.',
  jira_token_mode_invalid: 'Выбери тип API-токена.',
  jira_cloud_id_invalid: 'Не удалось определить сайт Jira. Проверь адрес и попробуй снова.',
  jira_token_invalid: 'API-токен выглядит неполным. Скопируй его целиком.',
  jira_token_write_failed: 'Не удалось сохранить новый токен в защищённом хранилище компьютера. Подключение не изменено.',
  jira_token_delete_failed: 'Импорт остановлен, но токен не удалось удалить из хранилища ключей.',
  jira_site_invalid: 'Укажи адрес сайта Jira Cloud вида example.atlassian.net.',
  jira_project_invalid: 'Ключ проекта — латинские заглавные буквы и цифры, например DEMO.',
  jira_email_invalid: 'Проверь email.',
  jira_title_invalid: 'Введи непустое название до 500 символов, без переносов строк.',
  jira_not_configured: 'Сначала заполни и сохрани подключение к Jira.',
  jira_unauthorized: 'Jira отклонила авторизацию. Проверь email, API-токен и выбранный тип токена.',
  jira_scope_missing: 'Jira сообщает о несовпадении прав токена и запроса. Проверь scopes: для загрузки, создания и изменения задач нужны read:jira-work и write:jira-work типа Classic. В Cicada выбери «С правами (scopes)».',
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
  jira_create_not_ready: 'Дождись подключения Jira и выбери тип задачи.',
  jira_create_request_invalid: 'Форма создания устарела. Обнови подключение в форме и проверь данные.',
  jira_create_request_conflict: 'Этот запрос уже отправлялся с другими данными. Обнови подключение и проверь результат предыдущего создания.',
  jira_create_recovery_required: 'Сначала проверь результат предыдущего создания в Jira.',
  jira_create_outcome_unknown: 'Jira могла создать задачу. Проверь её в Jira; повторная отправка заблокирована, чтобы не создать дубль.',
  jira_create_required_fields: 'Для этого типа Jira требует дополнительные поля. Создай задачу в Jira: Cicada отправляет только название и тип.',
  jira_create_local_invalid: 'Проверь дату, время, цель и этап задачи. Запрос создания не отправлен.',
  jira_issue_type_invalid: 'Этот тип задачи недоступен. Обнови подключение и выбери тип снова.',
  jira_create_configuration_changed: 'Подключение Jira изменилось. Обнови подключение в форме и проверь проект перед созданием.',
  jira_unsupported: 'На телефоне импорт из Jira недоступен.',
};
const errorCode = cause => typeof cause === 'string' ? cause : cause?.message;
export const jiraErrorText = (code, fallback = 'Не удалось выполнить запрос к Jira. Повтори попытку позже.') => ERRORS[code] || fallback;

export function jiraStatusText(status) {
  if (!status) return 'Состояние импорта из Jira недоступно.';
  if (status.running) return 'Загружаем задачи из Jira…';
  if (!status.enabled) return 'Jira не подключена. Уже загруженные задачи остаются в Cicada.';
  if (!status.tokenSaved) return 'Для подключения нужен API-токен.';
  const date = status.lastSuccess ? new Date(status.lastSuccess) : null;
  if (!date || !Number.isFinite(date.getTime())) return status.lastError ? 'Токен сохранён, но подключиться к Jira не удалось.' : 'Токен сохранён. Связь с Jira ещё не проверена.';
  return `${status.lastError ? 'Не удалось обновить задачи. ' : ''}Последняя загрузка: ${date.toLocaleString('ru-RU')} · задач: ${status.lastCount ?? 0}${status.truncated ? ' (первые 500)' : ''}.`;
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
    <p class="calendar-jira-hint">Название и статус меняются из карточки по кнопке «Изменить в Jira». «Создать → Задача → Рабочая» создаёт задачу в подключённом проекте. Этап Cicada и статус Jira независимы. Если включена синхронизация Cicada, названия и статусы передаются на твои устройства.</p>
    <p class="calendar-jira-hint" data-jira-scopes>Для всех этих действий нужны два права токена Jira типа <strong>Classic</strong>: <code>read:jira-work</code> и <code>write:jira-work</code>. В поле «Тип API-токена» выбери «С правами (scopes)».</p>
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
        <p class="calendar-jira-hint">Открой id.atlassian.com → Security → API tokens → Create API token with scopes. Выбери Jira, затем Scope type → Classic и оба права из подсказки выше. Скопируй выданный токен целиком в поле «API-токен» и нажми «Сохранить и подключить». Права готового токена изменить нельзя: при необходимости создай новый.</p>
        <p class="calendar-jira-hint">После сохранения поле очищается — это нормально: токен остаётся в защищённом хранилище компьютера. Сразу проверяется связь и загружаются задачи. Если Jira отказала в доступе, причина появится здесь. Email и токен отправляются только в Atlassian; в синхронизацию Cicada они не попадают.</p>
        <p class="calendar-jira-hint">Подключай Jira только на одном компьютере — иначе переименования из Jira попадут в разбор версий.</p>
      </details>
      <div class="calendar-sync-actions"><button type="button" data-jira-save>Сохранить и подключить</button><button type="button" data-jira-now>Загрузить сейчас</button><button type="button" data-jira-disable>Отключить</button></div>
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
