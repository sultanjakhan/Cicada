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

test('open recurring editor keeps its draft when the same plan was changed remotely', async t => {
  const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid'}),host=dom.window.document.querySelector('main');let raw=JSON.stringify(state),writes=0;
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  const invoke=async(command,args)=>{if(command==='get_ui_state')return raw;if(command==='set_ui_state'){writes++;raw=args.value;return;}throw Error(command);};
  const dispose=mountCalendarRecurring(host,{invoke,now:()=>new Date(`${today}T12:00:00`)});t.after(()=>{dispose();dom.window.close();});
  await dispose.openManager();dom.window.document.querySelector('[data-recurring-edit="rule-1"]').click();
  const modal=[...dom.window.document.querySelectorAll('dialog[open]')].at(-1),field=modal.querySelector('[name=title]');field.value='Local draft';
  raw=JSON.stringify({...state,plans:[{...plan,title:'Remote title'}]});const remote=raw;modal.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(modal.open,true);assert.equal(field.value,'Local draft');assert.match(modal.querySelector('[data-dialog-error]').textContent,/другом устройстве/);assert.equal(raw,remote);assert.equal(writes,0);
});

test('Today combines current-date task and pending rule under one Дела heading', async t => {
  const dom=new JSDOM('<main></main>'); const host=dom.window.document.querySelector('main'); let raw=JSON.stringify(state);
  const invoke=async(command,args)=>command==='get_ui_state'?raw:command==='set_ui_state'?(raw=args.value,null):command==='get_calendar_tasks'?[task]:null;
  const dispose=mountCalendarRecurring(host,{invoke,now:()=>new Date(`${today}T12:00:00`),mountTasks:slot=>mountCalendarDashboardTasks(slot,{invoke,now:()=>new Date(`${today}T12:00:00`),embedded:true})});
  t.after(()=>{dispose();dom.window.close();}); await new Promise(resolve=>setTimeout(resolve,0)); await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(host.querySelector('[data-recurring-heading]').textContent,'Сегодня');
  assert.equal(host.querySelector('.calendar-recurring__section h3').textContent,'Дела');
  assert.match(host.querySelector('[data-recurring-count]').textContent,/2 дел осталось/);
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
  assert.equal(host.querySelector('[data-recurring-count]').textContent,'Ещё 1 дел на сегодня');
  assert.doesNotMatch(host.querySelector('[data-recurring-tasks]').textContent,/Подготовить SQL-запрос/);
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
  host.querySelector('[data-recurring-history]').click(); dialog=dom.window.document.querySelector('dialog[open]');
  dialog.querySelector('[data-history-today]').click(); dialog.querySelector('[data-dialog-submit]')?.click();
  dialog.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(host.querySelector('[data-recurring-heading]').textContent,'Сегодня');
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
  assert.match(host.textContent,/На этот день больше нет неотмеченных дел/);
  release(); await new Promise(resolve=>setTimeout(resolve,0)); await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(host.textContent,/Подготовить SQL-запрос/);
  assert.equal(host.querySelector('.calendar-recurring__empty'),null);
});
