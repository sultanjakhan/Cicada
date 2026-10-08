import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarTasks } from '../src/hanni/js/calendar-tasks.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const today=()=>{const d=new Date();return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const row=(id,date,extra={})=>({source_type:'note',source_id:id,title:id,date,status_extra:'task',...extra});

test('compact filters retain visible constraints, reset and expanded row details across refresh',async t=>{
  const x=await setup(t);
  const filters=x.host.querySelector('.ct-filter-details');
  assert.equal(filters.open,false);
  assert.equal(filters.querySelector('[data-tasks-goal]'),x.host.querySelector('[data-tasks-goal]'));
  x.change('[data-tasks-goal]','parent');
  assert.match(x.host.querySelector('[data-tasks-applied]').textContent,/Цель: Career/);
  filters.open=false;
  assert.equal(x.host.querySelector('[data-tasks-reset]').hidden,false);
  const details=x.host.querySelector('.ct-row-details');details.open=true;
  x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed'));await settle();await settle();
  assert.equal(x.host.querySelector('.ct-row-details').open,true);
  x.host.querySelector('[data-tasks-reset]').click();
  assert.deepEqual(x.titles(),['API','SQL']);
  assert.equal(x.dom.window.document.activeElement,x.host.querySelector('[data-tasks-search]'));
  assert.deepEqual(x.actions,[]);
});

test('waiting task primary action opens review without starting a timer',async t=>{
  const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');
  const actions=[],opened=[],task=row('Waiting',null,{process:'system-analysis',stage:'acceptance',waiting:true});
  const dispose=mountCalendarTasks(host,{invoke:async cmd=>cmd==='get_calendar_tasks'?[task]:cmd==='get_goals'||cmd==='get_calendar_task_goals'?[]:null,openTask:r=>opened.push(r.source_id),editDate:()=>{},notifyChange:()=>{},executeAction:(_,a)=>actions.push(a)});
  t.after(()=>{dispose();dom.window.close();});await settle();await settle();
  const button=host.querySelector('[data-task-control="execute"]');
  assert.equal(host.querySelector('.ct-primary-meta .ct-status').textContent,'Жду ответа');
  assert.equal(button.textContent,'Открыть ожидание');button.click();
  assert.deepEqual(opened,['Waiting']);assert.deepEqual(actions,[]);
});

async function setup(t) {
  const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid',pretendToBeVisual:true});
  const host=dom.window.document.querySelector('main'), state={filter:'active',search:'',goal:'',page:0};
  let rows=[row('SQL',null),row('API',today()),row('Done',today(),{completed:true}),row('Hidden',null,{archived:true})],fail=false;
  const actions=[], opened=[];
  const dependencies={state,invoke:async command=>{if(fail)throw new Error('offline');if(command==='get_calendar_tasks')return rows;if(command==='get_goals')return[{id:'parent',title:'Career'},{id:'child',parent_goal_id:'parent',title:'SQL'}];if(command==='get_calendar_task_goals')return[{source_type:'note',source_id:'SQL',goal_id:'child'}];throw new Error(command);},openTask:(task)=>opened.push(task.source_id),editDate:()=>{},executeAction:async(task,action)=>{actions.push([task.source_id,action]);rows=rows.map(r=>r===task?{...r,completed:true}:r);},notifyChange:()=>{}};
  const dispose=mountCalendarTasks(host,dependencies);t.after(()=>{dispose();dom.window.close();});await settle();
  const titles=()=>[...host.querySelectorAll('[data-task-control="open"]')].map(el=>el.textContent);
  const change=(selector,value)=>{const el=host.querySelector(selector);el.value=value;el.dispatchEvent(new dom.window.Event(el.tagName==='INPUT'?'input':'change',{bubbles:true}));};
  return{host,dom,state,dependencies,dispose,titles,change,actions,opened,setFail:value=>fail=value};
}

test('task catalogue filters actual records by day, completion, search and parent goal', async t=>{
  const x=await setup(t);assert.deepEqual(x.titles(),['API','SQL']);
  x.host.querySelector('[data-tasks-filter="undated"]').click();assert.deepEqual(x.titles(),['SQL']);
  x.host.querySelector('[data-tasks-filter="today"]').click();assert.deepEqual(x.titles(),['API']);
  x.host.querySelector('[data-tasks-filter="completed"]').click();assert.deepEqual(x.titles(),['Done']);
  x.host.querySelector('[data-tasks-filter="active"]').click();x.change('[data-tasks-goal]','parent');assert.deepEqual(x.titles(),['SQL']);
  x.change('[data-tasks-search]','Missing');assert.deepEqual(x.titles(),[]);assert.equal(x.host.querySelector('[data-tasks-count]').textContent,'0');
  x.change('[data-tasks-search]','');x.change('[data-tasks-goal]','none');assert.deepEqual(x.titles(),['API']);
  x.host.querySelector('[data-task-control="open"]').click();assert.deepEqual(x.opened,['API']);
});

