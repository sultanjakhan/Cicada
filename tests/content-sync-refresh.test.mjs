import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { startMvpSyncRefresh } from '../src/hanni/js/content-sync-refresh.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

function setupRefresh(t, initialRevision='9007199254740993') {
  const dom=new JSDOM('',{pretendToBeVisual:true});
  let received,status={revision:initialRevision},wakes=0,unlistened=0,interval;
  let failedReads=0;
  const changes=[],statuses=[];
  const invoke=async()=>{if(failedReads){failedReads--;throw Error('temporary status failure');}return status;};
  dom.window.setInterval=(callback,delay)=>{assert.equal(delay,30_000);interval=callback;return 1;};
  dom.window.clearInterval=()=>{};
  dom.window.addEventListener('hanni:sync-status',event=>statuses.push(event.detail));
  const dispose=startMvpSyncRefresh({window:dom.window,invoke,listen:async(name,callback)=>{assert.equal(name,'mvp-sync-updated');received=callback;return()=>unlistened++;},requestSync:()=>wakes++,requestRefresh:details=>changes.push(details)});
  t.after(()=>{dispose();dom.window.close();});
  return {dom,changes,statuses,setStatus:value=>{status=value;},failNext:()=>{failedReads++;},fireInterval:()=>interval(),emit:value=>received({payload:value}),get wakes(){return wakes;},get unlistened(){return unlistened;}};
}

test('initial revision is a baseline; a no-change 30s wake syncs and checks status without invalidating views', async t => {
  const x=setupRefresh(t); await tick();
  assert.equal(x.wakes,1); assert.deepEqual(x.statuses,[{revision:'9007199254740993'}]);
  x.fireInterval(); await tick();
  assert.equal(x.wakes,2); assert.equal(x.statuses.length,2); assert.deepEqual(x.changes,[]);
  x.dom.window.dispatchEvent(new x.dom.window.Event('focus')); await tick();
  assert.equal(x.wakes,3); assert.deepEqual(x.changes,[]);
});

test('a changed native receive revision invalidates views after sync completes', async t => {
  const x=setupRefresh(t); await tick();
  x.setStatus({revision:'9007199254740994'});
  x.fireInterval(); await tick();
  assert.equal(x.wakes,2); assert.deepEqual(x.changes,[{remote:true}]);
});

test('an explicit views_changed event refreshes immediately and establishes its revision baseline', async t => {
  const x=setupRefresh(t); await tick();
  x.setStatus({revision:'9007199254740994'});
  x.emit({views_changed:true,revision:'9007199254740994'}); await tick();
  assert.deepEqual(x.changes,[{remote:true}]);
  x.dom.window.dispatchEvent(new x.dom.window.Event('hanni:sync-check-status')); await tick();
  assert.deepEqual(x.changes,[{remote:true}], 'the status check must not duplicate the event refresh');
});

test('a failed status read preserves the old revision so recovery still detects received changes', async t => {
  const x=setupRefresh(t); await tick();
  x.failNext(); x.fireInterval(); await tick();
  assert.deepEqual(x.changes,[]);
  x.setStatus({revision:'9007199254740994'});
  x.dom.window.dispatchEvent(new x.dom.window.Event('hanni:sync-check-status')); await tick();
  assert.deepEqual(x.changes,[{remote:true}]);
  assert.ok(x.statuses.some(status=>status.revision==='9007199254740994'));
});

test('returning from a hidden window checks the current revision without a spurious refresh', async t => {
  const x=setupRefresh(t); await tick();
  Object.defineProperty(x.dom.window.document,'visibilityState',{configurable:true,value:'hidden'});
  x.fireInterval(); await tick();
  assert.equal(x.wakes,1); assert.deepEqual(x.changes,[]);
  Object.defineProperty(x.dom.window.document,'visibilityState',{configurable:true,value:'visible'});
  x.dom.window.document.dispatchEvent(new x.dom.window.Event('visibilitychange')); await tick();
  assert.equal(x.wakes,2); assert.deepEqual(x.changes,[]);
});

test('native invoke schedules sync only for acknowledged writes', async t => {
  const dom=new JSDOM('',{url:'https://fixture.invalid',pretendToBeVisual:true});const calls=[],timers=[];
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage});
  let fail=true;dom.window.__TAURI__={core:{invoke:async command=>{calls.push(command);if(command==='set_ui_state'&&fail)throw Error('write rejected');return null;}}};
  dom.window.setTimeout=callback=>{timers.push(callback);return timers.length;};dom.window.clearTimeout=()=>{};
  t.after(()=>dom.window.close());
  const source=(await readFile(new URL('../src/hanni/js/state.js',import.meta.url),'utf8')).replace("'./calendar-display-preferences.js'",JSON.stringify(new URL('../src/hanni/js/calendar-display-preferences.js',import.meta.url).href)).replace("'./sync-trigger.js'",JSON.stringify(new URL('../src/hanni/js/sync-trigger.js',import.meta.url).href)).replace("'../../../package.json'",JSON.stringify(new URL('../package.json',import.meta.url).href));
  const bridge=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  await assert.rejects(bridge.invoke('set_ui_state',{key:'calendar_now_v1',value:'{}'}));assert.equal(timers.length,0);
  fail=false;await bridge.invoke('set_ui_state',{key:'calendar_now_v1',value:'{}'});assert.equal(timers.length,1);timers.shift()();await tick();assert.equal(calls.filter(command=>command==='mvp_sync_now').length,1);
  await bridge.invoke('mvp_sync_set_enabled',{enabled:true});assert.equal(timers.length,0);
});
