import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('privacy guard passes the current tracked MVP tree', () => {
  const result = spawnSync('python', ['-B', 'scripts/check-private-data.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /first-party text files checked/);
  assert.match(result.stdout, /binary\/vendor generated files skipped/);
});
