"""Exercise the actual MCP schema/invoke/stdio against fictional native replies."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'vendor'))
import agent_mcp as m

NAMES = {'cicada_list_tasks','cicada_read_task','cicada_begin_ai_work',
         'cicada_report_ai_work','cicada_read_result_state','cicada_submit_result',
         'cicada_read_result_receipt'}
TASK = '11111111-1111-1111-1111-111111111111'
REPORT = dict(runId='fixture-run-001',sequence=1,taskKey=None,agent='codex',
              model=None,provider=None,stage=None,status='running',skillIds=[],
              mcpCalls=None,inputTokens=None,outputTokens=None)

class Bridge:
    def __init__(self, *unused):
        self.calls = []
        self.reply = {'synthetic':True}
    def call(self, value):
        self.calls.append(copy.deepcopy(value))
        return copy.deepcopy(self.reply)

class ProtocolTests(unittest.TestCase):
    def test_exact_seven_contracts_and_optional_schema(self):
        tools = {t['name']:t for t in m.tools_for('cicada')}
        self.assertEqual(set(tools), NAMES)
        hashes = json.loads((ROOT/'tests/baseline_contracts.json').read_text())
        for name, expected in hashes.items():
            self.assertEqual(hashlib.sha256(json.dumps(tools[name],sort_keys=True,separators=(',',':')).encode()).hexdigest(),expected)
        contract = tools['cicada_list_tasks']['inputSchema']
        self.assertEqual(contract['required'], [])
        self.assertFalse(contract['additionalProperties'])
        self.assertEqual(contract['properties']['pageSize'],dict(type='integer',minimum=1,maximum=100))

    def test_legacy_and_forwarding_do_not_mutate_or_transform(self):
        b=Bridge(); b.reply=[{'id':TASK,'version':4}]
        for args in ({},{'pageSize':1},{'pageSize':100}, {'cursor':'v1:7461736b2d31'},
                     {'pageSize':17,'cursor':'v1:7461736b2d31'}):
            retained=copy.deepcopy(args)
            self.assertEqual(m.invoke('cicada',b,'cicada_list_tasks',args),b.reply)
            call=b.calls[-1]
            self.assertEqual(set(call),{'version','operation_id','action','body'})
            self.assertEqual((call['version'],call['action'],call['body']),(1,'list',retained))
            self.assertEqual(args,retained)
        self.assertEqual(b.calls[0]['body'],{})

    def test_invalid_paging_never_reaches_native(self):
        b=Bridge()
        invalid=[{'pageSize':v} for v in (True,False,0,101,-1,1.0,'17',None)]
        invalid += [{'cursor':v} for v in (True,None,1,'','v1:','v1:0','v1:AA','v1:00','v1:ff','v1:20','v1:6120','v1:61\n','v1:'+'61'*81,'offset:1')]
        invalid += [{'offset':0},{'limit':17},{'pageSize':17,'profile':'other'}]
        for args in invalid:
            with self.subTest(args=args), self.assertRaises(ValueError):
                m.invoke('cicada',b,'cicada_list_tasks',args)
        self.assertEqual(b.calls,[])
        for raw in ('{"pageSize":1,"pageSize":2}','{"pageSize":NaN}'):
            with self.assertRaises(ValueError):m.parse(raw)

    def test_required_and_unknown_fields_all_seven(self):
        valid={
            'cicada_list_tasks':{},'cicada_read_task':{'taskId':TASK},
            'cicada_begin_ai_work':dict(operationId='fixture-begin-001',title='Synthetic',content='',taskId=TASK,expectedVersion=4,projects=[],report=REPORT),
            'cicada_report_ai_work':dict(operationId='fixture-report-001',taskId=TASK,expectedVersion=4,report=REPORT),
            'cicada_read_result_state':{'taskId':TASK},
            'cicada_submit_result':dict(operationId='fixture-submit-001',taskId=TASK,expectedVersion=4,runId='fixture-run-001',content='Synthetic result'),
            'cicada_read_result_receipt':dict(taskId=TASK,operationId='fixture-submit-001')}
        for name,args in valid.items():
            b=Bridge();b.reply={'known':False} if name.endswith('receipt') else {'synthetic':True}
            retained=copy.deepcopy(args)
            m.invoke('cicada',b,name,args)
            self.assertEqual(args,retained)
            for field in args:
                with self.subTest(name=name,missing=field), self.assertRaises(ValueError):
                    m.invoke('cicada',b,name,{k:v for k,v in args.items() if k!=field})
            with self.subTest(name=name), self.assertRaises(ValueError):
                m.invoke('cicada',b,name,dict(args,unexpected=True))
            self.assertEqual(len(b.calls),1)
        with self.assertRaises(ValueError):m.invoke('cicada',Bridge(),'cicada_task_command',{})

    def test_result_envelopes_replay_and_receipt_scope(self):
        b=Bridge();args=dict(operationId='fixture-submit-001',taskId=TASK,expectedVersion=4,runId='fixture-run-001',content='Synthetic result')
        m.invoke('cicada',b,'cicada_submit_result',args)
        m.invoke('cicada',b,'cicada_submit_result',args)
        self.assertEqual(b.calls[0],b.calls[1])
        self.assertEqual(b.calls[0],dict(version=1,operation_id=args['operationId'],action='task-command',body=dict(command='submit_result',arguments={k:v for k,v in args.items() if k!='operationId'})))
        receipt_args=dict(taskId=TASK,operationId=args['operationId'])
        for reply in ({'known':False},{'known':True,'receipt':{'operationId':args['operationId'],'task':{'id':TASK}}}):
            b.reply=reply;self.assertEqual(m.invoke('cicada',b,'cicada_read_result_receipt',receipt_args),reply)
        for reply in ({'known':True,'receipt':{'operationId':'other-op','task':{'id':TASK}}},
                      {'known':True,'receipt':{'operationId':args['operationId'],'task':{'id':'other-task'}}}, {'known':'true'}):
            b.reply=reply
            with self.assertRaises(ValueError):m.invoke('cicada',b,'cicada_read_result_receipt',receipt_args)
        count=len(b.calls)
        for changed in (dict(expectedVersion=True),dict(content='я'*4001),dict(runId=''),dict(operationId='short')):
            with self.assertRaises(ValueError):m.invoke('cicada',b,'cicada_submit_result',dict(args,**changed))
        self.assertEqual(len(b.calls),count)

    def test_stdio_schema_and_complete_137_personal_records(self):
        # The fixture executes the existing native eligibility SQL verbatim.
        # This verifies the public client route, not native device installation.
        process=subprocess.Popen([sys.executable,'-B',str(Path(__file__)),'--fixture-server'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        def rpc(method,params):
            process.stdin.write(json.dumps(dict(jsonrpc='2.0',id=1,method=method,params=params))+'\n');process.stdin.flush()
            return json.loads(process.stdout.readline())['result']
        try:
            self.assertEqual(rpc('initialize',{})['serverInfo']['name'],'cicada-local-authority')
            self.assertEqual({t['name'] for t in rpc('tools/list',{})['tools']},NAMES)
            def read(args):
                reply=rpc('tools/call',dict(name='cicada_list_tasks',arguments=args))
                self.assertFalse(reply['isError']);return reply['structuredContent']
            self.assertIsInstance(read({}),list)
            self.assertEqual(len(read({})),100)
            seen=[];args={'pageSize':17}
            for _ in range(10):
                page=read(args);self.assertLessEqual(len(page['tasks']),17)
                seen.extend(t['id'] for t in page['tasks'])
                if not page['hasMore']:
                    self.assertIsNone(page['nextCursor']);break
                self.assertIsInstance(page['nextCursor'],str)
                args={'pageSize':17,'cursor':page['nextCursor']}
            self.assertEqual(seen,[f'personal-{i:03d}' for i in range(137)])
            self.assertEqual(len(set(seen)),137)
            self.assertFalse(rpc('tools/call',dict(name='cicada_read_result_state',arguments={'taskId':TASK}))['isError'])
        finally:
            process.stdin.close();process.wait(timeout=10)
            errors=process.stderr.read();process.stdout.close();process.stderr.close()
            self.assertEqual(process.returncode,0,errors)

    def test_one_shot_cli(self):
        for args in ({},{'pageSize':17}):
            result=subprocess.run([sys.executable,'-B',str(Path(__file__)),'--fixture-call'],
                input=json.dumps(args),capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            value=json.loads(result.stdout)
            if args:self.assertEqual(len(value['tasks']),17)
            else:self.assertEqual(len(value),100)

def fixture_server():
    sql=(ROOT/'tests/personal_page.sql').read_text()
    source=ROOT.parents[2]/'src-tauri/src/agent_access.rs'
    if source.exists():
        assert sql==source.read_text().split('const PERSONAL_PAGE_SQL: &str = r#"',1)[1].split('"#;',1)[0]
    db=sqlite3.connect(':memory:');db.execute('CREATE TABLE items(id TEXT,kind TEXT,archived INTEGER,tags TEXT)')
    db.executemany('INSERT INTO items VALUES(?,?,?,?)',[(f'personal-{i:03d}','task',0,'task-sphere:personal') for i in range(137)])
    db.executemany('INSERT INTO items VALUES(?,?,?,?)',[
        ('excluded-work','task',0,'task-sphere:work'),('excluded-mixed','task',0,'task-sphere:personal,task-sphere:work'),
        ('excluded-jira','task',0,'task-sphere:personal,JIRA:synthetic'),('excluded-investlink','task',0,'task-sphere:personal,Investlink:synthetic'),
        ('excluded-archive','task',1,'task-sphere:personal'),('excluded-note','note',0,'task-sphere:personal')])
    class NativeFixture(Bridge):
        def call(self,envelope):
            if envelope['action']=='task-command':return {'task':{'id':TASK}}
            assert envelope['action']=='list' # All traversal must remain read-only.
            body=envelope['body'];after=bytes.fromhex(body['cursor'][3:]).decode() if 'cursor' in body else ''
            size=body.get('pageSize',100);ids=[row[0] for row in db.execute(sql,(after,size+1))]
            rows=[{'id':i,'version':4} for i in ids[:size]]
            if not body:return rows
            more=len(ids)>size
            return dict(tasks=rows,hasMore=more,nextCursor='v1:'+ids[size-1].encode().hex() if more else None)
    # Run the real portable CLI entrypoint with an isolated synthetic authority.
    m.Bridge=NativeFixture
    wrapper=ROOT/'scripts/cicada_mcp.py'
    spec=importlib.util.spec_from_file_location('wrapper',wrapper);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory() as raw:
        base=Path(raw);profile=base/'profile';profile.mkdir();(profile/'calendar.db').write_bytes(b'synthetic')
        config=base/'config.json';config.write_text(json.dumps(dict(cicadaProfile=str(profile),client=sys.executable)))
        call=['--call','cicada_list_tasks'] if '--fixture-call' in sys.argv else []
        sys.argv=[str(wrapper),'--config',str(config),*call];module.main()

if __name__=='__main__':
    if '--fixture-server' in sys.argv or '--fixture-call' in sys.argv:fixture_server()
    else:unittest.main()
