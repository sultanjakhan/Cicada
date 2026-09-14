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

test('Embedded task controller omits tasks when the selected date is not today', async t => {
  const dom=new JSDOM('<main></main>'); const host=dom.window.document.querySelector('main'); const counts=[];
  const dispose=mountCalendarDashboardTasks(host,{invoke:async()=>[task],now:()=>new Date(`${today}T12:00:00`),embedded:true,onCount:value=>counts.push(value)});
  t.after(()=>{dispose();dom.window.close();}); await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(host.textContent,/Подготовить SQL-запрос/);
  dispose.setDate('2026-09-12');
  assert.doesNotMatch(host.textContent,/Подготовить SQL-запрос/);
  assert.equal(counts.at(-1),0);
});
