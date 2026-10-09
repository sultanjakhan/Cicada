import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyTauriSignature } from './stage-updates.mjs';

const ORIGIN = 'https://hanni-mvp-updates-v1.hanni-services.workers.dev';
const MAX_BYTES = 25 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let phase = 'configuration';
try {
  const expected = JSON.parse(await readFile(new URL('./published-channel-expected.json', import.meta.url), 'utf8'));
  const publicKey = await readFile(new URL('../src-tauri/update-public-key.txt', import.meta.url));
  assert.equal(hash(publicKey), expected.pinnedPublicKeySha256);
  // Existing CI configuration stays inside the runner. No values, headers or errors are logged.
  const token = process.env.MVP_UPDATES_TOKEN;
  assert(typeof token === 'string' && token.trim().length > 0);
  const configured = new URL(process.env.MVP_UPDATES_URL);
  assert.equal(configured.origin, ORIGIN);
  assert(['/','/latest.json'].includes(configured.pathname));
  assert.equal(configured.username, ''); assert.equal(configured.password, '');
  assert.equal(configured.search, ''); assert.equal(configured.hash, '');
  assert.equal(expected.version, '0.5.4');
  assert.equal(expected.source, '6758f2d1adcf0d064a222deba966886b58b1b809');
  const inventory = new Map(expected.files.map(item => [item.name, item]));
  assert.equal(inventory.size, 128); assert.equal(expected.files.length, 128);
  const payloads = expected.files.filter(item => !item.name.endsWith('.sig'));
  assert.equal(payloads.length, 64);
  for (const item of expected.files) {
    assert(/^[A-Za-z0-9_.-]+$/.test(item.name));
    assert(/^[0-9a-f]{64}$/.test(item.sha256));
    assert(Number.isSafeInteger(item.size) && item.size > 0 && item.size <= MAX_BYTES);
  }
  async function request(pathname, authenticated = true) {
    assert(pathname === '/' || pathname === '/latest.json' || pathname === '/health'
      || /^\/releases\/[A-Za-z0-9_.-]+$/.test(pathname));
    const target = new URL(pathname, ORIGIN);
    assert.equal(target.origin, ORIGIN);
    return fetch(target, {
      headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
      redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
  }
  async function body(response, maxBytes) {
    assert.equal(response.status, 200);
    const chunks = []; let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length; assert(total <= maxBytes); chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }
  phase = 'public-health-and-auth-guard';
  const health = await request('/health', false);
  assert.equal(health.status, 200); await health.body?.cancel();
  const unauthenticated = await request('/latest.json', false);
  assert.equal(unauthenticated.status, 401); await unauthenticated.body?.cancel();
  phase = 'authenticated-feed';
  const feedResponse = await request(configured.pathname);
  assert.match(feedResponse.headers.get('cache-control') ?? '', /private/);
  assert.match(feedResponse.headers.get('cache-control') ?? '', /no-store/);
  const rawFeed = await body(feedResponse, 64 * 1024);
  assert.equal(hash(rawFeed), expected.feedSha256);
  const feed = JSON.parse(rawFeed.toString('utf8'));
  assert.deepEqual(feed, expected.feed);
  assert.equal(feed.version, expected.version);
  assert.equal(Object.keys(feed.platforms).length, 3);
  const alias = await request(configured.pathname === '/' ? '/latest.json' : '/');
  assert.equal(hash(await body(alias, 64 * 1024)), expected.feedSha256);
  const completed = [];
  async function asset(item) {
    const response = await request('/releases/' + item.name);
    assert.match(response.headers.get('cache-control') ?? '', /private/);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    const bytes = await body(response, item.size);
    assert.equal(bytes.length, item.size); assert.equal(hash(bytes), item.sha256);
    return bytes;
  }
  phase = 'authenticated-assets-and-pinned-signatures';
  // Three pairs at a time bound memory and traffic; there are no build or signing steps.
  for (let offset = 0; offset < payloads.length; offset += 3) {
    await Promise.all(payloads.slice(offset, offset + 3).map(async item => {
      const signature = inventory.get(item.name + '.sig'); assert(signature);
      const payloadBytes = await asset(item);
      const signatureBytes = await asset(signature);
      verifyTauriSignature(payloadBytes, signatureBytes.toString('utf8'), publicKey.toString('utf8'));
      completed.push({ name: item.name, size: item.size, sha256: item.sha256,
        signatureSha256: signature.sha256, pinnedMinisign: 'PASS' });
    }));
  }
  assert.equal(completed.length, 64);
  for (const platform of Object.values(feed.platforms)) {
    const target = new URL(platform.url); assert.equal(target.origin, ORIGIN);
    const item = inventory.get(target.pathname.slice('/releases/'.length)); assert(item);
    assert.equal(item.sha256, platform.sha256); assert.equal(item.size, platform.size);
  }
  console.log('CICADA_CHANNEL_PROOF ' + JSON.stringify({ status: 'PASS', observedUtc: new Date().toISOString(),
    origin: ORIGIN, version: feed.version, source: expected.source, feedSha256: hash(rawFeed),
    publicHealthStatus: 200, unauthenticatedFeedStatus: 401, authenticatedFeedStatus: 200,
    verifiedPlatforms: 3, verifiedFiles: 128, verifiedBytes: expected.files.reduce((n, item) => n + item.size, 0),
    retainedFiles: expected.retainedFiles, pinnedSignaturePairs: completed.length,
    pinnedPublicKeySha256: hash(publicKey), rootAliasMatches: true, privateNoStore: true,
    assets: completed.sort((a,b) => a.name.localeCompare(b.name)) }));
} catch {
  // Error details can contain configuration or request headers. Report only the fixed phase.
  console.error('CICADA_CHANNEL_PROOF ' + JSON.stringify({ status: 'FAIL', phase }));
  process.exitCode = 1;
}
