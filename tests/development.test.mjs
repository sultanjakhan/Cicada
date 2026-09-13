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
});

test('JSON import accepts generic skills and rejects malformed or empty input', () => {
  const imported = validateDevelopmentImport(JSON.stringify([{ id:'x', title:'Indexes', topic:'SQL', level:2 }]));
  assert.equal(imported.goals.imported.skills[0].title, 'Indexes');
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
  assert.match(summary.textContent, /SQL/);
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
  dev2.dispose(); sum2.dispose(); t.after(() => { root.remove(); summary.remove(); });
});
