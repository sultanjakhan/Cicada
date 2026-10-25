import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarTasks } from '../src/hanni/js/calendar-tasks.js';
import { nativeTaskStarted, readNativeTaskObservations } from '../src/hanni/js/native-task-observations.js';
import { TASK_RUN_KEY } from '../src/hanni/js/task-run-exchange.js';

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const row = (id, extra = {}) => ({ source_type:'note', source_id:id, title:id, status_extra:'task', date:null, ...extra });
const context = (extra = {}) => ({ sources:[], projects:[], tags:[], observations:[], reports:[], review:null, ...extra });
const review = (taskId, reviewState) => ({ taskId, taskRevision:2, resultVersion:1, reviewState, content:'Recorded result' });

test('execution membership requires recorded work; allocation, dates and manual plans do not count as a start', () => {
  for (const [task, observed] of [
    [row('running', {is_active:true}), context()],
    [row('paused-at-zero', {has_work:true,actual_seconds:0}), context()],
    [row('seconds', {actual_seconds:1}), context()],
    [row('minutes', {actual_minutes:1}), context()],
    [row('reported'), context({reports:[{status:'done'}]})],
    ...['running','awaiting_review','awaiting_dispatch'].map(state => [row(state), context({review:review(state,state)})]),
  ]) assert.equal(nativeTaskStarted(task, observed), true, task.source_id);

  for (const [task, observed] of [
    [row('idle'), context()],
    [row('scheduled', {date:'2026-10-25',process:'system-analysis',stage:'requirements'}), context()],
    [row('waiting-tag', {waiting:true}), context()],
    [row('allocated'), context({binding:{taskKey:'allocated'},latestRun:{runId:'allocated-run',report:null}})],
    [row('manual-progress'), context({workflow:{steps:[{id:'one',title:'Manual step',status:'running'}]}})],
  ]) assert.equal(nativeTaskStarted(task, observed), false, task.source_id);

  assert.equal(nativeTaskStarted(row('unknown-review'), context({reviewReadError:true})), null);
  assert.equal(nativeTaskStarted(row('unknown-execution'), context({executionReadError:true})), null);
  assert.equal(nativeTaskStarted(row('known-paused', {has_work:true}), context({executionReadError:true,reviewReadError:true})), true);
  assert.equal(nativeTaskStarted(row('known-report'), context({reports:[{status:'running'}],executionReadError:true})), true);
});

