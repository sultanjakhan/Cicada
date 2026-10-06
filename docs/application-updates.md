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

## Routine compatibility in 0.4.0

Update all synchronized devices to 0.4.0 before sharing branching routines.
Graph plans and daily graph snapshots use MVP record envelope version 2. Earlier
published clients reject that envelope and pause incoming synchronization without
advancing the receive cursor or partially installing a checkpoint. Receiving can
resume after the client is updated; this is not uninterrupted mixed-version sync.
Existing non-graph routines continue to use version 1.

Once a recurring identity uses version 2, edits and deletion retain that version.
Conflicting version 1 edits are retained for explicit resolution rather than
overwriting the upgraded record. Choosing an incoming edit retains version 2 and
the original conflict archive; it cannot restore an already deleted routine.

The supported upgrade starts from published 0.3.35, which never emitted graph
routines. Startup also upgrades stored graph records from earlier isolated DEV
builds, but this does not rewrite already sealed or uploaded experimental version
1 graph batches. Such DEV synchronization histories are outside this release's
compatibility guarantee and must not be mixed into a production sync profile.

## Installation behavior

Owner update policy, 2026-10-04: native/background checks may download verified
packages, but never install, restart, request focus or open system UI. On app
entry an available release appears as a nonmodal offer with Install and Later.
Discovery during an active session waits for the next entry. Later suppresses
the same release during that app session; a later release can still be offered.
Unsaved drafts and unfinished mutations disable installation in this offer.
Settings retain an explicit check/install action. Permission and confirmation
screens open only after the owner's action. Failed checks retry with bounded
backoff. The old automatic-install IPC always refuses, including old renderers.

Windows uses the official Tauri updater and NSIS. `windows/update-hooks.nsh`
retains the old executable beside the installed file instead of basename-wide
process termination. Only the installed binary with the standard profile
registers per-user logon and six-hour tasks. A production folder selected through
Cicada settings also qualifies; DEV and isolated QA profiles remain excluded.
Their windowless
`--update-background` process skips while the profile is already open, otherwise
checks and prepares a verified package without launching an installer.

Android's six-hour WorkManager job checks and prepares a verified package while
no Activity exists, subject to network, battery and storage constraints. It never
creates an installation session. Explicit installation rechecks package, version
and existing signer. Android may require a one-time install permission or system
confirmation, opened only through an explicit action. OS scheduling is not an
exact deadline; foreground checks remain available when background work is delayed.

macOS Apple Silicon support starts with 0.3.18. The existing per-user
`app.hanni.mvp.updates` LaunchAgent checks at login and every six hours without
a window. The profile lock protects an open instance. Background checks leave
the app closed; only explicit installation restarts it. Since 0.5.3 the update target is the
running executable's physical application bundle; its location and display name
are not allowlisted, and no Applications alias is required. Bundle aliases resolve
to the same verified physical target before restart. The bundle must have the
`app.hanni.mvp` identifier, `hanni-mvp` executable, valid code signature and regular
(non-symlink) executable/Info.plist. Its directory and parent must be owned by the
current account and writable by that owner. Every physical ancestor must be owned
by the current account or root, without group/world write permissions or ACL
write grants. Conservative ACL checks may refuse otherwise legitimate custom
write ACLs. A
production data folder selected in settings remains supported. DEV and isolated
profiles, unbundled executables, invalid bundles and unsafe update targets are
rejected. Targets on a different filesystem from the system temporary directory
are unsupported and rejected before offering an update: the pinned Tauri installer
uses temporary-directory staging and rename. Package authenticity still requires the pinned update signature; an
ad-hoc bundle signature does not prove Developer ID provenance.
The background job uses the verified physical executable. Only exact
Cicada-generated LaunchAgent documents are migrated from previous locations;
custom jobs and linked plist files remain untouched. Enrollment compares the
loaded executable on every attempt, so a failed reload retries even after the
on-disk job has already been rewritten. Before installation handoff, the complete
validation is repeated and directory/executable identities must match the target
captured before download. This is not an OS directory pin against changes by the
same account. Startup never moves or executes an invalid legacy bundle.
LaunchAgent errors appear in update settings; the private
`updates/background.json` receipt records background checks. macOS may delay
scheduled jobs during sleep or restrict background items.

The 0.3.22 updater extracts the archive contents into the old
`~/Applications/Hanni MVP.app` bundle. On its first startup, 0.3.23 renames that
bundle to `~/Applications/Cicada.app`, executes the new binary, keeps a legacy
symlink for the existing LaunchAgent, and updates the plist to the new path.

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

Windows distribution packaging now requires `HANNI_MVP_UPDATES_URL` and
`HANNI_MVP_UPDATES_TOKEN`, and verifies that the resulting executable contains
that exact configuration before emitting the package manifest. Unconfigured
DEV/no-bundle builds remain available. A local candidate must not replace the
installed app unless its update configuration is verified; a scheduled task
alone does not prove that the installed binary can check the channel.

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
