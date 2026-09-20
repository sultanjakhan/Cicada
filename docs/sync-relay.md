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

## Android while the app is closed

When content sync is configured and enabled, Android enrolls a unique periodic
WorkManager job. It requires a network connection and adequate battery/storage,
with a minimum interval of 15 minutes. Android may delay it; this is eventual
exchange, not an instant push guarantee. See [periodic work constraints](https://developer.android.com/reference/androidx/work/PeriodicWorkRequest).

The worker loads the native library without creating an Activity. It uses the
same private database, credentials, encrypted transport and OS content-sync lease
as foreground sync. It does not depend on update-channel configuration. Disabling
content sync cancels the job; the native exchange also rechecks the saved flag.
Transient errors and a busy lease get at most three attempts per cycle. Normal
backgrounding/closure and a process killed by Android are different from a user
force-stop, which must not be presented as supported background execution.

The private `hanni_content_sync` preferences record only the latest attempt time
and result code: 0 success, 1 retry, 2 disabled/unconfigured skip, 3 busy, 4 failure,
5 visible Activity skip. A skip is not evidence of a successful exchange.
`mvp_sync_status.background_error` reports failure to enroll the background job
separately from foreground exchange errors. Device acceptance must verify the
receipt, database convergence and process/Activity state together.
