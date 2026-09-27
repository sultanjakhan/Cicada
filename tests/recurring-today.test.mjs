import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarDashboardTasks } from '../src/hanni/js/calendar-dashboard-tasks.js';

const bootstrap=new JSDOM('<!doctype html><main></main>',{url:'http://127.0.0.1/'});
globalThis.window=bootstrap.window; globalThis.document=bootstrap.window.document; globalThis.CustomEvent=bootstrap.window.CustomEvent; globalThis.localStorage=bootstrap.window.localStorage;
globalThis.marked={Marked:class { use(){} parse(value){return value;} }};
const { mountCalendarRecurring }=await import('../src/hanni/js/calendar-recurring.js');

const today='2026-09-13';
const plan={id:'rule-1',kind:'rule',title:'Без телефона за столом',weekdays:[0],startsOn:today,endsOn:'',time:'09:00',active:true,required:true,createdOn:today};
const state={version:1,plans:[plan],days:{}};
const task={source_type:'note',source_id:'task-1',status_extra:'task',title:'Подготовить SQL-запрос',date:today,duration_minutes:25};

test('routine library preserves read errors through search and recovers without replacing unchanged rows',async t=>{
  const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid'}),host=dom.window.document.querySelector('main');let failed=false;
  const invoke=async()=>{if(failed)throw Error('Read unavailable');return JSON.stringify(state);};
  const dispose=mountCalendarRecurring(host,{invoke,library:true,now:()=>new Date(`${today}T12:00:00`)});t.after(()=>{dispose();dom.window.close();});
  const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
  await flush();const row=host.querySelector('[data-library-id]');failed=true;
  dom.window.dispatchEvent(new dom.window.CustomEvent('hanni:calendar-refresh'));await flush();
  assert.equal(host.querySelector('[data-recurring-error]').hidden,false);
  const search=host.querySelector('[data-routine-search]');search.value='unmatched';search.dispatchEvent(new dom.window.Event('input'));
  assert.equal(host.querySelector('[data-recurring-error]').hidden,false);
  assert.equal(host.querySelector('[data-library-no-results]').hidden,false);
  failed=false;host.querySelector('[data-recurring-retry]').click();await flush();
  assert.equal(host.querySelector('[data-recurring-error]').hidden,true);
  assert.equal(host.querySelector('[data-library-id]'),row);
});

test('open recurring editor keeps its draft when the same plan was changed remotely', async t => {
  const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid'}),host=dom.window.document.querySelector('main');let raw=JSON.stringify(state),writes=0;
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  const invoke=async(command,args)=>{if(command==='get_ui_state')return raw;if(command==='set_ui_state'){writes++;raw=args.value;return;}throw Error(command);};
  const dispose=mountCalendarRecurring(host,{invoke,now:()=>new Date(`${today}T12:00:00`)});t.after(()=>{dispose();dom.window.close();});
  await dispose.openManager();dom.window.document.querySelector('[data-recurring-edit="rule-1"]').click();
  const modal=[...dom.window.document.querySelectorAll('dialog[open]')].at(-1),field=modal.querySelector('[data-routine-title]');field.value='Local draft';
  raw=JSON.stringify({...state,plans:[{...plan,title:'Remote title'}]});const remote=raw;modal.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(modal.open,true);assert.equal(field.value,'Local draft');assert.match(modal.querySelector('[data-dialog-error]').textContent,/другом устройстве/);assert.equal(raw,remote);assert.equal(writes,0);
});

