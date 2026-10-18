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
export function mountCalendarAiReports(host, { invoke, listen = null, readTaskReview = null, onOpenTask = null, window: win = globalThis.window } = {}) {
  const uiCopy = createUiCopy(host.ownerDocument);
  let disposed = false, revision = 0, unlisten = null, hasLoaded = false, renderedSignature = null;
  const section = host.ownerDocument.createElement('section');
  section.className = 'calendar-ai-reports';
  section.hidden = false;
  section.setAttribute('aria-label', uiCopy('Работа ИИ'));
  const heading = host.ownerDocument.createElement('h3');
  heading.textContent = uiCopy('Работа ИИ');
  const disclosure = host.ownerDocument.createElement('details');
  const summary = host.ownerDocument.createElement('summary');
  const counts = host.ownerDocument.createElement('span');
  counts.dataset.aiReportCounts = '';
  summary.append(heading, counts);
  const note = host.ownerDocument.createElement('p');
  note.dataset.aiReportNote = '';
  const unknownFreshness = 'Подключение к исполнителю не подтверждено. По последнему отчёту. Время и актуальность неизвестны; текущее состояние не подтверждено.';
  note.textContent = uiCopy(unknownFreshness);
  const content = host.ownerDocument.createElement('div');
  content.setAttribute('aria-live', 'polite');
  disclosure.append(summary, note, content);
  section.append(disclosure);
  host.replaceChildren(section);

  function message(text, key = text) {
    counts.textContent = key === 'empty' ? (uiCopy.locale === 'en' ? 'Linked tasks: 0' : 'Связанных задач: 0')
      : key === 'error' ? uiCopy('Не удалось прочитать отчёты. Прежние данные скрыты.') : uiCopy('Загружаем отчёты…');
    const signature = `message:${uiCopy.locale}:${key}`;
    if (renderedSignature === signature && content.firstElementChild) return;
    const paragraph = host.ownerDocument.createElement('p');
    paragraph.textContent = text;
    const restore = content.contains(host.ownerDocument.activeElement);
    content.replaceChildren(paragraph);
    if (restore) summary.focus({ preventScroll:true });
    renderedSignature = signature;
  }

  function render(rows, contexts, unavailableReviews) {
    const items = [];
    for (const row of rows) {
      if (row.source_type !== 'note' || row.archived || row.readonly || row.status_extra !== 'task') continue;
      const context = contexts.get(nativeTaskKey(row));
      if (!context?.binding || !context.reports.length) continue;
      const report = context.reports.reduce((latest, item) => !latest || item.receivedOrder > latest.receivedOrder ? item : latest, null);
      if (context.latestRun && !context.latestRun.report && context.latestRun.receivedOrder > report?.receivedOrder) {
        items.push({ nativeTaskId:String(row.source_id), title:row.title, runId:context.latestRun.runId, report:null, order:context.latestRun.receivedOrder, review:context.review, reviewReadError:context.reviewReadError || unavailableReviews.has(String(row.source_id)) });
        continue;
      }
      if (report && STATUS_LABELS[report.status]) items.push({ nativeTaskId:String(row.source_id), title:row.title, report, order:report.receivedOrder, review:context.review, reviewReadError:context.reviewReadError || unavailableReviews.has(String(row.source_id)) });
    }
    items.sort((a, b) => b.order - a.order);
    if (!items.length) { section.hidden = false; message(uiCopy('Нет связанных отчётов о работе ИИ. Регистрация задачи не означает запуск.'), 'empty'); return; }
    section.hidden = false;
    const errors = items.filter(item => item.report?.status === 'error').length;
    const waiting = items.filter(item => item.report?.status === 'waiting').length;
    const needsReview = items.filter(item => !item.reviewReadError && item.review?.reviewState === 'awaiting_review').length;
    const unknownReview = items.filter(item => item.reviewReadError || !readTaskReview).length;
    counts.textContent = uiCopy.locale === 'en'
      ? `Linked tasks: ${items.length} · reported: errors ${errors}, waiting ${waiting} · awaiting review: ${needsReview}${unknownReview ? ` · review unknown: ${unknownReview}` : ''}`
      : `Связанных задач: ${items.length} · по отчётам: ошибок ${errors}, ожидают ${waiting} · на приёмке: ${needsReview}${unknownReview ? ` · приёмка неизвестна: ${unknownReview}` : ''}`;
    const signature = `items:${uiCopy.locale}:${JSON.stringify(items.map(item => [item.nativeTaskId, item.title, item.runId, item.report, item.review, item.reviewReadError]))}`;
    if (renderedSignature === signature && content.querySelector('ul')) return;
    const list = host.ownerDocument.createElement('ul');
    for (const item of items) {
      const row = host.ownerDocument.createElement('li');
      row.dataset.nativeTaskId = item.nativeTaskId;
      row.dataset.runId = item.runId ?? item.report.runId;
      const title = host.ownerDocument.createElement('strong');
      title.textContent = item.title;
      if (onOpenTask) {
        const open = host.ownerDocument.createElement('button');
        open.type = 'button'; open.textContent = item.title;
        open.addEventListener('click', () => {
          const record = rows.find(record => String(record.source_id) === item.nativeTaskId);
          if (!disposed && record) onOpenTask(record, () => {
            if (!disposed && open.isConnected) open.focus({ preventScroll:true });
            else if (!disposed) summary.focus({ preventScroll:true });
          });
        });
        title.replaceChildren(open);
      }
      const status = host.ownerDocument.createElement('p');
      if (!item.report) {
        status.textContent = uiCopy('Нет связанных отчётов о работе ИИ. Регистрация задачи не означает запуск.');
        row.append(title, status);
      } else {
        const who = uiCopy(AGENT_LABELS[item.report.agent]);
        status.textContent = uiCopy.format('По последнему отчёту{0}: исполнитель {1}.', who ? ` (${who})` : '', uiCopy(STATUS_LABELS[item.report.status]));
        const facts = host.ownerDocument.createElement('p');
        facts.textContent = uiCopy.format('Модель: {0} · этап: {1} · актуальность: {2}', item.report.model || uiCopy('не сообщена'), item.report.stage || uiCopy('не сообщён'), (!item.report.freshness || item.report.freshness === 'unknown') ? uiCopy('неизвестна') : item.report.freshness);
        if (item.report.status === 'done') status.textContent += uiCopy(' Завершение задачи требует приёмки пользователем.');
        row.append(title, status, facts);
      }
      if (item.reviewReadError) {
        const unknown = host.ownerDocument.createElement('p'); unknown.textContent = uiCopy('Состояние приёмки не обновлено. Повтори чтение.'); row.append(unknown);
      } else if (item.review) {
        row.dataset.resultVersion = String(item.review.resultVersion);
        const review = host.ownerDocument.createElement('p');
        review.textContent = item.review.reviewState === 'awaiting_review' ? uiCopy.format('На приёмке · результат v{0}', item.review.resultVersion)
          : item.review.reviewState === 'accepted' ? uiCopy.format('Принято · результат v{0}', item.review.resultVersion)
          : item.review.reviewState === 'awaiting_dispatch' ? uiCopy('Ожидает передачи исполнителю') : uiCopy('В работе');
        row.append(review);
      }
      list.append(row);
    }
    const focused = content.contains(host.ownerDocument.activeElement) ? host.ownerDocument.activeElement.closest('li')?.dataset.nativeTaskId : null;
    content.replaceChildren(list);
    if (focused) ([...list.children].find(row => row.dataset.nativeTaskId === focused)?.querySelector('button') || summary).focus({ preventScroll:true });
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
      // The shared join treats disabled/missing authority like an absent result.
      // This summary must distinguish that unavailable authority from a known 404 absence.
      const unavailableReviews = new Set();
      const readReview = readTaskReview && (async id => {
        try { return await readTaskReview(id); }
        catch (error) {
          if (!(error?.status === 404 && error?.code === 'no_review_result')) unavailableReviews.add(id);
          throw error;
        }
      });
      const observed = await readNativeTaskObservations(rows, invoke, { readReview });
      if (!observed.available) throw new Error('Native observation read failed');
      if (disposed || request !== revision) return;
      note.textContent = uiCopy(unknownFreshness);
      render(rows, observed.contexts, unavailableReviews);
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
