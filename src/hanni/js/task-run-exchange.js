// Explicit local exchange only. No default invoke, network, launcher or sync hooks.
export const TASK_RUN_KEY = 'calendar_task_run_exchange_v1';
const FIELDS = ['runId', 'sequence', 'taskKey', 'agent', 'model', 'provider', 'stage', 'status', 'skillIds', 'mcpCalls', 'inputTokens', 'outputTokens'];
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sourcePattern = /^[A-Za-z0-9_-]{1,80}$/;
const taskPattern = /^cicada-[a-f0-9]{16}-[A-Za-z0-9_-]{1,80}$/;
const fail = message => { throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, limit = 10 ** 12) => Number.isSafeInteger(value) && value >= 0 && value <= limit;
const exact = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key)) && fields.every(key => Object.hasOwn(value, key));
const canonical = value => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const parseFile = raw => {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 4 * 1024 * 1024) fail('exchange_file_too_large');
  return JSON.parse(raw);
};

/** Strict Agent City 0.5.15 report projection. No task text or extra fields. */
export function validateRunReport(payload) {
  if (!object(payload) || Object.keys(payload).some(key => !FIELDS.includes(key))) fail('unsupported_run_fields');
  const row = Object.fromEntries(FIELDS.map(key => [key, payload[key] ?? null]));
  if (typeof row.runId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(row.runId)) fail('invalid_run_id');
  if (!integer(row.sequence, 10 ** 9) || row.sequence < 1) fail('invalid_sequence');
  if (!['codex', 'claude', 'other', 'agent-city'].includes(row.agent) || !['running', 'waiting', 'done', 'error', 'cancelled'].includes(row.status)) fail('invalid_agent_or_status');
  if (row.taskKey !== null && (typeof row.taskKey !== 'string' || !taskPattern.test(row.taskKey))) fail('invalid_task_key');
  for (const [key, limit] of [['model', 200], ['provider', 80], ['stage', 120]]) {
    const value = row[key];
    if (value !== null && (typeof value !== 'string' || !value.trim() || [...value].length > limit || /[\u0000-\u001f]/.test(value))) fail('invalid_run_label');
  }
  row.skillIds ??= [];
  if (!Array.isArray(row.skillIds) || row.skillIds.length > 40 || row.skillIds.some(id => typeof id !== 'string' || !/^skill-[a-f0-9]{24}$/.test(id))) fail('invalid_skill_ids');
  row.skillIds = [...new Set(row.skillIds)].sort();
  if (row.mcpCalls !== null) {
    if (!Array.isArray(row.mcpCalls) || row.mcpCalls.length > 30) fail('invalid_mcp_counters');
    const seen = new Set();
    row.mcpCalls = row.mcpCalls.map(call => {
      if (!exact(call, ['server', 'tool', 'calls']) || !['server', 'tool'].every(key => typeof call[key] === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(call[key])) || !integer(call.calls)) fail('invalid_mcp_counters');
      const key = canonical([call.server, call.tool]);
      if (seen.has(key)) fail('duplicate_mcp_counter');
      seen.add(key); return { server: call.server, tool: call.tool, calls: call.calls };
    }).sort((a, b) => a.server < b.server ? -1 : a.server > b.server ? 1 : a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0);
  }
  for (const key of ['inputTokens', 'outputTokens']) if (row[key] !== null && !integer(row[key])) fail('invalid_token_usage');
  return row;
}

function assertAdvance(previous, report) {
  if (report.sequence === previous.sequence && canonical(previous) === canonical(report)) return false;
  if (report.sequence <= previous.sequence) fail('run_sequence_conflict');
  for (const key of ['agent', 'taskKey', 'model', 'provider']) if (previous[key] !== report[key]) fail('new_run_id_required');
  for (const key of ['inputTokens', 'outputTokens']) if (previous[key] !== null && (report[key] === null || report[key] < previous[key])) fail('usage_decreased');
  const next = new Map((report.mcpCalls ?? []).map(call => [canonical([call.server, call.tool]), call.calls]));
  for (const call of previous.mcpCalls ?? []) if (!next.has(canonical([call.server, call.tool])) || next.get(canonical([call.server, call.tool])) < call.calls) fail('mcp_totals_decreased');
  return true;
}

