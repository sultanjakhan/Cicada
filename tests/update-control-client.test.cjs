const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('separate updater CLI preserves intent and reads receipts once after uncertainty', () => {
  const result = spawnSync('python', ['-B', '-c', `
import importlib.util, subprocess
s=importlib.util.spec_from_file_location('control','scripts/cicada-update-control.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
for action in ['check','prepare','install']:
 try:m.request(action,'operation-one')
 except ValueError:pass
 else:raise AssertionError('authorization missing')
r=m.request('install','operation-one',True,'9.0.0','a'*64)
assert set(r['payload'])=={'authorization','expected_version','prepared_id'}
for raw in [b'{"ok":true,"ok":false}',b'{"ok":NaN}',b'\\xff',b'{]',b'[]',b'x'*m.LIMIT]:
 try:m.decode_reply(raw)
 except (ValueError,UnicodeError):pass
 else:raise AssertionError('malformed reply accepted')
assert m.decode_reply(b'{"ok":true,"result":{"receipt":null}}')['ok']
calls=[]
def transport(value):
 calls.append(value)
 if value['action']=='install':raise OSError('ack lost after commit')
 return {'ok':True,'result':{'receipt':{'operation_id':'operation-one','phase':'committing','result':{'outcome':'unknown'}}}}
reply=m.execute(r,transport)
assert reply['result']['receipt']['phase']=='committing'
assert [v['action'] for v in calls]==['install','receipt']
assert all(v['operation_id']=='operation-one' for v in calls)
for missing in [False,True]:
 calls=[]
 def offline(value):
  calls.append(value)
  if missing and value['action']=='receipt':return {'ok':True,'result':{'receipt':None}}
  raise subprocess.TimeoutExpired('synthetic',1)
 reply=m.execute(r,offline)
 assert reply['error']=='control_outcome_unknown'
 assert [v['action'] for v in calls]==['install','receipt']
 assert all(v['operation_id']=='operation-one' for v in calls)
calls=[]
def refused(value):calls.append(value);return {'ok':False,'error':'control_window_active'}
assert m.execute(r,refused)['error']=='control_window_active';assert len(calls)==1
missing=False
for action in ['status','receipt']:
 calls=[];v=m.request(action,'operation-one');reply=m.execute(v,offline);assert len(calls)==1;assert reply['error']=='control_outcome_unknown'
print('CLI_AUTHORIZATION_STABLE_ID_RECEIPT_FIRST_UNKNOWN_NO_MUTATION_REPLAY_PASS')
`], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RECEIPT_FIRST_UNKNOWN_NO_MUTATION_REPLAY_PASS/);
});

