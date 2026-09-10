import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutSegments } from '../src/layout.js';

const segment = (id, start, end) => ({ item: { id }, start, end });
test('overlapping records remain in separate lanes', () => {
  const result = layoutSegments([segment('a', 540, 660), segment('b', 570, 600), segment('c', 600, 630)]);
  assert.deepEqual(result.map(s => [s.item.id, s.lane, s.columns]), [['a', 0, 2], ['b', 1, 2], ['c', 1, 2]]);
});
test('adjacent groups use the full available width', () => {
  const result = layoutSegments([segment('a', 540, 570), segment('b', 570, 600)]);
  assert.deepEqual(result.map(s => s.columns), [1, 1]);
});
