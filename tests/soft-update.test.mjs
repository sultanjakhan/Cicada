import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSoftUpdateNotice } from '../src/hanni/js/app-update-notice.js';
import { startAppUpdates } from '../src/hanni/js/app-updates.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const available = { configured: true, installed_version: '1.2.3', phase: 'available', version: '9.8.7' };

test('soft offer preserves focus, uses the feed version and installs only on click', async () => {
  const dom = new JSDOM('<input id="work">', { pretendToBeVisual: true }), calls = [];
  dom.window.document.querySelector('input').focus();
  const notice = createSoftUpdateNotice(dom.window, { invoke: async (...args) => { calls.push(args); return { ...available, phase: 'installer_opened' }; } });
  assert.equal(notice.show(available), true);
  assert.equal(dom.window.document.activeElement.id, 'work');
  assert.equal(dom.window.document.querySelector('[data-soft-update-version]').textContent, '9.8.7');
  assert.equal(calls.length, 0);
  dom.window.document.querySelector('[data-soft-update-install]').click();
  dom.window.document.querySelector('[data-soft-update-install]').click();
  await tick();
  assert.deepEqual(calls, [['mvp_update_install', { expectedVersion: '9.8.7' }]]);
  notice.dispose(); dom.window.close();
});

test('hidden app, unconfigured channel and unsaved work never start an installer', () => {
  const dom = new JSDOM('', { pretendToBeVisual: true }), calls = [];
  const notice = createSoftUpdateNotice(dom.window, { invoke: (...args) => calls.push(args), safe: () => false });
  assert.equal(notice.show({ ...available, configured: false }), false);
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'hidden' });
  assert.equal(notice.show(available), false);
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
  notice.show(available);
  assert.equal(dom.window.document.querySelector('[data-soft-update-install]').disabled, true);
  dom.window.document.querySelector('[data-soft-update-later]').click();
  assert.equal(dom.window.document.querySelector('.calendar-soft-update'), null);
  assert.equal(calls.length, 0);
  notice.dispose(); dom.window.close();
});

test('background discovery waits for entry; Later is respected throughout this session', async () => {
  const dom = new JSDOM('', { pretendToBeVisual: true }), handlers = {}, calls = [];
  let result = { ...available, phase: 'current', version: null };
  const stop = startAppUpdates({ window: dom.window, invoke: async command => { calls.push(command); return result; },
    listen: async (event, callback) => { handlers[event] = callback; return () => {}; } });
  await tick();
  result = available;
  handlers['hanni:update-status']({ payload: available });
  assert.equal(dom.window.document.querySelector('.calendar-soft-update'), null);
  dom.window.dispatchEvent(new dom.window.Event('focus'));
  await tick();
  assert.ok(dom.window.document.querySelector('.calendar-soft-update'));
  const count = calls.length;
  await tick(); await tick();
  assert.equal(calls.length, count, 'Notice must not cause a MutationObserver/IPC loop');
  dom.window.document.querySelector('[data-soft-update-later]').click();
  dom.window.dispatchEvent(new dom.window.Event('focus'));
  handlers['hanni:update-status']({ payload: { ...available, phase: 'prepared' } });
  await tick();
  assert.equal(dom.window.document.querySelector('.calendar-soft-update'), null);
  result = { ...available, version: '9.8.8' };
  handlers['hanni:update-status']({ payload: result });
  assert.equal(dom.window.document.querySelector('.calendar-soft-update'), null, 'A later version also waits for entry');
  dom.window.dispatchEvent(new dom.window.Event('focus')); await tick();
  assert.equal(dom.window.document.querySelector('[data-soft-update-version]').textContent, '9.8.8');
  assert.ok(!calls.includes('mvp_update_install') && !calls.includes('mvp_update_auto_install'));
  stop(); dom.window.close();
});

