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

#[cfg(any(target_os = "macos", test))]
fn jira_pointer_path(database_path: &Path) -> Result<std::path::PathBuf, String> {
    Ok(database_path
        .canonicalize()
        .map_err(|_| "mvp_sync_credentials_path_invalid")?
        .with_file_name("jira-import.keychain-slot"))
}

#[cfg(any(target_os = "macos", test))]
fn jira_account(database_path: &Path) -> Result<String, String> {
    let base = account(database_path)?;
    let pointer = jira_pointer_path(database_path)?;
    let metadata = match std::fs::symlink_metadata(&pointer) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(base),
        Err(_) => return Err("mvp_sync_credentials_unavailable".into()),
    };
    if !metadata.is_file() || metadata.len() != 36 {
        return Err("mvp_sync_credentials_invalid".into());
    }
    let generation =
        std::fs::read_to_string(pointer).map_err(|_| "mvp_sync_credentials_unavailable")?;
    let id = uuid::Uuid::parse_str(&generation).map_err(|_| "mvp_sync_credentials_invalid")?;
    if id.to_string() != generation {
        return Err("mvp_sync_credentials_invalid".into());
    }
    // A selected generation never falls back to an older credential, even
    // after disconnecting. The database path still isolates copied profiles.
    Ok(format!("{base}-jira-{generation}"))
}

fn selected_account(store: &Store, database_path: &Path) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    if store.service == JIRA.service {
        return jira_account(database_path);
    }
    let _ = store;
    account(database_path)
}

