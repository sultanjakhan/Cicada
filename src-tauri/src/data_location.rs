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

pub fn validate_target(standard: &Path, source: &Path, target: &Path) -> Result<PathBuf, String> {
    validate_raw_local(target)?;
    validate_raw_local(source)?;
    let target = canonical_or_absolute(target)?;
    let source = canonical_or_absolute(source)?;
    let standard = canonical_or_absolute(standard)?;
    let legacy = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|p| p.join("Documents").join("Hanni"));
    if overlaps(&target, &source)
        || overlaps(&target, &standard)
        || legacy.as_deref().is_some_and(|p| overlaps(&target, p))
    {
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
        return Ok(standard.to_path_buf());
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
        is_default: path == *standard,
        path: path.to_string_lossy().into_owned(),
        restart_required: pending_path(standard).exists(),
    })
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_file_name(format!(
        ".{}.tmp-{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        Uuid::new_v4()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|_| "Не удалось подготовить расположение данных.")?;
    use std::io::Write;
    file.write_all(bytes)
        .map_err(|_| "Не удалось сохранить расположение данных.")?;
    file.sync_all()
        .map_err(|_| "Не удалось сохранить расположение данных.")?;
    drop(file);
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
    Ok(DataLocation {
        path: target.to_string_lossy().into_owned(),
        is_default: false,
        restart_required: true,
    })
}

fn hash(path: &Path) -> Result<Vec<u8>, String> {
    Ok(Sha256::digest(fs::read(path).map_err(|_| "Не удалось проверить копию данных.")?).to_vec())
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|_| "Не удалось создать папку данных.")?;
    for entry in fs::read_dir(source).map_err(|_| "Не удалось прочитать исходные данные.")?
    {
        let entry = entry.map_err(|_| "Не удалось прочитать исходные данные.")?;
        let name = entry.file_name();
        if name == "hanni-mvp.instance.lock"
            || name == "calendar.db"
            || name == "calendar.db-wal"
            || name == "calendar.db-shm"
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
            copy_tree(&from, &to)?;
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
        return Err("Отложенное перемещение относится к другому профилю.".into());
    }
    let target = validate_target(standard, source, Path::new(&pending.target))?;
    let temp = target
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!(".cicada-migration-{}", Uuid::new_v4()));
    fs::create_dir(&temp).map_err(|_| "Не удалось создать уникальную staging-папку.")?;
    copy_tree(source, &temp)?;
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
    fs::rename(&temp, &target).map_err(|_| "Не удалось включить новое расположение данных.")?;
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
    fn rejects_nonempty_and_preserves_pointer_on_failure() {
        let root = tempdir().unwrap();
        let standard = root.path().join("app");
        fs::create_dir(&standard).unwrap();
        let target = root.path().join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("x"), b"x").unwrap();
        assert!(validate_target(&standard, &standard, &target).is_err());
    }
    #[test]
    fn rejects_target_nested_in_custom_source_and_missing_pointer_database() {
        let root = tempdir().unwrap();
        let standard = root.path().join("app");
        let source = root.path().join("profile");
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
        let standard = root.path().join("app");
        fs::create_dir(&standard).unwrap();
        let conn = rusqlite::Connection::open(standard.join("calendar.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE identity(id TEXT); INSERT INTO identity VALUES('device-stable');",
        )
        .unwrap();
        drop(conn);
        let target = root.path().join("new");
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
        let standard = root.path().join("app");
        fs::create_dir(&standard).unwrap();
        let conn = rusqlite::Connection::open(standard.join("calendar.db")).unwrap();
        conn.execute_batch("CREATE TABLE t(id TEXT); INSERT INTO t VALUES('stable');")
            .unwrap();
        drop(conn);
        fs::write(standard.join("sync-key.bin"), b"stable-sync-key").unwrap();
        let target = root.path().join("new");
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
