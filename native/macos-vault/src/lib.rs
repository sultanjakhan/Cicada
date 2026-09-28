//! Local credential transport. Neither socket paths nor process IDs grant access.
#![cfg(target_os = "macos")]

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{c_char, c_void, CString},
    ptr,
};

pub type Result<T> = std::result::Result<T, &'static str>;
const FRAME_LIMIT: usize = 16_384;
pub const SERVICE: &str = "app.hanni.mvp.vault.v1";
pub const PUBLIC_KEY: &str = include_str!("../../../src-tauri/update-public-key.txt");
pub mod storage;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attestation {
    pub purpose: String,
    pub protocol: u32,
    pub cdhash: String,
    pub application: String,
    pub architecture: String,
    pub version: String,
    pub helper_cdhash: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Proof {
    pub manifest: String,
    pub signature: String,
}

impl Proof {
    pub fn verify(&self, public_key: &str) -> Result<Attestation> {
        let decode = |value: &str| {
            let bytes = STANDARD
                .decode(value.trim())
                .map_err(|_| "vault_signature_invalid")?;
            String::from_utf8(bytes).map_err(|_| "vault_signature_invalid")
        };
        let key = minisign_verify::PublicKey::decode(&decode(public_key)?)
            .map_err(|_| "vault_signature_invalid")?;
        let signature = minisign_verify::Signature::decode(&decode(&self.signature)?)
            .map_err(|_| "vault_signature_invalid")?;
        key.verify(self.manifest.as_bytes(), &signature, false)
            .map_err(|_| "vault_signature_invalid")?;
        let attestation: Attestation =
            serde_json::from_str(&self.manifest).map_err(|_| "vault_attestation_invalid")?;
        if attestation.purpose != "cicada-vault-client"
            || attestation.protocol != 1
            || attestation.application != "app.hanni.mvp"
            || attestation.architecture != "aarch64"
        {
            return Err("vault_attestation_invalid");
        }
        requirement(&attestation.cdhash)?;
        requirement(&attestation.helper_cdhash)?;
        if attestation.version.is_empty() || attestation.version.len() > 64 {
            return Err("vault_attestation_invalid");
        }
        Ok(attestation)
    }
}

fn requirement(cdhash: &str) -> Result<CString> {
    if cdhash.len() != 40 || !cdhash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("vault_identity_invalid");
    }
    CString::new(format!("cdhash H\"{cdhash}\"")).map_err(|_| "vault_identity_invalid")
}

extern "C" {
    fn vault_file_authorized(path: *const c_char, requirement: *const c_char) -> i32;
    fn vault_self_cdhash(output: *mut u8, capacity: usize) -> i32;
    fn vault_message_authorized(message: *mut c_void, requirement: *const c_char) -> i32;
    fn vault_client_request(
        service: *const c_char,
        requirement: *const c_char,
        proof: *const u8,
        proof_len: usize,
        request: *const u8,
        request_len: usize,
        output: *mut u8,
        capacity: usize,
        length: *mut usize,
    ) -> i32;
    fn vault_serve(
        service: *const c_char,
        callback: unsafe extern "C" fn(
            *mut c_void,
            *const u8,
            usize,
            bool,
            *mut u8,
            usize,
        ) -> usize,
    ) -> i32;
}

pub fn verify_file(path: &std::path::Path, cdhash: &str) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| "vault_identity_invalid")?;
    let requirement = requirement(cdhash)?;
    if unsafe { vault_file_authorized(path.as_ptr(), requirement.as_ptr()) } != 0 {
        return Err("vault_peer_denied");
    }
    Ok(())
}

pub fn self_cdhash() -> Result<String> {
    let mut output = [0u8; 41];
    if unsafe { vault_self_cdhash(output.as_mut_ptr(), output.len()) } != 0 {
        return Err("vault_identity_invalid");
    }
    String::from_utf8(output[..40].to_vec()).map_err(|_| "vault_identity_invalid")
}

/// `message` must be a live XPC message provided by the transport callback.
/// Authentication uses the kernel audit token attached to this exact message.
///
/// # Safety
/// The caller must retain the XPC message for the duration of the call.
pub unsafe fn authorize(message: *mut c_void, proof: &Proof, public_key: &str) -> Result<()> {
    let attestation = proof.verify(public_key)?;
    if attestation.helper_cdhash != self_cdhash()? {
        return Err("vault_peer_denied");
    }
    let requirement = requirement(&attestation.cdhash)?;
    if vault_message_authorized(message, requirement.as_ptr()) != 0 {
        return Err("vault_peer_denied");
    }
    Ok(())
}

pub fn request(service: &str, helper_cdhash: &str, proof: &Proof, body: &[u8]) -> Result<Vec<u8>> {
    let service = CString::new(service).map_err(|_| "vault_identity_invalid")?;
    let requirement = requirement(helper_cdhash)?;
    let proof = serde_json::to_vec(proof).map_err(|_| "vault_request_invalid")?;
    if proof.len() > FRAME_LIMIT || body.len() > FRAME_LIMIT {
        return Err("vault_request_invalid");
    }
    let mut output = vec![0u8; FRAME_LIMIT];
    let mut length = 0;
    let status = unsafe {
        vault_client_request(
            service.as_ptr(),
            requirement.as_ptr(),
            proof.as_ptr(),
            proof.len(),
            body.as_ptr(),
            body.len(),
            output.as_mut_ptr(),
            output.len(),
            &mut length,
        )
    };
    if status != 0 || length > output.len() {
        return Err("vault_transport_denied");
    }
    output.truncate(length);
    Ok(output)
}

/// # Safety
/// The callback must never unwind, and may write at most `capacity` bytes to
/// `output`. A zero return rejects the message. Hello receives only a Proof.
pub unsafe fn serve(
    service: &str,
    callback: unsafe extern "C" fn(*mut c_void, *const u8, usize, bool, *mut u8, usize) -> usize,
) -> Result<()> {
    let service = CString::new(service).map_err(|_| "vault_identity_invalid")?;
    if vault_serve(service.as_ptr(), callback) != 0 {
        return Err("vault_transport_failed");
    }
    Ok(())
}

/// # Safety
/// Destination must be writable for `capacity` bytes.
pub unsafe fn reply<T: Serialize>(value: &T, output: *mut u8, capacity: usize) -> usize {
    let Ok(bytes) = serde_json::to_vec(value) else {
        return 0;
    };
    if bytes.len() > capacity {
        return 0;
    }
    ptr::copy_nonoverlapping(bytes.as_ptr(), output, bytes.len());
    bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_hash_cannot_inject_a_weaker_requirement() {
        assert!(requirement("a\" or true").is_err());
        assert!(requirement(&"a".repeat(40)).is_ok());
    }
    #[test]
    fn unsigned_manifest_is_denied() {
        let proof = Proof {
            manifest: "{}".into(),
            signature: "invalid".into(),
        };
        assert!(proof.verify("invalid").is_err());
    }
}
