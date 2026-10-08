use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const POINTER_FILE: &str = "Cicada.data-location.json";
const PENDING_FILE: &str = "Cicada.data-location.pending.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DataLocation {
    pub path: String,
    pub is_default: bool,
    pub restart_required: bool,
    pub migration_error: Option<String>,
    pub can_move: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pointer {
    path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pending {
    source: String,
    target: String,
}

pub fn pointer_path(standard: &Path) -> PathBuf {
    standard.parent().unwrap_or(standard).join(POINTER_FILE)
}
/// The native agent endpoint is keyed by this stable directory, never by the
/// selected profile path. This keeps configured clients connected after a move.
pub fn stable_endpoint_dir(standard: &Path) -> Result<PathBuf, String> {
    canonical_or_absolute(standard)
}

pub fn endpoint_source<'a>(
    standard: &'a Path,
    data: &'a Path,
    isolated: bool,
    development_override: bool,
) -> &'a Path {
    if isolated || development_override {
        data
    } else {
        standard
    }
}
fn pending_path(standard: &Path) -> PathBuf {
    standard.parent().unwrap_or(standard).join(PENDING_FILE)
}
fn failure_path(standard: &Path) -> PathBuf {
    standard
        .parent()
        .unwrap_or(standard)
        .join("Cicada.data-location.failure.json")
}
pub fn record_failure(standard: &Path) -> Result<(), String> {
    let pending = pending_path(standard);
    if pending.exists() {
        let saved = pending.with_file_name(format!(
            "Cicada.data-location.pending.failed-{}.json",
            Uuid::new_v4()
        ));
        fs::rename(&pending, saved).map_err(|_| "Не удалось сохранить отказ переноса.")?;
    }
    atomic_write(&failure_path(standard), b"{\"state\":\"error\"}")
}

fn canonical_or_absolute(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Укажи локальный абсолютный путь.".into());
    }
    if path.exists() {
        fs::canonicalize(path).map_err(|_| "Не удалось определить путь.".into())
    } else {
        let parent = path
            .parent()
            .ok_or_else(|| "Не удалось определить путь.".to_string())?;
        let canonical_parent = canonical_or_absolute(parent)?;
        Ok(canonical_parent.join(
            path.file_name()
                .ok_or_else(|| "Не удалось определить путь.".to_string())?,
        ))
    }
}

fn is_unc(path: &Path) -> bool {
    let s = path.to_string_lossy();
    s.starts_with("\\\\?\\UNC\\")
        || s.starts_with("//?/UNC/")
        || (s.starts_with("\\\\") && !s.starts_with("\\\\?\\"))
        || (s.starts_with("//") && !s.starts_with("//?/"))
}

fn validate_raw_local(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Укажи локальный абсолютный путь.".into());
    }
    if is_unc(path) {
        return Err("Сетевые (UNC) пути не поддерживаются.".into());
    }
    let mut current = path;
    loop {
        if let Ok(metadata) = fs::symlink_metadata(current) {
            if is_reparse(&metadata) {
                return Err("Путь содержит символическую ссылку или reparse-point.".into());
            }
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent,
            _ => break,
        }
    }
    Ok(())
}

fn ordinary_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.is_dir() && !is_reparse(&m))
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn overlaps(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        let a = a.to_string_lossy().to_ascii_lowercase();
        let b = b.to_string_lossy().to_ascii_lowercase();
        a == b || a.starts_with(&(b.clone() + "\\")) || b.starts_with(&(a.clone() + "\\"))
    }
    #[cfg(not(windows))]
    {
        a == b || a.starts_with(b) || b.starts_with(a)
    }
}

