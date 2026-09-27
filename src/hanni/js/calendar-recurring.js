import { invoke as defaultInvoke } from './state.js';
import { createCalendarDialog } from './calendar-dialog.js';
import { applies, createRecurringStore, recurringItems, validDate, unfinishedRun } from './calendar-recurring-store.js';
import { openRecurringRun } from './calendar-routine-execution.js';
import { openCalendarRoutineEditor } from './calendar-routine-editor.js';
import { escapeHtml } from './utils.js';

const DAYS=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
const escaped=value=>escapeHtml(String(value??''));
const countedItems=count=>{const last=count%10,teen=count%100;return `${count} ${last===1&&teen!==11?'дело':last>=2&&last<=4&&(teen<12||teen>14)?'дела':'дел'}`;};
const routineKind=plan=>plan.kind==='rule'?'Правило на день':['chain','graph'].includes(plan.mode)?`${plan.steps.length} ${plan.steps.length%10===1&&plan.steps.length%100!==11?'шаг':plan.steps.length%10>=2&&plan.steps.length%10<=4&&(plan.steps.length%100<12||plan.steps.length%100>14)?'шага':'шагов'}`:plan.mode==='activity'?'С учётом времени':'Без таймера';
const frequency=plan=>`${plan.time?`${plan.time} · `:''}${plan.weekdays.length===7?'Каждый день':plan.weekdays.map(day=>DAYS[day]).join(', ')}${plan.endsOn?` · до ${plan.endsOn}`:''}`;

