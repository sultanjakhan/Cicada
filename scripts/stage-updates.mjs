#!/usr/bin/env node
/**
 * Verify signed CI update candidates and stage a static Tauri feed offline.
 *
 * Nothing here publishes files or contacts the update service. The output can
 * be reviewed before a separate deployment step copies `.local/update-assets`.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE_BASE = 'https://hanni-mvp-updates-v1.hanni-services.workers.dev';
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MINISIGN_TRUSTED_PREFIX = 'trusted comment: ';
const PLATFORMS = {
  windows: { platform: 'windows-x86_64', extension: '.exe' },
  android: { platform: 'android-aarch64', extension: '.apk' },
  macos: { platform: 'darwin-aarch64', extension: '.app.tar.gz' },
};

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function isSafeName(name) {
  return typeof name === 'string'
    && name === path.basename(name)
    && !name.includes('/')
    && !name.includes('\\')
    && name.length > 0;
}

function parsePublicKey(text) {
  const lines = Buffer.from(text.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  requireValue(lines.length === 2 && lines[0].startsWith('untrusted comment:'), 'Invalid Minisign public key envelope.');
  const key = Buffer.from(lines[1], 'base64');
  requireValue(key.length === 42 && key.subarray(0, 2).toString('ascii') === 'Ed', 'Invalid Minisign Ed25519 public key.');
  return { keyId: key.subarray(2, 10), publicKey: key.subarray(10) };
}

function ed25519PublicKey(raw) {
  requireValue(raw.length === 32, 'Invalid Ed25519 public key length.');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Verify the Tauri base64-wrapped Minisign signature without a shell tool. */
