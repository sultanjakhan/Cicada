import { mountProcessSettings } from './calendar-process-settings.js';
import { mountJiraWorkflowSettings } from './jira-workflow-settings.js';
import { jiraErrorText } from './jira-import.js';

/** One editor owns all process drafts while the work/personal views move its DOM. */
export function mountWorkflowSettings(element, { invoke, setPending = () => {}, openConnections = () => {} }) {
  const doc = element.ownerDocument, win = doc.defaultView;
  let editor = null, workflow = null, disposed = false, area = 'personal', areaChosen = false;
  let busy = false, editorBusy = false, workflowBusy = false, personalProcess = null;
  element.classList.add('calendar-workflow-settings');
  element.innerHTML = `<h3>Процессы задач</h3>
    <p class="calendar-setting-hint">Настрой, где видны задачи и какие внутренние этапы им нужны.</p>
    <div class="calendar-workflow-areas" role="group" aria-label="Область настройки процессов">
      <button type="button" data-process-area="work" aria-pressed="false">Работа</button>
      <button type="button" data-process-area="personal" aria-pressed="true">Личные</button>
    </div>
    <div data-process-work hidden><div data-process-workflow></div><button type="button" class="text-button" data-process-connection>Подключение Jira</button></div>
    <div data-process-personal><p class="calendar-setting-hint">Личная задача создаётся без этапов. Нужный шаблон выбирается в карточке задачи. Эти шаблоны общие для рабочих и личных задач.</p><div data-process-personal-editor></div></div>
    <p class="calendar-workflow-draft" data-process-draft role="status" aria-live="polite"></p>
    <p class="calendar-workflow-result" data-process-result role="status" aria-live="polite" hidden></p>
    <div class="calendar-processes-actions calendar-workflow-actions"><button type="button" data-unified-save disabled>Сохранить изменения</button><button type="button" data-unified-cancel disabled>Отменить изменения</button></div>`;
  const q = name => element.querySelector(`[data-process-${name}]`);
  const saveButton = element.querySelector('[data-unified-save]'), cancelButton = element.querySelector('[data-unified-cancel]');
  const editorElement = doc.createElement('section'); q('personal-editor').append(editorElement);
  const dirty = () => !!editor?.isDirty() || !!workflow?.isDirty();
  function update() {
    if (disposed) return;
    const pending = busy || editorBusy || workflowBusy;
    setPending(pending);
    const drafts = [editor?.isDirty() && 'шаблоны этапов', workflow?.isDirty() && 'правила проекта'].filter(Boolean);
    q('draft').textContent = drafts.length ? `Не сохранены: ${drafts.join(' и ')}. Кнопка ниже сохраняет оба раздела.` : '';
    saveButton.disabled = pending || !dirty(); cancelButton.disabled = pending || !dirty();
    element.querySelectorAll('[data-process-area], [data-process-connection]').forEach(button => { button.disabled = pending; });
    // No concurrent edits can enter either half during the coordinated save.
    for (const root of [q('work'), q('personal')]) root.toggleAttribute('inert', busy);
  }
  function placeEditor() {
    if (!editor || !workflow) return;
    const work = area === 'work', selected = workflow.getProcess();
    (work ? workflow.editorHost : q('personal-editor')).append(editorElement);
    editorElement.hidden = work && !selected;
    editor.select(work ? selected : personalProcess, { picker: !work });
  }
  function selectArea(next, explicit = true) {
    if (disposed || busy || editorBusy || workflowBusy) return;
    area = next; if (explicit) areaChosen = true;
    q('work').hidden = area !== 'work'; q('personal').hidden = area !== 'personal';
    element.querySelectorAll('[data-process-area]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.processArea === area)));
    placeEditor();
  }
  workflow = mountJiraWorkflowSettings(q('workflow'), {
    invoke, errorText: jiraErrorText, externalActions: true,
    setPending: value => { workflowBusy = value; update(); }, onChange: update,
    onProject: project => {
      element.querySelector('[data-process-area="work"]').textContent = `Работа · ${project}`;
      if (!areaChosen && !workflowBusy) selectArea('work', false);
    },
    onProcessChange: () => { placeEditor(); update(); },
    onCreateProcess: () => { if (!editor?.ready) return; workflow.openStages(); editorElement.hidden = false; editor.addProcess(); },
  });
  editor = mountProcessSettings(editorElement, {
    invoke, compact: true, externalActions: true,
    setPending: value => { editorBusy = value; update(); },
    onChange: processes => { workflow.setProcesses(processes); update(); },
    onSaved: processes => { workflow.setProcesses(processes); update(); },
    onSelect: (id, { reveal = false } = {}) => {
      if (reveal) {
        if (area === 'work' && workflow.getProcess() === id) workflow.openStages();
        else { personalProcess = id; selectArea('personal'); }
      }
      else if (area === 'work') workflow.setProcess(id);
      else personalProcess = id;
    },
  });
  function result(text, alert = false) {
    q('result').textContent = text; q('result').hidden = !text; q('result').setAttribute('role', alert ? 'alert' : 'status');
  }
  async function save() {
    if (busy || editorBusy || workflowBusy || disposed || !dirty()) return false;
    if (editor.isDirty() && !editor.check()) {
      // A draft may belong to the other view; show its existing editor and error.
      if (area === 'work' && !workflow.getProcess()) selectArea('personal');
      if (area === 'work') workflow.openStages();
      result('Проверь названия процесса и этапов. Изменения ещё не сохранены.', true); return false;
    }
    busy = true; update(); result('Сохраняем изменения…');
    const hadTemplates = editor.isDirty();
    try {
      if (hadTemplates && !await editor.save({ external: true })) {
        result('Не удалось сохранить шаблоны этапов. Правила проекта не отправлены; черновики остались в форме.', true); return false;
      }
      if (!await workflow.save({ external: true })) {
        result(`${hadTemplates ? 'Шаблоны этапов сохранены. ' : ''}Правила проекта не сохранены; их черновик остался в форме.`, true); return false;
      }
      result('Изменения сохранены.'); return true;
    } finally { busy = false; update(); }
  }
  saveButton.onclick = () => void save();
  cancelButton.onclick = async () => {
    if (busy || editorBusy || workflowBusy || disposed) return;
    busy = true; update(); result('');
    try { await editor.reset(); if (!disposed) { await workflow.reset(); placeEditor(); result('Несохранённые изменения отменены.'); } }
    finally { busy = false; update(); }
  };
  element.querySelectorAll('[data-process-area]').forEach(button => button.onclick = () => selectArea(button.dataset.processArea));
  q('connection').onclick = openConnections;
  const status = event => { if (!disposed) workflow.setConnection(event.detail); };
  win.addEventListener('hanni:jira-status', status);
  update();
  return {
    isDirty: dirty, save,
    openWork() { selectArea('work'); },
    setConnection: status => workflow.setConnection(status),
    dispose() { disposed = true; workflow(); editor.dispose(); win.removeEventListener('hanni:jira-status', status); },
  };
}
