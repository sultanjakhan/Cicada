# Hanni MVP

This is a new, independent repository authorized by the owner on 2026-09-10.
It has no Git ancestry or writer lock in common with the legacy Hanni repository.
Do not modify the legacy application, its repositories, data, locks or releases.

- Scope: the original Hanni Calendar workspace, with one project and its Dashboard, Table, Goals and Notes panes. Exclude Routine. Use upstream components as the baseline. On 2026-09-12 the owner authorized refining the homepage layout and navigation, including a persistent shared Create action. The agreed homepage direction is selected goal, current task, other tasks today and optional daily metrics; this is product scope, not a claim that every block is implemented. A predominantly white, graphite palette is being considered; do not treat it as an already applied theme.
- Keep personal records, backups, contacts, credentials, local paths and generated training data outside Git. Start with an empty database. Use fictional test records only.
- The integrator owns `main`. Assign writing agents distinct worktrees and file scopes; never change another worker's work. Only the integrator publishes.
- Use a unique `HANNI_SESSION_ID`. Before Git mutations, inspect branch, HEAD, status and any unfinished Git operation. Keep commits scoped and preserve foreign WIP.
- Issues are the operational source of truth. Existing Hanni planning remains in the owner's private issue repository; do not create a second backlog in Markdown.
- Validate relevant behavior with `npm test`, `npm run check:privacy`, `npm run build` and Rust tests. UI, native persistence, builds and hosted checks are different evidence levels; report them separately.
- No automatic import from legacy Hanni, remote sync, telemetry, updater, additional projects, Routine or AI in this MVP. Goals and Notes belong to the authorized Calendar workspace. Preserve records entered in earlier MVP versions through tested migrations.
- Keep this repository private until a separate publication review and license decision.
- Build and install this MVP from this repository only. The Windows identity is `Hanni MVP` / `app.hanni.mvp` / `hanni-mvp.exe`; preserve it across updates. `npm run package:windows` emits an installer and source/hash manifest from a clean commit. Install it beside legacy Hanni, with its own shortcuts and data directory.
- While the owner uses the computer, run UI checks through the `hanni-mvp-ui` Playwright MCP on the isolated inactive desktop described in `docs/background-ui-qa.md`. Do not activate, restart or operate the owner's open window. Use the real installed EXE with separate QA data and WebView2 profile; never substitute a browser preview as native UI evidence.
