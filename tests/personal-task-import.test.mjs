import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePersonalJson, validatePersonalFile, nativeTaskFields, previewPersonalImport, applyPersonalImport } from '../src/hanni/js/personal-task-import.js';
const task = (id='one') => ({ externalId:id, title:`Synthetic ${id}`, projects:['cicada','agent-city'], status:'waiting', operation:'Review synthetic fixture', waitingFor:'Fixture review', result:'No execution', dependsOn:[] });
const file = tasks => JSON.stringify({ schemaVersion:1, kind:'personal-native-tasks', namespace:'personal-backlog', tasks, archiveTemplates:[] });
function domain() {
  const notes = new Map(); const calls=[]; let counter=0; let fail=null; let commitThenThrow=false;
  const invoke = async (command,args={}) => {
    calls.push({command,args:structuredClone(args)});
    if (fail === command) { fail=null; throw new Error('synthetic failure'); }
    if(command==='get_notes') { assert.equal(args.filter,'personal-import'); return [...notes.values()].filter(n=>n.tags.split(',').includes(args.search)).map(n=>structuredClone(n)); }
    if(command==='create_backup') return 'synthetic-backup';
    if(command==='create_note') { const id=`fixture-${++counter}`; notes.set(id,{id,version:1,title:args.title,content:args.content,tags:args.tags,status:args.status,archived:false,completed:false}); if(commitThenThrow){commitThenThrow=false; throw new Error('response lost');} return args.personalImportReceipt ? {schemaVersion:1,id,created:true,marker:args.tags.split(',').find(t=>t.startsWith('personal-import:'))} : id; }
    if(command==='get_note') return structuredClone(notes.get(args.id));
    if(command==='update_note') { const n=notes.get(args.id); assert.equal(args.expectedVersion,n.version); Object.assign(n,{title:args.title,content:args.content,tags:args.tags,archived:args.archived??n.archived,version:n.version+1}); return null; }
    throw new Error(`Forbidden command ${command}`);
  };
  return {invoke,notes,calls,failNext:c=>fail=c,loseCreateResponse:()=>commitThenThrow=true};
}
const sink = [];
const saveRecovery = async value => sink.push(structuredClone(value));
test('strict JSON rejects duplicate escaped keys, unknown fields, oversized input and cyclic deps',()=>{
  assert.throws(()=>parsePersonalJson('{"kind":1,"k\\u0069nd":2}'));
  assert.throws(()=>validatePersonalFile(file([task(),task()])));
  assert.throws(()=>validatePersonalFile(file([{...task(),source:'jira'}])));
  assert.throws(()=>parsePersonalJson(' '.repeat(65537)));
  assert.throws(()=>validatePersonalFile(file([{...task('one'),dependsOn:['two']},{...task('two'),dependsOn:['one']}])));
  assert.throws(()=>validatePersonalFile(file([{...task(),status:'running'}])));
});
test('shared projects one native personal record; personal task has no project tokens',()=>{
  const f=validatePersonalFile(file([task(),{...task('personal'),projects:[]} ]));
  assert.equal(f.tasks.length,2); const fields=nativeTaskFields(f,f.tasks[0]);
  assert.match(fields.tags,/task-sphere:personal/); assert.match(fields.tags,/project:cicada/); assert.match(fields.tags,/project:agent-city/);
  assert.doesNotMatch(nativeTaskFields(f,f.tasks[1]).tags,/project:/);
});
test('preview only reads own stable markers; backup precedes mutation; retry skips',async()=>{
  const d=domain();const raw=file([task()]); const p=await previewPersonalImport(d.invoke,raw);
  assert.deepEqual(d.calls.map(c=>c.command),['get_notes']);assert.equal(p.rows[0].action,'create');
  const result=await applyPersonalImport(d.invoke,p,{saveRecovery}); assert.equal(result.phase,'complete');
  assert.ok(d.calls.findIndex(c=>c.command==='create_backup')<d.calls.findIndex(c=>c.command==='create_note'));
  const again=await previewPersonalImport(d.invoke,raw);assert.equal(again.rows[0].action,'skip');
  await applyPersonalImport(d.invoke,again,{saveRecovery});assert.equal(d.notes.size,1);assert.equal(d.calls.filter(c=>c.command==='create_backup').length,1);
  assert.ok(result.rollback);assert.equal(result.created.length,1);
});
test('lost create response after commit retries without duplicate',async()=>{
  const d=domain(); const raw=file([task(),task('two')]);d.loseCreateResponse();
  await assert.rejects(applyPersonalImport(d.invoke,await previewPersonalImport(d.invoke,raw),{saveRecovery}), e=>e.report.phase==='partial');
  assert.equal(d.notes.size,1);const retry=await previewPersonalImport(d.invoke,raw);assert.deepEqual(retry.rows.map(r=>r.action),['skip','create']);
  await applyPersonalImport(d.invoke,retry,{saveRecovery});assert.equal(d.notes.size,2);
});
test('backup or export failure performs no domain writes',async()=>{
  for(const step of ['backup','export']){
    const d=domain(); const p=await previewPersonalImport(d.invoke,file([task()]));if(step==='backup')d.failNext('create_backup');
    await assert.rejects(applyPersonalImport(d.invoke,p,{saveRecovery:step==='export'?async()=>{throw new Error('export denied');}:saveRecovery}));assert.equal(d.notes.size,0);
  }
});
test('updates require preview version and preserve rollback export',async()=>{
  const d=domain();await applyPersonalImport(d.invoke,await previewPersonalImport(d.invoke,file([task()])),{saveRecovery});
  const raw=file([{...task(),operation:'Changed fixture'}]);const p=await previewPersonalImport(d.invoke,raw);assert.equal(p.rows[0].action,'update');
  const result=await applyPersonalImport(d.invoke,p,{saveRecovery});assert.match(result.before[0].content,/Review synthetic fixture/);assert.match([...d.notes.values()][0].content,/Changed fixture/);
  const next=await previewPersonalImport(d.invoke,file([{...task(),operation:'Another'}]));[...d.notes.values()][0].version++;
  await assert.rejects(applyPersonalImport(d.invoke,next,{saveRecovery}),/изменились/);
});
test('duplicate domain markers and archived records fail closed rather than recreate',async()=>{
  const d=domain();const f=validatePersonalFile(file([task()]));const fields=nativeTaskFields(f,f.tasks[0]);
  const row={id:'x',version:1,...fields,status:'task',completed:false,archived:false};d.notes.set('x',row);d.notes.set('y',{...row,id:'y'});
  await assert.rejects(previewPersonalImport(d.invoke,file([task()])),/Неоднозначный/);
  d.notes.delete('y');row.archived=true;await assert.rejects(previewPersonalImport(d.invoke,file([task()])),/недоступна/);
});
test('explicit templates exported then revision-checked archive/readback; no enumeration',async()=>{
  const d=domain();const id='00000000-0000-4000-8000-000000000001';d.notes.set(id,{id,version:3,title:'Synthetic personal template',content:'Synthetic original',tags:'calendar,task-sphere:personal',status:'note',archived:false,completed:false});
  const parsed=JSON.parse(file([task()]));parsed.archiveTemplates=[{id,expectedVersion:3,personalTemplateConfirmed:true}];
  const p=await previewPersonalImport(d.invoke,JSON.stringify(parsed));const report=await applyPersonalImport(d.invoke,p,{saveRecovery});
  assert.equal(report.templateExport[0].archived,false);assert.equal(d.notes.get(id).archived,true);assert.equal(report.archived.length,1);
  assert.equal(d.calls.some(c=>c.command==='get_notes'&&!c.args.search.startsWith('personal-import:')),false);
});
test('template revision changed or corporate tokens refuse archive before backup',async()=>{
  const d=domain();const id='00000000-0000-4000-8000-000000000001';d.notes.set(id,{id,version:4,title:'Synthetic template',content:'fixture',tags:'jira:fixture',status:'note',archived:false,completed:false});
  const parsed=JSON.parse(file([task()]));parsed.archiveTemplates=[{id,expectedVersion:4,personalTemplateConfirmed:true}];
  await assert.rejects(previewPersonalImport(d.invoke,JSON.stringify(parsed)));assert.equal(d.calls.some(c=>c.command==='create_backup'),false);
});
test('readback failure leaves recoverable creation and retry verifies without duplication',async()=>{
  const d=domain();const raw=file([task()]);d.failNext('get_note');
  await assert.rejects(applyPersonalImport(d.invoke,await previewPersonalImport(d.invoke,raw),{saveRecovery}),e=>e.report.created.length===1&&e.report.phase==='partial');
  const retry=await previewPersonalImport(d.invoke,raw);assert.equal(retry.rows[0].action,'skip');
  await applyPersonalImport(d.invoke,retry,{saveRecovery});assert.equal(d.notes.size,1);
});
test('archive failure after tasks can retry with explicit unchanged revision and existing tasks',async()=>{
  const d=domain();const id='00000000-0000-4000-8000-000000000001';d.notes.set(id,{id,version:1,title:'Synthetic personal template',content:'fixture',tags:'calendar,task-sphere:personal',status:'note',archived:false,completed:false});
  const input=JSON.parse(file([task()]));input.archiveTemplates=[{id,expectedVersion:1,personalTemplateConfirmed:true}];const raw=JSON.stringify(input);d.failNext('update_note');
  await assert.rejects(applyPersonalImport(d.invoke,await previewPersonalImport(d.invoke,raw),{saveRecovery}),e=>e.report.created.length===1&&e.report.archived.length===0);
  const retry=await previewPersonalImport(d.invoke,raw);assert.equal(retry.rows[0].action,'skip');await applyPersonalImport(d.invoke,retry,{saveRecovery});assert.equal(d.notes.size,2);assert.equal(d.notes.get(id).archived,true);
});
test('QA-IMP-002 same-file retry preserves user workflow/history and performs no update',async()=>{
  const d=domain();const raw=file([task()]);await applyPersonalImport(d.invoke,await previewPersonalImport(d.invoke,raw),{saveRecovery});
  const record=[...d.notes.values()][0];const userTags='task-process:system-analysis,task-stage:requirements,task-waiting,task-stage-log:requirements@2026-10-03T00:00:00Z,task-kind:instant,custom:fixture,project:custom';record.tags+=','+userTags;record.version++;
  const original=record.tags;const p=await previewPersonalImport(d.invoke,raw);assert.equal(p.rows[0].action,'skip');await applyPersonalImport(d.invoke,p,{saveRecovery});assert.equal(record.tags,original);assert.equal(d.calls.filter(c=>c.command==='update_note').length,0);
  const changed=file([{...task(),projects:[],operation:'Reviewed source update'}]);const next=await previewPersonalImport(d.invoke,changed);assert.equal(next.rows[0].action,'update');await applyPersonalImport(d.invoke,next,{saveRecovery});
  for(const tag of userTags.split(','))assert.ok(record.tags.split(',').includes(tag));assert.doesNotMatch(record.tags,/project:cicada|project:agent-city/);
});
test('NI1 stable marker dedup survives personal sphere change, conflicting work scope fails closed',async()=>{
  const d=domain();const raw=file([task()]);await applyPersonalImport(d.invoke,await previewPersonalImport(d.invoke,raw),{saveRecovery});const record=[...d.notes.values()][0];
  record.tags=record.tags.replace('task-sphere:personal','task-sphere:home');record.version++;
  const p=await previewPersonalImport(d.invoke,raw);assert.equal(p.rows[0].action,'skip');await applyPersonalImport(d.invoke,p,{saveRecovery});assert.equal(d.notes.size,1);assert.match(record.tags,/task-sphere:home/);
  const changed=file([{...task(),operation:'Updated source'}]);await applyPersonalImport(d.invoke,await previewPersonalImport(d.invoke,changed),{saveRecovery});assert.match(record.tags,/task-sphere:home/);assert.equal(d.notes.size,1);
  record.tags=record.tags.replace('task-sphere:home','task-sphere:work');record.version++;await assert.rejects(previewPersonalImport(d.invoke,raw));assert.equal(d.notes.size,1);
});
test('workflow revision change after preview aborts before backup',async()=>{
  const d=domain();const raw=file([task()]);await applyPersonalImport(d.invoke,await previewPersonalImport(d.invoke,raw),{saveRecovery});const p=await previewPersonalImport(d.invoke,file([{...task(),operation:'Changed'}]));
  const record=[...d.notes.values()][0];record.tags+=',task-stage:acceptance';record.version++;const backupCount=d.calls.filter(c=>c.command==='create_backup').length;
  await assert.rejects(applyPersonalImport(d.invoke,p,{saveRecovery}),/изменились/);assert.equal(d.calls.filter(c=>c.command==='create_backup').length,backupCount);assert.match(record.tags,/task-stage:acceptance/);
});
test('atomic native receipt replay after last check reports replay without another creation',async()=>{
  const d=domain();const raw=file([task()]);const base=d.invoke;let injected=false;
  // Protocol fixture only; real atomic enforcement is covered by two-connection Rust tests.
  const invoke=async(command,args={})=>{
    if(command==='create_note'){
      if(!injected){injected=true;await base(command,args);}
      const marker=args.tags.split(',').find(t=>t.startsWith('personal-import:'));
      const existing=[...d.notes.values()].find(note=>note.tags.split(',').includes(marker));
      return {schemaVersion:1,id:existing.id,created:false,marker};
    }
    return base(command,args);
  };
  const p=await previewPersonalImport(invoke,raw);assert.equal(p.rows[0].action,'create');const report=await applyPersonalImport(invoke,p,{saveRecovery});
  assert.equal(d.notes.size,1);assert.equal(report.created.length,0);assert.equal(report.replayed.length,1);assert.equal(report.phase,'complete');
});
test('unsupported or incorrectly bound native create receipt cannot claim complete import',async()=>{
  for(const reply of ['legacy-id',{schemaVersion:1,id:'fixture',created:true,marker:'wrong-marker'}]){
    const d=domain();const base=d.invoke;const invoke=async(command,args={})=>command==='create_note'?reply:base(command,args);
    await assert.rejects(applyPersonalImport(invoke,await previewPersonalImport(invoke,file([task()])),{saveRecovery}),e=>e.report.phase==='partial'&&e.report.created.length===0);
  }
});
