# Encrypted MVP checkpoints

This adapts ordinary Hanni's `cloud_relay_checkpoint.rs` and existing SQLite
Durable Object checkpoint engine. The content profile stays
`hanni-mvp-content-v1`; checkpoint schema and AEAD domains are MVP-specific.
The service never receives the encryption key or plaintext snapshot.

## Activation and older clients

`HANNI_MVP_CHECKPOINTS_ENABLED` is `"0"` in the checked-in Wrangler configuration.
Deploying this code alone does not publish checkpoints or remove history. Set it
to `"1"` only after reviewing local native/Worker tests, upgrading enrolled
clients, checking readiness and receiving owner approval for production pruning.
A later deployment with the checked-in configuration disables further pruning.

New native clients send `X-Hanni-MVP-Checkpoint: hanni-mvp-checkpoint-v1` on HTTP
and WebSocket requests. `GET /content/v1/checkpoints/status` records support for
the authenticated device's current token hash and returns only:

```text
{schema,enabled,ready,seen_clients,blocked_clients,checkpoint}
```

Readiness requires support from every enrolled device still authorized in either
token binding. Enrollment is retained from authenticated requests, existing
accepted sender cursors and surviving WebSocket attachments. A token generated
in advance but never used does not block readiness. Do not impersonate an
offline device by registering its capability from a different client. Rotation
invalidates the previous token's capability; revocation removes it from the gate.
The previous Worker did not retain historical GET-only connections without an
upload cursor or surviving socket; those facts cannot be reconstructed.

Once manually enabled, or after any prefix has been compacted, a client missing
the capability header receives HTTP 426 before ordinary writes or reads. A first
rejected request from an unused old client does not enroll it. Its local data and
outbox must remain intact until upgrade. Disabling maintenance after a compaction
keeps this compatibility fence and checkpoint recovery routes. Existing old
socket hints cannot authorize writes or acknowledge an outbox packet.

## Snapshot and installation

The authenticated JSONL header contains schema/table list, exact server prefix,
receipts and sender watermarks. Rows retain full `mvp_records` payloads, original
row timestamps and writers, including deleted records and timeline identities.
Separate entries preserve active alternatives and the hidden archive of resolved
alternatives, so dismissing a local conflict cannot erase its only recoverable
payload from a later checkpoint. App settings, credentials,
device identity, enabled flags and outgoing sequences are never copied.
Exact conflict resolution receipts remain local and are respected during merge.
A new replica requires a new per-device token/ID. Restoring an existing device
requires its own database and outgoing sequence, not only its config file.
Reusing an accepted device ID with an empty database fails closed on sequence
mismatch; checkpoints never renumber an immutable local outbox.

Capture runs in one immediate SQLite transaction and requires a nonzero fully
applied prefix with empty dirty, outbox, outbound/inbound fragments and pending
queues. Every row and archived schema is validated. Legacy transport tombstones
outside the MVP deleted-record representation block capture. A conflict archive
may be included; unresolved quarantined rows block publication. A device that
chose its current value over a pending incoming record cannot publish a new
checkpoint: its primary view may not represent that accepted prefix. Old
resolution receipts without retained payload/provenance also block publication.
Another device with a fully represented prefix can still compact the journal;
these gates do not erase local choices or relax ordinary sync. Local edits
made after capture belong to the suffix and do not change staged ciphertext.

Plaintext is bounded to 64 MiB, encrypted snapshot parts to 128 MiB. Parts contain
at most 60000 plaintext bytes. The manifest authenticates schema, base, counts,
plain length/hash and ordered ciphertext hash root. Part and manifest AAD bind
different MVP domains plus uploader, UUID, key ID, base and part index. Durable
local staging contains only ciphertext and nonsensitive transfer metadata.

