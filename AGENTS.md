# Hanni MVP

This is a new, independent repository authorized by the owner on 2026-09-10.
It has no Git ancestry or writer lock in common with the legacy Hanni repository.
Do not modify the legacy application, its repositories, data, locks or releases.

- Scope: a local calendar with tasks and events, one shared editor, grid and list views.
- Keep personal records, backups, contacts, credentials, local paths and generated training data outside Git. Start with an empty database. Use fictional test records only.
- The integrator owns `main`. Assign writing agents distinct worktrees and file scopes; never change another worker's work. Only the integrator publishes.
- Use a unique `HANNI_SESSION_ID`. Before Git mutations, inspect branch, HEAD, status and any unfinished Git operation. Keep commits scoped and preserve foreign WIP.
- Issues are the operational source of truth. Existing Hanni planning remains in the owner's private issue repository; do not create a second backlog in Markdown.
- Validate relevant behavior with `npm test`, `npm run check:privacy`, `npm run build` and Rust tests. UI, native persistence, builds and hosted checks are different evidence levels; report them separately.
- No automatic import from legacy Hanni, remote sync, telemetry, updater, projects, goals or AI in this MVP. Add scope only when requested.
- Keep this repository private until a separate publication review and license decision.