test('important badge is shown for priority five note tasks only', async t=>{
  const x=await setup(t);
  const rows=await x.dependencies.invoke('get_calendar_tasks'); rows[0].priority=5;
  x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed')); await settle(); await settle();
  assert.ok(x.host.querySelectorAll('[data-important-badge]').length >= 1);
  assert.match(x.host.textContent,/Важная/);
  assert.equal(x.host.querySelector('.ct-row.task-important [data-important-badge]').textContent,'Важная задача');
  rows[0].priority=0;
  x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed')); await settle(); await settle();
  assert.equal(x.host.querySelectorAll('.ct-row.task-important').length,0,'removing importance clears the row emphasis');
});

test('completion updates the same task and count, while a failed refresh preserves visible records', async t=>{
  const x=await setup(t);x.host.querySelector('[data-task-control="finish"]').click();await settle();await settle();
  assert.deepEqual(x.actions,[['API','finish']]);assert.deepEqual(x.titles(),['SQL']);assert.equal(x.host.querySelector('[data-tasks-count]').textContent,'1');
  x.dom.window.dispatchEvent(new x.dom.window.Event('hanni:calendar-refresh'));await settle();await settle();
  assert.equal(x.host.querySelector('[data-tasks-message]').textContent,'Задача завершена.');
  x.setFail(true);x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed'));await settle();await settle();
  assert.deepEqual(x.titles(),['SQL']);assert.equal(x.host.querySelector('[data-tasks-retry]').hidden,false);
  x.setFail(false);x.host.querySelector('[data-tasks-retry]').click();await settle();assert.equal(x.host.querySelector('[data-tasks-retry]').hidden,true);
});

test('pane filter state survives remount and disposed async results cannot replace the new pane', async t=>{
  const x=await setup(t);x.host.querySelector('[data-tasks-filter="undated"]').click();x.change('[data-tasks-search]','SQL');x.dispose();
  const dispose=mountCalendarTasks(x.host,x.dependencies);await settle();assert.deepEqual(x.titles(),['SQL']);assert.equal(x.host.querySelector('[data-tasks-search]').value,'SQL');dispose();
  let release;const pending=new Promise(resolve=>release=resolve);
  const stop=mountCalendarTasks(x.host,{...x.dependencies,invoke:()=>pending});stop();x.host.textContent='another pane';release([]);await settle();assert.equal(x.host.textContent,'another pane');
});

