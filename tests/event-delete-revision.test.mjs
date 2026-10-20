import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const settle = async () => { for (let i=0;i<15;i++) await new Promise(r=>setImmediate(r)); };
async function fixture(t, eventOverrides = {}) {
  const w = new JSDOM('<body></body>', {url:'http://localhost',pretendToBeVisual:true}).window;
  for (const n of ['window','document','localStorage','MutationObserver','AbortController','CustomEvent','Event','Option']) globalThis[n]=n==='window'?w:w[n];
  globalThis.marked={Marked:class {use(){} parse(v){return v;}}};
  const oldConfirm=globalThis.confirm; globalThis.confirm=()=>true;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  t.after(()=>{globalThis.confirm=oldConfirm;w.close();});
  const state={event:{id:'example-event',version:1,title:'Reviewed title',description:'Original',date:'2026-11-03',time:'10:00',duration_minutes:60,category:'general',priority:1},calls:[],links:[{source_type:'event',source_id:'example-event',goal_id:'g'}],failRead:false,active:false};
  Object.assign(state.event, eventOverrides);
  w.__TAURI__={core:{invoke:async(name,args={})=>{
    state.calls.push({name,args});
    if(name==='list_event_categories')return [{id:'general',name:'general',color:'#999'}];
    if(name==='get_ui_state')return null;
    if(name==='get_all_events'){if(state.failRead)throw Error('offline');return state.event?[structuredClone(state.event)]:[];}
    if(name==='get_goals')return [{id:'g',title:'Example goal',goal_kind:'goal'}];
    if(name==='get_calendar_task_goals')return structuredClone(state.links);
    if(name==='update_event')throw Error('stale event');
    if(name==='delete_event'){
      if(!state.event||state.event.version!==args.expectedVersion)throw Error('event changed elsewhere or was deleted');
      if(state.active)throw Error('event has an active timer');
      state.event=null;state.links=[];return;
    }
    throw Error('Unexpected '+name);
  }}};
  (await import('../src/hanni/js/calendar-categories.js')).invalidateCategoriesCache();
  await (await import('../src/hanni/js/calendar-event-modal.js')).showEventModal('example-event'); await settle();
  const q=s=>w.document.querySelector(s), deletes=()=>state.calls.filter(c=>c.name==='delete_event');
  if(q('#evm-title')) { q('#evm-title').value='Unsaved draft';q('#evm-desc').value='Keep description'; }
  return {w,state,q,deletes};
}
test('stale deletion preserves draft and links; explicit review binds reconfirmation without advancing the editor',async t=>{
  const x=await fixture(t);x.state.event.version=2;x.state.event.title='Newer title';
  x.q('#evm-del').click();await settle();
  assert.equal(x.deletes()[0].args.expectedVersion,1);assert.equal(x.state.links.length,1);
  assert.equal(x.q('#evm-title').value,'Unsaved draft');assert.equal(x.q('#evm-desc').value,'Keep description');
  x.q('#evm-del').click();await settle();assert.equal(x.deletes().length,1,'cannot blindly repeat stale deletion');
  x.q('#evm-delete-review').click();await settle();
  assert.match(x.q('dialog').textContent,/Newer title/);assert.match(x.q('dialog').textContent,/Example goal/);
  x.q('dialog [data-dialog-close]').click();await settle();
  assert.equal(x.q('#evm-title').value,'Unsaved draft');assert.equal(x.deletes().length,1);
  x.q('#evm-save').click();await settle();
  assert.equal(x.state.calls.find(c=>c.name==='update_event').args.expectedVersion,1,'review never silently rebases editor');
  assert.equal(x.q('#evm-title').value,'Unsaved draft');
  x.q('#evm-delete-review').click();await settle();
  x.state.event.version=3;x.state.event.title='Changed again';
  x.q('dialog form').requestSubmit();await settle();
  assert.equal(x.deletes()[1].args.expectedVersion,2);assert.equal(x.state.event.title,'Changed again');assert.equal(x.state.links.length,1);
  assert.equal(x.q('dialog [type=submit]').disabled,true);
  x.q('dialog [data-dialog-close]').click();await settle();
  x.q('#evm-delete-review').click();await settle();
  assert.match(x.q('dialog').textContent,/Changed again/);
  x.q('dialog form').requestSubmit();x.q('dialog form').requestSubmit();await settle();
  assert.equal(x.deletes().length,3);assert.equal(x.deletes()[2].args.expectedVersion,3);assert.equal(x.state.event,null);assert.equal(x.q('.evm-overlay'),null);
});
test('missing event and failed review keep editor/draft, no implicit recreate or delete',async t=>{
  const x=await fixture(t);x.state.event=null;x.q('#evm-del').click();await settle();
  x.state.failRead=true;x.q('#evm-delete-review').click();await settle();
  assert.equal(x.q('#evm-title').value,'Unsaved draft');assert.equal(x.q('#evm-save').disabled,false);
  x.state.failRead=false;x.q('#evm-delete-review').click();await settle();
  assert.match(x.q('#evm-error').textContent,/больше не существует/);assert.equal(x.q('dialog'),null);assert.equal(x.deletes().length,1);
  assert.equal(x.state.calls.some(c=>c.name==='create_event'),false);assert.equal(x.state.links.length,1);
});
test('current event deletes once; active event requires pause and explicit fresh review',async t=>{
  const x=await fixture(t);x.state.active=true;x.q('#evm-del').click();await settle();
  assert.match(x.q('#evm-error').textContent,/паузу/);assert.equal(x.state.links.length,1);
  x.state.active=false;x.q('#evm-delete-review').click();await settle();x.q('dialog form').requestSubmit();await settle();
  assert.equal(x.state.event,null);assert.equal(x.state.links.length,0);assert.equal(x.q('.evm-overlay'),null);
});
test('current reviewed version deletes directly and removes links',async t=>{
  const x=await fixture(t);x.q('#evm-del').click();x.q('#evm-del').click();await settle();
  assert.equal(x.deletes().length,1);assert.deepEqual(x.deletes()[0].args,{id:'example-event',expectedVersion:1});
  assert.equal(x.state.event,null);assert.equal(x.state.links.length,0);
});

test('protected health projection offers details without a delete action',async t=>{
  const x=await fixture(t,{readonly:true,source:'health_connect'});
  assert.equal(x.q('#evm-del'),null);assert.equal(x.q('#evm-delete-review'),null);assert.equal(x.deletes().length,0);
});
