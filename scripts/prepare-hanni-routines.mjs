// Explicit, offline preparation of an owner-provided routine export. Never opens
// a database or imports history. The output contains personal data: keep it local.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const identifier = value => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value;
  throw Error('Invalid source identifier');
};
const text = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160) throw Error('Invalid routine or step title');
  return value.trim();
};
const indexed = rows => {
  if (!Array.isArray(rows)) throw Error('Missing export collection');
  const map = new Map();
  for (const row of rows) {
    const id = identifier(row.id);
    if (map.has(id)) throw Error('Duplicate source identifier');
    map.set(id, row);
  }
  return map;
};

export function prepareHanniRoutines(source, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0,10) !== date) throw Error('A valid import date is required');
  const chains = indexed(source.chains), nodes = indexed(source.nodes), edges = indexed(source.edges), schedules = indexed(source.linked_schedules);
  const plans = [], mappings = [], adaptations = [];
  for (const [chainId, chain] of chains) {
    if (!chain.is_active) continue;
    if (!['manual', 'sleep_end'].includes(chain.trigger_type) || chain.trigger_time) throw Error('Unsupported automatic chain trigger');
    const all = [...nodes.values()].filter(node => identifier(node.chain_id) === chainId);
    const byId = new Map(all.map(node => [identifier(node.id), node]));
    const parents = new Map(all.map(node => [identifier(node.id), []]));
    for (const edge of edges.values()) {
      if (identifier(edge.chain_id) !== chainId) continue;
      const from = identifier(edge.from_node_id), to = identifier(edge.to_node_id);
      if (!byId.has(from) || !byId.has(to) || from === to || edge.trigger_type !== 'after_completion' || edge.trigger_value != null && edge.trigger_value !== '') throw Error('Unsupported or broken routine dependency');
      if (parents.get(to).includes(from)) throw Error('Duplicate routine dependency');
      parents.get(to).push(from);
    }
    const visited = new Set(), visiting = new Set();
    function visit(id) {
      if (visiting.has(id)) throw Error('Cyclic routine dependency');
      if (visited.has(id)) return;
      visiting.add(id); parents.get(id).forEach(visit); visiting.delete(id); visited.add(id);
    }
    all.forEach(node => visit(identifier(node.id)));
    const entries = new Set(all.filter(node => node.source_type === 'start' && node.is_start).map(node => identifier(node.id)));
    if ([...entries].some(id => parents.get(id).length)) throw Error('An entry node has prerequisites');
    const kept = all.filter(node => !entries.has(identifier(node.id)));
    if (!kept.length || kept.length > 50) throw Error('Routine needs 1 to 50 steps');
    const positions = new Map(kept.map((node, index) => [identifier(node.id), index]));
    let linked = 0, enabled = 0;
    const steps = kept.map(node => {
      if (!['schedule', 'start'].includes(node.source_type)) throw Error('Unsupported routine node type');
      const schedule = node.source_id == null ? null : schedules.get(identifier(node.source_id));
      if (node.source_type === 'schedule' && node.source_id != null && !schedule) throw Error('A linked routine schedule is missing');
      if (schedule) { linked++; if (schedule.is_active) enabled++; }
      const trackingMode = schedule?.tracking_mode || 'check';
      if (!['check', 'track'].includes(trackingMode)) throw Error('Unsupported step tracking mode');
      return { title:text(node.title), dependsOn:parents.get(identifier(node.id)).filter(id => !entries.has(id)).map(id => positions.get(id)).sort((a,b)=>a-b), trackingMode, optional:node.requirement === 'optional' };
    });
    // This target has plan-level availability, not per-node enablement.
    if (enabled && enabled !== linked) throw Error('Mixed enabled and disabled routine steps need explicit mapping');
    // Fully disabled linked schedules must not be silently reactivated by import.
    const active = !(linked && !enabled);
    const id = `hanni-chain-${chainId}`;
    plans.push({id, kind:'action', title:text(chain.title), weekdays:[0,1,2,3,4,5,6], startsOn:'', endsOn:'', time:'', active, required:steps.some(step=>!step.optional), createdOn:date, mode:'graph', steps});
    mappings.push({planId:id, chainId, entryNodeIds:[...entries], steps:kept.map((node,index)=>({index,nodeId:identifier(node.id),scheduleId:node.source_id == null ? null : identifier(node.source_id)}))});
    if (chain.trigger_type === 'sleep_end') adaptations.push({planId:id,change:'sleep_end_to_explicit_start'});
    else adaptations.push({planId:id,change:'manual_chain_available_daily_with_explicit_start'});
    if (!active) adaptations.push({planId:id,change:'disabled_schedules_remain_inactive'});
  }
  return {version:1, preparedOn:date, plans, mappings, adaptations,
    scope:'Active saved chains only; no completion history, timer history or standalone schedules. Available daily for suggestions, each run starts explicitly. Schedule weekdays and visible_from are not chain execution gates in the source.'};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i=0;i<args.length;i+=2) {
    if (!['--source','--output','--date'].includes(args[i]) || !args[i+1]) throw Error('Use --source private-export.json --output private-prepared.json --date YYYY-MM-DD');
    options[args[i].slice(2)] = args[i+1];
  }
  if (!options.source || !options.output) throw Error('Source and private output are required');
  const result = prepareHanniRoutines(JSON.parse(fs.readFileSync(options.source,'utf8').replace(/^\uFEFF/,'')),options.date);
  fs.writeFileSync(options.output,JSON.stringify(result,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({plans:result.plans.length,active:result.plans.filter(plan=>plan.active).length,steps:result.plans.reduce((sum,plan)=>sum+plan.steps.length,0),adaptations:result.adaptations.length}));
}
