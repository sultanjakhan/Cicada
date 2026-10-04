# Working registry import — proposed v1

The task-snapshot importer is available under Settings → Connections →
Imported work registry, with preview before save. Explicitly bound existing
task cards show the imported observation separately from manual steps.
This is not a dispatcher. The UI placement remains subject to navigation review.
Only explicitly published engineering work belongs here. Do not include chat
history, internal notes, corporate tasks, credentials, or inferred telemetry.

```json
{
  "schemaVersion": 1,
  "kind": "work-registry-snapshot",
  "snapshotId": "REPLACE_WITH_UUID",
  "sequence": 1,
  "source": {
    "publisherId": "engineering-parent",
    "sourceNamespace": "REPLACE_WITH_STABLE_UUID",
    "mode": "published-snapshot"
  },
  "publishedAt": "REPLACE_WITH_UTC_ISO_TIMESTAMP",
  "staleAfterSeconds": 3600,
  "projects": [{"id": "engineering", "title": "Agent City / Cicada"}],
  "tasks": [{
    "id": "REPLACE_WITH_STABLE_TASK_ID",
    "projectId": "engineering",
    "parentTaskId": null,
    "title": "REPLACE_WITH_PUBLIC_TASK_TITLE",
    "relationship": "root",
    "status": "unknown",
    "lastUpdated": "REPLACE_WITH_CONFIRMED_UTC_TIMESTAMP",
    "provenance": {"kind": "parent-published", "reference": "REPLACE_WITH_PUBLIC_REFERENCE"},
    "operation": null,
    "waitingFor": null,
    "result": null,
    "localBinding": null
  }],
  "runs": []
}
```

Replace placeholders before import. The example does not assert an active task.
The parent supplies confirmed titles, states and timestamps. `lastUpdated` is
the last confirmed observation, not import time. Local receipt time is recorded
separately by the consumer. A snapshot is never labelled live.

Identity is `(sourceNamespace, task.id)`; origin app does not change identity.
Project IDs are scoped to that namespace. Subtasks use `parentTaskId` and
`relationship: sequential | parallel`; roots use `root`. Reject duplicate IDs,
unknown parents/projects and cycles before writing anything. `localBinding`,
when explicitly provided, is the existing `{sourceNamespace, sourceType,
sourceId, taskKey}` binding; titles are not matching keys. Unbound imported
rows do not create calendar tasks automatically.

Task states: `planned`, `running`, `waiting`, `checking`, `decision-needed`,
`done`, `error`, `cancelled`, `unknown`. An observed error requires a cited
source; missing or stale observations are not errors. Optional `operation`,
`waitingFor` and `result` are short public summaries supplied by the publisher.
No prompts or internal reasoning. Cancellation is confirmed only after the
executor acknowledges it; a cancellation request remains an operation.

The v1 importer currently requires `runs: []`; run telemetry remains in the
existing strict report exchange. A proposed future run contains `runId`, `taskId`, `configSnapshotVersion`, `lastUpdated`,
`provenance` and `report`. `report` is either null or the existing strict Agent
City report from task-run-exchange.md. Unknown model/token/cost data remains
unknown; the registry does not infer it. Snapshot task status and executor
report status are displayed separately if they disagree.

Freshness is a separate display property: `fresh`, `stale`, `unknown`.
`staleAfterSeconds` is a display policy, not an executor timeout. Clock skew or
invalid timestamps produces `unknown`; age beyond the policy produces stale.
Neither changes the recorded status or finishes a task.

Snapshots replace only that publisher/namespace's imported projection, never
manual workflow steps or local task data. Lower sequence is rejected. An
identical same-sequence payload is a no-op; a different same-sequence payload
conflicts. Omission removes a row from the projection, not its underlying task.
The consumer never republishes imported snapshots automatically, preventing
echo loops. Full snapshots are the first supported unit; incremental event
import requires a separately agreed sequence/gap contract.

Start from either application uses a shared local transactional registry:
`task identity + idempotencyKey + configSnapshotVersion`. Repeating the same
key returns the original run; another key while a run is active returns a
conflict carrying its runId. Allocation is prepared, not running. Actual
dispatch and atomic native command ingestion remain separate implementation
work; the existing fixture exchange is not an automatic executor.

UI placement proposal: an imported-work section inside existing Projects,
with task detail showing hierarchy, imported timestamp/source, freshness,
operation/wait/check/decision and result. Bound calendar task cards can show
the same read-only projection. No new top-level navigation or Settings
dashboard is required. This placement awaits the navigation review.
