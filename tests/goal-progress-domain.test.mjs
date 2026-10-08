import test from 'node:test';
import assert from 'node:assert/strict';
import {
  goalGlance,
  goalNumericProgress,
  normalizeDevelopmentState,
  stageProgress,
} from '../src/hanni/js/calendar-development-state.js';

const goal = extra => ({ goal_kind: 'goal', target_value: 10, numeric_progress: true, ...extra });

test('null current is unknown, never fabricated as zero', () => {
  assert.equal(goalNumericProgress(goal({ current_value: null })), null);
});

test('omitted current is unknown', () => {
  assert.equal(goalNumericProgress(goal({})), null);
});

test('blank current is unknown', () => {
  assert.equal(goalNumericProgress(goal({ current_value: '' })), null);
});

test('whitespace current is unknown', () => {
  assert.equal(goalNumericProgress(goal({ current_value: '  \t' })), null);
});

test('invalid and nonfinite current values are rejected', () => {
  for (const current_value of ['not-a-number', Infinity, -Infinity, NaN]) {
    assert.equal(goalNumericProgress(goal({ current_value })), null);
  }
});

test('explicit numeric zero remains a valid zero', () => {
  assert.deepEqual(goalNumericProgress(goal({ current_value: 0 })), {
    done: 0, total: 10, percent: 0, scope: 'numeric', unit: '', label: '0 из 10',
  });
});

test('explicit string zero remains a valid zero', () => {
  assert.equal(goalNumericProgress(goal({ current_value: '0' })).done, 0);
});

test('numeric progress rounds to the nearest whole percent', () => {
  assert.equal(goalNumericProgress(goal({ current_value: 1 })).percent, 10);
  assert.equal(goalNumericProgress(goal({ target_value: 21, current_value: 12 })).percent, 57);
});

test('numeric progress clamps above the target', () => {
  assert.equal(goalNumericProgress(goal({ current_value: 15 })).percent, 100);
});

test('numeric progress clamps below zero', () => {
  assert.equal(goalNumericProgress(goal({ current_value: -2 })).percent, 0);
});

test('legacy measurable inference still recognizes a positive current value', () => {
  assert.equal(goalNumericProgress({ goal_kind: 'goal', target_value: 1, current_value: 0.2 }).scope, 'numeric');
});

test('disabled numeric progress stays excluded', () => {
  assert.equal(goalNumericProgress({ goal_kind: 'goal', target_value: 10, current_value: 2, numeric_progress: false }), null);
});

test('daily entries remain excluded from goal numeric progress', () => {
  assert.equal(goalNumericProgress({ goal_kind: 'daily_norm', target_value: 10, current_value: 2, numeric_progress: true }), null);
});

test('goal glance does not invent progress for unknown numeric current', () => {
  const result = goalGlance({ goals: {} }, { id: 'g1', ...goal({ current_value: null }) });
  assert.equal(result.progress, null);
});

test('goal glance falls back to separately labelled confirmed-skill progress', () => {
  const state = normalizeDevelopmentState({ version: 1, goals: {
    g1: {
      skills: [{ id: 's1', title: 'Skill', topic: 'Topic', evidence: 'proof', taskIds: ['t1', 't1'] }],
      stages: [],
    },
  } });
  const result = goalGlance(state, { id: 'g1', ...goal({ current_value: null }) });
  assert.deepEqual(result.progress, {
    done: 1, total: 1, percent: 100, scope: 'goal', label: '1 из 1 навыков цели подтверждено',
  });
  assert.deepEqual(state.goals.g1.skills[0].taskIds, ['t1']);
});

test('completion and undo snapshots are repeatable and do not accumulate; stage progress stays distinct', () => {
  const completed = goalNumericProgress(goal({ current_value: 10, status: 'achieved' }));
  const undone = goalNumericProgress(goal({ current_value: 4, status: 'active' }));
  assert.deepEqual(completed, goalNumericProgress(goal({ current_value: 10, status: 'achieved' })));
  assert.deepEqual(undone, goalNumericProgress(goal({ current_value: 4, status: 'active' })));
  assert.equal(completed.done, 10);
  assert.equal(completed.percent, 100);
  assert.equal(undone.done, 4);
  assert.equal(undone.percent, 40);
  const stage = stageProgress({ skillIds: ['s1'] }, [{ id: 's1', evidence: 'stage proof' }]);
  assert.deepEqual(stage, { done: 1, total: 1, percent: 100 });
});