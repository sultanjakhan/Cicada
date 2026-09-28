# Cicada

Owner choice, 2026-09-28 (credential repair): use a protected storage design
without a paid Apple Developer account. Prove update continuity and deny
unapproved local clients before deployment. This does not authorize plaintext
credentials, all-application Keychain access, or replacing the working app
before its saved connections can be preserved or explicitly migrated.

Owner correction, 2026-09-28 (credential continuity): ordinary updates must
preserve saved connections and the existing task/time/settings profile. Repeated
token entry is an update defect, not the normal release workflow. A database
backup does not prove access to Keychain credentials after replacement. Verify
two distinct builds and a restart before claiming update continuity; keep the
working installed app until that transition is established.

Owner correction, 2026-09-28 (after the Jira Today preview): show current work
in one list with a count matching its visible rows. Do not move one selected
task above the list or recommend new work while started work is present.
Preserve per-task stages, time and execution controls. Time means actual work:
explicit Start confirms Jira and starts that task's timer; imported In Progress
tasks remain idle until the owner presses Start. Import never starts clocks.
The Dashboard shows one timer per task: total actual work across every session
and day, including the running session. Pause adds no time; changing the internal
stage never resets this total. Keep stage breakdown in task details/tooltips,
not a second timer in the current-work list. See docs/task-time-and-recommendations.md.

Owner approval, 2026-09-28 (unified process settings): keep project status rules,
their visibility and optional process templates in general Cicada settings under
«Процессы задач», replacing «Этапы задач». Do not add a main workspace pane.
The same editor serves Work/project and Personal contexts; Connections keeps
credentials, health and a link to this editor. Show every Jira project status,
including empty/unmapped statuses, and preview destinations from the draft rules.
Task cards change an individual task's status/stage/process; project settings
change defaults and templates. Existing-task assignment remains explicit.

Owner repair approval, 2026-09-28: restore the installed Cicada background update
agent after a macOS Launch Constraint Violation. Validate actual launch state,
not merely registration. Preserve the app identity and OS security constraints;
never weaken launch constraints or repeatedly retry a denied launch.

Owner continuation, 2026-09-28: Jira project status meanings are explicitly
configured by the owner, never inferred from Jira categories or status spelling.
The working queue includes ready and working tasks; review, completed and other
statuses remain accessible through filters. Already running timers stay available
even after an external status change. Explicit Start/Finish/Send to review first
confirms Jira, then changes only that task's local execution; a stage arrow does
not change Jira. Processes remain optional: a project may assign a default to new
tasks, and each task may choose another process, no process or a subset of stages.
Existing tasks receive a project process only through an explicit bulk choice.
Stage history and time survive changes to templates and selected stages.

Текущее display name независимого продукта — `Cicada`, канонический репозиторий —
`https://github.com/sultanjakhan/Cicada`. Остальной интерфейс остаётся на русском;
технические идентификаторы, ключи, package/bundle IDs и лицензии не переименовывать.

Owner release request, 2026-09-28: prepare and publish Cicada 0.4.0 from the
accepted DEV work. The Today heading has its settings icon on the left and opens
only next-action selection settings. General application settings remain in the
sidebar. Task processes stay optional; automated process assignment or per-task
stage filtering needs an explicit product rule, not a hidden heuristic.

Owner correction, 2026-09-28: use current skills from the active catalog;
archived skills are historical material, not active instructions. For UI changes,
verify the agreed behavior and composition with `qa-acceptance`; use
`clear-writing` when editing interface copy.
Show the complete relevant scenario and make the primary action, stage and time
meaning clear. Passing tests or absence of overflow is not visual acceptance.
Preserve agreed workspace widths and controls; do not substitute decorations for
information hierarchy. A small copy fix does not require a full design audit.
The Today work focus shows one task and its current stage at a time. Selection
does not pause or finish other running tasks. The stage arrow advances the stage;
start/pause and task completion remain separate actions. Goals may have separate
subtasks; this does not make a task stage an independently completed subtask.