Download acquires a read lease, verifies every part and the entire manifest,
then merges rows and cursor in one SQLite transaction. It never wipes working
data, dirty/outbox entries, local identity or resolution receipts. Original
sender positions cannot regress. Dependencies are applied before quarantine;
remaining conflicts use the existing bounded pending queue (4096 rows/32 MiB).
Dependency work is bounded to 64 passes/one million attempts. Capacity, unknown
schema or authentication failures roll back working changes and cursor. An
already covered checkpoint may retire transfer staging but cannot regress data.

The snapshot represents a fully assembled prefix. Covered inbound fragment
staging can retire; pending local incompatibilities are retained and retried.
Normal ordered batches strictly after the base complete recovery. Local
optimistic record versions still advance through the existing adapter so open
forms cannot overwrite remote materialization with a stale version.

## Publication, races and collection

The existing protocol endpoints are exposed under `/content/v1/checkpoints`:

- `POST /lease`: UUID, expected generation, base, part count and encrypted bytes.
- `PUT /{id}/chunks/{index}`: fencing epoch and immutable encrypted envelope.
- `POST /{id}/finalize`: epoch, ordered part hash root and encrypted manifest.
- `GET /latest`: active checkpoint summary, or 404 when none exists.
- `POST /{id}/read-lease`: empty JSON object; returns a device-bound lease.
- `GET /{id}` and `GET /{id}/chunks/{index}`: require `X-Hanni-Read-Lease`.
- `POST /content/v1/maintenance`: empty JSON object; bounded collection only.

Every route authenticates the bearer token. Checkpoint routes additionally
require the capability header. Lease, part upload and new finalization require
both manual activation and readiness. Read leases/download remain available
when maintenance is disabled. The server can validate only opaque envelopes;
the authorized native uploader is responsible for snapshot completeness.

Upload and download resume across restarts in steps of up to four requests.
Upload leases last 15 minutes and each renewal fences older epochs. Finalization
retries the same bytes before renewing a lease: a lost commit ACK cannot produce
a new checkpoint or discard the local job. Generation compare-and-swap prevents
concurrent publishers from replacing each other's snapshot. If a rival abandons
an upload and disappears before publishing, an explicit not-staging/missing
response plus an empty latest checkpoint retires only that encrypted transfer
cache. Working rows, cursor and outgoing packets stay intact; recapture must
pass all current preconditions again.

After all parts and the manifest commit, the same server transaction updates
active checkpoint, generation and compacted-through prefix. Appends continue
while a snapshot uploads; newer suffix packets are untouched. Old receive
cursors return 409 `checkpoint_required` with a summary. Exact last append ACKs
remain in per-device cursors even after packet collection, so a lost append ACK
can still retire only its matching local outbox record.

Native maintenance checks readiness at most hourly and starts a snapshot after
at least 256 new packets beyond the latest checkpoint, while delivery is caught
up and capture preconditions hold. Existing jobs continue in bounded steps.
GC uses existing durable alarms, at most 100 rows per step/10000 rows per UTC day,
and only deletes committed prefixes or expired transfer generations. Active read
leases protect retired snapshots; normal lease/grace limits are 10/30 minutes.
The original 128 MiB/100000-packet journal and 768 MiB physical database bounds
remain. At capacity the server returns 507 and preserves existing data and ACKs;
clients retain pending work. Never reset a server journal or local sequence to
work around capacity or incompatibility.

## Local evidence

All fixtures use temporary directories outside Git and synthetic records only.
No test deploys, accesses live credentials or opens an owner database.

```sh
npm test
npm run test:native
npm run test:native:checkpoint
```

Use Rust 1.98.1 and `CARGO_BUILD_JOBS=2` for native runners. The checkpoint runner
covers a multi-part encrypted snapshot, publisher/receiver SQLite restarts, a
lost finalize ACK, another peer's retained append ACK after GC, tombstones, day
state, a newer suffix, and an offline receiver's dirty/outbox preservation.
Worker tests exercise generation races, stale leases, immutable chunks, read
leases, quotas, restart/alarm GC, old-client fencing and unused-token enrollment.
Local evidence is distinct from acceptance on installed Mac/Windows/phone builds.
