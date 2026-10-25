# Contributing to Cicada

Thanks for your interest. Cicada is a small project with one maintainer, so small, focused pull requests are the easiest to review. Issues and pull requests are welcome in English or Russian.

## Before you start

- For a bug, open an issue with steps to reproduce, your platform and the app version.
- For a new feature or a larger change, open an issue first and describe the problem you want to solve. This saves work on both sides.
- Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Set up

Requirements: Node.js 22.12+, Rust 1.98+ and Python 3. On Windows you also need Visual Studio Build Tools with C++ and WebView2; on macOS, Xcode Command Line Tools.

```sh
git clone https://github.com/sultanjakhan/Cicada.git
cd Cicada
npm ci
git config core.hooksPath .githooks
npm run tauri dev
```

In a debug build, set `HANNI_MVP_DATA_DIR` to an absolute path to keep your test data apart from your real profile.

## Commit email

The privacy checks reject personal email domains (Gmail, Outlook, iCloud, Yandex and similar) in commit metadata, and the pre-push hook runs the same check. Use your GitHub noreply address for commits in this repository:

```sh
git config user.email "<id>+<username>@users.noreply.github.com"
```

You can find the address in GitHub → Settings → Emails.

## Before you open a pull request

Run the checks:

```sh
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run check:privacy
```

In the pull request:

- Describe the user-visible change and how you tested it.
- Add screenshots for interface changes.
- Add or update tests: JavaScript tests live in `tests/`, Rust tests next to the code in `src-tauri/`.
- Keep test data made up. The privacy guard fails on personal email addresses, phone numbers, private keys and access tokens.

## Names that must not change

Cicada keeps some identifiers from its predecessor, Hanni. Changing them breaks updates and existing user data:

- the app identifier `app.hanni.mvp` and the data folders based on it;
- `hanni-mvp.exe`, the `hanni-mvp` crate and `hanni_mvp_lib`;
- the Windows install folder `Hanni MVP`, its uninstall key and the update scheduled tasks;
- environment variables `HANNI_MVP_*`, `X-Hanni-MVP-*` headers and the sync and update Worker names.

If a change needs to touch one of these, raise it in an issue first.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
