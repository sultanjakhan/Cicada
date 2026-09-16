import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountAppUpdates, startAppUpdates, updateActivity } from '../src/hanni/js/app-updates.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const available = { configured:true, installed_version:'0.3.4', platform:'android-aarch64', phase:'available', version:'0.3.5', notes:'<img src=x onerror=alert(1)>', size:100, downloaded:0 };

test('settings retain manual fallback, preserve version and render release text safely', async () => {
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

test('native scheduler owns checks and installs; UI reports safe leases even offline', async () => {
  const dom = new JSDOM('', { pretendToBeVisual:true }), calls = [], notices = [];
  Object.defineProperty(dom.window.navigator, 'onLine', { value:false });
  const stop = startAppUpdates({ window:dom.window, invoke:async (command,args) => {
    calls.push([command,args]); return available;
  }, listen:async () => () => {}, notify:message => notices.push(message) });
  await tick();
  assert.ok(calls.some(([c,a]) => c === 'mvp_update_activity' && !a.activity.hidden && a.activity.safeToInstall));
  assert.ok(calls.some(([c]) => c === 'mvp_update_status'));
  assert.ok(calls.every(([c]) => !['mvp_update_check','mvp_update_install','mvp_update_auto_install'].includes(c)));
  assert.equal(notices.length, 0);
  stop(); await tick();
  assert.deepEqual(calls.at(-1), ['mvp_update_activity', { activity:{ hidden:false, safeToInstall:false } }]);
  dom.window.close();
});

test('hidden app must not restart over a dialog, retained note draft or unfinished native call', () => {
  const dom = new JSDOM('<main></main>');
  Object.defineProperty(dom.window.document, 'visibilityState', { value:'hidden' });
  assert.deepEqual(updateActivity(dom.window), { hidden:true, safeToInstall:true });
  const main = dom.window.document.querySelector('main');
  main.innerHTML = '<div role="dialog"><input value="unsaved"></div>';
  assert.equal(updateActivity(dom.window).safeToInstall, false);
  main.firstChild.hidden = true;
  assert.equal(updateActivity(dom.window).safeToInstall, true);
  main.replaceChildren();
  assert.equal(updateActivity(dom.window, { hasUnsavedDrafts:() => true }).safeToInstall, false);
  assert.equal(updateActivity(dom.window, { getPendingOperations:() => 1 }).safeToInstall, false);
  dom.window.close();
});

test('opening a form invalidates hidden lease without waiting for the periodic timer', async () => {
  const dom = new JSDOM('<main></main>'), calls = [];
  Object.defineProperty(dom.window.document, 'visibilityState', { value:'hidden' });
  const stop = startAppUpdates({ window:dom.window, invoke:async (command,args) => {
    calls.push([command,args]); return available;
  }, listen:async () => () => {} });
  await tick();
  dom.window.document.querySelector('main').innerHTML = '<dialog open><textarea>draft</textarea></dialog>';
  await tick();
  assert.equal(calls.filter(([c]) => c === 'mvp_update_activity').at(-1)[1].activity.safeToInstall, false);
  stop(); await tick(); const count = calls.length;
  dom.window.document.querySelector('dialog').remove(); await tick();
  assert.equal(calls.length, count);
  dom.window.close();
});

test('Android requested confirmation only opens from explicit action and never claims success', async () => {
  const dom = new JSDOM('<section></section>'), calls = [], host = dom.window.document.querySelector('section');
  const stop = mountAppUpdates(host, { invoke:async (command,args) => {
    calls.push([command,args]); return { ...available, phase:'confirmation_required' };
  }});
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(host.querySelector('[data-update-install]').textContent, 'Подтвердить установку');
  assert.ok(host.querySelector('[data-update-status]').textContent.includes('Android просит подтвердить'));
  host.querySelector('[data-update-install]').click(); await tick();
  assert.equal(calls[1][0], 'mvp_update_confirm');
  stop(); dom.window.close();
});
