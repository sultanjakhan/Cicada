import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function startLocalRelay() {
  const { Miniflare, convertV4MiniflareOptions } = process.env.HANNI_MINIFLARE_MODULE
    ? await import(process.env.HANNI_MINIFLARE_MODULE) : await import('miniflare');
  const root = await mkdtemp(join(tmpdir(), 'hanni-mvp-native-relay-'));
  const key = randomBytes(32).toString('base64url');
  const keyId = `mvp_${randomBytes(16).toString('base64url')}`;
  const configs = ['mac', 'windows', 'phone'].map(label => ({ label,
    config: { v: 1, profile: 'hanni-mvp-content-v1', endpoint: '',
      device_id: `mvp_${randomBytes(16).toString('base64url')}`, key_id: keyId,
      token: randomBytes(32).toString('base64url'), key, enabled: true } }));
  const hashes = Object.fromEntries(configs.map(({ config }) => [config.device_id,
    createHash('sha256').update(config.token).digest('hex')]));
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0, modules: true,
    script: await readFile(new URL('../src/worker.mjs', import.meta.url), 'utf8'),
    compatibilityDate: '2026-09-01',
    durableObjects: { RELAY: { className: 'Relay', useSQLite: true } },
    bindings: { HANNI_DEVICE_TOKEN_HASHES: JSON.stringify(hashes) },
  }));
  // Native test transport uses loopback HTTP; keep the real Worker's HTTPS-only
  // boundary unchanged by forwarding through Miniflare's dispatch bridge.
  const proxy = createServer(async (req, res) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 96 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const headers = { ...req.headers };
      for (const name of ['host', 'connection', 'transfer-encoding']) delete headers[name];
      const response = await mf.dispatchFetch(`https://relay.test${req.url}`, {
        method: req.method, headers, ...(bytes ? { body: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(502).end(); }
  });
  const close = async () => {
    if (proxy.listening) {
      const closed = new Promise((resolveClose, reject) => proxy.close(error => error ? reject(error) : resolveClose()));
      proxy.closeAllConnections();
      try { await closed; } finally { await mf.dispose(); }
    } else await mf.dispose();
  };
  try {
    const runtimeUrl = await mf.ready;
    if (runtimeUrl.hostname !== '127.0.0.1' || !Number(runtimeUrl.port)) throw new Error('unexpected_runtime_address');
    await new Promise((resolveListen, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolveListen);
    });
    const endpoint = `http://127.0.0.1:${proxy.address().port}/`;
    const configDir = join(root, 'configs');
    await mkdir(configDir, { mode: 0o700 });
    for (const { label, config } of configs) {
      config.endpoint = endpoint;
      await writeFile(join(configDir, `${label}.json`), JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    }
    return { configDir, dataDir: join(root, 'native-data'), endpoint, close };
  } catch (error) { await close(); throw error; }
}

export async function testNative() {
  let interrupted = false;
  // Terminal Ctrl+C reaches cargo in the same process group. Keep Node alive
  // until that child exits so the finally block can dispose local workerd.
  const onInterrupt = () => { interrupted = true; };
  process.on('SIGINT', onInterrupt);
  let relay;
  try {
    relay = await startLocalRelay();
    if (interrupted) throw new Error('native_test_interrupted');
    const result = await new Promise((resolveRun, reject) => {
      const child = spawn('cargo', ['test', '--manifest-path',
        fileURLToPath(new URL('../../src-tauri/Cargo.toml', import.meta.url)),
        '--locked', 'mvp_sync_local_relay_roundtrip', '--', '--ignored'], {
        shell: false, windowsHide: true, stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env, HANNI_MVP_TEST_RELAY_CONFIG_DIR: relay.configDir,
          HANNI_MVP_DATA_DIR: relay.dataDir },
      });
      let passed = false;
      let tail = '';
      child.stdout.on('data', bytes => {
        tail = (tail + bytes.toString('utf8')).slice(-4096);
        if (/test \S*mvp_sync_local_relay_roundtrip \.\.\. ok/.test(tail)) passed = true;
      });
      // Assertion output may contain configurations. Never echo or save raw output.
      child.stderr.on('data', () => {});
      child.once('error', () => reject(new Error('native_test_start_failed')));
      child.once('exit', code => resolveRun({ code, passed }));
    });
    if (interrupted || result.code !== 0 || !result.passed) throw new Error('native_relay_roundtrip_not_passed');
    process.stdout.write('native_relay_roundtrip_passed\n');
  } finally {
    try { if (relay) await relay.close(); }
    finally { process.removeListener('SIGINT', onInterrupt); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await testNative(); }
  catch { process.stderr.write('native_relay_test_failed_no_sensitive_details\n'); process.exitCode = 1; }
}
