# Cicada

[![CI](https://github.com/sultanjakhan/Cicada/actions/workflows/ci.yml/badge.svg)](https://github.com/sultanjakhan/Cicada/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sultanjakhan/Cicada)](https://github.com/sultanjakhan/Cicada/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Русская версия](README.ru.md)

Cicada is a local-first planner for goals, tasks, calendar and notes. Your data stays in a SQLite file on your device: no account, no cloud, no telemetry. If you use several devices, you can run your own end-to-end encrypted sync relay.

Built with Tauri 2, Rust and plain JavaScript.

> **Status:** early (0.x), one maintainer. **The interface is in Russian only.**
> Platforms: Windows x64, macOS on Apple Silicon, Android ARM64. Linux is not supported yet.

## Features

- **Dashboard** — the current goal, the current task and a work timer.
- **Calendar** — day, week and month views; tasks and events share one form.
- **Tasks** — active, today, undated and completed; search and filter by goal, including subgoals.
- **Goals** — subgoals, result criteria, skills and stages with deadlines, linked to tasks and events.
- **Notes** — explicit drafts, archive and restore.
- **Routines** — recurring actions you start and track from the calendar.
- **Local and safe** — SQLite with transactional migrations and verified online backups.
- **Optional sync** — end-to-end encrypted with XChaCha20-Poly1305 through a relay you host yourself on Cloudflare Workers. See [docs/sync-relay.md](docs/sync-relay.md).
- **Android** — sleep and activity import from Health Connect.
- **Signed updates** — the app verifies the update signature before installing.

## Install

Download a file from the [latest release](https://github.com/sultanjakhan/Cicada/releases/latest):

| Platform | File | Note |
|---|---|---|
| Windows x64 | `Cicada-<version>-windows-x86_64.exe` | The installer has no Authenticode certificate, so SmartScreen may warn. Choose *More info → Run anyway*. |
| macOS, Apple Silicon | `Cicada-<version>-darwin-aarch64.app.tar.gz` | Contains `Cicada.app`. First launch is described in [docs/macos-build.md](docs/macos-build.md). |
| Android ARM64 | `Cicada-<version>-android-aarch64.apk` | Allow installs from the source you downloaded it with. |

A new install starts with an empty profile. Updates keep your data.

## Build from source

Requirements: Node.js 22.12+, Rust 1.98+ and Python 3. On Windows you also need Visual Studio Build Tools with C++ and WebView2; on macOS, Xcode Command Line Tools. Android builds are described in [docs/android-build.md](docs/android-build.md).

```sh
git clone https://github.com/sultanjakhan/Cicada.git
cd Cicada
npm ci
git config core.hooksPath .githooks
npm run tauri dev
```

In Windows PowerShell, use `npm.cmd` instead of `npm`. In a debug build, `HANNI_MVP_DATA_DIR` set to an absolute path gives you a separate test profile.

## Checks

```sh
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run check:privacy
```

`npm run check:history` also scans every reachable commit and its metadata. The sync relay has its own tests: `npm --prefix sync-relay ci`, then `npm --prefix sync-relay test`.

## Data and backups

The database is `calendar.db` in the app data folder, for example `%APPDATA%\app.hanni.mvp` on Windows. Backups go to the `backups` subfolder and use SQLite online backup with an integrity check.

Older versions cannot read a newer database schema. Before going back to an older version, keep a backup made before the update.

## Project layout

- `src/` — app shell (`app.js`, `index.html`) and UI components in `src/hanni/`.
- `src-tauri/` — Rust backend: storage, migrations, backups, sync and updates.
- `src-tauri/plugins/android-installer/` — Android plugin: updates and Health Connect.
- `sync-relay/` — Cloudflare Worker for encrypted sync.
- `update-service/` — Cloudflare Worker that serves signed update manifests.
- `scripts/` — packaging, icon generation and privacy checks.
- `docs/` — macOS and Android builds, sync relay, application updates.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately, as described in [SECURITY.md](SECURITY.md).

## License and origin

MIT, see [LICENSE](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Cicada grew out of the author's private app Hanni. That is why some internal identifiers, such as `app.hanni.mvp` and `hanni-mvp.exe`, keep the old name: changing them would break updates and existing data.
