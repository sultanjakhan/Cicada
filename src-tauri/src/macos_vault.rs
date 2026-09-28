//! Main application adapter. Only the separate, pinned helper owns new secrets.
use cicada_macos_vault::{
    storage::{Operation, Request, Response, Slot},
    Proof, PUBLIC_KEY, SERVICE,
};
use std::{io::Read, path::Path};

pub(crate) fn enabled() -> bool {
    option_env!("CICADA_VAULT_CDHASH").is_some()
}

pub(crate) fn helper_cdhash() -> Option<&'static str> {
    option_env!("CICADA_VAULT_CDHASH")
}

pub(crate) fn proof(database_path: &Path) -> Result<Proof, String> {
    let hash = cicada_macos_vault::self_cdhash().map_err(|_| "mvp_sync_credentials_unavailable")?;
    let directory = database_path
        .parent()
        .ok_or("mvp_sync_credentials_unavailable")?;
    let file = directory.join("vault/proofs").join(format!("{hash}.json"));
    let mut bytes = Vec::new();
    std::fs::File::open(file)
        .and_then(|file| file.take(16_385).read_to_end(&mut bytes))
        .map_err(|_| "mvp_sync_credentials_unavailable")?;
    if bytes.len() > 16_384 {
        return Err("mvp_sync_credentials_unavailable".into());
    }
    let proof: Proof =
        serde_json::from_slice(&bytes).map_err(|_| "mvp_sync_credentials_unavailable")?;
    let identity = proof
        .verify(PUBLIC_KEY)
        .map_err(|_| "mvp_sync_credentials_unavailable")?;
    if identity.cdhash != hash || Some(identity.helper_cdhash.as_str()) != helper_cdhash() {
        return Err("mvp_sync_credentials_unavailable".into());
    }
    Ok(proof)
}

pub(crate) fn call(
    database_path: &Path,
    service: &str,
    account: String,
    operation: Operation,
) -> Result<Response, String> {
    let slot = match service {
        "app.hanni.mvp.jira" => Slot::Jira,
        "app.hanni.mvp.relay" => Slot::Relay,
        _ => return Err("mvp_sync_credentials_invalid".into()),
    };
    let hash = option_env!("CICADA_VAULT_CDHASH").ok_or("mvp_sync_credentials_unavailable")?;
    let request = Request {
        proof: proof(database_path)?,
        slot,
        account,
        operation,
    };
    let body = serde_json::to_vec(&request).map_err(|_| "mvp_sync_credentials_invalid")?;
    let bytes = cicada_macos_vault::request(SERVICE, hash, &request.proof, &body)
        .map_err(|_| "mvp_sync_credentials_unavailable")?;
    match serde_json::from_slice(&bytes).map_err(|_| "mvp_sync_credentials_invalid")? {
        Response::Unavailable => Err("mvp_sync_credentials_unavailable".into()),
        response => Ok(response),
    }
}

pub(crate) fn save(
    database_path: &Path,
    service: &str,
    account: String,
    raw: &str,
) -> Result<(), String> {
    match call(
        database_path,
        service,
        account,
        Operation::Write { value: raw.into() },
    )? {
        Response::Saved => Ok(()),
        _ => Err("mvp_sync_credentials_verify_failed".into()),
    }
}
