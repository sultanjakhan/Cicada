use serde::Serialize;
use std::path::{Component, Path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection { path: String, entries: Vec<Entry>, inspected_at: String }
#[derive(Serialize)]
pub struct Entry { name: &'static str, exists: bool, kind: &'static str }

fn ordinary(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "source_path_unavailable")?;
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 0x400 != 0 { return Err("source_links_not_allowed".into()); } }
    if metadata.file_type().is_symlink() { return Err("source_links_not_allowed".into()); }
    Ok(())
}
fn inspect(path: &Path) -> Result<Inspection, String> {
    let raw = path.to_string_lossy();
    if !path.is_absolute() || raw.len() > 1024 || raw.chars().any(char::is_control) { return Err("invalid_source_path".into()); }
    #[cfg(windows)]
    if raw.starts_with(r"\\") { return Err("source_remote_path_not_allowed".into()); }
    let mut prefix = std::path::PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) { return Err("invalid_source_path".into()); }
        prefix.push(component.as_os_str());
        if matches!(component, Component::Normal(_)) { ordinary(&prefix)?; }
    }
    ordinary(path)?;
    if !path.is_dir() || path.parent().is_none() { return Err("source_directory_required".into()); }
    // Never enumerate arbitrary contents or open a file. Only known structure metadata.
    let mut entries = Vec::new();
    for (name, kind) in [("manifest.json", "file"), ("projects", "directory"), ("tasks", "directory"), ("runs", "directory"), (".git", "directory")] {
        let candidate = path.join(name);
        let exists = match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) => { ordinary(&candidate)?; if (kind == "directory" && !metadata.is_dir()) || (kind == "file" && !metadata.is_file()) { return Err("source_structure_type_mismatch".into()); } true },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => return Err("source_metadata_unavailable".into()),
        };
        entries.push(Entry{name, exists, kind});
    }
    Ok(Inspection{path:raw.into_owned(),entries,inspected_at:chrono::Utc::now().to_rfc3339()})
}
#[tauri::command]
pub fn inspect_data_source(path: String) -> Result<Inspection, String> { inspect(Path::new(&path)) }

#[tauri::command]
pub fn choose_data_source(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        use windows::{core::w, Win32::{System::Com::{CoTaskMemFree,CoInitializeEx,CoUninitialize,COINIT_APARTMENTTHREADED}, UI::Shell::{BROWSEINFOW, BIF_RETURNONLYFSDIRS, BIF_NEWDIALOGSTYLE, BIF_NONEWFOLDERBUTTON, SHBrowseForFolderW, SHGetPathFromIDListW}}};
        let owner = window.hwnd().map_err(|_| "source_chooser_unavailable")?;
        // Owned by the app window; no file contents or credentials are read.
        unsafe {
            CoInitializeEx(None,COINIT_APARTMENTTHREADED).ok().map_err(|_| "source_chooser_unavailable_use_absolute_path")?;
            struct ComGuard; impl Drop for ComGuard { fn drop(&mut self) { unsafe {CoUninitialize();} } } let _com=ComGuard;
            let info = BROWSEINFOW{hwndOwner:owner,lpszTitle:w!("Выберите папку данных. Ничего не будет перенесено."),ulFlags:BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE | BIF_NONEWFOLDERBUTTON,..Default::default()};
            let selected = SHBrowseForFolderW(&info);
            if selected.is_null() { return Ok(None); }
            let mut buffer = [0u16;260]; let valid = SHGetPathFromIDListW(selected,&mut buffer).as_bool();
            CoTaskMemFree(Some(selected.cast()));
            if !valid { return Err("source_chooser_path_unavailable".into()); }
            let end = buffer.iter().position(|v| *v == 0).unwrap_or(buffer.len());
            Ok(Some(String::from_utf16(&buffer[..end]).map_err(|_| "invalid_source_path")?))
        }
    }
    #[cfg(not(windows))]
    { let _ = window; Err("source_chooser_unavailable_use_absolute_path".into()) }
}

pub fn mark_new_profile(conn: &rusqlite::Connection, was_present: bool) -> Result<(), rusqlite::Error> {
    if !was_present { conn.execute("INSERT OR IGNORE INTO ui_state(key,value,updated_at) VALUES ('cicada_sources_onboarding_eligible_v1','true',?1)", [chrono::Utc::now().to_rfc3339()])?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn inspection_is_metadata_only_and_rejects_relative_missing_and_wrong_types() {
        let dir=tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("credentials"), "DO NOT READ").unwrap();
        let view=inspect(dir.path()).unwrap(); assert_eq!(view.entries.len(),5);assert!(view.entries.iter().all(|e|!e.exists));
        assert!(inspect(Path::new("relative")).is_err());assert!(inspect(&dir.path().join("missing")).is_err());
        std::fs::write(dir.path().join("tasks"),"bad").unwrap();assert!(inspect(dir.path()).is_err());
    }
    #[test] fn onboarding_marks_only_genuinely_new_database() {
        let conn=rusqlite::Connection::open_in_memory().unwrap();crate::init_schema(&conn).unwrap();
        mark_new_profile(&conn,true).unwrap();assert_eq!(conn.query_row("SELECT COUNT(*) FROM ui_state WHERE key='cicada_sources_onboarding_eligible_v1'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        mark_new_profile(&conn,false).unwrap();assert_eq!(conn.query_row("SELECT value FROM ui_state WHERE key='cicada_sources_onboarding_eligible_v1'",[],|r|r.get::<_,String>(0)).unwrap(),"true");
    }
}
