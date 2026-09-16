# Application updates

Starting with 0.3.14, the native updater checks after startup and every six hours,
downloads verified packages, and installs when the app is idle and hidden.
Open editors, unsaved drafts, native mutations and active timers defer it. A
renderer lease must remain safe for 30 seconds and expire after 90 seconds.
Failed checks/installations retry with bounded backoff; installation attempts
are recorded on disk so process restarts cannot create an immediate retry loop.
Settings retain an explicit check/install action and report system restrictions.

Windows uses the official Tauri updater and NSIS. `windows/update-hooks.nsh`
replaces only NSIS's basename-wide process termination: the old executable is
retained beside the installed file before replacement. Only the installed Windows
binary with the standard data profile registers per-user logon and six-hour tasks.
Separate Windows copies and QA data profiles cannot install automatically.
Their windowless `--update-background` process skips when the profile is already
open. Automatic installation leaves the app closed and does not take focus.
Android 12+ uses PackageInstaller sessions requesting no user action. A six-hour
WorkManager task also checks while no Activity exists, subject to network, battery
and storage constraints. Both paths recheck package, version and existing signer.
Android may require a one-time install permission or system confirmation; Hanni
reports that state and opens the system UI only through an explicit user action.
Android 7–11 retain manual installation. OS scheduling is not an exact deadline.

The client checks HTTPS origin, bounded size, SHA-256 and a pinned Minisign key.
Before handing off to the installer it creates a consistent SQLite backup.
The download bearer is a limited read capability embedded in the app; it is not
a confidentiality boundary for someone who possesses the binary. The release
channel contains application packages only, never personal databases or relay
credentials. The independent data-sync service is unchanged.

## Preparing the next version

1. Increment `package.json`, its root lock entries, Cargo package/lock and Tauri
   config together. Commit the intended source on private `main`.
2. Run the **Signed update candidate** workflow for that commit. It requires
   `MVP_UPDATER_PRIVATE_KEY`, `MVP_UPDATER_PRIVATE_KEY_PASSWORD`,
   `MVP_ANDROID_KEYSTORE_BASE64`, `MVP_UPDATES_URL`, and `MVP_UPDATES_TOKEN` repository
   secrets. Keep both signing keys stable. Android uses the same persistent
   certificate as the installed application; the CI runner must never replace it
   with an automatically generated key.
   The runner passes `MVP_ANDROID_KEYSTORE_PATH` to explicitly sign the finished
   APK with `apksigner`; restoring a default Gradle key alone is insufficient.
   AGP compresses native libraries (`useLegacyPackaging = true`) to fit the
   25 MiB delivery limit. Android extracts them during installation.
3. Download the two successful candidates. If GitHub artifact storage is full,
   the workflow stores them in private draft releases named
   `windows-update-candidate-<run>` and `android-update-candidate-<run>`.
   Verify the run's commit and each manifest's `source` before staging.
4. Run `node scripts/stage-updates.mjs --windows <directory> --android <directory>`.
   This verifies both signatures, hashes, versions and source equality, retaining
   previous packages. It writes `.local/update-assets/latest.json` last.
5. Deploy with `node sync-relay/node_modules/wrangler/bin/wrangler.js deploy
   --config update-service/wrangler.jsonc` from an authenticated operator session.
   `UPDATES_TOKEN` is a Worker secret. Keep `run_worker_first: true` so requests
   cannot bypass authentication by requesting an asset directly.
6. Verify unauthorized GET is 401, authorized feed/package hashes match, and an
   installed older client detects and applies the release without losing records.

Do not call a build or draft release an installed update. The bootstrap version
must be installed once before an older application can use this channel. An
Android sideload update does not remove application data or require reinstalling
from scratch when the package and signing certificate remain the same.

## Verified installation, 2026-09-16

The installed Windows client detected and installed 0.3.10 from 0.3.5, then
restarted itself. A physical Android client detected 0.3.10 from 0.3.9 and installed
it through Android's permission, confirmation and Play Protect flow. Both checks
started automatically; the install buttons were exercised in the real apps.
Native version labels and a subsequent Android restart reported 0.3.10. The
installed APK hash matched the signed delivery candidate.

All application records and Android sync credentials were retained. Comparing all
32 SQLite tables on each device found only the expected `mvp_sync_meta.last_success`
timestamp change. The three unrelated Windows QA processes remained running; one
ordinary Windows window remained minimized without taking focus. Windows pixel
capture while minimized was unavailable; the Android settings screenshot and both
native interaction paths were checked. Mac update installation was not tested.

Private backup and acceptance receipts are retained locally under
`.local/auto-update-20260916-c4e8/`; they are never release assets or Git content.

## Unattended Windows acceptance, 2026-09-16

Version 0.3.14 was built from `52c398f893fbbddde5e59b65321e94540629ee2f` in
[signed candidate run 35084194415](https://github.com/sultanjakhan/hanni-mvp/actions/runs/35084194415).
Both Windows and Android jobs passed, including 209 JavaScript tests, 102 Windows
Rust tests (4 ignored), privacy checks and Android installer plugin tests. Seven
Python packaging tests also passed locally. Both downloaded candidates matched
the commit/version and passed pinned-key signature, hash and size verification.
The authenticated live feed and both packages returned 200 with matching bytes;
unauthorized requests returned 401.

Windows was bootstrapped from 0.3.10 to 0.3.12 with an encrypted recovery copy.
Two unattended paths then passed on the installed production profile:

- 0.3.12 → 0.3.13 with Hanni closed, through the existing six-hour Windows task.
  The task was triggered manually for acceptance; its ordinary six-hour deadline
  and a real Windows logon were not waited for.
- 0.3.13 → 0.3.14 after starting Hanni minimized. The native startup loop detected,
  downloaded, deferred until its idle lease matured, and installed the new version.
  No check/install command or installer button was used during this update cycle.

Each update created its own consistent database backup and left Hanni closed.
The final 0.3.14 launch confirmed the version in the native UI, a current update
status with no errors, and successful registration of both least-privilege tasks
for the current account. One ordinary window was restored minimized without focus.
All 32 tables and sync credentials were preserved through the complete sequence;
only the expected `mvp_sync_meta.last_success` timestamp was excluded from the
row comparison after normal synchronization resumed.

Native checks on 0.3.12/0.3.13 verified the editor veto, a renewed 30-second safe
interval after closing a dialog, and the scheduled runner skipping an open
profile without stopping its process. Pixel screenshots while minimized were
not used as evidence. Private receipts and recovery copies are under ignored
`.local/unattended-20260916-b7e2/`, with the summary in `acceptance.json`.

Android 0.3.14 is signed, packaged, tested in CI and available through the same
channel. The phone was unavailable over ADB during this run: bootstrap installation,
WorkManager execution, PackageInstaller behavior and data retention on the physical
phone remain unverified. The next device step is to install the signed 0.3.13
bootstrap over the existing app with a backup, then verify its unattended upgrade
to the published 0.3.14. Do not treat the Windows result as Android acceptance.
