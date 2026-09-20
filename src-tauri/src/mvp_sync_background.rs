//! One bounded exchange without a Tauri Activity, renderer or application startup.
//! Codes are the JNI contract with HanniContentSyncWorker; no raw errors cross it.
use super::{open_existing, schedule, secrets, transport, RelayConfig};
use serde_json::Value;
use std::path::Path;

const SUCCESS: i32 = 0;
const RETRY: i32 = 1;
const SKIP: i32 = 2;
const BUSY: i32 = 3;
const FAILURE: i32 = 4;

fn classify(result: Result<String, String>) -> i32 {
    match result {
        Err(error) if error == "content_sync_already_running" => BUSY,
        Err(_) => RETRY,
        Ok(raw) => {
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                return FAILURE;
            };
            if value["enabled"] == false {
                return SKIP;
            }
            if value["enabled"] != true || value["error_code"].as_str().is_none() {
                return FAILURE;
            }
            if value["error_code"] != "none"
                || value["more_pending"] == true
                || value["pull_more"] == true
                || value["retry_after_secs"].as_u64().unwrap_or(0) > 0
            {
                RETRY
            } else {
                SUCCESS
            }
        }
    }
}

fn run_with(
    path: &Path,
    read_config: impl FnOnce(&Path) -> Result<Option<String>, String>,
    exchange: impl FnOnce(&str, &str) -> Result<String, String>,
) -> i32 {
    if !path.is_file() {
        return SKIP;
    }
    let Some(path_str) = path.to_str() else {
        return FAILURE;
    };
    let Ok(conn) = open_existing(path_str) else {
        return RETRY;
    };
    match schedule::read(&conn) {
        Ok(state) if !state.enabled => return SKIP,
        Err(_) => return RETRY,
        _ => {}
    }
    // Release this connection before transport takes its own lease/transactions.
    drop(conn);
    let raw = match read_config(path) {
        Ok(Some(raw)) => raw,
        Ok(None) => return SKIP,
        Err(_) => return FAILURE,
    };
    if RelayConfig::parse(&raw).is_err() {
        return FAILURE;
    }
    // The transport rechecks the DB feature flag and uses the same OS lease as
    // foreground sync. A stale `enabled` value in the credential file is ignored.
    classify(exchange(path_str, &raw))
}

fn run(path: &Path) -> i32 {
    run_with(path, secrets::read, transport::run_headless_once)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_hanni_mvp_android_installer_ContentSyncNative_runNative(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    database_path: jni::objects::JString,
) -> jni::sys::jint {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let Ok(path) = env.get_string(&database_path) else {
            return FAILURE;
        };
        let path: String = path.into();
        run(Path::new(&path))
    }))
    .unwrap_or(FAILURE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
    use serde_json::json;

    fn fixture(enabled: bool) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("calendar.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        crate::init_schema(&conn).unwrap();
        super::super::enabled(&conn, enabled).unwrap();
        (dir, path)
    }
    fn config() -> String {
        json!({"v":1,"profile":"hanni-mvp-content-v1","endpoint":"https://example.invalid/",
            "device_id":"synthetic","key_id":"test","token":B64.encode([1;32]),
            "key":B64.encode([2;32]),"enabled":false})
        .to_string()
    }
    #[test]
    fn closed_worker_does_not_create_a_profile_or_access_disabled_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.db");
        assert_eq!(run(&missing), SKIP);
        assert!(!missing.exists());
        let (_dir, path) = fixture(false);
        assert_eq!(
            run_with(
                &path,
                |_| panic!("disabled credentials"),
                |_, _| panic!("disabled network")
            ),
            SKIP
        );
    }
    #[test]
    fn missing_or_invalid_credentials_never_reach_network() {
        let (_dir, path) = fixture(true);
        assert_eq!(
            run_with(&path, |_| Ok(None), |_, _| panic!("unpaired network")),
            SKIP
        );
        assert_eq!(
            run_with(
                &path,
                |_| Ok(Some("invalid".into())),
                |_, _| panic!("invalid network")
            ),
            FAILURE
        );
    }
    #[test]
    fn persisted_enabled_flag_controls_reenabled_worker() {
        let (_dir, path) = fixture(true);
        let raw = config();
        assert_eq!(
            run_with(
                &path,
                |_| Ok(Some(raw.clone())),
                |db, cfg| {
                    assert_eq!(Path::new(db), path);
                    assert_eq!(cfg, raw);
                    Ok(json!({"enabled":true,"error_code":"none","more_pending":false,"retry_after_secs":0}).to_string())
                }
            ),
            SUCCESS
        );
    }
    #[test]
    fn worker_respects_foreground_transport_lease() {
        let (_dir, path) = fixture(true);
        let lease = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path.with_extension("content-sync.lock"))
            .unwrap();
        lease.try_lock().unwrap();
        assert_eq!(
            run_with(&path, |_| Ok(Some(config())), transport::run_headless_once),
            BUSY
        );
    }
    #[test]
    fn pending_backoff_and_errors_are_not_success() {
        for field in [
            json!({"more_pending":true}),
            json!({"pull_more":true}),
            json!({"retry_after_secs":60}),
            json!({"error_code":"content_sync_network"}),
        ] {
            let mut value = json!({"enabled":true,"error_code":"none"});
            for (key, v) in field.as_object().unwrap() {
                value[key] = v.clone();
            }
            assert_eq!(classify(Ok(value.to_string())), RETRY);
        }
        assert_eq!(classify(Err("network unavailable".into())), RETRY);
        assert_eq!(classify(Ok("{}".into())), FAILURE);
        assert_eq!(classify(Ok("invalid".into())), FAILURE);
        assert_eq!(classify(Ok("{\"enabled\":false}".into())), SKIP);
    }
}
