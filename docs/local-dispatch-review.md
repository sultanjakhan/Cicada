# Synthetic local dispatch review

Reviewed task-5's contract/patch `6e506b1` and `task_launch_contract.py` against
the existing Cicada exchange. No fake adapter or production dispatcher added.

Compatible: explicit two-origin initiation, idempotent replay, immutable attempts,
new IDs for retries, no automatic task completion, unknown telemetry, policy
recheck and explicit actualExecution=false. Claim identity is not authentication.

Required agreements:

1. Dispatch adds a registry UUID taskId. Cicada uses the persisted
   sourceNamespace/sourceType/sourceId/taskKey tuple. Define authoritative
   storage/mapping without replacing existing IDs or guessing from titles.
2. Intent derives UUIDv5 runId from taskId/requestId. Cicada allocates opaque
   UUID attempts. The new UUID is syntactically valid but the allocation rule
   differs: choose one owner and preserve all existing observed attempts.
3. Admission prepared/accepted/claimed/cancel_requested and synthetic
   succeeded/failed are not strict running/waiting/done/error/cancelled reports.
   Require explicit evidence projection; cancellation needs acknowledgement.
4. costUsd/durationMs/resultRef are rejected extra fields in strict exchange;
   keep them separate from skillIds/mcpCalls/stage report fields. Do not submit
   whole journal rows or invent currency, price, cost or task content transport.
5. Retry may change snapshots, but each exchange run fixes agent/model/provider/
   taskKey. A changed identity needs a new runId. Report sequence starts at 1
   and must not be conflated with journal admission-event numbering.
6. Budget enforcement, authoritative revisions, transport/auth, recovery and
   result retention remain blockers. Binding/catalogue availability alone does
   not authorize execution. Mac Jira-to-task mapping remains unverified.

Python prototype belongs to its Agent City/protocol owner; no copy was added to
Cicada. Synthetic validator success does not establish bidirectional execution.

Follow-up review of the owner's pure adapter `e0ae407`: it checks the existing
namespace-derived binding, keeps caller-supplied existing runId, omits pending
states, and projects only acknowledged synthetic events with agent=other and
stage=synthetic-fixture. This resolves a fixture projection route without a
production connection. Its agent=other projection must use an explicitly
compatible synthetic attempt; it cannot overwrite an existing codex/provider/
model identity under the same runId. No strict importer change is needed.