test('production journal SQL persists one install latch across connections and rolls back incomplete commits', () => {
  const result=spawnSync('python',['-B','-c',String.raw`
import json,re,sqlite3,tempfile
from pathlib import Path
source=Path('src-tauri/src/update_control.rs').read_text()
schema=re.search(r'conn.execute_batch\("(PRAGMA synchronous=FULL;[^"\n]+)"\)',source).group(1)
insert=re.search(r'tx.execute\("(INSERT INTO install_commit[^"\n]+)"',source).group(1)
read=re.search(r'self.conn.query_row\("(SELECT CASE[^"\n]+)"',source).group(1)
with tempfile.TemporaryDirectory() as d:
 path=Path(d)/'ops.sqlite';a=sqlite3.connect(path);a.executescript(schema)
 a.execute('INSERT INTO operations VALUES(?,?,?,?)',('operation-one','digest','{}','checksum'));a.commit()
 a.execute('BEGIN IMMEDIATE');a.execute(insert,('operation-one','9.0.0','a'*64,'descriptor','signature'));a.rollback()
 assert a.execute('SELECT count(*) FROM install_commit').fetchone()[0]==0
 a.execute('BEGIN IMMEDIATE');a.execute(insert,('operation-one','9.0.0','a'*64,'descriptor','signature'));a.commit();a.close()
 b=sqlite3.connect(path)
 assert b.execute('SELECT operation_id FROM install_commit').fetchone()[0]=='operation-one'
 try:b.execute(insert,('operation-two','9.0.0','a'*64,'descriptor','signature'))
 except sqlite3.IntegrityError:b.rollback()
 else:raise AssertionError('duplicate installer latch accepted')
 b.execute('UPDATE operations SET receipt=?',('x'*16385,));b.commit()
 assert b.execute(read,('operation-one',)).fetchone()[0] is None
 b.close()
print('ACTUAL_JOURNAL_SQL_TWO_CONNECTION_DURABILITY_SINGLE_LATCH_BOUNDED_READ_PASS')
`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/ACTUAL_JOURNAL_SQL_TWO_CONNECTION_DURABILITY_SINGLE_LATCH_BOUNDED_READ_PASS/);
});

test('packager descriptor hashes the exact native Candidate tuple without equating installer and runtime bytes', () => {
  const result=spawnSync('python',['-B','-c',String.raw`
import importlib.util,json,hashlib
s=importlib.util.spec_from_file_location('package_update','scripts/package-update.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
manifest=dict(platform='windows-x86_64',source='a'*40,asset='Cicada-9.0.0-windows-x86_64.exe',version='9.0.0',signature='fictional-signature',sha256='b'*64,size=123)
d=m.runtime_descriptor(manifest,'fictional-runtime-v1','https://updates.example/latest.json')
tuple_value={'version':'9.0.0','package':{'url':'https://updates.example/releases/Cicada-9.0.0-windows-x86_64.exe','signature':'fictional-signature','sha256':'b'*64,'size':123,'version_code':None}}
assert d['prepared_id']==hashlib.sha256(json.dumps(tuple_value,separators=(',',':')).encode()).hexdigest()
assert d['installer_sha256']=='b'*64 and d['source_commit']=='a'*40 and d['build_id']=='fictional-runtime-v1'
assert 'installed_executable_sha256' not in d and 'unbundled_executable_sha256' not in d
for key,value in [('sha256','c'*64),('signature','another-signature'),('size',124)]:
 changed=dict(manifest);changed[key]=value;assert m.runtime_descriptor(changed,'fictional-runtime-v1','https://updates.example/latest.json')['prepared_id']!=d['prepared_id']
import tempfile,sys
from pathlib import Path
with tempfile.TemporaryDirectory() as temp:
 root=Path(temp);m.ROOT=root;(root/'package.json').write_text(json.dumps({'cicadaBuildId':'fictional-runtime-v1'}))
 built=root/'synthetic-installer.exe';built.write_bytes(b'fictional installer')
 m.source_metadata=lambda:('a'*40,'https://github.com/sultanjakhan/Cicada',{'productName':'Cicada','identifier':'app.hanni.mvp'},'9.0.0')
 environment={'HANNI_MVP_UPDATES_URL':'https://updates.example/latest.json'}
 m.updater_environment=lambda:environment;m.build_windows=lambda *_:built;m.output=lambda *_:''
 signed=[]
 def signer(payload,env):
  assert env is environment;signed.append(payload.name);p=payload.with_name(payload.name+'.sig');p.write_text('fictional detached signature');return p
 m.sign=signer;sys.argv=['package-update.py','windows'];m.main()
 directory=root/'.local/update-candidate/windows';produced=json.loads((directory/'manifest.json').read_text())
 descriptor=json.loads((directory/produced['control_descriptor_file']).read_text())
 assert len(list(directory.iterdir()))==5 and len(signed)==2
 assert signed[1]==produced['control_descriptor_file']
 assert produced['sha256']==hashlib.sha256(built.read_bytes()).hexdigest()
 assert descriptor==m.runtime_descriptor(produced,'fictional-runtime-v1',environment['HANNI_MVP_UPDATES_URL'])
 assert (directory/produced['control_descriptor_signature_file']).is_file()
 assert produced['control_descriptor_sha256']==hashlib.sha256((directory/produced['control_descriptor_file']).read_bytes()).hexdigest()
print('PACKAGER_EXACT_NATIVE_PREPARED_TUPLE_SOURCE_DESCRIPTOR_PASS')
`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PACKAGER_EXACT_NATIVE_PREPARED_TUPLE_SOURCE_DESCRIPTOR_PASS/);
});
