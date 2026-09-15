//! Android-only system installer bridge for an APK that Rust has already verified.
//!
//! This crate deliberately does not download files or decide whether an update is
//! available. The Android implementation repeats the security boundary checks at
//! the final hand-off to the operating-system package installer.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.hanni.mvp.android.installer";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallVerifiedRequest {
    /// Absolute path to a file that must resolve below `<cache>/updates/`.
    pub path: String,
    pub expected_version_code: u64,
    /// Lowercase SHA-256 of the exact file.
    pub expected_sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstallStatus {
    Launched,
    PermissionRequired,
    Unsupported,
}

/// Access to the bounded Android package-installer bridge.
pub struct AndroidInstaller<R: Runtime>(Option<PluginHandle<R>>);

impl<R: Runtime> AndroidInstaller<R> {
    /// Opens Android's system confirmation UI only after the native Android
    /// bridge has checked cache location, hash, package id, version and signer.
    /// `Launched` means Android received the request; it never means installed.
    pub fn install_verified(
        &self,
        request: InstallVerifiedRequest,
    ) -> Result<InstallStatus, String> {
        let Some(handle) = &self.0 else {
            return Ok(InstallStatus::Unsupported);
        };
        handle
            .run_mobile_plugin("install_verified", request)
            .map_err(|error| error.to_string())
    }

    /// Returns `permission_required` until the user grants Android's install
    /// unknown apps permission. It only opens the settings page when this method
    /// is called explicitly by the product UI.
    pub fn open_install_permission(&self) -> Result<InstallStatus, String> {
        let Some(handle) = &self.0 else {
            return Ok(InstallStatus::Unsupported);
        };
        handle
            .run_mobile_plugin("open_install_permission", ())
            .map_err(|error| error.to_string())
    }
}

pub trait AndroidInstallerExt<R: Runtime> {
    fn android_installer(&self) -> &AndroidInstaller<R>;
}

impl<R: Runtime, T: Manager<R>> AndroidInstallerExt<R> for T {
    fn android_installer(&self) -> &AndroidInstaller<R> {
        self.state::<AndroidInstaller<R>>().inner()
    }
}

/// Initializes the Android bridge. On desktop it intentionally provides no
/// implementation: callers receive `Unsupported` before invoking it.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-installer")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin(PLUGIN_IDENTIFIER, "AndroidInstallerPlugin")?;
                app.manage(AndroidInstaller(Some(handle)));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(AndroidInstaller(None));
            }
            Ok(())
        })
        .build()
}
