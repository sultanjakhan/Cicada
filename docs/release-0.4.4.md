# Cicada 0.4.4 - 20261003-local.3

Separate local Windows release candidate based on accepted installed 1fb32e6.
Not installed or published; exact executable acceptance is recorded separately.

- Settings/About exposes the existing persisted light/dark preference.
- Existing task details show the confirmed current or nearest planned step and waiting work above the collapsed manual workflow; no new screen or implicit execution.
- Imported registry reports use Russian status and observation freshness labels across existing views. Recorded status, freshness calculation, binding and wire schema are unchanged; stale observations never become live execution.
- Eligible source onboarding uses existing neutral product buttons, wrapping actions and visible keyboard focus. Eligibility, explicit Save/Skip and failure recovery are unchanged.

The two reviewed source fixes are 024258a6a75daefe7c56a50c787a0e1fac1e2d05
and 04a086b47dd4acb09055fb6499c1b3585f165590. Their independent source/browser
reviews do not prove this combined executable's native persistence or visual acceptance.
The two remaining small UI defects were reproduced using synthetic JSDOM state
before applying copy/style fixes; no real integration records were used.

No experimental workflow-snapshot IPC/contract from 8f14035, delivery queue,
Agent City changes, credential migration, model dispatch or production edits.
This build does not resolve access to installed production UI/IPC for task creation.

Run the exact candidate only through the guarded isolated QA launcher with a
fresh marked root and integrations disabled until independent acceptance and
separate production installation authorization. No full native PASS is claimed.

QA-POP-001 followup: short Task/Goal dialogs retain the full title in a keyboard-scrollable header context, reserving usable body and footer actions. No title or content limit changes. Real shared dialog factory/CSS regression covers 16 headless Edge variants (390x320 and 640x400, light/dark, Task/Goal, 70/500 CJK characters plus Unicode prefix); no native short-viewport acceptance is implied.
The intermediate local.1 executable/manifest at commit 7d16f8a is preserved separately; its scoped native smoke is not evidence for the followup layout.

QA044-002 final display delta: missing, empty or non-string updater installed_version is shown as "Версия не сообщена", without borrowing a number from About or changing updater actions/policy. A valid reported version remains authoritative. Initial rejected status IPC and later status recovery are covered in JSDOM. Independent native coverage qa-native044-coverage.json belongs to prior ebc/local.2; final copy delta requires exact-source/executable retest.
