# Cicada local tasks plugin 0.5.2

Portable publication bundle for the local Cicada task MCP package.

- `cicada-local-tasks-0.5.2/` — opt-in macOS socket support plus preserved Windows seven-tool client;
- `cicada-local-tasks-0.5.1/` — preserved seven-tool client with optional pagination;
- `cicada-local-tasks-0.5.0/` — preserved five-tool package source;
- `cicada-local-tasks-0.4.8/` — preserved source of the previous package;
- `cicada-local-tasks-0.4.7/` — preserved source of the published package;
- `install.py` — plan/apply installer for a user-selected marketplace and
  Codex home;
- no hooks, credentials, profile data, generated receipts, or machine-specific
  paths are included.

Run the installer with explicit paths, for example:

```powershell
python .\install.py --package .\cicada-local-tasks-0.5.0 `
  --user-home $env:USERPROFILE --codex-home "$env:USERPROFILE\.codex" `
  --marketplace-root $env:USERPROFILE --manual-cicada
```

Use `--apply` only after reviewing the plan. Applying requires explicit
`--cicada-profile` and `--pipe-client` paths; the installer refuses conflicting
package, helper, or marketplace entries and is safe to repeat after success.

The plugin version is independent of the application: this instruction update
works with Cicada 0.4.7 and leaves its native API and task data unchanged. The
published 0.4.7 package is not replaced.

An existing 0.4.7 source is deliberately not overwritten by `install.py`.
`upgrade_048.py` provides a separate preview/apply path for its registered local
marketplace source: pass a machine-materialized 0.4.8 candidate, the expected
source tree SHA-256, marketplace file and Codex home. It checks source and
marketplace identity and revisions, backs up the old source, and retains the
0.4.7 cache. Run `--help` for explicit path arguments. After apply, refresh the
same plugin with `codex plugin add cicada-local-tasks@<marketplace>`. Changed or
unregistered sources are rejected; there is no recursive deletion in rollback.

## Instructions for AI clients

Connection settings make tools available. The Cicada server additionally sends
short shared task rules in MCP `initialize.instructions`. The plugin's
`cicada-task-workflow` skill contains the complete workflow: exact UUID and
revision, configured process stages, observed runs, immutable results, and human
review. These instructions guide the model; native validation enforces mutations.

For Codex, use the existing global `AGENTS.md` or a configured Agent City rule
bridge to request this skill for authorized multi-step work. For example:

> For authorized multi-step work, use cicada-task-workflow through the configured
> Cicada MCP. Find and reuse the matching task UUID before creating a task within
> the assignment. Report observed work and submit its result for human review.
> A normal question does not require a new task.

Do not copy the complete workflow into every repository. Repository-specific
instructions retain precedence. Other AI hosts need their own configured MCP
connection and supported rule location; installing a Codex plugin does not
configure another host. Client support for MCP instructions varies.

Check the plugin's installed/enabled version, MCP initialization and a real task
read separately. Refresh the plugin in a new Codex run after an update; a running
conversation may retain its previous tool/skill metadata. If an application is
unavailable, state that no write was confirmed and continue independent work.

For a registered 0.4.8 source, `upgrade_050.py` offers the same guarded
preview/apply path to 0.5.0 while preserving the 0.4.8 cache and a source backup.
The 0.5.0 package supports 64 KiB wire envelopes; result text retains the native
8000-byte limit. Keep the configured original endpoint profile after an
application data-folder move: the native pipe namespace remains stable.

## Active flat seven-tool helper

The 0.5.1 client preserves exactly the installed seven narrow tool names and
the six non-list contracts. It adds optional `pageSize` (integer 1–100) and
`cursor` to `cicada_list_tasks`. Empty `{}` requests and legacy responses remain
unchanged. No generic mutation or review tool is added. Existing 0.4.7, 0.4.8
and 0.5.0 package directories are immutable; the application version/feed is
not updated by this client-only delivery.

For a flat canonical `agent_mcp.py`, updating a marketplace/cache directory is
insufficient. The existing `upgrade_050.py` now has an explicit flat-helper
mode. Preview it with the selected installed helper, this 0.5.1 package, the
installed helper's expected SHA-256, and the reviewed candidate vendor file's
SHA-256:

```text
python upgrade_050.py --flat-helper <active-agent_mcp.py> --candidate <0.5.1-package> --expected-helper-sha256 <installed-sha256> --expected-candidate-sha256 <candidate-vendor-sha256>
```

Apply the same plan with `--apply --backup-root <new-backup-directory>`.
Only the reviewed seven-tool baseline is accepted. The helper is backed up,
staged beside the target and replaced after hash checks. Changed, unknown,
four-tool or symlink targets are rejected. Profile data, MCP configuration,
native executables, accepted relay channels and marketplace caches are untouched.

Rollback uses the exact installed candidate hash and original backup:

```text
python upgrade_050.py --flat-helper <active-agent_mcp.py> --expected-helper-sha256 <candidate-vendor-sha256> --rollback-backup <original-backup-directory> --apply --backup-root <new-rollback-backup-directory>
```

Rollback refuses newer/changed installed bytes. After installation, independently
refresh MCP metadata, check all seven names, read `{}`, then traverse with
`pageSize` and returned cursors. A successful cloud fixture check alone is not
installed-device acceptance. The native task queue must never be seeded for this
check. `fixtures/seven-tool-baseline.b64` is the supplied generic reference
source, pinned by SHA-256 in the upgrade tests; it contains no profile records.

## Opt-in macOS native transport

The 0.5.2 package adds an explicit macOS Unix-socket connection to the same
native personal-task dispatcher. It requires a matching native candidate and
an intentionally enabled machine-local grant; updating Python alone cannot
add transport to an older installed binary. Existing package directories and
Windows named-pipe behavior are preserved. Read the [configuration and installed
acceptance contract](../../docs/macos-local-tasks.md) before enabling access.
The existing Windows installer/guarded upgrade helpers are unchanged; the Mac
entry point is configured explicitly and never edits a host configuration.
