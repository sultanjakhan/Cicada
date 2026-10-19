import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EVENT_CREATE_PENDING_KEY } from '../src/hanni/js/calendar-event-create-attempt.js';

const settle = async () => { for (let i=0;i<14;i++) await new Promise(resolve=>setImmediate(resolve)); };
async function fixture(t) {
  const dom = new JSDOM('<body></body>', { url:'http://localhost', pretendToBeVisual:true }), w=dom.window;
  for (const name of ['window','document','localStorage','MutationObserver','AbortController','CustomEvent','Event','FormData','Option']) globalThis[name]=name==='window'?w:w[name];
  globalThis.marked={Marked:class { use() {} parse(value) { return value; } }};
  const state={events:[],receipts:new Map(),calls:[],links:[],active:[],loseCreate:0,failRecovery:0,failReadback:0,failLink:0,loseStart:0};
  w.__TAURI__={core:{invoke:async(command,args={})=>{
    state.calls.push({command,args:structuredClone(args)});
    if(command==='list_event_categories')return [{id:'general',name:'general',color:'#999'}];
    if(command==='get_goals')return [{id:'g',title:'Owned goal',goal_kind:'goal'}];
    if(command==='get_ui_state')return null;
    if(command==='get_calendar_task_goals')return structuredClone(state.links);
    if(command==='get_all_events'){if(state.failReadback-->0)throw Error('unavailable readback');return structuredClone(state.events);}
    if(command==='create_event'){
      const {operationId,recoverOnly,...payload}=args;
      if(recoverOnly&&state.failRecovery-->0)throw Error('unavailable receipt');
      const receipt=state.receipts.get(operationId);
      if(receipt){if(JSON.stringify(receipt.payload)!==JSON.stringify(payload))throw Error('event_create_operation_conflict');return receipt.id;}
      if(recoverOnly)return null;
      const id=`event-${state.events.length+1}`;
      state.events.push({id,title:payload.title,description:payload.description,date:payload.date,time:payload.time,duration_minutes:payload.durationMinutes,category:payload.category,color:payload.color,priority:payload.priority,version:1});
      if(operationId)state.receipts.set(operationId,{id,payload:structuredClone(payload)});
      if(state.loseCreate-->0)throw Error('acknowledgement lost after commit');
      return id;
    }
    if(command==='update_event'){
      const event=state.events.find(event=>event.id===args.id);
      if(!event||event.version!==args.expectedVersion)throw Error('stale event');
      Object.assign(event,{title:args.title,description:args.description,date:args.date,time:args.time,duration_minutes:args.durationMinutes,category:args.category,color:args.color,priority:args.priority,version:event.version+1});return;
    }
    if(command==='set_calendar_task_goal'){
      if(state.failLink-->0)throw Error('link unavailable');
      state.links=state.links.filter(link=>link.source_id!==args.sourceId);
      if(args.goalId)state.links.push({source_type:'event',source_id:args.sourceId,goal_id:args.goalId});return;
    }
    if(command==='get_active_blocks')return structuredClone(state.active);
    if(command==='start_task_block'){
      if(state.active.some(block=>block.source_id===args.sourceId)&&args.failIfActive)throw Error('task is already active');
      const block={id:state.active.length+1,source_type:args.sourceType,source_id:args.sourceId};state.active.push(block);
      if(state.loseStart-->0)throw Error('start acknowledgement lost');return block.id;
    }
    throw Error('Unexpected IPC '+command);
  }}};
  t.after(()=>w.close());
  (await import('../src/hanni/js/calendar-categories.js')).invalidateCategoriesCache();
  const {showEventModal}=await import('../src/hanni/js/calendar-event-modal.js');
  const q=selector=>w.document.querySelector(selector);
  const open=async()=>{await showEventModal(null,'2026-11-03',{kind:'event',types:['event'],initialTime:'23:30'});await settle();};
  const field=(selector,value)=>{q(selector).value=value;q(selector).dispatchEvent(new w.Event('input',{bubbles:true}));};
  const submit=async(start=false)=>{if(start)q('#evm-start-now').click();else q('#evm-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();};
  const calls=command=>state.calls.filter(call=>call.command===command);
  return {w,q,state,open,field,submit,calls};
}

test('lost event-create acknowledgement recovers one UUID through repeated unavailable retries',async t=>{
  const x=await fixture(t);await x.open();x.field('#evm-title','Owned uncertain event');x.state.loseCreate=1;
  await x.submit();assert.equal(x.state.events.length,1);assert.ok(x.q('#evm-form'));
  const attempt=JSON.parse(x.w.localStorage.getItem(EVENT_CREATE_PENDING_KEY));
  assert.ok(attempt?.operationId,'request identity is durable before first send');
  x.state.failRecovery=2;
  await x.submit();await x.submit();
  assert.equal(x.state.events.length,1);assert.equal(x.calls('create_event').filter(call=>!call.args.recoverOnly).length,1);
  assert.match(x.q('#evm-error').textContent,/Сохранение не подтверждено/);
  await x.submit();assert.equal(x.state.events.length,1);assert.equal(x.q('#evm-form'),null);
  assert.equal(x.w.localStorage.getItem(EVENT_CREATE_PENDING_KEY),null);
  assert.equal(x.calls('update_event').length,0,'unchanged recovery is not an overwrite');
});

test('uncertain event and edited draft survive close/reopen; changed payload needs explicit reconciliation',async t=>{
  const x=await fixture(t);await x.open();x.field('#evm-title','Original event');x.state.loseCreate=1;await x.submit();
  x.field('#evm-title','Changed retained draft');x.q('#evm-close').click();await settle();await x.open();
  assert.equal(x.q('#evm-title').value,'Changed retained draft');
  await x.submit();assert.equal(x.state.events.length,1);assert.equal(x.state.events[0].title,'Original event');
  assert.match(x.q('#evm-error').textContent,/Прежнее событие найдено/);assert.equal(x.calls('update_event').length,0);
  await x.submit();assert.equal(x.state.events.length,1);assert.equal(x.state.events[0].title,'Changed retained draft');
  assert.equal(x.calls('update_event').length,1);assert.equal(x.q('#evm-form'),null);
});

test('absent receipt and changed request conflict without sending a new payload; original retry is safe',async t=>{
  const x=await fixture(t);await x.open();x.field('#evm-title','Original event');x.state.loseCreate=1;await x.submit();
  // Simulate a pre-commit failure instead: no durable server receipt/event exists.
  x.state.events=[];x.state.receipts.clear();x.field('#evm-title','Changed draft');await x.submit();
  assert.equal(x.state.events.length,0);assert.equal(x.calls('create_event').filter(call=>!call.args.recoverOnly).length,1);
  assert.equal(x.q('#evm-title').value,'Changed draft');assert.match(x.q('#evm-error').textContent,/Запрос изменился/);
  x.field('#evm-title','Original event');await x.submit();assert.equal(x.state.events.length,1);
});

test('separate identical events remain separate and normal all-day category priority fields survive',async t=>{
  const x=await fixture(t);
  for(let i=0;i<2;i++){
    await x.open();x.field('#evm-title','Separate identical event');x.field('#evm-desc','Owned description');
    x.q('#evm-all-day').checked=true;x.q('#evm-all-day').dispatchEvent(new x.w.Event('change',{bubbles:true}));
    x.q('[data-pri="4"]').click();await x.submit();assert.equal(x.q('#evm-form'),null);
  }
  assert.equal(x.state.events.length,2);assert.notEqual(x.state.events[0].id,x.state.events[1].id);
  assert.equal(x.state.receipts.size,2);
  for(const event of x.state.events){assert.equal(event.time,'');assert.equal(event.duration_minutes,0);assert.equal(event.priority,4);assert.equal(event.category,'general');}
});

test('lost create/link/start acknowledgements keep one event and one timer across durable reopen',async t=>{
  const x=await fixture(t);await x.open();x.field('#evm-title','Owned start');x.field('#evm-goal','g');
  x.state.loseCreate=1;await x.submit(true);const id=x.state.events[0].id;
  x.state.failLink=1;await x.submit(true);assert.equal(x.state.events.length,1);assert.equal(x.state.active.length,0);
  x.state.loseStart=1;await x.submit(true);assert.equal(x.state.active.length,1);
  x.q('#evm-close').click();await settle();await x.open();await x.submit(true);
  assert.equal(x.state.events.length,1);assert.equal(x.state.events[0].id,id);assert.equal(x.state.active.length,1);
  assert.equal(x.calls('start_task_block').length,1);assert.equal(x.calls('start_task_block')[0].args.failIfActive,true);
  assert.deepEqual(x.state.links,[{source_type:'event',source_id:id,goal_id:'g'}]);assert.equal(x.q('#evm-form'),null);
});

test('receipt readback failure or deleted event retains UNKNOWN and never recreates the event',async t=>{
  const x=await fixture(t);await x.open();x.field('#evm-title','Owned missing readback');x.state.failReadback=1;
  await x.submit();assert.equal(x.state.events.length,1);assert.ok(x.q('#evm-form'));
  x.state.events=[];await x.submit();await x.submit();
  assert.equal(x.state.events.length,0);assert.equal(x.calls('create_event').filter(call=>!call.args.recoverOnly).length,1);
  assert.ok(x.w.localStorage.getItem(EVENT_CREATE_PENDING_KEY));assert.equal(x.q('#evm-title').value,'Owned missing readback');
});
