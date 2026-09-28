import { jiraErrorText } from './jira-import.js';

// Native owns the durable request journal. Reloading options never repeats a POST.
export function mountJiraCreate(element, { invoke, onChange, onPending, onRecovered, onCompleted }) {
  const document = element.ownerDocument;
  let active = false, loaded = false, busy = false, data = null, failure = '';
  let submitted = null;
  element.innerHTML = `<p data-jira-create-destination></p>
    <label class="evm-field" data-jira-create-type-label>Тип задачи в Jira
      <select class="form-select" data-jira-create-type></select></label>
    <p class="evm-jira-hint" data-jira-create-hint>В Jira отправятся название и тип. Дата, цель и этап Cicada сохранятся только в Cicada.</p>
    <p class="evm-error" role="alert" data-jira-create-error hidden></p>
    <button type="button" class="btn-secondary" data-jira-create-retry hidden>Обновить подключение</button>
    <p role="status" data-jira-create-recovery hidden></p>
    <button type="button" class="btn-secondary" data-jira-create-ack hidden></button>`;
  const q = name => element.querySelector(`[data-jira-create-${name}]`);
  const type = q('type');
  const ready = () => active && !busy && !!data?.requestId && !data.recovery && !!type.value && !failure;
  const render = () => {
    element.hidden = !active;
    element.setAttribute('aria-busy', String(busy));
    q('destination').textContent = busy ? 'Загружаем подключение Jira…' : data?.project ? `Новая задача в Jira · ${data.project}` : 'Рабочая задача создаётся в подключённом проекте Jira.';
    q('type-label').hidden = busy || !data?.requestId || !!data.recovery;
    q('hint').hidden = !!data?.recovery;
    q('error').textContent = failure; q('error').hidden = !failure;
    q('retry').hidden = !failure; q('retry').disabled = busy;
    const recovery = data?.recovery;
    q('recovery').hidden = !recovery;
    q('recovery').textContent = recovery ? recovery.state === 'created'
      ? `Задача уже создана в Jira: «${recovery.title}». Она сохранена в Cicada.`
      : `Jira могла создать задачу «${recovery.title}», но подтверждение не получено. Проверь её в Jira и загрузи задачи через настройки подключения. Повторная отправка заблокирована, чтобы не создать дубль.` : '';
    q('ack').hidden = !recovery; q('ack').disabled = busy;
    q('ack').textContent = recovery?.state === 'created' ? 'Готово — задача уже создана' : 'Проверил Jira — разрешить новое создание';
    onChange();
  };
  const load = async () => {
    if (busy) return;
    busy = true; failure = ''; loaded = true; render();
    const selected = type.value;
    try {
      data = await invoke('jira_create_options');
      type.replaceChildren(new document.defaultView.Option('Выбери тип задачи', ''), ...(data.issueTypes || []).map(item => new document.defaultView.Option(item.name, item.id)));
      if ((data.issueTypes || []).some(item => item.id === selected)) type.value = selected;
      else if (data.issueTypes?.length === 1) type.value = data.issueTypes[0].id;
    } catch (error) { data = null; failure = jiraErrorText(typeof error === 'string' ? error : error?.message); }
    finally { busy = false; if (element.isConnected) render(); }
  };
  type.addEventListener('change', onChange);
  q('retry').addEventListener('click', () => void load());
  q('ack').addEventListener('click', async () => {
    if (busy || !data?.recovery) return;
    const recovery = data.recovery;
    busy = true; failure = ''; onPending(true); render();
    try {
      if (recovery.state === 'created') await onRecovered(recovery, submitted?.requestId === recovery.requestId ? submitted.local : null);
      await invoke('jira_create_acknowledge', { requestId: recovery.requestId });
      if (recovery.state === 'created') { onCompleted(); return; }
      busy = false; await load();
    } catch { failure = 'Не удалось завершить подтверждение. Повтори подтверждение; задача повторно не отправляется.'; }
    finally { busy = false; if (element.isConnected) { onPending(false); render(); } }
  });
  return {
    setActive(value) { active = value; element.hidden = !value; if (value && !loaded) void load(); },
    ready,
    async create(title, local) {
      if (!ready()) throw 'jira_create_not_ready';
      submitted = { requestId: data.requestId, local };
      try { return await invoke('jira_task_create', { requestId: data.requestId, title, issueTypeId: type.value, local }); }
      catch (error) {
        // An IPC error may follow a successful remote write. Reconcile via the journal.
        await load();
        throw error;
      }
    },
    acknowledge(requestId) { return invoke('jira_create_acknowledge', { requestId }); },
  };
}
