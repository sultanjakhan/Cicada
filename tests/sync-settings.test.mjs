import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountSyncSettings } from '../src/hanni/js/sync-settings.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const initial = () => ({ configured:false,enabled:false,pending:0,conflicts:0,last_success:null,last_error:null,running:false,revision:'0' });
function mount(t, transport = null) {
  const dom = new JSDOM('<div id="host"></div>', { url:'https://fixture.invalid',pretendToBeVisual:true }), calls = [], busy = [];
  const host = dom.window.document.querySelector('#host'), q = name => host.querySelector(`[data-sync-${name}]`);
  const dispose = mountSyncSettings(host, { setPending:value=>busy.push(value), invoke:async(command,args)=>{calls.push({command,args});return transport?transport(command,args):initial();} });
  t.after(()=>{dispose();dom.window.close();});return {dom,host,q,calls,busy,dispose};
}
test('connection code stays masked, saves only explicitly and clears after native acknowledgement', async t => {
  let release;const x=mount(t,(command)=>command==='mvp_sync_status'?initial():new Promise(resolve=>{release=resolve;}));await tick();
  const code='{"v":1,"token":"fictional-sensitive-code","enabled":true}';x.q('code').value=code;x.q('code').dispatchEvent(new x.dom.window.Event('input'));
  assert.equal(x.q('code').type,'password');assert.equal(x.calls.length,1);
  x.q('save').click();await tick();assert.equal(x.q('code').value,code);assert.equal(x.q('cancel').disabled,true);assert.deepEqual(x.busy,[true]);
  assert.equal(x.calls[1].command,'mvp_sync_configure');assert.equal(JSON.parse(x.calls[1].args.configJson).enabled,true);
  release({...initial(),configured:true,enabled:true,pending:2});await tick();assert.equal(x.q('code').value,'');assert.equal(x.q('code').type,'password');assert.deepEqual(x.busy,[true,false]);
  assert.equal(x.dom.window.localStorage.length,0);assert.match(x.q('counts').textContent,/2/);assert.doesNotMatch(x.host.textContent,/fictional-sensitive-code/);
});
test('status refresh leaves an unsaved code, toggle and scroll intact; Cancel performs no write', async t => {
  const x=mount(t);await tick();x.q('code').value='draft-code';x.q('code').dispatchEvent(new x.dom.window.Event('input'));x.q('enabled').checked=false;x.q('enabled').dispatchEvent(new x.dom.window.Event('change'));x.host.scrollTop=123;
  x.dom.window.dispatchEvent(new x.dom.window.CustomEvent('hanni:sync-status',{detail:{...initial(),configured:true,enabled:true,pending:4,conflicts:1,last_success:'2026-09-14T04:00:00Z'}}));
  assert.equal(x.q('code').value,'draft-code');assert.equal(x.q('enabled').checked,false);assert.equal(x.host.scrollTop,123);assert.match(x.q('counts').textContent,/4.*1/);
  x.q('cancel').click();assert.equal(x.q('code').value,'');assert.equal(x.q('enabled').checked,true);assert.equal(x.calls.length,1);
});
test('failed configuration keeps the input for retry without exposing transport secrets', async t => {
  const x=mount(t,command=>{if(command==='mvp_sync_status')return initial();throw Error('secret-token-in-error');});await tick();
  x.q('code').value='{"token":"secret-token-in-error"}';x.q('code').dispatchEvent(new x.dom.window.Event('input'));x.q('save').click();await tick();
  assert.equal(x.q('code').value,'{"token":"secret-token-in-error"}');assert.doesNotMatch(x.host.textContent,/secret-token-in-error/);assert.match(x.q('error').textContent,/Не удалось/);assert.equal(x.q('save').disabled,false);
  x.dispose();assert.equal(x.q('code').value,'');
});
