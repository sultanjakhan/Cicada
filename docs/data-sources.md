# Data source preferences v1

Settings → Connections → Data and sources stores `cicada_data_sources_v1`
using native UI-state CAS. It is outside content-sync keys. Existing profiles
are not reset and no first-launch modal is imposed.

```json
{"schemaVersion":1,"appId":"cicada","sources":[{"appId":"cicada","path":null,"localGit":false,"visible":true,"placement":"projects"},{"appId":"agent-city","path":null,"localGit":false,"visible":true,"placement":"projects"}],"refresh":{"mode":"manual"},"onboarding":{"status":"skipped"}}
```

Windows has a native owned folder chooser; cancellation changes nothing.
Absolute paths can also be entered. Inspect validates existence, directory
types and every ancestor against symlinks/reparse points. UNC/device paths and
filesystem roots are rejected. It checks only metadata of manifest.json,
projects/, tasks/, runs/ and .git/. No files are opened or arbitrary names
enumerated. New paths require preview; save rechecks all configured paths.
Refresh is manual and reports its observation timestamp/error, not task status.

Visibility/placement take effect in the existing Tasks pane: Tasks before the
local task list, or Projects after it. The Cicada section contains the imported
hierarchy without requiring local calendar bindings; Agent City shows source
metadata and clearly states dispatch is unavailable. Architecture is pipelines
only and is not an allowed placement. Existing six panes are preserved.

Only a genuinely newly created calendar.db gets an onboarding eligibility
marker. Setup/Skip persists the choice; existing databases never receive a new
prompt. No Git initialization, private remote creation, file-content import,
sync, credentials or DEV DPAPI database movement occurs. localGit is an explicit
preference, not a repository creation action.
