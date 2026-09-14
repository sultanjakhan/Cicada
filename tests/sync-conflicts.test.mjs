import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountSyncConflicts } from '../src/hanni/js/sync-conflicts.js';
import { mountSyncSettings } from '../src/hanni/js/sync-settings.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const version = (overrides = {}) => ({ token:'selected-version', expected:'current-revision', source:'archive', label:'Задача: Пример', reason:null, current:{state:'present',fields:[{label:'Название',value:'Текущее'}]}, incoming:{state:'present',fields:[{label:'Название',value:'Другая версия'}]}, can_keep_current:true, can_use_incoming:true, ...overrides });
function fixture(t, transport) {
  const dom = new JSDOM('<div id="host"></div>', { url:'https://fixture.invalid' }), host = dom.window.document.querySelector('#host'), calls = [], pending = [];
  const mounted = mountSyncConflicts(host, { invoke:async(command,args) => { calls.push({command,args}); return transport(command,args); }, setPending:value => pending.push(value) });
  const q = name => host.querySelector(`[data-conflicts-${name}]`);
  t.after(() => { mounted.dispose(); dom.window.close(); });
  return { dom,host,calls,pending,q,...mounted };
}
test('review is lazy and displays content as text until the user chooses a version', async t => {
  const dangerous = '<img src=x onerror="document.body.remove()"><script>secret()</script>';
  const x = fixture(t, () => ({ total:1, entries:[version({label:dangerous,incoming:{state:'present',fields:[{label:'Текст',value:dangerous}]}})] }));
  assert.equal(x.calls.length,0);
  await x.refresh(); x.q('list').querySelector('button').click();
  assert.equal(x.calls.length,1); assert.match(x.host.textContent,/<img src=x/); assert.equal(x.host.querySelector('img,script'),null);
  assert.equal(x.q('keep').disabled,false); assert.equal(x.q('use').disabled,false);
  assert.equal(x.q('detail').hidden,false); assert.equal(x.q('list').hidden,true);
});
test('resolution sends the exact preview version and waits for native acknowledgement', async t => {
  let release, reviews = 0, statusEvents = 0;
  const x = fixture(t, command => command === 'mvp_sync_conflicts_list' ? {total:reviews++ ? 0 : 1, entries:reviews === 1 ? [version()] : []} : new Promise(resolve => { release = resolve; }));
  x.dom.window.addEventListener('hanni:sync-check-status',() => ++statusEvents);
  await x.refresh(); x.q('list').querySelector('button').click(); x.q('use').click(); await tick();
  assert.deepEqual(x.calls[1],{command:'mvp_sync_conflict_resolve',args:{token:'selected-version',expected:'current-revision',choice:'incoming'}});
  assert.equal(x.q('use').disabled,true); assert.equal(x.q('keep').disabled,true); assert.equal(x.q('refresh').disabled,true); assert.equal(statusEvents,0);
  release({resolved:true,views_changed:true,revision:'12'}); await tick();
  assert.equal(statusEvents,1); assert.match(x.q('message').textContent,/ожидает синхронизации/); assert.equal(x.q('detail').hidden,true); assert.equal(x.calls.length,3);
  assert.equal(x.pending.at(-1),false);
});
test('a concurrent update invalidates the open choice and requires a fresh preview', async t => {
  const x = fixture(t, command => { if (command === 'mvp_sync_conflicts_list') return {total:1,entries:[version()]}; throw 'mvp_sync_conflict_stale'; });
  await x.refresh(); x.q('list').querySelector('button').click(); x.q('keep').click(); await tick();
  assert.match(x.q('message').textContent,/Запись изменилась/); assert.equal(x.q('use').disabled,true); assert.equal(x.q('keep').disabled,true);
  x.q('use').click(); assert.equal(x.calls.length,2);
  x.q('refresh').click(); await tick(); x.q('list').querySelector('button').click(); assert.equal(x.q('use').disabled,false);
});
test('unknown and unsafe records stay read-only without leaking native error text', async t => {
  const x = fixture(t, command => { if (command === 'mvp_sync_conflicts_list') return {total:1,entries:[version({source:'pending',reason:'mvp_sync_conflict_unknown',can_keep_current:false,can_use_incoming:false,current:{state:'unknown',fields:[]},incoming:{state:'unknown',fields:[]}})]}; throw Error('fictional-credential-value'); });
  await x.refresh(); x.q('list').querySelector('button').click();
  assert.match(x.q('detail').textContent,/Формат записи пока не поддерживается/); assert.equal(x.q('keep').disabled,true); assert.equal(x.q('use').disabled,true);
  x.q('keep').click(); assert.equal(x.calls.length,1); assert.doesNotMatch(x.host.textContent,/fictional-credential-value/);
});
test('paging requests a bounded next page and disposal ignores late responses', async t => {
  let release;
  const x = fixture(t, (command,args) => args.offset === 0 ? {total:26,entries:Array.from({length:25},(_,i) => version({token:String(i)}))} : new Promise(resolve => {release=resolve;}));
  await x.refresh(); assert.equal(x.q('previous').disabled,true); assert.equal(x.q('next').disabled,false);
  x.q('next').click(); await tick(); assert.deepEqual(x.calls[1].args,{offset:25,limit:25});
  const prior = x.host.textContent; x.dispose(); release({total:26,entries:[version({label:'late response'})]}); await tick();
  assert.equal(x.host.textContent,prior); assert.equal(x.pending.at(-1),false);
});
test('inline conflict review preserves the connection draft and blocks simultaneous settings writes', async t => {
  const dom = new JSDOM('<div id="host"></div>'), host = dom.window.document.querySelector('#host'), calls = [], pending = [];
  let release;
  const dispose = mountSyncSettings(host, {invoke:async(command,args) => {calls.push({command,args}); if(command === 'mvp_sync_status') return {configured:false,enabled:false,pending:0,conflicts:1}; return new Promise(resolve => {release=resolve;});},setPending:v=>pending.push(v)});
  t.after(() => {dispose();dom.window.close();}); await tick();
  const code = host.querySelector('[data-sync-code]'); code.value = '{"token":"uncommitted-draft"}'; code.dispatchEvent(new dom.window.Event('input'));
  assert.equal(calls.length,1);
  const details = host.querySelector('[data-sync-conflicts]'); const opened = new Promise(resolve => details.addEventListener('toggle',resolve,{once:true})); details.open = true; await opened; await tick();
  assert.equal(calls[1].command,'mvp_sync_conflicts_list'); assert.equal(host.querySelector('[data-sync-save]').disabled,true);
  host.querySelector('[data-sync-save]').click(); assert.equal(calls.length,2);
  release({total:0,entries:[]}); await tick(); assert.equal(code.value,'{"token":"uncommitted-draft"}'); assert.equal(code.type,'password'); assert.equal(host.querySelector('[data-sync-save]').disabled,false); assert.equal(pending.at(-1),false);
});