test('routine library shows enabled and disabled plans, filters, marks rules, and creates only on submit',async t=>{
  const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid'}),host=dom.window.document.querySelector('main');const yesterday='2026-09-12',oldPlan={...plan,id:'old-run',kind:'action',mode:'activity',title:'Вчерашнее занятие'},checkPlan={...plan,id:'check-task',kind:'action',mode:'check',title:'Обычная отметка'};let raw=JSON.stringify({version:1,plans:[plan,{...plan,id:'disabled',title:'Выключенная рутина',active:false},oldPlan,checkPlan],days:{[yesterday]:{'old-run':{snapshot:oldPlan,status:'pending',run:{steps:[{title:'Занятие',status:'pending'}]}}}}}),writes=0,commands=[];
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  const invoke=async(command,args)=>{commands.push(command);if(command==='get_ui_state')return raw;if(command==='set_ui_state'){writes++;raw=args.value;return;}throw Error(command);};
  const dispose=mountCalendarRecurring(host,{invoke,now:()=>new Date(`${today}T12:00:00`),library:true});t.after(()=>{dispose();dom.window.close();});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(host.querySelector('[data-recurring-heading]').textContent,'Рутины');
  assert.equal(host.querySelectorAll('[data-library-title]').length,4);
  assert.match(host.textContent,/выключено/);
  assert.equal(host.querySelector('[data-library-run="old-run"]').textContent,'Продолжить');
  assert.equal(host.querySelector('[data-library-run="old-run"]').dataset.libraryDate,yesterday);
  const stableRow=host.querySelector('[data-library-id="disabled"]'),stableFocus=host.querySelector('[data-recurring-edit="disabled"]');stableFocus.focus();
  dom.window.dispatchEvent(new dom.window.CustomEvent('hanni:calendar-refresh',{detail:{remoteSync:true}}));
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(host.querySelector('[data-library-id="disabled"]'),stableRow);
  assert.equal(dom.window.document.activeElement,stableFocus);
  const search=host.querySelector('[data-routine-search]');search.value='выключенная';search.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  assert.equal([...host.querySelectorAll('[data-library-title]')].filter(row=>!row.hidden).length,1);
  search.value='';search.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  host.querySelector('[data-library-details="rule-1"]').click();
  const detail=dom.window.document.querySelector('dialog[open]');assert.ok(detail);
  detail.querySelector('[data-detail-status="kept"]').click();
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(JSON.parse(raw).days[today]['rule-1'].status,'kept');
  assert.equal(dom.window.document.activeElement,host.querySelector('[data-library-details="rule-1"]'));
  assert.equal(host.querySelector('[data-library-id="disabled"]'),stableRow);
  assert.equal(writes,1);
  host.querySelector('[data-library-mark="check-task"]').click();
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(JSON.parse(raw).days[today]['check-task'].status,'done');
  assert.equal(writes,2);
  assert.equal(commands.includes('start_task_block'),false);
  dispose.create();
  const editor=dom.window.document.querySelector('dialog[open]');assert.ok(editor);
  assert.equal(editor.querySelector('[data-routine-title]').value,'');
  assert.equal(writes,2);
  editor.close();
});

test('routine library rolls its daily marks forward after midnight',async t=>{
  const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid'}),host=dom.window.document.querySelector('main');let now=new Date(`${today}T23:59:00`),tick=null;
  const daily={...plan,weekdays:[0,1,2,3,4,5,6]};let raw=JSON.stringify({version:1,plans:[daily],days:{[today]:{'rule-1':{snapshot:daily,status:'kept'}}}});
  dom.window.setInterval=callback=>{tick=callback;return 1;};dom.window.clearInterval=()=>{};
  const invoke=async command=>{if(command==='get_ui_state')return raw;throw Error(command);};
  const dispose=mountCalendarRecurring(host,{invoke,now:()=>now,library:true});t.after(()=>{dispose();dom.window.close();});
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(host.querySelector('[data-library-id="rule-1"]').textContent,/Соблюдено/);
  now=new Date('2026-09-14T00:00:00');tick();
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.doesNotMatch(host.querySelector('[data-library-id="rule-1"]').textContent,/Соблюдено/);
  assert.match(host.querySelector('[data-library-id="rule-1"]').textContent,/Отметить/);
});