test('active tasks are grouped as running, overdue, today, soon and undated, and overdue dates are marked', async t=>{
  const shift=days=>{const d=new Date();d.setDate(d.getDate()+days);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid',pretendToBeVisual:true}), host=dom.window.document.querySelector('main');
  const rows=[row('Later',shift(5)),row('Free',null,{actual_minutes:10,has_work:true}),row('Old',shift(-3)),row('Now',today(),{duration_minutes:30,actual_minutes:42,has_work:true,is_active:true}),row('Late',shift(-1),{priority:5}),row('Plain',today()),row('Done',shift(-4),{completed:true})];
  const goals=[{id:'parent',title:'Career'},{id:'child',parent_goal_id:'parent',title:'SQL'}];
  const dispose=mountCalendarTasks(host,{state:{filter:'active',search:'',goal:'',page:0},invoke:async command=>command==='get_calendar_tasks'?rows:command==='get_goals'?goals:command==='get_calendar_task_goals'?[{source_type:'note',source_id:'Now',goal_id:'child'}]:[],openTask(){},editDate(){},executeAction:async()=>{},notifyChange(){}});
  t.after(()=>{dispose();dom.window.close();});await settle();
  const titles=()=>[...host.querySelectorAll('[data-task-control="open"]')].map(el=>el.textContent);
  const groups=()=>[...host.querySelectorAll('[data-tasks-group]')].map(el=>[el.dataset.tasksGroup,el.querySelector('.ct-group-label').textContent,el.querySelector('.ct-group-count').textContent]);
  const item=id=>host.querySelector(`[data-context-record="note:${id}"]`), date=id=>item(id).querySelector('[data-task-control="date"]');
  assert.deepEqual(groups(),[['running','В работе','1'],['overdue','Просрочено','2'],['today','Сегодня','1'],['soon','Скоро','1'],['undated','Без даты','1']]);
  assert.deepEqual(titles(),['Now','Late','Old','Plain','Later','Free'],'running work leads; groups follow urgency; important tasks lead their group');
  for(const id of ['Old','Late']){assert.equal(item(id).classList.contains('is-overdue'),true);assert.equal(date(id).classList.contains('is-overdue'),true);assert.match(date(id).getAttribute('aria-label'),/просрочено/);}
  for(const id of ['Now','Plain','Later','Free']){assert.equal(item(id).classList.contains('is-overdue'),false);assert.equal(date(id)?.classList.contains('is-overdue')??false,false);}
  assert.equal(date('Late').textContent,'Вчера');assert.equal(date('Plain'),null,'the Today group does not repeat «Сегодня»');assert.equal(date('Free'),null,'no «Без даты» in rows');
  assert.match(date('Later').textContent,/\S/);
  assert.equal(item('Old').querySelector('[data-task-control="open"]').title,'Old','the full title stays available when it is truncated');
  assert.equal(item('Now').classList.contains('is-running'),true);assert.equal(item('Plain').classList.contains('is-running'),false);
  assert.equal(item('Now').querySelector('.ct-goal').textContent,'SQL');assert.equal(item('Now').querySelector('.ct-goal').title,'Career / SQL');
  assert.equal(item('Now').querySelector('.ct-estimate').textContent,'30 мин · факт 42');assert.equal(item('Free').querySelector('.ct-estimate').textContent,'факт 10 мин');
  const run=id=>item(id).querySelector('[data-task-control="execute"]');
  assert.deepEqual(['Now','Free','Plain'].map(id=>[run(id).title,run(id).getAttribute('aria-label')]),[['Пауза','Пауза: Now'],['Продолжить','Продолжить: Free'],['Начать','Начать: Plain']]);
  host.querySelector('[data-tasks-search]').value='Free';host.querySelector('[data-tasks-search]').dispatchEvent(new dom.window.Event('input'));
  assert.deepEqual(groups(),[['undated','Без даты','1']],'empty groups are hidden');
  host.querySelector('[data-tasks-search]').value='';host.querySelector('[data-tasks-search]').dispatchEvent(new dom.window.Event('input'));
  host.querySelector('[data-tasks-filter="today"]').click();
  assert.deepEqual(titles(),['Now','Plain']);assert.deepEqual(groups(),[],'a single-group filter needs no group headings');
  host.querySelector('[data-tasks-filter="completed"]').click();
  assert.deepEqual(titles(),['Done']);assert.equal(item('Done').classList.contains('is-overdue'),false,'completed tasks are never overdue');
  assert.equal(run('Done'),null);
});


test('day rollover refilters unchanged tasks while preserving focused search and filter state', async t => {
  const OriginalDate = globalThis.Date;
  let now = new OriginalDate(2026, 9, 2, 23, 59);
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  };
  const dom = new JSDOM('<main></main>', { url:'https://fixture.invalid', pretendToBeVisual:true });
  const host = dom.window.document.querySelector('main'), callbacks = [];
  dom.window.setInterval = callback => (callbacks.push(callback), callbacks.length);
  dom.window.clearInterval = () => {};
  const state = {filter:'today', search:'Synthetic', goal:'', sphere:'', page:0};
  const rows = [row('Synthetic old','2026-10-02'), row('Synthetic next','2026-10-03')];
  const dispose = mountCalendarTasks(host, {state, invoke:async command => command==='get_calendar_tasks'?rows:[], openTask(){}, editDate(){}, executeAction(){}, notifyChange(){}});
  t.after(() => { dispose(); dom.window.close(); globalThis.Date = OriginalDate; });
  await settle();
  const titles = () => [...host.querySelectorAll('[data-task-control="open"]')].map(el=>el.textContent);
  assert.deepEqual(titles(), ['Synthetic old']);
  const search = host.querySelector('[data-tasks-search]'); search.focus();
  now = new OriginalDate(2026,9,3,0,1);
  callbacks.forEach(callback=>callback()); await settle(); await settle();
  assert.deepEqual(titles(), ['Synthetic next']);
  assert.equal(state.filter, 'today'); assert.equal(state.search, 'Synthetic');
  assert.equal(search.value, 'Synthetic'); assert.equal(dom.window.document.activeElement, search);
});

