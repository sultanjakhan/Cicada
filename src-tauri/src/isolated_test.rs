//! Explicit release QA profile, never an environment-variable fallback.
use std::{
    fs::{File, OpenOptions},
    path::{Component, Path, PathBuf},
};
use tauri::{Manager, State};

pub(crate) struct Profile {
    pub root: Option<PathBuf>,
    _directories: Vec<File>,
}
const MARKER: &str = "cicada-isolated-test.json";

fn regular(path: &Path, directory: bool) -> Result<File, String> {
    let m = std::fs::symlink_metadata(path).map_err(|_| "isolated_path_unavailable")?;
    if m.file_type().is_symlink() || m.is_dir() != directory {
        return Err("isolated_path_type_or_link".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        if m.file_attributes() & 0x400 != 0 {
            return Err("isolated_reparse_point".into());
        }
        let f = OpenOptions::new()
            .read(true)
            .share_mode(3)
            .custom_flags(if directory {
                0x02000000 | 0x00200000
            } else {
                0x00200000
            })
            .open(path)
            .map_err(|_| "isolated_path_lock_failed")?;
        if !directory {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::{
                Foundation::HANDLE,
                Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION},
            };
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            unsafe { GetFileInformationByHandle(HANDLE(f.as_raw_handle()), &mut info) }
                .map_err(|_| "isolated_file_identity_unavailable")?;
            if info.nNumberOfLinks != 1 {
                return Err("isolated_hardlink_not_allowed".into());
            }
        }
        return Ok(f);
    }
    #[cfg(not(windows))]
    File::open(path).map_err(|_| "isolated_path_lock_failed".into())
}

fn check_tree(path: &Path, remaining: &mut usize) -> Result<(), String> {
    for entry in std::fs::read_dir(path).map_err(|_| "isolated_tree_unavailable")? {
        if *remaining == 0 { return Err("isolated_tree_limit".into()); }
        *remaining -= 1;
        let entry = entry.map_err(|_| "isolated_tree_unavailable")?;
        let directory = entry.file_type().map_err(|_| "isolated_tree_unavailable")?.is_dir();
        regular(&entry.path(), directory)?;
        if directory { check_tree(&entry.path(), remaining)?; }
    }
    Ok(())
}

fn prepare(root: &Path, protected: &[PathBuf]) -> Result<Profile, String> {
    if !root.is_absolute()
        || root.parent().is_none()
        || root.to_string_lossy().starts_with(r"\\")
        || root
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("isolated_absolute_local_root_required".into());
    }
    let mut prefix = PathBuf::new();
    let mut locks = Vec::new();
    for c in root.components() {
        prefix.push(c.as_os_str());
        if matches!(c, Component::Normal(_)) {
            locks.push(regular(&prefix, true)?);
        }
    }
    let root = root
        .canonicalize()
        .map_err(|_| "isolated_root_unavailable")?;
    for p in protected {
        let p = p
            .canonicalize()
            .map_err(|_| "isolated_protected_path_unavailable")?;
        if root.starts_with(&p) || p.starts_with(&root) {
            return Err("isolated_production_overlap".into());
        }
    }
    let marker = regular(&root.join(MARKER), false)?;
    if marker
        .metadata()
        .map_err(|_| "isolated_marker_unavailable")?
        .len()
        > 512
    {
        return Err("isolated_marker_invalid".into());
    }
    let value: serde_json::Value =
        serde_json::from_reader(&marker).map_err(|_| "isolated_marker_invalid")?;
    if value
        != serde_json::json!({"schemaVersion":1,"application":"app.hanni.mvp","purpose":"isolated-release-test"})
    {
        return Err("isolated_marker_invalid".into());
    }
    // Existing QA files must be ordinary single-link files; never accept credentials.
    for entry in std::fs::read_dir(&root).map_err(|_| "isolated_root_unavailable")? {
        let entry = entry.map_err(|_| "isolated_root_unavailable")?;
        let name = entry.file_name();
        let name = name.to_str().ok_or("isolated_unknown_entry")?;
        match name {
            MARKER
            | "calendar.db"
            | "calendar.db-wal"
            | "calendar.db-shm"
            | "hanni-mvp.instance.lock" => {
                regular(&entry.path(), false)?;
            }
            "webview2" | "backups" => {
                locks.push(regular(&entry.path(), true)?);
                check_tree(&entry.path(), &mut 10000)?;
            }
            _ => return Err("isolated_unknown_entry".into()),
        }
    }
    // WebView2 and SQLite accept conventional absolute drive paths, not every extended-path form.
    #[cfg(windows)]
    let root = PathBuf::from(
        root.to_string_lossy()
            .strip_prefix(r"\\?\")
            .unwrap_or(&root.to_string_lossy()),
    );
    let webview = root.join("webview2");
    if !webview.exists() {
        std::fs::create_dir(&webview).map_err(|_| "isolated_webview_unavailable")?;
    }
    locks.push(regular(&webview, true)?);
    Ok(Profile {
        root: Some(root),
        _directories: locks,
    })
}

