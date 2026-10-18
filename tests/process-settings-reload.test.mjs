import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountProcessSettings } from '../src/hanni/js/calendar-process-settings.js';
import { defaultProcesses, PROCESS_STALE_MESSAGE } from '../src/hanni/js/task-processes.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function boot() {
  const dom = new JSDOM('<section></section>');
  const element = dom.window.document.querySelector('section');
  let raw = JSON.stringify({ version: 1, processes: defaultProcesses() });
  let read = null;
  const writes = [], pending = [];
  const editor = mountProcessSettings(element, {
    setPending: value => pending.push(value),
    invoke: async (command, args) => {
      if (command === 'get_ui_state') return read ? read.promise : raw;
      assert.equal(command, 'set_ui_state');
      writes.push(args);
      if (args.expectedValue !== raw) throw 'mvp_sync_stale_ui_state';
      raw = args.value;
    },
  });
  await tick();
  const q = selector => element.querySelector(selector);
  const type = (selector, value) => { const input = q(selector); input.value = value; input.dispatchEvent(new dom.window.Event('input')); };
  return { editor, element, q, type, writes, pending, reload: () => (read = deferred()), stored: () => JSON.parse(raw), remote: value => { raw = JSON.stringify(value); } };
}
const title = '[data-stage-id="analysis"] [data-control="stage-title"]';

test('failed discard reload retains edited stage identity and draft, reports failure, and permits save', async () => {
  const x = await boot();
  x.type(title, 'Модели');
  const read = x.reload();
  x.q('[data-processes-cancel]').click();
  read.reject(new Error('Read unavailable'));
  await tick();
  assert.equal(x.q(title)?.value, 'Модели');
  assert.equal(x.editor.ready, true);
  assert.equal(x.editor.isDirty(), true);
  assert.equal(x.q('[data-processes-error]').textContent, 'Read unavailable');
  assert.notEqual(x.q('[data-processes-status]').textContent, 'Изменения отменены.');
  assert.equal(await x.editor.save(), true);
  assert.equal(x.stored().processes[0].stages.find(stage => stage.id === 'analysis').title, 'Модели');
});

test('discard reload blocks save and editing until the read finishes', async () => {
  const x = await boot();
  x.type(title, 'Модели');
  const read = x.reload();
  x.q('[data-processes-cancel]').click();
  assert.equal(x.q('fieldset').disabled, true);
  assert.equal(x.q('[data-processes-save]').disabled, true);
  assert.equal(await x.editor.save(), false);
  assert.deepEqual(x.writes, []);
  read.resolve(JSON.stringify({ version: 1, processes: defaultProcesses() }));
  await tick();
  assert.equal(x.q(title).value, 'Анализ и модели');
  assert.equal(x.editor.isDirty(), false);
  assert.equal(x.q('fieldset').disabled, false);
  assert.equal(x.pending.at(-1), false);
});

test('failed conflict reload preserves stale baseline so retry cannot overwrite remote stages', async () => {
  const x = await boot();
  x.type(title, 'Модели');
  const remote = { version: 1, processes: defaultProcesses() };
  remote.processes[0].stages.reverse();
  x.remote(remote);
  assert.equal(await x.editor.save(), false);
  assert.equal(x.q('[data-processes-error]').textContent, PROCESS_STALE_MESSAGE);
  const read = x.reload();
  x.q('[data-processes-cancel]').click();
  read.reject(new Error('Read unavailable'));
  await tick();
  assert.equal(x.q(title)?.value, 'Модели');
  assert.equal(await x.editor.save(), false);
  assert.deepEqual(x.stored(), remote);
  assert.equal(x.writes.length, 2);
  assert.equal(x.writes[0].expectedValue, x.writes[1].expectedValue);
});