test('library opens dated reflection, keeps drafts across dates and does not treat no answer as success',async t=>{
  const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid'}),host=dom.window.document.querySelector('main'),yesterday='2026-09-12';
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  const reflectionPlan={...plan,id:'reflection',kind:'action',title:'Дневной ритуал',mode:'check',startsOn:yesterday,weekdays:[0,1,2,3,4,5,6],reflection:{prompt:'Мой вопрос'}};let raw=JSON.stringify({version:1,plans:[reflectionPlan],days:{}}),writes=0;
  const invoke=async(command,args)=>{if(command==='get_ui_state')return raw;if(command==='set_ui_state'){raw=args.value;writes++;return;}throw Error(command);};
  const dispose=mountCalendarRecurring(host,{invoke,now:()=>new Date(`${today}T12:00:00`),library:true});t.after(()=>{dispose();dom.window.close();});
  await new Promise(resolve=>setImmediate(resolve));const opener=host.querySelector('[data-library-reflection="reflection"]');assert.ok(opener);opener.click();
  const detail=dom.window.document.querySelector('dialog[open]');assert.match(detail.textContent,/Мой вопрос/);assert.equal(detail.querySelector('[data-reflection-date]').value,today);
  detail.querySelector('[data-reflection-rule]').value='kept';detail.querySelector('[data-reflection-restoration]').value='better';detail.querySelector('[data-reflection-trigger]').value='Черновик сегодня';
  let dateInput=detail.querySelector('[data-reflection-date]');dateInput.value=yesterday;dateInput.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  assert.equal(detail.querySelector('[data-reflection-rule]').value,'');assert.equal(detail.querySelector('[data-reflection-date]').value,yesterday);
  detail.querySelector('[data-save-reflection]').click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes,0);assert.match(detail.querySelector('[data-dialog-error]').textContent,/Выбери ответ/);
  detail.querySelector('[data-reflection-rule]').value='no_answer';detail.querySelector('[data-reflection-restoration]').value='no_answer';detail.querySelector('[data-save-reflection]').click();
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  let saved=JSON.parse(raw).days[yesterday].reflection;assert.equal(saved.status,'pending');assert.equal(saved.reflection.ruleOutcome,'no_answer');assert.equal(saved.reflection.restoration,'no_answer');assert.equal(saved.reflection.trigger,'');assert.equal(writes,1);
  dateInput=detail.querySelector('[data-reflection-date]');dateInput.value=today;dateInput.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  assert.equal(detail.querySelector('[data-reflection-rule]').value,'kept');assert.equal(detail.querySelector('[data-reflection-restoration]').value,'better');assert.equal(detail.querySelector('[data-reflection-trigger]').value,'Черновик сегодня');
  detail.querySelector('[data-save-reflection]').click();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  saved=JSON.parse(raw).days[today].reflection;assert.equal(saved.status,'pending');assert.equal(saved.reflection.ruleOutcome,'kept');assert.equal(saved.reflection.trigger,'Черновик сегодня');assert.equal(writes,2);
  detail.close();assert.equal(dom.window.document.activeElement,host.querySelector('[data-library-reflection="reflection"]'));
});

test('graph editor lets imported step properties be edited without changing the plan identity',async t=>{
  const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid'}),host=dom.window.document.querySelector('main');
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  const steps=[{title:'Умыться',dependsOn:[],trackingMode:'check',optional:false},{title:'Подготовить вещи',dependsOn:[0],trackingMode:'track',optional:true}];
  let raw=JSON.stringify({version:1,plans:[{id:'imported-graph',kind:'action',mode:'graph',title:'Утро',steps,weekdays:[0],startsOn:today,endsOn:'',time:'',active:true,required:true,createdOn:today}],days:{}});
  const invoke=async(command,args)=>{if(command==='get_ui_state')return raw;if(command==='set_ui_state'){raw=args.value;return;}throw Error(command);};
  const dispose=mountCalendarRecurring(host,{invoke,now:()=>new Date(`${today}T12:00:00`)});t.after(()=>{dispose();dom.window.close();});
  await dispose.openManager();dom.window.document.querySelector('[data-recurring-edit="imported-graph"]').click();
  const modal=[...dom.window.document.querySelectorAll('dialog[open]')].at(-1);
  assert.equal(modal.querySelectorAll('[data-routine-step]').length,2);
  assert.equal(modal.querySelectorAll('[data-step-dependency]:checked').length,1);
  modal.querySelector('[data-routine-title]').value='Утренний порядок';
  modal.querySelectorAll('[data-step-title]')[1].value='Подготовить сумку';
  modal.querySelectorAll('[data-step-optional]')[1].click();
  modal.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  const saved=JSON.parse(raw).plans[0];
  assert.equal(saved.title,'Утренний порядок');assert.equal(saved.mode,'graph');
  assert.equal(saved.steps[1].title,'Подготовить сумку');assert.equal(saved.steps[1].optional,false);
  assert.deepEqual(saved.steps[1].dependsOn,[0]);assert.equal(saved.steps[0].trackingMode,'check');
});

