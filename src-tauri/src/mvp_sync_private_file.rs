//! Explicit macOS plaintext credential storage; never a fallback from Keychain.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::{c_char, c_int, c_void, CString},
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path},
};

const DIRECTORY: &str = ".cicada-sync-private";
const MARKER: &str = ".cicada-sync-backend.json";
const PAYLOAD: &str = "pairing.json";
const INVALID: &str = "mvp_sync_private_file_invalid";
const UNAVAILABLE: &str = "mvp_sync_private_file_unavailable";
const LIMIT: u64 = 4096;
// Darwin SDK sys/fcntl.h, sys/stat.h, sys/stdio.h and sys/acl.h.
const NOFOLLOW: c_int = 0x100;
const CLOEXEC: c_int = 0x0100_0000;
const DIRECTORY_FLAG: c_int = 0x0010_0000;
const NONBLOCK: c_int = 0x4;
unsafe extern "C" {
    fn openat(fd: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
    fn mkdirat(fd: c_int, path: *const c_char, mode: u16) -> c_int;
    fn renameat(from: c_int, name: *const c_char, to: c_int, target: *const c_char) -> c_int;
    fn geteuid() -> u32;
    fn acl_get_fd_np(fd: c_int, kind: c_int) -> *mut c_void;
    fn acl_valid(acl: *mut c_void) -> c_int;
    fn acl_get_entry(acl: *mut c_void, index: c_int, entry: *mut *mut c_void) -> c_int;
    fn acl_get_tag_type(entry: *mut c_void, tag: *mut c_int) -> c_int;
    fn acl_get_permset_mask_np(entry: *mut c_void, mask: *mut u64) -> c_int;
    fn acl_free(acl: *mut c_void) -> c_int;
}
fn invalid<T>() -> Result<T, String> {
    Err(INVALID.into())
}
fn name(value: &std::ffi::OsStr) -> Result<CString, String> {
    CString::new(value.as_bytes()).map_err(|_| INVALID.into())
}
fn acl_private(file: &File, no_grants: bool) -> Result<(), String> {
    let acl = unsafe { acl_get_fd_np(file.as_raw_fd(), 0x100) };
    if acl.is_null() {
        return if std::io::Error::last_os_error().raw_os_error() == Some(2) {
            Ok(())
        } else {
            invalid()
        };
    }
    struct Acl(*mut c_void);
    impl Drop for Acl {
        fn drop(&mut self) {
            unsafe {
                acl_free(self.0);
            }
        }
    }
    let acl = Acl(acl);
    if unsafe { acl_valid(acl.0) } != 0 {
        return invalid();
    }
    const WRITE: u64 =
        (1 << 2) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 8) | (1 << 10) | (1 << 12) | (1 << 13);
    for index in 0..=128 {
        let mut entry = std::ptr::null_mut();
        if unsafe { acl_get_entry(acl.0, index, &mut entry) } != 0 {
            return if std::io::Error::last_os_error().raw_os_error() == Some(22) {
                Ok(())
            } else {
                invalid()
            };
        }
        let mut tag = 0;
        let mut mask = 0;
        if unsafe { acl_get_tag_type(entry, &mut tag) } != 0
            || unsafe { acl_get_permset_mask_np(entry, &mut mask) } != 0
            || (tag == 1 && (no_grants || mask & WRITE != 0))
        {
            return invalid();
        }
    }
    invalid()
}
fn validate(file: &File, directory: bool, private: bool) -> Result<(), String> {
    validate_limit(file, directory, private, LIMIT)
}
fn validate_limit(file: &File, directory: bool, private: bool, limit: u64) -> Result<(), String> {
    let m = file.metadata().map_err(|_| UNAVAILABLE)?;
    let uid = unsafe { geteuid() };
    if directory {
        if !m.is_dir()
            || (m.uid() != uid && (private || m.uid() != 0))
            || if private {
                m.mode() & 0o7777 != 0o700
            } else {
                m.mode() & 0o022 != 0
            }
        {
            return invalid();
        }
    } else if !m.is_file()
        || m.uid() != uid
        || m.mode() & 0o7777 != 0o600
        || m.nlink() != 1
        || m.len() > limit
    {
        return invalid();
    }
    acl_private(file, private)
}
fn child(parent: &File, leaf: &std::ffi::OsStr, directory: bool) -> Result<Option<File>, String> {
    let leaf = name(leaf)?;
    let fd = unsafe {
        openat(
            parent.as_raw_fd(),
            leaf.as_ptr(),
            NOFOLLOW | CLOEXEC | if directory { DIRECTORY_FLAG } else { NONBLOCK },
        )
    };
    if fd < 0 {
        return if std::io::Error::last_os_error().raw_os_error() == Some(2) {
            Ok(None)
        } else {
            invalid()
        };
    }
    Ok(Some(unsafe { File::from_raw_fd(fd) }))
}
fn directory(path: &Path, private: bool) -> Result<File, String> {
    if !path.is_absolute() {
        return invalid();
    }
    let mut current = File::open("/").map_err(|_| UNAVAILABLE)?;
    validate(&current, true, false)?;
    for part in path.components() {
        match part {
            Component::RootDir => (),
            Component::Normal(leaf) => {
                current = child(&current, leaf, true)?.ok_or(UNAVAILABLE)?;
                validate(&current, true, false)?;
            }
            _ => return invalid(),
        }
    }
    validate(&current, true, private)?;
    Ok(current)
}
fn read(parent: &File, leaf: &str) -> Result<String, String> {
    read_limit(parent, leaf, LIMIT)
}
fn read_limit(parent: &File, leaf: &str, limit: u64) -> Result<String, String> {
    let file = child(parent, leaf.as_ref(), false)?.ok_or(UNAVAILABLE)?;
    validate_limit(&file, false, true, limit)?;
    let before = file.metadata().map_err(|_| UNAVAILABLE)?;
    let mut bytes = Vec::new();
    (&file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UNAVAILABLE)?;
    validate_limit(&file, false, true, limit)?;
    let after = file.metadata().map_err(|_| UNAVAILABLE)?;
    if bytes.is_empty()
        || bytes.len() as u64 > limit
        || bytes.len() as u64 != after.len()
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return invalid();
    }
    String::from_utf8(bytes).map_err(|_| INVALID.into())
}
fn atomic_write(parent: &File, leaf: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() as u64 > LIMIT {
        return invalid();
    }
    if let Some(existing) = child(parent, leaf.as_ref(), false)? {
        validate(&existing, false, true)?;
    }
    let temporary = name(format!(".write-{}", uuid::Uuid::new_v4()).as_ref())?;
    let fd = unsafe {
        openat(
            parent.as_raw_fd(),
            temporary.as_ptr(),
            1 | 0x200 | 0x800 | NOFOLLOW | CLOEXEC,
            0o600 as c_int,
        )
    };
    if fd < 0 {
        return Err(UNAVAILABLE.into());
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    validate(&file, false, true)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| UNAVAILABLE)?;
    validate(&file, false, true)?;
    let destination = name(leaf.as_ref())?;
    if unsafe {
        renameat(
            parent.as_raw_fd(),
            temporary.as_ptr(),
            parent.as_raw_fd(),
            destination.as_ptr(),
        )
    } != 0
    {
        return Err(UNAVAILABLE.into());
    }
    parent.sync_all().map_err(|_| UNAVAILABLE)?;
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Marker {
    version: u8,
    backend: String,
    profile: String,
}
fn profile(database: &Path) -> Result<(File, String), String> {
    let path = database.canonicalize().map_err(|_| INVALID)?;
    if !path.is_file() {
        return invalid();
    }
    let binding = format!(
        "device-v1-{:x}",
        Sha256::digest(path.to_str().ok_or(INVALID)?.as_bytes())
    );
    Ok((directory(path.parent().ok_or(INVALID)?, false)?, binding))
}
fn store(database: &Path) -> Result<Option<(File, String)>, String> {
    let (parent, binding) = profile(database)?;
    let Some(marker) = child(&parent, MARKER.as_ref(), false)? else {
        // An interrupted explicit setup must never revert to the default store.
        return if child(&parent, DIRECTORY.as_ref(), true)?.is_some() {
            invalid()
        } else {
            Ok(None)
        };
    };
    validate(&marker, false, true)?;
    let marker: Marker = serde_json::from_str(&read(&parent, MARKER)?).map_err(|_| INVALID)?;
    if marker.version != 1 || marker.backend != "private-file" || marker.profile != binding {
        return invalid();
    }
    let dir = child(&parent, DIRECTORY.as_ref(), true)?.ok_or(UNAVAILABLE)?;
    validate(&dir, true, true)?;
    Ok(Some((dir, binding)))
}
pub(super) fn selected(database: &Path) -> Result<bool, String> {
    Ok(store(database)?.is_some())
}
pub(super) fn read_selected(database: &Path) -> Result<Option<String>, String> {
    store(database)?
        .map(|(dir, _)| read(&dir, PAYLOAD))
        .transpose()
}
pub(super) fn write_selected(database: &Path, raw: &str) -> Result<bool, String> {
    let Some((dir, _)) = store(database)? else {
        return Ok(false);
    };
    atomic_write(&dir, PAYLOAD, raw.as_bytes())?;
    Ok(true)
}
pub(super) fn read_external(path: &Path) -> Result<String, String> {
    read_external_limited(path, LIMIT)
}
pub(super) fn read_external_limited(path: &Path, limit: u64) -> Result<String, String> {
    let parent = directory(path.parent().ok_or(INVALID)?, true)?;
    let leaf = path.file_name().and_then(|v| v.to_str()).ok_or(INVALID)?;
    read_limit(&parent, leaf, limit)
}
pub(super) fn recovery_directory(database: &Path) -> Result<std::path::PathBuf, String> {
    let (dir, _) = store(database)?.ok_or(UNAVAILABLE)?;
    validate(&dir, true, true)?;
    Ok(database.canonicalize().map_err(|_| INVALID)?.parent().ok_or(INVALID)?.join(DIRECTORY))
}
// Caller validates the exact pairing and durable sync scope before creating anything.
pub(super) fn install(database: &Path, raw: &str) -> Result<(), String> {
    install_with_previous_binding(database, raw, None)
}
pub(super) fn install_relocated(source: &Path, target: &Path, raw: &str) -> Result<(), String> {
    let (_, old_binding) = profile(source)?;
    install_with_previous_binding(target, raw, Some(&old_binding))
}
fn install_with_previous_binding(
    database: &Path,
    raw: &str,
    previous: Option<&str>,
) -> Result<(), String> {
    let (parent, binding) = profile(database)?;
    if let Some(marker) = child(&parent, MARKER.as_ref(), false)? {
        validate(&marker, false, true)?;
        let existing: Marker =
            serde_json::from_str(&read(&parent, MARKER)?).map_err(|_| INVALID)?;
        if existing.version != 1
            || existing.backend != "private-file"
            || (existing.profile != binding && Some(existing.profile.as_str()) != previous)
        {
            return invalid();
        }
    }
    let dir = match child(&parent, DIRECTORY.as_ref(), true)? {
        Some(dir) => dir,
        None => {
            let leaf = name(DIRECTORY.as_ref())?;
            if unsafe { mkdirat(parent.as_raw_fd(), leaf.as_ptr(), 0o700) } != 0 {
                return Err(UNAVAILABLE.into());
            }
            parent.sync_all().map_err(|_| UNAVAILABLE)?;
            child(&parent, DIRECTORY.as_ref(), true)?.ok_or(UNAVAILABLE)?
        }
    };
    validate(&dir, true, true)?;
    atomic_write(&dir, PAYLOAD, raw.as_bytes())?;
    let marker = serde_json::to_vec(&Marker {
        version: 1,
        backend: "private-file".into(),
        profile: binding,
    })
    .map_err(|_| INVALID)?;
    atomic_write(&parent, MARKER, &marker)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, DirBuilderExt, PermissionsExt};
    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("calendar.db");
        std::fs::write(&database, b"synthetic database").unwrap();
        (root, database)
    }
    #[test]
    fn explicit_selection_survives_restart_and_never_crosses_profiles() {
        let (root, db) = fixture();
        assert!(!selected(&db).unwrap());
        install(&db, "synthetic-private-payload").unwrap();
        assert_eq!(
            read_selected(&db).unwrap().unwrap(),
            "synthetic-private-payload"
        );
        let (other, other_db) = fixture();
        std::fs::rename(root.path().join(DIRECTORY), other.path().join(DIRECTORY)).unwrap();
        std::fs::rename(root.path().join(MARKER), other.path().join(MARKER)).unwrap();
        assert!(selected(&other_db).is_err());
    }
    #[test]
    fn missing_invalid_and_unsafe_selected_files_fail_closed() {
        for mutation in [
            "missing-marker",
            "bad-marker",
            "missing-payload",
            "mode",
            "symlink",
            "hardlink",
            "large",
        ] {
            let (root, db) = fixture();
            install(&db, "synthetic-private-payload").unwrap();
            let dir = root.path().join(DIRECTORY);
            let payload = dir.join(PAYLOAD);
            match mutation {
                "missing-marker" => std::fs::remove_file(root.path().join(MARKER)).unwrap(),
                "bad-marker" => std::fs::write(root.path().join(MARKER), b"invalid").unwrap(),
                "missing-payload" => std::fs::remove_file(&payload).unwrap(),
                "mode" => {
                    std::fs::set_permissions(&payload, std::fs::Permissions::from_mode(0o644))
                        .unwrap()
                }
                "symlink" => {
                    std::fs::remove_file(&payload).unwrap();
                    symlink("missing", &payload).unwrap();
                }
                "hardlink" => std::fs::hard_link(&payload, dir.join("alias")).unwrap(),
                "large" => std::fs::write(&payload, vec![b'x'; 4097]).unwrap(),
                _ => unreachable!(),
            }
            assert!(read_selected(&db).is_err(), "{mutation}");
        }
    }
    #[test]
    fn external_pairing_requires_a_private_nonsymlink_single_link_file() {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let physical = root.path().canonicalize().unwrap();
        let input = physical.join("input.json");
        std::fs::write(&input, b"synthetic").unwrap();
        std::fs::set_permissions(&input, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_external(&input).unwrap(), "synthetic");
        let alias = physical.join("alias");
        symlink(&input, &alias).unwrap();
        assert!(read_external(&alias).is_err());
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(read_external(&input).is_err());
    }
    #[test]
    fn allowed_acl_grants_are_refused() {
        let (root, db) = fixture();
        install(&db, "synthetic-private-payload").unwrap();
        let payload = root.path().join(DIRECTORY).join(PAYLOAD);
        assert!(std::process::Command::new("/bin/chmod")
            .args(["+a", "everyone allow read"])
            .arg(&payload)
            .status()
            .unwrap()
            .success());
        assert!(read_selected(&db).is_err());
    }
    #[test]
    fn an_opened_directory_cannot_be_redirected_by_a_path_replacement() {
        let root = tempfile::tempdir().unwrap();
        let physical = root.path().canonicalize().unwrap();
        let original = physical.join("original");
        let moved = physical.join("moved");
        let other = physical.join("other");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&original)
            .unwrap();
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&other)
            .unwrap();
        let pinned = directory(&original, true).unwrap();
        std::fs::rename(&original, &moved).unwrap();
        symlink(&other, &original).unwrap();
        atomic_write(&pinned, "fixture", b"synthetic-private-payload").unwrap();
        assert_eq!(
            read(&pinned, "fixture").unwrap(),
            "synthetic-private-payload"
        );
        assert!(moved.join("fixture").is_file());
        assert!(!other.join("fixture").exists());
    }
}
