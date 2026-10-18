import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/signed-update-candidate.yml', import.meta.url), 'utf8');
const sha = 'a'.repeat(40);
const tip = 'b'.repeat(40);
const repository = { id: 123, full_name: 'sultanjakhan/Cicada', fork: false };
const event = () => ({ action: 'completed', repository: { ...repository }, workflow_run: {
  status: 'completed', conclusion: 'success', event: 'push', head_branch: 'main',
  name: 'CI', path: '.github/workflows/ci.yml', head_repository: { ...repository }, head_sha: sha,
} });
function runGate(payload, overrides = {}) {
  const match = workflow.match(/        shell: python\n        run: \|\n([\s\S]*?)(?=\n  windows:)/);
  assert.ok(match, 'actual workflow must contain a secret-free Python trust gate');
  const script = match[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'cicada-trigger-'));
  try {
    const input = join(dir, 'event.json'), output = join(dir, 'output');
    writeFileSync(input, JSON.stringify(payload));
    const result = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', script], {
      encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: input, GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: repository.full_name, GITHUB_REPOSITORY_ID: '123',
        GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: tip, ...overrides },
    });
    let outputs = '';
    try { outputs = readFileSync(output, 'utf8').replace(/\r\n/g, '\n'); } catch {}
    return { ...result, outputs };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('successful main push CI selects the tested SHA rather than the mutable branch tip', () => {
  const result = runGate(event());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs, `sha=${sha}\nplatform=all\n`);
});

test('untrusted or unsuccessful upstream runs cannot produce signing outputs', () => {
  const mutations = [
    e => { e.workflow_run.conclusion = 'failure'; },
    e => { e.workflow_run.conclusion = 'cancelled'; },
    e => { e.workflow_run.status = 'in_progress'; },
    e => { e.action = 'requested'; },
    e => { e.workflow_run.event = 'pull_request'; },
    e => { e.workflow_run.event = 'pull_request_target'; },
    e => { e.workflow_run.head_branch = 'feature'; },
    e => { e.workflow_run.head_repository.id = 456; },
    e => { e.workflow_run.head_repository.full_name = 'fork/Cicada'; },
    e => { e.workflow_run.head_repository.fork = true; },
    e => { e.workflow_run.head_repository = null; },
    e => { e.repository.id = 456; },
    e => { e.repository.full_name = 'fork/Cicada'; },
    e => { e.repository.fork = true; },
    e => { e.workflow_run.name = 'Other'; },
    e => { e.workflow_run.path = '.github/workflows/other.yml'; },
    e => { e.workflow_run.head_sha = 'main'; },
    e => { e.workflow_run.head_sha = `${sha}\nplatform=macos`; },
    e => { delete e.workflow_run; },
  ];
  for (const mutate of mutations) {
    const payload = event(); mutate(payload);
    const result = runGate(payload);
    assert.notEqual(result.status, 0, String(mutate));
    assert.equal(result.outputs, '', String(mutate));
  }
});

test('manual main dispatch retains each supported platform and rejects other refs and events', () => {
  for (const platform of ['all', 'windows', 'android', 'macos']) {
    const payload = { repository, inputs: { platform } };
    const result = runGate(payload, { GITHUB_EVENT_NAME: 'workflow_dispatch' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs, `sha=${tip}\nplatform=${platform}\n`);
  }
  for (const overrides of [{ GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REF: 'refs/tags/v1' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REPOSITORY: 'fork/Cicada' }]) {
    const result = runGate({ repository }, { GITHUB_EVENT_NAME: 'workflow_dispatch', ...overrides });
    assert.notEqual(result.status, 0);
    assert.equal(result.outputs, '');
  }
  assert.notEqual(runGate({ repository, inputs: { platform: 'bad\nsha=main' } },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' }).status, 0);
});

test('all signing jobs depend on trust gate and bind checkout, artifact and draft target to its SHA', () => {
  assert.match(workflow, /workflow_run:\n    workflows: \[CI\]\n    types: \[completed\]\n    branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  const gate = workflow.split('  trusted-source:')[1].split('\n  windows:')[0];
  assert.doesNotMatch(gate, /secrets\.|uses: actions\/checkout|contents: write/);
  for (const platform of ['windows', 'android', 'macos']) {
    const job = workflow.split(`\n  ${platform}:\n`)[1].split(/\n  [a-z][\w-]*:\n/)[0];
    assert.match(job, /needs: trusted-source/);
    assert.ok(job.includes(`if: needs.trusted-source.outputs.platform == 'all' || needs.trusted-source.outputs.platform == '${platform}'`));
    assert.match(job, /ref: \$\{\{ needs.trusted-source.outputs.sha \}\}/);
    assert.match(job, /persist-credentials: false/);
    assert.ok(job.includes(`name: cicada-update-${platform}-` + '${{ needs.trusted-source.outputs.sha }}'));
    assert.match(job, /--target "\$CANDIDATE_SHA" --draft --latest=false/);
    assert.doesNotMatch(job, /github\.sha|\$GITHUB_SHA|ref: main/);
  }
});
