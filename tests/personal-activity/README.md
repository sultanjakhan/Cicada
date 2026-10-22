# Selected-game observation checks

Run the portable reducer/storage tests without building Tauri:

```sh
cargo test --locked --manifest-path tests/personal-activity/Cargo.toml
```

The same cases are included by the native module under `cfg(test)`. All database
records and source samples in these tests are fictional and isolated in memory.

The adapter can also be type-checked against the Windows SDK bindings, without
linking an application or compiling bundled SQLite:

```sh
cargo check --locked --manifest-path tests/personal-activity/windows-api/Cargo.toml --target x86_64-pc-windows-msvc
```

This requires an installed Windows Rust target. Passing it proves API/type
compatibility, not an installed application or actual Windows observation.

## Runtime contract

The root application initializes the module schema in its existing profile
SQLite database, registers the three commands and calls `start(calendar.db)` once
in a regular Windows application process. Do not call it from isolated tests,
update-only launches or one-shot commands. The worker opens only that existing
database, with its normal SQLite locking and a bounded busy timeout.

Collection defaults to OFF. Enabling requires an explicit list of executable
basenames; `expectedRevision` rejects stale settings writes. Disabling preserves
history and prevents old-revision samples from being committed after it returns.
A platform without the Windows adapter cannot enable collection.

A game interval needs two adjacent active samples of the same selected basename.
Sampling is every five seconds while the app process runs. Foreground/desktop
transition hooks invalidate intervening switches. Sampling gaps above eight
seconds, clock changes, sleep detected from biased/unbiased uptime, source
failures, locked/secure desktops, disconnected sessions, unselected applications,
keyboard/mouse idle at sixty seconds, startup and config changes break continuity.
No previous unseen period is backfilled. Adjacent intervals merge into chunks no
longer than sixty seconds. Reducer state advances only after SQLite commits;
failed storage resets it and cannot produce a fabricated successful observation.

The adapter asks for a process **basename**, never a full path, window title,
object contents or screenshot. It returns only an allowlist match to storage.
Errors are fixed codes without raw Windows/SQLite diagnostics.

Day retrieval accepts one bounded civil day, keeps interval identities and UTC
millisecond boundaries, clips to the requested bounds and never writes history.
Callers union overlapping intervals rather than summing them twice. Empty or
partial observations do not prove zero gaming, complete coverage, rest or focus.
The collection state can be disabled/unsupported while saved intervals remain
readable. The collector does not change task status, task timers or health data.

## Acceptance limits

- Windows foreground observation is a sampled estimate, not proof of attention.
- Controller-only input is unsupported; keyboard/mouse idle can exclude an active
  controller session. `controllerSupported` remains false.
- Protected processes, different integrity/bitness restrictions or failed Windows
  source calls leave observation unavailable. No title/path fallback is allowed.
- The collector runs only while this application process is running.
- Game history and settings are **local to this profile/device**. They are not
  included in content synchronization. No cross-device delivery is claimed.
- No iPad connector is implemented.
- The portable tests and API-only type check do not establish real Windows
  foreground, lock/unlock, sleep/resume or installed-game acceptance.

## Primary API references

- [GetModuleBaseNameW](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getmodulebasenamew)
- [GetLastInputInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo)
- [SetWinEventHook](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)
- [OpenInputDesktop](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop)
- [QueryUnbiasedInterruptTime](https://learn.microsoft.com/en-us/windows/win32/api/realtimeapiset/nf-realtimeapiset-queryunbiasedinterrupttime)