fn overlaps_legacy(standard: &Path, target: &Path, home: Option<PathBuf>) -> Result<bool, String> {
    let mut roots = vec![standard.parent().unwrap_or(standard).join("Hanni")];
    if let Some(home) = home {
        roots.push(home.join("Documents/Hanni"));
    }
    for root in roots {
        if overlaps(target, &canonical_or_absolute(&root)?) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn validate_target(standard: &Path, source: &Path, target: &Path) -> Result<PathBuf, String> {
    validate_raw_local(target)?;
    validate_raw_local(source)?;
    let target = canonical_or_absolute(target)?;
    let source = canonical_or_absolute(source)?;
    let legacy_home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let legacy_overlap = overlaps_legacy(standard, &target, legacy_home)?;
    let standard = canonical_or_absolute(standard)?;
    if overlaps(&target, &source) || overlaps(&target, &standard) || legacy_overlap {
        return Err("Папка пересекается с системной или legacy Hanni директорией.".into());
    }
    if target.exists() {
        if !ordinary_dir(&target) {
            return Err("Папка должна быть обычной локальной директорией.".into());
        }
        if fs::read_dir(&target)
            .map_err(|_| "Не удалось прочитать выбранную папку.")?
            .next()
            .is_some()
        {
            return Err("Выбранная папка не пуста.".into());
        }
    }
    Ok(target)
}

pub fn resolve(standard: &Path) -> Result<PathBuf, String> {
    let pointer = pointer_path(standard);
    if !pointer.exists() {
        return canonical_or_absolute(standard);
    }
    let bytes = fs::read(&pointer).map_err(|_| "Не удалось прочитать расположение данных.")?;
    if bytes.len() > 16 * 1024 {
        return Err("Файл расположения данных слишком большой.".into());
    }
    let value: Pointer =
        serde_json::from_slice(&bytes).map_err(|_| "Файл расположения данных повреждён.")?;
    validate_raw_local(Path::new(&value.path))?;
    let target = canonical_or_absolute(Path::new(&value.path))?;
    if !ordinary_dir(&target) {
        return Err("Расположение данных недоступно или является ссылкой.".into());
    }
    if !target.join("calendar.db").is_file() {
        return Err("В расположении данных отсутствует база Cicada.".into());
    }
    Ok(target)
}

pub fn current(standard: &Path) -> Result<DataLocation, String> {
    let path = resolve(standard)?;
    Ok(DataLocation {
        is_default: path == canonical_or_absolute(standard)?,
        path: path.to_string_lossy().into_owned(),
        restart_required: pending_path(standard).exists(),
        can_move: !cfg!(target_os = "android"),
        migration_error: if failure_path(standard).exists() {
            Some(
                "Перенос не завершён. Исходная папка остаётся активной; выбери новую пустую папку."
                    .into(),
            )
        } else {
            None
        },
    })
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = tempfile::Builder::new()
        .prefix(&format!(
            ".{}.tmp-",
            path.file_name().unwrap_or_default().to_string_lossy()
        ))
        .tempfile_in(path.parent().unwrap_or(Path::new(".")))
        .map_err(|_| "Не удалось подготовить расположение данных.")?;
    use std::io::Write;
    file.write_all(bytes)
        .map_err(|_| "Не удалось сохранить расположение данных.")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Не удалось сохранить расположение данных.")?;
    let tmp = file.into_temp_path();
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING};
        let from: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING,
            )
        }
        .map_err(|_| "Не удалось атомарно заменить расположение данных.")?;
    }
    #[cfg(not(windows))]
    fs::rename(&tmp, path).map_err(|_| "Не удалось атомарно заменить расположение данных.")?;
    Ok(())
}

pub fn prepare(standard: &Path, target: &Path) -> Result<DataLocation, String> {
    let source = resolve(standard)?;
    let target = validate_target(standard, &source, target)?;
    let pending = serde_json::to_vec(&Pending {
        source: source.to_string_lossy().into_owned(),
        target: target.to_string_lossy().into_owned(),
    })
    .map_err(|_| "Не удалось подготовить перемещение.")?;
    atomic_write(&pending_path(standard), &pending)?;
    if failure_path(standard).exists() {
        fs::remove_file(failure_path(standard))
            .map_err(|_| "Не удалось обновить статус переноса.")?;
    }
    Ok(DataLocation {
        path: target.to_string_lossy().into_owned(),
        is_default: false,
        restart_required: true,
        migration_error: None,
        can_move: !cfg!(target_os = "android"),
    })
}

