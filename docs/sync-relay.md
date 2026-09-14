# MVP device synchronization relay

MVP uses a separate copy of Hanni's encrypted Cloudflare relay protocol, with its
own Worker `hanni-mvp-relay-v1`, Durable Object namespace, per-device tokens and
shared encryption key. It never attaches to the legacy Hanni endpoint or imports
legacy data. Native clients use profile `hanni-mvp-content-v1` and only the
`/content/v1/batches`, `/content/v1/device-state` and `/content/v1/stream` routes.

The base endpoint in each native configuration is the HTTPS origin, ending in
`/`, without `/content`. The local provisioning tool generates files with exactly
`v, profile, endpoint, device_id, key_id, token, key, enabled`; server bindings
contain only SHA-256 token hashes. Generation requires a new explicitly selected
directory outside Git and works on Mac/Linux; the files are portable to clients
on Windows and mobile. It never deploys or accesses Keychain/live data.

For provisioning, route contracts, limits and local test commands see
[sync-relay/README.md](../sync-relay/README.md) and
[sync-relay/CONTRACT.md](../sync-relay/CONTRACT.md).

Content v1 retains all encrypted packets and currently has no exposed checkpoint
or garbage collection. At 128 MiB or 100000 retained packets, new writes fail
closed with HTTP 507, while committed history remains intact. The client must
retain pending local work and report the capacity condition. An independently
verified compaction protocol is needed before this journal reaches its limit;
resetting the server or local sequence is not a safe workaround.

The relay tests use synthetic data and real local workerd/SQLite. The optional
`npm run test:native` gate additionally runs the ignored Rust
`mvp_sync_local_relay_roundtrip` test against three temporary device configs.
Passing local checks is distinct from deployment and from verification on
installed Mac, Windows and phone clients.