pub(crate) fn initialize(root: Option<&Path>) -> Result<Profile, String> {
    let Some(root) = root else {
        return Ok(Profile {
            root: None,
            _directories: Vec::new(),
        });
    };
    #[cfg(not(windows))]
    {
        let _ = root;
        return Err("isolated_windows_only".into());
    }
    #[cfg(windows)]
    {
        use windows::Win32::{
            System::Com::CoTaskMemFree,
            UI::Shell::{
                FOLDERID_LocalAppData, FOLDERID_RoamingAppData, SHGetKnownFolderPath,
                KF_FLAG_DEFAULT,
            },
        };
        let mut protected = Vec::new();
        for id in [FOLDERID_RoamingAppData, FOLDERID_LocalAppData] {
            let raw = unsafe { SHGetKnownFolderPath(&id, KF_FLAG_DEFAULT, None) }
                .map_err(|_| "isolated_protected_path_unavailable")?;
            let value = unsafe { raw.to_string() };
            unsafe {
                CoTaskMemFree(Some(raw.0.cast()));
            }
            protected.push(PathBuf::from(
                value.map_err(|_| "isolated_protected_path_unavailable")?,
            ));
        }
        if std::env::var_os("HANNI_MVP_DATA_DIR").is_some() {
            return Err("isolated_ambiguous_environment".into());
        }
        let profile = prepare(root, &protected)?;
        if let Some(folder) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
            let candidate = PathBuf::from(folder)
                .canonicalize()
                .map_err(|_| "isolated_webview_override_invalid")?;
            if candidate
                != profile
                    .root
                    .as_ref()
                    .unwrap()
                    .join("webview2")
                    .canonicalize()
                    .map_err(|_| "isolated_webview_unavailable")?
            {
                return Err("isolated_webview_override_invalid".into());
            }
        }
        if std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
            .unwrap_or_default()
            .to_lowercase()
            .contains("user-data")
        {
            return Err("isolated_webview_override_invalid".into());
        }
        Ok(profile)
    }
}