#[cfg(any(target_os = "macos", test))]
fn save_jira_generation(
    database_path: &Path,
    raw: &str,
    add: impl FnOnce(&str, &[u8]) -> Result<(), String>,
    read: impl FnOnce(&str) -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    use std::io::Write;
    let pointer = jira_pointer_path(database_path)?;
    jira_account(database_path)?;
    let generation = uuid::Uuid::new_v4().to_string();
    let slot = format!("{}-jira-{generation}", account(database_path)?);
    // An updated ad-hoc application may not own its predecessor's Keychain
    // item. Explicit replacement creates its own item without changing old ACLs.
    add(&slot, raw.as_bytes())?;
    if read(&slot)?.as_slice() != raw.as_bytes() {
        return Err("mvp_sync_credentials_verify_failed".into());
    }
    let parent = pointer
        .parent()
        .ok_or("mvp_sync_credentials_path_invalid")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "mvp_sync_credentials_write_failed")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "mvp_sync_credentials_write_failed")?;
    }
    temporary
        .write_all(generation.as_bytes())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "mvp_sync_credentials_write_failed")?;
    temporary
        .persist(pointer)
        .map_err(|_| "mvp_sync_credentials_write_failed")?;
    Ok(())
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
    let slot = selected_account(store, database_path)?;
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
        if store.service == JIRA.service {
            return save_jira_generation(
                database_path,
                raw,
                |new_slot, bytes| {
                    use core_foundation::data::CFData;
                    use security_framework::item::{
                        ItemAddOptions, ItemAddValue, ItemClass, Location,
                    };
                    let mut add = ItemAddOptions::new(ItemAddValue::Data {
                        class: ItemClass::generic_password(),
                        data: CFData::from_buffer(bytes),
                    });
                    add.set_service(store.service)
                        .set_account_name(new_slot)
                        .set_location(Location::DefaultFileKeychain);
                    add.add()
                        .map(|_| ())
                        .map_err(|_| "mvp_sync_credentials_write_failed".into())
                },
                |new_slot| {
                    security_framework::passwords::generic_password(read_options(store, new_slot))
                        .map_err(|_| "mvp_sync_credentials_verify_failed".into())
                },
            );
        }
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
    let slot = selected_account(store, database_path)?;
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

    fn jira_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("calendar.db");
        std::fs::write(&database, b"").unwrap();
        (directory, database)
    }

    #[test]
    fn jira_replacement_publishes_only_a_verified_new_slot() {
        use std::cell::RefCell;
        let (_directory, database) = jira_fixture();
        let original = account(&database).unwrap();
        assert_eq!(jira_account(&database).unwrap(), original);
        let added = RefCell::new(None);
        save_jira_generation(
            &database,
            "fictional-secret",
            |slot, bytes| {
                assert_ne!(
                    slot, original,
                    "the inaccessible original must not be modified"
                );
                assert_eq!(jira_account(&database).unwrap(), original);
                added.replace(Some((slot.to_owned(), bytes.to_vec())));
                Ok(())
            },
            |slot| {
                assert_eq!(
                    jira_account(&database).unwrap(),
                    original,
                    "readback precedes publication"
                );
                let record = added.borrow();
                let (key, bytes) = record.as_ref().unwrap();
                assert_eq!(slot, key);
                Ok(bytes.clone())
            },
        )
        .unwrap();
        let selected = jira_account(&database).unwrap();
        assert_eq!(selected, added.borrow().as_ref().unwrap().0);
        let pointer = jira_pointer_path(&database).unwrap();
        let metadata = std::fs::read_to_string(&pointer).unwrap();
        assert_eq!(metadata.len(), 36);
        assert!(!metadata.contains("fictional-secret"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&pointer).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        // Losing or deleting the selected Keychain item must not revive legacy.
        added.replace(None);
        assert_eq!(jira_account(&database).unwrap(), selected);
        let (_other_directory, other) = jira_fixture();
        std::fs::copy(&pointer, jira_pointer_path(&other).unwrap()).unwrap();
        assert_ne!(jira_account(&other).unwrap(), selected);
        #[cfg(target_os = "macos")]
        assert_eq!(selected_account(&RELAY, &database).unwrap(), original);
    }

    #[test]
    fn failed_jira_add_or_readback_preserves_the_previous_generation() {
        let (_directory, database) = jira_fixture();
        let pointer = jira_pointer_path(&database).unwrap();
        let previous = uuid::Uuid::new_v4().to_string();
        std::fs::write(&pointer, &previous).unwrap();
        let selected = jira_account(&database).unwrap();
        assert!(save_jira_generation(
            &database,
            "new-fictional-secret",
            |_, _| Err("mvp_sync_credentials_write_failed".into()),
            |_| panic!("failed add cannot be read or published")
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&pointer).unwrap(), previous);
        for value in [Ok(b"wrong-value".to_vec()), Err("unavailable".into())] {
            assert!(save_jira_generation(
                &database,
                "new-fictional-secret",
                |_, _| Ok(()),
                |_| value
            )
            .is_err());
            assert_eq!(std::fs::read_to_string(&pointer).unwrap(), previous);
            assert_eq!(jira_account(&database).unwrap(), selected);
        }
    }

    #[test]
    fn an_invalid_jira_pointer_cannot_fall_back_or_be_overwritten() {
        let (_directory, database) = jira_fixture();
        let pointer = jira_pointer_path(&database).unwrap();
        for contents in [
            "not-a-slot",
            "00000000000000000000000000000000000000",
            "../../a-private-file",
        ] {
            std::fs::write(&pointer, contents).unwrap();
            assert!(jira_account(&database).is_err());
            assert!(save_jira_generation(
                &database,
                "fictional-secret",
                |_, _| panic!("invalid pointer must fail before Keychain writes"),
                |_| unreachable!()
            )
            .is_err());
            assert_eq!(std::fs::read_to_string(&pointer).unwrap(), contents);
        }
        #[cfg(unix)]
        {
            let other = database.with_file_name("other-slot");
            std::fs::write(&other, uuid::Uuid::new_v4().to_string()).unwrap();
            std::fs::remove_file(&pointer).unwrap();
            std::os::unix::fs::symlink(&other, &pointer).unwrap();
            assert!(jira_account(&database).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_jira_pointer_publication_keeps_the_previous_selection() {
        use std::os::unix::fs::PermissionsExt;
        let (directory, database) = jira_fixture();
        let pointer = jira_pointer_path(&database).unwrap();
        let previous = uuid::Uuid::new_v4().to_string();
        std::fs::write(&pointer, &previous).unwrap();
        let permissions = std::fs::metadata(directory.path()).unwrap().permissions();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let bypasses_permissions = tempfile::NamedTempFile::new_in(directory.path()).is_ok();
        std::fs::set_permissions(directory.path(), permissions.clone()).unwrap();
        if bypasses_permissions {
            return;
        }
        let result = save_jira_generation(
            &database,
            "fictional-secret",
            |_, _| Ok(()),
            |_| {
                std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o500))
                    .unwrap();
                Ok(b"fictional-secret".to_vec())
            },
        );
        std::fs::set_permissions(directory.path(), permissions).unwrap();
        assert_eq!(result.unwrap_err(), "mvp_sync_credentials_write_failed");
        assert_eq!(std::fs::read_to_string(&pointer).unwrap(), previous);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "Creates and removes one fictional Keychain item for a temporary database"]
    fn mac_jira_generation_native_roundtrip() {
        let (_directory, database) = jira_fixture();
        assert_eq!(read_from(&JIRA, &database).unwrap(), None);
        write_to(&JIRA, &database, "fictional-native-credential").unwrap();
        let stored = read_from(&JIRA, &database);
        let selected = selected_account(&JIRA, &database).unwrap();
        let removed = delete_from(&JIRA, &database);
        assert_eq!(
            stored.unwrap().as_deref(),
            Some("fictional-native-credential")
        );
        removed.unwrap();
        assert_eq!(selected_account(&JIRA, &database).unwrap(), selected);
        assert_eq!(read_from(&JIRA, &database).unwrap(), None);
        assert_eq!(
            selected_account(&RELAY, &database).unwrap(),
            account(&database).unwrap()
        );
    }

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
