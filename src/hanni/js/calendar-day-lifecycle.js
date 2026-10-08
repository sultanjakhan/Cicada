import { createCalendarDialog } from './calendar-dialog.js';
import { createUiCopy } from './ui-copy.js';
export const DAY_PENDING_KEY = 'cicada_day_action_pending_v1';
const terminal = /^calendar_day_(stale_preview|context_changed|already_closed|not_closed|invalid_selection|task_unavailable|operation_conflict|invalid_operation|invalid_action|invalid_date|unknown_schema|invalid_ledger)$/;
export const DAY_QUARANTINE_KEY = 'cicada_day_action_quarantine_v1';
export function validDayRequest(value) {
  const fields = ['operation_id','action','date','local_date','offset_minutes','token','task_ids'];
  const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(f => Object.hasOwn(value,f))
    && typeof value.operation_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.operation_id)
    && ['close','reopen','plan'].includes(value.action) && date(value.date) && date(value.local_date)
    && Number.isInteger(value.offset_minutes) && Math.abs(value.offset_minutes) < 1440
    && typeof value.token === 'string' && /^[0-9a-f]{64}$/i.test(value.token)
    && Array.isArray(value.task_ids) && value.task_ids.length <= 500 && value.task_ids.every(id => typeof id === 'string' && id.length > 0) && new Set(value.task_ids).size === value.task_ids.length
    && (value.action === 'plan' || value.task_ids.length === 0);
}
const secondsText = value => `${Math.floor(value / 60)}:${String(value % 60).padStart(2,'0')}`;

