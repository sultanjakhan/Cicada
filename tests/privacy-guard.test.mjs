import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('privacy guard detects private fixtures without disclosing their values', () => {
  const result = spawnSync('python', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_privacy_guard.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
