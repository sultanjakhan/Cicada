# Cicada local tasks plugin 0.5.0

This is a portable local marketplace package. It connects to an existing Cicada
profile through the existing Windows named-pipe client. Cicada remains the
single task authority; the plugin does not create a second task store.

## Configure one machine

1. Copy `config.example.json` to a private machine location and replace both
   absolute paths with the existing Cicada profile and `LocalPipeClient.exe`.
2. Set `CICADA_LOCAL_CONFIG` to that file, or pass `--config` when registering
   the stdio server. The package never guesses these paths.
3. Register or install the local marketplace. The package contains no hooks and
   does not change `~/.codex`, application data, or production settings.

Example direct check:

```powershell
$env:CICADA_LOCAL_CONFIG = 'C:\private\cicada-local.json'
python .\scripts\cicada_mcp.py
```

Send MCP `initialize`, then `tools/list`. Use `cicada_list_tasks` for a read
check. Mutating tools require the exact task UUID, current version, and an
explicit operation ID.

## Marketplace

`marketplace.json` in the companion marketplace directory exposes this package
as `cicada-local-tasks`. Refresh the Codex desktop app after adding that local
marketplace. Installation is separate from configuring the machine-specific
MCP connection.

The bundled MCP server is intentionally local-only. Public plugin submission
would require a public HTTPS MCP endpoint; this package is distributed as a local bundle, not an HTTPS registry plugin.

## Complete personal queue reads

`cicada_list_tasks({})` retains the legacy response and ordering (up to 100,
`tasks` and `hasMore` only). Opt in with `{"pageSize": 50}`; each response adds
`nextCursor`. Pass that string as `cursor` with the next request, until it is
null. Page sizes are integers 1–100, default 100; cursors are versioned opaque
continuations, not task identities to invent or edit. No task content is listed.

Paged reads order eligible personal task IDs by binary ascending order, independent
of mutable timestamps. Work/corporate and archived records are excluded before
the page bound. An unchanged queue is exhausted exactly once; this is a live read,
not a persisted snapshot. If tasks are inserted, deleted, archived or reclassified
during traversal, restart from the first page to discover the changed queue.
Deduplicate subsequent investigations by the real task UUID. No read changes
records, timers, review data, reports or operation receipts.

Requires the matching native application implementation and refreshed MCP tool
metadata. Updating only an installed 0.4.8 client cannot enable server pagination;
old native servers reject nonempty list bodies. Preserved 0.4.7/0.4.8 bundles are
not rewritten. This source change is not an installed-device acceptance claim.

Pagination delivery: Cicada **0.5.5+**, client package **0.5.0** from the same
release source commit, native envelope version **1**. Refresh the MCP connection
after the supported 0.4.8-to-0.5.0 upgrade; existing empty list calls remain valid.