pub(crate) fn allowed(command: &str) -> bool {
    if cfg!(feature = "local-result-review-prototype") && matches!(command,
        "prototype_publish_task_result" | "read_task_result_review" |
        "enqueue_task_result_review" | "commit_task_result_review" |
        "recover_task_result_review") { return true; }
    matches!(
        command,
        "get_compact_window_state" | "set_compact_window" |
        "isolated_test_status"
            | "list_items"
            | "save_item"
            | "set_completed"
            | "delete_item"
            | "create_backup"
            | "save_personal_import_recovery"
            | "read_calendar_day" | "commit_calendar_day_action" | "read_calendar_day_operation"
            | "start_calendar_day"
            | "get_events"
            | "get_all_events"
            | "create_event"
            | "update_event"
            | "delete_event"
            | "get_notes"
            | "get_note"
            | "create_note"
            | "update_note"
            | "update_note_status"
            | "toggle_note_archive"
            | "get_calendar_tasks"
            | "get_calendar_task"
            | "save_calendar_task"
            | "save_calendar_task_manual_edit"
            | "save_calendar_task_manual_stage"
            | "undo_calendar_task_manual_edit"
            | "complete_calendar_task"
            | "set_calendar_task_stage"
            | "shared_task_command"
            | "get_calendar_records"
            | "get_ui_state"
            | "set_ui_state"
            | "get_goals"
            | "save_calendar_goal"
            | "set_calendar_goal_status"
            | "delete_goal"
            | "get_calendar_task_goals"
            | "set_calendar_task_goal"
            | "list_event_categories"
            | "create_event_category"
            | "update_event_category"
            | "delete_event_category"
            | "get_timeline_blocks"
            | "get_calendar_task_blocks"
            | "get_latest_task_block"
            | "get_active_block"
            | "get_active_blocks"
            | "start_task_block"
            | "pause_task_block"
            | "cancel_task_block"
            | "finish_task_block"
            | "skip_recurring_step"
            | "complete_recurring_step"
            | "get_calendar_task_minutes"
            | "get_calendar_task_seconds"
            | "get_schedules"
            | "get_task_pins"
            | "get_app_setting"
            | "set_app_setting"
    )
}
/// Shared outer application dispatcher, also used by headless external IPC tests.
/// No extra permission is granted to ordinary profiles; handler scope still applies.
pub(crate) fn dispatch<R: tauri::Runtime>(
    isolated: bool,
    invoke: tauri::ipc::Invoke<R>,
    handler: impl FnOnce(tauri::ipc::Invoke<R>) -> bool,
) -> bool {
    if isolated && !allowed(invoke.message.command()) {
        invoke.resolver.reject("isolated_test_integration_disabled");
        return true;
    }
    handler(invoke)
}
#[tauri::command]
pub(crate) fn isolated_test_status(profile: State<'_, Profile>) -> serde_json::Value {
    serde_json::json!({"isolated":profile.root.is_some(),"root":profile.root,"integrationsEnabled":profile.root.is_none()})
}
pub(crate) fn root(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.try_state::<Profile>().and_then(|p| p.root.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn marked() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(MARKER),r#"{"schemaVersion":1,"application":"app.hanni.mvp","purpose":"isolated-release-test"}"#).unwrap();
        d
    }
    #[test]
    fn invalid_roots_fail_without_fallback() {
        let d = tempfile::tempdir().unwrap();
        assert!(prepare(d.path(), &[]).is_err());
        assert!(prepare(Path::new("relative"), &[]).is_err());
        assert!(!d.path().join("calendar.db").exists());
        let d = marked();
        assert!(prepare(d.path(), &[d.path().to_owned()]).is_err());
    }
    #[test]
    fn credentials_and_unknown_files_are_rejected() {
        let d = marked();
        std::fs::write(d.path().join("mvp-sync.credentials"), "synthetic-opaque").unwrap();
        assert!(prepare(d.path(), &[]).is_err());
        assert!(!d.path().join("calendar.db").exists());
    }
    #[test]
    fn legitimate_profile_is_separate_and_denies_side_effects() {
        let d = marked();
        let p = prepare(d.path(), &[]).unwrap();
        assert_eq!(
            p.root.as_ref().unwrap().canonicalize().unwrap(),
            d.path().canonicalize().unwrap()
        );
        for c in [
            "mvp_sync_now",
            "mvp_update_install",
            "open_url",
            "choose_data_source",
            "inspect_data_source",
            "health_sleep_connect",
            "future_command",
        ] {
            assert!(!allowed(c));
        }
        assert!(allowed("save_calendar_task"));
    }
    #[cfg(windows)]
    #[test]
    fn hardlinks_are_rejected() {
        let d = marked();
        std::fs::write(d.path().join("source"), "synthetic").unwrap();
        std::fs::hard_link(d.path().join("source"), d.path().join("calendar.db")).unwrap();
        assert!(regular(&d.path().join("calendar.db"), false).is_err());
    }
}
