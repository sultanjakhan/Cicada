# Guarded local update control

This is a separate Windows same-account control endpoint, not a task MCP tool.
It is available only in the installed production executable/profile. It cannot
hide windows, change timers, approve dialogs or supply renderer safety state.
macOS, Linux, Android and pre-upgrade binaries do not expose this endpoint.

The local account is the trust boundary. The pipe rejects remote clients and
grants access only to the server account; the client verifies the pipe owner
before sending bytes. `--authorize` is a deliberate caller opt-in to the
human-authorized update capability, not a secret or a substitute for OS identity.
No HTTP listener, task grant or task report grants installation authority.

## CLI

Run with the existing Python interpreter on Windows. No extra packages:

```console
python scripts/cicada-update-control.py status --operation-id status-20261019
python scripts/cicada-update-control.py check --operation-id check-20261019-a --authorize
python scripts/cicada-update-control.py prepare --operation-id prepare-20261019-a --authorize
python scripts/cicada-update-control.py install --operation-id install-20261019-a --authorize --version 0.0.0 --prepared-id <exact prepared_id from prepare/status>
python scripts/cicada-update-control.py receipt --operation-id install-20261019-a
```

`0.0.0` is an illustrative placeholder, not an install target. Use the exact
prepared version and ID returned by this running application's status/prepare.
The ID binds version, URL, size, hash, signature and platform version code.
No caller-provided package path, URL, safety flag, visibility, draft or lease
is accepted. Check/prepare use the existing pinned signed updater. Control install
requires the already prepared immutable package and its pinned-key-signed source
descriptor; it cannot silently replace either or accept unsigned build metadata.

Pipe name: `CicadaUpdateControl-` plus the first 32 lowercase SHA256 hex characters
of `current account SID + LF + canonical standard app-data directory.uppercase()`.
The standard directory remains stable after a profile move. One UTF-8 JSON line,
at most 4096 bytes, contains `version:1`, stable `operation_id`, `action`, and
`payload` with `authorization`, `expected_version`, `prepared_id` (unused values
are null). Mutation authorization is `user-authorized-safe-update-v1`.
Unknown/duplicate fields are rejected. Responses are bounded to 32768 bytes,
followed by LF; clients acknowledge complete read with one byte.

## Receipts and refusals

Receipts live in `update-control/operations.sqlite` under the actual private
profile, outside synchronized calendar data. The journal commits `started`
before work and `committing` before installer handoff. Operation ID plus exact
typed payload replay returns its receipt; changed payload conflicts. `started`,
`committing` and `unknown` are uncertain outcomes, never installed success.
After a lost acknowledgement, read the same receipt. The CLI does this once;
it never retries the mutation automatically. Receipt absence is still UNKNOWN
after a transport failure. At 1000 operations the bounded journal refuses more
mutations; it never evicts replay protection automatically.

Unsafe or unavailable state returns a durable `deferred` receipt with a reason.
Replaying it returns the same result; after reviewing that known refusal, use a
new explicitly authorized operation to check the now-current conditions.
Corrupt/oversized receipts fail closed. A separate durable install latch blocks
every later install operation while a prior installer outcome is unresolved.
Reconciliation verifies the signed descriptor stored at install commit, its exact
prepared tuple/version, and the source commit/build ID embedded in the actual
running Rust binary. Matching SemVer alone never clears the latch. Missing,
corrupt or mismatched evidence keeps UNKNOWN. If the original source is running,
preserve UNKNOWN and investigate via
the ordinary supported updater; neither the API nor CLI clears/retries the latch.

Control install uses all native automation guards, then rechecks immediately at
commit: production profile and executable, actual hidden/minimized unfocused
window, no active timeline, authoritative renderer draft/pending lease safe for
30 continuous seconds and refreshed within 90 seconds, exact prepared bytes and
pinned signature, and current signed feed identity. The lease is consumed while
timeline and renderer locks are held. The existing serial updater, backup,
installer rollback hooks and one normal installer restart are reused. A failed
installer handoff remains UNKNOWN, not a second launch. No restart loop is added.

## Authenticated compiled identity

The normal Windows cloud packager signs `<installer>.identity.json` using the
existing updater signing facility/key. The bounded strict descriptor contains
schema/identifier/platform, version, source commit, build ID, exact prepared ID,
installer SHA256 and size. Its detached signature covers those exact bytes.
Staging verifies the pinned signature and full installer tuple before preserving
both descriptor assets. The update service's existing release-path policy applies.
No key, trust relaxation, installer execution or NSIS parser is introduced.

Only the new control prepare path requires the descriptor; legacy explicit UI and
old signed packages remain compatible. Control install refuses old packages with
no authentic descriptor. The Rust build script embeds the Git commit; the build
ID comes from a compiled `include_str`, never a runtime JS/file/caller field.
The committed signed proof is durable across restart. Same version with another
source/build, missing compiled identity, wrong signature or prepared tuple cannot
claim completion or remove the install latch. Installer SHA and the unbundled EXE
hash are never treated as the installed EXE hash.

The separate task helper retains Cicada 15s/Agent City 3s connect waits, a 40s
total deadline, CurrentUserOnly, 64KiB/1MiB frame bounds and one-frame ACK. Its
8192-byte reader rejects an already-read trailing frame instead of discarding it.
The existing hosted fixture includes 440KiB replies within the native 3s write/ACK
deadline, split LF, limits, EOF, cancellation, malformed UTF-8/JSON and depth.

The explicit Settings install action is separate. Both legacy automatic entry
points retain their existing refusal. This source requires hosted native/Windows
transport tests, independent security review and guarded installed delivery;
source/client tests are not installed acceptance.
