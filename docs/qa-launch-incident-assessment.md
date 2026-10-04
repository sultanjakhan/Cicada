# Preliminary QA launch incident: static assessment

The parent's incident record describes PID 1228 on 2026-10-02 at 17:53 UTC:
optimized candidate `b3998fb`, no application flags, environment-only data
override, exit before readiness, no recorded exit reason or production baseline.
It does not establish that production was untouched. No repeated production
launch, database read, credentials read or rollback was performed here.

## Lock guarantee is conditional

In `b3998fb` setup, the order is app-data resolution/create_dir_all, open/create
`hanni-mvp.instance.lock`, `try_lock`, SQLite presence check/open, WAL pragma,
schema initialization, new-profile marker, managed state/lock, sync/update start.
The native OS file lock, if another process held the same profile's same lock
file, rejects before SQLite open. The local variable retains the successfully
acquired lock through initialization and managed state retains it thereafter.

An already-open application window does not prove that exact lock was held at
the incident time: its build, profile and actual lock ownership must match.
No event trace/exit reason proves the preliminary process failed at try_lock.
Normal Tauri window/WebView construction can precede setup; WebView files alone
do not establish that the SQLite stage was reached. Directory and lock opening
precede the database guard. If try_lock succeeded, SQLite/WAL/schema and sync
were reachable. Therefore no blanket no-writes/no-credentials/no-sync assurance
is justified. Existing WAL timestamps cannot attribute writes under concurrent
production activity. No rollback is warranted without evidence of corruption.

## Schema compatibility evidence and limits

The known pre-work source baseline `d2d10c` and candidate `b3998fb` both have
`SCHEMA_VERSION = 5`; their complete `init_schema` function is byte-identical
(SHA256 `dfa9aabfe67f40d35cb1f941bf25c6c9acfb42bf21bdc7115dce1a4b398bd961`).
This work introduced no schema migration or version bump. Workflow, exchange,
registry and source preferences use additive `ui_state` keys. The added
`mark_new_profile` write runs only when calendar.db was absent before opening.
These changes are compatible with that baseline's schema; old code ignores the
new keys. SQLite open/WAL pragma and CREATE IF NOT EXISTS still cannot be called
read-only operations. The installed EXE's observed product version 0.4.0 is
not a proof of source commit/schema identity. Exact installed-build provenance
remains unverified; this assessment did not inspect its database.

## Guard correction

Both tracked QA entrypoints now refuse a missing `--release-isolation` before
any application launch. Legacy environment-string detection and env-only launch
are removed for all builds. The candidate must match the supplied hash and
contain the explicit native-isolation support marker. The final process argument
builder requires an existing absolute unlinked root and bounded exact native
marker, then unconditionally supplies `--isolated-test-root` (and `--background`
for hidden mode). The application independently validates protected paths,
unknown entries, aliases and locks before constructing its isolated window/DB.

Pure policy regression tests create synthetic markers and fake binary bytes;
they prove rejection of absent opt-in, legacy-only support, wrong hash, missing
or malformed marker and relative root, plus exact safe foreground/background
arguments. They never call CreateProcess. This does not retrofit an outdated
copy of the launcher: QA must use the corrected tracked scripts, not the old
preliminary copy. The accepted release artifact/hash is unchanged. Production
installation/closure remains paused while the parent resolves the incident and
obtains saved-draft confirmation.

Validation of the improvement branch: 511 JavaScript tests passed (including
the real approved Agent City validator in temporary storage and the pure launch
policy regression), Python syntax and whitespace checks passed. Frontend build
passed for the preceding UI-only improvement. No native process was launched
for this guard correction.

## Filesystem preparation follow-up

Independent N3/N4 review reproduced pre-launch active.lock and rollback staging
hardlink writes against `b3998fb`. Those findings concern helper preparation,
not proof of a production exploit. The night helper now pins ordinary Windows
ancestor/tree directories with GENERIC_READ and no delete sharing, checks
opened-file reparse attributes and link count before writes, and writes controls
through that verified handle. New staging/backup files use CREATE_NEW; rollback
also validates its synthetic root and pins SQLite file identity. Existing files
are not truncated merely to inspect them. Artifact output uses a new child
directory per launch. No ACL or OS security settings change.

Seven synthetic Windows tests cover reused active.lock, rollback staging and
SQLite hardlinks, parent junction, directory rename, concurrent file replacement,
and the actual launcher refusal before desktop/process creation. A synthetic
portable upgrade/rollback also passed with consistent SQLite restoration. These
are application QA safeguards, not a hostile-administrator sandbox claim.

## Independent helper review limitation (7fa8b51)

Independent Windows review confirmed the original N3/N4 pre-existing-hardlink
refusals occur before writes, all seven regression cases pass, and the ordinary
synthetic rollback works. This is not full protection against concurrent writers.
A competing process can still create a new hardlink to an output file while its
write handle is open. The initial link-count check and no-delete sharing do not
prove that no new alias appears after validation. Run helpers only in the owned
QA workspace without competing writers; do not present these checks as a sandbox
against hostile local processes or as complete concurrent-writer protection.
