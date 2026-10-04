# Combined Dashboard / localization source candidate

Source baseline: 80fc325aba10c54f357a4111003238ea3f964ee0. Retained dashboard commit: 29beb1df8881d0f0c971200028417b4c6d73fb5d. Retained localization commit: 9452a6f18f1f178fe619e19a486b81d49f421da5 (includes 6669125, 9308a99, 5faf85c and the own-key lookup correction). Combined in a separate integration worktree by a no-ff merge, no conflicts. Source gate results do not substitute for independent localization closure or native visual acceptance.

## Today theme placement

The existing theme button sits immediately to the right of the upper Today control ([data-calendar-running] [data-header-action="in-progress"]) in the workspace header, outside the Today body. Its identity, event handler, accessible label, saved hanni_theme preference and external theme-change listener stay intact. The same upper control group remains in the shared workspace header on other panes. This adds no preference key or native command. DOM tests exercise the same button after relocation, including persisted dark preference, click toggle and cleanup.

## Start / finish day assessment — recommendation only

Current day banner reads calendar_day_start_v1 and invokes start_calendar_day only on explicit click. The backend mvp_sync_db::start_day transaction checks the local day before appending a UUID/UTC start marker and returns the ledger. It does not start timers, finish tasks or clear unfinished work. Existing acknowledgement is displayed as a disabled started-at button; no reset/finish-day action exists in this surface.

Recommendation: keep the compact day-start acknowledgement secondary beside the date, reducing competition with the actual work action. Do not relocate the badge or change behavior in this candidate beyond the requested theme-button position. A Finish Day affordance is useful only as optional factual review/reflection (what finished, what remains, observed time where available). It must not invent mandatory state, automatically stop timers, accept AI results or complete outstanding tasks. That product decision and persistent schema are outside this source repair; no finish-day implementation is included.

## Portable actual-component QA fixture

Run node scripts/build-dashboard-component-preview.mjs from the repository root. It reads the actual Today markup from calendar-workspace.js and bundles the real mountCalendarDayBanner, mountCalendarTodayAction, mountCalendarInProgress, mountDashboardWorkViews, mountDashboardAiWork and theme components with existing CSS. Output: ignored .local/dashboard-component-preview/today-component-fixture.html. The file contains its CSS and JavaScript and can be transferred as a standalone QA fixture.

Controls select desktop (1100px) or narrow (360px), light/dark, personal/AI, and reports/empty/error/loading/no-source states. All records, goals, task/run IDs, report timestamps, result versions and commands are synthetic and in-memory; no application/API/MCP connection or real dataset. Interaction never launches an executor. This is not the separately requested product mockup or a replacement for native visual acceptance.

Source/DOM tests validate component mounts, associated tabs, synthetic-only reads, error/empty states and theme relocation. Browser rendering, narrow-screen visual inspection and screenshot comparison: NOT RUN. No supported browser or computer-use surface is available; no alternate launch route used. No installation, native GUI, publication or production data writes.

Native/API/MCP/Agent City bindings and default-disabled review are unchanged. The exact AI-data dependency and before/after source coverage remain in DASHBOARD-TODAY-AI-SOURCE-FIX.md. Existing unfinished tasks are retained. Localization source strings are preserved as merged, no dictionary/contract changes added by integration.

## Finite independent design corrections

DQA-001: Today scope-switch selectors now deliberately outrank the later base scope styles, including mobile display, full-row width and button padding. The independent production-order CSS sample now computes margin 0 0 18px; narrow declarations are verified via CSSOM. This is source/style evidence, not 360px layout acceptance.

DQA-002: native report summary declares border-box minimum height 44px, preserves list-item marker, focus and repeated native disclosure toggle. Actual pointer hitbox, keyboard Enter/Space sequence and contrast remain visual/browser NOT RUN.

DQA-003: tag spans explicitly wrap anywhere, allow normal whitespace and stay within 100% width without truncating or changing Unicode user content. A >200-character unbroken Unicode tag is covered by DOM/computed-style tests and the same actual-component fixture. Actual 360px/200%-zoom reflow and horizontal overflow measurements remain NOT RUN.

Scope after branch division: presentation and interaction only. API/MCP/Agent City task registration/status/binding/transport and phone updater remain owned by the user's separate task. No schema or native source edits. Portable fixture now includes 1100px and 360px viewports and a long-content scenario, while retaining the original components and synthetic-only data. No new product mockup, desktop GUI or installation.

## Latest confirmed hierarchy correction

Theme belongs immediately right of the existing upper Today navigation control, not in the day banner. Shared header contains data-calendar-today-controls with the original data-calendar-running control followed by the original theme button. This preserves its saved preference/accessible label and keeps Calendar as navigation, without creating a project.

AI switching belongs only to the task widget labelled Tasks Today. The widget reuses mountCalendarDashboardTasks (calendar-task-overview) with its existing Today/All filters and native records; its personal and AI panels are children of data-calendar-task-widget. Recommendation data-calendar-next-action, current work data-calendar-in-progress and day banner stay outside the switch and remain visible when AI is selected. Choosing tasks in the existing recommendation picker focuses this same task widget instead of constructing a duplicate task list. No registration/status schema, source binding or transport change.

No Rhythm Day section, Finish Day state or additional day ritual is created. Existing Start Day remains in its current day-banner location; future summary/Finish Day is only an assessment, sharing that location if later authorized. Existing unfinished tasks remain unchanged.

Actual-component fixture now includes the real upper Today control via mountCalendarNow, its bundled existing Markdown/highlight/sanitizer dependencies, and the actual daily task list. Existing UI preference writes stay synthetic/in-memory inside the fixture; task/timer/executor mutations are disabled. Visual/native/browser acceptance remains NOT RUN.
