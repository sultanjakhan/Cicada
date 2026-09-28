use cicada_macos_vault::{request, Proof, Result};
use serde::Serialize;

#[derive(Serialize)]
struct Request {
    proof: Proof,
    mode: String,
}

fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4 {
        return Err("fixture_arguments");
    }
    std::hint::black_box(env!("CICADA_SYNTHETIC_CLIENT_VERSION"));
    let proof = std::fs::read(&args[2]).map_err(|_| "fixture_proof")?;
    let request_body = Request {
        proof: serde_json::from_slice(&proof).map_err(|_| "fixture_proof")?,
        mode: args[3].clone(),
    };
    let body = serde_json::to_vec(&request_body).map_err(|_| "fixture_request")?;
    let response = request(
        &args[1],
        env!("CICADA_SYNTHETIC_HELPER_CDHASH"),
        &request_body.proof,
        &body,
    )?;
    if response == b"true" {
        Ok(())
    } else {
        Err("fixture_mismatch")
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
