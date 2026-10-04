import { stableTaskBinding, createTaskRunExchange } from './task-run-exchange.js';
export const REGISTRY_KEY = 'engineering_work_registry_v1';
const fail = () => { throw new Error('invalid_work_registry'); };
const obj = x => x && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => obj(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(x);
const text = (x, n) => typeof x === 'string' && x.trim() && x.length <= n && !/[\u0000-\u001f]/.test(x);
const date = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(x) && Number.isFinite(Date.parse(x));
const canonical = x => JSON.stringify(x, (_, v) => obj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

export function validateRegistry(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 1024 * 1024) fail();
  const s = JSON.parse(raw);
  if (!exact(s, ['schemaVersion','kind','snapshotId','sequence','source','publishedAt','staleAfterSeconds','projects','tasks','runs']) || s.schemaVersion !== 1 || s.kind !== 'work-registry-snapshot' || !id(s.snapshotId) || !Number.isSafeInteger(s.sequence) || s.sequence < 1) fail();
  if (!exact(s.source, ['publisherId','sourceNamespace','mode']) || !id(s.source.publisherId) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s.source.sourceNamespace) || s.source.mode !== 'published-snapshot') fail();
  if (!date(s.publishedAt) || !Number.isSafeInteger(s.staleAfterSeconds) || s.staleAfterSeconds < 60 || s.staleAfterSeconds > 604800 || !Array.isArray(s.projects) || !Array.isArray(s.tasks) || s.tasks.length > 1000 || s.projects.length > 100 || !Array.isArray(s.runs) || s.runs.length) fail();
  // v1 importer supports task snapshots; run telemetry uses the separate strict exchange.
  const projects = new Set(), tasks = new Map();
  for (const p of s.projects) { if (!exact(p, ['id','title']) || !id(p.id) || !text(p.title,200) || projects.has(p.id)) fail(); projects.add(p.id); }
  for (const t of s.tasks) {
    if (!exact(t, ['id','projectId','parentTaskId','title','relationship','status','lastUpdated','provenance','operation','waitingFor','result','localBinding']) || !id(t.id) || tasks.has(t.id) || !projects.has(t.projectId) || !text(t.title,500) || !date(t.lastUpdated) || Date.parse(t.lastUpdated) > Date.parse(s.publishedAt)) fail();
    if (!['planned','running','waiting','checking','decision-needed','done','error','cancelled','unknown'].includes(t.status) || !['root','parallel','sequential'].includes(t.relationship) || (t.parentTaskId === null) !== (t.relationship === 'root')) fail();
    if (!exact(t.provenance,['kind','reference']) || t.provenance.kind !== 'parent-published' || !text(t.provenance.reference,500)) fail();
    for (const k of ['operation','waitingFor','result']) if (t[k] !== null && !text(t[k],2000)) fail();
    if (t.localBinding !== null && (!exact(t.localBinding,['sourceNamespace','sourceType','sourceId','taskKey']) || !id(t.localBinding.sourceId) || t.localBinding.sourceType !== 'note' || !/^[a-f0-9-]{36}$/.test(t.localBinding.sourceNamespace) || !/^cicada-[a-f0-9]{16}-[A-Za-z0-9_-]{1,80}$/.test(t.localBinding.taskKey))) fail();
    tasks.set(t.id,t);
  }
  for (const t of tasks.values()) {
    const seen = new Set([t.id]); let parent = t.parentTaskId;
    while (parent !== null) { const p = tasks.get(parent); if (!p || p.projectId !== t.projectId || seen.has(parent)) fail(); seen.add(parent); parent = p.parentTaskId; }
  }
  return s;
}

export function freshness(snapshot, task, now = Date.now()) {
  const updated = Date.parse(task.lastUpdated), published = Date.parse(snapshot.publishedAt);
  if (!Number.isFinite(now) || published > now || updated > now) return 'unknown';
  return now - updated > snapshot.staleAfterSeconds * 1000 ? 'stale' : 'fresh';
}

export function createRegistryStore(invoke) {
  return {
    async load() { const raw = await invoke('get_ui_state',{key:REGISTRY_KEY}); if (!raw) return {}; const state = JSON.parse(raw); if (!obj(state)) fail(); for (const [key,s] of Object.entries(state)) { validateRegistry(JSON.stringify(s)); if (key !== `${s.source.publisherId}:${s.source.sourceNamespace}`) fail(); } return state; },
    async import(raw) {
      const incoming = validateRegistry(raw), key = `${incoming.source.publisherId}:${incoming.source.sourceNamespace}`;
      const previous = await invoke('get_ui_state',{key:REGISTRY_KEY}), all = await this.load();
      // If another writer changed storage between reads, CAS rejects this write.
      const current = all[key];
      if (current && incoming.sequence <= current.sequence) {
        if (incoming.sequence === current.sequence && canonical(incoming) === canonical(current)) return {changed:false,snapshot:current};
        throw new Error('registry_sequence_conflict');
      }
      all[key] = incoming; const value = canonical(all);
      if (new TextEncoder().encode(value).length > 4 * 1024 * 1024) throw new Error('registry_storage_limit');
      await invoke('set_ui_state',{key:REGISTRY_KEY,value,expectedValue:previous ?? ''});
      return {changed:true,snapshot:incoming};
    },
  };
}

export async function readRegistryTask(record, invoke) {
  const [all, exchange] = await Promise.all([createRegistryStore(invoke).load(), createTaskRunExchange(invoke).load()]);
  const matches = [];
  if (!exchange) return matches;
  for (const s of Object.values(all)) for (const t of s.tasks) {
    const b = t.localBinding;
    if (!b || b.sourceType !== record.source_type || b.sourceId !== record.source_id) continue;
    const expected = await stableTaskBinding(b.sourceNamespace, record);
    if (canonical(expected) !== canonical(b)) throw new Error('invalid_registry_binding');
    if (b.sourceNamespace !== exchange.sourceNamespace || canonical(exchange.bindings[b.taskKey]) !== canonical(b)) continue;
    matches.push({snapshot:s,task:t,freshness:freshness(s,t)});
  }
  return matches;
}
