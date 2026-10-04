import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('native QA policy refuses environment-only startup before process creation and always passes an explicit marked root',()=>{
  const code=`import importlib.util,hashlib,json,pathlib,tempfile
spec=importlib.util.spec_from_file_location('policy','scripts/qa-launch-policy.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
binary=b'fixture isolated_test_integration_disabled HANNI_MVP_DATA_DIR';digest=hashlib.sha256(binary).hexdigest()
def rejected(fn):
 try: fn()
 except (ValueError,FileNotFoundError): return
 raise AssertionError('Unsafe launch accepted')
rejected(lambda:p.verify_binary(binary,digest,False))
rejected(lambda:p.verify_binary(b'HANNI_MVP_DATA_DIR',hashlib.sha256(b'HANNI_MVP_DATA_DIR').hexdigest(),True))
rejected(lambda:p.verify_binary(binary,'0'*64,True))
p.verify_binary(binary,digest,True)
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory)
 rejected(lambda:p.launch_args('fixture.exe',root,'foreground'))
 marker=root/'cicada-isolated-test.json';marker.write_text('{}',encoding='utf-8')
 rejected(lambda:p.launch_args('fixture.exe',root,'foreground'))
 marker.write_text(json.dumps(p.MARKER),encoding='utf-8')
 foreground=p.launch_args('fixture.exe',root,'foreground');background=p.launch_args('fixture.exe',root,'background')
 assert foreground==['fixture.exe','--isolated-test-root',str(root)]
 assert background==foreground+['--background']
 rejected(lambda:p.launch_args('fixture.exe',pathlib.Path('relative'),'foreground'))
print('fail-closed-policy-ok')`;
  const result=spawnSync('python',['-B','-c',code],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),'fail-closed-policy-ok');
});
