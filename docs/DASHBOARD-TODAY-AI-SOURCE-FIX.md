# Today work views — source candidate

Base: 80fc325aba10c54f357a4111003238ea3f964ee0. Scope: existing Dashboard/Today UI only. No new navigation pane, task domain or imported task list; existing native task overview is reused. No native commands, stored keys, transport, bindings or review authority changes.

## Narrow design brief and evidence

User requirement: AI work belongs inside Today with views, preserving personal work and the existing task list. Source evidence: calendar-workspace.js renderDash placed a separate AI host after Today and main goal; no dashboard-ai-work CSS import existed. The old view showed internal protocol language and raw selectors. Existing calendar-today card, scope switch, theme tokens and next-action surface supply the design primitives.

Flow: the Tasks Today widget defaults to personal native tasks and retains its existing Today/All filters. Work AI reveals the existing linked AI projection only within that widget. The recommendation and active personal work remain visible outside the switch. Switch by click or Left, Right, Home, End with roving tabindex; both panels associate with their tabs. Switching hides DOM without recreating tasks, starting/pausing timers, changing personal focus or writing preferences. Header running-work shortcut returns to personal task view without hiding current work. Main goal remains separate and full task lists/filters remain in Tasks.

Alternative: restyle the bottom AI block. Rejected because user explicitly requires AI inside Today. Trade-off: AI is one tab away, personal execution remains visible by default; hiding does not mean pausing. No date filter or inferred live activity was introduced.

## Before → after source coverage

| Scenario | Before | After |
| --- | --- | --- |
| Personal/AI | Independent bottom AI block | Two associated tabs inside the Tasks Today widget; personal DOM and current work preserved |
| Loading | Unknown diagnostic counts and raw controls | Human loading message; counts hidden; controls disabled |
| Linked rows | Repeated protocol details and unstyled HTML | Native title action, result/review if explicit, optional report details, scoped neutral controls |
| No reports | Empty source list diagnostic | Explains absence of linked AI reports; opens existing Tasks |
| Failed read | Unavailable protocol text | Retryable error; no false zero and no stale rows |
| Unknown execution | Mixed developer terms | Current execution explicitly unconfirmed; stale/unknown report recency remains visible |
| Keyboard/mobile/theme | No scoped styles or view switch | Associated tabs, keyboard selection, theme tokens, 44px controls and narrow-screen rules |

## User-owned integration dependency

The source adapter obtains native note rows, excluding readonly/archived, then dashboardFromNativeTasks excludes rows without a bound executor report or explicit review state, as well as accepted/completed work. Therefore 19 ordinary native tasks, manual running/blocked steps, descriptions, plans or saved result text alone are not 19 AI tasks. This was verified with synthetic source fixtures; no personal database inspected.

Executor reports are joined by the current explicitly registered native binding, with exact sourceNamespace/sourceType/sourceId/taskKey identity. Registry snapshots also require an exact localBinding. Published titles or matching native IDs alone do not qualify. Normal review reader is disabled by default. A production result/review contract and current-execution/recency authority must be supplied by the API/MCP/Agent City owner before those tasks can truthfully appear as AI work; no bridge, launch command or transport change is included. Prepared code and manual progress do not imply an AI run, review or Done.

## Acceptance limits

Applied hanni-ux-ui-research and hanni-visual-review from the preparation workspace. Discovery/synthesis: partial, narrowly grounded in source and explicit user requirements; issue_search not performed (no private issue/Jira access). Canonical product IDs were not supplied or invented.

Library screenshot libfile_66b53cf41d588191a4080ed390c055a5 was resolved through the current Library skill. Supported consumer-local materializer failed at os.setxattr on Windows; no alternate URL/helper used. Library image read returned metadata/OCR without model-visible pixels. Screenshot-dependent matching is BLOCKED. Parent's pixel inspection is not this executor's visual acceptance.

DOM tests/build are source evidence only. Visual/native/mobile acceptance: NOT RUN, no visual PASS. No desktop/input/focus/window operations, production database access, native launch, installation, signing or publishing. The candidate must receive authorized visual acceptance before installation.

Localization 5faf85c62491fa8554d6b0c080a467c957e1b207 uses different files; its strings/keys were not replaced. Dashboard projection fields and status enums remain unchanged.
