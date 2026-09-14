import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseArguments, provision } from '../tools/provision.mjs';

const endpoint = 'https://hanni-mvp-relay-v1.synthetic.workers.dev/';
const run = promisify(execFile);
const posixOnly = { skip: process.platform === 'win32' ? 'Provision on Mac/Linux for private Unix modes' : false };

async function fixture() {
  return { endpoint, devices: ['mac', 'windows', 'phone'],
    outputDir: join(await mkdtemp(join(tmpdir(), 'hanni-mvp-provision-fixture-')), 'pairing') };
}

test('provisioning creates separate device credentials and one MVP-only key without logging them', posixOnly, async () => {
  const options = await fixture();
  const result = await run(process.execPath, [fileURLToPath(new URL('../tools/provision.mjs', import.meta.url)),
    '--endpoint', endpoint, '--output-dir', options.outputDir, '--devices', options.devices.join(',')]);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary, { profile: 'hanni-mvp-content-v1', device_count: 3,
    files: ['device-mac.json', 'device-windows.json', 'device-phone.json', 'worker-secrets.json'] });
  assert.equal(result.stderr, '');
  const configs = await Promise.all(options.devices.map(label =>
    readFile(join(options.outputDir, `device-${label}.json`), 'utf8').then(JSON.parse)));
  const bindings = JSON.parse(await readFile(join(options.outputDir, 'worker-secrets.json'), 'utf8'));
  const hashes = JSON.parse(bindings.HANNI_DEVICE_TOKEN_HASHES);
  assert.equal(new Set(configs.map(value => value.token)).size, 3);
  assert.equal(new Set(configs.map(value => value.device_id)).size, 3);
  assert.equal(new Set(configs.map(value => value.key)).size, 1);
  assert.equal(new Set(configs.map(value => value.key_id)).size, 1);
  for (const config of configs) {
    assert.deepEqual(Object.keys(config), ['v', 'profile', 'endpoint', 'device_id', 'key_id', 'token', 'key', 'enabled']);
    assert.equal(config.profile, 'hanni-mvp-content-v1');
    assert.equal(config.endpoint, endpoint);
    assert.equal(config.v, 1);
    assert.equal(config.enabled, true);
    for (const value of [config.key, config.token]) {
      assert.equal(Buffer.from(value, 'base64url').length, 32);
      assert.equal(Buffer.from(value, 'base64url').toString('base64url'), value);
      assert.equal(result.stdout.includes(value), false);
      assert.equal(JSON.stringify(bindings).includes(value), false);
    }
    assert.equal(hashes[config.device_id], createHash('sha256').update(config.token).digest('hex'));
  }
  if (process.platform !== 'win32') {
    assert.equal((await lstat(options.outputDir)).mode & 0o777, 0o700);
    for (const file of summary.files) assert.equal((await lstat(join(options.outputDir, file))).mode & 0o777, 0o600);
  }
});

test('separate provisioning runs never reuse a key, token or device identity', posixOnly, async () => {
  const options = await Promise.all([fixture(), fixture()]);
  const configs = [];
  for (const value of options) {
    await provision(value);
    configs.push(JSON.parse(await readFile(join(value.outputDir, 'device-mac.json'), 'utf8')));
  }
  for (const field of ['key', 'key_id', 'token', 'device_id']) assert.notEqual(configs[0][field], configs[1][field]);
});

test('existing output is never overwritten, including symlink targets', posixOnly, async () => {
  const options = await fixture();
  await provision(options);
  const before = await readFile(join(options.outputDir, 'device-mac.json'), 'utf8');
  await assert.rejects(provision(options));
  assert.equal(await readFile(join(options.outputDir, 'device-mac.json'), 'utf8'), before);
  const link = join(options.outputDir, '..', 'pairing-link');
  await symlink(options.outputDir, link, 'dir');
  await assert.rejects(provision({ ...options, outputDir: link }));
  assert.equal(await readFile(join(options.outputDir, 'device-mac.json'), 'utf8'), before);
});

test('Git directories and worktree .git files are rejected before any credentials are written', posixOnly, async () => {
  for (const kind of ['directory', 'worktree']) {
    const options = await fixture();
    const parent = join(options.outputDir, '..');
    if (kind === 'directory') await mkdir(join(parent, '.git'));
    else {
      await writeFile(join(parent, '.git'), 'gitdir: synthetic\n');
    }
    await assert.rejects(provision(options), /outside_git/);
    await assert.rejects(access(options.outputDir));
    const link = join(await mkdtemp(join(tmpdir(), 'hanni-mvp-provision-link-')), 'git-parent');
    await symlink(parent, link, 'dir');
    await assert.rejects(provision({ ...options, outputDir: join(link, 'pairing') }), /outside_git/);
    assert.deepEqual(await readdir(parent), ['.git']);
  }
});

test('provisioning rejects legacy endpoints, unsafe paths and ambiguous devices', async () => {
  const options = await fixture();
  for (const invalid of [
    { endpoint: 'https://hanni-personal-relay-v2.synthetic.workers.dev/' },
    { endpoint: 'http://hanni-mvp-relay-v1.synthetic.workers.dev/' },
    { endpoint: endpoint + 'content' },
    { endpoint: endpoint + '?token=synthetic' },
    { endpoint: 'https://synthetic:synthetic@hanni-mvp-relay-v1.synthetic.workers.dev/' },
    { outputDir: 'relative' }, { devices: [] }, { devices: ['../escape'] },
    { devices: ['mac', 'mac'] }, { devices: Array.from({ length: 9 }, (_, i) => `device-${i}`) },
  ]) await assert.rejects(provision({ ...options, ...invalid }));
  await assert.rejects(access(options.outputDir));
  assert.throws(() => parseArguments(['--endpoint', endpoint]));
  assert.throws(() => parseArguments(['--endpoint', endpoint, '--endpoint', endpoint]));
  assert.throws(() => parseArguments(['--token', 'synthetic']));
});
