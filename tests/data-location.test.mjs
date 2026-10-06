import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountDataLocation } from '../src/hanni/js/data-location.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('folder move is explicit, trims only the path and reports preparation errors', async () => {
  const dom = new JSDOM('<main></main>');
  globalThis.document = dom.window.document;
  const host = document.querySelector('main'), calls = [];
  const stop = mountDataLocation(host, { invoke: async (command, args) => {
    calls.push([command, args]);
    if (command === 'prepare_data_location') throw Error('Выбранная папка не пуста.');
    return { path: '/synthetic/profile', can_move: true, restart_required: false };
  } });
  await tick();
  assert.deepEqual(calls.map(([command]) => command), ['get_data_location']);
  const input = host.querySelector('input'), button = host.querySelector('button');
  button.click(); await tick();
  assert.equal(calls.length, 1);
  input.value = '  /synthetic/new folder  ';
  button.click(); await tick();
  assert.deepEqual(calls[1], ['prepare_data_location', { path: '/synthetic/new folder' }]);
  assert.equal(host.querySelector('[data-location-status]').textContent, 'Выбранная папка не пуста.');
  assert.equal(input.value, '  /synthetic/new folder  ');
  assert.equal(button.disabled, false);
  stop(); dom.window.close(); delete globalThis.document;
});

test('unavailable migration hides controls; closing the panel ignores a late response', async () => {
  const dom = new JSDOM('<main></main>');
  globalThis.document = dom.window.document;
  const host = document.querySelector('main');
  let stop = mountDataLocation(host, { invoke: async () => ({ path: '/synthetic/android', can_move: false }) });
  await tick();
  assert.equal(host.querySelector('button').hidden, true);
  assert.equal(host.querySelector('.data-location-field').hidden, true);
  stop();
  let reply;
  stop = mountDataLocation(host, { invoke: () => new Promise(resolve => { reply = resolve; }) });
  stop(); reply({ path: '/synthetic/late', can_move: true }); await tick();
  assert.equal(host.textContent, '');
  dom.window.close(); delete globalThis.document;
});
