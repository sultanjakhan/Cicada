// A read-only projection of existing tasks. Execution remains owned by Calendar Now.
const taskKey = row => `${row.source_type}:${String(row.source_id)}`;
const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const PAGE_SIZE = 50;
let instance = 0;

export function mountCalendarDashboardTasks(element, dependencies) {
  const { invoke, openTask } = dependencies;
  const now = dependencies.now || (() => new Date());
  const document = element.ownerDocument, window = document.defaultView;
  const prefix = `calendar-task-overview-${++instance}`;
  let rows = null, current = { key: '', state: '' }, date = localDate(now());
  let disposed = false, revision = 0, loading = false, failed = false, expanded = false, page = 0;
  element.classList.add('calendar-task-overview');
  element.innerHTML = `<section aria-labelledby="${prefix}-title">
    <div class="cto-heading"><h2 id="${prefix}-title" tabindex="-1" data-overview-title>Другие задачи на сегодня</h2><button type="button" data-overview-toggle aria-expanded="false" aria-controls="${prefix}-all" disabled>Все задачи</button></div>
    <p class="cto-description">Задачи всех целей и без цели. Текущая задача показана выше.</p>
    <p class="cto-message" data-overview-message role="status" aria-live="polite"></p>
    <button type="button" data-overview-retry hidden>Повторить загрузку</button>
    <div data-overview-today></div>
    <div id="${prefix}-all" class="cto-all" data-overview-all hidden>
      <div class="cto-heading"><h3 tabindex="-1" data-overview-all-title>Все незавершённые задачи</h3><button type="button" data-overview-close aria-label="Закрыть список задач">×</button></div>
      <p class="cto-description">Включая текущую задачу. События доступны в календаре.</p>
      <div data-overview-groups></div>
      <div class="cto-pagination" data-overview-pagination hidden><button type="button" data-overview-prev>Назад</button><span data-overview-page role="status"></span><button type="button" data-overview-next>Далее</button></div>
    </div>
  </section>`;
  const query = name => element.querySelector(`[data-overview-${name}]`);
  const title = query('title'), toggle = query('toggle'), message = query('message'), retry = query('retry');
  const today = query('today'), all = query('all'), groups = query('groups'), pagination = query('pagination');
  const dateLabel = value => {
    const parsed = new Date(`${value}T12:00:00`);
    return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' }).format(parsed) : String(value);
  };
  const groupOf = row => row.is_active ? 'active' : !row.date ? 'undated' : row.date < date ? 'past' : row.date === date ? 'today' : 'future';
  const groupLabels = { active: 'В работе', past: 'Просроченные', today: 'Сегодня', future: 'Позже', undated: 'Без даты' };
  const groupOrder = Object.keys(groupLabels);
  const ordered = () => [...(rows || [])].sort((a, b) => groupOrder.indexOf(groupOf(a)) - groupOrder.indexOf(groupOf(b)) || (Number(b.priority) || 0) - (Number(a.priority) || 0) || (a.date || '9999').localeCompare(b.date || '9999') || a.title.localeCompare(b.title, 'ru') || taskKey(a).localeCompare(taskKey(b)));
  const findRowButton = (key, scope, more = false) => [...element.querySelectorAll(more ? '[data-overview-menu-task]' : '[data-overview-task]')].find(button => (button.dataset.overviewTask || button.dataset.overviewMenuTask) === key && button.dataset.overviewScope === scope);
  const disposeMenu = dependencies.mountMenu?.(element, {
    getRecord: item => rows?.find(row => taskKey(row) === item.dataset.contextRecord),
    restoreFocus: (item, trigger) => (findRowButton(item.dataset.contextRecord, item.dataset.overviewScope, 'recordMenu' in trigger.dataset) || title).focus(),
  });

  function taskList(items, scope) {
    const list = document.createElement('ul'); list.className = 'cto-list';
    items.forEach(row => {
      const item = document.createElement('li');
      item.dataset.contextRecord = taskKey(row); item.dataset.overviewScope = scope;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'cto-task';
      button.dataset.overviewTask = taskKey(row); button.dataset.overviewScope = scope;
      const name = document.createElement('span'); name.className = 'cto-task-title'; name.textContent = row.title;
      const meta = document.createElement('span'); meta.className = 'cto-task-meta';
      const parts = [row.date ? dateLabel(row.date) : 'Без даты'];
      if (taskKey(row) === current.key) parts.push(current.state === 'active' ? 'В работе · сейчас' : current.state === 'paused' ? 'На паузе · сейчас' : 'Сейчас');
      else if (row.is_active) parts.push('В работе');
      else if (row.has_work || row.actual_minutes > 0) parts.push('На паузе');
      meta.textContent = parts.join(' · ');
      button.append(name, meta); item.append(button);
      if (dependencies.mountMenu) {
        const more = document.createElement('button'); more.type = 'button'; more.className = 'cto-task-more'; more.textContent = '⋯';
        more.dataset.recordMenu = ''; more.dataset.overviewMenuTask = taskKey(row); more.dataset.overviewScope = scope;
        more.setAttribute('aria-label', `Действия: ${row.title}`); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
        item.append(more);
      }
      list.append(item);
    });
    return list;
  }
  function empty(container, text) {
    const paragraph = document.createElement('p'); paragraph.className = 'cto-empty'; paragraph.textContent = text; container.append(paragraph);
  }
  function render() {
    if (disposed) return;
    element.setAttribute('aria-busy', String(loading));
    message.textContent = failed ? 'Не удалось обновить список задач. Повтори загрузку.' : loading ? (rows ? 'Обновляем задачи…' : 'Загружаем задачи…') : '';
    retry.hidden = !failed; retry.disabled = loading;
    toggle.disabled = rows === null;
    if (rows === null) return;
    const focused = document.activeElement;
    const focusedKey = element.contains(focused) ? focused.dataset.overviewTask || focused.dataset.overviewMenuTask : null;
    const focusedScope = focused?.dataset.overviewScope;
    const items = ordered(), todayItems = items.filter(row => row.date === date && taskKey(row) !== current.key);
    title.textContent = `Другие задачи на сегодня · ${todayItems.length}`;
    toggle.textContent = `${expanded ? 'Закрыть все задачи' : 'Все задачи'} · ${items.length}`;
    toggle.setAttribute('aria-expanded', String(expanded)); all.hidden = !expanded;
    today.replaceChildren();
    if (todayItems.length) today.append(taskList(todayItems.slice(0, 3), 'today'));
    else empty(today, 'Других задач на сегодня нет. Можно посмотреть задачи на другие даты и без даты.');
    if (todayItems.length > 3) {
      const rest = document.createElement('button'); rest.type = 'button'; rest.className = 'cto-more'; rest.dataset.overviewMore = '';
      rest.textContent = `Ещё ${todayItems.length - 3} на сегодня`; today.append(rest);
    }
    page = Math.max(0, Math.min(page, Math.ceil(items.length / PAGE_SIZE) - 1));
    groups.replaceChildren();
    if (expanded) {
      const slice = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      for (const [group, label] of Object.entries(groupLabels)) {
        const groupRows = slice.filter(row => groupOf(row) === group);
        if (!groupRows.length) continue;
        const heading = document.createElement('h4'); heading.textContent = `${label} · ${items.filter(row => groupOf(row) === group).length}`;
        groups.append(heading, taskList(groupRows, 'all'));
      }
      if (!items.length) empty(groups, 'Незавершённых задач пока нет.');
    }
    pagination.hidden = items.length <= PAGE_SIZE;
    query('prev').disabled = page === 0;
    query('next').disabled = (page + 1) * PAGE_SIZE >= items.length;
    query('page').textContent = items.length ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, items.length)} из ${items.length}` : '';
    if (focusedKey && !focused.isConnected) (findRowButton(focusedKey, focusedScope, 'recordMenu' in focused.dataset) || title).focus();
  }
  async function refresh() {
    if (disposed) return;
    const request = ++revision; date = localDate(now()); loading = true; failed = false;
    element.setAttribute('aria-busy', 'true');
    message.textContent = rows ? 'Обновляем задачи…' : 'Загружаем задачи…'; retry.hidden = true;
    try {
      const result = await invoke('get_calendar_tasks', {});
      if (disposed || request !== revision) return;
      if (!Array.isArray(result)) throw new Error('Invalid task response');
      const eligible = result.filter(row => row.source_type === 'note' && !row.archived && !row.completed && !row.readonly && row.status_extra === 'task');
      rows = [...new Map(eligible.map(row => [taskKey(row), row])).values()];
    } catch {
      if (disposed || request !== revision) return;
      failed = true;
    } finally {
      if (!disposed && request === revision) { loading = false; render(); }
    }
  }
  function expandToday() {
    expanded = true;
    const index = ordered().findIndex(row => row.date === date && taskKey(row) !== current.key);
    page = Math.max(0, Math.floor(index / PAGE_SIZE)); render(); groups.scrollTop = 0; query('all-title').focus();
  }
  const onClick = event => {
    const button = event.target.closest('button'); if (!button || !element.contains(button) || button.disabled) return;
    if (button === toggle) { expanded = !expanded; render(); if (expanded) { groups.scrollTop = 0; query('all-title').focus(); } }
    else if (button === query('close')) { expanded = false; render(); toggle.focus(); }
    else if (button === retry) void refresh();
    else if ('overviewMore' in button.dataset) expandToday();
    else if (button === query('prev') || button === query('next')) { page += button === query('prev') ? -1 : 1; render(); groups.scrollTop = 0; query('all-title').focus(); }
    else if ('overviewTask' in button.dataset) {
      const key = button.dataset.overviewTask, scope = button.dataset.overviewScope;
      const row = rows?.find(value => taskKey(value) === key);
      if (row && openTask) openTask(row, () => { if (!disposed && element.isConnected) (findRowButton(key, scope) || title).focus(); });
    }
  };
  const onExternal = () => { void refresh(); };
  const onKey = event => { if (event.key === 'Escape' && expanded && all.contains(event.target)) { event.preventDefault(); event.stopPropagation(); expanded = false; render(); toggle.focus(); } };
  element.addEventListener('click', onClick);
  element.addEventListener('keydown', onKey);
  window.addEventListener('task-state-changed', onExternal); window.addEventListener('focus', onExternal);
  const timer = window.setInterval(() => { if (date !== localDate(now())) void refresh(); }, 1000);
  void refresh();
  const dispose = () => {
    disposed = true; revision++; disposeMenu?.(); window.clearInterval(timer); element.removeEventListener('click', onClick); element.removeEventListener('keydown', onKey);
    window.removeEventListener('task-state-changed', onExternal); window.removeEventListener('focus', onExternal);
  };
  dispose.setCurrentTask = value => {
    if (disposed || (current.key === value.key && current.state === value.state)) return;
    current = { key: value.key, state: value.state }; render();
  };
  return dispose;
}
