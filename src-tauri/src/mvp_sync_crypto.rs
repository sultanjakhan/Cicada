//! XChaCha20-Poly1305 seal/open reused from Hanni sync_crypto.rs.
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;

const NONCE_LEN: usize = 24;

/// Seal `plaintext` with the shared device key. `aad` binds the ciphertext to
/// its slot (we pass the repo-relative file path). Output layout:
/// `nonce(24) || ciphertext || tag(16)`.
pub fn seal(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "sync_crypto: bad key length".to_string())?;
    let mut nonce = [0u8; NONCE_LEN];
    rand::rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "sync_crypto: encrypt failed".to_string())?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Reverse of [`seal`]. `aad` must equal what was used to seal (the file path),
/// or AEAD verification fails. Returns the plaintext bytes.
pub fn open(key: &[u8; 32], aad: &[u8], blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < NONCE_LEN {
        return Err("sync_crypto: blob too short".to_string());
    }
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "sync_crypto: bad key length".to_string())?;
    cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad })
        .map_err(|_| "sync_crypto: decrypt/verify failed".to_string())
}
