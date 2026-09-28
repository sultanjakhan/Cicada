use cicada_macos_vault::{authorize, reply, serve, Proof, Result};
use security_framework::os::macos::keychain::SecKeychain;
use serde::Deserialize;
use std::{ffi::c_void, path::Path, sync::OnceLock};

static KEYCHAIN: OnceLock<String> = OnceLock::new();

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    proof: Proof,
    mode: String,
}

unsafe fn handle(message: *mut c_void, bytes: &[u8], hello: bool) -> Result<bool> {
    if hello {
        let proof: Proof = serde_json::from_slice(bytes).map_err(|_| "fixture_proof")?;
        authorize(message, &proof, env!("CICADA_SYNTHETIC_PUBLIC_KEY"))?;
        return Ok(true);
    }
    let request: Request = serde_json::from_slice(bytes).map_err(|_| "fixture_request")?;
    authorize(message, &request.proof, env!("CICADA_SYNTHETIC_PUBLIC_KEY"))?;
    let _no_ui = SecKeychain::disable_user_interaction().map_err(|_| "fixture_ui")?;
    let keychain = SecKeychain::open(KEYCHAIN.get().ok_or("fixture_keychain")?)
        .map_err(|_| "fixture_keychain")?;
    use cicada_macos_vault::storage::{
        execute_in, Operation, Request as StoreRequest, Response, Slot,
    };
    if request.mode == "slow-write" {
        std::thread::sleep(std::time::Duration::from_secs(6));
    }
    for slot in [Slot::Jira, Slot::Relay] {
        let operation = match request.mode.as_str() {
            "write" | "slow-write" => Operation::Write {
                value: "fictional-credential-for-update-test".into(),
            },
            "disconnect" => Operation::Disconnect,
            "read" | "disconnected" => Operation::Read,
            "import" => Operation::ImportIfMissing {
                value: "fictional-credential-for-update-test".into(),
            },
            "stale-import" | "stale-import-disconnected" => Operation::ImportIfMissing {
                value: "obsolete-fictional-credential".into(),
            },
            _ => return Err("fixture_operation"),
        };
        let store = StoreRequest {
            proof: Proof {
                manifest: String::new(),
                signature: String::new(),
            },
            slot,
            account: format!("device-v1-{}", "a".repeat(64)),
            operation,
        };
        let result = execute_in(&store, &keychain)?;
        let matches = match result {
            Response::Saved => {
                matches!(request.mode.as_str(), "write" | "slow-write" | "disconnect")
            }
            Response::Present { value } => {
                matches!(request.mode.as_str(), "read" | "import" | "stale-import")
                    && value == "fictional-credential-for-update-test"
            }
            Response::Disconnected => matches!(
                request.mode.as_str(),
                "disconnected" | "stale-import-disconnected"
            ),
            _ => false,
        };
        if !matches {
            return Ok(false);
        }
    }
    Ok(true)
}

unsafe extern "C" fn callback(
    message: *mut c_void,
    bytes: *const u8,
    length: usize,
    hello: bool,
    output: *mut u8,
    capacity: usize,
) -> usize {
    let result = std::panic::catch_unwind(|| {
        handle(message, std::slice::from_raw_parts(bytes, length), hello)
    });
    match result {
        Ok(Ok(value)) => reply(&value, output, capacity),
        _ => 0,
    }
}

fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    std::hint::black_box(env!("CICADA_SYNTHETIC_VAULT_VERSION"));
    if args.len() != 3
        || !args[1].starts_with("app.cicada.vault.synthetic.")
        || !args[2].contains("/cicada-keychain-upgrade-")
        || Path::new(&args[2])
            .file_name()
            .is_none_or(|name| name != "fixture.keychain-db")
    {
        return Err("fixture_arguments");
    }
    KEYCHAIN
        .set(args[2].clone())
        .map_err(|_| "fixture_keychain")?;
    unsafe { serve(&args[1], callback) }
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 4 && args[1] == "--check-client" {
        std::process::exit(
            if cicada_macos_vault::verify_file(std::path::Path::new(&args[2]), &args[3]).is_ok() {
                0
            } else {
                1
            },
        );
    }
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
