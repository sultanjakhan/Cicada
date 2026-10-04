# Integrated visible improvements candidate

Separate worktree integrated-visible-candidate, branch candidate/visible-normal-ui. Exact inherited1a9e9d357472703c7c76f2685271430e94084ef0 source candidate remains untouched in its original worktree for independent QA. Applied original settings/theme68ee7221af03e4af98d25480b96df0e536c18f9e patch unchanged; original direct base b880eeb26ba6f290f026e5d6faec6a93f94a7877. Applied integration commit6a1c5132f69da9bf78e834ec83e10da11bf8855d; eight files applied cleanly, zero conflicts.

## Normal mode visible scope

ONE existing native Tasks list with search/count, date/completion/Work-Personal filters and source/project/tag filters. No extra Projects/Imported works section, no deleted snapshots. Explicitly bound published observations annotate native IDs; unbound observations remain stored and are disclosed with a count. Personal and readonly Jira IDs are preserved. Manual tasks/timers continue through the existing native commands; no AI running inferred from a human timer.

Theme icon is mounted in the existing Calendar header using the existing device preference and setTheme, persistent across sessions and reflected in existing settings. Connection field/action grouping and checkbox labels are improved; unconfigured update channel disables Check/hides Install instead of promising automatic update availability. This is the exact supplied68ee UI delta; it adds no connection, auth authority, installation, new migrations or signing configuration.

Normal list does NOT require native review commands/features or initialized review tables. Its Na priemke filter is hidden when no explicit review reader is supplied; a restored review filter falls back to active. Product copy omits developer-only native/isolated opt-in instructions. Native task/source/project/tag filters and completion remain usable with read-only/null observation state. Shared pending actual-model feed remains absent; saved run reports are explicitly observations. No fictitious result/current model/run is generated.

## Opt-in review remains separate

Inherited c87724fb65cb357246bc9dc16918699f26edce9b→23434ac013d7854453c7ef4ff860152a9b245c90→b880 exact lineage unchanged. loadCalendarWorkspace nativeReview=false and Cargo local-result-review-prototype disabled by default. Backend feature+validated isolated-profile gate precedes schema initialization; ordinary profiles reject403. No native/Rust/Cargo changes in this integration. Existing review consumer can explicitly inject its reader/prepare adapter in an authorized synthetic profile. Accepted/pending/rework behavior, immutable local prototype records, lifetime guards, operation receipts/history are inherited, not made production-ready by the normal UI release.

No real result publisher, cross-app authority/dispatcher/live feed, production migration, sync/downgrade policy or old-result content reader is added. “One list works normally” is not a claim that prototype review is approved for personal production data.

## Explicit exclusions and acceptance gate

No features/routines cherry-picked from other branches. Existing baseline routines retained unchanged. No main/shared checkout edits, Agent City modifications, real private DB/Jira/secrets access, windows/input/dialogs/native GUI probes, install, package signing or network publication. Native visual acceptance must occur only when authorized through the main/Agent City coordination owner; this worker does not authorize or execute it. This is a candidate source/build checkpoint for that next acceptance, not an installed release.

Evidence and artifact hashes are recorded in the separate exact source manifest/hand-off, so no user-local paths or runtime fixture DBs enter public Git. Build artifacts/node_modules/fixture storage are excluded from git archives.

## Independent QA corrections

QA-UNIFIED-001: readonly source rows remain visible, searchable and counted with exact original open identity; row mutations and bulk date changes exclude readonly rows. QA-UNIFIED-002: transient review-read errors preserve last known ownership and disable manual completion until a successful refresh. Explicit initial review_prototype_disabled (403) or no_review_result (404) leaves ordinary manual tasks usable. No backend authority or production review scope changed.

## Confirmed progress independently of timer

Native local workflow steps supply manual progress in list/card: blocked steps or explicit waiting stage => waiting, running steps => in progress, planned steps => planned. All steps done/result text does not close the task. Timer state remains independently displayed and controls still explicitly start/pause the timer. Empty workflow preserves existing fallback. Manual progress never creates executor/live telemetry or review data. No mapping19 applied, IDs hardcoded, source descriptions interpreted, or production writes performed.
