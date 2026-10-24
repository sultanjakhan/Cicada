import test from 'node:test';
import assert from 'node:assert/strict';
import {changeTaskArchive} from '../src/hanni/js/task-archive.js';

const record = () => ({source_type:'note',source_id:'synthetic-task',version:4,archived:false});
function service({unknown=false}={}) {
  const state={id:'synthetic-task',version:4,archived:false,title:'Preserved task',notes:'Original requirements',completed:false};
  const calls=[];
  const invoke=async(command,args)=>{
    calls.push({command,args});
    if(command==='get_calendar_task')return structuredClone(state);
    assert.equal(command,'toggle_note_archive');
    assert.deepEqual(args,{id:state.id,expectedVersion:state.version});
    state.archived=!state.archived; state.version++;
    if(unknown)throw new Error('transport outcome unknown');
    return state.archived;
  };
  return {state,calls,invoke};
}

test('archive and restore keep identity, original text and incomplete state',async()=>{
  const s=service();
  const archived=await changeTaskArchive(s.invoke,record(),true);
  assert.equal(archived.archived,true);
  assert.equal(archived.completed,false);
  assert.equal(archived.notes,'Original requirements');
  const restored=await changeTaskArchive(s.invoke,{...record(),version:5,archived:true},false);
  assert.equal(restored.id,'synthetic-task');
  assert.equal(restored.archived,false);
  assert.equal(restored.title,'Preserved task');
  assert.equal(restored.version,6);
});

test('stale menu snapshot cannot archive a newer task revision',async()=>{
  const s=service(); s.state.version=5;
  await assert.rejects(changeTaskArchive(s.invoke,record(),true),/changed elsewhere/);
  assert.equal(s.calls.filter(c=>c.command==='toggle_note_archive').length,0);
  assert.equal(s.state.archived,false);
});

test('uncertain successful archive is not toggled back by replaying the stale action',async()=>{
  const s=service({unknown:true});
  await assert.rejects(changeTaskArchive(s.invoke,record(),true),/outcome unknown/);
  assert.equal(s.state.archived,true);
  await assert.rejects(changeTaskArchive(s.invoke,record(),true),/changed elsewhere/);
  assert.equal(s.calls.filter(c=>c.command==='toggle_note_archive').length,1);
  assert.equal(s.state.archived,true);
});

test('another returned identity or an unconfirmed readback never counts as success',async()=>{
  const s=service();
  await assert.rejects(changeTaskArchive(async()=>({...s.state,id:'other-task'}),record(),true),/changed elsewhere/);
  let mutated=false;
  await assert.rejects(changeTaskArchive(async(command)=>{
    if(command==='toggle_note_archive'){mutated=true;return true;}
    return {...s.state,version:mutated?5:4,archived:false};
  },record(),true),/requires a fresh read/);
});
