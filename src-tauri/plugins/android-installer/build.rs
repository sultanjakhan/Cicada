// These names are used by the plugin metadata. Native Android dispatch below
// uses Kotlin method names (`installVerified`, `openInstallPermission`,
// `getInstallStatus`, `openPendingUserAction`).
const COMMANDS: &[&str] = &[
    "install_verified",
    "open_install_permission",
    "get_install_status",
    "open_pending_user_action",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .try_build()
        .expect("failed to build Android installer plugin bindings");
}
