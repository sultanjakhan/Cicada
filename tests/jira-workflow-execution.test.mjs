import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { startCalendarExecution, finishCalendarExecution, reviewCalendarExecution, pauseCalendarExecution } from '../src/hanni/js/calendar-execution.js';
import { chooseJiraWorkflowTransition } from '../src/hanni/js/jira-workflow-action.js';
import { mountCalendarContextMenu } from '../src/hanni/js/calendar-context-menu.js';

const itemId = `jira:${'a'.repeat(64)}`;
const task = { source_type: 'note', source_id: itemId, date: '2026-09-28', jira_status: 'Stale status' };
const current = { jira_status: 'Ready', jira_workflow_revision: 'scope-revision-1' };
const confirmed = { workflowOutcome: 'confirmed', status: 'Working', workflowRevision: 'scope-revision-1', transitions: [] };
const choices = { workflowOutcome: 'choose', title: '<b>Fictional task</b>', status: 'Ready', workflowRevision: 'scope-revision-2',
  transitions: [{ id: '31', name: 'Start implementation', status: 'Working' }, { id: '32', name: 'Start research', status: 'Research' }] };
function fixture(handler = () => confirmed, running = []) {
  const calls = [], blocks = running.map(row => ({ ...row }));
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'get_active_blocks') return blocks.filter(row => row.is_active !== false);
    if (command === 'get_calendar_task') return current;
    if (command === 'jira_task_workflow_action') return handler(args);
    if (command === 'start_task_block') { blocks.push({ id: 20, source_type: args.sourceType, source_id: args.sourceId }); return 20; }
    if (command === 'pause_task_block') { blocks.find(row => row.id === args.blockId).is_active = false; return; }
    if (command === 'complete_calendar_task') return;
    throw Error(command);
  };
  return { invoke, calls, blocks, commands: () => calls.map(row => row.command), writes: () => calls.filter(row => ['start_task_block', 'pause_task_block', 'complete_calendar_task'].includes(row.command)) };
}

test('Jira start uses fresh status/revision and starts time only after confirmation, keeping parallel work', async () => {
  const x = fixture(() => confirmed, [{ id: 1, source_type: 'note', source_id: 'personal' }]);
  assert.equal(await startCalendarExecution(x.invoke, task), 20);
  assert.deepEqual(x.commands(), ['get_active_blocks', 'get_calendar_task', 'jira_task_workflow_action', 'start_task_block']);
  assert.deepEqual(x.calls[2].args, { itemId, action: 'start', expectedStatus: 'Ready', expectedRevision: 'scope-revision-1', transitionId: null });
  assert.equal(x.blocks[0].is_active, undefined);
});

test('a running Jira task is adopted and remains pausable even when Jira cannot be reached', async () => {
  const x = fixture(() => { throw 'jira_network_unavailable'; }, [{ id: 7, source_type: 'note', source_id: itemId }]);
  assert.equal(await startCalendarExecution(x.invoke, task), 7);
  assert.equal(await pauseCalendarExecution(x.invoke, task), 1);
  assert.equal(x.commands().includes('get_calendar_task'), false);
  assert.equal(x.commands().includes('jira_task_workflow_action'), false);
});

for (const action of ['start', 'finish', 'review']) {
  test(`failed Jira ${action} preserves timers and local completion and is never retried`, async () => {
    const running = action === 'start' ? [] : [{ id: 7, source_type: 'note', source_id: itemId }];
    const x = fixture(() => { throw 'jira_write_outcome_unknown'; }, running);
    const run = { start: startCalendarExecution, finish: finishCalendarExecution, review: reviewCalendarExecution }[action];
    await assert.rejects(run(x.invoke, task), error => error.jiraWorkflow && error.refreshRequired && /могла принять/.test(error.message));
    assert.equal(x.calls.filter(row => row.command === 'jira_task_workflow_action').length, 1);
    assert.deepEqual(x.writes(), []);
  });
}

