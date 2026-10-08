import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountTaskFilterTabs } from '../src/hanni/js/task-filter-tabs.js';
import { mountCalendarTasks } from '../src/hanni/js/calendar-tasks.js';
import { ALL_TASK_FILTERS, DEFAULT_TASK_FILTERS, taskFilters } from '../src/hanni/js/task-filter-views.js';

const flush = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};
const makeView = (id, title, filters = DEFAULT_TASK_FILTERS) => ({id, title, filters:{...filters}});
const collection = views => JSON.stringify({version:1,views});
function store(initial = null) {
  const db = {raw:initial, writes:0, reads:0, failWrites:0, failReads:0, loseAck:false, defer:false, release:null, commands:[]};
  db.invoke = async (command, args = {}) => {
    db.commands.push(command);
    if (command === 'get_ui_state') {
      db.reads++;
      if (db.failReads) { db.failReads--; throw Error('read failed'); }
      return db.raw;
    }
    if (command === 'set_ui_state') {
      if (db.defer) {
        db.defer = false;
        await new Promise(resolve => { db.release = resolve; });
      }
      if (db.failWrites) { db.failWrites--; throw Error('write failed'); }
      if (args.expectedValue !== (db.raw ?? '')) throw Error('mvp_sync_stale_ui_state');
      db.raw = args.value;
      db.writes++;
      if (db.loseAck) {
        db.loseAck = false;
        db.failReads++;
        throw Error('ack lost');
      }
      return null;
    }
    return [];
  };
  return db;
}
function mountTabs(db, state = {...DEFAULT_TASK_FILTERS}, language = 'ru') {
  const dom = new JSDOM(`<html lang="${language}"><main></main></html>`, {pretendToBeVisual:true});
  const host = dom.window.document.querySelector('main');
  const applied = [];
  const control = mountTaskFilterTabs(host, {
    invoke:db.invoke, state,
    onApply:filters => { Object.assign(state, filters); applied.push({...filters}); },
  });
  return {dom,host,state,applied,control,close:() => {control.dispose();dom.window.close();}};
}
const control = (host, name) => host.querySelector('[data-task-view-' + name + ']');
function nameInput(host, value) {
  const input = control(host, 'name');
  input.value = value;
  input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', {bubbles:true}));
}
function submit(host) {
  const form = host.querySelector('[data-task-view-editor]');
  form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit', {bubbles:true,cancelable:true}));
}

test('All and Active are permanent; saved tab appears after acknowledged write and survives remount', async t => {
  const db = store();
  const mounted = mountTabs(db);
  t.after(mounted.close);
  await flush();
  assert.equal(mounted.host.querySelectorAll('[data-task-view-tab]').length, 2);
  mounted.host.querySelector('[data-task-view-id="all"]').click();
  assert.equal(mounted.state.filter, 'all');
  assert.deepEqual(taskFilters(mounted.state), ALL_TASK_FILTERS);
  mounted.host.querySelector('[data-task-view-id="active"]').click();
  assert.equal(mounted.state.filter, 'active');

  mounted.state.search = 'важное';
  mounted.control.update();
  control(mounted.host, 'create').click();
  nameInput(mounted.host, 'Важное');
  db.defer = true;
  submit(mounted.host);
  await flush();
  assert.equal(mounted.host.querySelectorAll('[data-task-view-tab]').length, 2);
  assert.equal(control(mounted.host, 'save').disabled, true);
  assert.equal(db.writes, 0);
  db.release();
  await flush();
  assert.equal(db.writes, 1);
  const saved = JSON.parse(db.raw).views[0];
  assert.equal(saved.title, 'Важное');
  assert.equal(saved.filters.search, 'важное');
  assert.equal(mounted.host.querySelectorAll('[data-task-view-tab]').length, 3);
  assert.equal(mounted.host.querySelector('[data-task-view-id="' + saved.id + '"]').getAttribute('aria-pressed'), 'true');

  const remounted = mountTabs(db, mounted.state);
  t.after(remounted.close);
  await flush();
  assert.equal(remounted.host.querySelector('[data-task-view-id="' + saved.id + '"]').textContent, 'Важное');
  assert.equal([...remounted.host.querySelectorAll('[data-task-view-id]')].find(item => item.dataset.taskViewId === saved.id).getAttribute('aria-pressed'), 'true');
  remounted.host.querySelector('[data-task-view-id="' + saved.id + '"]').click();
  assert.equal(remounted.state.search, 'важное');
});