export async function stableTaskBinding(sourceNamespace, record) {
  if (typeof sourceNamespace !== 'string' || !uuidPattern.test(sourceNamespace) || record?.source_type !== 'note' || typeof record.source_id !== 'string' || !sourcePattern.test(record.source_id)) fail('invalid_source_identity');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceNamespace));
  const prefix = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
  return { sourceNamespace, sourceType: 'note', sourceId: record.source_id, taskKey: `cicada-${prefix}-${record.source_id}` };
}

async function readState(raw) {
  if (raw == null || raw === '') return null;
  const state = typeof raw === 'string' ? parseFile(raw) : structuredClone(raw);
  if (!exact(state, ['version', 'sourceNamespace', 'order', 'bindings', 'runs']) || state.version !== 1 || !uuidPattern.test(state.sourceNamespace) || !integer(state.order) || !object(state.bindings) || !object(state.runs) || Object.keys(state.bindings).length > 500 || Object.keys(state.runs).length > 500) fail('invalid_exchange_state');
  for (const [key, binding] of Object.entries(state.bindings)) {
    if (!exact(binding, ['sourceNamespace', 'sourceType', 'sourceId', 'taskKey'])) fail('invalid_binding');
    const expected = await stableTaskBinding(state.sourceNamespace, { source_type: binding.sourceType, source_id: binding.sourceId });
    if (canonical(binding) !== canonical(expected) || key !== expected.taskKey) fail('invalid_binding');
  }
  for (const [id, run] of Object.entries(state.runs)) {
    if (!exact(run, ['runId', 'taskKey', 'agent', 'provider', 'model', 'report', 'receivedOrder']) || id !== run.runId || !Object.hasOwn(state.bindings, run.taskKey) || !integer(run.receivedOrder) || run.receivedOrder > state.order) fail('invalid_stored_run');
    validateRunReport({ runId: id, taskKey: run.taskKey, agent: run.agent, provider: run.provider, model: run.model, sequence: 1, status: 'running' });
    if (run.report !== null) {
      const report = validateRunReport(run.report);
      if (canonical(report) !== canonical(run.report) || ['runId', 'taskKey', 'agent', 'provider', 'model'].some(key => report[key] !== run[key])) fail('invalid_stored_run');
    }
  }
  return state;
}

