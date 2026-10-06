# Cicada local tasks plugin 0.5.0

Portable publication bundle for the local Cicada task MCP package.

- `cicada-local-tasks-0.5.0/` — current self-contained plugin source;
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
