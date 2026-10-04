# Dashboard AI work section: narrow source-only prototype

Base b880eeb26ba6f290f026e5d6faec6a93f94a7877, independent experiment/dashboard-ai-work. This supersedes the prior task-list-oriented audit for this request. Scope is DASHBOARD AI work overview, not generic Tasks or the user's human-focused Today/Now recommendation. No workspace wiring, settings, theme, connectivity, timers, shared checkout or production writes.

## Minimal dashboard plan

Add one dedicated sibling section “ИИ-работы” after the existing personal focus widgets, retaining their order and widths. Leave the human “Сейчас” task and its timer unchanged. Section header: unique task total, current active count (unknown until live contract is bound), needs-user badge/count, grouping “По проектам / По основному тегу”, tag filter. Inside: project/tag headings with counts and compact flat task rows. No task accordion as primary layout; no new screen or duplicate stages.

One row shows title/open action, explicit needs-user badge when authoritative, last reported executor/model and technical stage, report receipt time and freshness, available result version/review state. Numeric percentage remains unknown: pipeline configuration stages do not prove work progress. Open callback targets the existing task/result card/history for this exact task identity; it does not launch work. Completed/accepted result availability belongs to the same task, not an inferred result from executor done. This finite prototype has no completed/history storage or new decision UI.

For multi-tag tasks, each task is assigned to ONE canonical primary tag (lexically first stable tag ID); other tags remain visible and selectable. Filtering by any tag finds all members even if another tag is their group. No-tag/no-project get explicit buckets. The sum of group counts equals the visible unique task count; global total is not a sum of tag memberships. A future user-owned primary-tag field may replace the deterministic fallback without rewriting source tags. Project grouping uses the saved exact project ID; no title/path-based matching or copying project rules.

## Existing relations actually read

Cicada calendar-dashboard-tasks.js renders native task/timer/date groups. row.is_active is the human/native timeline timer, not executor evidence. calendar-workspace.js mounts existing personal task widgets separately.

Cicada task-run-exchange.js explicitly pairs a stable sourceNamespace/sourceId binding with taskKey and run reports. readTaskRunStatus picks latest receivedOrder; no default network/launcher, result content or wall-clock report timestamp in its strict envelope. Do not call timers or infer run identity from title.

Agent City task-5/agent-city-actual-model/static/dashboard.js taskModelReports uses task.runTaskKeys or exact task.taskKey to match aggregateRuns reports; it carries runId, sequence, agent/model/provider/stage/status, receivedAt from updatedAt, freshness and provenance=executor-report, independentlyVerified=false. It explicitly says “Live worker source is not connected; current actual model is unknown.” TASK-RUN-CONTRACT.md defines RunStore.updatedAt as receipt time, not execution duration. PIPELINE-CONTRACT.md prepare_intent is status prepared/executionSupported=false, modelRefs are configuration references, registry/dispatcher/status synchronization is pending. Catalog/default model is not actual model evidence.

These existing reported fields are available in source; an authorized live adapter into Cicada is NOT available. No live requests are made by this prototype. The pending pipeline actual-model contract must supply agreed task/run ownership and live provenance before current running/model can be displayed as actual. Until then the header says active unknown and rows label model as reported; “Running в последних отчётах” is historical reported coverage, including stale reports, not an active count.

## Component injection seam (not a new domain/storage system)

mountDashboardAiWork(host,{read,onOpenTask}) in src/hanni/js/dashboard-ai-work.js is isolated, opt-in and not mounted by the workspace. With no read adapter it shows unknown/no-data, never fake zero completed work. read returns transient {tasks,reports}; no file, DB, IPC, polling, credentials or transport is implemented.

Task projection: {taskKey,title,runTaskKeys?,project:{id,name}|null,tags:[{id,name}],needsUser:true|false|null,resultVersion?:positive integer,reviewState?}. taskKey must be explicitly bound; duplicate identities fail closed. needsUser must come from authoritative user-owned pending decision or review state, never from generic waiting/blocked or a timer. Null remains unknown. Metadata and result revision require a registry/review-service adapter; pipeline modelRefs never fill model fields.

Report projection: {taskKey,runId,agent,model,stage,status,receivedAt,freshness}; source uses latest full cumulative report per run and supplies freshness (fresh/stale/unknown). status is existing RunStore enum. report.updatedAt→receivedAt must remain receipt time. Current Cicada exchange lacks timestamp/freshness, so null/unknown is required there. For multiple attempts the row shows the latest received report and attempt count, not a claim that it describes every concurrent worker. Missing result content is not generated; callback opens existing source-backed details. Actual model remains unknown regardless of configured/report model until pending live source contract is accepted and connected.

Source read error, no adapter and a successfully returned empty fixture are distinct. Error does not turn tasks completed. Component has no persistence: source owns all task/run/result/history facts; grouping/tag selection are ephemeral view state. onOpenTask must map exact taskKey through the approved registry to existing task details/result history. Source prototypes/patches are not installed work results and are not injected as tasks or accepted outcomes.

## Evidence / remaining gates

Six synthetic DOM tests: 11 tasks grouped by projects and multi-tags without duplicate totals, filtering by secondary tag, preservation of personal Now, exact open identity, reported/stale model separate from current unknown, no-feed vs empty source, human timer ignored, unknown needsUser/no inferred badge, unbound report cannot match a title, duplicate identities and disposed late read fail closed. No real execution occurs.

This source-only prototype adds only component, tests and this documentation. It does not integrate with main's changing real task statuses or a real live feed. Pending gates: approved registry/project/tag/result mapping; pipeline actual-model/live report contract; authenticated read adapter and source freshness; existing result/history open binding; native visual composition. Settings/theme/connectivity belong to other work and are untouched.

Read paths: ../task-5/agent-city-actual-model/{TASK-RUN-CONTRACT.md,PIPELINE-CONTRACT.md,WORK-EXCHANGE.md,run_store.py,static/dashboard.js}; isolated Cicada repo this isolated repository, baseline source {src/hanni/js/calendar-dashboard-tasks.js,calendar-workspace.js,task-run-exchange.js}. No GUI, production DB, corporate data, imports, keys, provider calls or publication.
