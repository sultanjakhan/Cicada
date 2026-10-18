# Temporary updater dependency compatibility patch

Source: official crates.io `tauri-plugin-updater` 2.11.0 crate, SHA-256
`b28d8cabdeb0564f03ae261963de4bc3d98321cd3d213e76a81b7d344e5df606`.
Upstream: https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/updater
Original MIT/Apache licenses and source headers are retained.

The Windows optional `zip` dependency changes from `4` to `=9.0.0`,
in Cargo.toml and its original manifest. Production updater Rust is unchanged.
The upstream Windows quote-escaping test uses a synthetic `C:\\Test Fixtures`
path instead of a home-directory-shaped example, preserving its spaces/quoting
assertion while satisfying the unchanged repository privacy guard.
Generated crate lock/VCS metadata are not included; the application lockfile is
canonical. Zip 9.0.0 is the lowest patched version for RUSTSEC-2026-0367,
RUSTSEC-2026-0368 and RUSTSEC-2026-0369. Updater 2.11.0 matches this application's
pinned Tauri 2.11.1; all published stable updater 2 versions through 2.14.0 still
require zip 4, and 2.13+ also require Tauri 2.12. This local compatibility patch
avoids a framework upgrade or disabling archive support/security auditing.

Retain until a compatible upstream updater release supports fixed zip. To remove,
restore the registry updater dependency, regenerate the lockfile, and pass the
archive regression, locked native tests and current advisory audit with no ignores.
Advisories: https://rustsec.org/advisories/RUSTSEC-2026-0367.html
https://rustsec.org/advisories/RUSTSEC-2026-0368.html
https://rustsec.org/advisories/RUSTSEC-2026-0369.html