test('Today combines current-date task and pending rule under one Дела heading', async t => {
  const dom=new JSDOM('<main></main>'); const host=dom.window.document.querySelector('main'); let raw=JSON.stringify(state);
  const invoke=async(command,args)=>command==='get_ui_state'?raw:command==='set_ui_state'?(raw=args.value,null):command==='get_calendar_tasks'?[task]:null;
  const dispose=mountCalendarRecurring(host,{invoke,now:()=>new Date(`${today}T12:00:00`),mountTasks:slot=>mountCalendarDashboardTasks(slot,{invoke,now:()=>new Date(`${today}T12:00:00`),embedded:true})});
  t.after(()=>{dispose();dom.window.close();}); await new Promise(resolve=>setTimeout(resolve,0)); await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(host.querySelector('[data-recurring-heading]').textContent,'Сегодня');
  assert.equal(host.querySelector('.calendar-recurring__section h3').textContent,'Дела');
  assert.match(host.querySelector('[data-recurring-count]').textContent,/2 дела на сегодня/);
  assert.match(host.textContent,/Подготовить SQL-запрос/);
  const row=host.querySelector('[data-recurring-id="rule-1"]');
  assert.match(row.textContent,/Обязательное · 09:00 · Вс · правило на день/);
  assert.match(row.textContent,/Ещё не отмечено/);
  assert.equal(row.querySelector('.calendar-recurring__marks [data-recurring-details]').textContent,'Отметить');
});

test('Today count says other work remains when current task is paused', async t => {
  const dom=new JSDOM('<main></main>'); const host=dom.window.document.querySelector('main'); let raw=JSON.stringify(state);
  const invoke=async(command,args)=>command==='get_ui_state'?raw:command==='set_ui_state'?(raw=args.value,null):command==='get_calendar_tasks'?[task]:null;
  const dispose=mountCalendarRecurring(host,{invoke,now:()=>new Date(`${today}T12:00:00`),mountTasks:slot=>mountCalendarDashboardTasks(slot,{invoke,now:()=>new Date(`${today}T12:00:00`),embedded:true})});
  t.after(()=>{dispose();dom.window.close();}); await new Promise(resolve=>setImmediate(resolve)); await new Promise(resolve=>setImmediate(resolve));
  dispose.setCurrentTask({key:'note:task-1',state:'paused'});
  assert.equal(host.querySelector('[data-recurring-count]').textContent,'Ещё 1 дело на сегодня');
  assert.doesNotMatch(host.querySelector('[data-recurring-tasks]').textContent,/Подготовить SQL-запрос/);
  dispose.setCurrentTask({key:'note:task-1',state:'completed'});
  assert.equal(host.querySelector('[data-recurring-count]').textContent,'1 дело на сегодня');
});

test('Embedded task controller omits tasks when the selected date is not today', async t => {
  const dom=new JSDOM('<main></main>'); const host=dom.window.document.querySelector('main'); const counts=[];
  const dispose=mountCalendarDashboardTasks(host,{invoke:async()=>[task],now:()=>new Date(`${today}T12:00:00`),embedded:true,onCount:value=>counts.push(value)});
  t.after(()=>{dispose();dom.window.close();}); await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(host.textContent,/Подготовить SQL-запрос/);
  dispose.setDate('2026-09-12');
  assert.doesNotMatch(host.textContent,/Подготовить SQL-запрос/);
  assert.equal(counts.at(-1).visible,0);
  dom.window.dispatchEvent(new dom.window.Event('focus'));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.doesNotMatch(host.textContent,/Подготовить SQL-запрос/,'refresh must retain the chosen history date');
  assert.equal(counts.at(-1).visible,0);
});

