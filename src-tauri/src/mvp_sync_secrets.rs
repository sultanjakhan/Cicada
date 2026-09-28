//! Adapted from Hanni's no-prompt Keychain reads and user-bound DPAPI storage.
//! Database-path scoping keeps independently launched MVP profiles unpaired.
//! The sync relay key and the Jira import credential (2026-09-25) use separate
//! slots; the relay slot keeps its original service, file name and entropy.
use sha2::{Digest, Sha256};
use std::path::Path;

/// One secret slot: the Keychain service on macOS; on Windows and Android the
/// file next to the database, protected on Windows with `<service>:<account>`
/// as DPAPI entropy.
pub(crate) struct Store {
    #[cfg_attr(not(any(target_os = "macos", windows, test)), allow(dead_code))]
    service: &'static str,
    #[cfg_attr(not(any(windows, target_os = "android", test)), allow(dead_code))]
    file_name: &'static str,
}
pub(crate) const RELAY: Store = Store {
    service: "app.hanni.mvp.relay",
    file_name: "mvp-sync.credentials",
};
pub(crate) const JIRA: Store = Store {
    service: "app.hanni.mvp.jira",
    file_name: "jira-import.credentials",
};
const LIMIT: usize = 4096;

fn account(database_path: &Path) -> Result<String, String> {
    let canonical = database_path
        .canonicalize()
        .map_err(|_| "mvp_sync_credentials_path_invalid")?;
    let path = canonical
        .to_str()
        .ok_or("mvp_sync_credentials_path_invalid")?;
    Ok(format!("device-v1-{:x}", Sha256::digest(path.as_bytes())))
}

#[cfg(any(windows, test))]
fn entropy(store: &Store, account: &str) -> String {
    format!("{}:{account}", store.service)
}

#[cfg(target_os = "macos")]
fn read_options(store: &Store, account: &str) -> security_framework::passwords::PasswordOptions {
    use core_foundation::{
        base::TCFType,
        string::{CFString, CFStringRef},
    };
    use security_framework::passwords::PasswordOptions;
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecUseAuthenticationUI: CFStringRef;
        static kSecUseAuthenticationUIFail: CFStringRef;
    }
    let mut options = PasswordOptions::new_generic_password(store.service, account);
    // This flag covers the modern backend; the file-based Keychain also needs
    // SecKeychainSetUserInteractionAllowed below (Apple FB16959400).
    #[allow(deprecated)]
    unsafe {
        options.query.push((
            CFString::wrap_under_get_rule(kSecUseAuthenticationUI),
            CFString::wrap_under_get_rule(kSecUseAuthenticationUIFail).into_CFType(),
        ));
    }
    options
}

#[cfg(target_os = "macos")]
fn forbid_keychain_dialogs() -> Result<(), String> {
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainSetUserInteractionAllowed(allowed: u8) -> i32;
    }
    // Keep this process noninteractive, including explicit configuration saves.
    // Restoring interaction after a read can race another Keychain operation.
    if unsafe { SecKeychainSetUserInteractionAllowed(0) } != 0 {
        return Err("mvp_sync_credentials_unavailable".into());
    }
    Ok(())
}

pub(crate) fn read(database_path: &Path) -> Result<Option<String>, String> {
    read_from(&RELAY, database_path)
}

pub(crate) fn write(database_path: &Path, raw: &str) -> Result<(), String> {
    write_to(&RELAY, database_path, raw)
}

