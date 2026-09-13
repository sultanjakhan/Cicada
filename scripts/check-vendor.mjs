import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const json = file => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

export function checkVendor(root) {
  const manifest = json(path.join(root, 'scripts/vendor-manifest.json'));
  const declared = json(path.join(root, 'package.json')).dependencies;
  const locked = json(path.join(root, 'package-lock.json')).packages;
  const vendor = path.join(root, 'src/public/vendor');
  const entries = readdirSync(vendor, { withFileTypes: true });
  assert.ok(entries.every(entry => entry.isFile()), 'Vendor directory must contain files, without subdirectories');
  const files = entries.filter(entry => entry.name.endsWith('.js')).map(entry => entry.name).sort();
  assert.ok(Array.isArray(manifest) && manifest.length > 0, 'Missing vendor inventory');
  assert.deepEqual(manifest.map(entry => entry.file).sort(), files, 'Vendor inventory must cover every JavaScript file exactly once');
  for (const entry of manifest) {
    assert.ok(/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(entry.package), 'Invalid npm package name');
    assert.ok(entry.member.split('/').every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '..'), 'Invalid package member');
    const installed = path.join(root, 'node_modules', entry.package);
    assert.equal(declared?.[entry.package], entry.version, `${entry.file}: exact runtime dependency required`);
    assert.equal(locked['']?.dependencies?.[entry.package], entry.version, `${entry.file}: stale root lockfile`);
    assert.equal(locked[`node_modules/${entry.package}`]?.version, entry.version, `${entry.file}: locked version mismatch`);
    assert.equal(json(path.join(installed, 'package.json')).version, entry.version, `${entry.file}: run npm ci`);
    assert.equal(sha256(path.join(installed, entry.member)), entry.sha256, `${entry.file}: published package bytes differ`);
    assert.equal(sha256(path.join(vendor, entry.file)), entry.sha256, `${entry.file}: shipped vendor bytes differ`);
  }
  return manifest.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    console.log(`Vendor guard: ${checkVendor(root)} files match exact installed and locked npm packages.`);
  } catch (error) {
    console.error(`Vendor guard failed: ${error.message}`);
    process.exitCode = 1;
  }
}
