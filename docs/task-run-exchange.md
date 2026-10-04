# Local Cicada / Agent City exchange

This is an opt-in, offline candidate for the supplied Agent City 0.5.15 contract
(`cafc0996`). No Agent City files, production database, credentials or security
settings are changed by this work. The fixture does not execute an agent or
report a real model call. Existing native task UUIDs, timers, task steps and
results retain their formats and identities.

## Persistent source identity

`src/hanni/js/task-run-exchange.js` accepts an injected native `invoke`, without
importing the frontend sync wrapper. `prepareSource()` explicitly creates a
random UUID once in the device-local SQLite key `calendar_task_run_exchange_v1`.
It uses acknowledged compare-and-swap; concurrent initializers converge, and
unreadable saved state is never replaced. Opening the task card only reads this
key and never creates a namespace. The key is outside the content sync whitelist.

`bindTask({source_type:'note', source_id:<existing ID>})` verifies the native task
exists and stores its binding:

```json
{
  "sourceNamespace": "<persistent lowercase UUID>",
  "sourceType": "note",
  "sourceId": "<unchanged native task UUID>",
  "taskKey": "cicada-<namespace hash prefix>-<sourceId>"
}
```

The prefix is exactly the first 16 lowercase hexadecimal characters of
SHA-256 of the UTF-8 namespace string, including its UUID hyphens. It never uses
a path, title, account or device display name. The full namespace/sourceId pair
travels in the local envelope and is checked on import, rather than relying only
on the short hash. A relocated database retains this stored identity. Fresh
independent sources generate different namespaces. Copying a database copies
its identity too; an independent clone therefore needs an explicit re-namespace
plan before participating. No automatic clone detection or rekeying is included.

## Producer and consumer

The exported `createTaskRunExchange(invoke)` supports:

1. `prepareSource()` and `bindTask(record)` — explicit local initialization/binding.
2. `createAttempt(binding, {agent, provider:null, model:null})` — persist a fresh
   opaque UUID for each attempt, returning runId. This creates no execution
   report, status event, token count or spend value.
3. `recordReport(binding, report)` — accept a complete reported snapshot.
4. `exportBinding(record)` and `exportReport(runId)` — return JSON strings for
   a caller's explicit local file save.
5. `importReport(envelopeJson)` — accept an explicitly supplied local envelope
   only for this database's already-known namespace, binding and existing task.

An import may introduce a new external runId, but cannot introduce or replace a
source namespace or silently bind another task. Run identity (`taskKey`, agent,
model, provider) cannot change. A retry/different executor uses a new runId.
Source binding does not authorize execution.

Binding export has `{schemaVersion:1, kind:'cicada-task-binding', binding}`.
Run export has `{schemaVersion:1, kind:'cicada-run-report', binding, report}`.
The envelope is a local pairing/file format, **not** an Agent City endpoint body.
Only its `report` object uses the strict endpoint fields:

```json
{
  "runId": "<attempt UUID>", "sequence": 1,
  "taskKey": "<explicitly paired key>", "agent": "codex",
  "model": null, "provider": null, "stage": null, "status": "waiting",
  "skillIds": [], "mcpCalls": null,
  "inputTokens": null, "outputTokens": null
}
```

Allowed agents: codex, claude, other, agent-city. OpenCode uses other, with only
observed provider/model labels. Allowed statuses: running, waiting, done, error,
cancelled. Sequence starts at 1 and increases; each report is a complete
cumulative snapshot. An identical same-sequence snapshot, including canonical
key ordering, skill and MCP-counter ordering, is idempotent and performs no
write. Different same-sequence or older snapshots conflict. Previously reported
token/MCP counters cannot decrease or become unknown. Unknown stays null;
observed zero is allowed. Extra fields, task text/prompts fields and MCP
arguments/results are rejected. Native AI writes commit task, report and
operation receipt in one SQLite transaction. Durable bindings, runs and receipts
have no lifetime limit of 500. Indexed receipt lookup preserves exact retries;
the same operation ID with a changed payload conflicts.

The version-1 `ui_state` exchange remains a compatibility view of at most 500
recent runs/bindings and 4 MiB, not a retention boundary. Native commands use the
durable history, including older runs omitted from that view. The first native
write or exchange import migrates valid existing namespace, reports, receipt
digests/results and receipt times atomically; invalid legacy state aborts without
partial migration. A partial compatibility import never deletes omitted history.
Archived personal tasks may replay an existing exact receipt but cannot accept
new AI writes; reassignment to work/Jira scope still denies access.

This additive component uses schema version 2 without changing the main SQLite
schema version. Keep a consistent database backup before installing a build that
uses it. An older executable cannot interpret new SQL history: file replacement
alone is not a data rollback. Restore the matching pre-upgrade backup for that
rollback, retaining any later data separately.

The task card shows the **last imported report**, not independently verified
activity. A done run does not complete its native task or overwrite its result.
Cost remains unknown; no rate, amount or currency is fabricated. Local receipt
order selects a display row and does not measure time.

Agent City must explicitly consume the binding and read the persisted namespace
to produce the same dashboard key. Its legacy path-based task keys are not
rewritten here. Until this matching change is accepted on that side, send no
report for a guessed key. The synthetic test proves schema compatibility using
Agent City's real validator/RunStore, not a production dashboard association.

