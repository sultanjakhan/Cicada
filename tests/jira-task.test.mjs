import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { openJiraTaskEditor } from '../src/hanni/js/jira-task.js';

const itemId = `jira:${'a'.repeat(64)}`;
const record = { source_type: 'note', source_id: itemId, title: 'Fictional local title' };
const state = extra => ({ title: 'Fictional Jira title', status: 'To Do', editable: true, changed: 0,
  transitions: [{ id: '31', name: 'Start work', status: 'In Progress' }], ...extra });
const settle = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(t, handler = () => state()) {
  const dom = new JSDOM('<button>opener</button>', { pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const calls = [], updates = [];
  window.addEventListener('hanni:jira-imported', () => updates.push('imported'));
  const dispose = openJiraTaskEditor(record, { document: window.document,
    invoke: async (command, args) => { calls.push({ command, args }); return handler(command, args); }, onChanged: () => updates.push('changed') });
  t.after(() => { dispose(); window.close(); });
  const q = name => window.document.querySelector(`[data-jira-${name}]`);
  const type = value => { q('title').value = value; q('title').dispatchEvent(new window.Event('input', { bubbles: true })); };
  const select = () => { q('transition').value = '31'; q('transition').dispatchEvent(new window.Event('change', { bubbles: true })); };
  return { dom, window, calls, updates, dispose, q, type, select };
}

test('opening reads Jira; selecting a transition and typing a title do not write', async t => {
  const x = fixture(t); await settle();
  assert.deepEqual(x.calls, [{ command: 'jira_task_details', args: { itemId } }]);
  assert.match(x.q('current').textContent, /Статус: To Do/);
  x.type('New title'); x.select();
  assert.equal(x.calls.length, 1);
  assert.equal(x.q('rename').disabled, false);
  assert.equal(x.q('move').disabled, false);
});

test('rename sends only the requested title and expected prior title; double click sends once', async t => {
  let finish;
  const x = fixture(t, command => command === 'jira_task_rename' ? new Promise(resolve => { finish = resolve; }) : state());
  await settle(); x.type('  New title  ');
  x.q('rename').click(); x.q('rename').click(); await settle();
  assert.deepEqual(x.calls[1], { command: 'jira_task_rename', args: { itemId, title: 'New title', expectedTitle: 'Fictional Jira title' } });
  assert.equal(x.calls.length, 2);
  x.window.document.querySelector('[data-dialog-close]').click(); await settle();
  assert.equal(x.window.document.querySelector('dialog').open, true, 'pending write cannot be silently detached by closing');
  finish(state({ title: 'New title', changed: 1 })); await settle();
  assert.equal(x.q('title').value, 'New title');
  assert.deepEqual(x.updates, ['changed', 'imported']);
});

test('a transition writes only on its own button and preserves an unsent title draft', async t => {
  const x = fixture(t, command => state(command === 'jira_task_transition' ? { status: 'In Progress', transitions: [] } : {}));
  await settle(); x.type('Unsent rename'); x.select(); x.q('move').click(); await settle();
  assert.deepEqual(x.calls[1], { command: 'jira_task_transition', args: { itemId, transitionId: '31', expectedStatus: 'To Do' } });
  assert.equal(x.q('title').value, 'Unsent rename');
  assert.match(x.q('current').textContent, /In Progress/);
  assert.equal(x.q('transition').disabled, true);
  assert.equal(x.calls.some(call => call.command === 'jira_task_rename'), false);
});

test('unknown write outcome locks mutation until a successful refresh; it never retries automatically', async t => {
  let failRead = false;
  const x = fixture(t, command => {
    if (command === 'jira_task_rename') throw 'jira_write_outcome_unknown';
    if (failRead) throw 'jira_network_unavailable';
    return state();
  });
  await settle(); x.type('Unconfirmed rename'); x.q('rename').click(); await settle();
  assert.equal(x.q('rename').disabled, true); assert.equal(x.q('move').disabled, true);
  assert.match(x.window.document.querySelector('[data-dialog-error]').textContent, /могла принять/);
  failRead = true; x.q('refresh').click(); await settle();
  assert.equal(x.q('rename').disabled, true);
  failRead = false; x.q('refresh').click(); await settle();
  assert.equal(x.q('rename').disabled, false);
  assert.equal(x.q('title').value, 'Unconfirmed rename');
  assert.equal(x.calls.filter(call => call.command === 'jira_task_rename').length, 1);
});

test('conflicts keep the draft and refresh updates the expected comparison before another explicit rename', async t => {
  let reads = 0, writes = 0;
  const x = fixture(t, command => {
    if (command === 'jira_task_details') return state({ title: ++reads === 1 ? 'Old' : 'Changed elsewhere' });
    if (++writes === 1) throw 'jira_task_conflict';
    return state({ title: 'My draft' });
  });
  await settle(); x.type('My draft'); x.q('rename').click(); await settle();
  assert.equal(x.q('rename').disabled, true);
  x.q('refresh').click(); await settle();
  assert.equal(x.q('title').value, 'My draft');
  assert.match(x.q('current').textContent, /Changed elsewhere/);
  x.q('rename').click(); await settle();
  assert.equal(x.calls.at(-1).args.expectedTitle, 'Changed elsewhere');
});

test('closing with a draft is blocked until the user resets it', async t => {
  const x = fixture(t); await settle(); x.type('Unsent');
  x.window.document.querySelector('[data-dialog-close]').click(); await settle();
  assert.equal(x.window.document.querySelector('dialog').open, true);
  assert.match(x.window.document.querySelector('[data-dialog-error]').textContent, /несохранённые/);
  x.q('reset').click(); x.window.document.querySelector('[data-dialog-close]').click(); await settle();
  assert.equal(x.window.document.querySelector('dialog'), null);
  assert.equal(x.calls.length, 1);
});

test('unknown backend errors never render response bodies; Jira text is plain text', async t => {
  const x = fixture(t, command => {
    if (command === 'jira_task_details') return state({ title: '<img src=x onerror=alert(1)>', status: '<b>Waiting</b>' });
    throw new Error('private server body and credential');
  });
  await settle();
  assert.equal(x.q('current').querySelector('img,b'), null);
  x.type('New title'); x.q('rename').click(); await settle();
  assert.doesNotMatch(x.window.document.body.textContent, /private server|credential/);
});

test('disposal suppresses a late read and does not trigger a refresh callback', async t => {
  let finish;
  const x = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  await settle(); x.dispose(); finish(state({ changed: 1 })); await settle();
  assert.equal(x.window.document.querySelector('dialog'), null);
  assert.deepEqual(x.updates, []);
});
