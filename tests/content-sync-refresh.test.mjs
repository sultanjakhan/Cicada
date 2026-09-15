import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { startMvpSyncRefresh } from '../src/hanni/js/content-sync-refresh.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('native apply, foreground wake and changed revisions invalidate views without sending records to events', async t => {
  const dom=new JSDOM('',{pretendToBeVisual:true});let received,status={revision:'9007199254740993'},wakes=0,unlistened=0;const changes=[];
  const dispose=startMvpSyncRefresh({window:dom.window,invoke:async()=>status,listen:async(name,callback)=>{assert.equal(name,'mvp-sync-updated');received=callback;return()=>unlistened++;},requestSync:()=>wakes++,requestRefresh:details=>changes.push(details)});
  t.after(()=>{dispose();dom.window.close();});await tick();assert.equal(wakes,1);
  status={revision:'9007199254740994'};received({payload:{views_changed:true,revision:status.revision}});await tick();assert.equal(changes.length,1);assert.deepEqual(changes[0],{remote:true});
  status={revision:'9007199254740995'};dom.window.dispatchEvent(new dom.window.Event('focus'));await tick();assert.ok(wakes>=2);assert.ok(changes.length>=2);
  dispose();assert.equal(unlistened,1);
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
