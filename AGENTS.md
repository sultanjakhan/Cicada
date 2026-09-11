# Hanni MVP

This is a new, independent repository authorized by the owner on 2026-09-10.
It has no Git ancestry or writer lock in common with the legacy Hanni repository.
Do not modify the legacy application, its repositories, data, locks or releases.

- Scope, corrected by the owner on 2026-09-11: the original Hanni Calendar workspace, with one project and its Dashboard, Table, Goals and Notes panes. Exclude Routine. Preserve upstream components, styles and interactions instead of redesigning the calendar.
- Keep personal records, backups, contacts, credentials, local paths and generated training data outside Git. Start with an empty database. Use fictional test records only.
- The integrator owns `main`. Assign writing agents distinct worktrees and file scopes; never change another worker's work. Only the integrator publishes.
- Use a unique `HANNI_SESSION_ID`. Before Git mutations, inspect branch, HEAD, status and any unfinished Git operation. Keep commits scoped and preserve foreign WIP.
- Issues are the operational source of truth. Existing Hanni planning remains in the owner's private issue repository; do not create a second backlog in Markdown.
- Validate relevant behavior with `npm test`, `npm run check:privacy`, `npm run build` and Rust tests. UI, native persistence, builds and hosted checks are different evidence levels; report them separately.
- No automatic import from legacy Hanni, remote sync, telemetry, updater, additional projects, Routine or AI in this MVP. Goals and Notes belong to the authorized Calendar workspace. Preserve records entered in earlier MVP versions through tested migrations.
- Keep this repository private until a separate publication review and license decision.
- Build and install this MVP from this repository only. The Windows identity is `Hanni MVP` / `app.hanni.mvp` / `hanni-mvp.exe`; preserve it across updates. `npm run package:windows` emits an installer and source/hash manifest from a clean commit. Install it beside legacy Hanni, with its own shortcuts and data directory.