for (const language of ['ru','en']) test(`${language}: All, Active, Not started, Completed and Archive partition the visible native task states without writes`, async t => {
  const tasks = [
    row('idle'), row('allocated'), row('planned'), row('scheduled', {date:'2026-10-25',stage:'requirements'}), row('waiting-tag', {waiting:true}),
    row('running', {is_active:true}), row('paused-at-zero', {has_work:true,actual_seconds:0}), row('recorded-time', {actual_seconds:8}),
    row('ai-report'), row('review'), row('rework'), row('accepted'),
    row('unknown-review'), row('unknown-execution'), row('known-report-after-fault'),
    row('completed', {completed:true,has_work:true}), row('archived-open', {archived:true}), row('archived-completed', {archived:true,completed:true}),
  ];
  const contexts = new Map(tasks.map(task => [`note:${task.source_id}`, context()]));
  contexts.set('note:idle', context({projects:[{id:'project:Cicada',label:'Cicada'}],tags:['study']}));
  contexts.set('note:allocated', context({binding:{taskKey:'allocated'},latestRun:{runId:'allocated-run',report:null}}));
  contexts.set('note:planned', context({workflow:{steps:[{id:'one',title:'Manual step',status:'running'}]}}));
  contexts.set('note:ai-report', context({reports:[{status:'done'}]}));
  contexts.set('note:review', context({review:review('review','awaiting_review')}));
  contexts.set('note:rework', context({review:review('rework','awaiting_dispatch')}));
  contexts.set('note:accepted', context({review:review('accepted','accepted')}));
  contexts.set('note:unknown-review', context({reviewReadError:true}));
  contexts.set('note:unknown-execution', context({executionReadError:true}));
  contexts.set('note:known-report-after-fault', context({reports:[{status:'running'}],executionReadError:true}));
  const before = JSON.stringify(tasks), observedBefore = JSON.stringify([...contexts]);
  const dom = new JSDOM(`<html lang="${language}"><main></main></html>`, {pretendToBeVisual:true});
  const host = dom.window.document.querySelector('main'), writes = [], actions = [];
  const dispose = mountCalendarTasks(host, {
    invoke:async (command,args) => {
      if (command === 'get_calendar_tasks') return tasks;
      if (command.startsWith('get_')) return command === 'get_ui_state' ? null : [];
      writes.push([command,args]);
    },
    readTaskReview:async () => { throw Error('The supplied observations are authoritative in this fixture'); },
    readTaskObservations:async () => ({available:true,unboundCount:0,contexts}),
    openTask() {}, editDate() {}, notifyChange() {}, executeAction:async (...args) => actions.push(args),
  });
  t.after(() => { dispose(); dom.window.close(); });
  await settle();
  const ids = () => [...host.querySelectorAll('.ct-row')].map(item => item.dataset.contextRecord.replace('note:','')).sort();
  const filter = id => host.querySelector(`[data-tasks-filter="${id}"]`).click();
  const expectedOpen = ['idle','allocated','planned','scheduled','waiting-tag','running','paused-at-zero','recorded-time','ai-report','review','rework','unknown-review','unknown-execution','known-report-after-fault'].sort();
  assert.deepEqual(ids(), expectedOpen, 'the default All view includes unfinished tasks, including unknown reads');
  assert.deepEqual([...host.querySelectorAll('[data-task-view-tab]')].map(item => item.dataset.taskViewId), ['all','active','@completed','@archive']);
  const status = id => host.querySelector(`[data-context-record="note:${id}"] .ct-primary-meta .ct-status`).textContent;
  assert.equal(status('ai-report'), language === 'en' ? 'Execution started' : 'Выполнение начато');
  assert.equal(status('recorded-time'), language === 'en' ? 'Paused' : 'На паузе');
  assert.equal(status('unknown-execution'), language === 'en' ? 'Execution unknown' : 'Выполнение неизвестно');

  host.querySelector('[data-task-view-id="active"]').click();
  assert.deepEqual(ids(), ['running','paused-at-zero','recorded-time','ai-report','review','rework','known-report-after-fault'].sort());
  filter('not-started');
  assert.deepEqual(ids(), ['idle','allocated','planned','scheduled','waiting-tag'].sort());
  assert.match(host.querySelector('[data-tasks-observation-note]').textContent, language === 'en' ? /unknown.*All/ : /неизвестно.*Все/);
  filter('completed');
  assert.deepEqual(ids(), ['accepted','completed']);
  host.querySelector('[data-task-view-id="@archive"]').click();
  assert.deepEqual(ids(), ['archived-completed','archived-open']);

  host.querySelector('[data-task-view-id="all"]').click();
  const details = host.querySelector('.ct-filter-details'), summary = details.querySelector('summary');
  assert.equal(summary.textContent, language === 'en' ? 'Filters' : 'Фильтры');
  assert.equal(details.querySelector('[data-tasks-filter="not-started"]'), host.querySelector('[data-tasks-filter="not-started"]'));
  summary.focus(); summary.click();
  assert.equal(details.open, true);
  const project = details.querySelector('[data-tasks-observation="project"]');
  project.focus(); project.value = 'project:Cicada'; project.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(ids(), ['idle']);
  assert.equal(dom.window.document.activeElement, project);
  const tag = details.querySelector('[data-tasks-observation="tag"]');
  tag.value = 'study'; tag.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(ids(), ['idle'], 'project and tag constraints combine inside Filter');
  assert.equal(details.open, true);
  host.querySelector('[data-tasks-reset]').click();
  assert.deepEqual(ids(), expectedOpen);
  assert.deepEqual(writes, []); assert.deepEqual(actions, []);
  assert.equal(JSON.stringify(tasks), before); assert.equal(JSON.stringify([...contexts]), observedBefore);
});

test('a failed execution read keeps previously observed reports and leaves unobserved tasks unknown', async () => {
  const tasks = [row('known'), row('unobserved')];
  const previousContexts = new Map([['note:known', context({reports:[{status:'done',runId:'actual-prior-run'}]})]]);
  const commands = [];
  const observed = await readNativeTaskObservations(tasks, async (command,args) => {
    commands.push(command);
    if (command !== 'get_ui_state') throw Error(`Unexpected mutation ${command}`);
    if (args.key === TASK_RUN_KEY) throw Error('Execution read unavailable');
    return null;
  }, {previousContexts});
  assert.equal(nativeTaskStarted(tasks[0], observed.contexts.get('note:known')), true);
  assert.equal(nativeTaskStarted(tasks[1], observed.contexts.get('note:unobserved')), null);
  assert.deepEqual(observed.contexts.get('note:known').reports, previousContexts.get('note:known').reports);
  assert.equal(observed.contexts.get('note:known').executionReadError, true);
  assert.equal(commands.every(command => command === 'get_ui_state'), true);
});
