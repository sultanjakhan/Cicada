import { invoke as defaultInvoke } from './state.js';
import { createCalendarDialog } from './calendar-dialog.js';
import { createRecurringStore, recurringItems, validDate } from './calendar-recurring-store.js';
import { escapeHtml } from './utils.js';

const DAYS=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
const LABELS={pending:'Без отметки',done:'Сделано',skipped:'Пропущено',kept:'Соблюдено',broken:'Не соблюдено'};
const escaped=value=>escapeHtml(String(value??''));
export function mountCalendarRecurring(element,{invoke=defaultInvoke,showCompleted=false,now}={}) {
  const document=element.ownerDocument,window=document.defaultView,store=createRecurringStore(invoke,{now});
  let disposed=false,busy=false,state=null,date=store.today(),followToday=true,expanded=showCompleted,manager=null,editor=null,revision=0;
  element.classList.add('calendar-recurring');
  element.innerHTML=`<header><div><h2>Дела и правила</h2><p>Повторяются по расписанию. Отметки хранятся по дням.</p></div><button type="button" data-recurring-manage>Настроить</button></header>
    <div class="calendar-recurring__toolbar"><label>День <input type="date" data-recurring-date aria-label="День для дел и правил"></label><button type="button" data-recurring-today>Сегодня</button><label><input type="checkbox" data-recurring-completed> С отметкой</label></div>
    <p data-recurring-error role="alert" hidden></p><button type="button" data-recurring-retry hidden>Повторить</button><div data-recurring-list aria-live="polite"></div>`;
  const list=element.querySelector('[data-recurring-list]'),error=element.querySelector('[data-recurring-error]'),retry=element.querySelector('[data-recurring-retry]'),dateInput=element.querySelector('[data-recurring-date]'),completed=element.querySelector('[data-recurring-completed]');
  dateInput.value=date;completed.checked=expanded;
  function fail(err){error.textContent=err?.message||String(err);error.hidden=false;retry.hidden=false;}
  function render(){
    if(disposed||!state)return;
    const all=recurringItems(state,date),items=all.filter(item=>expanded||item.status==='pending');
    list.innerHTML=items.length?items.map(item=>`<div class="calendar-recurring__row" data-recurring-id="${escaped(item.id)}"><div><strong>${escaped(item.title)}</strong><small>${item.kind==='rule'?'Правило':'Дело'}${item.time?' · '+escaped(item.time):''}${item.endsOn?' · до '+escaped(item.endsOn):''}</small></div><div class="calendar-recurring__marks">${(item.status==='pending'?(item.kind==='rule'?[['kept','Соблюдено'],['broken','Не соблюдено']]:[['done','Сделано'],['skipped','Пропустить']]):[['pending','Отменить отметку']]).map(([status,label])=>`<button type="button" data-recurring-status="${status}" ${busy||date>store.today()?'disabled':''}>${label}</button>`).join('')}${item.status!=='pending'?`<span>${LABELS[item.status]}</span>`:''}</div></div>`).join(''):`<p class="calendar-recurring__empty">${all.length?'На этот день всё отмечено. Включи «С отметкой», чтобы посмотреть или исправить.':state.plans.length?'На этот день нет дел по расписанию.':'Добавь повторяющееся дело или правило: выбери дни недели и, если нужно, срок курса.'}</p>`;
    element.setAttribute('aria-busy',String(busy));
  }
  async function refresh(){const own=++revision;try{const loaded=await store.read();if(disposed||own!==revision)return;state=loaded;error.hidden=true;retry.hidden=true;render();}catch(err){if(!disposed&&own===revision)fail(err);}}
  async function mark(id,status){if(busy)return;busy=true;render();try{const result=await store.setStatus(id,status,date);state=result.state;error.hidden=true;retry.hidden=true;window.dispatchEvent(new window.CustomEvent('hanni:recurring-changed'));}catch(err){fail(err);}finally{busy=false;render();}}
  function edit(plan=null){
    if(editor)return;
    const dialog=createCalendarDialog({document,title:plan?'Изменить расписание':'Дело или правило',submitLabel:'Сохранить',onClose:()=>{editor=null;},isCurrent:()=>!disposed});editor=dialog;
    const item=plan||{kind:'action',weekdays:[0,1,2,3,4,5,6],startsOn:store.today(),active:true};
    dialog.body.innerHTML=`<label>Способ учёта<select name="kind" ${plan?'disabled':''}><option value="action">Дело — сделать и отметить</option><option value="rule">Правило — соблюдено или нет</option></select></label><label>Название<input name="title" maxlength="160" autocomplete="off" placeholder="Что повторять или соблюдать" value="${escaped(item.title||'')}"></label><fieldset class="calendar-recurring__week"><legend>Дни недели</legend>${[1,2,3,4,5,6,0].map(day=>`<label><input type="checkbox" name="weekday" value="${day}" ${item.weekdays.includes(day)?'checked':''}>${DAYS[day]}</label>`).join('')}</fieldset><div class="calendar-recurring__dates"><label>С какого дня<input name="startsOn" type="date" value="${escaped(item.startsOn||'')}"></label><label>Последний день курса<input name="endsOn" type="date" value="${escaped(item.endsOn||'')}"></label><label>Время, если нужно<input name="time" type="time" value="${escaped(item.time||'')}"></label></div><p class="calendar-recurring__help">Время помогает упорядочить список. Уведомления пока не отправляются.</p><label><input name="active" type="checkbox" ${item.active?'checked':''}> Расписание действует</label>`;
    dialog.body.querySelector('[name=kind]').value=item.kind;
    dialog.form.addEventListener('submit',async()=>{
      if(dialog.pending)return;
      const field=name=>dialog.body.querySelector(`[name=${name}]`);
      const fields={kind:field('kind').value,title:field('title').value,weekdays:[...dialog.body.querySelectorAll('[name=weekday]:checked')].map(input=>Number(input.value)),startsOn:field('startsOn').value,endsOn:field('endsOn').value,time:field('time').value,active:field('active').checked};
      dialog.setPending(true);dialog.showError('');
      try{const result=await store.savePlan(fields,plan?.id);state=result.state;dialog.setPending(false);dialog.close();render();renderManager();window.dispatchEvent(new window.CustomEvent('hanni:recurring-changed'));}
      catch(err){dialog.setPending(false);dialog.showError(err?.message||String(err));}
    });
    dialog.open(dialog.body.querySelector('[name=title]'));
  }
  function renderManager(){if(!manager||!state)return;manager.body.innerHTML=`<button type="button" data-recurring-add>+ Дело или правило</button><div class="calendar-recurring__plans">${state.plans.length?state.plans.map(plan=>`<button type="button" data-recurring-edit="${escaped(plan.id)}"><strong>${escaped(plan.title)}</strong><small>${plan.kind==='rule'?'Правило':'Дело'} · ${plan.weekdays.map(day=>DAYS[day]).join(', ')}${plan.active?'':' · выключено'}${plan.endsOn?' · до '+escaped(plan.endsOn):''}</small></button>`).join(''):'<p>Пока нет расписаний. Новые записи появятся в списке в назначенные дни.</p>'}</div>`;}
  let openingManager=false;
  async function manage(){
    if(manager||openingManager||disposed)return;openingManager=true;
    const dialog=createCalendarDialog({document,title:'Дела и правила',hint:'Дни недели и сроки курса. Старые отметки сохраняются при изменении расписания.',onClose:()=>{editor?.dispose();editor=null;manager=null;dispose.onManagerClose?.();},isCurrent:()=>!disposed});
    manager=dialog;dialog.modal.querySelector('footer [data-dialog-close]').textContent='Закрыть';dialog.body.textContent='Загружаем расписания…';
    dialog.body.addEventListener('click',event=>{const button=event.target.closest('button');if(button?.hasAttribute('data-recurring-add'))edit();else if(button?.dataset.recurringEdit)edit(state.plans.find(plan=>plan.id===button.dataset.recurringEdit));});
    const load=async()=>{await refresh();if(manager!==dialog||disposed)return;if(error.hidden){dialog.showError('');dialog.retry.hidden=true;renderManager();}else{dialog.showError(error.textContent);dialog.retry.hidden=false;}};
    dialog.retry.onclick=()=>void load();dialog.open();await load();openingManager=false;
  }
  element.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.hasAttribute('data-recurring-manage'))void manage();else if(button.hasAttribute('data-recurring-today')){date=store.today();followToday=true;dateInput.value=date;render();}else if(button.hasAttribute('data-recurring-retry'))void refresh();else if(button.dataset.recurringStatus)void mark(button.closest('[data-recurring-id]').dataset.recurringId,button.dataset.recurringStatus);});
  dateInput.addEventListener('change',()=>{if(!validDate(dateInput.value))return;date=dateInput.value;followToday=date===store.today();render();});
  completed.addEventListener('change',()=>{expanded=completed.checked;render();});
  const preferences=event=>{if(typeof event.detail?.changes?.showCompleted==='boolean'){expanded=event.detail.changes.showCompleted;completed.checked=expanded;render();}};
  window.addEventListener('hanni:open-recurring-settings',manage);window.addEventListener('hanni:calendar-settings-changed',preferences);
  const timer=window.setInterval(()=>{if(followToday&&date!==store.today()){date=store.today();dateInput.value=date;void refresh();}},30000);
  void refresh();
  const dispose=()=>{if(disposed)return;disposed=true;revision++;window.clearInterval(timer);editor?.dispose();manager?.dispose();window.removeEventListener('hanni:open-recurring-settings',manage);window.removeEventListener('hanni:calendar-settings-changed',preferences);};
  dispose.openManager=manage;
  return dispose;
}
