//! A stable OS lock serializes foreground and headless content exchanges.
//! Never unlink it: another process could otherwise lock a different inode.
use std::{
    fs::{File, OpenOptions, TryLockError},
    path::Path,
};

pub(super) fn acquire(database: &Path) -> Result<File, String> {
    let database = database
        .canonicalize()
        .map_err(|_| "content_sync_lease_failed")?;
    if !database.is_file() {
        return Err("content_sync_lease_failed".into());
    }
    let path = database.with_extension("content-sync.lock");
    match std::fs::symlink_metadata(&path) {
        Ok(v) if !v.is_file() || v.file_type().is_symlink() => {
            return Err("content_sync_lease_failed".into())
        }
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            return Err("content_sync_lease_failed".into())
        }
        _ => {}
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0x0000_0001 | 0x0000_0002);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(&path)
        .map_err(|_| "content_sync_lease_failed")?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err("content_sync_already_running".into()),
        Err(TryLockError::Error(_)) => Err("content_sync_lease_failed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "child probe invoked by content_process_lease test"]
    fn content_process_lease_probe() {
        let path = std::env::var("HANNI_CONTENT_LEASE_TEST_DB").unwrap();
        assert_eq!(
            acquire(Path::new(&path)).unwrap_err(),
            "content_sync_already_running"
        );
    }
    #[test]
    fn content_process_lease_excludes_another_process_and_releases_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.db");
        std::fs::write(&path, b"synthetic").unwrap();
        let first = acquire(&path).unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "mvp_sync::transport::run_lease::tests::content_process_lease_probe",
            ])
            .env("HANNI_CONTENT_LEASE_TEST_DB", &path)
            .output()
            .unwrap();
        assert!(child.status.success());
        drop(first);
        assert!(acquire(&path).is_ok());
        assert!(path.with_extension("content-sync.lock").is_file());
    }
}
