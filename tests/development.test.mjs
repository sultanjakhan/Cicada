import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url:'http://localhost/', pretendToBeVisual:true });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.localStorage = dom.window.localStorage;
globalThis.FormData = dom.window.FormData;
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value:{ randomUUID: () => 'test-id' } });
globalThis.marked = { Marked: class { use() {} parse(value) { return value; } } };
const { DEVELOPMENT_STATE_KEY, normalizeDevelopmentState, validateDevelopmentImport, attachDevelopmentTask, mountGoalDevelopment, mountGoalDevelopmentSummary } = await import('../src/hanni/js/calendar-development.js');

async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); }
function dialogPolyfill() { const p = dom.window.HTMLDialogElement.prototype; p.showModal = function () { this.open = true; }; p.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); }; }
dialogPolyfill();

test('normalization retains an active stage, its outcome and its scoped focus', () => {
  const state = normalizeDevelopmentState({ version:1, goals:{ g:{ skills:[{id:'sql',title:'JOIN',topic:'SQL',level:2,evidence:'query'}], stages:[{id:'s',title:'SQL sprint',outcome:'write query',deadline:'2026-10-10',skillIds:['sql'],focusId:'sql'}], activeStageId:'s',focusId:'sql' } } });
  assert.equal(state.goals.g.activeStageId, 's');
  assert.equal(state.goals.g.stages[0].outcome, 'write query');
  assert.equal(state.goals.g.stages[0].focusId, 'sql');
  const invalid = normalizeDevelopmentState({ version:1, goals:{ g:{ skills:[{id:'a',title:'A',topic:'T'}], stages:[{id:'s',title:'S',skillIds:['missing'],focusId:'missing'}], activeStageId:'s' } } });
  assert.deepEqual(invalid.goals.g.stages[0].skillIds, []);
  assert.equal(invalid.goals.g.stages[0].focusId, null);
  assert.equal(normalizeDevelopmentState({ version:1, goals:{ g:{ skills:[], stages:[{id:'bad',title:'Bad',deadline:'2026-02-31',skillIds:[]}] } } }).goals.g.stages.length, 0);
  assert.throws(() => normalizeDevelopmentState({ version:99, goals:{} }), /Неподдерживаемый/);
});

test('active stage limits the compact skill view and can return to the whole goal', async t => {
  const root = document.createElement('div'); document.body.append(root);
  let stored = JSON.stringify({ version:1, goals:{ g:{ skills:[{id:'a',title:'API',topic:'API'},{id:'b',title:'SQL',topic:'SQL'}], stages:[{id:'s',title:'API stage',skillIds:['a'],focusId:null}], activeStageId:'s',focusId:null } } });
  const invoke = async (command, args) => { if (command === 'get_ui_state') return stored; if (command === 'set_ui_state') { stored = args.value; return; } throw Error(command); };
  const controller = await mountGoalDevelopment(root, { invoke, goal:{ id:'g', title:'Goal' } });
  assert.equal(root.querySelectorAll('[data-dev-skill]').length, 1);
  assert.equal(root.querySelector('[data-dev-skill]').textContent, 'API');
  root.querySelector('[data-dev-stage-clear]').click(); await settle(); await settle();
  assert.equal(root.querySelectorAll('[data-dev-skill]').length, 2);
  assert.equal(root.querySelectorAll('details.dev-group, details.dev-topic').length, 0, 'stage selection is enough; skill text does not require nested disclosures');
  controller.dispose(); t.after(() => root.remove());
});

