# MVP content relay v1 wire

The outer router allows `/content/v1/batches`, `/content/v1/device-state`,
`/content/v1/stream` and the checkpoint/maintenance routes documented in
[CHECKPOINT.md](CHECKPOINT.md). HTTP must use HTTPS. Every request, including native
WebSocket, uses `Authorization: Bearer <32-byte canonical base64url token>`.
Tokens in URLs and unexpected query/body fields are rejected. This is a separate
MVP Worker/DO namespace, not an endpoint on the legacy Hanni relay.

## Append and replay

`POST /content/v1/batches` body:

```text
{client_seq, batch_id, envelope: {v:1, alg:"XChaCha20-Poly1305", key_id, nonce, ciphertext}}
```

`client_seq` is a positive safe integer, strictly increasing per device.
`batch_id` is a lowercase UUID; `key_id` is 1–64 `[A-Za-z0-9_-]` characters.
`nonce` is 24 bytes, `ciphertext` includes the AEAD tag and is 16–65536 bytes;
both are canonical unpadded base64url. No plaintext fields are accepted.
The client persists sequence, batch UUID and encrypted envelope before upload.

ACK after durable commit, HTTP 201 (new) or 200 (exact duplicate):

```text
{seq, duplicate, client_seq, sender_device_id, batch_id, envelope_sha256}
```

The digest is lowercase SHA-256 of canonical envelope JSON in field order
`v,alg,key_id,nonce,ciphertext`. The server authenticates `sender_device_id` from
the token; the client does not send or choose it in an append body.

Only `client_seq == accepted + 1` creates a new journal row.
`client_seq == accepted` returns the last ACK only if batch ID and digest match;
otherwise 409 `batch_payload_mismatch`. Older sequences return 409
`device_state_stale` with `accepted_client_seq` and the active checkpoint summary; gaps return
409 `client_sequence_gap` with `accepted_client_seq`. The client must preserve
its outbox and report these errors; never renumber, clear or re-encrypt it silently.

## Pull and recovery

`GET /content/v1/batches?after=N&limit=16` returns:

```text
{batches:[{seq,client_seq,sender_device_id,batch_id,envelope_sha256,envelope}],
 next_cursor,latest_seq,has_more}
```

`after` starts at 0, `limit` is 1–32. Packets are ordered, including the reader's
own packets. A page may end early at its byte limit; `next_cursor` advances only
through returned rows. A cursor beyond the server's latest sequence returns 409
`cursor_ahead`. Persist the receive cursor atomically with authenticated changes.

`GET /content/v1/device-state` returns:

```text
{accepted_client_seq,last_ack,checkpoint:null|{checkpoint_id,base_seq,generation},latest_seq}
```

`last_ack` is null for a new device, otherwise the ACK fields above without
`duplicate`. This endpoint only reports state; it does not acknowledge a local
pending item or authorize a reset. A cursor below the committed checkpoint base
returns 409 `checkpoint_required`; upgraded clients authenticate and merge the
snapshot, then pull the strictly newer suffix.

## Stream and limits

`GET /content/v1/stream` upgrades to native WebSocket, requiring Authorization.
Initial frame: `{type:"ready",latest_seq}`. Committed append notification:
`{type:"changed",latest_seq}`. Text `ping` receives `pong`. Notifications contain
only a hint to pull, not user records; reconnect must inspect/pull the journal.

429 limits include `Retry-After`; 507 capacity preserves committed rows. Content
capacity is 128 MiB/100000 retained packets. Checkpoint publication and bounded GC
require explicit manual activation and enrolled-client readiness.
See [README.md](README.md) for all bounds and operational consequences.

The service validates only an opaque envelope. MVP profile, AAD domain, content
schema, AEAD authenticity and merge invariants are enforced by the native client.
Legacy keys/configurations must never be used with this Worker.
