import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareHanniRoutines } from '../scripts/prepare-hanni-routines.mjs';

function source() {
  return {chains:[{id:1,title:'Example routine',is_active:1,trigger_type:'manual'}],nodes:[
    {id:10,chain_id:1,title:'Start',source_type:'start',is_start:1},
    {id:11,chain_id:1,title:'First branch',source_type:'schedule',source_id:null},
    {id:12,chain_id:1,title:'Second branch',source_type:'schedule',source_id:20,requirement:'optional'},
    {id:13,chain_id:1,title:'Join',source_type:'start',is_start:0},
  ],edges:[[10,11],[10,12],[11,13],[12,13]].map(([from,to],id)=>({id,chain_id:1,from_node_id:from,to_node_id:to,trigger_type:'after_completion',trigger_value:null})),linked_schedules:[{id:20,is_active:1,tracking_mode:'track',frequency:'custom',frequency_days:'2,4'}]};
}
test('offline preparation retains fork/join, standalone titles, terminal marker and check/track semantics',()=>{
  const input=source(), before=structuredClone(input), result=prepareHanniRoutines(input,'2026-09-27'), plan=result.plans[0];
  assert.deepEqual(input,before);
  assert.equal(plan.id,'hanni-chain-1');
  assert.deepEqual(plan.steps.map(step=>step.dependsOn),[[],[],[0,1]]);
  assert.deepEqual(plan.steps.map(step=>step.trackingMode),['check','track','check']);
  assert.equal(plan.steps[1].optional,true);
  assert.deepEqual(plan.weekdays,[0,1,2,3,4,5,6]);
  assert.deepEqual(result.mappings[0].entryNodeIds,['10']);
  assert.equal(result.mappings[0].steps[0].scheduleId,null);
  assert.deepEqual(result.adaptations.map(item=>item.change),['manual_chain_available_daily_with_explicit_start']);
});
test('disabled linked schedules stay inactive; sleep trigger becomes an explicitly recorded manual adaptation',()=>{
  const input=source();input.chains[0].trigger_type='sleep_end';input.linked_schedules[0].is_active=0;
  const result=prepareHanniRoutines(input,'2026-09-27');
  assert.equal(result.plans[0].active,false);
  assert.deepEqual(result.adaptations.map(item=>item.change),['sleep_end_to_explicit_start','disabled_schedules_remain_inactive']);
});
test('broken references, cycles, unsupported delays and invalid dates stop preparation instead of flattening',()=>{
  const broken=source();broken.nodes[2].source_id=999;assert.throws(()=>prepareHanniRoutines(broken,'2026-09-27'),/missing/);
  const cyclic=source();cyclic.edges.push({id:9,chain_id:1,from_node_id:13,to_node_id:11,trigger_type:'after_completion'});assert.throws(()=>prepareHanniRoutines(cyclic,'2026-09-27'),/Cyclic/);
  const delayed=source();delayed.edges[0].trigger_type='after_minutes';assert.throws(()=>prepareHanniRoutines(delayed,'2026-09-27'),/dependency/);
  assert.throws(()=>prepareHanniRoutines(source(),'2026-02-30'),/date/);
});
test('mixed enabled and disabled linked steps require a decision instead of silent activation',()=>{
  const input=source();input.nodes[1].source_id=21;
  input.linked_schedules.push({id:21,is_active:0,tracking_mode:'check'});
  assert.throws(()=>prepareHanniRoutines(input,'2026-09-27'),/Mixed enabled and disabled/);
});