test('JSON import accepts generic skills and rejects malformed or empty input', () => {
  const imported = validateDevelopmentImport(JSON.stringify([{ id:'x', title:'Indexes', topic:'SQL', group:'soft', level:2, result:'Show index plan', exercise:'Compare query' }]));
  assert.equal(imported.goals.imported.skills[0].title, 'Indexes');
  assert.deepEqual({ group:imported.goals.imported.skills[0].group, description:imported.goals.imported.skills[0].description, practice:imported.goals.imported.skills[0].practice }, { group:'soft', description:'Show index plan', practice:'Compare query' });
  assert.equal(validateDevelopmentImport(JSON.stringify({ skills:[{ id:'a', title:'API error', topic:'API' }] })).goals.imported.skills.length, 1);
  assert.throws(() => validateDevelopmentImport('{'), /JSON/);
  assert.throws(() => validateDevelopmentImport(JSON.stringify({ version:1, goals:{} })), /нет корректных/);
});

test('task attachment is idempotent and never creates a task', async () => {
  let stored = JSON.stringify({ version:1, goals:{ g:{ skills:[{id:'sql',title:'JOIN',topic:'SQL'}], stages:[] } } }); let writes = 0;
  const invoke = async (command, args) => { if (command === 'get_ui_state') return stored; if (command === 'set_ui_state') { writes++; stored = args.value; return; } throw Error(command); };
  await attachDevelopmentTask('g', 'sql', 'task-1', { invoke });
  await attachDevelopmentTask('g', 'sql', 'task-1', { invoke });
  assert.deepEqual(JSON.parse(stored).goals.g.skills[0].taskIds, ['task-1']);
  assert.equal(writes, 1, 'second attach is safe to retry and does not create another relation write');
});

test('task attachment does not overwrite a remote skill change made after its read', async () => {
  const before=JSON.stringify({version:1,goals:{g:{skills:[{id:'s',title:'Skill',topic:'Topic'}],stages:[]}}});let stored=before;
  const remote=JSON.stringify({version:1,goals:{g:{skills:[{id:'s',title:'Remote skill',topic:'Topic'}],stages:[]}}});
  const invoke=async(command,args)=>{if(command==='get_ui_state')return stored;assert.equal(args.expectedValue,before);stored=remote;throw Error('mvp_sync_stale_ui_state');};
  await assert.rejects(attachDevelopmentTask('g','s','task-a',{invoke}),/mvp_sync_stale_ui_state/);assert.equal(stored,remote);
});

for (const kind of ['skill','evidence','stage']) test(`open ${kind} editor preserves its draft and rejects a newer remote version of that record`, async t => {
  const host=document.createElement('div');document.body.append(host);
  const original={version:1,goals:{g:{skills:[{id:'a',title:'Skill A',topic:'Topic',evidence:''}],stages:[{id:'s',title:'Stage',skillIds:['a']}],activeStageId:'s'}}};let stored=JSON.stringify(original),writes=0;
  const invoke=async(command,args)=>{if(command==='get_ui_state')return stored;if(command==='set_ui_state'){writes++;stored=args.value;return;}throw Error(command);};
  const controller=await mountGoalDevelopment(host,{invoke,goal:{id:'g',title:'Goal'}});t.after(()=>{controller.dispose();host.remove();});
  host.querySelector(kind==='skill'?'[data-dev-skill="a"]':kind==='evidence'?'[data-dev-evidence="a"]':'[data-dev-stage="s"]').click();await settle();
  const modal=document.querySelector('dialog[open]'),field=modal.querySelector(kind==='evidence'?'[name=evidence]':'[name=title]');field.value='Unsaved local draft';
  const remote=structuredClone(original);if(kind==='stage')remote.goals.g.stages[0].title='Remote stage';else remote.goals.g.skills[0].title='Remote skill';stored=JSON.stringify(remote);const remoteRaw=stored;
  modal.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
  assert.equal(modal.open,true);assert.equal(field.value,'Unsaved local draft');assert.match(modal.querySelector('[data-dialog-error]').textContent,/другом устройстве/);assert.equal(stored,remoteRaw);assert.equal(writes,0);
});

