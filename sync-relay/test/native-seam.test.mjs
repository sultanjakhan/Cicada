import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startLocalRelay } from '../tools/test-native.mjs';

test('native fixture provides three isolated configurations and a working loopback relay', async () => {
  const relay = await startLocalRelay();
  try {
    const configs = await Promise.all(['mac', 'windows', 'phone'].map(label =>
      readFile(join(relay.configDir, `${label}.json`), 'utf8').then(JSON.parse)));
    const body = { client_seq: 1, batch_id: randomUUID(), envelope: {
      v: 1, alg: 'XChaCha20-Poly1305', key_id: configs[0].key_id,
      nonce: randomBytes(24).toString('base64url'), ciphertext: randomBytes(32).toString('base64url'),
    } };
    const ack = await fetch(new URL('content/v1/batches', configs[0].endpoint), {
      method: 'POST', headers: { Authorization: `Bearer ${configs[0].token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(ack.status, 201);
    assert.equal((await ack.json()).sender_device_id, configs[0].device_id);
    for (const config of configs.slice(1)) {
      const page = await fetch(new URL('content/v1/batches', config.endpoint), {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      assert.equal(page.status, 200);
      assert.deepEqual((await page.json()).batches[0].envelope, body.envelope);
    }
  } finally { await relay.close(); }
});
