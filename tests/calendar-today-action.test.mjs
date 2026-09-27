import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarTodayAction } from '../src/hanni/js/calendar-today-action.js';

const settle = async () => { for (let i=0;i<12;i++) await new Promise(resolve=>setImmediate(resolve)); };
async function setup(t) {
  const dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main');
  const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const plan = {id:'routine',title:'Проверка',kind:'action',mode:'graph',active:true,required:true,createdOn:date,startsOn:'',endsOn:'',time:'',weekdays:[0,1,2,3,4,5,6],steps:[{title:'Первая ветка',dependsOn:[],trackingMode:'check'},{title:'Вторая ветка',dependsOn:[],trackingMode:'check'}]};
  let state = JSON.stringify({version:1,plans:[plan],days:{}});
  const calls = [], selected = [];
  const invoke = async (name,args) => {
    calls.push({name,args});
    if (name==='get_ui_state') return args?.key==='calendar_recurring_v1'?state:null;
    if (name==='set_ui_state') { assert.equal(args.expectedValue,state); state=args.value; return; }
    if (['get_calendar_tasks','get_calendar_task_goals','get_goals','get_active_blocks','get_schedules'].includes(name)) return [];
    throw Error(name);
  };
  const dispose = mountCalendarTodayAction(host, {invoke,taskOptions:{invoke},onRoutineFocusChange:value=>selected.push(value)});
  t.after(()=>{dispose();dom.window.close();}); await settle();
  return {dom,host,calls,selected,dispose,state:()=>JSON.parse(state)};
}

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
});
