# Application updates

## Public distribution

The first public release is 0.3.16. Its Windows x64 installer and Android ARM64
APK are published in [GitHub Releases](https://github.com/sultanjakhan/Cicada/releases).
Each platform includes a source/hash manifest and detached update signature.
The application contains the license inventory under `vendor/licenses/`.

Public source uses sanitized Git history. Historical acceptance logs and build
runs from the private development repository are not public-release evidence.
Do not reuse old candidate assets under a new source SHA or overwrite a released
version: increment the version and build from the reviewed public commit.

The black cicada/hourglass mark on white is shared by the app and Android launcher.
The product display name is Cicada. Technical application identity and both
signing keys remain stable.

## Installation behavior

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
Android may require a one-time install permission or system confirmation; Cicada
reports that state and opens the system UI only through an explicit user action.
Android 7–11 retain manual installation. OS scheduling is not an exact deadline.

macOS Apple Silicon support starts with 0.3.18. Install this bootstrap once in
`~/Applications/Cicada.app`; later signed releases use the same channel.
The per-user `app.hanni.mvp.updates` LaunchAgent checks at login and every six
hours without a window. The profile lock prevents it from interrupting an open
instance; that instance uses the existing hidden/idle checks instead. Automatic
installation leaves the app closed. The manual Settings action restarts it.
DEV, relocated bundles, nonstandard profiles and non-writable bundles cannot
replace the installed app. LaunchAgent errors appear in update settings; a
private `updates/background.json` receipt records closed-app checks/installations.
macOS may delay scheduled jobs during sleep or restrict background items.

The 0.3.22 transition may place `Cicada.app.tar.gz` inside the old
`~/Applications/Hanni MVP.app`. On startup, 0.3.23 moves the bundle to
`~/Applications/Cicada.app`, keeps a legacy symlink for the existing LaunchAgent,
reopens the new executable and updates the plist to the new path.

The macOS archive uses the existing pinned Minisign update key. Its application
bundle retains the local ad-hoc code signature; Developer ID/notarization are
not configured. This channel is for the owner's already trusted local install,
not a claim of Apple-notarized public distribution.

The client checks HTTPS origin, bounded size, SHA-256 and a pinned Minisign key.
Before handing off to the installer it creates a consistent SQLite backup.
The download bearer is a limited read capability embedded in the app; it is not
a confidentiality boundary for someone who possesses the binary. The release
channel contains application packages only, never personal databases or relay
credentials. The independent data-sync service is unchanged.

## Preparing the next version

1. Increment `package.json`, its root lock entries, Cargo package/lock and Tauri
   config together. Commit the intended source on `main`, with the bundled license notices.
   Run the current-file and full-history privacy checks before pushing.
2. Run the **Signed update candidate** workflow with `platform=all` for that commit. It requires
   `MVP_UPDATER_PRIVATE_KEY`, `MVP_UPDATER_PRIVATE_KEY_PASSWORD`,
   `MVP_ANDROID_KEYSTORE_BASE64`, `MVP_UPDATES_URL`, and `MVP_UPDATES_TOKEN` repository
   secrets. Keep both signing keys stable. Android uses the same persistent
   certificate as the installed application; the CI runner must never replace it
   with an automatically generated key.
   The runner passes `MVP_ANDROID_KEYSTORE_PATH` to explicitly sign the finished
   APK with `apksigner`; restoring a default Gradle key alone is insufficient.
   AGP compresses native libraries (`useLegacyPackaging = true`) to fit the
   25 MiB delivery limit. Android extracts them during installation.
3. Download all three successful candidates. If GitHub artifact storage is full,
   the workflow stores them in unpublished draft releases named
   `<platform>-update-candidate-<run>` (Windows, Android or macOS).
   Verify the run's commit and each manifest's `source` before staging.
4. Run `node scripts/stage-updates.mjs --windows <directory> --android <directory> --macos <directory>`.
   This verifies all signatures, hashes, versions and source equality, retaining
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

## Evidence boundaries

Previous private acceptance covered the Windows unattended updater and a manual
Android update with preserved application records. The public release adds a
new build and delivery check; it does not imply a new physical-device test.
A successful CI build, signature verification, or download is not proof of
installation on an unavailable phone. macOS bootstrap installation and an actual
subsequent automatic version upgrade must be verified separately.
