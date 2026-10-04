import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('distribution rejects an unconfigured or stale binary without revealing credentials', () => {
  const result = spawnSync('python', ['-B', '-c', `
import importlib.util, tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('configuration','scripts/check-update-configuration.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
configured={'HANNI_MVP_UPDATES_URL':'https://updates.example/latest.json','HANNI_MVP_UPDATES_TOKEN':'fixture-token-'*4}
for bad in [{}, {**configured,'HANNI_MVP_UPDATES_URL':'http://updates.example/latest.json'}, {**configured,'HANNI_MVP_UPDATES_URL':'https://user@updates.example/latest.json'}, {**configured,'HANNI_MVP_UPDATES_URL':'https://updates.example/latest.json?token=secret'}, {**configured,'HANNI_MVP_UPDATES_TOKEN':'short'}]:
 try: module.validate(bad)
 except ValueError as error: assert 'fixture-token' not in str(error)
 else: raise AssertionError('Invalid configuration accepted')
module.validate(configured)
with tempfile.TemporaryDirectory() as directory:
 binary=Path(directory)/'app.exe';binary.write_bytes(b'old unconfigured candidate')
 try: module.validate(configured,binary)
 except ValueError: pass
 else: raise AssertionError('Stale candidate accepted')
 binary.write_bytes(b'MZ'+configured['HANNI_MVP_UPDATES_URL'].encode()+b'\\x00'+configured['HANNI_MVP_UPDATES_TOKEN'].encode())
 module.validate(configured,binary)
print('PASS')
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'PASS');
});