Перед новой постановкой прочитай [подтверждённый контекст продукта](docs/product-context.md), затем проверь исходный код и относящиеся к задаче Issues. Не повторяй вопросы, на которые уже есть ответ в этом контексте; уточняй только новые отсутствующие факты.

Owner continuation, 2026-09-27 (Today completion): recommendation settings open
from the Today heading; remove the footer Settings and All Tasks links. A confirmed
terminal routine returns the inline surface to the existing recommendation or empty
state without starting anything. Defer the policy for empty Today, overdue/undated
work and rest/sleep to private product Issue #107; do not change ranking for this fix.

Owner continuation, 2026-09-27 (workspace controls): restore a dedicated Routines
pane after Tasks, reusing existing routine records, execution and editors. Keep
one shared Create entry, including Wishes and Routines; remove duplicate New Note
and New Goal/Wish buttons in their panes. Preserve note drafts and explicit starts.
Distinguish Create from Start visually, make task/routine choices easy to reach,
and keep the selected main goal clearly marked. The separate goal below Today
was accepted. This supersedes the older no-Routines-pane directions below.

Owner continuation, 2026-09-27: keep the main goal in a separate widget; the DEV
candidate places it below Today at matching width. Connect task recommendations to their existing goal/subgoal
and stage; waiting tasks lead to review, never an implicit start. Import the
owner's saved legacy routine chains into the isolated DEV only, keeping personal
exports outside Git and the legacy source read-only. Preserve branching and
check/track steps; launches stay explicit. This is not an authorization to copy
legacy credentials/history or install over production.

Owner approval, 2026-09-27 (later): implement one coherent Today dashboard with
one date, a compact goal context, one explained task/routine recommendation and
controls for running work. Full task lists and paused-today work belong in Tasks.
The shared Start picker includes routines. Recommendations use current time and
existing records; routines do not require fixed times. No invented user routines,
inferred location/hunger, autonomous starts or silent pauses of parallel work.
Offer explicit feedback and minimal recommendation settings. The approved task
card keeps stage choice and time accessible, collapses time history and moves
goal/date/process editing to Edit. Keep the inline next-stage arrows in lists.
This supersedes the older routine deferral and Edit-only stage rule below.

Owner correction, 2026-09-27: keep the current-task widget aligned to the full
dashboard width. Restore the inline next-stage arrow; the stage label is text,
and arbitrary stage selection remains in task details -> Edit -> Stage. Remove
the Tasks quick-add row because the shared Create already exists. Keep overdue
tasks in Tasks, defer routine changes, and discuss daily remaining/minimum counts
before implementing them. This supersedes the inline stage menu and quick-add
directions below; see docs/product-context.md.

Owner iteration, 2026-09-25: stages belong only to tasks with a process. The
built-in process «Системный анализ» has Понимание, Требования, Анализ и модели,
Описание, Согласование, Декомпозиция, В разработке, Приёмка; processes and
their stages are edited in Calendar settings («Процессы задач», synced key
`calendar_processes_v1`; devices on 0.3.33 or older pause receiving sync once
a process record exists, until they update). The stage moves forward with a
«→» button; the label opens the menu. Stage changes are logged as
`task-stage-log:<stage>@<UTC>` tags and time per stage is shown in task
details. Work and non-work tasks are split: «Все · Работа · Личное» in Tasks,
«Работа»/«Личное» sub-headings in «В работе», and «Рабочая / Личная» first in
the task dialog. The widget clock ticks as mm:ss against the estimate.

Owner iteration, 2026-09-24 (evening): the header current-task block is removed
on every tab; the header shows only a green «● N» indicator while tasks run,
opening the «В работе» widget. Widget rows show time against the estimate,
the work stage and the goal, with «Остановить» (hide until started again,
per device) and «Отменить запуск» (deletes the running block). Tasks carry an
optional stage (Понимание, Требования, Описание, Согласование, Декомпозиция,
В разработке, Приёмка) and «Жду ответа», stored as tags. The Tasks pane
splits Все/Работа/Дом/Другое, keeps running tasks in «В работе» on top,
offers bulk actions for overdue tasks, grouping by date or goal and a
quick-add line.

