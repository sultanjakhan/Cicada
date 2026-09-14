import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../src/hanni/js/health-view-refresh.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
let serial = 0;

async function setup(t) {
  const dom = new JSDOM('<div id="view-calendar" class="view active"><div id="calendar-inner-content">before</div></div>', {
    url: 'https://fixture.invalid', pretendToBeVisual: true,
  });
  const w = dom.window, doc = w.document;
  let visibility = 'visible', events = 0;
  Object.defineProperty(doc, 'visibilityState', { get: () => visibility });
  Object.assign(globalThis, { window: w, document: doc, CustomEvent: w.CustomEvent, MutationObserver: w.MutationObserver });
  globalThis.calendarRefreshFixture = { activeTab: 'calendar', activeSubTab: {} };
  const actual = source.replace("import { S } from './state.js';", 'const S = globalThis.calendarRefreshFixture;');
  const ui = await import('data:text/javascript;base64,' + Buffer.from(actual + '\n// instance ' + (++serial)).toString('base64'));
  w.addEventListener('hanni:calendar-refresh', () => events++);
  t.after(() => w.close());
  return {
    w, doc, ui, target: doc.querySelector('#calendar-inner-content'),
    get events() { return events; },
    hide(value) { visibility = value ? 'hidden' : 'visible'; doc.dispatchEvent(new w.Event('visibilitychange')); },
  };
}

test('local invalidations coalesce without replacing unchanged records', async t => {
  const x = await setup(t);
  x.ui.startHealthViewRefresh();
  x.ui.requestHealthViewRefresh();
  x.ui.requestHealthViewRefresh();
  await settle();
  assert.equal(x.events, 1);
  assert.equal(x.ui.mayCommitHealthView(x.target, 'rows-v1'), true);
  assert.equal(x.ui.mayCommitHealthView(x.target, 'rows-v1', true), false);
});

test('hidden view, open editor and pointer interaction defer the refresh', async t => {
  const x = await setup(t);
  x.ui.startHealthViewRefresh();
  x.hide(true);
  x.ui.requestHealthViewRefresh();
  await settle();
  assert.equal(x.events, 0);
  const editor = x.doc.createElement('dialog');
  editor.setAttribute('open', '');
  editor.innerHTML = '<input value="draft">';
  x.doc.body.append(editor);
  x.hide(false);
  editor.querySelector('input').focus();
  await settle();
  assert.equal(x.events, 0);
  editor.remove();
  x.doc.dispatchEvent(new x.w.Event('pointerdown'));
  await settle();
  assert.equal(x.events, 0);
  x.doc.dispatchEvent(new x.w.Event('pointerup'));
  await settle();
  assert.equal(x.events, 1);
});

test('a read finishing after editing began cannot replace the draft', async t => {
  const x = await setup(t);
  x.ui.startHealthViewRefresh();
  const old = x.ui.beginHealthViewRead(x.target);
  const latest = x.ui.beginHealthViewRead(x.target);
  assert.equal(old(), false);
  assert.equal(latest(), true);
  const input = x.doc.createElement('input');
  input.value = 'unsaved draft';
  x.target.append(input);
  input.focus();
  assert.equal(x.ui.mayCommitHealthView(x.target, 'new rows', true), false);
  assert.equal(input.value, 'unsaved draft');
  assert.ok(x.target.contains(input));
  input.remove();
  await settle();
  assert.equal(x.events, 1);
});

test('failed reads schedule one delayed retry', async t => {
  const x = await setup(t);
  x.ui.startHealthViewRefresh();
  const retries = [], actualTimeout = x.w.setTimeout.bind(x.w);
  x.w.setTimeout = (callback, delay) => delay === 15_000
    ? (retries.push(callback), retries.length)
    : actualTimeout(callback, delay);
  x.ui.retryHealthViewRefresh();
  x.ui.retryHealthViewRefresh();
  assert.equal(retries.length, 1);
  retries[0]();
  await settle();
  assert.equal(x.events, 1);
});

test('remote changes wait for the editor and provide a commit guard for late responses', async t => {
  const x = await setup(t); x.ui.startHealthViewRefresh();
  const events=[];x.w.addEventListener('task-state-changed',event=>events.push(event.detail));
  const modal=x.doc.createElement('dialog');modal.open=true;modal.innerHTML='<textarea>unsaved</textarea>';x.doc.body.append(modal);modal.querySelector('textarea').focus();
  x.ui.requestHealthViewRefresh({remote:true});await settle();assert.equal(events.length,0);assert.equal(modal.querySelector('textarea').value,'unsaved');
  modal.remove();await settle();assert.equal(events.length,1);assert.equal(events[0].remoteSync,true);assert.equal(events[0].canCommit(),true);
  x.doc.body.append(modal);assert.equal(events[0].canCommit(),false);modal.remove();await settle();assert.equal(events.length,2,'late unsafe commits requeue the remote refresh');
});
