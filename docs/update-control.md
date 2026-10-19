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
requires the already prepared immutable package; it cannot silently replace it.

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
Only the actually running exact target version reconciles that latch to complete.
If the original version is still running, preserve UNKNOWN and investigate via
the ordinary supported updater; neither the API nor CLI clears/retries the latch.

Control install uses all native automation guards, then rechecks immediately at
commit: production profile and executable, actual hidden/minimized unfocused
window, no active timeline, authoritative renderer draft/pending lease safe for
30 continuous seconds and refreshed within 90 seconds, exact prepared bytes and
pinned signature, and current signed feed identity. The lease is consumed while
timeline and renderer locks are held. The existing serial updater, backup,
installer rollback hooks and one normal installer restart are reused. A failed
installer handoff remains UNKNOWN, not a second launch. No restart loop is added.

The explicit Settings install action is separate. Both legacy automatic entry
points retain their existing refusal. This source requires hosted native/Windows
transport tests, independent security review and guarded installed delivery;
source/client tests are not installed acceptance.