Owner iteration, 2026-09-24 (private issue #104): the owner often works on
several tasks at once. Starting a task never pauses other running work; the
same source never gets a second running block. The Dashboard shows an «В работе»
widget before the main goal with every running task and tasks paused today,
each with its own time, pause/resume, «Готово» and menu. With two or more
running tasks the header shows «В работе: N». This supersedes the 2026-09-20
«no second dashboard widget» rule and the 2026-09-22 removal of the dashboard
current-task card. Parallel blocks overlap, so time sums can exceed real time.

Owner iteration, 2026-09-23 (mobile and Tasks; private issues #94, #95): on
the phone the Calendar header and drawer show no Cicada logo and the section
name appears once. «Сегодня», the date and the day-start state share one line.
Create and Start stay above the scroll in one compact row. The Day/Week grid
scrolls with the pane instead of a nested window; Week shows three days per
screen. The Tasks pane groups Просрочено/Сегодня/Скоро/Без даты with one-line
rows and icon actions. Desktop keeps its layout.

Owner direction, 2026-09-23 (planned; each item needs its private issue and is
not implemented by this note): task kinds instant/normal, sphere and time of day
(#96); one Create for task, event, goal, note and wish (#97, supersedes goal
creation only in Goals); goals in three display levels — dashboard title and
current stage, list, full popup (#98, supersedes the 2026-09-14/20 rules that
keep the full goal on the dashboard without an Open action); wishes kept apart
from goals (#85); a day strip with sleep, steps, self-reported energy, focus
minutes and a personal benchmark computed from own data (#99, lifts the
quantitative-norm exclusion for this benchmark); routine unlock branches from
legacy Hanni and household quick actions (#100); read-only Jira PL import with
analyst stages (#101); LLM quick input and suggestions confirmed by the user
(#102); an Android home-screen widget (#103). These supersede the matching
exclusions in the scope list below.

Owner iteration, 2026-09-21 (Calendar), integrated 2026-09-22: remove Calendar
List mode, its adjacent planning task panel and the neighboring date labels;
retain day/week/month navigation and existing records. Interpret a saved List
preference as Month without rewriting it on read. Use a calm white/graphite grid
and keep header/date controls usable in narrow windows. This supersedes the
earlier instruction to retain Calendar List mode. The header launcher and brand
size follow the later 2026-09-22 decision in the product context; there is no
Routines header action (routines stay in the dashboard/settings manager).
Important tasks use a text label without a flag icon. Missing routines must be
diagnosed at their source; do not ship or invent user routine data. Local UI
checks do not establish installed native acceptance.

Owner authorization, 2026-09-21: make automatic updates work for the installed
macOS MVP too. Extend the existing signed channel and idle/hidden installation
rules, preserve the profile, and verify a real installed version upgrade. Keep
local models stopped and use CI for heavy builds on this Mac session.

Owner handoff, 2026-09-21: publish the accepted task-execution checkpoint so the
owner can continue on Mac. Use `work/execution-ux-20260920-8bf4`; main integration
and release are still separate. The sending Windows session stops writes to
this checkpoint after publication. The receiving session checks local WIP,
remote HEAD and ownership, uses its own HANNI_SESSION_ID and preserves other
worktrees. This does not transfer legacy Hanni or authorize overwriting an
existing checkout. See [Mac handoff](docs/mac-handoff-20260921.md).

Owner authorization, 2026-09-20: implement the reviewed task-execution and compact
goal package (private issues #84, #88–93). Put the current task before the goal
summary and expose Start/Resume/Pause on existing task lists. Reuse task identity
and timeline records. Repeating entries may be checkmarks, runnable activities,
or ordered step chains. Keep them in the existing Calendar routine manager;
do not add a placeholder project or a second dashboard widget. No mandatory
countdown, automatic next step, or automatic restart. Preserve a return to the
previous unfinished task. All routine titles and steps come from user data.

Owner correction, 2026-09-20: compact the complete goal view and its editors.
Preserve all goal information and the existing stage filters; do not replace
them with a brief summary that hides the remaining content. Avoid nested
disclosures around the skill text. Today uses compact separate groups; its
duplicate Add action is removed. These are product decisions, not a claim
that a candidate has been integrated, installed, or verified on every device.

Owner authorization, 2026-09-16 (open source): publish this independent MVP
under MIT, retaining third-party licenses and attribution. Keep the previous
GitHub repository, build logs and artifacts in a private archive. Publish only
the sanitized history and reviewed release assets at the canonical Cicada URL.
Do not merge or push old branches from before this cleanup; transfer reviewed
diffs onto a fresh main. Personal data and sync credentials remain outside Git.

Owner authorization, 2026-09-16 (unattended updates): extend the existing signed
Windows/Android update channel to download and install without routine clicks,
including scheduled checks while the app is closed. Preserve signatures, app
identity, data and backups. Defer installation while the user is editing or using
the visible app. Android must respect a system request for user confirmation and
report it honestly. This supersedes the explicit-install-only restriction below.
The owner authorized implementation, signed delivery and preserved-data device
verification; unavailable devices remain an explicit acceptance limit.

Owner authorization, 2026-09-16: add signed application updates for Windows and
Android through an authenticated channel. Keep the stable Android signing key,
preserve application identity and data, and back up before installation. Android
uses the system confirmation screen. Check automatically, but restart/install
only after the owner's update action. This supersedes the updater exclusion below.

Owner iteration, 2026-09-16: add the Tasks pane and use the order Dashboard,
Calendar, Tasks, Notes, Goals. Do not show a Routine placeholder. Keep the
Calendar List mode until the owner tests on the phone. The collapsible planning
panel shows undated tasks and assigns a day to the same task (no event copies
or timer changes). Task scheduling currently has a date only; do not pretend
that dropping on an hour assigns a planned time. Keep the homepage presentation.

Owner correction, 2026-09-15: simplify the homepage goal card to the current
development topic/skill and explicitly labelled whole-goal skill progress.
Remove the separate current-stage summary, duplicate topic and decorative focus
icon there. Keep stage selection, skill subsets and deadlines in goal details.
The homepage skill picker still respects the active stage; changing focus must
not start or replace the current task. This supersedes the full-width stage
section requirement below.

Owner scope update, 2026-09-14: fix Android system-inset overlap, package a stable
Mac application, add review/resolution of synchronization conflicts, and adapt
Hanni's safe checkpoint/journal compaction. Preserve offline-device recovery.
Keep the working DEV window minimized or on its inactive desktop; permission
to update/test does not permit moving or focusing it. Stable and DEV profiles
must use distinct sender identities when both continue synchronizing.

Owner scope update, 2026-09-14: implement synchronization between MVP devices,
including the started day, by adapting the existing Hanni encrypted content
relay before introducing a replacement. Use an independent MVP protocol profile,
relay namespace and credentials. Preserve existing local records through tested
migrations. Reusing source does not authorize accessing or changing legacy Hanni
data, credentials, deployments or writer locks. Validate with isolated replicas;
unavailable Windows/phone devices are a separate acceptance limit. The earlier
exclusion of remote sync below is superseded by this authorization.

Owner scope update, 2026-09-13: apply the approved goal-development prototype to
MVP DEV, including generic Hard/Soft/topic skills, evidence, stage subsets and
deadlines, plus recurring actions and rules. Exclude quantitative daily norms.
These stay inside Calendar, with no additional Routine project. New profiles are
empty; the approved matrix belongs in the owner's local data, never a shipped
seed. Settings use explicit Save/Cancel and native snapshot persistence. Preserve
existing task identity/timers when changing development focus or stages.

Owner correction, 2026-09-14: preserve the approved v7 dashboard presentation
when transferring prototype logic. The goal summary uses a full-width stage
section and an expanded topic/skill focus, without a nested summary card or an
extra Open action. Focus selection opens directly from the homepage. Keep one
Today card containing native tasks and scheduled actions/rules; do not invent a
separate Actions and rules dashboard section. Quantitative norms remain excluded.
The day-start acknowledgement has no Undo start button. These decisions override
older dashboard descriptions below; preserve existing records and task execution.

MVP handoff, 2026-09-14: the owner is continuing from Mac. The Windows session
stops repository writes after pushing this checkpoint. The receiving session
must inspect its local WIP and remote main, use its own HANNI_SESSION_ID, and
preserve foreign changes. This handoff concerns this independent MVP only;
it does not transfer the legacy Hanni canonical or its locks. See README for
the local-data boundary and the compact goal-card proposal, not yet implemented.

This is a new, independent repository authorized by the owner on 2026-09-10.
It has no Git ancestry or writer lock in common with the legacy Hanni repository.
Do not modify the legacy application, its repositories, data, locks or releases.

- Scope: the original Hanni Calendar workspace, with one project and its Dashboard, Table, Goals and Notes panes. Exclude Routine. Use upstream components as the baseline. On 2026-09-12 the owner authorized refining the homepage layout and navigation, including a persistent shared Create action. The agreed homepage direction is selected goal, current task, other tasks today and optional daily metrics; this is product scope, not a claim that every block is implemented. The owner approved a predominantly white, graphite palette for the MVP iteration. Keep Create above the scrolling content for now; its exact placement remains provisional. Do not propagate these design changes to legacy Hanni without a separate decision.
- Keep personal records, backups, contacts, credentials, local paths and generated training data outside Git. Start with an empty database. Use fictional test records only.
- The integrator owns `main`. Assign writing agents distinct worktrees and file scopes; never change another worker's work. Only the integrator publishes.
- Use a unique `HANNI_SESSION_ID`. Before Git mutations, inspect branch, HEAD, status and any unfinished Git operation. Keep commits scoped and preserve foreign WIP.
- Issues are the operational source of truth. Existing Hanni planning remains in the owner's private issue repository; do not create a second backlog in Markdown.
- Validate relevant behavior with `npm test`, `npm run check:privacy`, `npm run build` and Rust tests. UI, native persistence, builds and hosted checks are different evidence levels; report them separately.
- No automatic import from legacy Hanni, remote sync, telemetry, updater, additional projects, Routine or AI in this MVP (later owner decisions above re-scope sync, updater, routines, Jira import and AI). Goals and Notes belong to the authorized Calendar workspace. Preserve records entered in earlier MVP versions through tested migrations.
- Public source is MIT for Hanni-owned code; third-party terms remain unchanged. Run `npm run check:history` before publishing refs. Enable `.githooks` locally. Never republish pre-cleanup history.
- Build and install Cicada from this repository only. The Windows technical identity remains `app.hanni.mvp` / `hanni-mvp.exe`; preserve it across updates. The visible product name and public artifact are `Cicada`. `npm run package:windows` emits an installer and source/hash manifest from a clean commit. Install it beside legacy Hanni, with its own shortcuts and data directory.
- While the owner uses the computer, run UI checks through the `hanni-mvp-ui` Playwright MCP on the isolated inactive desktop described in `docs/background-ui-qa.md`. Do not activate, restart or operate the owner's open window. Use the real installed EXE with separate QA data and WebView2 profile; never substitute a browser preview as native UI evidence.
- On 2026-09-12 the owner chose native DEV as the current design surface. Run Tauri with Vite and separate `HANNI_MVP_DATA_DIR` / `WEBVIEW2_USER_DATA_FOLDER`; the current machine-local launcher and evidence are under ignored `.local/dev/`. DEV checks may attach to its real WebView2; label this as DEV, not installed-release proof. Create is one labelled action directly below the static 28px Calendar title/icon, aligned left in its own fixed row above the pane tabs; there is no second sidebar Create action. It opens the shared Task/Event form; goal creation stays in Goals. Repeated active navigation must preserve the current pane and scroll. Settings use the two-line sliders icon and open in a native modal over the workspace, close through X/Escape/Done and acknowledge saves before changing the selection. First day applies on close; default view applies at the next app start. The homepage opens task and goal details from their titles, shows the linked task's subgoal path, and switches Today/All below the heading within one task list. Today excludes the task already shown in Now; All includes it and excludes completed tasks. Parent goal summaries include linked records from their subgoals. Keep Now's execution identity and occurrence intact while refreshing edited record fields.
