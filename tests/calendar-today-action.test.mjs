import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarTodayAction } from '../src/hanni/js/calendar-today-action.js';

const settle = async () => { for (let i=0;i<12;i++) await new Promise(resolve=>setImmediate(resolve)); };
async function setup(t, {nextTask=false,activeTask=false,extraTasks=[]}={}) {
  const dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main');
  const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const plan = {id:'routine',title:'Проверка',kind:'action',mode:'graph',active:true,required:true,createdOn:date,startsOn:'',endsOn:'',time:'',weekdays:[0,1,2,3,4,5,6],steps:[{title:'Первая ветка',dependsOn:[],trackingMode:'check'},{title:'Вторая ветка',dependsOn:[],trackingMode:'check'}]};
  let state = JSON.stringify({version:1,plans:[plan],days:{}}), failCompletion=false;
  const calls = [], selected = [], currentTasks=[];
  const invoke = async (name,args) => {
    calls.push({name,args});
    if (name==='get_ui_state') return args?.key==='calendar_recurring_v1'?state:null;
    if (name==='set_ui_state') { assert.equal(args.expectedValue,state); state=args.value; return; }
    if (name==='get_calendar_tasks' && nextTask) return [{source_type:'note',source_id:'99',title:'Следующая задача',status_extra:'task',date,completed:false,is_active:activeTask,has_work:activeTask,actual_seconds:activeTask?90:0},...extraTasks];
    if (name==='complete_recurring_step' || name==='skip_recurring_step') {
      if(failCompletion) throw Error('Не удалось сохранить шаг');
      const data=JSON.parse(state), [id,day,index]=JSON.parse(args.sourceId), run=data.days[day][id];
      run.run.steps[index].status=name==='complete_recurring_step'?'done':'skipped';
      run.status=run.run.steps.some(step=>step.status==='pending')?'pending':run.run.steps.some(step=>step.status==='skipped')?'skipped':'done';
      state=JSON.stringify(data); return;
    }
    if (['get_calendar_tasks','get_calendar_task_goals','get_goals','get_active_blocks','get_schedules'].includes(name)) return [];
    throw Error(name);
  };
  const dispose = mountCalendarTodayAction(host, {invoke,taskOptions:{invoke},onRoutineFocusChange:value=>selected.push(value),onCurrentTaskChange:value=>currentTasks.push(value)});
  t.after(()=>{dispose();dom.window.close();}); await settle();
  return {dom,host,calls,selected,currentTasks,dispose,date,state:()=>JSON.parse(state),failCompletion:value=>{failCompletion=value;}};
}

test('one selected running task becomes the current work row, and choices hide it without timer writes',async t=>{
  const x=await setup(t,{nextTask:true,activeTask:true});
  assert.equal(x.currentTasks.at(-1).source_id,'99');
  assert.equal(x.host.querySelector('[data-today-title]').textContent,'Сейчас');
  x.host.querySelector('[data-today-choose]').click();await settle();
  assert.equal(x.currentTasks.at(-1),null);
  assert.equal(x.host.querySelector('[data-today-title]').textContent,'Что сделать сейчас');
  x.dispose.openRoutine({id:'routine',date:x.date,start:false});await settle();
  assert.equal(x.currentTasks.at(-1),null);
  assert.equal(x.calls.some(call=>['pause_task_block','cancel_task_block','finish_task_block','start_task_block'].includes(call.name)),false);
});

test('choosing a task by title selects it and returns to Today without changing any timer',async t=>{
  const x=await setup(t,{nextTask:true,activeTask:true,extraTasks:[
    {source_type:'note',source_id:'100',title:'Вторая активная',status_extra:'task',date:null,completed:false,is_active:true,has_work:true,actual_seconds:30},
    {source_type:'note',source_id:'101',title:'Не начатая',status_extra:'task',date:null,completed:false,is_active:false},
  ]});
  const openPicker=async()=>{x.host.querySelector('[data-today-choose]').click();x.host.querySelector('[data-today-scope="tasks"]').click();await settle();};
  await openPicker();
  x.host.querySelector('[data-overview-task="note:100"]').click(); await settle();
  assert.equal(x.currentTasks.at(-1).source_id,'100','an already-running task can become the one selected current task');
  assert.equal(x.host.dataset.mode,'recommendation');
  assert.ok(x.host.querySelector('[data-next-action-key]'));

  await openPicker();
  x.host.querySelector('[data-overview-task="note:101"]').click(); await settle();
  assert.equal(x.currentTasks.at(-1),null,'an inactive task becomes the recommendation but is not shown as running work');
  assert.equal(x.host.dataset.mode,'recommendation');
  assert.equal(x.host.querySelector('[data-next-action-key]').dataset.nextActionKey,'task:note:101');
  assert.equal(x.calls.some(call=>['start_task_block','pause_task_block','cancel_task_block','finish_task_block'].includes(call.name)),false);
});

