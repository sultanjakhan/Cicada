# Windows release acceptance without VM

The earlier NSIS installer is not isolated by an inactive desktop. It changes
production registration/shortcuts. Do not run it for acceptance.

The release now supports only an explicit Windows profile:
`hanni-mvp.exe --isolated-test-root ABSOLUTE_ROOT [--background]`.
The existing root must contain a regular, single-link, bounded
`cicada-isolated-test.json` with exactly:

```json
{"schemaVersion":1,"application":"app.hanni.mvp","purpose":"isolated-release-test"}
```

Root/path/marker validation runs before Tauri constructs a window or SQLite
opens. Missing/relative/linked/protected roots and ambiguous overrides exit
nonzero; there is no fallback to production. Roaming/Local AppData trees and
their ancestors are rejected using native Known Folder paths. Credentials and
unknown root entries are forbidden. Root directory handles prevent rename;
ordinary known fixture files reject hardlinks. A profile-local file lock gives
an independent single-instance namespace.

SQLite, backups and the explicit absolute WebView2 data directory are under
that root. The window is marked `[isolated test]`. The default WebView2 path is
not used. Sync/updater/task enrollment are not started; updater/Android plugins
are not registered. The IPC allowlist admits only local Calendar/SQLite work.
Health, sync/update actions, external URLs, folder chooser and folder inspection
are disabled. Unknown new commands default to denied. The unchanged core ACL
does not permit frontend creation of additional webviews. This is an application
QA mode, not a claim of OS sandboxing against an adversarial local administrator.

Portable upgrade can avoid installer writes: retain registered EXE path, save
old EXE and consistent SQLite backup, verify candidate hash, replace only the
EXE via a staged neighbor, verify installed hash, and preserve the data path and
credentials. Windows registration/uninstaller metadata would remain at its
previous installer version; that limitation must be disclosed. Production
replacement still requires independent QA of the final hash and the user's
confirmation that drafts are saved. No current helper can deploy production.

`scripts/portable-update-fixture.py --root .local/NEW_FIXTURE` proves wrong-hash
rejection, file-only upgrade and EXE/SQLite rollback on synthetic data only.
It never reads credentials or invokes installer/registry/shortcuts operations.

Acceptance on DESKTOP-4313SFA used the actual optimized 0.4.2 release (build
`20261002-local.2`), SHA256
`517776276885F99D4C432C3702E608F89CDB74B95AF142ABC321DF648B580950`.
Missing-marker, relative-root and conflicting-sync startup attempts exited 1
without creating SQLite or a WebView profile. The valid isolated release denied
ten integration actions, used only its owned WebView profile, and restored a
synthetic task's completed step and saved result after process restart. No agent
run was created. Both foreground and hidden background launches stayed on the
inactive QA desktop; native visibility was respectively true and false.
The checked-in suite passed 508 JS tests and 191 Rust tests (4 Rust ignored).
Independent final-hash QA and saved-draft confirmation remain required before
production replacement. This evidence does not validate the NSIS installer.