## Runnable synthetic file fixture

From this checkout:

```powershell
node scripts/task-run-exchange-fixture.mjs init .local/exchange-fixture
node scripts/task-run-exchange-fixture.mjs import .local/exchange-fixture .local/exchange-fixture/report-envelope.json
node scripts/task-run-exchange-fixture.mjs show .local/exchange-fixture
```

This is an explicitly marked synthetic JSON-backed KV/IPC fixture, not an
application database tool. It writes only its direct child directory under this
checkout's `.local`, refuses directory links/unknown existing folders, and imports
only an envelope placed inside that fixture directory. `binding.json` contains
identity only; `report-envelope.json` contains the paired envelope; `report.json`
contains the bare strict Agent City payload. All reports carry the
synthetic-fixture stage. Re-running init preserves the namespace and existing
run. Importing its unchanged export twice leaves the stored bytes unchanged.

Set `AGENT_CITY_CONTRACT_ROOT` to the approved local Agent City source directory
and run `node --test tests/task-run-exchange.test.mjs` to exercise its actual
Python validator/RunStore in a temporary directory. That test imports code only,
does not inspect its live storage, and makes no network/inference calls.

## Production adoption and rollback plan — not executed

Before adoption, QA must accept this candidate and the paired consumer. Preserve
a consistent native backup at the original profile location, with its original
database and credential paths. Explicitly initialize only the intended source;
read back the namespace and verify existing task IDs, timer state, steps/results
and new binding. Never initialize a clone as production by guessing identity.

Code rollback retains the additive exchange key; old versions ignore it and
existing tasks stay readable. Keeping the namespace prevents accidental key
changes if exchange is enabled again. Any data rollback must restore the
consistent snapshot at the original profile path and explicitly reconcile
accepted run reports. No automatic delete/rekey, credential copy or DB relocation
is part of rollback. DEV DPAPI remains bound to its original database path.

## Native QA launch

Use an existing approved Python with mcp, psutil and pywin32, Node.js, WebView2
and the project's installed Playwright MCP CLI. Do not install or download tools
as an implicit fallback. Build a debug candidate with embedded assets:

```powershell
node node_modules/vite/bin/vite.js build --configLoader runner
$env:CARGO_PROFILE_DEV_DEBUG='0'
cargo build --offline --locked --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol --bin hanni-mvp
```

If using a configured CARGO_TARGET_DIR, find the EXE under that directory's
`debug`; otherwise use `src-tauri/target/debug/hanni-mvp.exe`. Record its SHA-256,
then pass the verified paths/hash to the tracked client:

```powershell
python scripts/task-workflow-native-qa.py --exe <candidate-exe> --expected-sha256 <verified-hash> --mcp-cli <existing-playwright-mcp-cli.js> --session <new-qa-session> --release-isolation --calls <local-call-list.json>
```

QA now requires the explicit native isolated-test-root mode in both debug and
release. Environment-only debug detection is forbidden; old binaries without
native isolation support are rejected before launch.

The client invokes `scripts/qa-background.py`, which creates an inactive desktop,
isolated data/WebView2 directories and a hash-bound QA profile. It never activates
the owner's desktop/app. Use the same session and unchanged binary for process
restart checks; use a new session after rebuilding. Do not move or copy DEV data
or credentials to get around the hash/profile guard.

The call list is an array of `{name, arguments}` MCP requests. This installed
server has `browser_evaluate`, not `browser_run_code`. Use observed snapshot refs
for target; the client also resolves `@<accessible label prefix>` to exactly one
fresh observed ref, rejecting ambiguity. UTF-8 is set for both Python processes.
Results/screenshots/runtime manifests are stored under
`.local/background-qa/<session>`. Process restart, imported-report UI, unknown
telemetry and desktop isolation are separate acceptance criteria.

## Candidate acceptance, Windows 2026-10-02

501 JavaScript tests passed, including the actual Agent City Python
validator/RunStore fixture; 185 Rust tests passed, with 4 existing ignored tests.
Frontend and isolated native builds passed; privacy had zero findings.

Native QA executed the producer/consumer module source in an isolated WebView2
with real Tauri IPC. It explicitly initialized a synthetic source, bound a
native task, allocated a run, recorded/exported/imported a synthetic report,
and verified an identical import did not change the stored value. The packaged
task card displayed the last imported report and unknown token usage/cost.
Create, manual step progress and result saving used actual Playwright UI actions.

The final EXE's process restart changed PID 22920 to 24880 with the same QA
database. Namespace, source ID, taskKey, runId, report, manual step and result
survived; active timeline blocks stayed empty. Both desktop monitors reported
no activation. QA-001's close warning cleared after explicit discard and after
an acknowledged result save, in both regression tests and the native UI.

Evidence is under `.local/background-qa/exchange-final-native-20261002`, including
`runtime-before-restart.json`, `runtime-after-restart.json`,
`exchange-final-calls-6.json`, `exchange-restart-and-jira-calls-0.json`, and
`artifacts/exchange-restored.png`. This is local candidate acceptance at
760 × 720, not installed production, Mac, live Jira, live peer association,
execution dispatch or real usage/spend measurement. The final candidate still
needs the requested independent QA before production installation.
