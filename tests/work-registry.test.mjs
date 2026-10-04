import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRegistry, freshness, createRegistryStore, readRegistryTask} from '../src/hanni/js/work-registry.js';
import {createTaskRunExchange, stableTaskBinding} from '../src/hanni/js/task-run-exchange.js';
const fixture = () => ({schemaVersion:1,kind:'work-registry-snapshot',snapshotId:'synthetic-1',sequence:1,source:{publisherId:'synthetic-parent',sourceNamespace:'11111111-1111-4111-8111-111111111111',mode:'published-snapshot'},publishedAt:'2026-10-02T12:00:00Z',staleAfterSeconds:3600,projects:[{id:'engineering',title:'Synthetic engineering'}],tasks:[{id:'task-1',projectId:'engineering',parentTaskId:null,title:'Synthetic task',relationship:'root',status:'checking',lastUpdated:'2026-10-02T12:00:00Z',provenance:{kind:'parent-published',reference:'synthetic-fixture'},operation:'Synthetic check',waitingFor:null,result:null,localBinding:null}],runs:[]});
test('registry validates hierarchy and rejects cycles, unknown parents and private extra fields',()=>{
  const s=fixture(); assert.deepEqual(validateRegistry(JSON.stringify(s)),s);
  for(const mutate of [s=>s.tasks[0].parentTaskId='missing',s=>{s.tasks[0].parentTaskId='task-1';s.tasks[0].relationship='parallel';},s=>s.tasks[0].prompt='private',s=>s.tasks.push({...s.tasks[0]})]){const bad=fixture();mutate(bad);assert.throws(()=>validateRegistry(JSON.stringify(bad)));}
});
test('freshness never rewrites recorded status',()=>{const s=fixture();assert.equal(freshness(s,s.tasks[0],Date.parse('2026-10-02T12:30:00Z')),'fresh');assert.equal(freshness(s,s.tasks[0],Date.parse('2026-10-02T14:00:00Z')),'stale');assert.equal(freshness(s,s.tasks[0],Date.parse('2026-10-02T11:00:00Z')),'unknown');assert.equal(s.tasks[0].status,'checking');});
test('durable import is idempotent, conflicts on changed sequence and survives new store',async()=>{
  let raw='',writes=0;const invoke=async(cmd,a)=>{if(cmd==='get_ui_state')return raw;if(a.expectedValue!==raw)throw Error('stale');raw=a.value;writes++;};
  const store=createRegistryStore(invoke),s=fixture();assert.equal((await store.import(JSON.stringify(s))).changed,true);const saved=raw;
  assert.equal((await createRegistryStore(invoke).import(JSON.stringify(s))).changed,false);assert.equal(raw,saved);assert.equal(writes,1);
  s.tasks[0].status='done';await assert.rejects(store.import(JSON.stringify(s)),/sequence_conflict/);assert.equal(raw,saved);
  s.sequence=2;await store.import(JSON.stringify(s));assert.equal(Object.values(await createRegistryStore(invoke).load())[0].tasks[0].status,'done');
});

test('registry task association requires the current explicitly bound source, not matching native IDs alone', async()=>{
  const values=new Map(), record={source_type:'note',source_id:'synthetic-task'};
  const invoke=async(cmd,a)=>{
    if(cmd==='get_calendar_task')return {id:a.id};
    if(cmd==='get_ui_state')return values.get(a.key)??'';
    if(cmd==='set_ui_state'){assert.equal(a.expectedValue,values.get(a.key)??'');values.set(a.key,a.value);return;}
    throw Error(cmd);
  };
  const s=fixture();
  s.tasks[0].localBinding=await stableTaskBinding(s.source.sourceNamespace,record);
  await createRegistryStore(invoke).import(JSON.stringify(s));
  assert.deepEqual(await readRegistryTask(record,invoke),[]);
  const exchange=createTaskRunExchange(invoke,()=>s.source.sourceNamespace);
  await exchange.prepareSource();
  assert.deepEqual(await readRegistryTask(record,invoke),[]);
  await exchange.bindTask(record);
  assert.equal((await readRegistryTask(record,invoke)).length,1);
  s.sequence=2;
  s.tasks[0].localBinding=await stableTaskBinding('22222222-2222-4222-8222-222222222222',record);
  await createRegistryStore(invoke).import(JSON.stringify(s));
  assert.deepEqual(await readRegistryTask(record,invoke),[]);
});