test('routine recommendation opens branches inline and quiet refresh keeps the same controls', async t => {
  const x=await setup(t);
  x.host.querySelector('[data-next-action-action="start"]').click(); await settle();
  assert.equal(x.host.querySelector('[data-today-run]').hidden,false);
  assert.equal(x.host.querySelectorAll('dialog').length,0);
  assert.equal(x.host.querySelectorAll('[data-run-step-card]').length,2);
  assert.equal(x.calls.some(call=>call.name==='start_task_block'),false,'branch selection never silently starts a timer');
  const button=x.host.querySelector('[data-run-action]');button.focus();
  x.dom.window.dispatchEvent(new x.dom.window.Event('hanni:calendar-refresh'));await settle();
  assert.equal(x.host.querySelector('[data-run-action]'),button);
  assert.equal(x.dom.window.document.activeElement,button);
  x.host.querySelector('[data-today-choose]').click();await settle();
  assert.equal(x.host.querySelector('[data-today-choices]').hidden,false);
  assert.equal(x.host.querySelector('[data-today-run]').hidden,true);
  assert.equal(x.calls.some(call=>/pause|cancel|finish/.test(call.name)),false,'leaving the inline runner never stops work');
  assert.equal(Object.keys(x.state().days).length,1,'the same canonical run survives changing the view');
});

test('inline choice switches between tasks and routines without opening a dialog or writing data', async t => {
  const x=await setup(t);
  x.host.querySelector('[data-today-choose]').click();await settle();
  assert.ok(x.host.querySelector('[data-routine-choice="routine"]'));
  x.host.querySelector('[data-today-scope="tasks"]').click();await settle();
  assert.equal(x.host.querySelector('[data-today-task-choices]').hidden,false);
  assert.equal(x.host.querySelector('[data-today-routines]').hidden,true);
  x.host.querySelector('[data-today-choose]').click();
  assert.equal(x.host.querySelector('[data-today-recommendation]').hidden,false);
  assert.equal(x.calls.some(call=>call.name==='set_ui_state'),false);
  assert.equal(x.host.querySelectorAll('dialog').length,0);
  assert.equal(x.host.querySelector('[data-today-settings]'),null);
  assert.equal(x.host.querySelector('[data-today-all-tasks]'),null);
});

for (const action of ['complete','skip']) test(`last routine step (${action}) returns to an empty recommendation without starting work`,async t=>{
  const x=await setup(t);x.dispose.openRoutine({id:'routine',date:x.date,start:true});await settle();
  x.host.querySelector(`[data-run-action="${action}"]`).click();await settle();
  assert.equal(x.host.dataset.mode,'run','partial completion keeps the remaining branches');
  x.host.querySelector(`[data-run-action="${action}"]`).click();await settle();
  assert.equal(x.host.dataset.mode,'recommendation');assert.equal(x.host.querySelector('[data-today-run]').hidden,true);
  assert.equal(x.state().days[x.date].routine.status,action==='complete'?'done':'skipped');
  assert.match(x.host.querySelector('[data-today-recommendation]').textContent,/Подходящей задачи или дела сейчас нет/);
  assert.equal(x.dom.window.document.activeElement,x.host.querySelector('[data-today-choose]'));
  assert.equal(x.calls.some(call=>call.name==='start_task_block'),false);
});

test('completion shows the next existing candidate; failed save keeps the runner available',async t=>{
  const x=await setup(t,{nextTask:true});x.dispose.openRoutine({id:'routine',date:x.date,start:true});await settle();
  x.failCompletion(true);x.host.querySelector('[data-run-action="complete"]').click();await settle();
  assert.equal(x.host.dataset.mode,'run');assert.equal(x.state().days[x.date].routine.status,'pending');
  x.failCompletion(false);x.host.querySelector('[data-run-action="complete"]').click();await settle();
  x.host.querySelector('[data-run-action="complete"]').click();await settle();
  assert.equal(x.host.dataset.mode,'recommendation');
  assert.match(x.host.querySelector('[data-today-recommendation]').textContent,/Следующая задача/);
  assert.equal(x.calls.some(call=>call.name==='start_task_block'),false);
});
