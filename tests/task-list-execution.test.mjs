import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarDashboardTasks } from '../src/hanni/js/calendar-dashboard-tasks.js';
import { mountCalendarTasks } from '../src/hanni/js/calendar-tasks.js';
const settle = () => new Promise(resolve => setImmediate(resolve));

for (const surface of ['overview', 'tasks']) {
  test(`${surface}: explicit start/resume, duplicate suppression and recoverable failure`, async t => {
    const dom = new JSDOM('<main></main>', {pretendToBeVisual:true}), host = dom.window.document.querySelector('main');
    const day = new Date();
    const date = `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
    let rows = [{source_type:'note',source_id:'free-task',title:'Задача без цели',status_extra:'task',date:null}];
    let release, rejectNext=false, calls=[];
    const dependencies = {
      invoke: async command => command==='get_calendar_tasks'?rows:[],
      openTask:()=>{},editDate:()=>{},notifyChange:()=>{},
      executeAction: async (row,action) => {
        calls.push(action);
        await new Promise(resolve=>{release=resolve;});
        if(rejectNext)throw Error('Другая задача уже в работе.');
        rows=[{...row,has_work:true,is_active:action==='start',date}];
      },
    };
    const dispose = surface==='overview'?mountCalendarDashboardTasks(host,dependencies):mountCalendarTasks(host,dependencies);
    t.after(()=>{dispose();dom.window.close();});
    await settle();
    if(surface==='overview')dispose.showAll();
    const run=()=>host.querySelector(surface==='overview'?'[data-overview-execute]':'[data-task-control="execute"]');
    host.querySelector(surface==='overview'?'[data-overview-task]':'[data-task-control="open"]').click();
    assert.equal(calls.length,0,'opening details does not start work');
    assert.equal(run().textContent,'Начать');
    run().click();run().click();assert.deepEqual(calls,['start']);
    release();await settle();await settle();assert.equal(run().textContent,'Пауза');
    run().click();release();await settle();await settle();assert.equal(run().textContent,'Продолжить');
    rejectNext=true;run().click();release();await settle();await settle();
    assert.equal(run().textContent,'Продолжить');assert.equal(run().disabled,false);
    assert.match(host.querySelector('[role=alert]').textContent,/Другая задача/);
    rejectNext=false;run().click();release();await settle();await settle();
    assert.equal(run().textContent,'Пауза');
  });
}