test('History is secondary, cancel keeps Today, past date applies, and Today returns explicitly', async t => {
  const dom=new JSDOM('<main></main>'); const host=dom.window.document.querySelector('main');
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  const dispose=mountCalendarRecurring(host,{invoke:async command=>command==='get_ui_state'?JSON.stringify(state):null,now:()=>new Date(`${today}T12:00:00`)});
  t.after(()=>{dispose();dom.window.close();}); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(host.querySelector('[data-recurring-date]'),null);
  host.querySelector('[data-recurring-history]').click();
  let dialog=dom.window.document.querySelector('dialog[open]');
  assert.equal(dialog.querySelector('[data-history-date]').value,today);
  dialog.querySelector('[data-dialog-close]').click();
  assert.equal(host.querySelector('[data-recurring-heading]').textContent,'Сегодня');
  host.querySelector('[data-recurring-history]').click(); dialog=dom.window.document.querySelector('dialog[open]');
  const input=dialog.querySelector('[data-history-date]'); input.value='2026-09-12'; dialog.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(host.querySelector('[data-recurring-heading]').textContent,'Дневные отметки');
  assert.match(host.querySelector('[data-recurring-history]').textContent,/История/);
  const todayButton=host.querySelector('[data-recurring-today]'); assert.equal(todayButton.hidden,false); todayButton.focus(); todayButton.click();
  assert.equal(dom.window.document.activeElement,host.querySelector('[data-recurring-history]'),'returning to Today keeps keyboard focus on a visible control');
  assert.equal(host.querySelector('[data-recurring-heading]').textContent,'Сегодня');
  assert.equal(todayButton.hidden,true);
});

test('Recurring disposes a function task controller and releases a temporary settings mount on close', async t => {
  const dom=new JSDOM('<main></main>',{url:'http://127.0.0.1/'}); const host=dom.window.document.querySelector('main'); let taskDisposed=0,managerClosed=0;
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  const dispose=mountCalendarRecurring(host,{invoke:async command=>command==='get_ui_state'?JSON.stringify({version:1,plans:[],days:{}}):null,now:()=>new Date(`${today}T12:00:00`),mountTasks:()=>Object.assign(()=>{taskDisposed++;},{onCount(){}})});
  t.after(()=>{dispose();dom.window.close();}); await new Promise(resolve=>setTimeout(resolve,0));
  dispose.onManagerClose=()=>{managerClosed++;}; await dispose.openManager();
  dom.window.document.querySelector('dialog').close();
  assert.equal(managerClosed,1);
  dispose(); assert.equal(taskDisposed,1);
});

test('A delayed embedded task count removes the recurring empty message without rerendering the task slot', async t => {
  const dom=new JSDOM('<main></main>'); const host=dom.window.document.querySelector('main'); let release;
  const taskGate=new Promise(resolve=>{release=resolve;});
  const invoke=async command=>{
    if(command==='get_ui_state') return JSON.stringify({version:1,plans:[],days:{}});
    if(command==='get_calendar_tasks') { await taskGate; return [task]; }
    return null;
  };
  const dispose=mountCalendarRecurring(host,{invoke,now:()=>new Date(`${today}T12:00:00`),mountTasks:slot=>mountCalendarDashboardTasks(slot,{invoke,now:()=>new Date(`${today}T12:00:00`),embedded:true})});
  t.after(()=>{dispose();dom.window.close();}); await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(host.textContent,/На сегодня дел нет/);
  release(); await new Promise(resolve=>setTimeout(resolve,0)); await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(host.textContent,/Подготовить SQL-запрос/);
  assert.equal(host.querySelector('.calendar-recurring__empty'),null);
});