// The dashboard owns the card. The optional task mount fills its persistent slot.
export function mountCalendarRecurring(element,{invoke=defaultInvoke,showCompleted=false,now,mountTasks,library=false}={}) {
  const document=element.ownerDocument,window=document.defaultView,store=createRecurringStore(invoke,{now});
  let disposed=false,busy=false,state=null,date=store.today(),followToday=true,expanded=showCompleted,manager=null,editor=null,details=null,history=null,revision=0,taskMeta={visible:0,currentKey:'',currentState:''},tasks=null,libraryQuery='',libraryRows=new Map();
  element.classList.add('calendar-recurring',library?'calendar-recurring--library':'calendar-recurring--today');
  element.innerHTML=library?`<section class="calendar-recurring__card calendar-recurring__library" aria-labelledby="calendar-routines-heading">
    <header class="calendar-recurring__heading"><div><h2 id="calendar-routines-heading" data-recurring-heading>Рутины</h2><small data-recurring-count></small></div></header>
    <p data-recurring-error role="alert" hidden></p><button type="button" data-recurring-retry hidden>Повторить</button>
    <div class="calendar-routine-controls"><input type="search" data-routine-search aria-label="Найти рутину" placeholder="Найти рутину"></div>
    <div class="calendar-recurring__plans" data-library-plans></div>
    <p class="calendar-recurring__empty" data-library-no-results role="status" hidden>Ничего не найдено. Попробуй другое название.</p>
  </section>`:`<section class="calendar-recurring__card" aria-labelledby="calendar-today-heading">
    <div class="calendar-recurring__heading"><div><h2 id="calendar-today-heading" data-recurring-heading>Сегодня</h2><small data-recurring-count></small></div><div class="calendar-recurring__tools"><button type="button" class="calendar-recurring__text" data-recurring-history>История</button><button type="button" class="calendar-recurring__text" data-recurring-today hidden>Сегодня</button></div></div>
    <div class="calendar-recurring__section"><h3>Дела</h3><button type="button" class="calendar-recurring__text" data-recurring-all>Все задачи</button><button type="button" class="calendar-recurring__text" data-recurring-manage>Рутины</button></div>
    <p data-recurring-error role="alert" hidden></p><button type="button" data-recurring-retry hidden>Повторить</button>
    <div data-recurring-tasks></div><div data-recurring-list aria-live="polite"></div><details class="calendar-recurring__completed" data-recurring-completed><summary data-recurring-completed-label></summary><div data-recurring-completed-list></div></details>
  </section>`;
  const q=name=>element.querySelector(`[data-recurring-${name}]`);
  const list=q('list'),error=q('error'),retry=q('retry'),historyButton=q('history'),todayButton=q('today'),completed=q('completed'),completedLabel=q('completed-label'),completedList=q('completed-list'),heading=q('heading'),count=q('count'),taskHost=q('tasks');
  const notifyTasks=meta=>{ if(disposed||taskMeta.visible===meta.visible&&taskMeta.currentKey===meta.currentKey&&taskMeta.currentState===meta.currentState)return; taskMeta=meta; renderHeading(); renderPlanList(); };
  if(mountTasks) { tasks=mountTasks(taskHost); tasks?.onCount?.(notifyTasks); }
  function renderHeading(){
    const today=date===store.today(),hasUnfinishedCurrent=Boolean(taskMeta.currentKey&&taskMeta.currentState!=='completed');
    heading.textContent=today?'Сегодня':'Дневные отметки';
    const parsed=new Date(`${date}T12:00:00`),year=parsed.getFullYear()===new Date(`${store.today()}T12:00:00`).getFullYear()?{}:{year:'numeric'};
    historyButton.textContent=today?'История':`История · ${new Intl.DateTimeFormat('ru',{day:'numeric',month:'short',...year}).format(parsed)}`;
    historyButton.setAttribute('aria-label',today?'История отметок':`История отметок за ${new Intl.DateTimeFormat('ru',{day:'numeric',month:'long',year:'numeric'}).format(parsed)}`);
    todayButton.hidden=today;
    const pending=state?recurringItems(state,date).filter(item=>item.status==='pending').length:0;
    const remaining=taskMeta.visible+pending;
    if(!state){count.textContent='';return;}
    if(today)count.textContent=hasUnfinishedCurrent?(remaining?`Ещё ${countedItems(remaining)} на сегодня`:'Других дел на сегодня нет'):(remaining?`${countedItems(remaining)} на сегодня`:'На сегодня дел нет');
    else count.textContent=remaining?`${countedItems(remaining)} без отметки`:'Нет дел без отметки';
  }
  function planRow(item) {
    const finished=item.status!=='pending'; const status=item.status==='done'?'Выполнено':item.status==='skipped'?'Пропущено':item.status==='kept'?'Соблюдено':item.status==='broken'?'Не соблюдено':'Ещё не отмечено';
    const runnable=item.kind==='action'&&['activity','chain','graph'].includes(item.mode);
    const control=runnable ? (finished?`<span class="calendar-recurring__status">${status}</span><button type="button" class="calendar-recurring__text" data-recurring-run>Просмотреть</button>`:`<button type="button" data-recurring-run>${item.run?'Продолжить':'Начать'}</button>`) : item.kind==='rule' ? (item.status==='pending'?'<span class="calendar-recurring__status">Ещё не отмечено</span><button type="button" data-recurring-details>Отметить</button>':`<span class="calendar-recurring__status ${item.status==='kept'?'is-good':'is-missed'}">${status}</span><button type="button" class="calendar-recurring__text" data-recurring-details>Изменить</button>`) : (item.status==='pending'?'<button type="button" data-recurring-status="done">✓ Выполнено</button>':`<span class="calendar-recurring__status ${item.status==='done'?'is-good':''}">${status}</span><button type="button" class="calendar-recurring__text" data-recurring-status="pending">Отменить</button>`);
    return `<div class="calendar-recurring__row ${finished?'is-recorded':''}" data-recurring-id="${escaped(item.id)}"><div class="calendar-recurring__copy"><button type="button" data-recurring-details>${escaped(item.title)}</button><small>${item.required===false?'По желанию':'Обязательное'} · ${escaped(frequency(item))}${item.kind==='rule'?' · правило на день':''}</small></div><div class="calendar-recurring__marks">${control}</div></div>`;
  }
  function renderPlanList(){if(disposed||!state)return;const all=recurringItems(state,date),pending=all.filter(item=>item.status==='pending'),done=all.filter(item=>item.status!=='pending');const hasUnfinishedCurrent=Boolean(taskMeta.currentKey&&taskMeta.currentState!=='completed');const empty=today=>today?(hasUnfinishedCurrent?'Других дел на сегодня нет':'На сегодня дел нет'):'Нет дел без отметки';list.innerHTML=[['action','Рутины'],['rule','Правила']].map(([kind,label])=>{const rows=pending.filter(item=>item.kind===kind);return rows.length?`<section class="calendar-recurring__group"><h3>${label}</h3>${rows.map(planRow).join('')}</section>`:'';}).join('')||(!taskMeta.visible?`<p class="calendar-recurring__empty">${empty(date===store.today())}</p>`:'');completed.hidden=!done.length;completed.open=expanded&&done.length>0;completedLabel.textContent=`Отмечено · ${done.length}`;completedList.innerHTML=done.map(planRow).join('');}
  function render(){if(disposed||!state)return;if(library){renderManager();element.setAttribute('aria-busy',String(busy));return;}tasks?.setDate?.(date);renderHeading();renderPlanList();element.setAttribute('aria-busy',String(busy));}
  function fail(err){error.textContent=err?.message||String(err);error.hidden=false;retry.hidden=false;}
  async function refresh(canCommit=null){if(canCommit&&!canCommit())return;const own=++revision;try{const loaded=await store.read();if(disposed||own!==revision||(canCommit&&!canCommit()))return;state=loaded;error.hidden=true;retry.hidden=true;render();}catch(err){if(!disposed&&own===revision)fail(err);}}
  async function mark(id,status){if(busy)return;busy=true;render();try{const result=await store.setStatus(id,status,date);state=result.state;error.hidden=true;retry.hidden=true;window.dispatchEvent(new window.CustomEvent('hanni:recurring-changed'));}catch(err){fail(err);}finally{busy=false;render();}}
  function openDetails(initialItem,returnFocus){
    if(details||disposed)return;
    const dialog=createCalendarDialog({document,title:initialItem.title,returnFocus,onClose:()=>{details=null;},isCurrent:()=>!disposed});details=dialog;
    dialog.modal.querySelector('footer [data-dialog-close]').textContent='Закрыть';
    const rule=initialItem.kind==='rule',hasReflection=Boolean(initialItem.reflection),drafts=new Map();
    let item=initialItem,pending=item.status==='pending',reflectionDate=date,saveNotice='';
    const forDate=day=>{
      const record=state?.days?.[day]?.[initialItem.id];
      if(record)return{...record.snapshot,status:record.status,run:record.run,reflectionAnswer:record.reflection};
      const plan=state?.plans?.find(value=>value.id===initialItem.id);
      if(plan&&applies(plan,day))return{...plan,status:'pending'};
      return{...initialItem,status:'pending',reflection:null,reflectionAnswer:undefined,reflectionUnavailable:true};
    };
    const captureDraft=()=>{
      if(!dialog.body.querySelector('[data-reflection-rule]'))return;
      drafts.set(reflectionDate,{ruleOutcome:dialog.body.querySelector('[data-reflection-rule]').value,restoration:dialog.body.querySelector('[data-reflection-restoration]').value,trigger:dialog.body.querySelector('[data-reflection-trigger]').value});
    };
    const renderDetails=()=>{
      const saved=drafts.get(reflectionDate)||item.reflectionAnswer||{};
      dialog.body.innerHTML=`<p>${rule?'Отметь, соблюдено ли правило в выбранный день.':'Отметка выполнения для выбранного дня.'}</p><p class="calendar-recurring__dialog-meta">${item.required===false?'По желанию':'Обязательное'} · ${escaped(frequency(item))}${rule?' · правило на день':''}</p>${hasReflection?`<section class="calendar-recurring__reflection"><label>День учёта<input type="date" data-reflection-date max="${store.today()}" value="${escaped(reflectionDate)}"></label>${item.reflection?`<h3>Короткая рефлексия</h3><p>${escaped(item.reflection.prompt)}</p><label>Я следовал своему правилу<select data-reflection-rule><option value="">Выбери ответ</option><option value="kept" ${saved.ruleOutcome==='kept'?'selected':''}>Да</option><option value="broken" ${saved.ruleOutcome==='broken'?'selected':''}>Нет</option><option value="no_answer" ${saved.ruleOutcome==='no_answer'?'selected':''}>Нет ответа</option></select></label><label>Восстановление после дня<select data-reflection-restoration><option value="">Выбери ответ</option><option value="better" ${saved.restoration==='better'?'selected':''}>Лучше</option><option value="same" ${saved.restoration==='same'?'selected':''}>Так же</option><option value="worse" ${saved.restoration==='worse'?'selected':''}>Хуже</option><option value="no_answer" ${saved.restoration==='no_answer'?'selected':''}>Нет ответа</option></select></label><label>Что повлияло, если хочешь<textarea data-reflection-trigger maxlength="500" rows="2">${escaped(saved.trigger||'')}</textarea></label><button type="button" data-save-reflection>Сохранить ответы за этот день</button><p data-reflection-saved role="status" ${saveNotice?'':'hidden'}>${escaped(saveNotice)}</p>`:'<p>На выбранный день рефлексия не запланирована.</p>'}</section>`:''}${rule?`<div class="calendar-recurring__choice-actions">${pending?'<button type="button" data-detail-status="kept">Соблюдено</button><button type="button" data-detail-status="broken">Не соблюдено</button>':'<button type="button" data-detail-status="pending">Отменить отметку</button>'}</div>`:''}<button type="button" class="calendar-recurring__text" data-detail-edit>Изменить рутину</button>`;
    };
    renderDetails();
    dialog.body.addEventListener('change',event=>{
      const input=event.target;
      if(input.matches('[data-reflection-date]')){
        if(!validDate(input.value)||input.value>store.today()){input.value=reflectionDate;dialog.showError('Выбери сегодня или прошедший день.',input);return;}
        captureDraft();reflectionDate=input.value;item=forDate(reflectionDate);pending=item.status==='pending';saveNotice='';dialog.showError('');renderDetails();
      }else if(input.matches('[data-reflection-rule],[data-reflection-restoration]'))dialog.showError('');
    });
    dialog.body.addEventListener('click',async event=>{
      const button=event.target.closest('button');
      if(button?.dataset.detailStatus){void mark(item.id,button.dataset.detailStatus).then(()=>dialog.close());}
      else if(button?.hasAttribute('data-detail-edit')){dialog.close();edit(item);}
      else if(button?.hasAttribute('data-save-reflection')){
        const ruleOutcome=dialog.body.querySelector('[data-reflection-rule]')?.value,restoration=dialog.body.querySelector('[data-reflection-restoration]')?.value;
        if(!ruleOutcome||!restoration){dialog.showError('Выбери ответ на оба вопроса. Если не хочешь отвечать, выбери «Нет ответа».',!ruleOutcome?dialog.body.querySelector('[data-reflection-rule]'):dialog.body.querySelector('[data-reflection-restoration]'));return;}
        captureDraft();dialog.setPending(true);dialog.showError('');
        try{const result=await store.setReflection(item.id,{ruleOutcome,restoration,trigger:dialog.body.querySelector('[data-reflection-trigger]').value},reflectionDate);state=result.state;item=forDate(reflectionDate);pending=item.status==='pending';drafts.delete(reflectionDate);saveNotice='Ответы сохранены за '+reflectionDate+'.';renderDetails();window.dispatchEvent(new window.CustomEvent('hanni:recurring-changed'));render();}
        catch(error){dialog.showError(error?.message||String(error));}
        finally{dialog.setPending(false);dialog.body.querySelector('[data-save-reflection]')?.focus();}
      }
    });
    dialog.open();
  }
  function run(id,start=true){return openRecurringRun({document,invoke,id,date,start});}
  function edit(plan=null,kind='action',options={}){
    if(editor)return;
    const dialog=openCalendarRoutineEditor({document,store,plan,kind,returnFocus:options.returnFocus,isCurrent:()=>!disposed,onClose:()=>{editor=null;},onSaved:next=>{state=next;render();renderManager();}});
    editor=dialog;
  }
  function openHistory(){if(history||disposed)return;const dialog=createCalendarDialog({document,title:'История',hint:'Выбери сегодня или прошедший день.',submitLabel:'Показать',onClose:()=>{history=null;},isCurrent:()=>!disposed});history=dialog;dialog.body.innerHTML=`<label>День учёта<input type="date" data-history-date max="${store.today()}" value="${escaped(date)}"></label><button type="button" class="calendar-recurring__text" data-history-today hidden>Вернуться к сегодня</button>`;const input=dialog.body.querySelector('[data-history-date]'),todayButton=dialog.body.querySelector('[data-history-today]');const sync=()=>{todayButton.hidden=input.value===store.today();};input.addEventListener('input',sync);dialog.form.addEventListener('submit',event=>{event.preventDefault();if(!validDate(input.value)||input.value>store.today()){input.value=date;dialog.showError('Выбери сегодня или прошедший день.',input);return;}date=input.value;followToday=date===store.today();tasks?.setDate?.(date);dialog.close();render();});todayButton.addEventListener('click',()=>{input.value=store.today();sync();input.focus();});sync();dialog.open(input);}
  function renderManager(){
    if(library){
      if(!state)return;
      const target=element.querySelector('[data-library-plans]');
      const search=element.querySelector('[data-routine-search]');
      if(!target)return;
      const focused=document.activeElement===search;
      if(search)libraryQuery=search.value;
      const rows=state.plans.map(plan=>{
        const previous=unfinishedRun(state,plan.id),finished=state.days[date]?.[plan.id]?.run&&!previous;
        const runnable=plan.kind==='action'&&['activity','chain','graph'].includes(plan.mode);
        const kind=routineKind(plan);
        const title=`${plan.title} ${kind} ${frequency(plan)}${plan.active?'':' выключено'}`;
        const occurrence=recurringItems(state,date).find(item=>item.id===plan.id);
        const status=occurrence&&occurrence.status!=='pending'?` · ${occurrence.status==='done'?'Отмечено':occurrence.status==='kept'?'Соблюдено':occurrence.status==='broken'?'Не соблюдено':'Пропущено'}`:'';
        const markButton=occurrence&&plan.kind==='rule'?`<button type="button" data-library-details="${escaped(plan.id)}">${occurrence.status==='pending'?'Отметить':'Изменить отметку'}</button>`:occurrence&&plan.kind==='action'&&!runnable?`<button type="button" data-library-mark="${escaped(plan.id)}" data-library-status="${occurrence.status==='pending'?'done':'pending'}">${occurrence.status==='pending'?'Отметить':'Отменить отметку'}</button>`:'';
        const reflectionButton=plan.reflection?`<button type="button" data-library-reflection="${escaped(plan.id)}">${occurrence?.reflectionAnswer?'Ответы за день':'Заполнить рефлексию'}</button>`:'';
        const html=`<div class="calendar-routine-library-row" data-library-id="${escaped(plan.id)}" data-library-title="${escaped(title.toLocaleLowerCase('ru'))}"><button type="button" data-recurring-edit="${escaped(plan.id)}"><strong>${escaped(plan.title)}</strong><small>${kind} · ${escaped(frequency(plan))}${plan.active?'':' · выключено'}${escaped(status)}</small></button>${runnable&&(plan.active||previous)?`<button type="button" data-library-run="${escaped(plan.id)}" data-library-date="${escaped(previous?.date||date)}" data-library-view="${finished?'true':'false'}">${previous?'Продолжить':finished?'Просмотреть':'Начать'}</button>`:''}${markButton}${reflectionButton}</div>`;
        return {id:plan.id,html};
      });
      const count=element.querySelector('[data-recurring-count]');
      if(count)count.textContent=`${state.plans.filter(plan=>plan.active).length} включено · ${state.plans.filter(plan=>!plan.active).length} выключено`;
      const focusBefore=document.activeElement;
      const focusedRow=focusBefore?.closest?.('[data-library-id]');
      const focusId=focusedRow?.dataset.libraryId;
      const focusSelector=focusedRow&&['data-recurring-edit','data-library-run','data-library-details','data-library-mark','data-library-reflection'].map(name=>document.activeElement.hasAttribute(name)?`[${name}]`:null).find(Boolean);
      const nextRows=new Map();
      if(rows.length)target.querySelector('.calendar-recurring__empty')?.remove();
      for(const row of rows){
        const prior=libraryRows.get(row.id);
        if(prior?.signature===row.html&&prior.node.isConnected){nextRows.set(row.id,prior);continue;}
        const template=document.createElement('template');template.innerHTML=row.html;
        const node=template.content.firstElementChild;
        if(prior?.node.parentElement===target)prior.node.replaceWith(node);
        nextRows.set(row.id,{signature:row.html,node});
      }
      for(const [id,prior] of libraryRows)if(!nextRows.has(id)&&prior.node.parentElement===target)prior.node.remove();
      rows.forEach((row,index)=>{const node=nextRows.get(row.id).node,current=target.children[index]||null;if(current!==node)target.insertBefore(node,current);});
      libraryRows=nextRows;
      if(!rows.length&&!target.querySelector('.calendar-recurring__empty'))target.innerHTML='<p class="calendar-recurring__empty">Создать → Рутина</p>';
      target.querySelectorAll('[data-library-title]').forEach(row=>{row.hidden=!row.dataset.libraryTitle.includes(libraryQuery.trim().toLocaleLowerCase('ru'));});
      element.querySelector('[data-library-no-results]').hidden=!rows.length||Boolean(target.querySelector('[data-library-title]:not([hidden])'));
      if(focusId&&focusSelector&&focusBefore&&!focusBefore.isConnected){const row=libraryRows.get(focusId)?.node; (row?.querySelector(focusSelector)||row?.querySelector('[data-recurring-edit]'))?.focus({preventScroll:true});}
      if(focused)search.focus();
      return;
    }
    if(!manager||!state)return;
    const wasFocused=document.activeElement===manager.body.querySelector('[data-routine-search]');
    const query=manager.body.querySelector('[data-routine-search]')?.value||'';
    manager.body.innerHTML=`<div class="calendar-routine-controls"><input type="search" data-routine-search aria-label="Найти рутину" placeholder="Найти занятие или правило"><button type="button" data-recurring-add>Добавить рутину</button></div><div class="calendar-recurring__plans">${state.plans.length?state.plans.map(plan=>{
      const previous=unfinishedRun(state,plan.id),finished=state.days[store.today()]?.[plan.id]?.run&&!previous;
      const runnable=plan.kind==='action'&&['activity','chain','graph'].includes(plan.mode);
      return `<div class="calendar-routine-library-row" data-library-title="${escaped(plan.title.toLocaleLowerCase('ru'))}"><button type="button" data-recurring-edit="${escaped(plan.id)}"><strong>${escaped(plan.title)}</strong><small>${routineKind(plan)} · ${escaped(frequency(plan))}${plan.active?'':' · выключено'}</small></button>${runnable&&(plan.active||previous)?`<button type="button" data-library-run="${escaped(plan.id)}" data-library-view="${finished?'true':'false'}">${previous?'Продолжить':finished?'Просмотреть':'Начать'}</button>`:''}</div>`;
    }).join(''):'<p>Добавь повторяющееся дело, занятие или цепочку шагов.</p>'}</div>`;
    const search=manager.body.querySelector('[data-routine-search]');search.value=query;
    const filter=()=>manager.body.querySelectorAll('[data-library-title]').forEach(row=>{row.hidden=!row.dataset.libraryTitle.includes(search.value.trim().toLocaleLowerCase('ru'));});
    search.addEventListener('input',filter);filter();if(wasFocused)search.focus();
  }
  async function manage(){
    if(manager||disposed)return;
    const dialog=createCalendarDialog({document,title:'Рутины',hint:'Выбери занятие для запуска или название, чтобы изменить его.',onClose:()=>{editor?.dispose();editor=null;manager=null;dispose.onManagerClose?.();},isCurrent:()=>!disposed});manager=dialog;
    dialog.modal.querySelector('footer [data-dialog-close]').textContent='Закрыть';dialog.body.textContent='Загружаем рутины…';
    dialog.body.addEventListener('click',event=>{const button=event.target.closest('button');if(button?.hasAttribute('data-recurring-add'))edit();else if(button?.dataset.recurringEdit)edit(state.plans.find(plan=>plan.id===button.dataset.recurringEdit));else if(button?.dataset.libraryRun)openRecurringRun({document,invoke,id:button.dataset.libraryRun,date:store.today(),start:button.dataset.libraryView!=='true'});});
    dialog.open();await refresh();if(manager===dialog&&!disposed)renderManager();
  }
  element.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||!element.contains(button))return;if(library){if(button.dataset.recurringEdit)edit(state?.plans.find(plan=>plan.id===button.dataset.recurringEdit));else if(button.dataset.libraryRun)openRecurringRun({document,invoke,id:button.dataset.libraryRun,date:button.dataset.libraryDate||date,start:button.dataset.libraryView!=='true'});else if(button.dataset.libraryDetails||button.dataset.libraryReflection){const id=button.dataset.libraryDetails||button.dataset.libraryReflection,item=recurringItems(state,date).find(value=>value.id===id)||state?.plans.find(value=>value.id===id);if(item)openDetails(item,()=>{const row=libraryRows.get(item.id)?.node;(row?.querySelector('[data-library-reflection]')||row?.querySelector('[data-library-details]')||row?.querySelector('[data-recurring-edit]'))?.focus({preventScroll:true});});}else if(button.dataset.libraryMark)void mark(button.dataset.libraryMark,button.dataset.libraryStatus);else if(button.hasAttribute('data-recurring-retry'))void refresh();return;}const item=state&&button.closest('[data-recurring-id]')&&recurringItems(state,date).find(value=>value.id===button.closest('[data-recurring-id]').dataset.recurringId);if(button.hasAttribute('data-recurring-add'))edit();else if(button.hasAttribute('data-recurring-history'))openHistory();else if(button.hasAttribute('data-recurring-today')){date=store.today();followToday=true;tasks?.setDate?.(date);render();historyButton.focus();}else if(button.hasAttribute('data-recurring-manage'))window.dispatchEvent(new window.CustomEvent('hanni:open-routines-pane'));else if(button.hasAttribute('data-recurring-all'))tasks?.showAll?.();else if(button.hasAttribute('data-recurring-retry'))void refresh();else if(item&&button.hasAttribute('data-recurring-run'))run(item.id,item.status==='pending');else if(item&&button.hasAttribute('data-recurring-details')){if(item.run)run(item.id,false);else openDetails(item);}else if(item&&button.dataset.recurringStatus)void mark(item.id,button.dataset.recurringStatus);});
  if(library)element.querySelector('[data-routine-search]').addEventListener('input',event=>{libraryQuery=event.currentTarget.value;renderManager();event.currentTarget.focus();});
  const onSync=event=>{void refresh(event.detail?.remoteSync?event.detail.canCommit:null).then(()=>renderManager());};window.addEventListener('hanni:calendar-refresh',onSync);
  if(completed)completed.addEventListener('toggle',()=>{expanded=completed.open;});
  const preferences=event=>{if(typeof event.detail?.changes?.showCompleted==='boolean'){expanded=event.detail.changes.showCompleted;render();}};window.addEventListener('hanni:calendar-settings-changed',preferences);const timer=window.setInterval(()=>{if(followToday&&date!==store.today()){date=store.today();tasks?.setDate?.(date);void refresh();}},30000);void refresh();
  const dispose=()=>{if(disposed)return;disposed=true;revision++;window.clearInterval(timer);editor?.dispose();manager?.dispose();details?.dispose();history?.dispose();if(typeof tasks==='function')tasks();else tasks?.dispose?.();window.removeEventListener('hanni:calendar-refresh',onSync);window.removeEventListener('hanni:calendar-settings-changed',preferences);};dispose.openManager=manage;dispose.create=options=>{if(library&&!disposed&&!editor)edit(null,'action',options);};dispose.setCurrentTask=value=>tasks?.setCurrentTask?.(value);dispose.setInProgress=keys=>tasks?.setInProgress?.(keys);dispose.setDate=value=>{if(!validDate(value)||value>store.today())return date;date=value;followToday=date===store.today();tasks?.setDate?.(date);render();return date;};return dispose;
}