test('large synthetic catalogue retains filters and search through failed reads and retry', async t => {
  const dom = new JSDOM('<main></main>', {url:'https://fixture.invalid', pretendToBeVisual:true});
  const host = dom.window.document.querySelector('main');
  const state = {filter:'undated', search:'Synthetic 4999', goal:'', sphere:'work', page:0};
  const rows = Array.from({length:5000}, (_,index)=>row('Synthetic '+index,null,{sphere:'work'}));
  let fail = false;
  const dispose = mountCalendarTasks(host, {state, invoke:async command => {if(fail)throw new Error('synthetic read fault');return command==='get_calendar_tasks'?rows:[];},openTask(){},editDate(){},executeAction(){},notifyChange(){}});
  t.after(()=>{dispose();dom.window.close();}); await settle();
  const search = host.querySelector('[data-tasks-search]'); search.focus();
  const titles = () => [...host.querySelectorAll('[data-task-control="open"]')].map(el=>el.textContent);
  assert.deepEqual(titles(),['Synthetic 4999']);
  fail=true; dom.window.dispatchEvent(new dom.window.Event('task-state-changed')); await settle();await settle();
  assert.equal(host.querySelector('[data-tasks-retry]').hidden,false);
  assert.deepEqual(titles(),['Synthetic 4999']);
  fail=false; rows.push(row('Synthetic 4999 extra',null,{sphere:'work'}));
  host.querySelector('[data-tasks-retry]').click();await settle();await settle();
  assert.equal(host.querySelector('[data-tasks-retry]').hidden,true);
  assert.deepEqual(titles(),['Synthetic 4999','Synthetic 4999 extra']);
  assert.equal(state.filter,'undated');assert.equal(state.sphere,'work');assert.equal(search.value,'Synthetic 4999');
  assert.equal(dom.window.document.activeElement,search);
});

for (const scenario of [
  {label:'Начать', active:false, worked:false, action:'start', recoveredLabel:'Пауза'},
  {label:'Продолжить', active:false, worked:true, action:'start', recoveredLabel:'Пауза'},
  {label:'Пауза', active:true, worked:true, action:'pause', recoveredLabel:'Продолжить'},
]) {
  test(`${scenario.label}: a successful timer change followed by a failed read locks stale execution until Retry`, async t => {
    const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main');
    let task=row('Synthetic timer',null,{is_active:scenario.active,has_work:scenario.worked}),failRead=false;
    const actions=[];
    const dispose=mountCalendarTasks(host,{
      invoke:async command=>{
        if(command==='get_calendar_tasks'){if(failRead)throw Error('synthetic list read fault');return [{...task}];}
        return command==='get_ui_state'?null:[];
      },
      openTask(){},editDate(){},notifyChange(){dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));},
      executeAction:async (selected,action)=>{
        actions.push([selected.source_id,action]);
        task={...task,is_active:action==='start',has_work:true};
        failRead=true;
      },
    });
    t.after(()=>{dispose();dom.window.close();});await settle();await settle();
    const run=()=>host.querySelector('[data-task-control="execute"]');
    const original=run();assert.equal(original.textContent,scenario.label);original.click();await settle();await settle();
    assert.deepEqual(actions,[['Synthetic timer',scenario.action]]);
    assert.equal(task.is_active,scenario.action==='start','the timer mutation succeeded');
    assert.equal(run().textContent,scenario.label,'the previous list remains visible');
    assert.equal(run().disabled,true,'a stale timer state cannot choose Start or Pause');
    const message=host.querySelector('[data-tasks-message]'),retry=host.querySelector('[data-tasks-retry]');
    assert.match(message.textContent,/Не удалось обновить задачи/);
    assert.equal(message.getAttribute('role'),'alert');assert.equal(retry.hidden,false);
    original.click();run().click();await settle();
    assert.equal(actions.length,1,'stale controls cannot issue a second timer action');
    retry.click();await settle();await settle();
    assert.equal(run().disabled,true);assert.match(message.textContent,/Не удалось обновить задачи/);
    failRead=false;retry.click();await settle();await settle();
    assert.equal(run().disabled,false);assert.equal(run().textContent,scenario.recoveredLabel);
    assert.equal(retry.hidden,true);assert.equal(message.textContent,'');assert.equal(message.getAttribute('role'),'status');
    assert.equal(actions.length,1,'Retry only reads authoritative state');
  });
}

