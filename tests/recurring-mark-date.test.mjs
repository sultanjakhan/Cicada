import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const bootstrap = new JSDOM('<!doctype html><main></main>', { url: 'https://fixture.invalid' });
globalThis.window = bootstrap.window;
globalThis.document = bootstrap.window.document;
globalThis.CustomEvent = bootstrap.window.CustomEvent;
globalThis.localStorage = bootstrap.window.localStorage;
globalThis.marked = { Marked: class { use() {} parse(value) { return value; } } };
const { mountCalendarRecurring } = await import('../src/hanni/js/calendar-recurring.js');

const today = '2026-10-08', yesterday = '2026-10-07', tomorrow = '2026-10-09';
const daily = { id: 'fictional-rule', kind: 'rule', title: 'Fictional daily rule',
  weekdays: [0, 1, 2, 3, 4, 5, 6], startsOn: yesterday, endsOn: '', time: '',
  active: true, required: true, createdOn: yesterday };
const oldSnapshot = { ...daily, title: 'Earlier fictional rule' };
const check = { ...daily, id: 'fictional-check', kind: 'action', mode: 'check', title: 'Fictional check' };
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };

async function setup(t, library) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://fixture.invalid' });
  const document = dom.window.document, host = document.querySelector('main');
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  let clock = new Date(`${today}T23:59:00`), tick;
  dom.window.setInterval = callback => { tick = callback; return 1; };
  dom.window.clearInterval = () => {};
  const fixture = { raw: JSON.stringify({ version: 1, plans: [daily, check], days: {
    [yesterday]: { [daily.id]: { snapshot: oldSnapshot, status: 'broken' } },
  } }), writes: 0, failWrites: 0, changes: 0, calls: [], writeGate: null };
  const invoke = async (command, args) => {
    fixture.calls.push(command);
    if (command === 'get_ui_state') return fixture.raw;
    if (command === 'set_ui_state') {
      fixture.writes++;
      assert.equal(args.expectedValue, fixture.raw);
      if (fixture.failWrites > 0) { fixture.failWrites--; throw Error('Fictional save unavailable'); }
      if (fixture.writeGate) await fixture.writeGate;
      fixture.raw = args.value;
      return;
    }
    throw Error(`Unexpected command: ${command}`);
  };
  dom.window.addEventListener('hanni:recurring-changed', () => { fixture.changes++; });
  const dispose = mountCalendarRecurring(host, { invoke, library, showCompleted: true, now: () => clock });
  t.after(() => { dispose(); dom.window.close(); });
  await settle();
  return { fixture, dom, document, host, dispose,
    read: () => JSON.parse(fixture.raw),
    rollover: async () => { clock = new Date(`${tomorrow}T00:00:00`); tick(); await settle(); },
    openRule: () => {
      const selector = library ? `[data-library-details="${daily.id}"]` : `[data-recurring-id="${daily.id}"] [data-recurring-details]`;
      host.querySelector(selector).click();
      const dialog = document.querySelector('dialog[open]');
      assert.ok(dialog);
      return dialog;
    },
    markCheck: () => host.querySelector(library ? `[data-library-mark="${check.id}"]` : `[data-recurring-id="${check.id}"] [data-recurring-status]`).click(),
  };
}

