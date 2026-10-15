import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const windows = new Set();
function setup(lang = 'en') {
  const dom = new JSDOM('<main></main>', { url: 'http://cicada.local/', pretendToBeVisual: true });
  windows.add(dom.window); const { window } = dom; window.document.documentElement.lang = lang;
  Object.assign(globalThis, { window, document: window.document, CustomEvent: window.CustomEvent, FormData: window.FormData, localStorage: window.localStorage });
  globalThis.marked = { Marked: class { use() {} parse(value) { return value; } } };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  return { window, document: window.document, root: window.document.querySelector('main') };
}
setup();
const { mountGoalDevelopment, mountGoalGlance, validateDevelopmentImport } = await import('../src/hanni/js/calendar-development.js');
const { mountCalendarGoals, openCalendarGoalEditor, calendarGoalLinks } = await import('../src/hanni/js/calendar-goals.js');
const { mountCalendarNow } = await import('../src/hanni/js/calendar-now.js');
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
afterEach(() => { for (const window of windows) window.close(); windows.clear(); });
const sourceState = () => ({ version: 1, goals: { g: { skills: [{ id: 'skill', title: 'Подтвердить', topic: 'Тема', group: 'hard', description: 'Авторский результат', practice: 'Авторская практика', evidence: 'Авторское подтверждение', level: 2, taskIds: ['task'] }], stages: [{ id: 'stage', title: 'Завершить', outcome: 'Авторский этап', skillIds: ['skill'], focusId: 'skill', status: 'completed' }], activeStageId: 'stage' } } });
for (const lang of ['ru', 'en']) test(`${lang} goal development localizes dynamic status and preserves authored text`, async t => {
  const x = setup(lang); let stored = JSON.stringify(sourceState());
  const controller = await mountGoalDevelopment(x.root, { goal: { id: 'g', title: 'Цель', criteria: 'Мои критерии', deadline: '2027-01-02' }, invoke: async command => { assert.equal(command, 'get_ui_state'); return stored; }, getTasks: () => [{ source_type: 'note', source_id: 'task', title: 'Удалить', completed: true }] });
  t.after(() => controller.dispose());
  assert.equal(x.root.querySelector('[data-dev-skill]').textContent, 'Подтвердить');
  assert.equal(x.root.querySelector('[data-dev-task-link]').textContent, lang === 'en' ? 'Удалить · Completed' : 'Удалить · Выполнено');
  assert.match(x.root.querySelector('.dev-stage').textContent, lang === 'en' ? /Current · Completed.*Skills: 1 of 1 confirmed/ : /Текущий · Завершён.*Навыки: 1 из 1 подтверждено/);
  assert.match(x.root.querySelector('.dev-stage-completed').textContent, lang === 'en' ? /Current stage “Завершить” is completed/ : /Текущий этап «Завершить» завершён/);
  assert.ok(x.root.textContent.includes('Авторская практика'));
  x.root.querySelector('[data-dev-skill]').click();
  const dialog = x.document.querySelector('dialog[open]');
  assert.deepEqual([...dialog.querySelector('[name=group]').options].map(option => option.value), ['hard', 'soft']);
  assert.equal(dialog.querySelector('[name=title]').value, 'Подтвердить');
  assert.equal(dialog.querySelector('[name=topic]').value, 'Тема');
  assert.equal(dialog.querySelector('[name=level]').options[1].textContent, lang === 'en' ? 'Level 2' : 'Уровень 2');
  assert.equal(dialog.querySelector('[name=description]').value, 'Авторский результат');
  assert.equal(stored, JSON.stringify(sourceState()), 'rendering and opening an editor never writes data');
});
test('EN development save failure keeps draft, enum values, and native state intact', async t => {
  const x = setup(); let stored = JSON.stringify(sourceState()), calls = 0;
  const controller = await mountGoalDevelopment(x.root, { goal: { id: 'g', title: 'Цель' }, invoke: async (command) => { if (command === 'get_ui_state') return stored; if (command === 'set_ui_state') { calls++; throw Error('mvp_sync_stale_ui_state'); } throw Error(command); } });
  t.after(() => controller.dispose()); x.root.querySelector('[data-dev-skill]').click();
  const dialog = x.document.querySelector('dialog[open]'); dialog.querySelector('[name=title]').value = 'Сохранить';
  dialog.querySelector('form').dispatchEvent(new x.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  assert.equal(calls, 1); assert.equal(dialog.open, true); assert.equal(dialog.querySelector('[name=title]').value, 'Сохранить');
  assert.match(dialog.textContent, /The goal changed on another device/); assert.match(x.root.querySelector('[role=alert]').textContent, /The goal changed on another device/);
  assert.equal(stored, JSON.stringify(sourceState()));
  assert.throws(() => validateDevelopmentImport('{'), /Could not read JSON/);
});
test('EN goal glance exposes translated progress with authored stage name', async t => {
  const x = setup(); const controller = await mountGoalGlance(x.root, { goal: { id: 'g', title: 'Цель' }, invoke: async () => JSON.stringify(sourceState()) });
  t.after(() => controller.dispose());
  assert.equal(x.root.querySelector('[data-glance-stage] .calendar-goal-glance__value').textContent, 'Завершить');
  assert.equal(x.root.querySelector('[role=progressbar]').getAttribute('aria-label'), '1 of 1 stage skills confirmed');
});
test('EN goal catalog counts and numeric summaries localize without changing title or unit', async t => {
  const x = setup(); const goal = { id: 'g', title: 'Сохранить', goal_kind: 'goal', numeric_progress: true, target_value: 10, current_value: 2, unit: 'задач', deadline: '2027-01-02', status: 'active' };
  const invoke = async (command, args) => command === 'get_goals' ? [goal] : command === 'get_calendar_task_goals' ? [{ goal_id: 'g', source_type: 'note', source_id: 'a' }] : command === 'get_active_block' ? null : command === 'get_ui_state' ? args.key === 'calendar_development_v1' ? JSON.stringify(sourceState()) : JSON.stringify({version:1, goalId:'g'}) : Promise.reject(Error(command));
  const controller = await mountCalendarGoals(x.root, { invoke }); t.after(() => controller());
  assert.equal(x.root.querySelector('.cp-goal-row__title').textContent, 'Сохранить');
  assert.match(x.root.textContent, /Long-term goals/); assert.match(x.root.textContent, /2 of 10 задач/); assert.match(x.root.textContent, /Stage: Завершить/);
  assert.equal(calendarGoalLinks([{ goal_id:'g', source_type:'note', source_id:'a' }], 'g'), '1 task');
  assert.equal(calendarGoalLinks([{ goal_id:'g', source_type:'note', source_id:'a' },{ goal_id:'g', source_type:'note', source_id:'b' }], 'g'), '2 tasks');
});
test('EN goal editor reports failed native save and retains original authored fields', async t => {
  const x = setup(); const editor = openCalendarGoalEditor({ document:x.document, goal:{ id:'g', title:'Удалить', goal_kind:'goal', description:'Заметка', criteria:'Подтвердить' }, invoke:async () => {throw Error('offline');} });
  t.after(() => editor.dispose());
  editor.form.dispatchEvent(new x.window.Event('submit', { bubbles:true,cancelable:true })); await tick();
  assert.match(editor.modal.textContent, /Could not save the goal/); assert.equal(editor.modal.open,true);
  assert.equal(editor.form.elements.title.value,'Удалить'); assert.equal(editor.form.elements.description.value,'Заметка'); assert.equal(editor.form.elements.criteria.value,'Подтвердить');
});
test('EN main goal detail localizes dynamic deadline and progress without translating content', async t => {
  const x = setup(); const goal={id:'g',title:'Цель',description:'Результат',criteria:'Подтвердить',status:'achieved',deadline:'2027-01-02',current_value:2,target_value:10,unit:'задач'};
  const invoke=async(command)=>{ if(command==='get_ui_state')return JSON.stringify({version:1,goalId:'g',selectionMode:'auto'});if(command==='get_goals')return[goal];if(['get_calendar_records','get_calendar_task_goals','get_active_blocks','get_timeline_blocks','get_task_pins'].includes(command))return[];if(['get_latest_task_block','get_active_block'].includes(command))return null;throw Error(command);};
  const controller=mountCalendarNow(x.root,{invoke,rankTasks:items=>items,loadWeights:async()=>({}),now:()=>new Date('2026-10-07T12:00:00')});t.after(()=>controller());await tick();
  assert.equal(x.root.querySelector('[data-ui=goal-title]').textContent,'Цель');assert.equal(x.root.querySelector('[data-ui=goal-status]').textContent,'Goal achieved');
  x.root.querySelector('[data-action=goal-details]').click();await tick();const dialog=x.document.querySelector('dialog[open]');
  assert.ok(dialog);assert.match(dialog.textContent,/Deadline:/);assert.match(dialog.textContent,/Tracked: 2 of 10 задач/);assert.ok(dialog.textContent.includes('Подтвердить'));assert.equal(dialog.querySelector('[data-goal-close]').getAttribute('aria-label'),'Close goal');
});
