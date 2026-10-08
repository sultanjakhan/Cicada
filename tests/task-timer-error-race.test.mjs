import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarTasks } from '../src/hanni/js/calendar-tasks.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
for (const firstAction of ['start','finish']) {
  test(`${firstAction} error after timer change must keep controls locked during authoritative read`, async t => {
    const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');
    let task={source_type:'note',source_id:'synthetic',title:'Synthetic',date:null,status_extra:'task',is_active:firstAction==='finish',has_work:firstAction==='finish'},changed=false;
    const pending=[],actions=[];
    const dispose=mountCalendarTasks(host,{
      invoke:async command=>command==='get_calendar_tasks' ? changed ? new Promise(resolve=>pending.push(resolve)) : [{...task}] : command==='get_ui_state' ? null : [],
      readTaskObservations:async()=>({available:true,unboundCount:0,contexts:new Map()}),
      openTask(){},editDate(){},notifyChange(){dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));},
      executeAction:async (_selected,action)=>{
        actions.push(action);
        task={...task,is_active:action==='start',has_work:true};changed=true;
        throw Object.assign(Error(action==='finish'?'Synthetic complete failed after pause':'Synthetic lost IPC reply'),{refreshRequired:action==='finish'});
      },
    });
    t.after(()=>{dispose();dom.window.close();});await settle();await settle();
    const run=()=>host.querySelector('[data-task-control="execute"]');
    (firstAction==='start' ? run() : host.querySelector('[data-task-control="finish"]')).click();await settle();await settle();
    assert.ok(pending.length>0,'authoritative refresh remains pending');
    assert.equal(run().disabled,true,'initial busy-rendered control remains disabled');
    host.querySelector('[data-tasks-filter="undated"]').click();
    assert.equal(run().disabled,true,'filter repaint must not unlock stale execution after a changed/unknown timer outcome');
    run().click();assert.deepEqual(actions,[firstAction],'stale control cannot dispatch another command');
    for (const resolve of pending) resolve([{...task}]);
    await settle();await settle();await settle();
    assert.equal(run().disabled,false,'authoritative committed read unlocks the current control');
    assert.equal(run().textContent,task.is_active?'Пауза':'Продолжить');
    assert.deepEqual(actions,[firstAction]);
  });
}
