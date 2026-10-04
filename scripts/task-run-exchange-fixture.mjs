// Offline synthetic fixture only. This script never opens an application database.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskRunExchange, readTaskRunStatus } from '../src/hanni/js/task-run-exchange.js';

const [mode, destination, input] = process.argv.slice(2);
if (!['init', 'import', 'export', 'show'].includes(mode) || !destination) throw new Error('Usage: node scripts/task-run-exchange-fixture.mjs init|import|export|show .local/<fixture> [envelope-file|runId]');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = path.join(root, '.local');
await fs.mkdir(local, { recursive: true });
const directory = path.resolve(root, destination);
if (path.dirname(directory) !== local) throw new Error('Fixture destination must be a direct child of this checkout .local directory');
if (await fs.realpath(local) !== path.join(await fs.realpath(root), '.local')) throw new Error('Fixture root cannot use a directory link');
const marker = path.join(directory, 'fixture-marker.json');
async function readFixtureFile(file, limit = 8 * 1024 * 1024) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit || path.dirname(await fs.realpath(file)) !== await fs.realpath(directory)) throw new Error('Not a bounded regular fixture file');
  return fs.readFile(file, 'utf8');
}
const stat = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
if (stat?.isSymbolicLink()) throw new Error('Fixture cannot use a directory link');
if (stat) {
  const identity = JSON.parse(await readFixtureFile(marker, 4096));
  if (identity.purpose !== 'synthetic-task-run-exchange' || identity.version !== 1) throw new Error('Not an exchange fixture');
} else {
  if (mode !== 'init') throw new Error('Initialize the fixture first');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(marker, JSON.stringify({ purpose: 'synthetic-task-run-exchange', version: 1 }), { flag: 'wx' });
}
const storage = path.join(directory, 'fixture-ui-state.json');
const read = async () => JSON.parse(await readFixtureFile(storage).catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
const record = { source_type: 'note', source_id: 'synthetic-exchange-task' };
async function invoke(command, args) {
  if (command === 'get_calendar_task' && args.id === record.source_id) return { id: record.source_id };
  const data = await read();
  if (command === 'get_ui_state') return data[args.key] ?? null;
  if (command !== 'set_ui_state') throw new Error('Fixture does not support this operation');
  if ((data[args.key] ?? '') !== args.expectedValue) throw new Error('mvp_sync_stale_ui_state');
  data[args.key] = args.value;
  const temporary = path.join(directory, `fixture-${process.pid}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(data), { flag: 'wx' });
  await fs.rename(temporary, storage);
}
const exchange = createTaskRunExchange(invoke);
if (mode === 'init') {
  await exchange.prepareSource();
  const binding = await exchange.bindTask(record);
  const state = await exchange.load();
  if (!Object.keys(state.runs).length) {
    const runId = await exchange.createAttempt(binding, { agent: 'codex' });
    // An explicitly synthetic observation, never a report about a real executor.
    await exchange.recordReport(binding, { runId, taskKey: binding.taskKey, sequence: 1, agent: 'codex', status: 'waiting', stage: 'synthetic-fixture', model: null, provider: null, inputTokens: null, outputTokens: null, mcpCalls: null, skillIds: [] });
  }
  await fs.writeFile(path.join(directory, 'binding.json'), await exchange.exportBinding(record));
}
if (mode === 'import') {
  if (!input) throw new Error('Envelope file required');
  if (path.dirname(path.resolve(input)) !== directory) throw new Error('Import only an envelope placed inside this synthetic fixture');
  await exchange.importReport(await readFixtureFile(path.resolve(input), 4 * 1024 * 1024));
}
if (mode === 'init' || mode === 'export') {
  const status = await readTaskRunStatus(record, invoke);
  const envelope = await exchange.exportReport(input ?? status.runId);
  await fs.writeFile(path.join(directory, 'report-envelope.json'), envelope);
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(JSON.parse(envelope).report));
}
const state = await exchange.load();
console.log(JSON.stringify({ purpose: 'synthetic-fixture', sourceNamespace: state.sourceNamespace, binding: state.bindings, latest: await readTaskRunStatus(record, invoke) }, null, 2));
