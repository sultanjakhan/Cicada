import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountCalendarDayLifecycle,DAY_PENDING_KEY,DAY_QUARANTINE_KEY,validDayRequest} from '../src/hanni/js/calendar-day-lifecycle.js';
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
function fixture(t,{storage,handler,asyncClose=false,language='ru'}={}){
 const dom=new JSDOM('<main></main>',{url:'https://synthetic.test',pretendToBeVisual:true}),w=dom.window,host=w.document.querySelector('main'),calls=[],receipts=new Map(),receiptRequests=new Map();
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;if(asyncClose)setImmediate(()=>this.dispatchEvent(new w.Event('close')));else this.dispatchEvent(new w.Event('close'));};
 w.document.documentElement.lang=language;
 const openedTasks=[];
 const state={scope:'device_local',date:'2026-10-08',local_date:'2026-10-08',offset_minutes:330,next_date:'2026-10-09',token:'a'.repeat(64),day:{closed:false,revision:0,summaries:[],plan_ids:[]},next_day:{closed:false,revision:0,summaries:[],plan_ids:[]},history:[],active_blocks:[{id:1,source_type:'note',source_id:'one',title:'Synthetic Timer',seconds:91}],candidates:[{id:'one',title:'Synthetic One',deadline:'2026-12-01',version:7},{id:'two',title:'Synthetic Two',deadline:null,version:3}]};
 const invoke=async(command,args)=>{calls.push([command,structuredClone(args)]);if(handler){const intercepted=await handler(command,args,state,receipts);if(intercepted!==undefined)return intercepted;}
  if(command==='read_calendar_day')return structuredClone(state);
  if(command==='read_calendar_day_operation'){const saved=receiptRequests.get(args.input.operation_id);if(saved&&JSON.stringify(saved)!==JSON.stringify(args.input))throw Error('calendar_day_operation_conflict');return receipts.get(args.input.operation_id)||null;}
  if(command==='commit_calendar_day_action'){
   const req=args.input;if(receipts.has(req.operation_id))return receipts.get(req.operation_id);
   if(req.action==='close'){state.day.closed=true;state.day.summaries.push({closed_at_utc:'2026-10-07T18:30:00Z',paused_blocks:structuredClone(state.active_blocks)});state.history=[{date:state.date,closed:true,summaries:state.day.summaries}];state.active_blocks=[];}
   if(req.action==='reopen')state.day.closed=false;
   if(req.action==='plan')state.next_day.plan_ids=[...req.task_ids];
   const receipt={operation_id:req.operation_id,action:req.action};receipts.set(req.operation_id,receipt);receiptRequests.set(req.operation_id,structuredClone(req));return receipt;
  }throw Error(command);
 };
 const options={invoke,onOpenTask:record=>openedTasks.push(record),...(storage?{storage}: {})};
 let stop=mountCalendarDayLifecycle(host,options);
 t.after(()=>{stop();dom.window.close();});
 return{w,host,calls,state,receipts,invoke,openedTasks,restart(){stop();stop=mountCalendarDayLifecycle(host,options);},click(sel){const e=w.document.querySelector(sel);assert.ok(e,sel);e.click();},submit(){w.document.querySelector('dialog form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));}};
}
const commits=x=>x.calls.filter(([c])=>c==='commit_calendar_day_action');
test('End Day preview lists actual human timers; cancel leaves no intent or native commit',async t=>{const x=fixture(t);await tick();x.click('[data-end-day]');await tick();assert.match(x.w.document.querySelector('dialog').textContent,/Synthetic Timer.*1:31/);assert.match(x.w.document.querySelector('dialog').textContent,/2026-10-08/);assert.equal(commits(x).length,0);x.click('dialog [data-dialog-close]');assert.equal(commits(x).length,0);assert.equal(x.w.localStorage.getItem(DAY_PENDING_KEY),null);assert.equal(x.state.day.closed,false);});
test('double submit commits once, closes day and reopen never restarts timers',async t=>{let release;const x=fixture(t,{handler:(command)=>command==='commit_calendar_day_action'?new Promise(r=>release=()=>r(undefined)):undefined});await tick();x.click('[data-end-day]');await tick();x.submit();x.submit();await tick();assert.equal(commits(x).length,1);release();await tick();assert.equal(x.state.day.closed,true);assert.equal(x.host.querySelector('[data-end-day]').hidden,true);x.click('[data-day-summary]');await tick();assert.match(x.w.document.querySelector('dialog').textContent,/Synthetic Timer/);x.submit();await tick();release();await tick();assert.equal(x.state.day.closed,false);assert.equal(x.state.active_blocks.length,0);assert.equal(x.state.day.summaries.length,1);assert.ok(x.calls.every(([c])=>!['start_task_block','complete_calendar_task','finish_task_block'].includes(c)));});
test('blank plan is unchecked and Skip writes nothing; selection preserves original ids/deadlines',async t=>{const x=fixture(t);await tick();const before=structuredClone(x.state.candidates);x.click('[data-next-day-plan]');await tick();assert.equal(x.w.document.querySelectorAll('[data-day-plan-task]:checked').length,0);x.click('[data-day-plan-skip]');assert.equal(commits(x).length,0);x.click('[data-next-day-plan]');await tick();x.w.document.querySelector('[data-day-plan-task][value=two]').checked=true;x.submit();await tick();assert.deepEqual(commits(x)[0][1].input.task_ids,['two']);assert.deepEqual(x.state.candidates,before);assert.deepEqual(x.state.next_day.plan_ids,['two']);assert.ok(x.calls.every(([c])=>c!=='save_calendar_task'));});
test('empty selected plan is valid and is not a blanket carry',async t=>{const x=fixture(t);await tick();x.click('[data-next-day-plan]');await tick();x.submit();await tick();assert.deepEqual(commits(x)[0][1].input.task_ids,[]);assert.deepEqual(x.state.next_day.plan_ids,[]);});
test('unknown reply retains exact request; retry is identical and restart reads the durable receipt',async t=>{let fail=true;const x=fixture(t,{handler:(c)=>{if(c==='commit_calendar_day_action'&&fail)throw Error('synthetic lost reply');}});await tick();x.click('[data-end-day]');await tick();x.submit();await tick();const original=commits(x)[0][1].input;assert.deepEqual(JSON.parse(x.w.localStorage.getItem(DAY_PENDING_KEY)),original);assert.equal(x.host.querySelector('[data-next-day-plan]').disabled,true);x.click('dialog [data-dialog-close]');fail=false;x.click('[data-day-action-retry]');await tick();assert.deepEqual(commits(x)[1][1].input,original);assert.equal(x.w.localStorage.getItem(DAY_PENDING_KEY),null);x.w.localStorage.setItem(DAY_PENDING_KEY,JSON.stringify(original));x.restart();await tick();assert.equal(commits(x).length,2);assert.equal(x.w.localStorage.getItem(DAY_PENDING_KEY),null);assert.equal(x.host.querySelector('[data-day-action-retry]').hidden,true);});
test('uncommitted durable intent survives restart but never runs automatically',async t=>{const x=fixture(t,{handler:c=>{if(c==='commit_calendar_day_action')throw Error('offline');}});await tick();x.click('[data-end-day]');await tick();x.submit();await tick();const original=commits(x)[0][1].input;x.restart();await tick();assert.equal(commits(x).length,1);assert.equal(x.host.querySelector('[data-day-action-retry]').hidden,false);x.click('[data-day-action-retry]');await tick();assert.deepEqual(commits(x)[1][1].input,original);});
test('stale preview rejects the action, clears the intent and requires a fresh preview',async t=>{const x=fixture(t,{handler:c=>{if(c==='commit_calendar_day_action')throw 'calendar_day_stale_preview';}});await tick();x.click('[data-end-day]');await tick();x.submit();await tick();assert.equal(x.w.localStorage.getItem(DAY_PENDING_KEY),null);assert.equal(x.state.day.closed,false);assert.match(x.w.document.querySelector('[data-dialog-error]').textContent,/Предпросмотр устарел/);assert.equal(commits(x).length,1);});
test('failure to persist a retry intent prevents native mutation',async t=>{const storage={getItem:()=>null,setItem:()=>{throw Error('synthetic quota');},removeItem:()=>{}};const x=fixture(t,{storage});await tick();x.click('[data-end-day]');await tick();x.submit();await tick();assert.equal(commits(x).length,0);assert.match(x.w.document.querySelector('[data-dialog-error]').textContent,/Не удалось сохранить запрос/);});

test('restart reconciliation checks full request and retains a conflicting saved request',async t=>{
 const x=fixture(t);await tick();x.click('[data-next-day-plan]');await tick();x.submit();await tick();
 const original=commits(x)[0][1].input;const changed={...original,task_ids:['two']};
 x.w.localStorage.setItem(DAY_PENDING_KEY,JSON.stringify(changed));x.restart();await tick();
 assert.deepEqual(x.calls.findLast(([c])=>c==='read_calendar_day_operation')[1],{input:changed});
 assert.deepEqual(JSON.parse(x.w.localStorage.getItem(DAY_PENDING_KEY)),changed);
 assert.equal(x.host.querySelector('[data-next-day-plan]').disabled,true);assert.equal(commits(x).length,1);
});
test('complete saved request validation rejects missing, malformed and extra values',()=>{
 const good={operation_id:'11111111-1111-1111-1111-111111111111',action:'plan',date:'2026-10-08',local_date:'2026-10-08',offset_minutes:330,token:'a'.repeat(64),task_ids:['one']};
 assert.equal(validDayRequest(good),true);
 for(const key of Object.keys(good)){const value={...good};delete value[key];assert.equal(validDayRequest(value),false,key);}
 for(const changed of [{date:'2026-02-30'},{local_date:4},{offset_minutes:1.5},{offset_minutes:1440},{operation_id:'bogus'},{task_ids:[42]},{task_ids:['']},{task_ids:['one','one']},{token:'bogus'},{extra:true},{action:'close'}])assert.equal(validDayRequest({...good,...changed}),false,JSON.stringify(changed));
});
test('corrupted pending data blocks replay and is explicitly quarantined without native mutations',async t=>{
 const x=fixture(t);await tick();const raw=JSON.stringify({operation_id:'11111111-1111-1111-1111-111111111111',action:'close',token:'a'.repeat(64),task_ids:[]});
 x.w.localStorage.setItem(DAY_PENDING_KEY,raw);x.restart();await tick();
 assert.equal(x.host.querySelector('[data-end-day]').disabled,true);assert.equal(x.host.querySelector('[data-day-action-retry]').hidden,true);
 assert.equal(commits(x).length,0);assert.equal(x.calls.filter(([c])=>c==='read_calendar_day_operation').length,0);
 x.click('[data-day-pending-discard]');await tick();assert.equal(x.w.localStorage.getItem(DAY_PENDING_KEY),null);assert.equal(x.w.localStorage.getItem(DAY_QUARANTINE_KEY),raw);
 assert.equal(x.host.querySelector('[data-end-day]').disabled,false);assert.equal(commits(x).length,0);
});
test('history selection waits for asynchronous dialog close before opening the chosen summary',async t=>{
 const x=fixture(t,{asyncClose:true});await tick();x.state.history=[{date:'2026-10-06',closed:true},{date:'2026-10-07',closed:true}];
 x.w.dispatchEvent(new x.w.Event('hanni:calendar-refresh'));await tick();x.click('[data-day-summary]');await tick();
 const button=[...x.w.document.querySelectorAll('dialog button')].find(b=>b.textContent.startsWith('2026-10-06'));assert.ok(button);button.click();
 assert.equal(x.calls.filter(([c,a])=>c==='read_calendar_day'&&a.date==='2026-10-06').length,0);
 await tick();assert.equal(x.calls.filter(([c,a])=>c==='read_calendar_day'&&a.date==='2026-10-06').length,1);assert.ok(x.w.document.querySelector('dialog[open]'));assert.equal(commits(x).length,0);
});


for (const language of ['ru', 'en-US']) {
 const en=language.startsWith('en');
 const expected=(ru,english)=>en?english:ru;
 const status=x=>x.host.querySelector('[data-day-status]').textContent;
 const currentDialog=x=>x.w.document.querySelector('dialog');

 test(`${language}: End Day translates controls and preview while preserving human timer titles`,async t=>{
  const x=fixture(t,{language});await tick();
  x.state.active_blocks[0].title='Начать день';
  assert.equal(x.host.querySelector('[data-end-day]').textContent,expected('Завершить день','End day'));
  assert.equal(x.host.querySelector('[data-next-day-plan]').textContent,expected('План на завтра','Plan for tomorrow'));
  assert.equal(x.host.querySelector('[data-day-summary]').textContent,expected('Итоги дней','Day summaries'));
  x.click('[data-end-day]');await tick();const modal=currentDialog(x);
  assert.equal(modal.querySelector('h2').textContent,expected('Завершить день','End day'));
  assert.equal(modal.querySelector('[type=submit]').textContent,expected('Завершить день','End day'));
  assert.equal(modal.querySelector('header p').textContent,'2026-10-08 · UTC+05:30 · '+expected('На этом устройстве','On this device'));
  assert.equal(modal.querySelector('[aria-label]').getAttribute('aria-label'),expected('Закрыть','Close'));
  assert.equal(modal.querySelector('footer [data-dialog-close]').textContent,expected('Отмена','Cancel'));
  assert.equal(modal.querySelector('fieldset > p').textContent,expected('Будут поставлены на паузу человеческие таймеры:','These human timers will be paused:'));
  assert.equal(modal.querySelector('li').textContent,'Начать день · 1:31');
  assert.equal(modal.querySelector('fieldset > p:last-child').textContent,expected('Задачи остаются незавершёнными. Работа ИИ не меняется.','Tasks remain unfinished. AI work is unchanged.'));
  x.click('dialog [data-dialog-close]');assert.equal(commits(x).length,0);assert.equal(x.w.localStorage.getItem(DAY_PENDING_KEY),null);
  x.state.active_blocks=[];x.state.offset_minutes=-210;x.click('[data-end-day]');await tick();
  assert.equal(currentDialog(x).querySelector('header p').textContent,'2026-10-08 · UTC-03:30 · '+expected('На этом устройстве','On this device'));
  assert.ok(currentDialog(x).textContent.includes(expected('Работающих человеческих таймеров нет.','No human timers are running.')));
  if(en)assert.doesNotMatch(currentDialog(x).textContent,/[А-Яа-яЁё]/);
  assert.equal(commits(x).length,0);
 });

 test(`${language}: tomorrow and today plans keep authored titles, chosen IDs and deadlines`,async t=>{
  const x=fixture(t,{language});await tick();x.state.candidates[0].title='Завершить день';x.state.day.plan_ids=['one'];x.state.next_day.plan_ids=['one'];
  x.w.dispatchEvent(new x.w.Event('hanni:calendar-refresh'));await tick();
  assert.equal(x.host.querySelector('[data-day-plan-today] h3').textContent,expected('План на сегодня','Plan for today'));
  const todayTask=x.host.querySelector('[data-day-plan-today] button');assert.equal(todayTask.textContent,'Завершить день');todayTask.click();
  assert.deepEqual(x.openedTasks,[{source_type:'note',source_id:'one',title:'Завершить день'}]);
  const before=structuredClone(x.state.candidates);x.click('[data-next-day-plan]');await tick();
  assert.equal(currentDialog(x).querySelector('h2').textContent,expected('План на завтра','Plan for tomorrow'));
  assert.equal(currentDialog(x).querySelector('[type=submit]').textContent,expected('Сохранить план','Save plan'));
  assert.equal(currentDialog(x).querySelector('fieldset > p').textContent,expected('План на 2026-10-09. Сроки задач сохраняются.','Plan for 2026-10-09. Task deadlines stay unchanged.'));
  assert.equal(currentDialog(x).querySelector('label span').textContent,'Завершить день'+expected(' · срок ',' · due ')+'2026-12-01');
  assert.equal(currentDialog(x).querySelector('[value=one]').checked,true);
  assert.equal(currentDialog(x).querySelector('[data-day-plan-skip]').textContent,expected('Пропустить','Skip'));
  x.click('[data-day-plan-skip]');assert.equal(commits(x).length,0);
  x.click('[data-next-day-plan]');await tick();currentDialog(x).querySelector('[value=one]').checked=false;currentDialog(x).querySelector('[value=two]').checked=true;x.submit();await tick();
  assert.deepEqual(commits(x)[0][1].input.task_ids,['two']);assert.deepEqual(x.state.candidates,before);
  x.state.candidates=[];x.click('[data-next-day-plan]');await tick();
  assert.ok(currentDialog(x).textContent.includes(expected('Незавершённых задач нет. Можно сохранить пустой план.','No unfinished tasks. You can save an empty plan.')));
  if(en)assert.doesNotMatch(currentDialog(x).textContent,/[А-Яа-яЁё]/);
  x.click('[data-day-plan-skip]');assert.equal(commits(x).length,1);
 });

 test(`${language}: close, summary history and reopen retain timers and summary data`,async t=>{
  const x=fixture(t,{language});await tick();x.state.active_blocks[0].title='Сегодня';x.click('[data-end-day]');await tick();x.submit();await tick();
  assert.equal(status(x),expected('День закрыт. Таймеры не возобновляются автоматически.','The day is closed. Timers do not resume automatically.'));
  const savedSummary=structuredClone(x.state.day.summaries);x.click('[data-day-summary]');await tick();
  assert.equal(currentDialog(x).querySelector('h2').textContent,expected('Итог дня','Day summary'));
  assert.equal(currentDialog(x).querySelector('fieldset > p').textContent,expected('Закрыт: ','Closed: ')+'2026-10-07T18:30:00Z');
  assert.ok(currentDialog(x).textContent.includes('Сегодня · 1:31'));
  assert.equal(currentDialog(x).querySelector('fieldset > p:last-child').textContent,expected('Повторное открытие сохраняет итог и не запускает таймеры.','Reopening preserves the summary and does not start timers.'));
  assert.equal(currentDialog(x).querySelector('[type=submit]').textContent,expected('Открыть день снова','Reopen day'));
  x.submit();await tick();assert.equal(x.state.day.closed,false);assert.deepEqual(x.state.day.summaries,savedSummary);assert.deepEqual(x.state.active_blocks,[]);
  x.click('[data-day-summary]');await tick();assert.equal(currentDialog(x).querySelector('[type=submit]'),null);x.click('dialog [data-dialog-close]');
  x.state.history=[{date:'2026-10-06',closed:true},{date:'2026-10-07',closed:false}];x.w.dispatchEvent(new x.w.Event('hanni:calendar-refresh'));await tick();x.click('[data-day-summary]');await tick();
  assert.equal(currentDialog(x).querySelector('h2').textContent,expected('Итоги дней','Day summaries'));
  assert.deepEqual([...currentDialog(x).querySelectorAll('fieldset button')].map(b=>b.textContent),['2026-10-07'+expected(' · открыт',' · open'),'2026-10-06'+expected(' · закрыт',' · closed')]);
  assert.ok(x.calls.every(([c])=>!['start_task_block','complete_calendar_task','finish_task_block'].includes(c)));
 });

 test(`${language}: unknown outcome and restart keep the same recoverable request`,async t=>{
  let fail=true;const x=fixture(t,{language,handler:c=>{if(c==='commit_calendar_day_action'&&fail)return {operation_id:'unconfirmed',action:'close'};}});await tick();x.click('[data-end-day]');await tick();x.submit();await tick();
  const original=commits(x)[0][1].input;
  assert.equal(currentDialog(x).querySelector('[data-dialog-error]').textContent,expected('Сохранение не подтверждено. Повтори тот же запрос; новое действие пока недоступно.','Saving is unconfirmed. Retry the same request; a new action is unavailable for now.'));
  assert.equal(status(x),expected('Сохранение не подтверждено. Повтори тот же запрос.','Saving is unconfirmed. Retry the same request.'));
  assert.equal(x.host.querySelector('[data-day-action-retry]').textContent,expected('Повторить сохранение','Retry save'));
  assert.equal(x.host.querySelector('[data-next-day-plan]').disabled,true);assert.deepEqual(JSON.parse(x.w.localStorage.getItem(DAY_PENDING_KEY)),original);
  x.restart();await tick();assert.equal(commits(x).length,1);assert.deepEqual(JSON.parse(x.w.localStorage.getItem(DAY_PENDING_KEY)),original);
  fail=false;x.click('[data-day-action-retry]');await tick();assert.deepEqual(commits(x)[1][1].input,original);assert.equal(x.w.localStorage.getItem(DAY_PENDING_KEY),null);assert.equal(x.state.day.closed,true);
 });

 test(`${language}: corrupted recovery preserves raw data when quarantine fails`,async t=>{
  const raw='{"operation_id":"broken"}',values=new Map([[DAY_PENDING_KEY,raw]]);let fail=true;
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>{if(key===DAY_QUARANTINE_KEY&&fail)throw Error('synthetic quota');values.set(key,value);},removeItem:key=>values.delete(key)};
  const x=fixture(t,{language,storage});await tick();
  assert.equal(status(x),expected('Сохранённый запрос повреждён. Его нельзя повторить. Отбросьте его для нового предпросмотра; подтверждённые итоги остаются в истории.','The saved request is corrupted and cannot be retried. Discard it for a new preview; confirmed summaries remain in history.'));
  assert.equal(x.host.querySelector('[data-day-pending-discard]').textContent,expected('Отбросить повреждённый запрос','Discard corrupted request'));
  assert.equal(x.host.querySelector('[data-end-day]').disabled,true);assert.equal(x.host.querySelector('[data-day-action-retry]').hidden,true);
  x.click('[data-day-pending-discard]');await tick();
  assert.equal(status(x),expected('Не удалось сохранить повреждённый запрос отдельно. Он не удалён.','Could not save the corrupted request separately. It has not been deleted.'));
  assert.equal(values.get(DAY_PENDING_KEY),raw);assert.equal(values.has(DAY_QUARANTINE_KEY),false);assert.equal(x.host.querySelector('[data-end-day]').disabled,true);
  fail=false;x.click('[data-day-pending-discard]');await tick();assert.equal(values.has(DAY_PENDING_KEY),false);assert.equal(values.get(DAY_QUARANTINE_KEY),raw);assert.equal(x.host.querySelector('[data-end-day]').disabled,false);
  assert.equal(commits(x).length,0);assert.equal(x.calls.filter(([c])=>c==='read_calendar_day_operation').length,0);
 });

 test(`${language}: load and save failures remain readable and recover without mutations`,async t=>{
  await t.test('unavailable request storage blocks all actions',async st=>{
   const storage={getItem:()=>{throw Error('synthetic storage failure');}};const x=fixture(st,{language,storage});await tick();
   assert.equal(status(x),expected('Хранилище запроса дня недоступно. Сохранение заблокировано.','Day request storage is unavailable. Saving is blocked.'));
   assert.equal(x.host.querySelector('[data-end-day]').disabled,true);assert.equal(x.host.querySelector('[data-next-day-plan]').disabled,true);assert.equal(x.calls.length,0);
  });
  await t.test('state load failure can be retried',async st=>{
   let fail=true;const x=fixture(st,{language,handler:c=>{if(c==='read_calendar_day'&&fail)throw Error('synthetic read failure');}});await tick();
   assert.equal(status(x),expected('Состояние дня недоступно. Данные не изменены.','Day state is unavailable. Data is unchanged.'));assert.equal(x.host.querySelector('[data-end-day]').disabled,true);
   fail=false;x.w.dispatchEvent(new x.w.Event('hanni:calendar-refresh'));await tick();assert.equal(status(x),'');assert.equal(x.host.querySelector('[data-end-day]').disabled,false);assert.equal(commits(x).length,0);
  });
  await t.test('preview failure survives repaint and allows a fresh preview',async st=>{
   let fail=false;const x=fixture(st,{language,handler:c=>{if(c==='read_calendar_day'&&fail)throw Error('synthetic preview failure');}});await tick();const before=structuredClone(x.state);fail=true;x.click('[data-end-day]');await tick();
   assert.equal(status(x),expected('Предпросмотр недоступен. Данные не изменены.','Preview is unavailable. Data is unchanged.'));assert.equal(currentDialog(x),null);assert.equal(x.host.querySelector('[data-end-day]').disabled,false);assert.deepEqual(x.state,before);assert.equal(commits(x).length,0);
   fail=false;x.click('[data-end-day]');await tick();assert.equal(status(x),'');assert.ok(currentDialog(x));assert.equal(commits(x).length,0);
  });
  await t.test('failed durable intent never reaches native mutation',async st=>{
   const storage={getItem:()=>null,setItem:()=>{throw Error('synthetic quota');},removeItem:()=>{}};const x=fixture(st,{language,storage});await tick();x.click('[data-end-day]');await tick();x.submit();await tick();
   assert.equal(currentDialog(x).querySelector('[data-dialog-error]').textContent,expected('Не удалось сохранить запрос для повторной попытки. Данные не изменены.','Could not save the request for retry. Data is unchanged.'));
   assert.equal(status(x),expected('Не удалось сохранить запрос для повторной попытки.','Could not save the request for retry.'));assert.equal(commits(x).length,0);assert.equal(x.state.day.closed,false);
  });
  await t.test('stale preview clears pending state and needs a fresh preview',async st=>{
   let fail=true;const x=fixture(st,{language,handler:c=>{if(c==='commit_calendar_day_action'&&fail)throw Error('calendar_day_stale_preview');}});await tick();x.click('[data-end-day]');await tick();x.submit();await tick();
   assert.equal(currentDialog(x).querySelector('[data-dialog-error]').textContent,expected('Предпросмотр устарел или данные изменились. Закрой окно и перечитай состояние.','The preview is stale or data has changed. Close the dialog and reload the state.'));
   assert.equal(x.w.localStorage.getItem(DAY_PENDING_KEY),null);assert.equal(x.state.day.closed,false);assert.equal(x.host.querySelector('[data-day-action-retry]').hidden,true);
   x.click('dialog [data-dialog-close]');fail=false;x.click('[data-end-day]');await tick();assert.equal(currentDialog(x).querySelector('[data-dialog-error]').textContent,'');assert.equal(commits(x).length,1);
  });
 });
}