fn hash(path: &Path) -> Result<Vec<u8>, String> {
    Ok(Sha256::digest(fs::read(path).map_err(|_| "Не удалось проверить копию данных.")?).to_vec())
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    copy_tree_inner(source, target, true)
}
fn copy_tree_inner(source: &Path, target: &Path, active_root: bool) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|_| "Не удалось создать папку данных.")?;
    for entry in fs::read_dir(source).map_err(|_| "Не удалось прочитать исходные данные.")?
    {
        let entry = entry.map_err(|_| "Не удалось прочитать исходные данные.")?;
        let name = entry.file_name();
        if active_root
            && (name == "hanni-mvp.instance.lock"
                || name == "calendar.db"
                || name == "calendar.db-wal"
                || name == "calendar.db-shm"
                || name == "mvp-sync.credentials")
        {
            continue;
        }
        let from = entry.path();
        let to = target.join(&name);
        let kind = entry
            .file_type()
            .map_err(|_| "Не удалось проверить файл данных.")?;
        let metadata = entry
            .metadata()
            .map_err(|_| "Не удалось проверить файл данных.")?;
        if kind.is_symlink() || is_reparse(&metadata) {
            return Err("Исходные данные содержат ссылку или reparse-point.".into());
        }
        if kind.is_dir() {
            copy_tree_inner(&from, &to, false)?;
        } else if kind.is_file() {
            fs::copy(&from, &to).map_err(|_| "Не удалось скопировать данные.")?;
            if hash(&from)? != hash(&to)? {
                return Err("Проверка копии данных не прошла.".into());
            }
        } else {
            return Err("Исходные данные содержат неподдерживаемый тип файла.".into());
        }
    }
    Ok(())
}