test('several Jira transitions wait for an explicit choice and use its updated status/revision', async () => {
  let choose, count = 0;
  const x = fixture(() => ++count === 1 ? choices : confirmed);
  const pending = startCalendarExecution(x.invoke, task, { chooseTransition: () => new Promise(resolve => { choose = resolve; }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 1); assert.deepEqual(x.writes(), []);
  choose('32'); assert.equal(await pending, 20);
  assert.deepEqual(x.calls.filter(row => row.command === 'jira_task_workflow_action')[1].args,
    { itemId, action: 'start', expectedStatus: 'Ready', expectedRevision: 'scope-revision-2', transitionId: '32' });
});

test('cancelled choice does not change Jira or timers and an unknown selection is refused', async () => {
  const x = fixture(() => choices);
  assert.equal(await startCalendarExecution(x.invoke, task, { chooseTransition: async () => null }), null);
  assert.equal(x.commands().filter(name => name === 'jira_task_workflow_action').length, 1);
  assert.deepEqual(x.writes(), []);
  await assert.rejects(startCalendarExecution(x.invoke, task, { chooseTransition: async () => 'not-listed' }), /переход больше недоступен/);
  assert.deepEqual(x.writes(), []);
});

test('finish confirms Jira before pausing this task and completing locally', async () => {
  const x = fixture(() => ({ ...confirmed, status: 'Completed' }), [
    { id: 7, source_type: 'note', source_id: itemId }, { id: 8, source_type: 'note', source_id: 'personal' }]);
  assert.equal(await finishCalendarExecution(x.invoke, task), true);
  assert.deepEqual(x.commands(), ['get_active_blocks', 'get_calendar_task', 'jira_task_workflow_action', 'pause_task_block', 'complete_calendar_task']);
  assert.equal(x.calls[3].args.blockId, 7); assert.equal(x.blocks[1].is_active, undefined);
});

test('explicit review pauses its captured block and keeps local completion and stages unchanged', async () => {
  const x = fixture(() => confirmed, [{ id: 7, source_type: 'note', source_id: itemId }]);
  assert.equal(await reviewCalendarExecution(x.invoke, task), true);
  assert.deepEqual(x.writes().map(row => row.command), ['pause_task_block']);
  assert.equal(x.calls.find(row => row.command === 'jira_task_workflow_action').args.action, 'review');
});

test('a task restarted during the Jira request is not silently paused or completed', async () => {
  const x = fixture(() => {
    x.blocks[0].is_active = false;
    x.blocks.push({ id: 8, source_type: 'note', source_id: itemId });
    return confirmed;
  }, [{ id: 7, source_type: 'note', source_id: itemId }]);
  const invoke = async (command, args) => {
    if (command === 'complete_calendar_task' && x.blocks.some(row => row.is_active !== false)) throw 'task is active';
    return x.invoke(command, args);
  };
  await assert.rejects(finishCalendarExecution(invoke, task), /Завершение в Cicada не подтверждено/);
  assert.deepEqual(x.calls.filter(row => row.command === 'pause_task_block').map(row => row.args.blockId), [7]);
  assert.equal(x.blocks[1].is_active, undefined);
});

test('partial success reports Jira confirmation separately from a failed local timer command', async () => {
  for (const [run, localCommand] of [[startCalendarExecution, 'start_task_block'], [finishCalendarExecution, 'complete_calendar_task']]) {
    const x = fixture();
    const invoke = async (command, args) => { if (command === localCommand) throw new Error('private database details'); return x.invoke(command, args); };
    await assert.rejects(run(invoke, task), error => error.jiraWorkflow && error.refreshRequired && /подтверждён/.test(error.message) && !error.message.includes('private'));
    assert.equal(x.commands().filter(name => name === 'jira_task_workflow_action').length, 1);
  }
});

test('unexpected native errors never expose response bodies or authorize an automatic retry', async () => {
  const x = fixture(() => { throw new Error('private server body'); });
  await assert.rejects(startCalendarExecution(x.invoke, task), error => /могла принять/.test(error.message) && !error.message.includes('private'));
  assert.deepEqual(x.writes(), []);
});

test('transition picker renders plain text, requires a choice, and closes without choosing on cancel', async t => {
  const dom = new JSDOM('<button>open</button>', { pretendToBeVisual: true }); t.after(() => dom.window.close());
  const { document } = dom.window;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  const result = chooseJiraWorkflowTransition(choices, 'start', document);
  assert.equal(document.querySelector('dialog b'), null);
  assert.equal(document.querySelector('[type=submit]').disabled, true);
  document.querySelector('[data-dialog-close]').click(); assert.equal(await result, null);
  const selected = chooseJiraWorkflowTransition(choices, 'finish', document);
  const select = document.querySelector('select'); select.value = '31'; select.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.querySelector('[type=submit]').disabled, false);
  document.querySelector('[type=submit]').click(); assert.equal(await selected, '31');
});

test('context actions retain safe Jira feedback and refresh after dismissal without exposing other errors', async t => {
  const dom = new JSDOM('<main><div data-context-record="task"><button data-record-menu>Menu</button></div></main>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { document } = dom.window; let refresh = 0, safe = true;
  const dispose = mountCalendarContextMenu(document.querySelector('main'), {
    getRecord: () => ({ title: 'Fictional task' }),
    getActions: () => [{ id: 'review', label: 'Отправить на проверку', run: () => { throw safe
      ? Object.assign(new Error('Jira могла принять изменение.'), { jiraWorkflow: true, refreshRequired: true })
      : new Error('private server body'); } }],
    onActionError: error => { if (error.refreshRequired) refresh++; },
  });
  t.after(dispose);
  document.querySelector('[data-record-menu]').click(); document.querySelector('[data-menu-action]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(document.querySelector('[role=alert]').textContent, /могла принять/);
  assert.equal(refresh, 0, 'a row refresh must not dismiss the error before it can be read');
  dispose.close(); assert.equal(refresh, 1);
  safe = false; document.querySelector('[data-record-menu]').click(); document.querySelector('[data-menu-action]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(document.querySelector('[role=alert]').textContent, /private/);
});

test('the context menu does not intercept its pending Jira transition dialog', async t => {
  const dom = new JSDOM('<main><div data-context-record="task"><button data-record-menu>Menu</button></div></main>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  const dispose = mountCalendarContextMenu(document.querySelector('main'), {
    getRecord: () => ({ title: 'Fictional task' }),
    getActions: () => [{ id: 'review', label: 'Отправить на проверку', run: async () => {
      await chooseJiraWorkflowTransition(choices, 'review', document);
      throw Object.assign(new Error('Изменение не подтверждено Jira.'), { jiraWorkflow: true });
    } }],
  });
  t.after(dispose);
  document.querySelector('[data-record-menu]').click(); document.querySelector('[data-menu-action]').click();
  const select = document.querySelector('select');
  select.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
  const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); select.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, false, 'Escape belongs to the native dialog');
  assert.ok(document.querySelector('[role=menu]'));
  document.querySelector('[data-dialog-close]').click(); await new Promise(resolve => setImmediate(resolve));
  assert.match(document.querySelector('[role=alert]').textContent, /не подтверждено/);
});
