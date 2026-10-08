import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { mountTaskFilterTabs } from '../src/hanni/js/task-filter-tabs.js';
import { DEFAULT_TASK_FILTERS } from '../src/hanni/js/task-filter-views.js';

const taskCss = readFileSync(new URL('../src/hanni/css/calendar-tasks.css', import.meta.url), 'utf8');
const settle = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};
const collection = views => JSON.stringify({version:1,views});
const saved = {id:'view-one',title:'Сохранённая',filters:{...DEFAULT_TASK_FILTERS}};
const button = (host,name) => host.querySelector('[data-task-view-' + name + ']');

function makeStore(raw = null) {
  const db = {raw,calls:[],readGate:null,writeGate:null};
  db.deferRead = () => {
    let release;
    db.readGate = new Promise(resolve => { release = resolve; });
    return release;
  };
  db.deferWrite = () => {
    let release;
    db.writeGate = new Promise(resolve => { release = resolve; });
    return release;
  };
  db.invoke = async (command,args = {}) => {
    db.calls.push(command);
    if (command === 'get_ui_state') {
      const gate = db.readGate;
      db.readGate = null;
      if (gate) await gate;
      return db.raw;
    }
    if (command === 'set_ui_state') {
      const gate = db.writeGate;
      db.writeGate = null;
      if (gate) await gate;
      if (args.expectedValue !== (db.raw ?? '')) throw Error('mvp_sync_stale_ui_state');
      db.raw = args.value;
      return null;
    }
    throw Error('Unexpected task mutation or read: ' + command);
  };
  return db;
}

function mountWithCss(db, {modelHiddenFocus = false} = {}) {
  const dom = new JSDOM('<main></main>', {pretendToBeVisual:true});
  const doc = dom.window.document;
  const style = doc.createElement('style');
  style.textContent = taskCss;
  doc.head.append(style);
  const host = doc.querySelector('main');
  const observations = [];
  const originalFocus = dom.window.HTMLElement.prototype.focus;
  dom.window.HTMLElement.prototype.focus = function (...args) {
    if (this.classList?.contains('ct-view-tabs-status')) {
      observations.push({
        connected:this.isConnected,
        text:this.textContent,
        empty:this.matches(':empty'),
        display:dom.window.getComputedStyle(this).display,
      });
    }
    // JSDOM focuses display:none nodes; this optional model enforces browser visibility.
    if (modelHiddenFocus && this.classList?.contains('ct-view-tabs-status')
      && dom.window.getComputedStyle(this).display === 'none') return;
    return originalFocus.apply(this,args);
  };
  const state = {...DEFAULT_TASK_FILTERS};
  const dispose = mountTaskFilterTabs(host, {
    invoke:db.invoke,state,
    onApply:filters => Object.assign(state,filters),
  });
  const status = host.querySelector('.ct-view-tabs-status');
  if (modelHiddenFocus) {
    // Model a browser blurring the focused live region when :empty hides it.
    const text = Object.getOwnPropertyDescriptor(dom.window.Node.prototype,'textContent');
    assert.ok(text?.get && text?.set);
    Object.defineProperty(status,'textContent',{
      configurable:true,
      get() { return text.get.call(this); },
      set(value) {
        text.set.call(this,value);
        if (doc.activeElement === this && dom.window.getComputedStyle(this).display === 'none') this.blur();
      },
    });
  }
  return {dom,doc,host,state,status,observations,db,
    close() { dispose.dispose(); dom.window.HTMLElement.prototype.focus = originalFocus; dom.window.close(); }};
}

function assertVisibleAtFocus(observation, pendingText) {
  const evidence = JSON.stringify(observation);
  assert.ok(observation,'status was focused during pending operation: ' + evidence);
  assert.equal(observation.connected,true,'status was connected when focus was attempted: ' + evidence);
  assert.match(observation.text,pendingText,'pending message existed before focus: ' + evidence);
  assert.equal(observation.empty,false,'status was not :empty at focus time: ' + evidence);
  assert.notEqual(observation.display,'none','actual task CSS did not hide status at focus time: ' + evidence);
}
function assertOnlyUiStateCalls(db) {
  assert.ok(db.calls.every(command => ['get_ui_state','set_ui_state'].includes(command)));
}

test('actual task CSS hides the settled empty status before a pending action', async t => {
  const db = makeStore();
  const view = mountWithCss(db);
  t.after(() => view.close());
  await settle();
  assert.equal(view.status.textContent,'');
  assert.equal(view.status.matches(':empty'),true);
  assert.equal(view.dom.window.getComputedStyle(view.status).display,'none');
  assertOnlyUiStateCalls(db);
});

