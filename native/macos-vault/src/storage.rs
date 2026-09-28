use crate::{Proof, Result};
use security_framework::os::macos::keychain::SecKeychain;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Slot {
    Jira,
    Relay,
}

impl Slot {
    fn service(self) -> &'static str {
        match self {
            Self::Jira => "app.hanni.mvp.vault.v1.jira",
            Self::Relay => "app.hanni.mvp.vault.v1.relay",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Read,
    Write { value: String },
    ImportIfMissing { value: String },
    Disconnect,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub proof: Proof,
    pub slot: Slot,
    pub account: String,
    pub operation: Operation,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum Response {
    Missing,
    Disconnected,
    Present { value: String },
    Saved,
    Unavailable,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    value: Option<String>,
}

fn validate_account(account: &str) -> Result<()> {
    let digest = account
        .strip_prefix("device-v1-")
        .ok_or("vault_account_invalid")?;
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("vault_account_invalid");
    }
    Ok(())
}

/// Called only after the exact XPC message has passed release and peer checks.
/// Keys are restricted to Cicada's two dedicated services, never caller-supplied.
pub fn execute(request: &Request) -> Result<Response> {
    execute_in(
        request,
        &SecKeychain::default().map_err(|_| "vault_unavailable")?,
    )
}

/// Explicit keychain selection permits isolated acceptance with synthetic data.
pub fn execute_in(request: &Request, keychain: &SecKeychain) -> Result<Response> {
    validate_account(&request.account)?;
    let _no_ui = SecKeychain::disable_user_interaction().map_err(|_| "vault_unavailable")?;
    match &request.operation {
        Operation::Read => {
            let bytes = match keychain
                .find_generic_password(request.slot.service(), &request.account)
                .map(|(value, _)| value.as_ref().to_vec())
            {
                Ok(bytes) => bytes,
                Err(error) if error.code() == -25300 => return Ok(Response::Missing),
                Err(_) => return Err("vault_unavailable"),
            };
            if bytes.len() > 24_576 {
                return Err("vault_record_invalid");
            }
            let record: Record =
                serde_json::from_slice(&bytes).map_err(|_| "vault_record_invalid")?;
            match record.value {
                Some(value) if value.len() <= 4096 => Ok(Response::Present { value }),
                None => Ok(Response::Disconnected),
                _ => Err("vault_record_invalid"),
            }
        }
        Operation::Write { value } | Operation::ImportIfMissing { value } if value.len() > 4096 => {
            Err("vault_record_invalid")
        }
        Operation::ImportIfMissing { value } => {
            let mut current = Request {
                proof: Proof {
                    manifest: String::new(),
                    signature: String::new(),
                },
                slot: request.slot,
                account: request.account.clone(),
                operation: Operation::Read,
            };
            match execute_in(&current, keychain)? {
                Response::Missing => {
                    current.operation = Operation::Write {
                        value: value.clone(),
                    };
                    execute_in(&current, keychain)?;
                    Ok(Response::Present {
                        value: value.clone(),
                    })
                }
                existing => Ok(existing),
            }
        }
        operation => {
            let value = match operation {
                Operation::Write { value } => Some(value.clone()),
                Operation::Disconnect => None,
                Operation::Read => unreachable!(),
                Operation::ImportIfMissing { .. } => unreachable!(),
            };
            // A tombstone prevents a disconnected profile from reimporting an
            // older Keychain item. Repeating the same write is safe after timeout.
            let bytes =
                serde_json::to_vec(&Record { value }).map_err(|_| "vault_record_invalid")?;
            keychain
                .set_generic_password(request.slot.service(), &request.account, &bytes)
                .map_err(|_| "vault_write_failed")?;
            if keychain
                .find_generic_password(request.slot.service(), &request.account)
                .map(|(value, _)| value.as_ref().to_vec())
                .map_err(|_| "vault_verify_failed")?
                != bytes
            {
                return Err("vault_verify_failed");
            }
            Ok(Response::Saved)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_profile_digest_accounts_are_accepted() {
        assert!(validate_account(&format!("device-v1-{}", "a".repeat(64))).is_ok());
        for value in ["", "login", "device-v1-../other", "device-v1-abcd"] {
            assert!(validate_account(value).is_err());
        }
    }
    #[test]
    fn requests_cannot_select_another_keychain_service() {
        assert!(serde_json::from_str::<Slot>("\"other.service\"").is_err());
    }
}
