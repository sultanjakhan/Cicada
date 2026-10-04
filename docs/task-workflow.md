# Local task workflow candidate

Continuation of the approved create → steps → progress → result scenario, based
on Cicada `d2d10c5`, Windows, 2026-10-02. This candidate is not installed or published.

The existing Create action and native task identity remain the entry point. Open
a task title, expand **Шаги и результат**, add steps, choose each step's manual
status, and explicitly save the result. Stages describe the process of the task;
steps describe its individual work items. Step changes never start/pause a timer,
complete the parent task, launch an agent, or contact a model. Unsubmitted inputs
block normal closing; **Отменить ввод** discards only those inputs.

Each task has a device-local SQLite `ui_state` key
`calendar_task_workflow_v1:<taskId>`. The versioned state contains steps, their
statuses, a user result and an optional external run. Writes use the existing
`set_ui_state` compare-and-swap contract (`expectedValue`); failed or conflicting
writes do not claim success. Unknown or malformed saved state cannot be replaced.
The key is outside the sync whitelist. Cross-device steps are deferred until a
compatible sync record is agreed; this does not alter existing task sync.

## Local external exchange candidate

The opt-in local exchange is specified in [task-run-exchange.md](task-run-exchange.md).
It implements persistent sourceNamespace/sourceId binding, namespace-derived
stable taskKey, distinct attempt runIds, strict cumulative snapshots and
idempotent local JSON export/import against the supplied Agent City 0.5.15
contract. No namespace is created by opening this card, and no production source
has been initialized or migrated by this work. The existing workflow taskId/key
remains a local storage identity and preserves the original steps/results.

The older attachRun/applyRunEvent helpers are retained only for their existing
local candidate state; they are not Agent City report-run payloads. Use the new
createTaskRunExchange module for the paired contract. It makes no network,
model, launcher or sync calls. Only an explicitly matched binding may receive
reported execution telemetry. The card labels the last imported report and
keeps unknown token usage/cost unknown; a done run does not complete the native
task or overwrite its result.

Agent City files were not changed. Its consumer still needs to read the
persisted namespace and explicitly reconcile any accepted legacy path-based
keys. Production pairing, credentials, cloud transport and real cost receipts
remain outside the fixture candidate.

## Jira diagnosis boundary

This Windows checkout and the checked DEV worktrees contain no Jira UI/backend
implementation. Read-only production metadata inspection found no Jira-named
table, and zero Jira-named keys in `ui_state` and `app_settings`. No values,
credentials or corporate issue content were read. No sync/login/permission flow
was started. Settings now explicitly say that this build has no Jira integration
or local connection/import evidence. Device content sync is not Jira activity.

These facts establish the inspected Windows build's limitation. They do not prove
whether the user's Mac is connected. Mac inspection is not authorized in this
task. Import activity cannot be added truthfully until the actual Jira-capable
build and its safe connection/last-import metadata are available.

## Checks and remaining acceptance

The new DOM scenario covers add → running → done → saved result → remount,
escaped untrusted titles, failed writes, stale concurrent windows and external
event validation. Native Rust IPC creates a synthetic task, stores its steps and
result using acknowledged CAS, rejects a stale write, then destroys and recreates
the application test runtime against the same SQLite file. No timer is started.
MockRuntime and DOM remount are not installed application restart evidence.

Native visual and full process restart acceptance are recorded separately in
ignored local QA evidence. The native candidate was launched on an inactive
Windows desktop with an empty QA profile. Playwright MCP created a task through
Create, added a step, selected running then done, and saved its result. A new
native process with the same QA profile restored one done step and the exact
saved result, with zero active timeline blocks. Settings exposed the Jira
unavailable explanation and zero Jira action buttons. The desktop monitor saw
no activation of the QA desktop. This is local native candidate evidence at
760 × 720, not installed production or narrow-window acceptance.

Production installation, Mac/Jira acceptance, external
executor transport and real cost accounting remain outside this candidate.
