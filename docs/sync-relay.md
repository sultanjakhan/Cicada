# MVP device synchronization relay

MVP uses a separate copy of Hanni's encrypted Cloudflare relay protocol, with its
own Worker `hanni-mvp-relay-v1`, Durable Object namespace, per-device tokens and
shared encryption key. It never attaches to the legacy Hanni endpoint or imports
legacy data. Native clients use profile `hanni-mvp-content-v1` with the
`/content/v1/batches`, `/content/v1/device-state`, `/content/v1/stream` and
MVP-authenticated checkpoint routes.

The base endpoint in each native configuration is the HTTPS origin, ending in
`/`, without `/content`. The local provisioning tool generates files with exactly
`v, profile, endpoint, device_id, key_id, token, key, enabled`; server bindings
contain only SHA-256 token hashes. Generation requires a new explicitly selected
directory outside Git and works on Mac/Linux; the files are portable to clients
on Windows and mobile. It never deploys or accesses Keychain/live data.

For provisioning, route contracts, limits and local test commands see
[sync-relay/README.md](../sync-relay/README.md) and
[sync-relay/CONTRACT.md](../sync-relay/CONTRACT.md).

Encrypted full snapshots, suffix recovery and bounded journal collection reuse
ordinary Hanni's existing checkpoint protocol. Maintenance stays disabled by
default (`HANNI_MVP_CHECKPOINTS_ENABLED="0"`); production activation requires owner
approval and upgraded enrolled clients. Never-used preprovisioned tokens do not
block readiness. Older clients fail closed without dropping their local outbox.
See [CHECKPOINT.md](../sync-relay/CHECKPOINT.md) for the exact activation gate,
snapshot/queue preconditions, tombstones, leases, limits and recovery contract.
The original 128 MiB/100000-packet cap still returns 507 without resetting data.

The relay tests use synthetic data and real local workerd/SQLite. The optional
`npm run test:native` gate additionally runs the ignored Rust
`mvp_sync_local_relay_roundtrip` test against three temporary device configs.
The additional `npm run test:native:checkpoint` gate verifies authenticated
snapshot/restart/lost-ACK/GC recovery using the actual local Worker.
Passing local checks is distinct from deployment and from verification on
installed Mac, Windows and phone clients.
