# Android debug build

Android support has been checked by building an ARM64 debug APK. Installation,
launch and synchronization on physical devices remain separate checks.

Requirements: Node/npm dependencies, Python 3, Rust `1.98.1` with
`aarch64-linux-android`, JDK 21, Android SDK platform 36, Build Tools 35.0.0 and
NDK `27.2.12479018`. Set `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` to their
installation directories. The generated project uses Gradle 8.14.3, Android
Gradle Plugin 8.11.0 and Kotlin 1.9.25. AGP 8.11 requires Gradle 8.13+ and JDK 17+;
the listed toolchain passed the build. See the [AGP requirements](https://developer.android.com/build/releases/agp-8-11-0-release-notes).

From this repository root, after installing npm dependencies:

```sh
export HANNI_SESSION_ID=android-build
export RUSTUP_TOOLCHAIN=1.98.1
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export CARGO_TARGET_DIR="$PWD/.local/android-cargo-target"
rustup target add --toolchain 1.98.1 aarch64-linux-android
npm run tauri -- android init --ci --skip-targets-install
python3 scripts/prepare-android.py
npm run tauri -- android build --debug --target aarch64 --apk --ci
```

Use a unique session ID when building concurrently. Initialize through `npm run
tauri` so the generated Gradle task uses the same npm runner. Reapply the guard
after every init: generated Android files are ignored and can be replaced by init.
The guard also accepts a repository root argument and refuses other app identities
or conflicting backup settings without overwriting them.

Preparation also generates the standard and adaptive Android launcher icons from
`src-tauri/icons/icon.png`. Run it for DEV builds too; skipping it leaves Tauri's
default launcher icon in the generated project.

The guard disables Android-managed backup and transfer of the MVP private
profile, including synchronization credentials, temporary credential files and
the database's device identity. It preserves the existing INTERNET permission and
unrelated manifest settings. Both legacy backup XML and Android 12+ cloud/transfer
rules are generated and structurally checked. The app's own SQLite backup remains
available. See [Android backup rules](https://developer.android.com/identity/data/autobackup).

Output: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
The current artifact is debug signed, contains only `arm64-v8a`, uses Android 7+
(minSdk 24), targets SDK 36 and retains `Hanni MVP` / `app.hanni.mvp`. Its debug
signature is a build check; compatibility with an existing installation requires
the same application ID and signing certificate. Release signing is a separate
step described in the [Tauri Android signing guide](https://v2.tauri.app/distribute/sign/android/).

## CI debug candidate

`Android debug candidate` is started manually in GitHub Actions. It pins Node 22,
Rust 1.98, JDK 17, SDK 36, Build Tools 35.0.0 and NDK 28.2.13676358, then uploads
one ARM64 APK and `manifest.json`. The manifest records the source commit, SHA-256,
version code and CI debug certificate. It is a review candidate only: its fresh CI
debug certificate is not authorised to update an installed Hanni MVP. Compare the
certificate before any installation; never solve a mismatch by uninstalling the app.
