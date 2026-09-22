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
    /// Requests Android 12+ PackageInstaller session delivery. Older Android
    /// versions deliberately retain the existing explicit system installer.
    #[serde(default)]
    pub automatic: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstallStatus {
    Launched,
    PermissionRequired,
    Installing,
    PendingUserAction,
    Success,
    Failure,
    Idle,
    Unsupported,
}

/// Kotlin resolves mobile commands as `{ "status": "..." }`; keeping that
/// envelope explicit prevents Rust from accidentally trying to deserialize the
/// whole object as the `InstallStatus` string itself.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatusResponse {
    pub status: InstallStatus,
    #[serde(default)]
    pub session_id: Option<i32>,
    #[serde(default)]
    pub status_code: Option<i32>,
    #[serde(default)]
    pub status_message: Option<String>,
    #[serde(default)]
    pub updated_at_ms: Option<i64>,
    #[serde(default)]
    pub version_code: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct AutoInstallScheduleResponse {
    pub scheduled: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Access to the bounded Android package-installer bridge.
pub struct AndroidInstaller<R: Runtime>(Option<PluginHandle<R>>);

impl<R: Runtime> AndroidInstaller<R> {
    pub fn sleep_command(&self, command: &str) -> Result<serde_json::Value, String> {
        #[cfg(not(target_os = "android"))]
        { let _ = command; Ok(serde_json::json!({"status":"unsupported"})) }
        #[cfg(target_os = "android")]
        {
            let Some(handle) = &self.0 else { return Ok(serde_json::json!({"status":"unsupported"})); };
            handle.run_mobile_plugin(command, ()).map_err(|_| "health_sleep_bridge_failed".into())
        }
    }

    pub fn activity_command(&self, command: &str) -> Result<serde_json::Value, String> {
        #[cfg(not(target_os = "android"))]
        { let _ = command; Ok(serde_json::json!({"status":"unsupported"})) }
        #[cfg(target_os = "android")]
        {
            let Some(handle) = &self.0 else { return Ok(serde_json::json!({"status":"unsupported"})); };
            handle.run_mobile_plugin(command, ()).map_err(|_| "health_activity_bridge_failed".into())
        }
    }

    /// Opens Android's system confirmation UI only after the native Android
    /// bridge has checked cache location, hash, package id, version and signer.
    /// `Launched` means Android received the request; it never means installed.
    pub fn install_verified(
        &self,
        request: InstallVerifiedRequest,
    ) -> Result<InstallStatus, String> {
        #[cfg(not(target_os = "android"))]
        { let _ = request; Ok(InstallStatus::Unsupported) }
        #[cfg(target_os = "android")]
        {
        let Some(handle) = &self.0 else {
            return Ok(InstallStatus::Unsupported);
        };
        let response: InstallStatusResponse = handle
            .run_mobile_plugin("installVerified", request)
            .map_err(|error| error.to_string())?;
        Ok(response.status)
        }
    }

    /// Returns `permission_required` until the user grants Android's install
    /// unknown apps permission. It only opens the settings page when this method
    /// is called explicitly by the product UI.
    pub fn open_install_permission(&self) -> Result<InstallStatus, String> {
        #[cfg(not(target_os = "android"))]
        { Ok(InstallStatus::Unsupported) }
        #[cfg(target_os = "android")]
        {
        let Some(handle) = &self.0 else {
            return Ok(InstallStatus::Unsupported);
        };
        let response: InstallStatusResponse = handle
            .run_mobile_plugin("openInstallPermission", ())
            .map_err(|error| error.to_string())?;
        Ok(response.status)
        }
    }

    /// Reads the last system PackageInstaller callback stored in Android's
    /// private preferences. `Installing` only means the session was committed;
    /// `Success` is the terminal confirmation from Android.
    pub fn get_install_status(&self) -> Result<InstallStatusResponse, String> {
        #[cfg(not(target_os = "android"))]
        {
            Ok(InstallStatusResponse {
                status: InstallStatus::Unsupported,
                session_id: None,
                status_code: None,
                status_message: None,
                updated_at_ms: None,
                version_code: None,
            })
        }
        #[cfg(target_os = "android")]
        {
            let Some(handle) = &self.0 else {
                return Ok(InstallStatusResponse {
                    status: InstallStatus::Unsupported,
                    session_id: None,
                    status_code: None,
                    status_message: None,
                    updated_at_ms: None,
                    version_code: None,
                });
            };
            handle
                .run_mobile_plugin("getInstallStatus", ())
                .map_err(|error| error.to_string())
        }
    }

    /// Opens the system confirmation only after Android returned and persisted
    /// `PendingUserAction`; never called by automatic installation itself.
    pub fn open_pending_user_action(&self) -> Result<InstallStatus, String> {
        #[cfg(not(target_os = "android"))]
        { Ok(InstallStatus::Unsupported) }
        #[cfg(target_os = "android")]
        {
            let Some(handle) = &self.0 else {
                return Ok(InstallStatus::Unsupported);
            };
            let response: InstallStatusResponse = handle
                .run_mobile_plugin("openPendingUserAction", ())
                .map_err(|error| error.to_string())?;
            Ok(response.status)
        }
    }

    /// Enrolls the Android-only, connectivity-constrained six-hour worker.
    /// It returns `scheduled = false` when the release build has no configured
    /// authenticated update channel.
    pub fn schedule_auto_install(&self) -> Result<AutoInstallScheduleResponse, String> {
        #[cfg(not(target_os = "android"))]
        {
            Ok(AutoInstallScheduleResponse { scheduled: false, reason: Some("unsupported".into()) })
        }
        #[cfg(target_os = "android")]
        {
            let Some(handle) = &self.0 else {
                return Ok(AutoInstallScheduleResponse { scheduled: false, reason: Some("unsupported".into()) });
            };
            handle.run_mobile_plugin("scheduleAutoInstall", ()).map_err(|error| error.to_string())
        }
    }

    /// Enables or cancels the independent closed-app content-sync worker.
    pub fn schedule_content_sync(&self, enabled: bool) -> Result<bool, String> {
        #[cfg(not(target_os = "android"))]
        {
            let _ = enabled;
            Ok(false)
        }
        #[cfg(target_os = "android")]
        {
            let Some(handle) = &self.0 else {
                return Ok(false);
            };
            #[derive(Deserialize)]
            struct Response {
                scheduled: bool,
            }
            #[derive(Serialize)]
            struct Request {
                enabled: bool,
            }
            let response: Response = handle
                .run_mobile_plugin("scheduleContentSync", Request { enabled })
                .map_err(|error| error.to_string())?;
            Ok(response.scheduled)
        }
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
    use super::{InstallStatus, InstallStatusResponse, InstallVerifiedRequest};

    #[test]
    fn response_envelope_maps_kotlin_permission_status() {
        let response: InstallStatusResponse =
            serde_json::from_str(r#"{"status":"permission_required"}"#).unwrap();
        assert_eq!(response.status, InstallStatus::PermissionRequired);
    }

    #[test]
    fn response_envelope_preserves_pending_user_action_details() {
        let response: InstallStatusResponse = serde_json::from_str(
            r#"{"status":"pending_user_action","sessionId":41,"statusCode":-1,"updatedAtMs":42}"#,
        )
        .unwrap();
        assert_eq!(response.status, InstallStatus::PendingUserAction);
        assert_eq!(response.session_id, Some(41));
        assert_eq!(response.status_code, Some(-1));
        assert_eq!(response.updated_at_ms, Some(42));
    }

    #[test]
    fn request_uses_kotlin_camel_case_field_names() {
        let request = InstallVerifiedRequest {
            path: "/private/cache/updates/hanni.apk".into(),
            expected_version_code: 3004,
            expected_sha256: "a".repeat(64),
            automatic: true,
        };
        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["expectedVersionCode"], 3004);
        assert_eq!(json["expectedSha256"], "a".repeat(64));
        assert_eq!(json["automatic"], true);
        assert!(json.get("expected_version_code").is_none());
    }
}
