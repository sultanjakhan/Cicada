# N1: isolated review routing correction

Direct base23434ac013d7854453c7ef4ff860152a9b245c90. The independently reported integration failure was real: lib.rs outer allowlist rejected all five new commands even though direct MockRuntime handler tests passed. No domain transaction or identity contract changed.

Applied the supplied narrow proposal: isolated_test::allowed permits exactly prototype_publish_task_result/read_task_result_review/enqueue_task_result_review/commit_task_result_review/recover_task_result_review only when local-result-review-prototype is compiled. No prefix or general allowance exists. Existing external integrations remain denied; ordinary profiles still fail Scope.require before schema initialization.

Extracted the existing app's outer reject/delegate logic into isolated_test::dispatch<R>. Production Wry in lib.rs and test InvokeRequest routing call this same function. The closure performs the same existing rule before registered handlers run. A shared implementation prevents tests from silently replacing the outer gate with a direct handler registration.

Three external-dispatch regressions are executed with feature absent and present:

- An actual InvokeRequest for all five commands is denied in default build, leaves no review tables and preserves task version1. Feature build allows publication/read/enqueue/commit/recover and produces native version3 plus exactly one awaiting_dispatch intent. The ordinary save_calendar_task path remains allowed.
- Nonisolated ordinary profile rejects every review command with403 in both builds, before review migration.
- External integration, unknown command and review-command suffix requests are rejected by the outer dispatcher before any backend operation.

The stdio worker used by the existing headless DOM/native bridge now also uses the shared outer dispatcher and actual Scope::from_isolated conjunction. This reruns the entire request/commit/reopen and five process-crash scenarios through the corrected gate. Direct core fixture tests remain clearly separate.

Validation: default dispatcher3 PASS; feature native suite23 PASS + one ignored fixture worker explicitly used by Node; targeted DOM/native bridge14 PASS. Native compilation offline PASS for default and feature variants. Diff check and privacy guard PASS. Logs/executable hashes/source manifest supplied outside public Git. No new dependencies, GUI, network, production permissions, real owner, migration target or remote access.

Evidence remains headless: MockRuntime supplies InvokeRequest transport; the tested application filter is the exact shared function used by Wry. No real WebView/native-window acceptance is claimed. Earlier prototype migration/single-profile/publisher/dispatch/power-loss limits remain in effect. The five commands stay default-disabled and single-profile isolated only.