export function verifyTauriSignature(payload, signatureText, publicKeyText) {
  const { keyId, publicKey } = parsePublicKey(publicKeyText);
  const lines = Buffer.from(signatureText.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  requireValue(lines.length === 4 && lines[0].startsWith('untrusted comment:'), 'Invalid Minisign signature envelope.');
  requireValue(lines[2].startsWith(MINISIGN_TRUSTED_PREFIX), 'Missing Minisign trusted comment.');
  const signed = Buffer.from(lines[1], 'base64');
  const global = Buffer.from(lines[3], 'base64');
  requireValue(signed.length === 74 && global.length === 64, 'Invalid Minisign signature lengths.');
  requireValue(signed.subarray(2, 10).equals(keyId), 'Minisign key id differs from pinned update key.');

  const algorithm = signed.subarray(0, 2).toString('ascii');
  const rawSignature = signed.subarray(10);
  const message = algorithm === 'ED'
    ? createHash('blake2b512').update(payload).digest()
    : algorithm === 'Ed'
      ? payload
      : fail('Unsupported Minisign signature algorithm.');
  const verifier = ed25519PublicKey(publicKey);
  requireValue(verify(null, message, verifier, rawSignature), 'Payload Minisign signature is invalid.');
  const trustedComment = Buffer.from(lines[2].slice(MINISIGN_TRUSTED_PREFIX.length), 'utf8');
  requireValue(verify(null, Buffer.concat([rawSignature, trustedComment]), verifier, global),
    'Minisign trusted comment signature is invalid.');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectedAsset(version, config) {
  return `Cicada-${version}-${config.platform}${config.extension}`;
}

function expectedVersionCode(version) {
  const pieces = version.split('.').map(Number);
  requireValue(pieces.length === 3 && pieces.every(Number.isSafeInteger), 'Invalid semantic version.');
  const [major, minor, patch] = pieces;
  requireValue(major >= 0 && minor >= 0 && patch >= 0 && minor < 1000 && patch < 1000,
    'Invalid Android version components.');
  return major * 1_000_000 + minor * 1_000 + patch;
}

async function readCandidate(directory, kind, publicKeyText) {
  const config = PLATFORMS[kind];
  requireValue(config, `Unsupported platform: ${kind}`);
  const source = path.resolve(directory);
  const manifestPath = path.join(source, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const version = manifest.version;
  requireValue(/^\d+\.\d+\.\d+$/.test(version), `${kind} candidate version is invalid.`);
  requireValue(manifest.identifier === 'app.hanni.mvp', `${kind} candidate identifier is invalid.`);
  requireValue(manifest.platform === config.platform, `${kind} candidate platform is invalid.`);
  requireValue(/^[0-9a-f]{40}$/i.test(manifest.source), `${kind} candidate source commit is invalid.`);
  const assetName = expectedAsset(version, config);
  requireValue(manifest.asset === assetName && isSafeName(manifest.asset), `${kind} candidate asset name is invalid.`);
  requireValue(manifest.signature_file === `${assetName}.sig` && isSafeName(manifest.signature_file),
    `${kind} candidate signature name is invalid.`);
  const assetPath = path.join(source, assetName);
  const signaturePath = path.join(source, `${assetName}.sig`);
  requireValue(path.dirname(assetPath) === source && path.dirname(signaturePath) === source,
    `${kind} candidate path escapes its directory.`);
  const [asset, signature, info] = await Promise.all([readFile(assetPath), readFile(signaturePath, 'utf8'), stat(assetPath)]);
  requireValue(info.isFile() && asset.length > 0 && asset.length <= MAX_ASSET_BYTES, `${kind} asset size is invalid.`);
  requireValue(manifest.size === asset.length && manifest.sha256 === sha256(asset), `${kind} asset hash is invalid.`);
  requireValue(manifest.signature === signature.trim(), `${kind} manifest signature differs from its detached file.`);
  verifyTauriSignature(asset, signature, publicKeyText);
  if (kind === 'android') {
    requireValue(manifest.version_code === expectedVersionCode(version), 'Android version_code does not match version.');
  } else {
    requireValue(!Object.hasOwn(manifest, 'version_code'), 'Desktop candidate must not define Android version_code.');
  }
  return { kind, config, directory: source, manifest, asset, signature };
}

async function atomicWrite(destination, contents) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents);
  await rename(temporary, destination);
}

async function preserveAsset(destination, contents) {
  try {
    const existing = await readFile(destination);
    requireValue(existing.equals(contents), `Existing release asset differs: ${path.basename(destination)}`);
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await atomicWrite(destination, contents);
}

export async function stageUpdates({ windows, android, macos, notes = '', publishedAt, root = ROOT, publicKeyText }) {
  requireValue(typeof notes === 'string' && notes.length <= 2000 && !/[<>]/.test(notes),
    'Release notes must be plain text up to 2000 characters.');
  const pinnedKey = publicKeyText ?? await readFile(path.join(root, 'src-tauri/update-public-key.txt'), 'utf8');
  const candidates = await Promise.all([
    readCandidate(windows, 'windows', pinnedKey),
    readCandidate(android, 'android', pinnedKey),
    readCandidate(macos, 'macos', pinnedKey),
  ]);
  const [first] = candidates;
  requireValue(candidates.every(c => c.manifest.version === first.manifest.version), 'Candidate versions differ.');
  requireValue(candidates.every(c => c.manifest.source.toLowerCase() === first.manifest.source.toLowerCase()), 'Candidate source commits differ.');
  const timestamp = publishedAt ?? new Date().toISOString();
  requireValue(Number.isFinite(Date.parse(timestamp)), 'publishedAt must be an ISO timestamp.');

  const output = path.join(root, '.local', 'update-assets');
  // Version is already part of each filename; match the server's flat allowlist.
  const release = path.join(output, 'releases');
  const platforms = {};
  for (const candidate of candidates) {
    const assetPath = path.join(release, candidate.manifest.asset);
    const signaturePath = path.join(release, candidate.manifest.signature_file);
    await preserveAsset(assetPath, candidate.asset);
    await preserveAsset(signaturePath, Buffer.from(candidate.signature, 'utf8'));
    platforms[candidate.config.platform] = {
      url: `${UPDATE_BASE}/releases/${encodeURIComponent(candidate.manifest.asset)}`,
      signature: candidate.signature.trim(),
      sha256: candidate.manifest.sha256,
      size: candidate.manifest.size,
      ...(candidate.kind === 'android' ? { version_code: candidate.manifest.version_code } : {}),
    };
  }
  const latest = {
    version: first.manifest.version,
    notes,
    pub_date: timestamp,
    platforms,
  };
  await atomicWrite(path.join(output, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  return { output, latest };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    requireValue(['--windows', '--android', '--macos', '--notes', '--published-at'].includes(name) && value !== undefined,
      'Usage: stage-updates.mjs --windows <dir> --android <dir> --macos <dir> [--notes <plain text>] [--published-at <ISO>]');
    options[name.slice(2).replaceAll('-', '')] = value;
  }
  requireValue(options.windows && options.android && options.macos, 'Windows, Android and macOS candidate directories are required.');
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  stageUpdates({
    windows: options.windows,
    android: options.android,
    macos: options.macos,
    notes: options.notes ?? '',
    publishedAt: options.publishedat,
  }).then(({ output }) => console.log(output)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
