import { loadProcesses } from './task-processes.js';
import { JIRA_WORKFLOW_ROLES, workflowPreview } from './jira-workflow-model.js';

export function mountJiraWorkflowSettings(element, { invoke, setPending = () => {}, errorText, externalActions = false, onChange = () => {}, onProject = () => {}, onProcessChange = () => {}, onCreateProcess = () => {} }) {
  const doc = element.ownerDocument, win = doc.defaultView;
  let snapshot = null, processes = [], tasks = null, disposed = false, busy = false, generation = 0, connection = '', initialized = false;
  let defaultProcessId = null, applyToExisting = false;
  const mappings = new Map();
  element.className = 'calendar-jira-workflow';
  element.innerHTML = `<p class="calendar-jira-hint">Выбери, где видны задачи каждого статуса. Пустые статусы тоже остаются в списке.</p>
    <p data-workflow-message role="status" aria-live="polite"></p>
    <div data-workflow-fields hidden>
      <div class="calendar-jira-workflow-head"><span>Статус Jira</span><span>Где показывать в Cicada</span></div>
      <div class="calendar-jira-workflow-map" data-workflow-map></div>
      <div data-workflow-stage-fallback></div>
      <p class="calendar-jira-hint">«Начать» переводит задачу в рабочий статус Jira, «Завершить» — в выбранный завершающий статус. Пауза меняет только таймер. Внутренние этапы не меняют статус Jira.</p>
      <section class="calendar-workflow-preview" aria-label="Предпросмотр списков"><h4>Как будут выглядеть списки</h4><p class="calendar-jira-hint">По загруженным задачам этого проекта и текущим настройкам формы.</p><div data-workflow-preview></div><p class="calendar-jira-hint" data-workflow-preview-note></p></section>
      <div class="calendar-sync-actions"><button type="button" data-workflow-save>Сохранить правила проекта</button><button type="button" data-workflow-cancel>Отменить правила</button></div>
    </div>
    <button type="button" data-workflow-reload>Обновить статусы из Jira</button>`;
  const q = name => element.querySelector(`[data-workflow-${name}]`);
  const stageSection = doc.createElement('details');
  stageSection.className = 'calendar-workflow-stages'; stageSection.dataset.workflowStages = '';
  stageSection.innerHTML = `<summary data-workflow-stage-summary>Внутренние этапы · без этапов</summary>
    <label class="calendar-jira-workflow-process">Процесс для новых задач проекта<select data-workflow-process aria-label="Процесс для новых задач проекта"><option value="">Без этапов</option></select></label>
    <p class="calendar-jira-hint">В отдельной задаче можно выбрать другой процесс, нужные этапы или обойтись без них.</p>
    <div data-workflow-editor></div>
    <button type="button" data-workflow-create>＋ Новый процесс для проекта</button>
    <label class="calendar-jira-workflow-apply"><input type="checkbox" data-workflow-apply>Также назначить процесс загруженным задачам проекта без процесса</label>`;
  q('stage-fallback').append(stageSection);
  if (externalActions) { q('save').hidden = true; q('cancel').hidden = true; }
  const say = (text, alert = false) => { q('message').textContent = text; q('message').setAttribute('role', alert ? 'alert' : 'status'); };
  const dirty = () => !!snapshot && (applyToExisting || defaultProcessId !== (snapshot.defaultProcessId || null) || snapshot.statuses.some(status => (mappings.get(status.name) || null) !== (status.bucket || null)));
  const values = () => snapshot?.statuses.map(status => ({ name: status.name, bucket: mappings.get(status.name) || null })) || [];
  function controls() {
    // The shared process editor manages its own pending controls.
    element.querySelectorAll('button,select,input').forEach(field => { if (!q('editor').contains(field)) field.disabled = busy; });
    q('apply').disabled = busy || !defaultProcessId;
    q('save').disabled = busy || !snapshot || !dirty();
    q('cancel').disabled = busy || !dirty();
    q('reload').disabled = busy || dirty();
    q('reload').title = dirty() ? 'Сначала сохрани или отмени изменения правил.' : '';
    onChange();
  }
  function preview() {
    if (!snapshot || tasks === null) {
      q('preview').replaceChildren(); q('preview-note').textContent = 'Количество задач недоступно. Обнови статусы, чтобы повторить загрузку.'; return;
    }
    const counts = workflowPreview(tasks, snapshot.scope, values());
    q('preview').replaceChildren(...[['queue','Рабочая очередь'],['review','На проверке'],['completed','Сделано'],['all','Все']].map(([id, title]) => {
      const entry = doc.createElement('div'), name = doc.createElement('span'), count = doc.createElement('strong');
      entry.dataset.workflowCount = id; name.textContent = title; count.textContent = String(counts[id]); entry.append(name, count); return entry;
    }));
    q('preview-note').textContent = `Только в «Все»: ${counts.onlyAll}. Уже запущенные задачи остаются в рабочей очереди до паузы.`;
  }
  function processOptions() {
    q('process').replaceChildren(new win.Option('Без этапов', ''), ...processes.map(process => new win.Option(process.title || 'Новый процесс', process.id)));
    if (defaultProcessId && !processes.some(process => process.id === defaultProcessId)) q('process').add(new win.Option('Процесс недоступен — выбери другой', defaultProcessId));
    q('process').value = defaultProcessId || ''; q('apply').checked = applyToExisting;
    const title = processes.find(process => process.id === defaultProcessId)?.title || (defaultProcessId ? 'процесс недоступен' : 'без этапов');
    q('stage-summary').textContent = `Внутренние этапы · ${title}`;
  }
  function placeStages() {
    const working = [...q('map').children].find(row => mappings.get(row.dataset.workflowRow) === 'working');
    (working || q('stage-fallback')).append(stageSection);
  }
  function render() {
    q('map').replaceChildren();
    const roleOrder = role => { const index = JIRA_WORKFLOW_ROLES.findIndex(([id]) => id === role); return index < 0 ? JIRA_WORKFLOW_ROLES.length : index; };
    // Sort only the accepted snapshot: editing a dropdown must not move its row.
    const ordered = [...snapshot.statuses].sort((a, b) => roleOrder(a.bucket) - roleOrder(b.bucket));
    for (const status of ordered) {
      const row = doc.createElement('div'), label = doc.createElement('label'), name = doc.createElement('span'), select = doc.createElement('select');
      row.dataset.workflowRow = status.name;
      name.textContent = status.name; select.dataset.workflowStatus = status.name;
      for (const [value, title] of [['', 'Не настроен · только в «Все»'], ...JIRA_WORKFLOW_ROLES]) select.add(new win.Option(title, value));
      select.value = mappings.get(status.name) || ''; select.setAttribute('aria-label', `Статус ${status.name} в Cicada`);
      select.addEventListener('change', () => { mappings.set(status.name, select.value || null); placeStages(); preview(); controls(); });
      label.append(name, select); row.append(label); q('map').append(row);
    }
    placeStages(); processOptions(); q('fields').hidden = false; preview(); controls();
    onProject(snapshot.project); onProcessChange(defaultProcessId);
  }
  function accept(next) {
    snapshot = next; mappings.clear();
    if (!next) { q('fields').hidden = true; controls(); return; }
    for (const status of next.statuses) mappings.set(status.name, status.bucket || null);
    defaultProcessId = next.defaultProcessId || null; applyToExisting = false; render();
  }
  async function readTasks() {
    try { const value = await invoke('get_calendar_tasks', { includeCompleted: true }); return Array.isArray(value) ? value : null; }
    catch { return null; }
  }
  async function load({ remote = false } = {}) {
    if (busy || disposed || dirty()) return;
    busy = true; const own = ++generation; if (remote) setPending(true); controls();
    say(remote ? 'Обновляем статусы и задачи из Jira…' : 'Загружаем сохранённые правила…');
    try {
      if (remote) {
        const imported = await invoke('jira_import_now');
        if (disposed || own !== generation) return;
        if (imported?.lastError) throw imported.lastError;
        win.dispatchEvent(new win.Event('hanni:jira-imported'));
      }
      const [next, templates, rows] = await Promise.all([invoke(remote ? 'jira_workflow_options' : 'jira_workflow_cached'), externalActions ? Promise.resolve(processes) : loadProcesses(invoke), readTasks()]);
      if (disposed || own !== generation) return;
      if (!externalActions) processes = templates;
      tasks = rows; accept(next); initialized = true;
      say(next ? `Проект ${next.project} · статусов: ${next.statuses.length}.` : 'Сохранённых статусов пока нет. Подключи Jira, затем обнови статусы.');
    } catch (cause) {
      if (disposed || own !== generation) return;
      say(`${snapshot ? 'Показаны сохранённые правила. ' : ''}${errorText(typeof cause === 'string' ? cause : cause?.message)}`, true);
    } finally { if (!disposed && own === generation) { busy = false; if (remote) setPending(false); controls(); } }
  }
  async function save({ external = false } = {}) {
    if (busy || disposed) return false;
    if (!dirty()) return true;
    busy = true; const own = ++generation; if (!external) setPending(true); controls(); say('Сохраняем правила…');
    try {
      const next = await invoke('jira_workflow_save', { scope: snapshot.scope, expectedRevision: snapshot.revision, mappings: values(), defaultProcessId, applyToExisting });
      if (disposed || own !== generation) return false;
      accept(next); say('Правила проекта сохранены.');
      win.dispatchEvent(new win.Event('hanni:jira-imported')); win.dispatchEvent(new win.Event('task-state-changed'));
      return true;
    } catch (cause) { if (!disposed && own === generation) say(errorText(typeof cause === 'string' ? cause : cause?.message), true); return false; }
    finally { if (!disposed && own === generation) { busy = false; if (!external) setPending(false); controls(); } }
  }
  q('reload').onclick = () => void load({ remote: true });
  q('process').addEventListener('change', () => {
    defaultProcessId = q('process').value || null; if (!defaultProcessId) applyToExisting = false;
    processOptions(); controls(); onProcessChange(defaultProcessId);
  });
  q('apply').addEventListener('change', () => { applyToExisting = q('apply').checked; controls(); });
  q('create').onclick = onCreateProcess;
  q('save').onclick = () => void save();
  q('cancel').onclick = () => { accept(snapshot); say('Изменения правил отменены.'); };
  const dispose = () => { disposed = true; generation++; };
  dispose.isDirty = dirty; dispose.save = save;
  dispose.reset = async () => { accept(snapshot); await load(); };
  dispose.setProcesses = next => { processes = next; processOptions(); };
  dispose.setProcess = id => { defaultProcessId = id || null; if (!id) applyToExisting = false; processOptions(); controls(); onProcessChange(defaultProcessId); };
  dispose.editorHost = q('editor');
  dispose.openStages = () => { stageSection.open = true; };
  dispose.getProcess = () => defaultProcessId;
  dispose.setConnection = status => {
    const next = status?.enabled && status?.supported !== false ? `${status.site}\n${status.project}` : '';
    if (status?.project) onProject(status.project);
    if (next === connection) return;
    const changed = connection && next !== connection;
    connection = next;
    if (changed) {
      generation++; if (busy) setPending(false); busy = false; snapshot = null; defaultProcessId = null; applyToExisting = false; mappings.clear();
      q('fields').hidden = true; controls(); say('Подключение изменено. Загрузи правила выбранного проекта.'); onProcessChange(null);
    }
    if (!initialized && !busy || changed && next) void load();
  };
  void load();
  return dispose;
}
