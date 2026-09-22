import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stageUpdates, verifyTauriSignature } from '../scripts/stage-updates.mjs';

const prefix = Buffer.from('302a300506032b6570032100', 'hex');

function keyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(prefix.length);
  const keyId = randomBytes(8);
  const encoded = Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64');
  return { privateKey, keyId, publicText: Buffer.from(`untrusted comment: test\n${encoded}\n`).toString('base64') };
}

function tauriSignature(payload, keys, prehashed = true) {
  const message = prehashed ? createHash('blake2b512').update(payload).digest() : payload;
  const rawSignature = sign(null, message, keys.privateKey);
  const algorithm = Buffer.from(prehashed ? 'ED' : 'Ed');
  const signed = Buffer.concat([algorithm, keys.keyId, rawSignature]);
  const trusted = 'timestamp: 0\tfile: candidate';
  const global = sign(null, Buffer.concat([rawSignature, Buffer.from(trusted)]), keys.privateKey);
  const inner = `untrusted comment: test\n${signed.toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`;
  return Buffer.from(inner).toString('base64');
}

async function candidate(root, kind, keys, source = 'a'.repeat(40)) {
  const spec = kind === 'windows'
    ? { platform: 'windows-x86_64', extension: '.exe' }
    : kind === 'macos' ? { platform: 'darwin-aarch64', extension: '.app.tar.gz' }
      : { platform: 'android-aarch64', extension: '.apk' };
  const version = '0.3.4';
  const asset = `Cicada-${version}-${spec.platform}${spec.extension}`;
  const directory = path.join(root, kind);
  const bytes = Buffer.from(`fictional ${kind} update`);
  const signature = tauriSignature(bytes, keys);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, asset), bytes);
  await writeFile(path.join(directory, `${asset}.sig`), signature);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    version, source, identifier: 'app.hanni.mvp', platform: spec.platform,
    asset, signature_file: `${asset}.sig`, signature, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(kind === 'android' ? { version_code: 3004 } : {}),
  }));
  return directory;
}

test('accepts both Minisign prehashed and pure Ed25519 payload forms', () => {
  const keys = keyMaterial();
  const payload = Buffer.from('fictional payload');
  verifyTauriSignature(payload, tauriSignature(payload, keys, true), keys.publicText);
  verifyTauriSignature(payload, tauriSignature(payload, keys, false), keys.publicText);
  assert.throws(() => verifyTauriSignature(Buffer.from('tampered'), tauriSignature(payload, keys), keys.publicText));
});

test('stages matching candidates and rejects traversal, source mismatch and tampering', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'hanni-stage-'));
  try {
    const keys = keyMaterial();
    const windows = await candidate(temporary, 'windows', keys);
    const android = await candidate(temporary, 'android', keys);
    const macos = await candidate(temporary, 'macos', keys);
    const staged = await stageUpdates({ windows, android, macos, root: temporary, publicKeyText: keys.publicText,
      notes: 'Plain text', publishedAt: '2026-09-16T00:00:00.000Z' });
    assert.equal(staged.latest.platforms['android-aarch64'].version_code, 3004);
    assert.match(staged.latest.platforms['darwin-aarch64'].url, /darwin-aarch64\.app\.tar\.gz$/);
    assert.equal(Object.keys(staged.latest.platforms).length, 3);
    assert.equal(JSON.parse(await readFile(path.join(temporary, '.local/update-assets/latest.json'))).version, '0.3.4');
    for (const entry of Object.values(JSON.parse(await readFile(path.join(temporary, '.local/update-assets/latest.json'))).platforms)) {
      assert.match(new URL(entry.url).pathname, /^\/releases\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }

    const manifest = JSON.parse(await readFile(path.join(windows, 'manifest.json')));
    manifest.asset = '../escape.exe';
    await writeFile(path.join(windows, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(stageUpdates({ windows, android, macos, root: temporary, publicKeyText: keys.publicText }));

    manifest.asset = 'Cicada-0.3.4-windows-x86_64.exe';
    manifest.source = 'b'.repeat(40);
    await writeFile(path.join(windows, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(stageUpdates({ windows, android, macos, root: temporary, publicKeyText: keys.publicText }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