pub fn apply_pending(standard: &Path, source: &Path) -> Result<(), String> {
    let path = pending_path(standard);
    if !path.exists() {
        return Ok(());
    }
    let pending: Pending = serde_json::from_slice(
        &fs::read(&path).map_err(|_| "Не удалось прочитать отложенное перемещение.")?,
    )
    .map_err(|_| "Отложенное перемещение повреждено.")?;
    let expected = canonical_or_absolute(Path::new(&pending.source))?;
    let actual = canonical_or_absolute(source)?;
    if expected != actual {
        // A published pointer is the commit point. A leftover marker after a
        // crash must not turn an already activated profile into a failed move.
        validate_raw_local(Path::new(&pending.target))?;
        let activated = canonical_or_absolute(Path::new(&pending.target))?;
        if actual == activated && resolve(standard)? == activated {
            let _ = fs::remove_file(&path);
            return Ok(());
        }
        return Err("Отложенное перемещение относится к другому профилю.".into());
    }
    let target = validate_target(standard, source, Path::new(&pending.target))?;
    // The guard owns only this new staging directory, never source or target.
    let staging = tempfile::Builder::new()
        .prefix(".cicada-migration-")
        .tempdir_in(target.parent().unwrap_or(Path::new(".")))
        .map_err(|_| "Не удалось создать уникальную staging-папку.")?;
    let temp = staging.path();
    copy_tree(source, temp)?;
    let source_db = source.join("calendar.db");
    let target_db = temp.join("calendar.db");
    let src = rusqlite::Connection::open_with_flags(
        &source_db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "Не удалось открыть исходную базу.")?;
    let mut dst =
        rusqlite::Connection::open(&target_db).map_err(|_| "Не удалось создать копию базы.")?;
    let backup = rusqlite::backup::Backup::new(&src, &mut dst)
        .map_err(|_| "Не удалось скопировать базу.")?;
    backup
        .run_to_completion(128, std::time::Duration::from_millis(5), None)
        .map_err(|_| "Не удалось завершить копирование базы.")?;
    drop(backup);
    drop(dst);
    drop(src);
    let verify =
        rusqlite::Connection::open(&target_db).map_err(|_| "Не удалось проверить копию базы.")?;
    let integrity: String = verify
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|_| "Не удалось проверить копию базы.")?;
    if integrity != "ok" {
        return Err("Проверка копии базы не прошла.".into());
    }
    drop(verify);
    if target.exists() {
        if !ordinary_dir(&target)
            || fs::read_dir(&target)
                .map_err(|_| "Целевая папка недоступна.")?
                .next()
                .is_some()
        {
            return Err("Целевая папка занята или внезапно стала недоступна.".into());
        }
        fs::remove_dir(&target).map_err(|_| "Не удалось подготовить пустую целевую папку.")?;
    }
    fs::rename(temp, &target).map_err(|_| "Не удалось включить новое расположение данных.")?;
    crate::mvp_sync::relocate_credentials(&source_db, &target.join("calendar.db")).map_err(
        |_| "Не удалось перенести защищённый профиль синхронизации. Исходная папка сохранена.",
    )?;
    let pointer_result = atomic_write(
        &pointer_path(standard),
        serde_json::to_string(&Pointer {
            path: target.to_string_lossy().into_owned(),
        })
        .unwrap()
        .as_bytes(),
    );
    if let Err(error) = pointer_result {
        return Err(error);
    }
    let _ = fs::remove_file(path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    #[test]
    fn migration_target_cannot_enter_either_legacy_data_root() {
        let root = tempdir().unwrap();
        let home = root.path().canonicalize().unwrap();
        let standard = home.join("ApplicationSupport/app.hanni.mvp");
        assert!(overlaps_legacy(
            &standard,
            &home.join("Documents/Hanni/new"),
            Some(home.clone())
        )
        .unwrap());
        assert!(overlaps_legacy(
            &standard,
            &home.join("ApplicationSupport/Hanni/new"),
            Some(home.clone())
        )
        .unwrap());
        assert!(!overlaps_legacy(&standard, &home.join("cicada-new"), Some(home)).unwrap());
    }
    #[cfg(unix)]
    #[test]
    fn standard_alias_keeps_pointer_and_endpoint_while_user_targets_reject_links() {
        use std::os::unix::fs::symlink;
        let root = tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let physical = root.join("project/data/live");
        fs::create_dir_all(&physical).unwrap();
        drop(rusqlite::Connection::open(physical.join("calendar.db")).unwrap());
        let standard = root.join("application-support/profile");
        fs::create_dir_all(standard.parent().unwrap()).unwrap();
        symlink(&physical, &standard).unwrap();
        assert_eq!(resolve(&standard).unwrap(), physical);
        assert!(current(&standard).unwrap().is_default);
        let target = root.join("moved");
        prepare(&standard, &target).unwrap();
        assert!(pending_path(&standard).starts_with(standard.parent().unwrap()));
        apply_pending(&standard, &resolve(&standard).unwrap()).unwrap();
        assert_eq!(resolve(&standard).unwrap(), target);
        assert_eq!(stable_endpoint_dir(&standard).unwrap(), physical);
        assert!(physical.join("calendar.db").exists());
        let alias = root.join("target-alias");
        symlink(&target, &alias).unwrap();
        assert!(validate_target(&standard, &target, &alias).is_err());
    }

    #[test]
    fn relocation_preserves_durable_history_past_the_compatibility_window() {
        let root = tempdir().unwrap();
        let standard = root.path().canonicalize().unwrap().join("profile");
        fs::create_dir(&standard).unwrap();
        let connection = rusqlite::Connection::open(standard.join("calendar.db")).unwrap();
        crate::init_schema(&connection).unwrap();
        crate::agent_history::ensure(&connection).unwrap();
        let namespace = crate::agent_history::load(&connection).unwrap()["sourceNamespace"].clone();
        for n in 0..503 {
            crate::agent_history::insert_receipt(
                &connection,
                &format!("synthetic-operation-{n:04}"),
                &"a".repeat(64),
                &serde_json::json!({"synthetic":n}),
            )
            .unwrap();
        }
        drop(connection);
        let target = root.path().canonicalize().unwrap().join("moved");
        prepare(&standard, &target).unwrap();
        apply_pending(&standard, &standard).unwrap();
        for path in [&standard, &target] {
            let connection = rusqlite::Connection::open(path.join("calendar.db")).unwrap();
            assert_eq!(
                crate::agent_history::load(&connection).unwrap()["sourceNamespace"],
                namespace
            );
            assert_eq!(
                crate::agent_history::receipts(&connection)
                    .unwrap()
                    .as_object()
                    .unwrap()
                    .len(),
                503
            );
            assert_eq!(
                crate::agent_history::receipt(&connection, "synthetic-operation-0000")
                    .unwrap()
                    .unwrap()["result"]["synthetic"],
                0
            );
        }
    }
    #[test]
    fn failed_migration_can_resume_original_profile_without_retrying_forever() {
        let root = tempdir().unwrap();
        let source = root.path().canonicalize().unwrap().join("app");
        fs::create_dir(&source).unwrap();
        drop(rusqlite::Connection::open(source.join("calendar.db")).unwrap());
        let target = root.path().canonicalize().unwrap().join("new");
        prepare(&source, &target).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(target.join("foreign"), b"keep").unwrap();
        assert!(apply_pending(&source, &source).is_err());
        record_failure(&source).unwrap();
        assert_eq!(resolve(&source).unwrap(), source);
        assert!(!current(&source).unwrap().restart_required);
        assert!(current(&source).unwrap().migration_error.is_some());
        assert_eq!(fs::read(target.join("foreign")).unwrap(), b"keep");
        prepare(&source, &root.path().canonicalize().unwrap().join("retry")).unwrap();
        assert!(current(&source).unwrap().migration_error.is_none());
    }
    #[cfg(windows)]
    #[test]
    fn actual_dpapi_profile_is_reprotected_for_the_new_database_path() {
        let root = tempdir().unwrap();
        let source = root.path().canonicalize().unwrap().join("app");
        fs::create_dir(&source).unwrap();
        drop(rusqlite::Connection::open(source.join("calendar.db")).unwrap());
        let raw = "synthetic-device-and-key-payload";
        crate::mvp_sync::seed_migration_credentials(&source.join("calendar.db"), raw).unwrap();
        let old = fs::read(source.join("mvp-sync.credentials")).unwrap();
        let target = root.path().canonicalize().unwrap().join("new");
        prepare(&source, &target).unwrap();
        apply_pending(&source, &source).unwrap();
        assert_eq!(
            crate::mvp_sync::read_migration_credentials(&target.join("calendar.db"))
                .unwrap()
                .as_deref(),
            Some(raw)
        );
        assert_eq!(
            crate::mvp_sync::read_migration_credentials(&source.join("calendar.db"))
                .unwrap()
                .as_deref(),
            Some(raw)
        );
        assert_eq!(fs::read(source.join("mvp-sync.credentials")).unwrap(), old);
        assert_ne!(fs::read(target.join("mvp-sync.credentials")).unwrap(), old);
    }
    #[test]
    fn rejects_nonempty_and_preserves_pointer_on_failure() {
        let root = tempdir().unwrap();
        let standard = root.path().canonicalize().unwrap().join("app");
        fs::create_dir(&standard).unwrap();
        let target = root.path().canonicalize().unwrap().join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("x"), b"x").unwrap();
        assert!(validate_target(&standard, &standard, &target).is_err());
    }
    #[test]
    fn rejects_target_nested_in_custom_source_and_missing_pointer_database() {
        let root = tempdir().unwrap();
        let standard = root.path().canonicalize().unwrap().join("app");
        let source = root.path().canonicalize().unwrap().join("profile");
        fs::create_dir_all(&source).unwrap();
        assert!(validate_target(&standard, &source, &source.join("nested")).is_err());
        let pointer = pointer_path(&standard);
        fs::create_dir_all(pointer.parent().unwrap()).unwrap();
        fs::write(&pointer, serde_json::json!({"path": source}).to_string()).unwrap();
        assert!(resolve(&standard).is_err());
    }
    #[test]
    fn busy_source_is_refused_and_original_remains_usable() {
        let root = tempdir().unwrap();
        let standard = root.path().canonicalize().unwrap().join("app");
        fs::create_dir(&standard).unwrap();
        let conn = rusqlite::Connection::open(standard.join("calendar.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE identity(id TEXT); INSERT INTO identity VALUES('device-stable');",
        )
        .unwrap();
        drop(conn);
        let target = root.path().canonicalize().unwrap().join("new");
        prepare(&standard, &target).unwrap();
        let lock = crate::acquire_instance_lock(&standard).unwrap();
        assert!(crate::acquire_instance_lock(&standard).is_err());
        drop(lock);
        assert!(standard.join("calendar.db").is_file());
        assert!(!target.exists());
    }
    #[test]
    fn pending_copy_keeps_database_bytes_and_sets_pointer() {
        let root = tempdir().unwrap();
        let standard = root.path().canonicalize().unwrap().join("app");
        fs::create_dir(&standard).unwrap();
        let conn = rusqlite::Connection::open(standard.join("calendar.db")).unwrap();
        conn.execute_batch("CREATE TABLE t(id TEXT); INSERT INTO t VALUES('stable');")
            .unwrap();
        drop(conn);
        fs::write(standard.join("sync-key.bin"), b"stable-sync-key").unwrap();
        let target = root.path().canonicalize().unwrap().join("new");
        prepare(&standard, &target).unwrap();
        apply_pending(&standard, &standard).unwrap();
        assert_eq!(
            canonical_or_absolute(&resolve(&standard).unwrap()).unwrap(),
            canonical_or_absolute(&target).unwrap()
        );
        assert_eq!(
            stable_endpoint_dir(&standard).unwrap(),
            canonical_or_absolute(&standard).unwrap()
        );
        assert_eq!(endpoint_source(&standard, &target, false, false), standard);
        assert_eq!(endpoint_source(&standard, &target, false, true), target);
        assert_eq!(endpoint_source(&standard, &target, true, false), target);
        let c = rusqlite::Connection::open(target.join("calendar.db")).unwrap();
        assert_eq!(
            c.query_row("SELECT id FROM t", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "stable"
        );
        assert_eq!(
            fs::read(target.join("sync-key.bin")).unwrap(),
            b"stable-sync-key"
        );
    }
}

#[cfg(test)]
mod recovery_acceptance_tests {
    use super::*;
    use rusqlite::{Connection, OpenFlags};

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let standard = root.path().canonicalize().unwrap().join("profile");
        fs::create_dir(&standard).unwrap();
        (root, standard)
    }
    fn seed(path: &Path) -> Connection {
        let c = Connection::open(path.join("calendar.db")).unwrap();
        c.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE items(id TEXT PRIMARY KEY, version INTEGER NOT NULL);
            CREATE TABLE agent_history_meta(id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL,
                namespace TEXT NOT NULL, received_order INTEGER NOT NULL);
            INSERT INTO items VALUES('synthetic-task-stable',7);
            INSERT INTO agent_history_meta VALUES(1,2,'synthetic-canonical-namespace',42);",
        )
        .unwrap();
        c
    }
    fn identity(path: &Path) -> (String, i64, String) {
        let c =
            Connection::open_with_flags(path.join("calendar.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        assert_eq!(
            c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM items", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        c.query_row("SELECT items.id,items.version,agent_history_meta.namespace FROM items CROSS JOIN agent_history_meta WHERE agent_history_meta.id=1",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap()
    }
    fn staging_count(root: &Path) -> usize {
        fs::read_dir(root)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".cicada-migration-")
            })
            .count()
    }
    #[test]
    fn wal_backup_restore_and_relocation_keep_committed_identity() {
        let (root, standard) = fixture();
        let root = root.path().canonicalize().unwrap();
        let writer = seed(&standard);
        assert!(
            fs::metadata(standard.join("calendar.db-wal"))
                .unwrap()
                .len()
                > 32
        );
        let original_database = fs::read(standard.join("calendar.db")).unwrap();
        let expected = identity(&standard);
        writer
            .execute_batch("BEGIN IMMEDIATE; INSERT INTO items VALUES('synthetic-uncommitted',8);")
            .unwrap();
        let reader = Connection::open_with_flags(
            standard.join("calendar.db"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let backup = PathBuf::from(crate::backup(&reader, &standard).unwrap());
        assert!(backup.starts_with(&root));
        let restored = root.join("restored-profile");
        fs::create_dir(&restored).unwrap();
        fs::copy(&backup, restored.join("calendar.db")).unwrap();
        assert_eq!(identity(&restored), expected);
        assert_eq!(resolve(&restored).unwrap(), restored);
        let endpoint = stable_endpoint_dir(&standard).unwrap();
        let target = root.join("selected-profile");
        prepare(&standard, &target).unwrap();
        apply_pending(&standard, &standard).unwrap();
        assert_eq!(identity(&target), expected);
        assert_eq!(identity(&standard), expected);
        assert_eq!(
            fs::read(standard.join("calendar.db")).unwrap(),
            original_database
        );
        assert_eq!(resolve(&standard).unwrap(), target);
        assert_eq!(stable_endpoint_dir(&standard).unwrap(), endpoint);
        assert_eq!(staging_count(&root), 0);
        writer.execute_batch("ROLLBACK").unwrap();
    }
    #[test]
    fn corrupt_database_discards_partial_staging_without_switching_profile() {
        let (root, standard) = fixture();
        fs::write(
            standard.join("calendar.db"),
            b"synthetic invalid SQLite database",
        )
        .unwrap();
        fs::write(
            standard.join("attachment.txt"),
            b"synthetic retained attachment",
        )
        .unwrap();
        let target = root.path().canonicalize().unwrap().join("selected-profile");
        prepare(&standard, &target).unwrap();
        assert!(apply_pending(&standard, &standard).is_err());
        assert_eq!(resolve(&standard).unwrap(), standard);
        assert!(!target.exists());
        assert!(pending_path(&standard).is_file());
        assert_eq!(
            fs::read(standard.join("attachment.txt")).unwrap(),
            b"synthetic retained attachment"
        );
        assert_eq!(
            staging_count(root.path()),
            0,
            "failed copy must not leave partial user data in staging"
        );
    }
    #[cfg(windows)]
    #[test]
    fn denied_attachment_read_discards_partial_staging_and_keeps_source() {
        use std::os::windows::fs::OpenOptionsExt;
        let (root, standard) = fixture();
        drop(seed(&standard));
        let attachment = standard.join("attachment.txt");
        fs::write(&attachment, b"synthetic retained attachment").unwrap();
        let target = root.path().canonicalize().unwrap().join("selected-profile");
        let expected = identity(&standard);
        prepare(&standard, &target).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&attachment)
            .unwrap();
        assert!(apply_pending(&standard, &standard).is_err());
        assert_eq!(resolve(&standard).unwrap(), standard);
        assert_eq!(identity(&standard), expected);
        assert!(!target.exists());
        assert_eq!(
            staging_count(root.path()),
            0,
            "failed copy must not leave partial user data in staging"
        );
        drop(lock);
        assert_eq!(
            fs::read(&attachment).unwrap(),
            b"synthetic retained attachment"
        );
    }
    #[cfg(windows)]
    #[test]
    fn denied_pointer_replace_keeps_canonical_source_and_recoverable_copy() {
        use std::os::windows::fs::OpenOptionsExt;
        let (root, standard) = fixture();
        let source = root.path().canonicalize().unwrap().join("custom-source");
        fs::create_dir(&source).unwrap();
        drop(seed(&source));
        let expected = identity(&source);
        let pointer = serde_json::to_vec(&Pointer {
            path: source.to_string_lossy().into_owned(),
        })
        .unwrap();
        fs::write(pointer_path(&standard), &pointer).unwrap();
        let target = root.path().canonicalize().unwrap().join("selected-profile");
        prepare(&standard, &target).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(pointer_path(&standard))
            .unwrap();
        assert!(apply_pending(&standard, &source).is_err());
        assert_eq!(resolve(&standard).unwrap(), source);
        assert_eq!(fs::read(pointer_path(&standard)).unwrap(), pointer);
        assert_eq!(identity(&source), expected);
        assert_eq!(identity(&target), expected);
        assert_eq!(staging_count(root.path()), 0);
        assert!(!fs::read_dir(root.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".Cicada.data-location.json.tmp-")));
        drop(lock);
        record_failure(&standard).unwrap();
        assert!(!current(&standard).unwrap().restart_required);
        assert!(current(&standard).unwrap().migration_error.is_some());
        assert_eq!(resolve(&standard).unwrap(), source);
    }
    #[test]
    fn published_pointer_with_pending_marker_finishes_without_false_failure() {
        let (root, standard) = fixture();
        drop(seed(&standard));
        let target = root.path().canonicalize().unwrap().join("selected-profile");
        prepare(&standard, &target).unwrap();
        let pending = fs::read(pending_path(&standard)).unwrap();
        apply_pending(&standard, &standard).unwrap();
        // Reproduce interruption after pointer publication and before marker removal.
        fs::write(pending_path(&standard), pending).unwrap();
        let activated = resolve(&standard).unwrap();
        assert_eq!(activated, target);
        assert!(apply_pending(&standard, &activated).is_ok());
        assert!(!pending_path(&standard).exists());
        assert!(current(&standard).unwrap().migration_error.is_none());
        assert_eq!(identity(&standard), identity(&target));
    }
    #[test]
    fn foreign_pending_source_fails_without_writes() {
        let (root, standard) = fixture();
        drop(seed(&standard));
        let target = root.path().canonicalize().unwrap().join("selected-profile");
        prepare(&standard, &target).unwrap();
        let pending = fs::read(pending_path(&standard)).unwrap();
        let foreign = root.path().canonicalize().unwrap().join("other-profile");
        fs::create_dir(&foreign).unwrap();
        assert!(apply_pending(&standard, &foreign).is_err());
        assert_eq!(fs::read(pending_path(&standard)).unwrap(), pending);
        assert!(!target.exists());
        assert_eq!(staging_count(root.path()), 0);
    }
}