test('editing one skill merges an independent remote skill change in the same goal', async t => {
  const host=document.createElement('div');document.body.append(host);
  const original={version:1,goals:{g:{skills:[{id:'a',title:'Skill A',topic:'Topic'},{id:'b',title:'Skill B',topic:'Topic'}],stages:[]}}};let stored=JSON.stringify(original),writes=0;
  const invoke=async(command,args)=>{if(command==='get_ui_state')return stored;if(command==='set_ui_state'){assert.equal(args.expectedValue,stored);writes++;stored=args.value;return;}throw Error(command);};
  const controller=await mountGoalDevelopment(host,{invoke,goal:{id:'g',title:'Goal'}});t.after(()=>{controller.dispose();host.remove();});
  host.querySelector('[data-dev-skill="a"]').click();await settle();const modal=document.querySelector('dialog[open]');modal.querySelector('[name=title]').value='Local A';
  original.goals.g.skills[1].title='Remote B';stored=JSON.stringify(original);modal.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
  assert.equal(modal.open,false);assert.equal(writes,1);assert.deepEqual(JSON.parse(stored).goals.g.skills.map(skill=>skill.title),['Local A','Remote B']);
});

test('summary shows whole-goal progress with scoped focus and keeps stage selection in goal details', async t => {
  const host=document.createElement('div');document.body.append(host);
  let stored=JSON.stringify({version:1,goals:{g:{skills:[{id:'sql',title:'JOIN',topic:'SQL',evidence:'checked'},{id:'api',title:'Contract',topic:'API'}],stages:[{id:'s',title:'SQL',skillIds:['sql'],focusId:'sql'}],activeStageId:'s',focusId:'api'}}}),writes=0;
  const invoke=async(command,args)=>{if(command==='get_ui_state')return stored;if(command==='set_ui_state'){stored=args.value;writes++;return;}throw Error(command);};
  let opened=null;
  const controller=await mountGoalDevelopmentSummary(host,{invoke,goalId:'g',onOpen:selection=>{opened=selection;}});t.after(()=>{controller.dispose();host.remove();});
  assert.equal(host.querySelector('[data-development-open]'),null);
  assert.match(host.querySelector('.focus-topic').textContent,/SQL/);
  assert.equal(host.querySelector('.stage-panel, .stage-entry, [data-summary-action=choose-stage]'),null);
  assert.match(host.textContent,/50%/,'whole goal is 1 of 2 even while the SQL stage is 1 of 1');
  assert.match(host.textContent,/навыков всей цели подтверждено/);
  host.querySelector('[data-summary-skill]').click();assert.deepEqual(opened,{goalId:'g',skillId:'sql'});
  host.querySelector('[data-summary-action=focus]').click();await settle();
  assert.equal(document.querySelectorAll('dialog[open]').length,1,'no goal-detail dialog behind the picker');
  document.querySelector('dialog [data-dev-topic=SQL]').click();await settle();
  document.querySelector('dialog footer [data-dialog-close]').click();await settle();assert.equal(writes,0);
  assert.equal(document.activeElement,host.querySelector('[data-summary-action=focus]'));
  const detail=document.createElement('div');document.body.append(detail);
  const goal=await mountGoalDevelopment(detail,{invoke,goal:{id:'g',title:'Goal'}});t.after(()=>{goal.dispose();detail.remove();});
  goal.openStagePicker();await settle();
  const dialog=document.querySelector('dialog[open]');dialog.querySelector('input[value=""]').checked=true;
  dialog.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
  assert.equal(JSON.parse(stored).goals.g.activeStageId,null);
  assert.match(host.textContent,/50%/);assert.match(host.querySelector('.focus-topic').textContent,/API/);
  assert.equal(writes,1);assert.equal(host.querySelector('.stage-entry'),null);
});

