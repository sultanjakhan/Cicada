# Cicada 0.4.1 — 20261002-local.1

Local Windows release candidate. No publication or automatic agent dispatch.

- Task cards preserve manual steps and results across process restarts.
- Strict Agent City run-report exchange preserves shared binding/run IDs without inventing tokens, costs or execution.
- Parent-published engineering snapshots have preview, hierarchy, provenance, timestamps and stale/unknown indicators. Unbound snapshots are visible in Tasks.
- Data sources offer a Windows folder chooser, metadata-only structure validation, applied visibility and Tasks/Projects placement. Setup/Skip appears only for genuinely new databases.
- Start explicitly describes time tracking. Jira is truthfully marked unavailable in this Windows implementation.
- Settings → About shows version and build ID. The packaging script now produces a release NSIS build, not a debug package.

The six existing calendar panes, app.hanni.mvp identity and production database
location remain unchanged. No credentials, sessions or DEV DPAPI databases move.
Snapshots are not live. Source checks do not import files or synchronize Git.
The local installer is not Authenticode-signed; the manifest records its actual
status and hashes. Installation must preserve drafts, backup data in place and
coordinate the production restart before replacing the executable.
