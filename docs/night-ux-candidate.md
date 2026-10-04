# Limited night UX candidate

Build 0.4.2 / `20261002-night.1`, separate from accepted `b3998fb` portable.
No production install, data migration, credential-anchor implementation or new
executor/dispatch feature. Six Calendar panes and existing Create/Start, records,
timers, process arrows, menus, edit controls and draft guards remain accessible.

Neutral role tokens follow task-7's shared-neutral proposal. Event/category
colors are preserved. Faint ordinary text and selected sphere counters use
readable neutral roles; native review caught a 4.42:1 selected-counter contrast
before the final correction.

Tasks keeps search and Work/Personal visible, moves filters/grouping into a native
keyboard disclosure, and displays the current restrictions plus a reset outside
it. Rows keep task name, written state, stage, time and a labelled primary action;
date, goal and sphere metadata are expandable. Waiting opens review rather than
starting a timer. Existing inline stage transitions remain. Expanded row state
and focus survive refresh. Navigation focus survives shell replacement on
Tasks/Routines activation. No new date ranking or automatic hiding of urgent
work was added.

Validation before final native freeze: 515 JavaScript tests passed, frontend
build passed. The first native candidate verified six panes, empty list,
Enter/Space navigation, keyboard disclosures, applied-filter visibility, draft
preservation and review without a timer start. Final optimized native hash and
both-theme/narrow-screen/error-retry acceptance are recorded separately after
the final candidate is built; earlier screenshots do not accept the final hash.

Native error/retry uses only a marked synthetic QA database: temporarily rename
its calendar_goals table while the owned test app runs, restore it in finally,
then retry. Public Tauri APIs resisted test monkeypatching; those preliminary
attempts did not produce a fault and are not counted as error acceptance.

Mac/Jira state and real two-origin dispatch remain unverified. The reviewed DEV
credential-anchor proposal retains the original path at three secret call sites
but requires real canonical-identity/DPAPI and sender-isolation acceptance; no
DEV move or anchor runtime change is authorized by this candidate.
