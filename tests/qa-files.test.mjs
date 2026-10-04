import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('Windows QA preparation rejects hardlinks/junctions and pins identity before writing',{skip:process.platform!=='win32'},()=>{
  const result=spawnSync('python',['-B','-m','unittest','discover','-s','tests','-p','test_qa_files.py'],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