test('Retry unlocks timer execution when the authoritative list is unchanged after a read failure', async t => {
  const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');
  const task=row('Synthetic paused timer',null,{has_work:true});let failRead=false;
  const dispose=mountCalendarTasks(host,{invoke:async command=>{
    if(command==='get_calendar_tasks'){if(failRead)throw Error('synthetic read fault');return [task];}
    return command==='get_ui_state'?null:[];
  },openTask(){},editDate(){},notifyChange(){},executeAction(){throw Error('No timer action requested');}});
  t.after(()=>{dispose();dom.window.close();});await settle();await settle();
  const run=()=>host.querySelector('[data-task-control="execute"]');
  assert.equal(run().disabled,false);assert.equal(run().textContent,'Продолжить');
  failRead=true;dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));await settle();await settle();
  assert.equal(run().disabled,true);
  failRead=false;host.querySelector('[data-tasks-retry]').click();await settle();await settle();
  assert.equal(run().disabled,false);assert.equal(run().textContent,'Продолжить');
  assert.equal(host.querySelector('[data-tasks-retry]').hidden,true);
  assert.equal(host.querySelector('[data-tasks-message]').textContent,'');
});

test('a change-event refresh that supersedes the action read cannot unlock a stale timer while pending', async t => {
  const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');
  let task=row('Synthetic event timer',null),changed=false;
  const actions=[],pending=[];
  const dispose=mountCalendarTasks(host,{
    invoke:async command=>{
      if(command==='get_calendar_tasks'){
        if(!changed)return [{...task}];
        return new Promise((resolve,reject)=>pending.push({resolve,reject}));
      }
      return command==='get_ui_state'?null:[];
    },
    openTask(){},editDate(){},
    notifyChange(){dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));},
    executeAction:async (_row,action)=>{actions.push(action);task={...task,is_active:true,has_work:true};changed=true;},
  });
  t.after(()=>{dispose();dom.window.close();});await settle();await settle();
  const run=()=>host.querySelector('[data-task-control="execute"]');
  run().click();await settle();await settle();
  assert.equal(pending.length,2,'the action and its change event both reread the list');
  pending[0].resolve([{...task}]);await settle();await settle();
  assert.equal(run().textContent,'Начать');assert.equal(run().disabled,true,'the superseded read cannot validate the old timer state');
  host.querySelector('[data-tasks-filter="undated"]').click();run().click();await settle();
  assert.equal(run().disabled,true,'a filter render also keeps the pending state locked');assert.deepEqual(actions,['start']);
  pending[1].reject(Error('synthetic latest read fault'));await settle();await settle();
  assert.match(host.querySelector('[data-tasks-message]').textContent,/Не удалось обновить задачи/);
  assert.equal(run().disabled,true);const retry=host.querySelector('[data-tasks-retry]');assert.equal(retry.hidden,false);
  retry.click();await settle();assert.equal(pending.length,3);assert.equal(run().disabled,true);
  pending[2].resolve([{...task}]);await settle();await settle();
  assert.equal(run().textContent,'Пауза');assert.equal(run().disabled,false);assert.equal(retry.hidden,true);assert.deepEqual(actions,['start']);
});

test('a late superseded action read cannot release a newer pending timer mutation', async t => {
  const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');
  let task=row('Synthetic ordered timer',null),changed=false,releasePause;
  const actions=[],pending=[];
  const dispose=mountCalendarTasks(host,{
    invoke:async command=>{
      if(command==='get_calendar_tasks'){
        if(!changed)return [{...task}];
        return new Promise(resolve=>pending.push(resolve));
      }
      return command==='get_ui_state'?null:[];
    },
    openTask(){},editDate(){},
    notifyChange(){dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));},
    executeAction:async (_row,action)=>{
      actions.push(action);
      if(action==='pause')await new Promise(resolve=>{releasePause=resolve;});
      task={...task,is_active:action==='start',has_work:true};changed=true;
    },
  });
  t.after(()=>{dispose();dom.window.close();});await settle();await settle();
  const run=()=>host.querySelector('[data-task-control="execute"]');
  run().click();await settle();await settle();assert.equal(pending.length,2);
  pending[1]([{...task}]);await settle();await settle();
  assert.equal(run().textContent,'Пауза');assert.equal(run().disabled,false);
  run().click();await settle();assert.deepEqual(actions,['start','pause']);assert.equal(run().disabled,true);
  pending[0]([{...task}]);await settle();await settle();
  assert.equal(run().disabled,true,'the older action cleanup must preserve the pending pause lock');
  run().click();await settle();assert.deepEqual(actions,['start','pause'],'one explicit Pause issues one timer mutation');
  releasePause();await settle();await settle();assert.equal(pending.length,4);
  pending[2]([{...task}]);pending[3]([{...task}]);await settle();await settle();
  assert.equal(run().textContent,'Продолжить');assert.equal(run().disabled,false);assert.deepEqual(actions,['start','pause']);
});
