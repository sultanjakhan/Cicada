# Background UI checks on Windows

Use Microsoft's [Playwright MCP](https://github.com/microsoft/playwright-mcp),
attached to the **real WebView2 inside the installed MVP** using its
[documented CDP connection](https://playwright.dev/docs/webview2).
This checks the embedded frontend and real Rust/SQLite commands. It is not a
Vite preview and does not mock IPC.

`scripts/qa-background.py` only manages the processes. It starts the verified
installed EXE on a separate, inactive Windows desktop through
[`STARTUPINFO.lpDesktop`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow).
It never switches desktops or sends global keyboard/mouse input. The currently
open application is neither restarted nor automated.

## Prerequisites and connection

- Windows, Python 3.11+, Node.js, and the installed WebView2 runtime.
- Python packages `pywin32` and `psutil`.
- The MVP package built with `npm run package:windows`: a debug binary containing
  its embedded web assets and `HANNI_MVP_DATA_DIR` support. Release builds are not
  supported by this launcher. Verify the installed EXE hash against the package
  before adding it to the local MCP configuration.
- Install the official server locally, without downloading another browser:

```powershell
npm install --prefix .local/playwright-mcp --ignore-scripts --no-audit --no-fund --save-exact @playwright/mcp@0.0.80
```

The local Codex server is named `hanni-mvp-ui`. Its stdio command is Python with:

```text
-B scripts/qa-background.py
--exe <absolute installed hanni-mvp.exe path>
--expected-sha256 <verified installed EXE SHA256>
--mcp-cli <absolute .local/playwright-mcp/node_modules/@playwright/mcp/cli.js path>
--node <absolute node.exe path>
```

Use absolute paths in the machine-local config; do not commit that config.
The launcher verifies binary identity, starts the background instance, verifies
the loopback CDP listener belongs to its child WebView2, and delegates stdio to
the unmodified official MCP. Client disconnection closes the background app and
its children through a Windows job object. Startup timeout is 60 seconds.

Each connection gets fresh SQLite and WebView2 directories under the ignored
`.local/background-qa/` directory. For an explicit restart/persistence test,
reuse `--session <qa-name>`; a Windows file lock prevents concurrent use.
An explicit `--probe` checks launch/isolation and exits without starting MCP.
`runtime.json` records executable identity, app/child PIDs, CDP endpoint and
whether the QA desktop became active during the session.

## Operating limits

- Use snapshot, scoped click/type/select/key actions, page screenshots, console
  and network logs against the single `http://tauri.localhost/` page.
- Do not select/new/navigate browser tabs, upload files, open external URLs,
  invoke native focus/show, use the clipboard or call `bringToFront`.
- Screenshots show only the app's WebView content; they do not include the title
  bar, the Windows desktop, other applications or native file pickers.
- Keep test records fictional. Retain them in the isolated QA profile only as
  long as needed for restart evidence; never import the user's database/profile.
- The CDP port is chosen per connection and verified to listen on loopback only.
  It remains open only while this background instance is running.
- After an application update the EXE hash check deliberately stops launch.
  Verify the new package's debug isolation support and refresh the local pin.
- A successful connection does not establish complete product acceptance.
  Report individual UI scenarios and observed bugs separately.

## Verified setup, 2026-09-12

Installed MVP 0.2.1, source `df4a19b2b65b42a96e39b2d45eaaa7d44fb6889a`:
the official MCP read all four panes, switched to Table, captured the real
WebView and created a fictional task through the UI. The task remained visible
after closing and restarting the background EXE with the same isolated profile.
The QA desktop remained inactive. These checks do not claim full visual parity.

Live inspection also found missing settings-pill styling, an ignored first-day
setting, and CSP errors blocking editor-injected styles. Their fixes and native
visual rechecks remain separate from this connection setup.

## Header creation iteration, 2026-09-12

Superseded placement: the owner selected sidebar variant A in the following
DEV iteration below. The earlier installed-package evidence remains historical.

The shared Task/Event entry now lives in the non-scrolling Calendar header.
The old general Create buttons in Dashboard and Table were removed; calendar
cell creation keeps its date/time context. Closing the shared editor restores
focus to its header button. Header icons retain their square dimensions.

One fictional goal with a long title, description, six criteria and explicit
2-of-6 progress, plus one linked 90-minute task, were created through the
installed application's Playwright MCP in an isolated profile. A SQLite backup
of those records was opened by a locally built native candidate. The persistent
design profile and screenshots are in the ignored
`.local/background-qa/header-design-20260912/` directory; these examples are
retained for the owner's requested design comparison, outside shipped data.

Validation: 102 JavaScript tests, 14 Rust tests, privacy check and both frontend
and native builds passed. Native MCP confirmed the button remains in place
when the task area scrolls, the shared Task/Event switch works, focus returns,
and Table creation retains the viewed date. At a 640-by-500 WebView viewport the
button did not overlap the title and the header icon measured 24-by-24 CSS pixels.
The candidate's Windows desktop remained inactive throughout the check.

The candidate was not installed over the owner's running application. Its
version remains 0.2.1; identify it by the source and executable hash in the local
acceptance file, not as a new public release. The predominantly white/graphite
palette remains a proposal; existing green surfaces have not been replaced.
Previously observed CSP errors remain unresolved, and system zoom at 150/200
percent was not part of this header check.

## Palette and detailed goal iteration, 2026-09-12

The owner approved a predominantly white/graphite palette for MVP. Version 0.2.2
adds one final palette stylesheet for the shell and Calendar components, including
a corresponding dark theme and neutral primary-button focus/hover states.
Missing settings-pill styling is restored. The header Create position remains
provisional. Legacy Hanni and the owner's running MVP were not changed by QA.

Native MCP created a fictional junior system analyst learning case: one root
goal with detailed acceptance criteria, five subgoals and ten linked tasks.
Five tasks use the test day, one the following day and four have no date. The
estimates and dates are demonstration inputs, not a commitment or an assessment
of the owner's career progress. The clean fixture has no completed tasks or
invented goal progress. Its SQLite backup and creation evidence remain outside
Git in `.local/background-qa/junior-palette-20260912/`.

After a real native restart, MCP verified the root description/criteria, the
six-node goal tree, collapse/expand, ten task links, and exclusion of the goal
and its descendants from its parent selector. A separate copy at
`.local/background-qa/junior-acceptance-20260912/` exercised task start, pause,
resume, pause, completion and next-task selection; only that QA copy contains
the completed task. All four panes were opened in the dark theme and both
settings themes were inspected. A final candidate at
`.local/background-qa/junior-final-20260912/` rechecked dark category-dialog
primary-button contrast. Native evidence consists of 85 creation calls, 46
acceptance calls and 12 final palette calls; these are tool calls, not a count
of independent test cases. Screenshots and pinned executable identities are
stored with these profiles. All observed QA desktops remained inactive.

Known limits: the existing CSP errors still block editor styles and category
swatch inline backgrounds (the swatches appear white). This palette change
does not alter that CSP or semantic color values. Calendar first-day/default-view
settings behavior is not repaired by styling its controls. System zoom at
150/200 percent, native window chrome and file pickers are not covered. Detailed
goal criteria are available in Goals/editing, not all on the homepage. This is
native candidate evidence, not a claim that the owner's installed application
has already been updated. Packaging/install results belong in the local hash
manifest and acceptance record.

## Native DEV homepage iteration, 2026-09-12

The owner requested changes in the running native DEV rather than another
installer. Vite serves the frontend to a debug Tauri host with its own SQLite
and WebView2 directories. The machine-local `.local/dev/` launcher, profile and
hot-reload proof are ignored; they contain no import from the owner's installed
profile. The helper console stays hidden. Only an explicit DEV launch opens its
window; subsequent acceptance clicks/resizes use another inactive desktop.

The Calendar icon and heading now share a center line; the redundant default
description is omitted from the header without deleting stored metadata.
Create sits beside the four pane buttons outside the scroll area. The main goal
opens from its title, has a quiet Change action, and shows the current task's
actual descendant path when it belongs to the selected goal. Missing/cyclic or
unrelated paths are not presented as part of that goal. The Now card and timer
flow are unchanged. Settings uses a simpler adjustment icon.

Today and All are mutually exclusive views of one inline task list. Today shows
every other incomplete task assigned to the local day (50 rows per page for
large lists). All also includes the current task and tasks on other dates or
without a date. The five-task fixture now shows all five Today rows; the old
three-row preview and extra-count button are removed. Repeated Today dates are
replaced with available duration estimates. Row details and context actions
keep their original handlers.

Validation: 106 JavaScript checks, frontend build and privacy guard passed.
Focused cases cover filtering, counters, pagination, completion refresh and safe
goal paths. Native DEV MCP checked the real linked fixture, both list views,
task/goal detail closing and focus return, goal picker cancellation, settings
return, sticky creation and 24-by-24 icons at a 640-pixel viewport. Light and
dark screenshots are retained in ignored
`.local/background-qa/home-ux-20260912/`. Its desktop remained inactive. No
installer or backend change is part of this iteration; the earlier packaged
CSP and Calendar settings limits remain separate.

## Sidebar creation and modal settings, 2026-09-13

The chosen DEV variant places one 44px Create button in the left rail, separated
from navigation. The mobile drawer gives it a visible label. The Calendar title
and icon are static, aligned at 28px. Clicking the active Calendar sidebar item
or active pane no longer reloads its content.

Settings now use the shared native dialog shell and retain the underlying pane,
selected date and scroll. Close with X, Escape or Done; focus returns to the
settings trigger (the visible menu opener on mobile). Pending saves block
closing, failure preserves the prior selection, and loading can be cancelled
without a late response reopening the dialog. The familiar gear icon replaces
the adjustment sliders. No additional projects or settings categories were added.

The previously ignored first-day and default-view preferences are now wired to
Calendar. Sunday/Monday affects both the queried range and week/month grid.
First day applies after closing settings; the startup view does not replace the
current view and applies at the next app launch.

Validation: 111 JavaScript tests, 19 Rust tests, privacy guard and frontend build
passed. Native DEV Playwright MCP verified sidebar creation/date/type/focus,
idempotent navigation, modal closing and unchanged scroll, Sunday week/month
alignment, settings persistence across restart, 640px layout and dark appearance
on an inactive desktop. The running user DEV was inspected read-only and showed
the new sidebar, static 28px header and modal settings action. No installation
or publication occurred. Evidence: ignored `.local/dev/sidebar-settings-*.json`
and `.local/background-qa/home-ux-20260912/artifacts/sidebar-*.png`.
The only console error observed in this run was the existing DEV favicon 404.

### Goal hierarchy follow-up, 2026-09-13

The owner preferred the previous sliders icon; it is restored and the separator
above Settings removed. The selected-goal card now uses the main surface,
stronger outline, target glyph and larger title than the current-task card.
Change retains its text and adds two circular arrows. The linked descendant
path is labelled Current stage. The agreed Today/All task list remains intact.

The existing Now status gets an 8px green dot only while a native timer block is
active. A recommendation and a paused/completed task have no activity dot.
111 frontend tests, privacy/build, and native MCP scenarios passed, including
goal-picker focus, native Start/Pause, 640px layout and dark appearance. The
user's open DEV was inspected read-only. Screenshots and results are retained
under the same ignored DEV/background-QA paths with the `goal-hierarchy` prefix.

### Dashboard frame and linked records, 2026-09-13

The DEV frame uses the native Windows title bar without the redundant 28px web
drag spacer. The workspace scrolls at the window edge, with matching content
insets. The goal header has a fixed 22px outline flag aligned with Change.
Today/All sit below Tasks. One labelled Create action stays in the navigation
row below Calendar and opens the existing Task/Event editor; sidebar creation
was removed. This placement remains provisional pending the owner's preference.

The linked-record check found and fixed two inconsistencies: parent goal cards
excluded descendant links, and Now retained stale titles/estimates/due dates on
running or paused records. Goal summaries now include subgoals and deduplicate
record identities. Now reads current fields while preserving the timer block,
work history and execution occurrence. The suspected nested-goal stage issue
was not reproduced; an added assertion confirms its existing behavior.

Validation: 114 JavaScript tests and 19 Rust tests pass; privacy and frontend
build checks pass. JavaScript cases include parent/child link counts,
relinking, nested main-goal paths and edited running/paused task and event fields.
Native DEV Playwright MCP created a task through the shared form, selected it
in Now, started/paused it, changed its title/date, relinked its goal, verified
the new date in Calendar, completed it and checked Today/All counts. A restart
preserved the selected subgoal and completion without restarting a timer.
Wide/640px and dark screenshots were inspected. The first native rename check
reproduced stale Now; its rerun passed after the fix. An earlier picker script
needed the existing All suitable tasks control to reach the test task.

All mutations used a separate copy of the existing synthetic QA database at
ignored `.local/background-qa/dashboard-links-20260913/`; the inactive desktop
monitor recorded no activation. The user's running DEV was inspected read-only
through CDP and showed the new frame, action, icon and filters. Source/build and
privacy checks are separate from this native evidence. No release installation
or publication was performed. The existing DEV favicon 404 remains. Local
reproduction scripts and results use `.local/dev/dashboard-links-*` and
`.local/dev/dashboard-frame-*`.

### Header action placement and task title, 2026-09-13

The owner clarified Create should sit directly below the Calendar icon/title,
aligned left and above the pane tabs. It remains outside the scrolling content
and opens the same Task/Event form. Now opens details from its task title with
an arrow and keyboard focus instead of a separate Open task button. Closing
details returns focus to that title and does not alter execution. Empty states
remain plain text, without an unusable title action.

Goal copy now distinguishes dashboard selection from completion: the dialog
says Shown on dashboard, and the empty badge explicitly says Main goal not
selected. The focused static dialog heading no longer looks like an edit field.

114 JavaScript tests, privacy and build passed. Native DEV MCP verified the
fixed left placement, shared creation, keyboard task-title opening, unchanged
timer state, focus return, goal copy and 640px layout. Wide, narrow and modal
screenshots were inspected; the user's DEV was checked read-only through CDP.
The background desktop stayed inactive. Evidence is under the ignored
`.local/dev/header-actions-*` and existing `home-ux-20260912` QA profile.

The missing Start day action was inspected, not implemented: this MVP only
projects `calendar_day_start_v1`; it has no writer or CTA. The historical action
records confirmed actual rising, separate from sleep end. Whether the requested
action retains that meaning or opens daily planning was asked separately.
## Dynamic styles and Notes security, 2026-09-13

The native build added a nonce to `style-src 'self' 'unsafe-inline'`. Browsers
then ignored `unsafe-inline`, blocking EditorJS-injected styles and category
swatch backgrounds. The Tauri configuration now sets
`dangerousDisableAssetCspModification` to `["style-src"]` only. This preserves
the authored style policy while retaining automatic script hashes and the
existing restrictions on scripts and other origins. See Tauri's
[selective configuration](https://v2.tauri.app/reference/config/#dangerousdisableassetcspmodification)
and [CSP guidance](https://v2.tauri.app/security/csp/).

An embedded-assets native candidate on an inactive Windows desktop reproduced
the failure before the change and applied both a dynamically inserted style
rule and a style attribute after it. A harmless inline script remained blocked
by both the effective response policy and the HTML meta policy. Script hashes
were still present; no `unsafe-inline` or `unsafe-eval` was added to `script-src`.

The real Notes editor opened a fictional hostile rich-text fixture, removed
unsafe elements and `javascript:`, `data:` and `file:` links, and preserved bold
text, a safe HTTPS link, the legacy checked list item and literal code. Saving
through the UI and reading back through real Rust IPC retained those properties.
All eight category swatches displayed their declared colors in the native UI.
The blocked-script probe deliberately produces CSP console errors; distinguish
those expected errors from application startup or editor-style errors.

Repeat these checks on the merged native binary after changing CSP, Tauri or
editor bundles. Use an isolated fictional profile, save and reopen the note,
and inspect both the displayed content and persisted block data. Local evidence
and binary identities belong under `.local/background-qa/`, outside Git.
This candidate check does not establish acceptance of the user's merged main
or installed application. Inline CSS remains allowed for these dynamic styles;
it must not be mistaken for permission to trust arbitrary HTML or scripts.

## Authorized merge and homepage follow-up, 2026-09-13

The owner explicitly authorized merging the other chat's work. Merge `2eb9119`
integrates worker `fc183c5` with the current homepage; only this evidence document
conflicted, and both histories were preserved. Ignored Git bundle and consistent
SQLite backups were created first. No remote publication or installation occurred.

Application commit `490c674` makes the single Create action a 44px graphite button
in its existing fixed row below Calendar. Goal details now show the stored result,
newline-separated acceptance criteria and direct subgoal titles, followed by the
existing descendant-linked record counts. They are rendered as text. The compact
homepage goal still shows its title and current stage; no progress is invented.
The dialog footer wraps with spacing and retains visible closing controls.

Running and paused Now tasks have a Switch task action. Running work is paused;
the local execution selection is released, and the existing task picker opens.
The task stays unfinished and recorded time remains intact. A save retry does not
repeat the pause, and another active block is never stopped by this action.
An app crash between pause and selection persistence can retain a paused choice
on restart; the recorded time survives and switching again is safe.

Validation on the combined source: 127 JavaScript tests and 29 Rust tests pass
(one manual performance benchmark remains ignored). Privacy has zero findings;
all 11 vendor files match pinned packages; Vite and the embedded-assets native
debug build pass. Independent review found no blocking source interaction or
switch/retry defect. The first fresh Rust build exhausted local disk space;
compressing owned generated build caches allowed a successful rerun.

Native Playwright MCP used the exact `490c674` embedded-assets executable on an
inactive Windows desktop with a separate copy of the existing fictional fixture.
It verified Create/shared form, long goal details, paused and active switching,
unchanged work history, settings acknowledgement and the unchanged current week.
After restart, the selected default Day view applied, no timer restarted, and the
released selection persisted. Wide/640px and dark screenshots were inspected,
including long goal scrolling and an accessible fixed dialog footer.

The merged native CSP permits dynamic style rules/attributes while blocking a
harmless inline-script probe under both effective policies. Hostile fictional
rich Notes were opened, saved, reopened, and read back through native IPC: unsafe
elements/URLs were removed; bold, safe HTTPS, checked legacy lists and literal
code survived. A synthetic SQLite backup/restore compared all application tables
exactly and passed integrity checking, then the native app reopened the restored
note successfully. Normal initial/restarted runs logged no console errors; the
deliberate inline-script probe generated expected CSP errors. The restore helper's
first sentinel insertion missed required `updated_at`, rolled back, and was fixed
before repeating the full restore check.

Reproduction batches, binary/source hashes, screenshots and receipts are ignored
under `.local/dev/merged-*` and `.local/background-qa/merged-ux-20260913/`.
The owner's original DEV process was preserved and inspected read-only. Its Vite
frontend received these edits; its existing native host was not restarted. The
owned automatic native rebuild watcher was stopped before the merge to prevent
an unexpected window restart. The merged native host is proven by the separate
candidate above, not by that still-open DEV process or an installed release.

### Create interaction research and title actions, 2026-09-13

The owner accepted Create's location but questioned its implementation and the
two right-facing details arrows. This is a narrow interaction iteration on the
existing Task/Event editor; it introduces no new record types or creation flows.

References are documented patterns, not live competitor testing:
[Fluent button guidance](https://fluent2.microsoft.design/components/web/react/core/button/usage)
distinguishes a single action, an equal-choice menu and a dominant-action split
button. [Carbon menu buttons](https://carbondesignsystem.com/components/menu-buttons/usage/)
likewise reserves menu/combo patterns for grouped choices. For this MVP, the
existing editor already opens on Task and contains the Event switch.

| Candidate | Benefit and cost in the current Hanni flow |
| --- | --- |
| Neutral New task button, direct editor | Describes the actual default action; one click to start typing. Event creation is discovered inside the form. Chosen as a reversible DEV trial. |
| Create menu with Task/Event | Makes both types visible before the form, adding a choice that duplicates the editor switch. Consider if people cannot find Event. |
| New task plus a separate menu segment | Keeps Task direct but adds a second target and keyboard stop. Frequency evidence to justify that complexity is absent. |

The chosen trigger keeps its 44px target and fixed position but uses a soft
neutral surface, lighter weight and New task wording. Current-task execution
retains the stronger filled action. Goal/task titles remain native buttons inside
their headings, without right arrows or an additional Open button. Hover and
keyboard focus underline the title; focus also has a visible outline. Current
task replaces Now, including loading/read-error wording. Execution and data are
unchanged. Remaining UX tradeoff: the title action is less explicit at rest, and
touch users do not get hover; future feedback should evaluate discoverability.

127 existing JavaScript tests, privacy guard and frontend build passed. Native
DEV MCP verified direct Task-first creation, Enter/Space details opening,
Escape/focus return, unchanged execution state and 44px title targets at 640px.
Wide, narrow, dark and keyboard-focus screenshots were inspected on the inactive
QA desktop. The only console error was the existing DEV favicon 404. Independent
source review found no transition/accessibility regression. The owner's open
DEV was read-only inspected and received the neutral trigger through Vite.
Evidence: ignored `.local/dev/title-actions-*` and `home-ux-20260912/artifacts/`.
No Rust changes, native rebuild, owner-window restart, installation or push.