test('summary refreshes remote focus and whole-goal progress without writing or inventing an empty score', async t => {
  const host=document.createElement('div');document.body.append(host);
  let stored=JSON.stringify({version:1,goals:{g:{skills:[],stages:[]}}}),writes=0;
  const invoke=async(command)=>{if(command==='get_ui_state')return stored;writes++;throw Error(command);};
  const controller=await mountGoalDevelopmentSummary(host,{invoke,goalId:'g'});t.after(()=>{controller.dispose();host.remove();});
  assert.match(host.textContent,/Без оценки/);assert.doesNotMatch(host.textContent,/0%|Текущий этап/);
  stored=JSON.stringify({version:1,goals:{g:{skills:[{id:'a',title:'Skill A',topic:'SQL',evidence:'accepted'},{id:'b',title:'Skill B',topic:'API'}],stages:[{id:'s',title:'Stage',skillIds:['b'],focusId:'b'}],activeStageId:'s',focusId:'a'}}});
  window.dispatchEvent(new CustomEvent('hanni:calendar-refresh',{detail:{remoteSync:true,canCommit:()=>false}}));await settle();
  assert.match(host.textContent,/Без оценки/);
  window.dispatchEvent(new CustomEvent('hanni:calendar-refresh',{detail:{remoteSync:true,canCommit:()=>true}}));await settle();
  assert.match(host.querySelector('.focus-topic').textContent,/API/);assert.match(host.textContent,/50%/);
  assert.equal(writes,0);
});

