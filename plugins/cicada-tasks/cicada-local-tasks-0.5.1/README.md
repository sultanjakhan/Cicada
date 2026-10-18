# Cicada local tasks 0.5.1

An independent MCP client version for the existing native Cicada authority.
It exposes exactly seven narrow Cicada tools: list, read, begin, report,
read result state, submit result, and read result receipt. It exposes no generic
mutation or review tool. Existing result UUID, revision, run, intent and replay
guards remain native-authoritative. Acceptance remains a separate decision.

The package contains no hooks, credentials, profile data or machine paths.
Supply the existing configuration through `CICADA_LOCAL_CONFIG` or `--config`.
The configured profile determines the existing named-pipe namespace.

`cicada_list_tasks({})` sends the original empty body and returns the native
legacy response unchanged. For complete read-only traversal, send `pageSize`
(integer 1–100), then pass each `nextCursor` as `cursor` until it is null.
Cursor-only calls use the native default page size. The cursor is an opaque
keyset token; do not synthesize offsets or sort by display text. If the queue
changes during traversal, restart and deduplicate by exact task UUID.
Corporate, mixed-scope and archived records remain filtered by the native API.

Pagination requires the matching native implementation (Cicada 0.5.5+).
This client update does not require an application release. Older published
client directories and signed application feeds are unchanged.

For the active flat seven-tool helper, use the explicit `--flat-helper` route
in the existing `../upgrade_050.py`; it pins both installed and candidate bytes,
backs up the installed file and supports hash-guarded rollback. Updating a
marketplace/cache copy alone does not update that flat helper. Refresh MCP
metadata and independently check both legacy and paginated reads after install.
