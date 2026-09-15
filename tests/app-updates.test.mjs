import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountAppUpdates, startAppUpdates } from '../src/hanni/js/app-updates.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const available = { configured:true, installed_version:'0.3.4', platform:'android-aarch64', phase:'available', version:'0.3.5', notes:'<img src=x onerror=alert(1)>', size:100, downloaded:0 };

test('settings require explicit action, preserve version, render release text safely', async () => {
  const dom = new JSDOM('<section></section>'), host = dom.window.document.querySelector('section'), calls = [];
  const stop = mountAppUpdates(host, { invoke:async (command, args) => {
    calls.push([command, args]);
    return { ...available, phase:command === 'mvp_update_install' ? 'permission_required' : 'available' };
  }});
  await tick(); assert.deepEqual(calls.map(x => x[0]), ['mvp_update_status']);
  assert.equal(host.querySelector('img'), null);
  assert.equal(host.querySelector('[data-update-notes]').textContent, available.notes);
  host.querySelector('[data-update-install]').click(); await tick();
  assert.deepEqual(calls[1], ['mvp_update_install', { expectedVersion:'0.3.5' }]);
  assert.equal(host.querySelector('[data-update-permission]').hidden, false);
  host.querySelector('[data-update-permission]').click(); await tick();
  assert.equal(calls[2][0], 'mvp_update_open_permission');
  stop(); dom.window.close();
});

test('update errors allow retry and do not claim installed; disposal ignores late result', async () => {
  const dom = new JSDOM('<section></section>'), host = dom.window.document.querySelector('section');
  const stop = mountAppUpdates(host, { invoke:async command => {
    if (command === 'mvp_update_install') throw Error('Подпись не прошла проверку');
    return available;
  }});
  await tick(); host.querySelector('[data-update-install]').click(); await tick();
  assert.equal(host.querySelector('[data-update-check]').disabled, false);
  assert.equal(host.querySelector('[data-update-error]').hidden, false);
  assert.equal(host.querySelector('[data-update-install]').hidden, true);
  stop(); const text = host.textContent;
  dom.window.dispatchEvent(new dom.window.CustomEvent('hanni:update-status', { detail:{ ...available, phase:'current' } }));
  assert.equal(host.textContent, text); dom.window.close();
});

test('startup checks automatically without installation and throttles foreground checks', async () => {
  const dom = new JSDOM('', { pretendToBeVisual:true }), calls = [], timers = [], notices = [];
  dom.window.setTimeout = callback => { timers.push(callback); return 1; };
  const stop = startAppUpdates({ window:dom.window, invoke:async command => {
    calls.push(command); return command === 'mvp_update_status' ? { ...available, phase:'idle' } : available;
  }, listen:async () => () => {}, notify:message => notices.push(message) });
  await timers[0](); dom.window.dispatchEvent(new dom.window.Event('online')); await tick();
  assert.deepEqual(calls, ['mvp_update_status', 'mvp_update_check']);
  assert.equal(notices.length, 1); stop(); dom.window.close();
});

test('offline startup does not check or interrupt application', async () => {
  const dom = new JSDOM('', { pretendToBeVisual:true }), timers = [], calls = [];
  Object.defineProperty(dom.window.navigator, 'onLine', { value:false });
  dom.window.setTimeout = callback => { timers.push(callback); return 1; };
  const stop = startAppUpdates({ window:dom.window, invoke:async command => calls.push(command), listen:async () => () => {} });
  await timers[0](); assert.deepEqual(calls, []); stop(); dom.window.close();
});
