use cicada_macos_vault::{
    authorize, reply, serve,
    storage::{execute, Request, Response},
    Proof, PUBLIC_KEY, SERVICE,
};
use std::ffi::c_void;

unsafe extern "C" fn handle(
    message: *mut c_void,
    bytes: *const u8,
    length: usize,
    hello: bool,
    output: *mut u8,
    capacity: usize,
) -> usize {
    // No panic may cross the C callback boundary, and denied requests produce
    // neither a Keychain operation nor credential-bearing diagnostics.
    std::panic::catch_unwind(|| {
        let bytes = std::slice::from_raw_parts(bytes, length);
        if hello {
            let Ok(proof) = serde_json::from_slice::<Proof>(bytes) else {
                return 0;
            };
            if authorize(message, &proof, PUBLIC_KEY).is_err() {
                return 0;
            }
            return reply(&true, output, capacity);
        }
        let Ok(request) = serde_json::from_slice::<Request>(bytes) else {
            return 0;
        };
        if authorize(message, &request.proof, PUBLIC_KEY).is_err() {
            return 0;
        }
        let response = execute(&request).unwrap_or(Response::Unavailable);
        reply(&response, output, capacity)
    })
    .unwrap_or(0)
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
    if args.len() != 1 {
        std::process::exit(1);
    }
    if unsafe { serve(SERVICE, handle) }.is_err() {
        std::process::exit(1);
    }
}