pub(crate) fn read_from(store: &Store, database_path: &Path) -> Result<Option<String>, String> {
    let slot = account(database_path)?;
    #[cfg(target_os = "macos")]
    forbid_keychain_dialogs()?;
    #[cfg(target_os = "macos")]
    let bytes = match security_framework::passwords::generic_password(read_options(store, &slot)) {
        Ok(bytes) => bytes,
        Err(error) if error.code() == -25300 => return Ok(None),
        Err(_) => return Err("mvp_sync_credentials_unavailable".into()),
    };
    #[cfg(any(windows, target_os = "android"))]
    let bytes = {
        let Some(stored) = read_file(store, database_path)? else {
            return Ok(None);
        };
        #[cfg(windows)]
        let stored = dpapi_unprotect(&stored, entropy(store, &slot).as_bytes())?;
        #[cfg(target_os = "android")]
        let _ = slot;
        stored
    };
    #[cfg(not(any(windows, target_os = "macos", target_os = "android")))]
    {
        let _ = (store, slot);
        return Err("mvp_sync_platform_unsupported".into());
    }
    #[cfg(any(windows, target_os = "macos", target_os = "android"))]
    {
        if bytes.len() > LIMIT {
            return Err("mvp_sync_credentials_invalid".into());
        }
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "mvp_sync_credentials_invalid".into())
    }
}

pub(crate) fn write_to(store: &Store, database_path: &Path, raw: &str) -> Result<(), String> {
    if raw.len() > LIMIT {
        return Err("mvp_sync_credentials_invalid".into());
    }
    let slot = account(database_path)?;
    #[cfg(target_os = "macos")]
    {
        forbid_keychain_dialogs()?;
        security_framework::passwords::set_generic_password(store.service, &slot, raw.as_bytes())
            .map_err(|_| "mvp_sync_credentials_write_failed")?;
        if read_from(store, database_path)?.as_deref() != Some(raw) {
            return Err("mvp_sync_credentials_verify_failed".into());
        }
        Ok(())
    }
    #[cfg(any(windows, target_os = "android"))]
    {
        #[cfg(windows)]
        let stored = {
            let entropy = entropy(store, &slot);
            let protected = dpapi_protect(raw.as_bytes(), entropy.as_bytes())?;
            if dpapi_unprotect(&protected, entropy.as_bytes())? != raw.as_bytes() {
                return Err("mvp_sync_credentials_verify_failed".into());
            }
            protected
        };
        #[cfg(target_os = "android")]
        let stored = {
            let _ = slot;
            raw.as_bytes().to_vec()
        };
        write_file(store, database_path, &stored)
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "android")))]
    {
        let _ = (store, slot);
        Err("mvp_sync_platform_unsupported".into())
    }
}

/// Removes a slot on an explicit user action; a missing secret is not an error.
pub(crate) fn delete_from(store: &Store, database_path: &Path) -> Result<(), String> {
    let slot = account(database_path)?;
    #[cfg(target_os = "macos")]
    {
        forbid_keychain_dialogs()?;
        match security_framework::passwords::delete_generic_password(store.service, &slot) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(_) => Err("mvp_sync_credentials_write_failed".into()),
        }
    }
    #[cfg(any(windows, target_os = "android"))]
    {
        let _ = slot;
        match std::fs::remove_file(credential_path(store, database_path)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("mvp_sync_credentials_write_failed".into()),
        }
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "android")))]
    {
        let _ = (store, slot);
        Err("mvp_sync_platform_unsupported".into())
    }
}

#[cfg(any(windows, target_os = "android", test))]
fn credential_path(store: &Store, database_path: &Path) -> Result<std::path::PathBuf, String> {
    Ok(database_path
        .canonicalize()
        .map_err(|_| "mvp_sync_credentials_path_invalid")?
        .with_file_name(store.file_name))
}

#[cfg(any(windows, target_os = "android"))]
fn read_file(store: &Store, database_path: &Path) -> Result<Option<Vec<u8>>, String> {
    let path = credential_path(store, database_path)?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("mvp_sync_credentials_unavailable".into()),
    };
    if !metadata.is_file() || metadata.len() > 16384 {
        return Err("mvp_sync_credentials_invalid".into());
    }
    std::fs::read(path)
        .map(Some)
        .map_err(|_| "mvp_sync_credentials_unavailable".into())
}

