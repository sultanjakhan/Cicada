# Hanni MVP

Owner scope update, 2026-09-13: apply the approved goal-development prototype to
MVP DEV, including generic Hard/Soft/topic skills, evidence, stage subsets and
deadlines, plus recurring actions and rules. Exclude quantitative daily norms.
These stay inside Calendar, with no additional Routine project. New profiles are
empty; the approved matrix belongs in the owner's local data, never a shipped
seed. Settings use explicit Save/Cancel and native snapshot persistence. Preserve
existing task identity/timers when changing development focus or stages.

This is a new, independent repository authorized by the owner on 2026-09-10.
It has no Git ancestry or writer lock in common with the legacy Hanni repository.
Do not modify the legacy application, its repositories, data, locks or releases.

- Scope: the original Hanni Calendar workspace, with one project and its Dashboard, Table, Goals and Notes panes. Exclude Routine. Use upstream components as the baseline. On 2026-09-12 the owner authorized refining the homepage layout and navigation, including a persistent shared Create action. The agreed homepage direction is selected goal, current task, other tasks today and optional daily metrics; this is product scope, not a claim that every block is implemented. The owner approved a predominantly white, graphite palette for the MVP iteration. Keep Create above the scrolling content for now; its exact placement remains provisional. Do not propagate these design changes to legacy Hanni without a separate decision.
- Keep personal records, backups, contacts, credentials, local paths and generated training data outside Git. Start with an empty database. Use fictional test records only.
- The integrator owns `main`. Assign writing agents distinct worktrees and file scopes; never change another worker's work. Only the integrator publishes.
- Use a unique `HANNI_SESSION_ID`. Before Git mutations, inspect branch, HEAD, status and any unfinished Git operation. Keep commits scoped and preserve foreign WIP.
- Issues are the operational source of truth. Existing Hanni planning remains in the owner's private issue repository; do not create a second backlog in Markdown.
- Validate relevant behavior with `npm test`, `npm run check:privacy`, `npm run build` and Rust tests. UI, native persistence, builds and hosted checks are different evidence levels; report them separately.
- No automatic import from legacy Hanni, remote sync, telemetry, updater, additional projects, Routine or AI in this MVP. Goals and Notes belong to the authorized Calendar workspace. Preserve records entered in earlier MVP versions through tested migrations.
- Keep this repository private until a separate publication review and license decision.
- Build and install this MVP from this repository only. The Windows identity is `Hanni MVP` / `app.hanni.mvp` / `hanni-mvp.exe`; preserve it across updates. `npm run package:windows` emits an installer and source/hash manifest from a clean commit. Install it beside legacy Hanni, with its own shortcuts and data directory.
- While the owner uses the computer, run UI checks through the `hanni-mvp-ui` Playwright MCP on the isolated inactive desktop described in `docs/background-ui-qa.md`. Do not activate, restart or operate the owner's open window. Use the real installed EXE with separate QA data and WebView2 profile; never substitute a browser preview as native UI evidence.
- On 2026-09-12 the owner chose native DEV as the current design surface. Run Tauri with Vite and separate `HANNI_MVP_DATA_DIR` / `WEBVIEW2_USER_DATA_FOLDER`; the current machine-local launcher and evidence are under ignored `.local/dev/`. DEV checks may attach to its real WebView2; label this as DEV, not installed-release proof. Create is one labelled action directly below the static 28px Calendar title/icon, aligned left in its own fixed row above the pane tabs; there is no second sidebar Create action. It opens the shared Task/Event form; goal creation stays in Goals. Repeated active navigation must preserve the current pane and scroll. Settings use the two-line sliders icon and open in a native modal over the workspace, close through X/Escape/Done and acknowledge saves before changing the selection. First day applies on close; default view applies at the next app start. The homepage opens task and goal details from their titles, shows the linked task's subgoal path, and switches Today/All below the heading within one task list. Today excludes the task already shown in Now; All includes it and excludes completed tasks. Parent goal summaries include linked records from their subgoals. Keep Now's execution identity and occurrence intact while refreshing edited record fields.
