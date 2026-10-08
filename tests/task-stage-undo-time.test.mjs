import test from 'node:test';
import assert from 'node:assert/strict';
import { stageSeconds } from '../src/hanni/js/task-processes.js';

const t = time => Date.parse('2026-10-08T' + time + ':00.000Z');
const log = [
  { stage: 'a', at: '2026-10-08T08:00:00.000Z' },
  { stage: 'b', at: '2026-10-08T09:00:00.000Z' },
];
const compensation = { stage: 'a', at: '2026-10-08T09:30:00.000Z' };
const block = (id, sourceId) => ({
  id, source_id: sourceId, source_type: 'note',
  date: '2026-10-08', start_time: '08:00',
  created_at: '2026-10-08T08:00:00.000Z',
  duration_minutes: 90, duration_seconds: 5400, is_active: 1,
});

test('compensating stage history preserves time already spent before Undo', () => {
  const blocks = [block(410, 'task-a')];
  const before = stageSeconds({ blocks, log, stage: 'b', now: t('09:30') });
  const after = stageSeconds({ blocks, log: [...log, compensation], stage: 'a', now: t('10:00') });
  assert.equal(before.get('a'), 3600);
  assert.equal(before.get('b'), 1800);
  assert.equal(after.get('a'), 5400);
  assert.equal(after.get('b'), before.get('b'));
  assert.equal([...after.values()].reduce((sum, value) => sum + value, 0), 7200);
});

test('compensation leaves parallel active block identities and accounting intact', () => {
  const blocks = [block(410, 'task-a'), block(411, 'task-b')];
  const snapshot = structuredClone(blocks);
  const taskBLog = [{ stage: 'parallel', at: '2026-10-08T08:00:00.000Z' }];
  const projectB = () => stageSeconds({
    blocks: blocks.filter(row => row.source_id === 'task-b'),
    log: taskBLog, stage: 'parallel', now: t('10:00'),
  });
  const beforeB = projectB();
  const resultA = stageSeconds({
    blocks: blocks.filter(row => row.source_id === 'task-a'),
    log: [...log, compensation], stage: 'a', now: t('10:00'),
  });
  assert.equal(resultA.get('b'), 1800);
  assert.equal(projectB().get('parallel'), 7200);
  assert.deepEqual(projectB(), beforeB);
  assert.deepEqual(blocks, snapshot);
});
