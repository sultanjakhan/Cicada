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
 a.execute('BEGIN IMMEDIATE');a.execute(insert,('operation-one','9.0.0','a'*64));a.rollback()
 assert a.execute('SELECT count(*) FROM install_commit').fetchone()[0]==0
 a.execute('BEGIN IMMEDIATE');a.execute(insert,('operation-one','9.0.0','a'*64));a.commit();a.close()
 b=sqlite3.connect(path)
 assert b.execute('SELECT operation_id FROM install_commit').fetchone()[0]=='operation-one'
 try:b.execute(insert,('operation-two','9.0.0','a'*64))
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
