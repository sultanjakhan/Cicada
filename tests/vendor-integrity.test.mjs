import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkVendor } from '../scripts/check-vendor.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'hanni-vendor-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const bytes = '/* fictional vendor */';
  write('package.json', { dependencies: { 'example-vendor': '1.0.0' } });
  write('package-lock.json', { packages: {
    '': { dependencies: { 'example-vendor': '1.0.0' } },
    'node_modules/example-vendor': { version: '1.0.0' },
  } });
  write('node_modules/example-vendor/package.json', { version: '1.0.0' });
  write('node_modules/example-vendor/dist/bundle.js', bytes);
  write('src/public/vendor/example.js', bytes);
  write('scripts/vendor-manifest.json', [{ file: 'example.js', package: 'example-vendor', version: '1.0.0', member: 'dist/bundle.js', sha256: createHash('sha256').update(bytes).digest('hex') }]);
  return { root, write };
}

test('vendor guard accepts bytes tied to the audited package version', t => {
  const { root } = fixture(t);
  assert.equal(checkVendor(root), 1);
});

test('vendor guard rejects a changed shipped bundle even when npm package is clean', t => {
  const { root, write } = fixture(t);
  write('src/public/vendor/example.js', '/* substituted bundle */');
  assert.throws(() => checkVendor(root), /shipped vendor bytes differ/);
});

test('vendor guard rejects an unaudited added bundle', t => {
  const { root, write } = fixture(t);
  write('src/public/vendor/new.js', '/* missing from lock and inventory */');
  assert.throws(() => checkVendor(root), /cover every JavaScript file/);
});

test('vendor guard rejects package updates that leave the audited lock version behind', t => {
  const { root, write } = fixture(t);
  write('package-lock.json', { packages: { '': { dependencies: { 'example-vendor': '1.0.0' } }, 'node_modules/example-vendor': { version: '1.0.1' } } });
  assert.throws(() => checkVendor(root), /locked version mismatch/);
});

test('vendor guard rejects installed bytes that disagree with provenance', t => {
  const { root, write } = fixture(t);
  write('node_modules/example-vendor/dist/bundle.js', '/* changed package output */');
  assert.throws(() => checkVendor(root), /published package bytes differ/);
});