test('failed entry check cannot let a later background discovery pop during work', async () => {
  const dom = new JSDOM('', { pretendToBeVisual: true }), handlers = {}, calls = [];
  let offline = true;
  const stop = startAppUpdates({ window: dom.window, invoke: async command => {
    calls.push(command);
    if (offline && ['mvp_update_check', 'mvp_update_status'].includes(command)) throw Error('offline fixture');
    return available;
  }, listen: async (event, callback) => { handlers[event] = callback; return () => {}; } });
  await tick(); await tick();
  offline = false;
  handlers['hanni:update-status']({ payload: available });
  assert.equal(dom.window.document.querySelector('.calendar-soft-update'), null);
  dom.window.dispatchEvent(new dom.window.Event('online')); await tick();
  assert.equal(dom.window.document.querySelector('.calendar-soft-update'), null);
  dom.window.dispatchEvent(new dom.window.Event('focus')); await tick();
  assert.ok(dom.window.document.querySelector('.calendar-soft-update'));
  assert.ok(!calls.includes('mvp_update_install') && !calls.includes('mvp_update_auto_install'));
  stop(); dom.window.close();
});

test('permission and confirmation system UI require distinct explicit clicks', async () => {
  for (const [phase, command] of [['permission_required', 'mvp_update_open_permission'], ['confirmation_required', 'mvp_update_confirm']]) {
    const dom = new JSDOM('', { pretendToBeVisual: true }), calls = [];
    const notice = createSoftUpdateNotice(dom.window, { invoke: async c => { calls.push(c); return { ...available, phase }; } });
    notice.show({ ...available, phase }); await tick(); assert.equal(calls.length, 0);
    dom.window.document.querySelector('[data-soft-update-install]').click(); await tick();
    assert.deepEqual(calls, [command]); notice.dispose(); dom.window.close();
  }
});

test('offer stays mounted across checking, idle and failed background status', () => {
  const dom = new JSDOM('', { pretendToBeVisual:true });
  const notice = createSoftUpdateNotice(dom.window, {invoke:async()=>available});
  notice.show(available);
  const host = dom.window.document.querySelector('.calendar-soft-update');
  for (const phase of ['checking','idle','error']) {
    notice.update({configured:true,phase,version:null});
    assert.equal(dom.window.document.querySelector('.calendar-soft-update'),host);
    assert.equal(host.querySelector('[data-soft-update-version]').textContent,available.version);
  }
  notice.update({...available,phase:'current',version:null});
  assert.equal(dom.window.document.querySelector('.calendar-soft-update'),null);
  notice.dispose(); dom.window.close();
});

test('Later survives notice restart for exactly the dismissed version', () => {
  const dom = new JSDOM('', {pretendToBeVisual:true,url:'https://synthetic.test'});
  let notice = createSoftUpdateNotice(dom.window,{invoke:async()=>available});
  notice.show(available); dom.window.document.querySelector('[data-soft-update-later]').click(); notice.dispose();
  notice = createSoftUpdateNotice(dom.window,{invoke:async()=>available});
  assert.equal(notice.show(available),false);
  assert.equal(notice.show({...available,version:'9.8.8'}),true);
  notice.dispose(); dom.window.close();
});

test('a late installation reply cannot overwrite a newer offered version or disable Later forever', async () => {
  const dom = new JSDOM('', {pretendToBeVisual:true}); let resolve;
  const notice = createSoftUpdateNotice(dom.window,{invoke:()=>new Promise(r=>resolve=r)});
  notice.show(available); dom.window.document.querySelector('[data-soft-update-install]').click();
  notice.update({...available,version:'9.8.8'});
  resolve({...available,phase:'installer_opened'}); await tick();
  assert.equal(dom.window.document.querySelector('[data-soft-update-version]').textContent,'9.8.8');
  assert.equal(dom.window.document.querySelector('[data-soft-update-later]').disabled,false);
  dom.window.document.querySelector('[data-soft-update-later]').click();
  assert.equal(notice.show({...available,version:'9.8.8'}),false);
  notice.dispose(); dom.window.close();
});

test('returning from hidden restores an undismissed offer', async () => {
  const dom = new JSDOM('',{pretendToBeVisual:true});
  const stop = startAppUpdates({window:dom.window,invoke:async()=>available,listen:async()=>()=>{}});
  await tick(); assert.ok(dom.window.document.querySelector('.calendar-soft-update'));
  Object.defineProperty(dom.window.document,'visibilityState',{configurable:true,value:'hidden'});
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(dom.window.document.querySelector('.calendar-soft-update'),null);
  Object.defineProperty(dom.window.document,'visibilityState',{configurable:true,value:'visible'});
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); await tick();
  assert.ok(dom.window.document.querySelector('.calendar-soft-update'));
  stop(); dom.window.close();
});
