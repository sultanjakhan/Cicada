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

/// Kotlin resolves mobile commands as `{ "status": "..." }`; keeping that
/// envelope explicit prevents Rust from accidentally trying to deserialize the
/// whole object as the `InstallStatus` string itself.
#[derive(Debug, Deserialize)]
struct InstallResponse {
    status: InstallStatus,
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
        let response: InstallResponse = handle
            .run_mobile_plugin("installVerified", request)
            .map_err(|error| error.to_string())?;
        Ok(response.status)
    }

    /// Returns `permission_required` until the user grants Android's install
    /// unknown apps permission. It only opens the settings page when this method
    /// is called explicitly by the product UI.
    pub fn open_install_permission(&self) -> Result<InstallStatus, String> {
        let Some(handle) = &self.0 else {
            return Ok(InstallStatus::Unsupported);
        };
        let response: InstallResponse = handle
            .run_mobile_plugin("openInstallPermission", ())
            .map_err(|error| error.to_string())?;
        Ok(response.status)
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
                app.manage(AndroidInstaller::<R>(Some(handle)));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(AndroidInstaller::<R>(None));
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::{InstallResponse, InstallStatus, InstallVerifiedRequest};

    #[test]
    fn response_envelope_maps_kotlin_permission_status() {
        let response: InstallResponse =
            serde_json::from_str(r#"{"status":"permission_required"}"#).unwrap();
        assert_eq!(response.status, InstallStatus::PermissionRequired);
    }

    #[test]
    fn request_uses_kotlin_camel_case_field_names() {
        let request = InstallVerifiedRequest {
            path: "/private/cache/updates/hanni.apk".into(),
            expected_version_code: 3004,
            expected_sha256: "a".repeat(64),
        };
        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["expectedVersionCode"], 3004);
        assert_eq!(json["expectedSha256"], "a".repeat(64));
        assert!(json.get("expected_version_code").is_none());
    }
}
