# Opt-in macOS personal-task access

This route is a local Unix-domain socket from the portable seven-tool MCP client
to Cicada's existing native personal-task dispatcher. It requires a candidate
containing `agent_socket.rs`; an older installed 0.5.23 build does not acquire it
from a client update. Application version, source commit and executable hash are
separate evidence. This change neither publishes a release nor enables access.

## Machine configuration

Choose an existing current-user socket directory with a short, physical,
absolute path and permissions `0700`. Cicada does not create this directory.
The directory and its ancestors must be canonical (no symlink components).
Ancestors must belong to the current user or root and reject group/other writes,
except a root-owned sticky temporary root. The profile directory must belong to
the current user and reject group/other writes.

In the existing stable endpoint profile, deliberately create an ordinary file
named `cicada-agent-access.json`, owned by the current user with mode `0600`.
It contains exactly:

```json
{"version":1,"socketDirectory":"/absolute/canonical/private/socket-directory"}
```

The profile is the application's existing original endpoint profile. After a
supported data-folder move, retain that original endpoint profile, just as on
Windows. No profile is inferred from a task ID or copied from another device.
No configuration file means disabled. Wrong fields/version, unsafe file
permissions, symlinks, missing directories, or unsafe paths fail closed.
The opt-in file is read on application startup, including normal GUI launches;
it does not depend on a terminal environment or a replacement launcher.
Removing the opt-in file and restarting disables this route.

The grant permits same-account local processes to use the seven personal-task
operations. Review it as an access grant before enabling it. It issues no token
and changes no credentials, scheduler, remote endpoint, automation gate or
Windows pipe ownership. It does not authorize an AI to act outside the user's
assignment.

Create a separate client configuration outside the package, also preferably
mode `0600`:

```json
{
  "cicadaProfile":"/absolute/canonical/existing/stable-endpoint-profile",
  "socketDirectory":"/absolute/canonical/private/socket-directory"
}
```

Set the MCP host's explicit `CICADA_LOCAL_CONFIG` environment entry to that
configuration file, or start the packaged Python entry point with
`--config /absolute/path/to/machine-config.json`. The host launches
`python3 /absolute/path/to/cicada-local-tasks-0.5.2/scripts/cicada_mcp.py`.
There is no Windows executable dependency on macOS. This is a separate
connection; leave metadata-bound automation adapters and their guards unchanged.
The existing Windows configuration remains exactly `cicadaProfile` plus
`client`, using the existing current-user named-pipe client.

## Endpoint and failure contract

Both ends derive `cicada-<32 lowercase hex>.sock` in the configured directory.
The hex prefix is SHA-256 of the UTF-8 string
`<effective numeric UID>\n<canonical stable endpoint profile>`.
The complete socket path must be shorter than 104 bytes, including all directory
components but excluding the terminating NUL. A different UID or profile derives
a different endpoint. The socket is mode `0600`, owned by the current user,
and both sides require macOS `getpeereid` to confirm the connected peer UID.

The server preserves existing files/symlinks and live endpoints. It removes only
an unchanged current-user `0600` socket after a bounded connection explicitly
returns connection-refused. It does not remove unknown or permissive nodes.
Its own socket is removed on orderly endpoint drop; crash remnants are checked
on the next start.

Requests are a single UTF-8 JSON line, at most 64 KiB including newline; replies
are at most 1 MiB including newline. The server bounds request framing and reply
writes to 3 seconds each, and native dispatch wait to 30 seconds. A timed-out
dispatch may still commit. The Python exchange has a single 45-second total
deadline and never resends automatically. A timeout/disconnect is an unknown
outcome: preserve the operation ID and identical payload, recover using existing
native receipt/state reads, and do not fabricate success or cancellation.

The macOS ingress accepts only `list`, `get`, `begin`, `report` and the
existing `task-command` values `get`, `operation`, `submit_result`.
There is no generic invoke, shell, review/accept, archive, patch or settings
operation. All personal-scope checks, exact task UUIDs/revisions, immutable
receipts, report fields, run identity/sequence and native task completion rules
remain in the existing dispatcher.

## Verification and installed acceptance

Cloud CI checks the portable Python package and synthetic UDS failure cases,
the native macOS transport/allowlist, existing native task/report/receipt tests,
and Windows compatibility. The normal CI Mac job produces an ad-hoc-signed
`Cicada.app` candidate with embedded assets and a manifest containing the exact
source commit, application identity, executable hashes and archive hash.
No signing secrets or public service are added.

After reviewing that exact candidate, installation and machine configuration
are separate authorized actions. Preserve the existing application data and
unrelated work; no database import, reset or seed is needed. Use the normal
canonical app/launcher, then refresh the MCP connection in a new host run.
Verify all seven tool names, initialization instructions, a real personal-task
read and its current version before a write. Reuse the exact existing draft task
UUID. Confirm the returned binding instead of guessing it. Begin/report must use
stable operation/run identities and observed-only fields; user acceptance and
task completion remain separate. A cloud pass does not establish these installed
checks, profile selection, actual task linkage or unchanged user data.

## Candidate dependency prerequisite

The normal cloud audit of the unchanged base failed on DOMPurify 3.4.16 before
native tests or packaging. This candidate pins only DOMPurify to 3.4.17, keeping
the package and lockfile aligned with the [npm registry metadata](https://registry.npmjs.org/dompurify).
The upstream advisories identify 3.4.17 as patched for
[SAFE_FOR_TEMPLATES/shadow roots](https://github.com/advisories/GHSA-cg2g-xh64-v4q7),
[IN_PLACE detached-hook subtrees](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr)
and [the XHTML SMIL guard](https://github.com/advisories/GHSA-c6gr-qvv4-5v3f).
The [upstream release](https://github.com/cure53/DOMPurify/releases/tag/3.4.17)
describes the matching fixes. This records a dependency audit prerequisite;
reachability of those non-default configurations in Cicada was not established.
The normal audit thresholds remain enabled.
