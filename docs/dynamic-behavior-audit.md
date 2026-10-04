# Dynamic behavior audit, Windows

This improvement branch starts from accepted release source `b3998fb`.
It does not replace that release EXE, change its hash or install anything.
The task-list design belongs to the separate UX workstream; this patch changes
only the expanded task detail and source association.

## Confirmed defects and minimal fixes

1. `task-workflow-view.js` read external reports and registry once at mount.
   Reports imported while a card was open stayed invisible until reopening.
   An explicit **Обновить состояние** now reloads manual workflow, last imported
   run and registry together, preserving unsaved result/step input. Refresh
   performs reads only and does not dispatch an executor. There is no live-feed
   claim or automatic polling.
2. `readRegistryTask` validated a binding's hash but accepted a valid foreign
   namespace with the same native task ID. Imported status could attach to an
   unrelated local task. It now requires the current saved exchange namespace
   and an already-known exact binding. Unbound/foreign work remains available
   in the imported hierarchy, but does not appear as this native task's status.

Regression tests exercise a changed report in an open card with an unsaved
draft, read-only refresh, absent namespace, prepared-but-unbound source, exact
binding, and foreign namespace with matching native ID.

Validation: 510 JavaScript tests passed with the approved Agent City contract
root enabled; frontend build and whitespace checks passed. No Rust source
changed, no native improvement binary was rebuilt, and these new UI changes
have not yet received native WebView acceptance. The previous release artifact
retains its SHA256
`517776276885F99D4C432C3702E608F89CDB74B95AF142ABC321DF648B580950`.

## Current execution boundary

`task-run-exchange.js` exposes explicit source preparation, binding, attempt
allocation and report import/export. The application does not call its attempt
allocation or import/export from a dispatch control. The runnable exchange CLI
is marked synthetic. Folder inspection reads safe metadata; it does not ingest
tasks or launch Git, Jira, Codex or OpenCode. A configured folder is therefore
not evidence that execution or synchronization is running.

The stored namespace is generated, task keys are derived from namespace and
native ID, and run IDs are generated per attempt. Titles, folder paths and
machine names are not part of those identities. Observed reports determine
displayed executor status; missing telemetry/cost remains unknown. A manual
step status or Calendar Start timer does not constitute executor activity.

Starting from either app needs a separate, approved dispatch contract. The
minimum compatible proposal preserves the existing binding and report envelope:
the initiating side creates an idempotent request with request ID, exact binding,
executor choice and explicit user intent; the external execution owner returns
acceptance/rejection and its run ID, then publishes observed reports. Cicada
must not display running before that evidence. Task content transport,
authorization, cancellation, retry and duplicate acknowledgement need agreement
before implementing a production launcher. Binding alone is not authorization.

## Jira and Mac boundary

The inspected Windows checkout has no Jira connector/backend or Jira-specific
connection/import state. Its settings state that limitation. This does not
explain the user's Mac connection. No credentials, corporate issue contents,
new login, sync, external writes or paid inference were used in this audit.

Synthetic Windows checks can verify dynamic namespace/task/run identities,
reordered/duplicate/stale reports, persistence, concurrent-write rejection,
unknown telemetry, registry matching and safe UI refresh. Existing contract
tests also exercise the approved Agent City validator/RunStore in temporary
storage; they do not prove a live cross-app dispatch.

Authorized Mac access is required to identify the Jira-capable build and its
version, connector presence, safe connected/disconnected state, last attempted
import time and redacted error classification, and to locate that build's
actual Jira-to-task identity mapping. Only then can the owner distinguish no
connector, no import request, failed import and imported-but-unbound tasks.
No working projects or issue contents are necessary for those first checks.

Production installation remains blocked by saved-draft confirmation and the
parent's separate release/launcher investigation. This branch does not inspect
production data or independently certify whether another QA launch wrote it.

## Privacy boundary patch integration

The privacy workstream's Cicada-only patch was reviewed and applied to this
improvement branch. Private pointers, credential containers and runtime folders
are ignored; the guard reports private filename metadata and skips content
reads. Review additionally closed a parent-junction gap: the guard checks the
whole path chain before opening content, not only the leaf file.

Four Python privacy tests and both JavaScript privacy/history wrapper tests
passed. A synthetic regression replaces every private-file content read with
an exception; metadata reporting still succeeds. The branch scan checked 326
first-party text files with zero findings. The accepted EXE hash is unchanged.
No data or credential migration was performed. An inactive local data repository
is not evidence that existing DEV/runtime data has moved.
