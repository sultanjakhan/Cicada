import { readNativeTaskObservations, nativeTaskKey } from './native-task-observations.js';

const STATUS_LABELS = {
  running: 'сообщил, что работает',
  waiting: 'сообщил, что ожидает',
  done: 'сообщил о завершении',
  error: 'сообщил об ошибке',
  cancelled: 'сообщил об остановке',
};
const AGENT_LABELS = { codex: 'Codex', claude: 'Claude', other: 'другой исполнитель', 'agent-city': 'Agent City' };

/** A read-only view of reports explicitly bound to native Cicada tasks. */
export function mountCalendarAiReports(host, { invoke, listen = null, window: win = globalThis.window } = {}) {
  let disposed = false, revision = 0, unlisten = null;
  const section = host.ownerDocument.createElement('section');
  section.className = 'calendar-ai-reports';
  section.setAttribute('aria-label', 'Работа ИИ');
  const heading = host.ownerDocument.createElement('h3');
  heading.textContent = 'Работа ИИ';
  const note = host.ownerDocument.createElement('p');
  note.textContent = 'По последнему отчёту. Время и актуальность неизвестны; текущее состояние не подтверждено.';
  const content = host.ownerDocument.createElement('div');
  content.setAttribute('aria-live', 'polite');
  section.append(heading, note, content);
  host.replaceChildren(section);

  function message(text) {
    const paragraph = host.ownerDocument.createElement('p');
    paragraph.textContent = text;
    content.replaceChildren(paragraph);
  }

  function render(rows, contexts) {
    const items = [];
    for (const row of rows) {
      if (row.source_type !== 'note' || row.archived || row.readonly || row.status_extra !== 'task') continue;
      const context = contexts.get(nativeTaskKey(row));
      if (!context?.binding || !context.reports.length) continue;
      const report = context.reports.reduce((latest, item) => !latest || item.receivedOrder > latest.receivedOrder ? item : latest, null);
      if (report && STATUS_LABELS[report.status]) items.push({ nativeTaskId:String(row.source_id), title:row.title, report, order:report.receivedOrder });
    }
    items.sort((a, b) => b.order - a.order);
    if (!items.length) { message('Нет связанных отчётов о работе ИИ.'); return; }
    const list = host.ownerDocument.createElement('ul');
    for (const item of items) {
      const row = host.ownerDocument.createElement('li');
      row.dataset.nativeTaskId = item.nativeTaskId;
      const title = host.ownerDocument.createElement('strong');
      title.textContent = item.title;
      const status = host.ownerDocument.createElement('p');
      const who = AGENT_LABELS[item.report.agent];
      status.textContent = `По последнему отчёту${who ? ` (${who})` : ''}: исполнитель ${STATUS_LABELS[item.report.status]}.`;
      row.append(title, status);
      list.append(row);
    }
    content.replaceChildren(list);
  }

  async function refresh() {
    if (disposed) return;
    const request = ++revision;
    section.setAttribute('aria-busy', 'true');
    message('Загружаем отчёты…');
    try {
      const nativeRows = await invoke('get_calendar_tasks', {});
      if (!Array.isArray(nativeRows)) throw new Error('Invalid task response');
      const rows = nativeRows.filter(row => row?.source_type === 'note' && !row.archived && !row.readonly && row.status_extra === 'task');
      const observed = await readNativeTaskObservations(rows, invoke);
      if (!observed.available) throw new Error('Native observation read failed');
      if (disposed || request !== revision) return;
      render(rows, observed.contexts);
    } catch {
      if (!disposed && request === revision) message('Не удалось прочитать отчёты.');
    } finally {
      if (!disposed && request === revision) section.removeAttribute('aria-busy');
    }
  }

  const onRefresh = () => { void refresh(); };
  win?.addEventListener('task-state-changed', onRefresh);
  if (listen) {
    Promise.resolve().then(() => listen('mvp-sync-updated', onRefresh)).then(stop => {
      if (disposed) stop?.(); else unlisten = stop;
    }).catch(() => {});
  }
  void refresh();

  return () => {
    disposed = true;
    revision++;
    win?.removeEventListener('task-state-changed', onRefresh);
    unlisten?.();
    section.remove();
  };
}