test('Cancel and Escape write nothing; failed save preserves title and captured filters', async t => {
  const db = store();
  const mounted = mountTabs(db);
  t.after(mounted.close);
  await flush();
  control(mounted.host, 'create').click();
  nameInput(mounted.host, 'Отменить');
  control(mounted.host, 'cancel').click();
  control(mounted.host, 'create').click();
  nameInput(mounted.host, 'Тоже отменить');
  control(mounted.host, 'name').dispatchEvent(new mounted.dom.window.KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
  assert.equal(db.writes, 0);
  assert.equal(mounted.host.querySelector('[data-task-view-editor]'), null);

  mounted.state.search = 'снимок';
  control(mounted.host, 'create').click();
  nameInput(mounted.host, 'Повторить');
  mounted.state.search = 'после открытия';
  db.failWrites = 1;
  submit(mounted.host);
  await flush();
  assert.equal(control(mounted.host, 'name').value, 'Повторить');
  assert.equal(db.writes, 0);
  assert.match(mounted.host.querySelector('.ct-view-tabs-status').textContent, /Не удалось сохранить/);
  submit(mounted.host);
  await flush();
  assert.equal(db.writes, 1);
  assert.equal(JSON.parse(db.raw).views[0].filters.search, 'снимок');
});

test('editing uses current filters, marks modifications, and deletion needs confirmation with retry', async t => {
  const db = store(collection([makeView('one', 'Первая')]));
  const mounted = mountTabs(db);
  t.after(mounted.close);
  await flush();
  mounted.host.querySelector('[data-task-view-id="one"]').click();
  mounted.state.search = 'новый поиск';
  mounted.control.update();
  assert.match(mounted.host.querySelector('[data-task-view-id="one"]').textContent, /изменено/);
  control(mounted.host, 'edit').click();
  nameInput(mounted.host, 'Новая');
  submit(mounted.host);
  await flush();
  assert.equal(JSON.parse(db.raw).views[0].title, 'Новая');
  assert.equal(JSON.parse(db.raw).views[0].filters.search, 'новый поиск');

  control(mounted.host, 'edit').click();
  control(mounted.host, 'remove').click();
  assert.match(mounted.host.querySelector('.ct-view-delete-confirmation').textContent, /Задачи останутся/);
  assert.equal(db.writes, 1);
  db.failWrites = 1;
  control(mounted.host, 'confirm-remove').click();
  await flush();
  assert.equal(JSON.parse(db.raw).views.length, 1);
  assert.ok(control(mounted.host, 'name'));
  control(mounted.host, 'confirm-remove').click();
  await flush();
  assert.equal(JSON.parse(db.raw).views.length, 0);
  assert.equal(mounted.host.querySelectorAll('[data-task-view-tab]').length, 2);
  assert.deepEqual(mounted.applied.at(-1).search, 'новый поиск');
});

test('same-view conflict preserves draft and blocks overwrite after explicit reload', async t => {
  const db = store(collection([makeView('one', 'Первый')]));
  const a = mountTabs(db), b = mountTabs(db);
  t.after(() => {a.close();b.close();});
  await flush();
  a.host.querySelector('[data-task-view-id="one"]').click();
  b.host.querySelector('[data-task-view-id="one"]').click();
  control(a.host, 'edit').click();
  nameInput(a.host, 'Черновик А');
  control(b.host, 'edit').click();
  nameInput(b.host, 'Версия Б');
  submit(b.host);
  await flush();
  submit(a.host);
  await flush();
  assert.match(a.host.querySelector('.ct-view-tabs-status').textContent, /другом окне/);
  assert.equal(control(a.host, 'name').value, 'Черновик А');
  assert.equal(control(a.host, 'save').disabled, true);
  control(a.host, 'reload').click();
  await flush();
  assert.equal(control(a.host, 'name').value, 'Черновик А');
  assert.equal(control(a.host, 'save').disabled, true);
  assert.equal(JSON.parse(db.raw).views[0].title, 'Версия Б');
  control(b.host, 'edit').click();
  nameInput(b.host, 'Первый');
  submit(b.host);
  await flush();
  control(a.host, 'reload').click();
  await flush();
  assert.equal(control(a.host, 'name').value, 'Черновик А');
  assert.equal(control(a.host, 'save').disabled, false);
  submit(a.host);
  await flush();
  assert.equal(JSON.parse(db.raw).views[0].title, 'Черновик А');
});

test('unrelated concurrent edit can be retried after reload without losing draft', async t => {
  const db = store(collection([makeView('one', 'Один'),makeView('two', 'Два')]));
  const a = mountTabs(db), b = mountTabs(db);
  t.after(() => {a.close();b.close();});
  await flush();
  a.host.querySelector('[data-task-view-id="one"]').click();
  b.host.querySelector('[data-task-view-id="two"]').click();
  control(a.host, 'edit').click();
  nameInput(a.host, 'Один новый');
  control(b.host, 'edit').click();
  nameInput(b.host, 'Два новых');
  submit(b.host);
  await flush();
  submit(a.host);
  await flush();
  control(a.host, 'reload').click();
  await flush();
  assert.equal(control(a.host, 'name').value, 'Один новый');
  assert.equal(control(a.host, 'save').disabled, false);
  submit(a.host);
  await flush();
  assert.deepEqual(JSON.parse(db.raw).views.map(view => view.title), ['Один новый','Два новых']);
});

test('lost acknowledgement reconciles exact new view on reload without duplicating it', async t => {
  const db = store();
  const mounted = mountTabs(db);
  t.after(mounted.close);
  await flush();
  control(mounted.host, 'create').click();
  nameInput(mounted.host, 'Единственная');
  db.loseAck = true;
  submit(mounted.host);
  await flush();
  assert.equal(db.writes, 1);
  assert.ok(control(mounted.host, 'name'));
  control(mounted.host, 'reload').click();
  await flush();
  assert.equal(mounted.host.querySelector('[data-task-view-editor]'), null);
  assert.equal(JSON.parse(db.raw).views.length, 1);
  assert.equal(db.writes, 1);
});

test('future saved format fails closed while permanent tabs remain usable', async t => {
  const db = store(JSON.stringify({version:2,views:[]}));
  const mounted = mountTabs(db);
  t.after(mounted.close);
  await flush();
  assert.equal(control(mounted.host, 'create').disabled, true);
  assert.equal(db.writes, 0);
  mounted.host.querySelector('[data-task-view-id="all"]').click();
  assert.equal(mounted.state.filter, 'all');
  assert.match(mounted.host.querySelector('.ct-view-tabs-status').textContent, /Обновить подборки/);
});

for (const language of ['ru','en']) test(`calendar ${language} All includes completed nonarchived records; missing saved references stay restrictive across refresh`, async t => {
  const orphanFilters = {...ALL_TASK_FILTERS, goal:'gone-goal',source:'gone-source',project:'gone-project',tag:'gone-tag'};
  const reviewFilters = {...DEFAULT_TASK_FILTERS,filter:'review'};
  const db = store(collection([makeView('orphan','Недоступные связи',orphanFilters),makeView('review','Приёмка',reviewFilters)]));
  let rows = [
    {source_type:'note',source_id:'run',title:'Работает',status_extra:'task',is_active:true,date:null},
    {source_type:'note',source_id:'registered',title:'Зарегистрирована',status_extra:'task',date:null},
    {source_type:'note',source_id:'done',title:'Завершена',status_extra:'task',completed:true,date:null},
    {source_type:'note',source_id:'archived',title:'Archived fixture',status_extra:'task',archived:true,date:null},
  ];
  let actions = 0;
  const dom = new JSDOM(`<html lang="${language}"><main></main></html>`, {pretendToBeVisual:true});
  const host = dom.window.document.querySelector('main');
  const state = {filter:'active',search:'',goal:'',sphere:'',page:0};
  const invoke = async (command,args) => {
    if (command === 'get_calendar_tasks') return rows;
    if (command === 'get_goals' || command === 'get_calendar_task_goals') return [];
    return db.invoke(command,args);
  };
  const dispose = mountCalendarTasks(host, {
    invoke,state,openTask:()=>{},editDate:()=>{},notifyChange:()=>{},
    executeAction:()=>{actions++;},
    readTaskObservations:async () => ({
      available:true,unboundCount:0,
      contexts:new Map([
        ['note:run',{sources:[{id:'native',label:'Cicada'}],projects:[],tags:[],observations:[],binding:{taskKey:'run'},reports:[{status:'running'}],review:null}],
        ['note:registered',{sources:[{id:'native',label:'Cicada'}],projects:[],tags:[],observations:[],binding:{taskKey:'registered'},reports:[],review:null}],
        ['note:done',{sources:[{id:'native',label:'Cicada'}],projects:[],tags:[],observations:[],reports:[],review:null}],
      ]),
    }),
  });
  t.after(() => {dispose();dom.window.close();});
  await flush();
  assert.equal(host.querySelector('[data-tasks-count]').textContent, '2');
  host.querySelector('[data-task-view-id="all"]').click();
  assert.equal(host.querySelector('[data-tasks-count]').textContent, '3');
  assert.equal(state.filter, 'all');
  assert.deepEqual(rows.map(row => row.source_id), ['run','registered','done','archived']);
  assert.equal(host.querySelector('[data-context-record="note:archived"]'), null);
  host.querySelector('[data-tasks-filter="ai-running"]').click();
  assert.equal(host.querySelector('[data-tasks-count]').textContent, '1');
  assert.match(host.querySelector('[data-tasks-list]').textContent, /Работает/);
  assert.doesNotMatch(host.querySelector('[data-tasks-list]').textContent, /Зарегистрирована/);

  host.querySelector('[data-task-view-id="orphan"]').click();
  assert.equal(host.querySelector('[data-tasks-count]').textContent, '0');
  assert.equal(state.goal, 'gone-goal');
  assert.equal(state.source, 'gone-source');
  assert.equal(state.project, 'gone-project');
  assert.equal(state.tag, 'gone-tag');
  rows = rows.map(row => ({...row,title:row.title + '!'}));
  dom.window.dispatchEvent(new dom.window.Event('hanni:calendar-refresh'));
  await flush();
  assert.equal(host.querySelector('[data-tasks-count]').textContent, '0');
  assert.equal(host.querySelector('[data-tasks-goal]').value, 'gone-goal');
  assert.match(host.querySelector('[data-tasks-goal]').selectedOptions[0].textContent, language==='en'?/Unavailable goal/:/Недоступная цель/);
  assert.match(host.querySelector('[data-tasks-applied]').textContent, language==='en'?/Unavailable goal/:/Недоступная цель/);
  for (const key of ['source','project','tag']) {
    assert.equal(host.querySelector('[data-tasks-observation="' + key + '"]').value, 'gone-' + key);
    assert.match(host.querySelector('[data-tasks-observation="' + key + '"]').selectedOptions[0].textContent, language==='en'?/Unavailable:/:/Недоступно:/);
  }
  host.querySelector('[data-task-view-id="review"]').click();
  assert.equal(state.filter, 'review');
  assert.equal(host.querySelector('[data-tasks-count]').textContent, '0');
  assert.match(host.querySelector('[data-tasks-observation-note]').textContent, language==='en'?/Review is unavailable/:/Приёмка недоступна/);
  assert.match(host.querySelector('[data-tasks-goal]').selectedOptions[0].textContent, language==='en'?/Any goal/:/Любая цель/);
  assert.equal(host.querySelector('[data-task-view-id="review"]').textContent, 'Приёмка');
  assert.equal(actions, 0);
  assert.equal(db.writes, 0);
});
test('overlong retained search blocks only saving, and tab redraw keeps keyboard focus', async t => {
  const db = store();
  const state = {...DEFAULT_TASK_FILTERS,search:'x'.repeat(300)};
  const mounted = mountTabs(db,state);
  t.after(mounted.close);
  await flush();
  control(mounted.host, 'create').click();
  assert.equal(mounted.host.querySelector('[data-task-view-editor]'), null);
  assert.match(mounted.host.querySelector('.ct-view-tabs-status').textContent, /Нельзя сохранить/);
  assert.equal(db.writes, 0);
  const all = mounted.host.querySelector('[data-task-view-id="all"]');
  all.focus();
  all.click();
  assert.equal(mounted.state.filter, 'all');
  assert.equal(mounted.dom.window.document.activeElement.dataset.taskViewId, 'all');
});

for (const language of ['ru','en']) test(`saved ${language} Review with a retained result stays empty without a review reader across remount; legacy transient Review falls back`, async t => {
  const reviewFilters = {...DEFAULT_TASK_FILTERS,filter:'review'};
  const db = store(collection([makeView('review', 'Приёмка', reviewFilters)]));
  const dom = new JSDOM(`<html lang="${language}"><main></main></html>`, {pretendToBeVisual:true});
  t.after(() => dom.window.close());
  const row = {source_type:'note',source_id:'one',title:'Обычная задача',status_extra:'task',date:null};
  const invoke = async (command,args) => {
    if (command === 'get_calendar_tasks') return [row];
    if (command === 'get_goals' || command === 'get_calendar_task_goals') return [];
    return db.invoke(command,args);
  };
  const dependencies = {
    invoke,openTask:()=>{},editDate:()=>{},notifyChange:()=>{},executeAction:()=>{},
    readTaskObservations:async () => ({
      available:true,unboundCount:0,
      contexts:new Map([['note:one',{sources:[],projects:[],tags:[],observations:[],reports:[],review:{taskId:'one',taskRevision:1,resultVersion:1,reviewState:'awaiting_review'}}]]),
    }),
  };
  const state = {filter:'active',search:'',goal:'',sphere:'',page:0};
  let host = dom.window.document.querySelector('main');
  const first = mountCalendarTasks(host,{...dependencies,state});
  await flush();
  host.querySelector('[data-task-view-id="review"]').click();
  assert.equal(state.filter, 'review');
  assert.equal(state.taskViewId, 'review');
  first();

  const secondHost = dom.window.document.createElement('main');
  host.replaceWith(secondHost);
  host = secondHost;
  const second = mountCalendarTasks(host,{...dependencies,state});
  await flush();
  assert.equal(state.filter, 'review');
  assert.equal(host.querySelector('[data-tasks-count]').textContent, '0');
  assert.equal(host.querySelector('[data-task-view-id="review"]').getAttribute('aria-pressed'), 'true');
  assert.match(host.querySelector('[data-tasks-observation-note]').textContent, language==='en'?/Review is unavailable/:/Приёмка недоступна/);
  second();

  const legacyHost = dom.window.document.createElement('main');
  host.replaceWith(legacyHost);
  const legacyState = {filter:'review',search:'',goal:'',sphere:'',page:0};
  const legacy = mountCalendarTasks(legacyHost,{...dependencies,state:legacyState});
  t.after(legacy);
  await flush();
  assert.equal(legacyState.filter, 'active');
  assert.equal(legacyHost.querySelector('[data-tasks-count]').textContent, '1');
  legacy();
  const builtinState = {filter:'review',taskViewId:'all',search:'',goal:'',sphere:'',page:0};
  const builtin = mountCalendarTasks(legacyHost,{...dependencies,state:builtinState});
  t.after(builtin);
  await flush();
  assert.equal(builtinState.filter, 'active');
  assert.equal(builtinState.taskViewId, 'active');
  assert.equal(legacyHost.querySelector('[data-task-view-id="active"]').getAttribute('aria-pressed'), 'true');
  assert.equal(legacyHost.querySelector('[data-tasks-count]').textContent, '1');
});


test('English view controls, save/edit/delete confirmation and modified state preserve authored names and filters', async t => {
  const authoredName = 'Мой выбор';
  const db = store(collection([makeView('authored', authoredName)]));
  const mounted = mountTabs(db, {...DEFAULT_TASK_FILTERS}, 'en-US');
  t.after(mounted.close);
  await flush();
  assert.equal(mounted.host.querySelector('[role="group"]').getAttribute('aria-label'), 'Task views');
  assert.deepEqual([...mounted.host.querySelectorAll('[data-task-view-tab]')].map(item=>item.textContent), ['All','Active',authoredName]);
  assert.deepEqual([...mounted.host.querySelectorAll('.ct-view-tabs-actions button')].map(item=>item.textContent), ['Save current filters','Edit view','Refresh views']);
  mounted.host.querySelector('[data-task-view-id="authored"]').click();
  mounted.state.search = 'мой поиск';
  mounted.control.update();
  assert.equal(mounted.host.querySelector('[data-task-view-id="authored"]').textContent, authoredName + ' · modified');
  control(mounted.host, 'edit').click();
  assert.match(mounted.host.querySelector('label').textContent, /^Edit view/);
  assert.equal(control(mounted.host, 'name').value, authoredName);
  assert.equal(control(mounted.host, 'save').textContent, 'Save');
  assert.equal(control(mounted.host, 'cancel').textContent, 'Cancel');
  assert.match(mounted.host.querySelector('.ct-view-editor-note').textContent, /filters selected when this form opened/);
  submit(mounted.host);
  await flush();
  assert.equal(JSON.parse(db.raw).views[0].title, authoredName);
  assert.equal(JSON.parse(db.raw).views[0].filters.search, 'мой поиск');
  control(mounted.host, 'edit').click();
  control(mounted.host, 'remove').click();
  assert.equal(mounted.host.querySelector('.ct-view-delete-confirmation').textContent, `Delete the view “${authoredName}”? Tasks will remain.`);
  assert.equal(control(mounted.host, 'confirm-remove').textContent, 'Confirm deletion');
  assert.equal(control(mounted.host, 'keep').textContent, 'Keep view');
  control(mounted.host, 'keep').click();
  assert.equal(db.writes, 1);
  control(mounted.host, 'remove').click();
  control(mounted.host, 'confirm-remove').click();
  await flush();
  assert.equal(db.writes, 2);
  assert.deepEqual(JSON.parse(db.raw).views, []);
});

test('English validation, failed save and concurrent edit keep drafts and display localized recovery', async t => {
  const invalid = mountTabs(store(), {...DEFAULT_TASK_FILTERS, search:'s'.repeat(300)}, 'en');
  t.after(invalid.close);
  await flush();
  control(invalid.host, 'create').click();
  assert.equal(invalid.host.querySelector('.ct-view-tabs-status').textContent, 'Cannot save the current filters: The “search” filter is too long.');
  assert.equal(invalid.host.querySelector('[data-task-view-editor]'), null);
  const db = store(collection([makeView('editable','Сохранённое имя')]));
  const mounted = mountTabs(db, {...DEFAULT_TASK_FILTERS}, 'en');
  t.after(mounted.close);
  await flush();
  mounted.host.querySelector('[data-task-view-id="editable"]').click();
  control(mounted.host, 'edit').click();
  nameInput(mounted.host, ' ');
  submit(mounted.host);
  assert.equal(mounted.host.querySelector('.ct-view-tabs-status').textContent, 'Enter a name of up to 80 characters.');
  nameInput(mounted.host, 'Черновик');
  db.failWrites = 1;
  submit(mounted.host);
  await flush();
  assert.equal(mounted.host.querySelector('.ct-view-tabs-status').textContent, 'Could not save the view: Could not save the task views. Your draft is preserved on screen.');
  assert.equal(control(mounted.host, 'name').value, 'Черновик');
  db.raw = collection([makeView('editable','Changed elsewhere')]);
  submit(mounted.host);
  await flush();
  assert.equal(mounted.host.querySelector('.ct-view-tabs-status').textContent, 'Views changed in another window. Click Refresh views; your draft will stay open.');
  assert.equal(control(mounted.host, 'name').value, 'Черновик');
  assert.equal(control(mounted.host, 'save').disabled, true);
  control(mounted.host, 'reload').click();
  await flush();
  assert.equal(mounted.host.querySelector('.ct-view-tabs-status').textContent, 'This view changed or was deleted. Cancel the edit and reopen it.');
  assert.equal(control(mounted.host, 'save').disabled, true);
  assert.equal(db.writes, 0);
});

test('English read failures and unsupported stored formats keep permanent tabs usable and disable saving', async t => {
  for (const [raw, failure, detail] of [
    [null, 1, 'Could not load the saved task views.'],
    ['{', 0, 'Could not read the saved task views.'],
    [JSON.stringify({version:2,views:[]}), 0, 'The saved task view format is unsupported.'],
  ]) {
    const db = store(raw);
    db.failReads = failure;
    const mounted = mountTabs(db, {...DEFAULT_TASK_FILTERS}, 'en');
    t.after(mounted.close);
    await flush();
    assert.equal(mounted.host.querySelector('.ct-view-tabs-status').textContent, `Could not load views: ${detail} Click Refresh views.`);
    assert.equal(control(mounted.host, 'create').disabled, true);
    mounted.host.querySelector('[data-task-view-id="all"]').click();
    assert.equal(mounted.state.filter, 'all');
    assert.equal(db.writes, 0);
  }
});


for (const language of ['ru','en']) for (const ancestor of [false,true])
test(`saved ${language} missing ${ancestor?'ancestor':'direct'} goal alone fails closed with a retained task link and recovers when restored`, async t => {
  const filters = {...ALL_TASK_FILTERS,goal:'missing-goal'};
  const db = store(collection([makeView('goal-view','Авторское имя',filters)]));
  let goals = ancestor?[{id:'child',title:'Дочерняя цель',parent_goal_id:'missing-goal'}]:[];
  let row = {source_type:'note',source_id:'orphan-linked',title:'Задача со старой связью',status_extra:'task',date:null};
  const links = [{source_type:'note',source_id:row.source_id,goal_id:ancestor?'child':'missing-goal'}];
  const dom = new JSDOM(`<html lang="${language}"><main></main></html>`,{pretendToBeVisual:true});
  const host = dom.window.document.querySelector('main');
  const state = {...DEFAULT_TASK_FILTERS};
  const invoke = async (command,args) => {
    if(command==='get_calendar_tasks')return [row];
    if(command==='get_goals')return goals;
    if(command==='get_calendar_task_goals')return links;
    return db.invoke(command,args);
  };
  const dispose = mountCalendarTasks(host,{
    invoke,state,openTask:()=>{},editDate:()=>{},notifyChange:()=>{},executeAction:()=>{throw Error('No task mutation expected');},
    readTaskObservations:async()=>({available:true,unboundCount:0,contexts:new Map([['note:orphan-linked',{sources:[],projects:[],tags:[],observations:[],reports:[],review:null}]])}),
  });
  t.after(()=>{dispose();dom.window.close();});
  await flush();
  host.querySelector('[data-task-view-id="goal-view"]').click();
  assert.equal(host.querySelector('[data-tasks-count]').textContent,'0');
  assert.equal(state.goal,'missing-goal');
  assert.equal(state.source,'');assert.equal(state.project,'');assert.equal(state.tag,'');
  assert.match(host.querySelector('[data-tasks-goal]').selectedOptions[0].textContent,language==='en'?/Unavailable goal: missing-goal/:/Недоступная цель: missing-goal/);
  row={...row,title:row.title+'!'};
  dom.window.dispatchEvent(new dom.window.Event('hanni:calendar-refresh'));
  await flush();
  assert.equal(host.querySelector('[data-tasks-count]').textContent,'0');
  assert.equal(state.goal,'missing-goal');
  goals=[{id:'missing-goal',title:'Вернувшаяся цель',parent_goal_id:null},...goals];
  dom.window.dispatchEvent(new dom.window.Event('hanni:calendar-refresh'));
  await flush();
  assert.equal(host.querySelector('[data-tasks-count]').textContent,'1');
  assert.equal(host.querySelector('[data-context-record]').dataset.contextRecord,'note:orphan-linked');
  assert.equal(host.querySelector('[data-tasks-goal]').selectedOptions[0].textContent,'Вернувшаяся цель');
  assert.equal(host.querySelector('[data-task-view-id="goal-view"]').textContent,'Авторское имя');
  assert.equal(state.goal,'missing-goal');
  assert.equal(db.writes,0);
});

for (const language of ['ru','en']) test(`delete confirmation focuses safe choice, Keep and Escape restore Remove, then Escape closes editor (${language})`, async t => {
  const db = store(collection([makeView('one', 'Фокус')]));
  const mounted = mountTabs(db, {...DEFAULT_TASK_FILTERS}, language);
  t.after(mounted.close);
  await flush();
  mounted.host.querySelector('[data-task-view-id="one"]').click();
  const doc = mounted.dom.window.document;
  control(mounted.host, 'edit').focus();
  control(mounted.host, 'edit').click();
  assert.equal(doc.activeElement, control(mounted.host, 'name'));

  control(mounted.host, 'remove').focus();
  control(mounted.host, 'remove').click();
  assert.equal(doc.activeElement, control(mounted.host, 'keep'));
  control(mounted.host, 'keep').click();
  assert.equal(doc.activeElement, control(mounted.host, 'remove'));
  control(mounted.host, 'remove').click();
  assert.equal(doc.activeElement, control(mounted.host, 'keep'));
  control(mounted.host, 'keep').dispatchEvent(new mounted.dom.window.KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
  assert.ok(control(mounted.host, 'name'));
  assert.equal(control(mounted.host, 'confirm-remove'), null);
  assert.equal(doc.activeElement, control(mounted.host, 'remove'));
  control(mounted.host, 'remove').dispatchEvent(new mounted.dom.window.KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
  assert.equal(mounted.host.querySelector('[data-task-view-editor]'), null);
  assert.equal(doc.activeElement, control(mounted.host, 'edit'));

  control(mounted.host, 'edit').click();
  assert.equal(doc.activeElement, control(mounted.host, 'name'));
  assert.equal(db.writes, 0);
});

for (const language of ['ru','en']) test(`stale edit Cancel returns to enabled Reload control (${language})`, async t => {
  const db = store(collection([makeView('one', 'Исходная')]));
  const mounted = mountTabs(db, {...DEFAULT_TASK_FILTERS}, language);
  t.after(mounted.close);
  await flush();
  mounted.host.querySelector('[data-task-view-id="one"]').click();
  control(mounted.host, 'edit').click();
  nameInput(mounted.host, 'Черновик');
  db.raw = collection([makeView('one', 'Из другого окна')]);
  submit(mounted.host);
  await flush();
  assert.equal(control(mounted.host, 'edit').disabled, true);
  control(mounted.host, 'cancel').click();
  assert.equal(mounted.dom.window.document.activeElement, control(mounted.host, 'reload'));
  assert.equal(control(mounted.host, 'reload').disabled, false);
  assert.equal(db.writes, 0);
});

for (const language of ['ru','en']) test(`pending delete, failed write and retry keep a safe focus and only remove view definition (${language})`, async t => {
  const db = store(collection([makeView('one', 'Удалить')]));
  const mounted = mountTabs(db, {...DEFAULT_TASK_FILTERS}, language);
  t.after(mounted.close);
  await flush();
  mounted.host.querySelector('[data-task-view-id="one"]').click();
  control(mounted.host, 'edit').click();
  control(mounted.host, 'remove').click();
  const doc = mounted.dom.window.document;
  db.defer = true;
  db.failWrites = 1;
  control(mounted.host, 'confirm-remove').focus();
  control(mounted.host, 'confirm-remove').click();
  await flush();
  const pendingFocus = doc.activeElement;
  const pendingText = pendingFocus.textContent;
  const pendingDisabled = control(mounted.host, 'confirm-remove').disabled && control(mounted.host, 'keep').disabled;
  db.release();
  await flush();
  assert.equal(pendingDisabled, true);
  assert.equal(pendingFocus, mounted.host.querySelector('.ct-view-tabs-status'));
  assert.equal(pendingText, language==='en'?'Deleting view…':'Удаляем подборку…');
  assert.equal(pendingFocus.textContent, language==='en'?'Could not save the view: Could not save the task views. Your draft is preserved on screen.':'Не удалось сохранить подборку: Не удалось сохранить виды задач. Черновик сохранён на экране.');
  assert.equal(doc.activeElement, control(mounted.host, 'keep'));
  assert.equal(JSON.parse(db.raw).views.length, 1);
  assert.equal(db.writes, 0);
  control(mounted.host, 'confirm-remove').focus();
  control(mounted.host, 'confirm-remove').click();
  await flush();
  assert.equal(JSON.parse(db.raw).views.length, 0);
  assert.equal(doc.activeElement, control(mounted.host, 'create'));
  assert.ok(db.commands.every(command => command === 'get_ui_state' || command === 'set_ui_state'));
});

for (const language of ['ru','en']) test(`redraw preserves focused editor control and input selection during view reload (${language})`, async t => {
  const db = store(collection([makeView('one', 'Повторить')]));
  const mounted = mountTabs(db, {...DEFAULT_TASK_FILTERS}, language);
  t.after(mounted.close);
  await flush();
  mounted.host.querySelector('[data-task-view-id="one"]').click();
  control(mounted.host, 'edit').click();
  const doc = mounted.dom.window.document;
  control(mounted.host, 'cancel').focus();
  control(mounted.host, 'reload').click();
  await flush();
  assert.equal(doc.activeElement, control(mounted.host, 'cancel'));
  const input = control(mounted.host, 'name');
  input.focus();
  input.setSelectionRange(1, 4);
  control(mounted.host, 'reload').click();
  await flush();
  assert.equal(doc.activeElement, control(mounted.host, 'name'));
  assert.deepEqual([control(mounted.host, 'name').selectionStart, control(mounted.host, 'name').selectionEnd], [1,4]);
  assert.equal(db.writes, 0);
});


for (const language of ['ru','en']) for (const operation of ['save','delete','reload'])
test(`pending ${operation} populates the live status before focus (${language})`, async t => {
  const db = store(collection([makeView('one','Синтетическое имя')]));
  const mounted = mountTabs(db, {...DEFAULT_TASK_FILTERS}, language);
  t.after(mounted.close);
  await flush();
  mounted.host.querySelector('[data-task-view-id="one"]').click();
  const doc = mounted.dom.window.document;
  const status = mounted.host.querySelector('.ct-view-tabs-status');
  const focusedMessages = [];
  const focusStatus = status.focus.bind(status);
  // Existing CSS hides an empty status. Inspect the message at the focus boundary;
  // JSDOM does not model display:none, so an empty target cannot receive focus here.
  status.focus = options => {
    focusedMessages.push(status.textContent);
    if (status.textContent) focusStatus(options);
  };
  if (operation === 'reload') {
    control(mounted.host,'reload').focus();
    control(mounted.host,'reload').click();
  } else {
    control(mounted.host,'edit').click();
    db.defer = true;
    if (operation === 'delete') {
      control(mounted.host,'remove').click();
      control(mounted.host,'confirm-remove').focus();
      control(mounted.host,'confirm-remove').click();
    } else {
      control(mounted.host,'save').focus();
      submit(mounted.host);
    }
  }
  const message = operation==='reload'
    ? (language==='en'?'Loading views…':'Загружаем подборки…')
    : operation==='delete'
      ? (language==='en'?'Deleting view…':'Удаляем подборку…')
      : (language==='en'?'Saving view…':'Сохраняем подборку…');
  assert.deepEqual(focusedMessages,[message]);
  assert.equal(doc.activeElement,status);
  assert.equal(status.textContent,message);
  if (operation !== 'reload') db.release();
  await flush();
  if (operation === 'reload') assert.equal(doc.activeElement,control(mounted.host,'reload'));
  assert.ok(db.commands.every(command=>command==='get_ui_state'||command==='set_ui_state'));
});
