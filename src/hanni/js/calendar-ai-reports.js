import { readNativeTaskObservations, nativeTaskKey } from './native-task-observations.js';
import { createUiCopy } from './ui-copy.js';

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
  const uiCopy = createUiCopy(host.ownerDocument);
  let disposed = false, revision = 0, unlisten = null, hasLoaded = false, renderedSignature = null;
  const section = host.ownerDocument.createElement('section');
  section.className = 'calendar-ai-reports';
  section.hidden = false;
  section.setAttribute('aria-label', uiCopy('Работа ИИ'));
  const heading = host.ownerDocument.createElement('h3');
  heading.textContent = uiCopy('Работа ИИ');
  const note = host.ownerDocument.createElement('p');
  const unknownFreshness = 'Подключение к исполнителю не подтверждено. По последнему отчёту. Время и актуальность неизвестны; текущее состояние не подтверждено.';
  note.textContent = uiCopy(unknownFreshness);
  const content = host.ownerDocument.createElement('div');
  content.setAttribute('aria-live', 'polite');
  section.append(heading, note, content);
  host.replaceChildren(section);

  function message(text, key = text) {
    const signature = `message:${uiCopy.locale}:${key}`;
    if (renderedSignature === signature && content.firstElementChild) return;
    const paragraph = host.ownerDocument.createElement('p');
    paragraph.textContent = text;
    content.replaceChildren(paragraph);
    renderedSignature = signature;
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
    if (!items.length) { section.hidden = false; message(uiCopy('Нет связанных отчётов о работе ИИ. Регистрация задачи не означает запуск.'), 'empty'); return; }
    section.hidden = false;
    const signature = `items:${uiCopy.locale}:${JSON.stringify(items.map(item => [item.nativeTaskId, item.title, item.report]))}`;
    if (renderedSignature === signature && content.querySelector('ul')) return;
    const list = host.ownerDocument.createElement('ul');
    for (const item of items) {
      const row = host.ownerDocument.createElement('li');
      row.dataset.nativeTaskId = item.nativeTaskId;
      const title = host.ownerDocument.createElement('strong');
      title.textContent = item.title;
      const status = host.ownerDocument.createElement('p');
      const who = uiCopy(AGENT_LABELS[item.report.agent]);
      status.textContent = uiCopy.format('По последнему отчёту{0}: исполнитель {1}.', who ? ` (${who})` : '', uiCopy(STATUS_LABELS[item.report.status]));
      const facts = host.ownerDocument.createElement('p');
      facts.textContent = uiCopy.format('Модель: {0} · этап: {1} · актуальность: {2}', item.report.model || uiCopy('не сообщена'), item.report.stage || uiCopy('не сообщён'), (!item.report.freshness || item.report.freshness === 'unknown') ? uiCopy('неизвестна') : item.report.freshness);
      if (item.report.status === 'done') status.textContent += uiCopy(' Завершение задачи требует приёмки пользователем.');
      row.append(title, status, facts);
      list.append(row);
    }
    content.replaceChildren(list);
    renderedSignature = signature;
  }

  async function refresh() {
    if (disposed) return;
    const request = ++revision;
    section.setAttribute('aria-label', uiCopy('Работа ИИ'));
    heading.textContent = uiCopy('Работа ИИ');
    section.setAttribute('aria-busy', 'true');
    if (!hasLoaded) message(uiCopy('Загружаем отчёты…'), 'loading');
    try {
      const nativeRows = await invoke('get_calendar_tasks', {});
      if (!Array.isArray(nativeRows)) throw new Error('Invalid task response');
      const rows = nativeRows.filter(row => row?.source_type === 'note' && !row.archived && !row.readonly && row.status_extra === 'task');
      const observed = await readNativeTaskObservations(rows, invoke);
      if (!observed.available) throw new Error('Native observation read failed');
      if (disposed || request !== revision) return;
      note.textContent = uiCopy(unknownFreshness);
      render(rows, observed.contexts);
      hasLoaded = true;
    } catch {
      if (!disposed && request === revision) {
        section.hidden = false;
        note.textContent = uiCopy('Актуальность неизвестна: чтение отчётов завершилось ошибкой.');
        message(uiCopy('Не удалось прочитать отчёты. Прежние данные скрыты.'), 'error');
        hasLoaded = true;
      }
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