/** One device-local projection; the native transaction owns timers and receipts. */
export function mountCalendarDayLifecycle(host, { invoke, onOpenTask = () => {}, onDayState = () => {}, storage = null } = {}) {
  const document = host.ownerDocument, window = document.defaultView;
  const uiCopy = createUiCopy(document);
  let snapshot = null, dialog = null, pending = null, busy = false, disposed = false, revision = 0, corrupted = null;
  host.className = 'calendar-day-lifecycle';
  host.innerHTML = `<div class="calendar-day-lifecycle__actions"><button type="button" data-end-day disabled>${uiCopy('Завершить день')}</button><button type="button" data-next-day-plan disabled>${uiCopy('План на завтра')}</button><button type="button" data-day-summary hidden>${uiCopy('Итоги дней')}</button><button type="button" data-day-action-retry hidden>${uiCopy('Повторить сохранение')}</button><button type="button" data-day-pending-discard hidden>${uiCopy('Отбросить повреждённый запрос')}</button></div><p data-day-status role="status"></p><div data-day-plan-today></div>`;
  const q = name => host.querySelector(`[data-${name}]`);
  function store(value) {
    if (value) storage.setItem(DAY_PENDING_KEY, JSON.stringify(value));
    else storage.removeItem(DAY_PENDING_KEY);
  }
  try {
    storage ||= window.localStorage;
    const raw = storage.getItem(DAY_PENDING_KEY);
    if (raw) {
      try { const parsed=JSON.parse(raw); if (!validDayRequest(parsed)) throw Error('Invalid saved day request'); pending=parsed; }
      catch { corrupted=raw; }
    }
  } catch { q('day-status').textContent = uiCopy('Хранилище запроса дня недоступно. Сохранение заблокировано.'); busy = true; }
  function paint() {
    if (disposed) return;
    onDayState(snapshot?.day.closed ?? null);
    q('end-day').hidden = !!snapshot?.day.closed;
    q('end-day').disabled = q('next-day-plan').disabled = busy || !!pending || corrupted !== null || !snapshot;
    q('day-summary').hidden = !snapshot?.history.length;
    q('day-summary').disabled = busy;
    q('day-action-retry').hidden = !pending;
    q('day-action-retry').disabled = busy;
    q('day-pending-discard').hidden = corrupted === null;
    q('day-pending-discard').disabled = busy;
    if (corrupted !== null) q('day-status').textContent = uiCopy('Сохранённый запрос повреждён. Его нельзя повторить. Отбросьте его для нового предпросмотра; подтверждённые итоги остаются в истории.');
    else if (pending) q('day-status').textContent = uiCopy('Сохранение не подтверждено. Повтори тот же запрос.');
    else if (snapshot) q('day-status').textContent = snapshot.day.closed ? uiCopy('День закрыт. Таймеры не возобновляются автоматически.') : '';
    const plan=q('day-plan-today'); plan.replaceChildren();
    if (snapshot?.day.plan_ids.length) {
      const title=document.createElement('h3'); title.textContent=uiCopy('План на сегодня');plan.append(title);
      for (const id of snapshot.day.plan_ids) {
        const task=snapshot.candidates.find(t=>t.id===id);if (!task) continue;
        const open=document.createElement('button');open.type='button';open.textContent=task.title;open.onclick=()=>onOpenTask({source_type:'note',source_id:id,title:task.title});plan.append(open);
      }
    }
  }
  async function refresh() {
    if (disposed || busy) return;
    const request=++revision;
    try {
      const value=await invoke('read_calendar_day',{date:null});
      if (disposed || request!==revision) return;
      if (!value || value.scope!=='device_local' || !Array.isArray(value.active_blocks) || !Array.isArray(value.candidates) || !Array.isArray(value.history) || !Array.isArray(value.day?.plan_ids)) throw Error('Invalid native day snapshot');
      snapshot=value;paint();
    } catch { if (!disposed && request===revision) {snapshot=null;paint();q('day-status').textContent=uiCopy('Состояние дня недоступно. Данные не изменены.');} }
  }
  async function perform(request) {
    if (busy || disposed) return;
    // Persist the identical UUID and payload before an IPC call can have an unknown outcome.
    try { store(request); } catch { dialog?.showError(uiCopy('Не удалось сохранить запрос для повторной попытки. Данные не изменены.'));q('day-status').textContent=uiCopy('Не удалось сохранить запрос для повторной попытки.');return; }
    pending=request;busy=true;++revision;paint();dialog?.setPending(true);
    try {
      const receipt=await invoke('commit_calendar_day_action',{input:request});
      if (disposed) return;
      if (receipt?.operation_id!==request.operation_id || receipt.action!==request.action) throw Error('Unconfirmed native receipt');
      store(null);pending=null;
      dialog?.setPending(false);dialog?.close();dialog=null;
      window.dispatchEvent(new window.Event('task-state-changed'));
      window.dispatchEvent(new window.Event('hanni:calendar-refresh'));
    } catch (error) {
      if (disposed) return;
      const code=String(error?.message || error);
      if (terminal.test(code)) {
        try {store(null);pending=null;} catch { /* Keep the exact retry if local acknowledgement failed. */ }
        dialog?.showError(uiCopy('Предпросмотр устарел или данные изменились. Закрой окно и перечитай состояние.'));
      } else dialog?.showError(uiCopy('Сохранение не подтверждено. Повтори тот же запрос; новое действие пока недоступно.'));
    } finally {
      busy=false;
      if (!disposed) {dialog?.setPending(false);paint();if (!pending) await refresh();}
    }
  }
  function requestFor(preview,action,task_ids=[]) {
    return {operation_id:window.crypto.randomUUID(),action,date:preview.date,local_date:preview.local_date,offset_minutes:preview.offset_minutes,token:preview.token,task_ids};
  }
  function paragraph(text) {const p=document.createElement('p');p.textContent=text;return p;}
  async function open(action,date=null) {
    if (busy || pending || corrupted !== null || disposed || dialog) return;
    busy=true;paint();
    let preview, previewFailed = false;
    try {preview=await invoke('read_calendar_day',{date});if(disposed)return;}
    catch {previewFailed=true;return;}
    finally {busy=false;if(!disposed){paint();if(previewFailed)q('day-status').textContent=uiCopy('Предпросмотр недоступен. Данные не изменены.');}}
    const summary = action==='summary';
    const zone = (preview.offset_minutes>=0?'+':'-') + String(Math.floor(Math.abs(preview.offset_minutes)/60)).padStart(2,'0') + ':' + String(Math.abs(preview.offset_minutes)%60).padStart(2,'0');
    dialog=createCalendarDialog({document,title:action==='plan'?uiCopy('План на завтра'):summary?uiCopy('Итог дня'):uiCopy('Завершить день'),
      hint:`${preview.date} · UTC${zone} · ${uiCopy('На этом устройстве')}`,
      submitLabel:summary?(preview.day.closed?uiCopy('Открыть день снова'):null):action==='plan'?uiCopy('Сохранить план'):uiCopy('Завершить день'),
      onClose:()=>{if(dialog===current)dialog=null;},returnFocus:()=>host.querySelector('button:not([hidden])')?.focus()});
    const current=dialog;
    if (action==='plan') {
      current.body.append(paragraph(uiCopy('План на {date}. Сроки задач сохраняются.').replace('{date}', preview.next_date)));
      for (const task of preview.candidates) {
        const label=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span');input.type='checkbox';input.value=task.id;input.dataset.dayPlanTask='';input.checked=preview.next_day.plan_ids.includes(task.id);
        text.textContent=task.title+(task.deadline?`${uiCopy(' · срок ')}${task.deadline}`:'');label.append(input,text);current.body.append(label);
      }
      if(!preview.candidates.length)current.body.append(paragraph(uiCopy('Незавершённых задач нет. Можно сохранить пустой план.')));
      const skip=document.createElement('button');skip.type='button';skip.textContent=uiCopy('Пропустить');skip.dataset.dayPlanSkip='';skip.onclick=()=>current.close();current.body.append(skip);
    } else if(summary) {
      for(const item of preview.day.summaries){current.body.append(paragraph(`${uiCopy('Закрыт: ')}${item.closed_at_utc}`));for(const block of item.paused_blocks)current.body.append(paragraph(`${block.title || block.source_id} · ${secondsText(block.seconds)}`));}
      current.body.append(paragraph(uiCopy('Повторное открытие сохраняет итог и не запускает таймеры.')));
    } else {
      current.body.append(paragraph(uiCopy('Будут поставлены на паузу человеческие таймеры:')));
      const list=document.createElement('ul');for(const block of preview.active_blocks){const li=document.createElement('li');li.textContent=`${block.title || block.source_id} · ${secondsText(block.seconds)}`;list.append(li);}current.body.append(list);
      if(!preview.active_blocks.length)current.body.append(paragraph(uiCopy('Работающих человеческих таймеров нет.')));
      current.body.append(paragraph(uiCopy('Задачи остаются незавершёнными. Работа ИИ не меняется.')));
    }
    current.form.addEventListener('submit',()=> {
      if(current!==dialog || busy || pending) return;
      const ids=action==='plan'?[...current.body.querySelectorAll('input[data-day-plan-task]:checked')].map(i=>i.value):[];
      void perform(requestFor(preview,summary?'reopen':action,ids));
    });
    current.open();
  }
  q('end-day').onclick=()=>void open('close');q('next-day-plan').onclick=()=>void open('plan');
  q('day-action-retry').onclick=()=>{if(pending)void perform(pending);};
  q('day-summary').onclick=()=>{
    if(busy || dialog || !snapshot)return;
    const dates=snapshot.history;
    if(dates.length===1){void open('summary',dates[0].date);return;}
    let selectedDate = null;
    dialog=createCalendarDialog({document,title:uiCopy('Итоги дней'),onClose:()=>{dialog=null;if(selectedDate && !disposed)void open('summary',selectedDate);}});
    const current=dialog;
    for(const day of [...dates].reverse()){const b=document.createElement('button');b.type='button';b.textContent=day.date+(day.closed?uiCopy(' · закрыт'):uiCopy(' · открыт'));b.onclick=()=>{selectedDate=day.date;current.close();};current.body.append(b);}current.open();
  };
  q('day-pending-discard').onclick=()=>{
    if(busy || corrupted === null) return;
    try { storage.setItem(DAY_QUARANTINE_KEY,corrupted); store(null); corrupted=null;paint();void refresh(); }
    catch { q('day-status').textContent=uiCopy('Не удалось сохранить повреждённый запрос отдельно. Он не удалён.'); }
  };
  const onRefresh=()=>void refresh();window.addEventListener('hanni:calendar-refresh',onRefresh);window.addEventListener('task-state-changed',onRefresh);window.addEventListener('focus',onRefresh);
  const interval=window.setInterval(onRefresh,30_000);
  void (async()=>{
    if(pending){try{const receipt=await invoke('read_calendar_day_operation',{input:pending});if(!disposed && receipt?.operation_id===pending.operation_id){store(null);pending=null;}}catch{/* Unknown outcome retains its exact request. */}}
    if(!disposed){paint();await refresh();}
  })();
  return ()=>{disposed=true;++revision;window.clearInterval(interval);window.removeEventListener('hanni:calendar-refresh',onRefresh);window.removeEventListener('task-state-changed',onRefresh);window.removeEventListener('focus',onRefresh);dialog?.dispose();};
}
