//! Explicit desktop startup modes; provisioning uses the same native API as Settings.

use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum Options {
    #[default]
    Interactive,
    ConfigureSync(PathBuf),
    SyncCheck,
    UpdateBackground,
    Background,
    Minimized,
}

impl Options {
    pub(crate) fn from_env() -> Result<Self, &'static str> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        return Self::parse(std::env::args_os().skip(1));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        Ok(Self::Interactive)
    }

    fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Self, &'static str> {
        let mut args = args.into_iter();
        let Some(flag) = args.next() else {
            return Ok(Self::Interactive);
        };
        let mode = if flag == "--configure-sync" {
            let path = args.next().ok_or("mvp_launch_invalid_options")?;
            if path.is_empty() || path.to_string_lossy().starts_with("--") {
                return Err("mvp_launch_invalid_options");
            }
            Self::ConfigureSync(PathBuf::from(path))
        } else if flag == "--sync-check" {
            Self::SyncCheck
        } else if flag == "--update-background" {
            Self::UpdateBackground
        } else if flag == "--background" {
            Self::Background
        } else if flag == "--minimized" && cfg!(target_os = "macos") {
            Self::Minimized
        } else {
            return Err("mvp_launch_invalid_options");
        };
        if args.next().is_some() {
            return Err("mvp_launch_invalid_options");
        }
        Ok(mode)
    }

    pub(crate) fn is_one_shot(&self) -> bool {
        matches!(
            self,
            Self::ConfigureSync(_) | Self::SyncCheck | Self::UpdateBackground
        )
    }

    pub(crate) fn is_update_background(&self) -> bool {
        *self == Self::UpdateBackground
    }

    pub(crate) fn apply_context<R: tauri::Runtime>(&self, context: &mut tauri::Context<R>) {
        if self.is_one_shot() {
            // Clearing before build avoids creating a WebView and running frontend startup code.
            context.config_mut().app.windows.clear();
        } else if matches!(self, Self::Background | Self::Minimized) {
            for window in &mut context.config_mut().app.windows {
                window.visible = false;
                window.focus = false;
            }
        }
    }

    pub(crate) fn before_run<R: tauri::Runtime>(&self, app: &mut tauri::App<R>) {
        #[cfg(target_os = "macos")]
        if *self != Self::Interactive {
            // Set this on the built runtime before its first event-loop iteration, not in setup.
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = app;
    }

    pub(crate) fn after_setup(&self, app: &tauri::AppHandle) {
        #[cfg(target_os = "macos")]
        if *self == Self::Minimized {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if minimize_hidden_windows(&app).await.is_err() {
                    let _ = write_output(&json!({"ok":false,"error":"mvp_launch_minimize_failed"}));
                    app.exit(1);
                }
            });
            return;
        }
        if !self.is_one_shot() {
            return;
        }
        if self.is_update_background() {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let result = tokio::time::timeout(
                    Duration::from_secs(15 * 60),
                    crate::update_background::run(app.clone()),
                )
                .await
                .unwrap_or(Err("Проверка обновления превысила время ожидания.".into()));
                #[cfg(target_os = "macos")]
                if result.is_err() {
                    let _ = crate::update_macos::record_result(&app, "error", None);
                }
                let code = result.unwrap_or(1);
                app.exit(code);
            });
            return;
        }
        let options = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let result = tokio::time::timeout(Duration::from_secs(60), options.check(&app))
                .await
                .unwrap_or(Err("mvp_sync_check_timed_out"));
            let (output, code) = match result {
                Ok(status) => (safe_status(&status), 0),
                Err(error) => (json!({"ok": false, "error": error}), 1),
            };
            let written = write_output(&output).is_ok();
            app.exit(if written { code } else { 1 });
        });
    }

    pub(crate) fn on_event(&self, app: &tauri::AppHandle, event: &tauri::RunEvent) {
        #[cfg(target_os = "macos")]
        if matches!(event, tauri::RunEvent::Exit) {
            use tauri::Manager;
            // Tauri starts the replacement before process exit and retains managed
            // state. Release the file lock only at the final, non-cancellable exit.
            if let Some(lock) = app.try_state::<crate::AppInstanceLock>() {
                let _ = lock.0.unlock();
            }
        }
        #[cfg(target_os = "macos")]
        if *self == Self::Minimized && matches!(event, tauri::RunEvent::Reopen { .. }) {
            use tauri::Manager;
            // Reopen is the user's Dock/Finder action, never a startup or sync callback.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    }

    async fn check(&self, app: &tauri::AppHandle) -> Result<Value, &'static str> {
        if let Self::ConfigureSync(path) = self {
            let path = path.clone();
            let raw = tauri::async_runtime::spawn_blocking(move || read_config(&path))
                .await
                .map_err(|_| "mvp_sync_config_file_unavailable")??;
            crate::mvp_sync::mvp_sync_configure(app.clone(), raw)
                .await
                .map_err(|_| "mvp_sync_configuration_failed")?;
        }
        if *self == Self::UpdateBackground {
            return Err("mvp_update_background_not_initialized");
        }
        // A round already using the old configuration must not acknowledge the new one.
        let initial = loop {
            let status = crate::mvp_sync::mvp_sync_status(app.clone())
                .await
                .map_err(|_| "mvp_sync_check_failed")?;
            require_sync_enabled(&status)?;
            if status["running"] == false {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        };
        let mut status = crate::mvp_sync::mvp_sync_now(app.clone())
            .await
            .map_err(|_| "mvp_sync_check_failed")?;
        loop {
            require_sync_enabled(&status)?;
            if fresh_and_drained(&status, &initial) {
                return Ok(status);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
            status = crate::mvp_sync::mvp_sync_status(app.clone())
                .await
                .map_err(|_| "mvp_sync_check_failed")?;
        }
    }
}

#[cfg(target_os = "macos")]
async fn minimize_hidden_windows(app: &tauri::AppHandle) -> Result<(), ()> {
    use tauri::Manager;
    let windows = app.webview_windows();
    if windows.is_empty() {
        return Err(());
    }
    for window in windows.values() {
        if window.is_visible().map_err(|_| ())? {
            return Err(());
        }
        window.minimize().map_err(|_| ())?;
    }
    for _ in 0..100 {
        if windows.values().all(|window| {
            window.is_minimized().ok() == Some(true)
                && window.is_visible().ok() == Some(false)
                && window.is_focused().ok() == Some(false)
        }) {
            // Only expose the Dock entry after the hidden window is confirmed minimized.
            return app
                .set_activation_policy(tauri::ActivationPolicy::Regular)
                .map_err(|_| ());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(())
}

fn read_config(path: &Path) -> Result<String, &'static str> {
    let file = File::open(path).map_err(|_| "mvp_sync_config_file_unavailable")?;
    let metadata = file
        .metadata()
        .map_err(|_| "mvp_sync_config_file_unavailable")?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err("mvp_sync_config_file_invalid");
    }
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "mvp_sync_config_file_unavailable")?;
    if bytes.is_empty() || bytes.len() > 4096 {
        return Err("mvp_sync_config_file_invalid");
    }
    String::from_utf8(bytes).map_err(|_| "mvp_sync_config_file_invalid")
}

fn fresh_and_drained(status: &Value, initial: &Value) -> bool {
    status["last_success"].as_str().is_some()
        && status["last_success"] != initial["last_success"]
        && status["pending"] == 0
        && status["pull_more"] == false
        && status["running"] == false
        && status["last_error"].is_null()
}

fn require_sync_enabled(status: &Value) -> Result<(), &'static str> {
    match status["last_error"].as_str() {
        Some(
            error @ ("mvp_sync_credentials_unavailable"
            | "mvp_sync_credentials_invalid"
            | "mvp_sync_credentials_path_invalid"
            | "mvp_sync_platform_unsupported"),
        ) => return Err(error),
        _ => {}
    }
    if status["configured"] != true || status["enabled"] != true {
        return Err("mvp_sync_not_enabled");
    }
    Ok(())
}