/** Opt-in initialization only; UI reads never create a namespace or migrate tasks. */
export function createTaskRunExchange(invoke, uuid = () => globalThis.crypto.randomUUID()) {
  let queue = Promise.resolve();
  const load = async () => readState(await invoke('get_ui_state', { key: TASK_RUN_KEY }));
  function mutate(change) {
    const operation = queue.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await invoke('get_ui_state', { key: TASK_RUN_KEY });
        const state = await readState(raw);
        const changed = await change(state);
        if (!changed) return state;
        await readState(changed);
        const value = canonical(changed);
        if (new TextEncoder().encode(value).length > 4 * 1024 * 1024) fail('exchange_storage_limit');
        try { await invoke('set_ui_state', { key: TASK_RUN_KEY, value, expectedValue: raw ?? '' }); return changed; }
        catch (error) { if (attempt === 0 && String(error?.message ?? error).includes('mvp_sync_stale_ui_state')) continue; throw error; }
      }
    });
    queue = operation.catch(() => {}); return operation;
  }
  async function ensureTask(binding) { await invoke('get_calendar_task', { id: binding.sourceId }); }
  async function applyReport(state, binding, input) {
    if (!state || canonical(state.bindings[binding.taskKey]) !== canonical(binding)) fail('source_or_binding_mismatch');
    const report = validateRunReport(input);
    if (report.taskKey !== binding.taskKey) fail('task_key_mismatch');
    await ensureTask(binding);
    const previous = Object.hasOwn(state.runs, report.runId) ? state.runs[report.runId] : null;
    if (previous && ['taskKey', 'agent', 'provider', 'model'].some(key => previous[key] !== report[key])) fail('new_run_id_required');
    if (previous?.report && !assertAdvance(previous.report, report)) return null;
    state.order++;
    Object.defineProperty(state.runs, report.runId, { value: { runId: report.runId, taskKey: report.taskKey, agent: report.agent, provider: report.provider, model: report.model, report, receivedOrder: state.order }, enumerable: true, writable: true, configurable: true });
    return state;
  }
  return {
    load,
    async prepareSource() {
      const candidate = uuid();
      const state = await mutate(current => current ? null : { version: 1, sourceNamespace: candidate, order: 0, bindings: {}, runs: {} });
      return state.sourceNamespace;
    },
    async bindTask(record) {
      const current = await load(); if (!current) fail('source_not_prepared');
      const binding = await stableTaskBinding(current.sourceNamespace, record);
      await ensureTask(binding);
      await mutate(state => {
        if (!state || state.sourceNamespace !== binding.sourceNamespace) fail('source_mismatch');
        if (Object.hasOwn(state.bindings, binding.taskKey)) return null;
        Object.defineProperty(state.bindings, binding.taskKey, { value: binding, enumerable: true, writable: true, configurable: true }); return state;
      });
      return binding;
    },
    async exportBinding(record) {
      const binding = await this.bindTask(record);
      return canonical({ schemaVersion: 1, kind: 'cicada-task-binding', binding });
    },
    async createAttempt(binding, { agent, provider = null, model = null }) {
      const runId = uuid();
      validateRunReport({ runId, sequence: 1, taskKey: binding.taskKey, agent, provider, model, status: 'running' });
      await ensureTask(binding);
      await mutate(state => {
        if (!state || canonical(state.bindings[binding.taskKey]) !== canonical(binding)) fail('source_or_binding_mismatch');
        if (Object.hasOwn(state.runs, runId)) fail('run_id_exists');
        state.order++;
        state.runs[runId] = { runId, taskKey: binding.taskKey, agent, provider, model, report: null, receivedOrder: state.order }; return state;
      });
      return runId; // allocation is not execution: no report and no counters yet
    },
    async recordReport(binding, report) {
      return mutate(state => applyReport(state, binding, report));
    },
    async exportReport(runId) {
      const state = await load(), run = state?.runs[runId];
      if (!run?.report) fail('no_observed_report');
      return canonical({ schemaVersion: 1, kind: 'cicada-run-report', binding: state.bindings[run.taskKey], report: run.report });
    },
    async importReport(raw) {
      const envelope = parseFile(raw);
      if (!exact(envelope, ['schemaVersion', 'kind', 'binding', 'report']) || envelope.schemaVersion !== 1 || envelope.kind !== 'cicada-run-report' || !exact(envelope.binding, ['sourceNamespace', 'sourceType', 'sourceId', 'taskKey'])) fail('invalid_report_envelope');
      const binding = envelope.binding;
      const expected = await stableTaskBinding(binding.sourceNamespace, { source_type: binding.sourceType, source_id: binding.sourceId });
      if (canonical(expected) !== canonical(binding)) fail('invalid_binding');
      return mutate(state => applyReport(state, binding, envelope.report));
    },
  };
}

/** Display-only read. Unknown telemetry stays null; receipt order is not duration. */
export async function readTaskRunStatus(record, invoke) {
  const state = await createTaskRunExchange(invoke).load();
  if (!state) return null;
  const binding = await stableTaskBinding(state.sourceNamespace, record);
  if (!Object.hasOwn(state.bindings, binding.taskKey)) return null;
  const runs = Object.values(state.runs).filter(run => run.taskKey === binding.taskKey).sort((a, b) => b.receivedOrder - a.receivedOrder);
  const latest = runs[0];
  return latest ? { runId: latest.runId, report: latest.report, cost: null } : null;
}
