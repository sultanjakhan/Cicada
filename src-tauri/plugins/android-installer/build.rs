// These names are used by the plugin metadata. Native Android dispatch below
// uses Kotlin method names (`installVerified`, `openInstallPermission`).
const COMMANDS: &[&str] = &["install_verified", "open_install_permission"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .try_build()
        .expect("failed to build Android installer plugin bindings");
}