test('changing focus from the summary preserves goal focus and linked tasks', async t => {
  const host=document.createElement('div');document.body.append(host);
  let stored=JSON.stringify({version:1,goals:{g:{skills:[{id:'a',title:'JOIN',topic:'SQL',taskIds:['task-a']},{id:'b',title:'GROUP BY',topic:'SQL',taskIds:['task-b']}],stages:[{id:'s',title:'SQL',skillIds:['a','b'],focusId:'a'}],activeStageId:'s',focusId:'a'}}}),writes=0;
  const invoke=async(command,args)=>{if(command==='get_ui_state')return stored;if(command==='set_ui_state'){stored=args.value;writes++;return;}throw Error(command);};
  const controller=await mountGoalDevelopmentSummary(host,{invoke,goalId:'g'});t.after(()=>{controller.dispose();host.remove();});
  host.querySelector('[data-summary-action=focus]').click();await settle();
  document.querySelector('dialog [data-dev-topic=SQL]').click();await settle();
  const input=document.querySelector('dialog input[value=b]');input.checked=true;input.dispatchEvent(new window.Event('change',{bubbles:true}));
  document.querySelector('dialog form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
  const saved=JSON.parse(stored).goals.g;
  assert.equal(saved.stages[0].focusId,'b');assert.equal(saved.focusId,'a');assert.equal(saved.activeStageId,'s');
  assert.deepEqual(saved.skills.map(skill=>skill.taskIds),[['task-a'],['task-b']]);
  assert.equal(writes,1);assert.match(host.querySelector('[data-summary-skill]').textContent,/GROUP BY/);
});

test('mount persists only after acknowledgement and summary refreshes from event', async t => {
  const root = document.createElement('div'), summary = document.createElement('div'); document.body.append(root, summary);
  const state = { version:1, goals:{ g:{ skills:[{id:'sql',title:'JOIN',topic:'SQL',level:2,evidence:''}], stages:[{id:'stage',title:'SQL',outcome:'Practice',deadline:'2026-10-10',skillIds:['sql'],focusId:null}], activeStageId:'stage',focusId:null } } };
  let stored = JSON.stringify(state), fail = true, task = null;
  const invoke = async (command, args) => {
    if (command === 'get_ui_state') return stored;
    if (command === 'set_ui_state') { if (fail) throw Error('offline'); stored = args.value; return; }
    throw Error(command);
  };
  const dev = await mountGoalDevelopment(root, { invoke, goal:{id:'g',title:'Goal'}, onCreateTask:value => { task = value; } });
  const sum = await mountGoalDevelopmentSummary(summary, { invoke, goalId:'g', onOpen:() => {} });
  assert.match(summary.textContent, /Выбери навык из текущего этапа/);
  root.querySelector('[data-dev-focus]').click(); await settle();
  assert.equal(document.querySelectorAll('dialog input[name="development-picker"]').length, 0);
  const pickerSearch = document.querySelector('dialog [data-dev-picker-search]'); pickerSearch.focus(); pickerSearch.value = 's'; pickerSearch.dispatchEvent(new dom.window.Event('input', { bubbles:true })); await settle();
  assert.equal(document.activeElement, document.querySelector('dialog [data-dev-picker-search]'));
  document.querySelector('dialog [data-dev-picker-search]').value = 'sq'; document.querySelector('dialog [data-dev-picker-search]').dispatchEvent(new dom.window.Event('input', { bubbles:true })); await settle();
  assert.equal(document.activeElement, document.querySelector('dialog [data-dev-picker-search]'));
  document.querySelector('dialog [data-dev-topic="SQL"]').click(); await settle();
  assert.equal(document.querySelectorAll('dialog input[name="development-picker"]').length, 1);
  document.querySelector('dialog').close();
  root.querySelector('[data-dev-stage-add]').click(); await settle();
  assert.equal(document.querySelectorAll('dialog input[name="development-picker"]').length, 0);
  document.querySelector('dialog').close();
  const matrixSearch = root.querySelector('[data-dev-skill-search]'); matrixSearch.focus(); matrixSearch.value = 's'; matrixSearch.dispatchEvent(new dom.window.Event('input', { bubbles:true })); await settle();
  assert.equal(document.activeElement, root.querySelector('[data-dev-skill-search]'));
  root.querySelector('[data-dev-skill-search]').value = 'sq'; root.querySelector('[data-dev-skill-search]').dispatchEvent(new dom.window.Event('input', { bubbles:true })); await settle();
  assert.equal(document.activeElement, root.querySelector('[data-dev-skill-search]'));
  root.querySelector('[data-dev-evidence="sql"]').click(); await settle();
  const textarea = document.querySelector('dialog textarea[name="evidence"]'); textarea.value = 'accepted query'; document.querySelector('dialog form').dispatchEvent(new dom.window.Event('submit', { bubbles:true, cancelable:true })); await settle(); await settle();
  assert.equal(JSON.parse(stored).goals.g.skills[0].evidence, '');
  assert.match(document.querySelector('dialog [data-dialog-error]').textContent, /offline/);
  document.querySelector('dialog')?.close(); fail = false; dev.dispose(); sum.dispose(); root.replaceChildren(); summary.replaceChildren();
  const dev2 = await mountGoalDevelopment(root, { invoke, goal:{id:'g',title:'Goal'}, onCreateTask:value => { task = value; } });
  const sum2 = await mountGoalDevelopmentSummary(summary, { invoke, goalId:'g', onOpen:() => {} });
  root.querySelector('[data-dev-evidence="sql"]').click(); await settle(); document.querySelector('dialog[open] textarea[name="evidence"]').value = 'accepted query'; document.querySelector('dialog[open] form').dispatchEvent(new dom.window.Event('submit', { bubbles:true, cancelable:true })); await settle(); await settle();
  assert.equal(JSON.parse(stored).goals.g.skills[0].evidence, 'accepted query');
  assert.match(summary.textContent, /100%/);
  root.querySelector('[data-dev-task="sql"]').click(); assert.deepEqual(task, { goalId:'g', skillId:'sql', skillTitle:'JOIN' });
  root.querySelector('[data-dev-remove="sql"]').click(); await settle(); document.querySelector('dialog[open] form').dispatchEvent(new dom.window.Event('submit', { bubbles:true, cancelable:true })); await settle();
  assert.equal(JSON.parse(stored).goals.g.skills.length, 0);
  assert.deepEqual(JSON.parse(stored).goals.g.stages[0].skillIds, []);
  assert.equal(JSON.parse(stored).goals.g.stages[0].focusId, null);
  dev2.dispose(); sum2.dispose(); t.after(() => { root.remove(); summary.remove(); });
});
