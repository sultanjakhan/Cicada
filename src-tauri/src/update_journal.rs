//! Private updater cache writes and crash-persistent retry receipts.
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Не удалось сохранить обновление.")?;
    std::fs::create_dir_all(parent).map_err(|_| "Не удалось создать папку обновлений.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Недостаточно места для обновления.")?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "Недостаточно места для обновления.")?;
    temporary
        .persist(path)
        .map_err(|_| "Не удалось сохранить обновление.")?;
    Ok(())
}

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Default, Serialize, Deserialize)]
struct Attempt {
    version: String,
    sha256: String,
    last_attempt: u64,
    count: u32,
}

pub(crate) fn retry_seconds(count: u32) -> u64 {
    60u64
        .saturating_mul(1u64 << count.saturating_sub(1).min(9))
        .min(6 * 60 * 60)
}

fn read(path: &Path) -> Result<Attempt, String> {
    if !path.exists() {
        return Ok(Attempt::default());
    }
    if std::fs::metadata(path)
        .map_err(|_| "Не удалось прочитать состояние обновления.")?
        .len()
        > 4096
    {
        return Err("Состояние обновления повреждено.".into());
    }
    serde_json::from_slice(
        &std::fs::read(path).map_err(|_| "Не удалось прочитать состояние обновления.")?,
    )
    .map_err(|_| "Состояние обновления повреждено.".into())
}

pub(crate) fn allowed(path: &Path, version: &str, sha256: &str, at: u64) -> Result<bool, String> {
    let attempt = read(path)?;
    Ok(attempt.count == 0
        || attempt.version != version
        || attempt.sha256 != sha256
        || at.saturating_sub(attempt.last_attempt) >= retry_seconds(attempt.count))
}

pub(crate) fn record(path: &Path, version: &str, sha256: &str, at: u64) -> Result<(), String> {
    let previous = read(path)?;
    let count = if previous.version == version && previous.sha256 == sha256 {
        previous.count.saturating_add(1)
    } else {
        1
    };
    let receipt = Attempt {
        version: version.into(),
        sha256: sha256.into(),
        last_attempt: at,
        count,
    };
    let bytes =
        serde_json::to_vec(&receipt).map_err(|_| "Не удалось сохранить состояние обновления.")?;
    atomic_write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_cache_replaces_existing_file_without_partial_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prepared.json");
        atomic_write(&path, b"old payload").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn crash_receipt_throttles_same_package_but_not_a_newer_release() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("attempt.json");
        assert!(allowed(&path, "0.3.11", "a", 1000).unwrap());
        record(&path, "0.3.11", "a", 1000).unwrap();
        assert!(!allowed(&path, "0.3.11", "a", 1059).unwrap());
        assert!(allowed(&path, "0.3.11", "a", 1060).unwrap());
        record(&path, "0.3.11", "a", 1060).unwrap();
        assert!(!allowed(&path, "0.3.11", "a", 1179).unwrap());
        assert!(allowed(&path, "0.3.12", "b", 1061).unwrap());
        assert!(!allowed(&path, "0.3.11", "a", 500).unwrap());
        assert_eq!(retry_seconds(u32::MAX), 21600);
    }
    #[test]
    fn corrupt_or_oversized_receipt_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("attempt.json");
        atomic_write(&path, b"{").unwrap();
        assert!(allowed(&path, "1", "a", 0).is_err());
        atomic_write(&path, &[0; 4097]).unwrap();
        assert!(allowed(&path, "1", "a", 0).is_err());
    }
}