fn safe_status(status: &Value) -> Value {
    let last_success = status["last_success"]
        .as_str()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.to_rfc3339());
    json!({
        "ok": true,
        "configured": status["configured"].as_bool().unwrap_or(false),
        "enabled": status["enabled"].as_bool().unwrap_or(false),
        "pending": status["pending"].as_u64(),
        "pull_more": status["pull_more"].as_bool(),
        "conflicts": status["conflicts"].as_u64(),
        "last_success": last_success,
        "last_error": if status["last_error"].is_null() { Value::Null } else { json!("mvp_sync_failed") },
        "running": status["running"].as_bool().unwrap_or(false),
    })
}

fn write_output(value: &Value) -> std::io::Result<()> {
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, value)?;
    output.write_all(b"\n")?;
    output.flush()
}

pub(crate) fn fail_and_exit() -> ! {
    let _ = write_output(&json!({"ok": false, "error": "mvp_launch_failed"}));
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Options, &'static str> {
        Options::parse(args.iter().map(OsString::from))
    }

    #[test]
    fn exclusive_modes_and_config_path_are_parsed() {
        assert_eq!(parse(&[]), Ok(Options::Interactive));
        assert_eq!(parse(&["--sync-check"]), Ok(Options::SyncCheck));
        assert_eq!(
            parse(&["--update-background"]),
            Ok(Options::UpdateBackground)
        );
        assert_eq!(parse(&["--background"]), Ok(Options::Background));
        #[cfg(target_os = "macos")]
        assert_eq!(parse(&["--minimized"]), Ok(Options::Minimized));
        assert_eq!(
            parse(&["--configure-sync", "pairing with spaces.json"]),
            Ok(Options::ConfigureSync(PathBuf::from(
                "pairing with spaces.json"
            )))
        );
        for args in [
            vec!["--configure-sync"],
            vec!["--configure-sync", "--sync-check"],
            vec!["--sync-check", "--background"],
            vec!["--background", "--background"],
            vec!["--configure-sync", "pairing.json", "--sync-check"],
            vec!["--minimized", "--sync-check"],
        ] {
            assert_eq!(parse(&args), Err("mvp_launch_invalid_options"));
        }
    }

    #[test]
    fn one_shot_removes_every_window_before_build() {
        for mode in [
            Options::SyncCheck,
            Options::ConfigureSync("pairing.json".into()),
            Options::UpdateBackground,
        ] {
            let mut context = tauri::test::mock_context::<tauri::test::MockRuntime, _>(
                tauri::test::noop_assets(),
            );
            context.config_mut().app.windows = vec![Default::default(), Default::default()];
            mode.apply_context(&mut context);
            assert!(context.config().app.windows.is_empty());
        }
    }

    #[test]
    fn background_is_hidden_unfocused_and_preserves_window_geometry() {
        let mut context =
            tauri::test::mock_context::<tauri::test::MockRuntime, _>(tauri::test::noop_assets());
        context.config_mut().app.windows = vec![Default::default()];
        let before = context.config().app.windows[0].clone();
        Options::Interactive.apply_context(&mut context);
        assert_eq!(
            serde_json::to_value(&context.config().app.windows[0]).unwrap(),
            serde_json::to_value(&before).unwrap()
        );
        for mode in [Options::Background, Options::Minimized] {
            context.config_mut().app.windows = vec![before.clone()];
            mode.apply_context(&mut context);
            let actual = &context.config().app.windows[0];
            assert!(!actual.visible && !actual.focus);
            let mut expected = before.clone();
            expected.visible = false;
            expected.focus = false;
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
        }
    }

    #[test]
    fn stale_success_pending_work_or_error_cannot_pass_a_check() {
        let initial = json!({"last_success": "2026-09-14T00:00:00Z"});
        let ready = json!({"last_success":"2026-09-14T00:00:01Z","pending":0,"pull_more":false,"running":false,"last_error":null});
        assert!(fresh_and_drained(&ready, &initial));
        for (key, value) in [
            ("last_success", initial["last_success"].clone()),
            ("pending", json!(1)),
            ("pull_more", json!(true)),
            ("running", json!(true)),
            ("last_error", json!("failed")),
        ] {
            let mut blocked = ready.clone();
            blocked[key] = value;
            assert!(!fresh_and_drained(&blocked, &initial));
        }
        let mut missing_page_state = ready;
        missing_page_state
            .as_object_mut()
            .unwrap()
            .remove("pull_more");
        assert!(!fresh_and_drained(&missing_page_state, &initial));
    }

    #[test]
    fn sync_check_preserves_known_credential_errors_without_echoing_unknown_values() {
        let credential_error = json!({
            "configured": false,
            "enabled": true,
            "last_error": "mvp_sync_credentials_unavailable"
        });
        assert_eq!(
            require_sync_enabled(&credential_error),
            Err("mvp_sync_credentials_unavailable")
        );

        let disabled = json!({"configured": true, "enabled": false, "last_error": null});
        assert_eq!(require_sync_enabled(&disabled), Err("mvp_sync_not_enabled"));

        let unconfigured = json!({"configured": false, "enabled": false, "last_error": null});
        assert_eq!(
            require_sync_enabled(&unconfigured),
            Err("mvp_sync_not_enabled")
        );

        let unknown = json!({
            "configured": false,
            "enabled": true,
            "last_error": "private-transport-value"
        });
        assert_eq!(require_sync_enabled(&unknown), Err("mvp_sync_not_enabled"));

        let ready = json!({"configured": true, "enabled": true, "last_error": null});
        assert_eq!(require_sync_enabled(&ready), Ok(()));
    }

    #[test]
    fn output_whitelist_does_not_echo_unknown_values() {
        let value = safe_status(
            &json!({"configured":true,"enabled":true,"pending":0,"conflicts":2,
            "last_success":"private-value","last_error":"private-value","token":"private-value",
            "key":"private-value","endpoint":"private-value","revision":"private-value"}),
        );
        assert!(!value.to_string().contains("private-value"));
        assert_eq!(value["conflicts"], 2);
        assert!(value["last_success"].is_null());
    }

    #[test]
    fn configuration_reads_are_bounded_and_errors_do_not_echo_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic-private-name.json");
        assert_eq!(
            read_config(&path).unwrap_err(),
            "mvp_sync_config_file_unavailable"
        );
        std::fs::write(&path, [b'a'; 4096]).unwrap();
        assert_eq!(read_config(&path).unwrap().len(), 4096);
        std::fs::write(&path, [b'a'; 4097]).unwrap();
        assert_eq!(
            read_config(&path).unwrap_err(),
            "mvp_sync_config_file_invalid"
        );
        std::fs::write(&path, [255]).unwrap();
        assert_eq!(
            read_config(&path).unwrap_err(),
            "mvp_sync_config_file_invalid"
        );
        std::fs::write(&path, []).unwrap();
        assert_eq!(
            read_config(&path).unwrap_err(),
            "mvp_sync_config_file_invalid"
        );
    }
}