for (const library of [false, true]) {
  const surface = library ? 'library' : 'daily list';

  test(`${surface}: rule details mark the opening day after date navigation`, async t => {
    const app = await setup(t, library), before = app.read(), dialog = app.openRule();
    app.dispose.setDate(yesterday);
    assert.equal(app.fixture.writes, 0, 'opening and navigating never writes a mark');
    dialog.querySelector('[data-detail-status="kept"]').click();
    await settle();
    assert.equal(app.read().days[today]?.[daily.id]?.status, 'kept');
    assert.deepEqual(app.read().days[yesterday], before.days[yesterday]);
    assert.equal(dialog.isConnected, false, 'a successful explicit mark closes details');
    assert.equal(app.fixture.writes, 1);
  });

  test(`${surface}: rule details opened before midnight retain their day`, async t => {
    const app = await setup(t, library), dialog = app.openRule();
    await app.rollover();
    assert.equal(app.fixture.writes, 0, 'midnight refresh never writes a mark');
    dialog.querySelector('[data-detail-status="broken"]').click();
    await settle();
    assert.equal(app.read().days[today]?.[daily.id]?.status, 'broken');
    assert.equal(app.read().days[tomorrow], undefined);
    assert.equal(dialog.isConnected, false);
  });

  test(`${surface}: cancelling a historical mark keeps its saved snapshot`, async t => {
    const app = await setup(t, library);
    app.dispose.setDate(yesterday);
    const dialog = app.openRule();
    app.dispose.setDate(today);
    dialog.querySelector('[data-detail-status="pending"]').click();
    await settle();
    const record = app.read().days[yesterday][daily.id];
    assert.equal(record.status, 'pending');
    assert.deepEqual(record.snapshot, oldSnapshot);
    assert.equal(app.read().days[today], undefined);
    assert.deepEqual(app.read().plans, [daily, check]);
  });

  test(`${surface}: a failed rule save stays open and retries the opening day`, async t => {
    const app = await setup(t, library), before = app.fixture.raw, dialog = app.openRule();
    const button = dialog.querySelector('[data-detail-status="kept"]');
    app.fixture.failWrites = 1;
    button.click();
    await settle();
    assert.equal(app.fixture.raw, before, 'failed save does not alter persisted records');
    assert.equal(dialog.open, true, 'failed save leaves details open for retry');
    assert.equal(dialog.isConnected, true);
    assert.equal(app.fixture.changes, 0, 'failed save does not announce a change');
    assert.equal(dialog.querySelector('[data-dialog-error]').hidden, false);
    assert.match(dialog.querySelector('[data-dialog-error]').textContent, /Fictional save unavailable/);
    assert.equal(button.disabled, false);
    app.dispose.setDate(yesterday);
    button.click();
    await settle();
    assert.equal(app.read().days[today]?.[daily.id]?.status, 'kept');
    assert.deepEqual(app.read().days[yesterday], JSON.parse(before).days[yesterday]);
    assert.equal(dialog.isConnected, false);
    assert.equal(app.fixture.writes, 2);
    assert.equal(app.fixture.changes, 1);
    assert.equal(app.host.querySelector('[data-recurring-error]').hidden, true);
  });

  test(`${surface}: pending rule save blocks duplicate marks, editing and dismissal`, async t => {
    const app = await setup(t, library), before = app.fixture.raw, dialog = app.openRule();
    let release;
    app.fixture.writeGate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const button = dialog.querySelector('[data-detail-status="kept"]');
    button.click();
    await settle();
    assert.equal(dialog.querySelector('fieldset').disabled, true);
    assert.equal(dialog.querySelector('form').getAttribute('aria-busy'), 'true');
    assert.equal(app.fixture.writes, 1);
    button.click();
    dialog.querySelector('[data-detail-edit]').click();
    dialog.querySelector('[data-dialog-close]').click();
    dialog.dispatchEvent(new app.dom.window.Event('cancel', { cancelable: true }));
    await settle();
    assert.equal(app.fixture.writes, 1);
    assert.equal(app.fixture.raw, before, 'unacknowledged save leaves persisted records unchanged');
    assert.equal(app.document.querySelectorAll('dialog[open]').length, 1);
    assert.equal(dialog.open, true);
    release();
    await settle();
    assert.equal(app.read().days[today][daily.id].status, 'kept');
    assert.equal(app.fixture.changes, 1);
    assert.equal(dialog.isConnected, false);
  });

  test(`${surface}: direct check marks use the currently selected day`, async t => {
    const app = await setup(t, library);
    app.dispose.setDate(yesterday);
    assert.equal(app.fixture.writes, 0);
    app.markCheck();
    await settle();
    assert.equal(app.read().days[yesterday][check.id].status, 'done');
    app.dispose.setDate(today);
    app.markCheck();
    await settle();
    assert.equal(app.read().days[today][check.id].status, 'done');
    assert.equal(app.fixture.writes, 2);
    assert.equal(app.fixture.calls.includes('start_task_block'), false);
  });
}
