# Cicada local tasks 0.5.2

An independent MCP client for the existing native Cicada authority. It exposes
exactly the same seven narrow tools and contracts as 0.5.1: list, read, begin,
report, read result state, submit result, and read result receipt. It adds a
macOS Unix-domain socket transport; Windows retains its existing authenticated
named-pipe client. It exposes no generic mutation or review tool. Native UUID,
revision, run, intent and replay guards remain authoritative. Human acceptance
remains a separate decision.

The package contains no hooks, credentials, profile data or real machine paths.
Supply the explicit host configuration through CICADA_LOCAL_CONFIG or --config.
Use a Python 3 interpreter available to the MCP host. Installing this source
does not configure or start the native application.

## Windows

Keep the existing two-field configuration in config.example.json:
cicadaProfile is the original canonical endpoint profile and client is the
existing LocalPipeClient executable. Both are absolute machine paths. The
existing pipe name, native executable and transport behavior are unchanged.

## macOS

The running native application must include the matching macOS transport.
Select the existing original endpoint profile; do not substitute a discovered
database directory after a data-folder relocation. This package does not scan,
move or create profiles, databases, socket directories or connection settings.

The native listener is off when cicada-agent-access.json is absent from that
endpoint profile. To opt in, the owner supplies that existing-profile file with
exactly version: 1 and socketDirectory: an absolute canonical existing private
directory. The setup file is an ordinary current-user-owned file, mode 0600,
at most 4096 bytes; it must not be a symlink. It supports normal GUI launches
without environment-variable launch workarounds. See the repository's native
transport documentation for the complete setup and shutdown behavior.

The MCP configuration is separate and contains exactly cicadaProfile and
socketDirectory, as shown in config.macos.example.json. Both paths must already
exist, be absolute and canonical, and belong to the current effective user.
The endpoint profile and its ordinary current-user-owned calendar.db may not
be writable by group or others; the database may not be a symlink. The socket
directory must have mode 0700. Ancestors must belong to root or the current
user and may not be writable by group or others, except root-owned sticky
directories such as the system temporary directory.

The socket filename is cicada- followed by the first 32 lowercase hexadecimal
characters of SHA-256(effective UID + newline + canonical endpoint profile),
then .sock. The full UTF-8 path must occupy fewer than 104 bytes. No endpoint
path is accepted as an MCP tool argument.

Each connection requires an ordinary socket owned by the current effective
user with mode 0600, and the connected peer's UID must match through macOS
getpeereid. An unavailable credential API fails closed. One request uses one
connection, a total 45-second deadline, a 64-KiB request limit and a 1-MiB
newline-delimited response limit. There is no retry or fallback transport.
A failed exchange reports application_unavailable_or_outcome_unknown: inspect
the existing receipt before any separately authorized replay of an unchanged
mutation operation ID and payload.

## Complete task traversal

cicada_list_tasks({}) sends the original empty body and returns the native
legacy response unchanged. For complete read-only traversal, send pageSize
(integer 1–100), then pass each nextCursor as cursor until it is null.
Cursor-only calls use the native default page size. Treat the cursor as opaque.
If the queue changes during traversal, restart and deduplicate by exact UUID.
Corporate, mixed-scope and archived records remain filtered by the native API.

Pagination requires its matching native implementation (Cicada 0.5.5+).
Source and synthetic-fixture checks do not establish installed-device
acceptance. Verify MCP initialization, the seven names, a legacy read and
paginated traversal against the selected running native application separately.
Keep existing 0.4.7, 0.4.8, 0.5.0 and 0.5.1 directories immutable; this package
does not update signed application feeds, install the native application,
change credentials or accept task results.
