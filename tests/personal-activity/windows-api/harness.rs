//! API-only cross-target check: compiles the actual source without linking an app
//! or compiling bundled SQLite. It does not establish Windows runtime behavior.
#![cfg(windows)]
#![allow(dead_code)]
const IDLE_LIMIT_MS: u64 = 60_000;
struct Sample {
    utc_ms: i64,
    tick_ms: u64,
    awake_ms: u64,
    continuity: u64,
    executable: Option<String>,
    idle_ms: u64,
    unlocked: bool,
}
#[path = "../../../src-tauri/src/personal_activity_windows.rs"]
mod source;
