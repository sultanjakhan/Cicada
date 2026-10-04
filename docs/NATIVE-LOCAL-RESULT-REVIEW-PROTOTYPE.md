# Native local result review prototype

Base: exact b880eeb26ba6f290f026e5d6faec6a93f94a7877. Isolated experiment/native-local-result-review. Reuses the reviewed ff2338af94f42bebefd4476326b8e6180d988d8e result component, its ten tests and optional workflow-card seam unchanged. Self-contained delta includes the ff2338af UI files; do not apply that UI series again on top. No installed app/profile, GUI, real task, cross-app owner, MCP or dispatch integration.

## Scope and native authority

The native items row is the only task authority. Every result/decision refers to exact existing items.id; UI taskId is record.source_id, without hashing, fixture mapping, copied TaskService task, namespace or owner field. TaskRevision is native items.version. ResultVersion is independent immutable monotonic content version. The native connection comes solely from trusted AppState.

New handlers require both Cargo feature local-result-review-prototype and the existing validated isolated-test profile. Ordinary profiles and default builds reject with403 before review schema initialization. Test-only Scope::fixture enables synthetic MockRuntime fixtures; it is not a production identity or executor grant. No caller supplies DB path, owner, profile, scope or credentials. Cross-profile native IDs cannot access another AppState's DB; no cross-app identity claim is made.

## Records and migration

A scoped additive component migration creates local_review_meta(version1), results, state, audit, operations, intents and outbox. Global native PRAGMA user_version stays5. There is no startup migration in normal profiles: only scoped prototype handlers initialize the component. Newer component versions reject. Existing tasks/notes/native IDs/versions/timers/manual workflow.result strings are not converted. Old native v1 fixture is migrated by the existing init_schema, then this additive migration; its original ID, notes and version remain intact until explicit result publication.

Results are immutable `(task_id,result_version,content,published_task_version)`. Audit is append-only. Intent stores exact native task ID, result version, task version after decision, comment, awaiting_dispatch and event_id. SQLite triggers prevent changing/deleting result/audit rows, deleting/archiving tasks with awaiting_dispatch intents, and bypassing accepted/unreviewed completion through other native status writes. Existing readonly imported identities are rejected by the existing health_sleep::editable policy, without changing importer content. Native title/stage edits may still increment items.version and invalidate stale decisions. No second task table exists. Tables are absent from sync export lists; this prototype is isolated/single-profile only.

Migration risks: persistent triggers also affect older binaries using that synthetic DB; no downgrade/removal/retention policy or migration rollback tool is provided. The original global schema marker alone does not describe this component, hence the separate version. Component records are not synchronized or included in an invented cross-app registry. Before any production rollout, compatible backup/downgrade handling, sync conflict rules, task deletion/archival policy, native profile ownership and trusted result/executor publication must be reviewed. No production migration was applied or accepted.

## Native commands

- prototype_publish_task_result(input): synthetic-only explicit fixture publication with operation_id, existing task_id, expected_revision and content. It atomically inserts immutable result/state/audit/receipt and increments items.version. It never imports editable manual text or metadata-only run reports as an AI result. Superseding an awaiting-review result increases resultVersion; awaiting_dispatch/accepted publication rejects. A real result publisher is intentionally absent.
- read_task_result_review(taskId): one read transaction returns projection and durable outbox history. Projection fields match the existing UI: taskId, taskRevision, resultVersion, content, reviewState, history(action/resultVersion/comment/operationId/taskRevision/eventId).
- enqueue_task_result_review(input): persists normalized immutable user request as queued before returning. Input is the UI request operation_id/action/task_id/expected_revision/result_version/comment?; accept omits comment, rework requires a nonempty comment. Repeated same ID/body is idempotent; changed body, ID collision or a second unresolved click conflicts.
- commit_task_result_review(operationId): applies that queued local user decision, not a remote dispatch. Under BEGIN IMMEDIATE it checks the existing native task, task version and exact result version/state, then writes review state/audit/intent, native task version/completion, operation receipt and outbox ACK in one transaction. Accept marks native task completed/done; it preserves complete_calendar_task's existing active-timer guard, returning409 instead of silently stopping work. Rework marks native task uncompleted/task plus awaiting_dispatch, preserving timers/stages. No running state or confirm/start executor command exists.
- recover_task_result_review(taskId): the same consistent bundle for restoring pending request/comment/original ID after reopen. Conflicts remain stored with original payload and require a deliberate new decision; no automatic rebase.

ReviewError serializes status/code. No owner or arbitrary extras are accepted by the typed command input. Text is bounded to8000 Unicode characters, IDs200 characters, revisions to JS-safe positive integers. The UI's UTF-16 textarea limit can be stricter for non-BMP text. Requests/receipts are normalized typed JSON; matching IDs with different payloads never overwrite. Audit event IDs are local correlation only; no webhook is sent.

## Existing card bridge

native-result-review-adapter.js forwards to actual registered commands through the caller's existing invoke. It verifies task/operation correlation and response shape. Enqueue commits first; applying the local decision is a second call. If interrupted between calls, pending state survives on disk. The native apply transaction combines receipt and outbox ACK, eliminating the separate-database ACK gap. Original retry receipts may be older, so the adapter always renders a fresh consistent native read.

Explicit opt-in usage in an isolated caller:

```js
const review = await prepareNativeResultReview(record, invoke, () => crypto.randomUUID());
mountTaskWorkflow(host, { record, invoke, review });
```

Preparation restores queued immutable payload or conflict comment into a new caller-owned session Map before mounting; it does not overwrite a mounted lifetime. Native durable outbox protects submitted decisions; unsent edits remain session-only. Existing card/lifetime tests are preserved. Default application callers supply no review adapter, so no production buttons or feature toggle is enabled by this patch. No GUI/visual acceptance is claimed.

## Evidence

Native review: 20 tests PASS plus one ignored stdio fixture worker, exercised explicitly by Node. Native default-feature gate test PASS. Existing importer3, workflow1 and old-schema1 regressions PASS. Targeted JS14 PASS: ten existing result/lifetime tests plus four bridge cases, including actual DOM card -> JS adapter -> actual Tauri InvokeRequest deserializer/registered handler -> synthetic disk -> reopen readback, abrupt process crash after committed enqueue, and four real process exits inside the same native apply transaction at intent/audit/task/receipt/outbox cutpoints. Concurrent real SQLite connections commit one intent/receipt. Stale/different-payload/owner-field/profile-ID conflicts and immutable content/history are checked.

Full JS run: 571 tests, 568 PASS, 2 skipped, one inherited qa-files Windows CreateFile AccessDenied in restricted execution. That exact synthetic QA wrapper independently reran with approved elevated execution and passed1/1; do not describe the restricted full run as all-pass. Build PASS. Logs and exact executable hashes are delivered separately, not committed with local paths/data. Full Rust network/transport suites were not run because this task forbids network; relevant native review/importer/workflow/migration gates were run.

MockRuntime creates no real native window. A test-only stdio worker transports requests to actual handlers to pair headless DOM with Rust; it is not an application subprocess/HTTP/MCP adapter. One fixture was abruptly killed after committed enqueue; four exited before native apply commit. Recovery proves those process-crash/reopen cases, not hardware power loss, malicious filesystem swaps, external exactly-once execution, encryption or production durability. No dispatcher consumes intents; awaiting_dispatch remains truthful. HTTP2xx, event delivery and ordinary tool calls cannot prove work started. Remote identity, live result provenance, signed MCP Events and executor receipts remain disabled for a separate setup.
