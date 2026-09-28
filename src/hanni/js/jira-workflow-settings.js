import { loadProcesses } from './task-processes.js';
import { JIRA_WORKFLOW_ROLES } from './jira-workflow-model.js';

export function mountJiraWorkflowSettings(element, { invoke, setPending = () => {}, errorText }) {
  const doc = element.ownerDocument, win = doc.defaultView;
  let snapshot = null, processes = [], disposed = false, busy = false, dirty = false, generation = 0, connection = '';
  element.className = 'calendar-jira-workflow';
  element.innerHTML = `<details data-workflow-details><summary>Статусы и этапы проекта</summary>
    <p class="calendar-jira-hint">Статус Jira определяет, где видна задача. Внутренние этапы помогают вести работу и не меняют статус Jira.</p>
    <p data-workflow-message role="status"></p>
    <div data-workflow-fields hidden>
      <div class="calendar-jira-workflow-map" data-workflow-map></div>
      <p class="calendar-jira-hint">«Начать» переводит задачу в рабочий статус Jira, «Завершить» — в «Сделано». Пауза меняет только таймер. Не назначенные здесь статусы доступны в списке «Все».</p>
      <label class="calendar-jira-workflow-process">Процесс для новых задач проекта<select data-workflow-process><option value="">Без этапов</option></select></label>
      <p class="calendar-jira-hint">В карточке задачи можно выбрать другой процесс, оставить нужные этапы или убрать их. Шаблоны редактируются во вкладке «Этапы задач».</p>
      <label class="calendar-jira-workflow-apply"><input type="checkbox" data-workflow-apply>Также назначить процесс загруженным задачам проекта без процесса</label>
      <div class="calendar-sync-actions"><button type="button" data-workflow-save>Сохранить правила проекта</button></div>
    </div>
    <button type="button" data-workflow-reload>Загрузить статусы проекта</button>
  </details>`;
  const q = name => element.querySelector(`[data-workflow-${name}]`);
  const say = (text, alert = false) => { q('message').textContent = text; q('message').setAttribute('role', alert ? 'alert' : 'status'); };
  function controls() {
    element.querySelectorAll('button,select,input').forEach(field => { field.disabled = busy; });
    q('apply').disabled = busy || !q('process').value;
    q('save').disabled = busy || !snapshot;
    q('reload').textContent = dirty ? 'Отменить изменения и обновить статусы' : 'Обновить статусы проекта';
  }
  function render() {
    q('map').replaceChildren();
    for (const status of snapshot.statuses) {
      const label = doc.createElement('label'), name = doc.createElement('span'), select = doc.createElement('select');
      name.textContent = status.name; select.dataset.workflowStatus = status.name;
      for (const [value, title] of [['', 'Не назначено'], ...JIRA_WORKFLOW_ROLES]) select.add(new win.Option(title, value));
      select.value = status.bucket || ''; select.setAttribute('aria-label', `Статус ${status.name} в Cicada`);
      label.append(name, select); q('map').append(label);
    }
    q('process').replaceChildren(new win.Option('Без этапов', ''));
    for (const process of processes) q('process').add(new win.Option(process.title, process.id));
    if (snapshot.defaultProcessId && !processes.some(process => process.id === snapshot.defaultProcessId)) q('process').add(new win.Option('Процесс удалён — выбери другой', snapshot.defaultProcessId));
    q('process').value = snapshot.defaultProcessId || ''; q('apply').checked = false;
    q('fields').hidden = false; controls();
  }
  async function load() {
    if (busy || disposed) return;
    busy = true; const own = ++generation; setPending(true); controls(); say('Загружаем все статусы проекта…');
    try {
      const imported = await invoke('jira_import_now');
      if (disposed || own !== generation) return;
      if (imported?.lastError) throw imported.lastError;
      win.dispatchEvent(new win.Event('hanni:jira-imported'));
      const [next, templates] = await Promise.all([invoke('jira_workflow_options'), loadProcesses(invoke)]);
      if (disposed || own !== generation) return;
      snapshot = next; processes = templates; dirty = false; render();
      say(`Проект ${snapshot.project} · статусов: ${snapshot.statuses.length}.`);
    } catch (cause) {
      if (disposed || own !== generation) return;
      if (!snapshot) {
        try {
          const [saved, templates] = await Promise.all([invoke('jira_workflow_cached'), loadProcesses(invoke)]);
          if (disposed || own !== generation) return;
          if (saved) { snapshot = saved; processes = templates; render(); }
        } catch { /* The original connection error remains actionable. */ }
      }
      if (!disposed && own === generation) say(`${snapshot ? 'Показаны сохранённые правила проекта. ' : ''}${errorText(typeof cause === 'string' ? cause : cause?.message)}`, true);
    }
    finally { if (!disposed && own === generation) { busy = false; setPending(false); controls(); } }
  }
  q('details').addEventListener('toggle', () => { if (q('details').open && !snapshot) void load(); });
  q('reload').onclick = () => void load();
  q('fields').addEventListener('change', () => { dirty = true; if (!q('process').value) q('apply').checked = false; controls(); });
  q('save').onclick = async () => {
    if (busy || disposed || !snapshot) return;
    const mappings = [...q('map').querySelectorAll('select')].map(select => ({ name: select.dataset.workflowStatus, bucket: select.value || null }));
    busy = true; const own = ++generation; setPending(true); controls(); say('Сохраняем правила…');
    try {
      const next = await invoke('jira_workflow_save', { scope: snapshot.scope, expectedRevision: snapshot.revision, mappings, defaultProcessId: q('process').value || null, applyToExisting: q('apply').checked });
      if (disposed || own !== generation) return;
      snapshot = next; dirty = false; render(); say('Правила проекта сохранены.');
      win.dispatchEvent(new win.Event('hanni:jira-imported'));
      win.dispatchEvent(new win.Event('task-state-changed'));
    } catch (cause) { if (!disposed && own === generation) say(errorText(typeof cause === 'string' ? cause : cause?.message), true); }
    finally { if (!disposed && own === generation) { busy = false; setPending(false); controls(); } }
  };
  const dispose = () => { disposed = true; generation++; };
  dispose.isDirty = () => dirty;
  dispose.setConnection = status => {
    const next = status?.enabled && status?.supported !== false ? `${status.site}\n${status.project}` : '';
    element.hidden = !next;
    if (next === connection) return;
    connection = next; generation++; if (busy) setPending(false); busy = false; snapshot = null; dirty = false;
    q('fields').hidden = true; controls(); say('');
    if (next && q('details').open) void load();
  };
  return dispose;
}
