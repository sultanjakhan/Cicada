//! Adapted from Hanni's no-prompt Keychain reads and user-bound DPAPI storage.
//! Database-path scoping keeps independently launched MVP profiles unpaired.
use sha2::{Digest, Sha256};
use std::path::Path;

const SERVICE: &str = "app.hanni.mvp.relay";
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

#[cfg(target_os = "macos")]
fn read_options(account: &str) -> security_framework::passwords::PasswordOptions {
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
    let mut options = PasswordOptions::new_generic_password(SERVICE, account);
    // The upstream API has no per-query setter; these retained Security
    // constants forbid background prompts without changing process-wide policy.
    #[allow(deprecated)]
    unsafe {
        options.query.push((
            CFString::wrap_under_get_rule(kSecUseAuthenticationUI),
            CFString::wrap_under_get_rule(kSecUseAuthenticationUIFail).into_CFType(),
        ));
    }
    options
}

pub(crate) fn read(database_path: &Path) -> Result<Option<String>, String> {
    let slot = account(database_path)?;
    #[cfg(target_os = "macos")]
    let bytes = match security_framework::passwords::generic_password(read_options(&slot)) {
        Ok(bytes) => bytes,
        Err(error) if error.code() == -25300 => return Ok(None),
        Err(_) => return Err("mvp_sync_credentials_unavailable".into()),
    };
    #[cfg(any(windows, target_os = "android"))]
    let bytes = {
        let Some(stored) = read_file(database_path)? else {
            return Ok(None);
        };
        #[cfg(windows)]
        let stored = dpapi_unprotect(&stored, format!("{SERVICE}:{slot}").as_bytes())?;
        #[cfg(target_os = "android")]
        let _ = slot;
        stored
    };
    #[cfg(not(any(windows, target_os = "macos", target_os = "android")))]
    {
        let _ = slot;
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

/// Only an explicit configuration save may request OS authorization.
pub(crate) fn read_authorized(database_path: &Path) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        use security_framework::passwords::{generic_password, PasswordOptions};
        let slot = account(database_path)?;
        let bytes = match generic_password(PasswordOptions::new_generic_password(SERVICE, &slot)) {
            Ok(bytes) => bytes,
            Err(error) if error.code() == -25300 => return Ok(None),
            Err(_) => return Err("mvp_sync_credentials_unavailable".into()),
        };
        if bytes.len() > LIMIT {
            return Err("mvp_sync_credentials_invalid".into());
        }
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "mvp_sync_credentials_invalid".into())
    }
    #[cfg(not(target_os = "macos"))]
    read(database_path)
}

pub(crate) fn write(database_path: &Path, raw: &str) -> Result<(), String> {
    if raw.len() > LIMIT {
        return Err("mvp_sync_credentials_invalid".into());
    }
    let slot = account(database_path)?;
    #[cfg(target_os = "macos")]
    {
        security_framework::passwords::set_generic_password(SERVICE, &slot, raw.as_bytes())
            .map_err(|_| "mvp_sync_credentials_write_failed")?;
        if read(database_path)?.as_deref() != Some(raw) {
            return Err("mvp_sync_credentials_verify_failed".into());
        }
        Ok(())
    }
    #[cfg(any(windows, target_os = "android"))]
    {
        #[cfg(windows)]
        let stored = {
            let entropy = format!("{SERVICE}:{slot}");
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
        write_file(database_path, &stored)
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "android")))]
    {
        let _ = slot;
        Err("mvp_sync_platform_unsupported".into())
    }
}

#[cfg(any(windows, target_os = "android"))]
fn credential_path(database_path: &Path) -> Result<std::path::PathBuf, String> {
    Ok(database_path
        .canonicalize()
        .map_err(|_| "mvp_sync_credentials_path_invalid")?
        .with_file_name("mvp-sync.credentials"))
}

#[cfg(any(windows, target_os = "android"))]
fn read_file(database_path: &Path) -> Result<Option<Vec<u8>>, String> {
    let path = credential_path(database_path)?;
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
fn write_file(database_path: &Path, stored: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let path = credential_path(database_path)?;
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