#[cfg(any(windows, target_os = "android"))]
fn write_file(store: &Store, database_path: &Path, stored: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let path = credential_path(store, database_path)?;
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        if !metadata.is_file() {
            return Err("mvp_sync_credentials_invalid".into());
        }
    }
    let parent = path.parent().ok_or("mvp_sync_credentials_path_invalid")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "mvp_sync_credentials_write_failed")?;
    #[cfg(target_os = "android")]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "mvp_sync_credentials_write_failed")?;
    }
    temporary
        .write_all(stored)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "mvp_sync_credentials_write_failed")?;
    let check =
        std::fs::read(temporary.path()).map_err(|_| "mvp_sync_credentials_verify_failed")?;
    if check != stored {
        return Err("mvp_sync_credentials_verify_failed".into());
    }
    temporary
        .persist(path)
        .map_err(|_| "mvp_sync_credentials_write_failed")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn repeated_keychain_operations_keep_interaction_disabled() {
        use security_framework::os::macos::keychain::SecKeychain;
        // Only inspect process policy; never access the user's Keychain items.
        for _ in 0..3 {
            forbid_keychain_dialogs().unwrap();
            assert!(!SecKeychain::user_interaction_allowed().unwrap());
        }
    }

    #[test]
    fn independent_profiles_never_share_a_credential_slot() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let left = first.path().join("calendar.db");
        let right = second.path().join("calendar.db");
        std::fs::write(&left, b"").unwrap();
        std::fs::write(&right, b"").unwrap();
        assert_ne!(account(&left).unwrap(), account(&right).unwrap());
        assert_eq!(
            account(&left).unwrap(),
            account(&first.path().join("./calendar.db")).unwrap()
        );
        assert!(!account(&left)
            .unwrap()
            .contains(first.path().to_str().unwrap()));
    }

    #[test]
    fn a_missing_database_never_falls_back_to_another_profile() {
        let directory = tempfile::tempdir().unwrap();
        assert!(account(&directory.path().join("missing.db")).is_err());
    }

    #[test]
    fn the_relay_slot_keeps_its_identity_and_jira_uses_its_own() {
        // Only derive names; never access the user's Keychain items or files.
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("calendar.db");
        std::fs::write(&database, b"").unwrap();
        let slot = account(&database).unwrap();
        assert!(slot.starts_with("device-v1-"));
        assert_eq!(RELAY.service, "app.hanni.mvp.relay");
        assert_eq!(
            entropy(&RELAY, &slot),
            format!("app.hanni.mvp.relay:{slot}")
        );
        assert_eq!(
            credential_path(&RELAY, &database).unwrap(),
            database
                .canonicalize()
                .unwrap()
                .with_file_name("mvp-sync.credentials")
        );
        assert_eq!(JIRA.service, "app.hanni.mvp.jira");
        assert_ne!(entropy(&JIRA, &slot), entropy(&RELAY, &slot));
        assert_ne!(
            credential_path(&JIRA, &database).unwrap(),
            credential_path(&RELAY, &database).unwrap()
        );
    }
}

#[cfg(windows)]
fn dpapi_protect(plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input_len =
        u32::try_from(plaintext.len()).map_err(|_| "secret is too large for DPAPI".to_string())?;
    let entropy_len =
        u32::try_from(entropy.len()).map_err(|_| "DPAPI entropy is too large".to_string())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: plaintext.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy_len,
        pbData: entropy.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            Some(&entropy),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    }
    .map_err(|error| {
        let _ = error;
        "mvp_sync_credentials_write_failed".to_string()
    })?;
    if output.pbData.is_null() {
        return Err("DPAPI protect returned no data".to_string());
    }
    let protected =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    Ok(protected)
}

#[cfg(windows)]
fn dpapi_unprotect(protected: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input_len = u32::try_from(protected.len())
        .map_err(|_| "protected secret is too large for DPAPI".to_string())?;
    let entropy_len =
        u32::try_from(entropy.len()).map_err(|_| "DPAPI entropy is too large".to_string())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: protected.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy_len,
        pbData: entropy.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            Some(&entropy),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    }
    .map_err(|error| {
        let _ = error;
        "mvp_sync_credentials_unavailable".to_string()
    })?;
    if output.pbData.is_null() {
        return Err("DPAPI unprotect returned no data".to_string());
    }
    let plaintext =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    Ok(plaintext)
}