test('pending delete exposes its message before focusing status, then returns to an enabled control', async t => {
  const db = makeStore(collection([saved]));
  const view = mountWithCss(db);
  t.after(() => view.close());
  await settle();
  assert.equal(view.dom.window.getComputedStyle(view.status).display,'none');
  view.host.querySelector('[data-task-view-id="view-one"]').click();
  button(view.host,'edit').click();
  button(view.host,'remove').click();
  button(view.host,'confirm-remove').focus();
  const release = db.deferWrite();
  button(view.host,'confirm-remove').click();
  const atFocus = view.observations.at(-1);
  release();
  await settle();
  assertVisibleAtFocus(atFocus,/Удаляем подборку/);
  assert.equal(JSON.parse(db.raw).views.length,0);
  assert.equal(view.doc.activeElement,button(view.host,'create'));
  assert.equal(button(view.host,'create').disabled,false);
  assertOnlyUiStateCalls(db);
});

for (const origin of ['title','save']) {
  test('pending save from focused ' + origin + ' exposes its message before focusing status', async t => {
    const db = makeStore();
    const view = mountWithCss(db);
    t.after(() => view.close());
    await settle();
    assert.equal(view.dom.window.getComputedStyle(view.status).display,'none');
    button(view.host,'create').click();
    const title = button(view.host,'name');
    title.value = 'Новая';
    title.dispatchEvent(new view.dom.window.Event('input',{bubbles:true}));
    const release = db.deferWrite();
    if (origin === 'title') {
      title.focus();
      view.host.querySelector('[data-task-view-editor]').dispatchEvent(
        new view.dom.window.Event('submit',{bubbles:true,cancelable:true}));
    } else {
      button(view.host,'save').focus();
      button(view.host,'save').click();
    }
    const atFocus = view.observations.at(-1);
    release();
    await settle();
    assertVisibleAtFocus(atFocus,/Сохраняем подборку/);
    const id = JSON.parse(db.raw).views[0].id;
    const selected = [...view.host.querySelectorAll('[data-task-view-id]')]
      .find(item => item.dataset.taskViewId === id);
    assert.equal(view.doc.activeElement,selected);
    assert.equal(selected.disabled,false);
    assertOnlyUiStateCalls(db);
  });
}

test('focused Reload exposes its message before focusing status, then restores Reload', async t => {
  const db = makeStore();
  const view = mountWithCss(db);
  t.after(() => view.close());
  await settle();
  assert.equal(view.dom.window.getComputedStyle(view.status).display,'none');
  button(view.host,'reload').focus();
  const release = db.deferRead();
  button(view.host,'reload').click();
  const atFocus = view.observations.at(-1);
  release();
  await settle();
  assertVisibleAtFocus(atFocus,/Загружаем подборки/);
  assert.equal(view.doc.activeElement,button(view.host,'reload'));
  assert.equal(button(view.host,'reload').disabled,false);
  assertOnlyUiStateCalls(db);
});

test('CSS visibility model restores focused Reload after loading status becomes hidden', async t => {
  const db = makeStore();
  const view = mountWithCss(db,{modelHiddenFocus:true});
  t.after(() => view.close());
  await settle();
  assert.equal(view.dom.window.getComputedStyle(view.status).display,'none');
  button(view.host,'reload').focus();
  const release = db.deferRead();
  button(view.host,'reload').click();
  const atFocus = view.observations.at(-1);
  const heldStatusFocus = view.doc.activeElement === view.status;
  release();
  await settle();
  assertVisibleAtFocus(atFocus,/Загружаем подборки/);
  assert.equal(heldStatusFocus,true,'visible loading status accepted focus');
  assert.equal(view.doc.activeElement,button(view.host,'reload'),
    'Reload regained focus even when status became :empty and blurred');
  assertOnlyUiStateCalls(db);
});

test('CSS visibility model leaves externally moved focus alone during deferred Reload', async t => {
  const db = makeStore();
  const view = mountWithCss(db,{modelHiddenFocus:true});
  t.after(() => view.close());
  await settle();
  const external = view.doc.createElement('button');
  external.textContent = 'Другой контроль';
  view.doc.body.append(external);
  button(view.host,'reload').focus();
  const release = db.deferRead();
  button(view.host,'reload').click();
  const atFocus = view.observations.at(-1);
  external.focus();
  assert.equal(view.doc.activeElement,external);
  release();
  await settle();
  assertVisibleAtFocus(atFocus,/Загружаем подборки/);
  assert.equal(view.doc.activeElement,external,'refresh did not steal later external focus');
  assertOnlyUiStateCalls(db);
});
