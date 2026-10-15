import test from 'node:test';
import assert from 'node:assert/strict';
import { copyForLanguage, createUiCopy } from '../src/hanni/js/ui-copy.js';
import { rankNextAction, mountCalendarNextAction } from '../src/hanni/js/calendar-next-action.js';
import { JSDOM } from 'jsdom';
const today='2026-09-27', now=new Date(`${today}T12:00:00`);
test('dynamic patterns substitute authored values once, without translating or interpreting them',()=>{
 const value='Сегодня {0} — Заметка';
 for(const language of ['ru','en']) {
  const copy=copyForLanguage(language);
  assert.equal(copy.format('Цель: {0}',value),`${language==='en'?'Goal':'Цель'}: ${value}`);
  assert.equal(copy(value),value);
 }
 const doc={documentElement:{lang:'ru'}},copy=createUiCopy(doc);
 assert.equal(copy('Сегодня'),'Сегодня');doc.documentElement.lang='en';assert.equal(copy('Сегодня'),'Today');
});
test('RU/EN ranking preserves source enum, identity, title and score while localizing timed reasons',()=>{
 const task={source_type:'note',source_id:'a',title:'Сегодня {0}',status_extra:'task',date:today,planned_time:'11:00'};
 const ru=rankNextAction({now,tasks:[task],language:'ru'}),en=rankNextAction({now,tasks:[task],language:'en'});
 assert.equal(en.task,task);assert.equal(en.title,ru.title);assert.equal(en.score,ru.score);assert.equal(en.action,ru.action);
 assert.match(ru.reason,/сегодня/);assert.match(en.reason,/today/);assert.match(en.reason,/11:00/);assert.equal(task.status_extra,'task');
});
for(const language of ['ru','en'])test(`mounted ${language} next action localizes failure and retains authored task title`,async t=>{
 const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());dom.window.document.documentElement.lang=language;
 const host=dom.window.document.querySelector('main');let fail=false;
 const task={source_type:'note',source_id:'a',title:'Сегодня {0} — моя задача',status_extra:'task',date:today,completed:false};
 const invoke=async(name,args)=>{
  if(name==='get_calendar_tasks'){if(fail)throw Error('offline');return [task];}
  if(name==='get_active_blocks')return [];
  if(name==='get_ui_state')return null;
  if(name==='get_goals'||name==='get_calendar_task_goals')return [];
  throw Error(name);
 };
 const mounted=mountCalendarNextAction(host,{invoke,now:()=>now,executeAction:async()=>false,openTask:()=>{}});
 for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(host.textContent.includes(task.title));
 fail=true;await mounted.refresh();
 for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.match(host.textContent,language==='en'?/refresh|load|unavailable|failed/i:/обнов|загруз|доступ|удал/i);
 mounted();
});
import { mountCalendarTasks } from '../src/hanni/js/calendar-tasks.js';
for(const language of ['ru','en'])test(`mounted ${language} tasks localize statuses, select labels and errors without changing authored options`,async t=>{
 const dom=new JSDOM('<main></main>');dom.window.document.documentElement.lang=language;
 const host=dom.window.document.querySelector('main');let fail=false;
 const task={source_type:'note',source_id:'a',title:'Сегодня — задача',status_extra:'task',date:null,waiting:true};
 const dispose=mountCalendarTasks(host,{invoke:async name=>{
  if(name==='get_calendar_tasks'){if(fail)throw Error('offline');return [task];}
  if(name==='get_goals')return [{id:'g',title:'Сегодня — цель'}];
  if(name==='get_calendar_task_goals')return [];return null;
 },openTask:()=>{},editDate:()=>{},executeAction:()=>{},notifyChange:()=>{}});
 t.after(()=>{dispose();dom.window.close();});
 for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(host.textContent.includes(task.title));assert.ok(host.querySelector('[data-tasks-goal]').textContent.includes('Сегодня — цель'));
 assert.equal(host.querySelector('[data-tasks-goal]').options[1].value,'none');
 assert.equal(host.querySelector('.ct-status').textContent,language==='en'?'Waiting for a response':'Жду ответа');
 assert.equal(task.status_extra,'task');
 fail=true;dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.match(host.textContent,language==='en'?/refresh tasks/i:/обновить задачи/);
});
for(const language of ['ru','en'])test(`mounted ${language} routines localize counts, frequency and corrupt-state errors`,async t=>{
 const dom=new JSDOM('<main></main>',{url:'http://fixture.invalid'});dom.window.document.documentElement.lang=language;
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,CustomEvent:dom.window.CustomEvent});
 globalThis.marked={Marked:class{use(){}parse(value){return value;}}};
 const {mountCalendarRecurring}=await import('../src/hanni/js/calendar-recurring.js');
 const title='Сегодня — моя рутина',plan={id:'r',kind:'rule',mode:'check',title,weekdays:[0,1,2,3,4,5,6],startsOn:'',endsOn:'',time:'09:00',active:true,required:true,createdOn:today};
 let raw=JSON.stringify({version:1,plans:[plan],days:{}});
 const host=dom.window.document.querySelector('main'),dispose=mountCalendarRecurring(host,{invoke:async()=>raw,library:true,now:()=>now});
 t.after(()=>{dispose();dom.window.close();});
 for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(host.textContent.includes(title));assert.match(host.textContent,language==='en'?/every day/i:/Каждый день/i);
 assert.match(host.querySelector('[data-recurring-count]').textContent,language==='en'?/enabled/i:/включено/i);
 raw='{broken';dom.window.dispatchEvent(new dom.window.Event('hanni:calendar-refresh'));
 for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.match(host.querySelector('[data-recurring-error]').textContent,language==='en'?/Could not read/i:/прочитать/);
 assert.equal(plan.kind,'rule');assert.equal(plan.mode,'check');assert.equal(plan.title,title);
});
