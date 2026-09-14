//! MVP runtime around the existing Hanni encrypted content transport.
use crate::mvp_sync_db::{self as db, sql};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use futures_util::{SinkExt, StreamExt};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, protocol::WebSocketConfig, Message,
};
#[path = "mvp_sync_schedule.rs"]
mod schedule;
#[path = "mvp_sync_secrets.rs"]
mod secrets;
#[path = "mvp_sync_transport.rs"]
mod transport;

const PROFILE: &str = "hanni-mvp-content-v1";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RelayConfig {
    v: u8,
    profile: String,
    endpoint: String,
    device_id: String,
    key_id: String,
    token: String,
    key: String,
    enabled: bool,
}
fn opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'_' || v == b'-')
}
fn decode(value: &str, length: usize) -> Result<Vec<u8>, String> {
    let bytes = B64.decode(value).map_err(|_| "mvp_sync_invalid_config")?;
    if bytes.len() != length || B64.encode(&bytes) != value {
        return Err("mvp_sync_invalid_config".into());
    }
    Ok(bytes)
}
impl RelayConfig {
    fn parse(raw: &str) -> Result<Self, String> {
        if raw.len() > 4096 {
            return Err("mvp_sync_invalid_config".into());
        }
        let cfg: Self = serde_json::from_str(raw).map_err(|_| "mvp_sync_invalid_config")?;
        let url = reqwest::Url::parse(&cfg.endpoint).map_err(|_| "mvp_sync_invalid_config")?;
        let secure = url.scheme() == "https";
        #[cfg(test)]
        let secure = secure || (url.scheme() == "http" && url.host_str() == Some("127.0.0.1"));
        if cfg.v != 1
            || cfg.profile != PROFILE
            || !secure
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || !opaque_id(&cfg.device_id)
            || !opaque_id(&cfg.key_id)
        {
            return Err("mvp_sync_invalid_config".into());
        }
        decode(&cfg.token, 32)?;
        decode(&cfg.key, 32)?;
        Ok(cfg)
    }
    fn same_scope(&self, other: &Self) -> bool {
        self.endpoint.trim_end_matches('/') == other.endpoint.trim_end_matches('/')
            && self.device_id == other.device_id
            && self.key_id == other.key_id
            && self.key == other.key
    }
}
fn encrypt_bytes(key: &[u8; 32], aad: &[u8], plain: &[u8]) -> Result<Vec<u8>, String> {
    crate::mvp_sync_crypto::seal(key, aad, plain)
}
fn decrypt_bytes(key: &[u8; 32], aad: &[u8], blob: &[u8]) -> Result<Vec<u8>, String> {
    crate::mvp_sync_crypto::open(key, aad, blob)
}
fn open_existing(path: &str) -> Result<Connection, String> {
    let conn = sql(Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
    ))?;
    sql(conn.busy_timeout(Duration::from_secs(5)))?;
    sql(conn.pragma_update(None, "foreign_keys", "ON"))?;
    Ok(conn)
}
struct Runtime {
    path: PathBuf,
    config: Mutex<Option<Option<RelayConfig>>>,
    configuration: Mutex<()>,
    signal: Arc<tokio::sync::Notify>,
    running: AtomicBool,
    pull_more: AtomicBool,
    last_error: Mutex<Option<String>>,
}
impl Runtime {
    fn config(&self) -> Result<Option<RelayConfig>, String> {
        let mut cache = self
            .config
            .lock()
            .map_err(|_| "mvp_sync_configuration_busy")?;
        if let Some(value) = cache.as_ref() {
            return Ok(value.clone());
        }
        let raw = secrets::read(&self.path)?;
        let cfg = raw.as_deref().map(RelayConfig::parse).transpose()?;
        *cache = Some(cfg.clone());
        Ok(cfg)
    }
}
fn status(conn: &Connection, runtime: &Runtime) -> Result<Value, String> {
    let native = transport::database_status(conn)?;
    let configured = match runtime.config() {
        Ok(value) => value.is_some(),
        Err(error) => {
            *runtime
                .last_error
                .lock()
                .map_err(|_| "mvp_sync_status_failed")? = Some(error);
            false
        }
    };
    let last_success: Option<String> = sql(conn.query_row(
        "SELECT last_success FROM mvp_sync_meta WHERE id=1",
        [],
        |r| r.get(0),
    ))?;
    let conflicts: i64 =
        sql(conn.query_row("SELECT COUNT(*) FROM mvp_sync_conflicts", [], |r| r.get(0)))?;
    let error = runtime
        .last_error
        .lock()
        .map_err(|_| "mvp_sync_status_failed")?
        .clone()
        .or_else(|| {
            native["error_code"]
                .as_str()
                .filter(|v| *v != "none")
                .map(str::to_owned)
        });
    Ok(
        json!({"configured":configured,"enabled":native["enabled"],"pending":native["pending_keys"].as_i64().unwrap_or(0),"conflicts":native["conflict_count"].as_i64().unwrap_or(0)+conflicts,"last_success":last_success,"last_error":error,"running":runtime.running.load(Ordering::SeqCst),"pull_more":runtime.pull_more.load(Ordering::SeqCst),"revision":native["revision"].as_str().unwrap_or("0")}),
    )
}
#[tauri::command]
pub(crate) async fn mvp_sync_status(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<Arc<Runtime>>();
        let conn = open_existing(runtime.path.to_str().ok_or("mvp_sync_database_path")?)?;
        status(&conn, &runtime)
    })
    .await
    .map_err(|_| "mvp_sync_status_failed".to_string())?
}
fn enabled(conn: &Connection, value: bool) -> Result<(), String> {
    sql(conn.execute("INSERT INTO app_settings(key,value,updated_at) VALUES('content_sync_enabled',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",params![if value{"true"}else{"false"},chrono::Utc::now().to_rfc3339()]))?;
    Ok(())
}
fn backup_before_enable(conn: &Connection, runtime: &Runtime, value: bool) -> Result<(), String> {
    if value && db::get_setting_checked(conn, "content_sync_enabled")?.as_deref() != Some("true") {
        crate::backup(conn, runtime.path.parent().ok_or("mvp_sync_database_path")?)
            .map_err(|_| "mvp_sync_backup_failed")?;
    }
    Ok(())
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn mvp_sync_configure(
    app: tauri::AppHandle,
    config_json: String,
) -> Result<Value, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let cfg = RelayConfig::parse(&config_json)?;
        let runtime = app.state::<Arc<Runtime>>();
        let _guard = runtime
            .configuration
            .lock()
            .map_err(|_| "mvp_sync_configuration_busy")?;
        let previous = match runtime.config() {
            Ok(value) => value,
            Err(error) if error == "mvp_sync_credentials_unavailable" => {
                secrets::read_authorized(&runtime.path)?
                    .as_deref()
                    .map(RelayConfig::parse)
                    .transpose()?
            }
            Err(error) => return Err(error),
        };
        if previous.is_some_and(|old| !old.same_scope(&cfg)) {
            return Err("mvp_sync_pairing_changed".into());
        }
        let conn = open_existing(runtime.path.to_str().ok_or("mvp_sync_database_path")?)?;
        // Check the durable binding before replacing credentials after a lost Keychain entry.
        let scope = transport::derive_config(&cfg)?;
        transport::validate_scope(&conn, &scope)?;
        backup_before_enable(&conn, &runtime, cfg.enabled)?;
        let raw = serde_json::to_string(&cfg).map_err(|_| "mvp_sync_invalid_config")?;
        secrets::write(&runtime.path, &raw)?;
        enabled(&conn, cfg.enabled)?;
        *runtime
            .config
            .lock()
            .map_err(|_| "mvp_sync_configuration_busy")? = Some(Some(cfg));
        *runtime
            .last_error
            .lock()
            .map_err(|_| "mvp_sync_status_failed")? = None;
        runtime.pull_more.store(true, Ordering::SeqCst);
        runtime.signal.notify_one();
        status(&conn, &runtime)
    })
    .await
    .map_err(|_| "mvp_sync_configuration_failed".to_string())?;
    result
}
#[tauri::command]
pub(crate) async fn mvp_sync_set_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<Arc<Runtime>>();
        let _guard = runtime
            .configuration
            .lock()
            .map_err(|_| "mvp_sync_configuration_busy")?;
        if enabled && runtime.config()?.is_none() {
            return Err("mvp_sync_not_configured".into());
        }
        let conn = open_existing(runtime.path.to_str().ok_or("mvp_sync_database_path")?)?;
        backup_before_enable(&conn, &runtime, enabled)?;
        self::enabled(&conn, enabled)?;
        runtime.pull_more.store(true, Ordering::SeqCst);
        runtime.signal.notify_one();
        status(&conn, &runtime)
    })
    .await
    .map_err(|_| "mvp_sync_configuration_failed".to_string())?
}
#[tauri::command]
pub(crate) async fn mvp_sync_now(app: tauri::AppHandle) -> Result<Value, String> {
    app.state::<Arc<Runtime>>()
        .pull_more
        .store(true, Ordering::SeqCst);
    app.state::<Arc<Runtime>>().signal.notify_one();
    mvp_sync_status(app).await
}
async fn stream(cfg: RelayConfig, signal: Arc<tokio::sync::Notify>) {
    let mut delay = 2;
    loop {
        let url = format!("{}/content/v1/stream", cfg.endpoint.trim_end_matches('/'))
            .replacen("https://", "wss://", 1);
        let Ok(mut request) = url.into_client_request() else {
            return;
        };
        let Ok(auth) = format!("Bearer {}", cfg.token).parse() else {
            return;
        };
        request.headers_mut().insert("Authorization", auth);
        request.headers_mut().insert(
            "X-Hanni-MVP-Checkpoint",
            transport::CHECKPOINT_SCHEMA
                .parse()
                .expect("static capability header"),
        );
        let mut limits = WebSocketConfig::default();
        limits.max_message_size = Some(4096);
        limits.max_frame_size = Some(4096);
        if let Ok(Ok((mut socket, _))) = tokio::time::timeout(
            Duration::from_secs(15),
            tokio_tungstenite::connect_async_with_config(request, Some(limits), false),
        )
        .await
        {
            delay = 2;
            signal.notify_one();
            let mut heartbeat = tokio::time::interval(Duration::from_secs(60));
            let mut last_seen = Instant::now();
            loop {
                tokio::select! {
                    _=heartbeat.tick()=>{if last_seen.elapsed()>Duration::from_secs(150)||socket.send(Message::Text("ping".into())).await.is_err(){break;}},
                    message=socket.next()=>match message {
                        Some(Ok(Message::Text(text)))=>{last_seen=Instant::now();if text!="pong"{let valid=serde_json::from_str::<Value>(&text).ok().is_some_and(|v|matches!(v["type"].as_str(),Some("ready"|"changed"))&&v["latest_seq"].as_u64().is_some());if valid{signal.notify_one();}else{break;}}},
                        Some(Ok(Message::Ping(_)))|Some(Ok(Message::Pong(_)))=>last_seen=Instant::now(),
                        Some(Ok(Message::Close(_)))|Some(Err(_))|None=>break,_=>{}
                    }
                }
            }
            let _ = socket.close(None).await;
        }
        tokio::time::sleep(Duration::from_secs(delay)).await;
        delay = (delay * 2).min(60);
    }
}
pub(crate) fn start(app: &tauri::AppHandle, path: PathBuf) {
    let runtime = Arc::new(Runtime {
        path,
        config: Mutex::new(None),
        configuration: Mutex::new(()),
        signal: Arc::new(tokio::sync::Notify::new()),
        running: AtomicBool::new(false),
        pull_more: AtomicBool::new(true),
        last_error: Mutex::new(None),
    });
    app.manage(runtime.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut socket: Option<tokio::task::JoinHandle<()>> = None;
        let mut socket_identity = String::new();
        let mut requested = true;
        let mut poll = Instant::now();
        loop {
            let worker = runtime.clone();
            let should_poll = Instant::now() >= poll;
            let output =
                tauri::async_runtime::spawn_blocking(move || -> Result<Option<Value>, String> {
                    let conn =
                        open_existing(worker.path.to_str().ok_or("mvp_sync_database_path")?)?;
                    let schedule = schedule::read(&conn)?;
                    if !schedule.enabled {
                        return Ok(None);
                    }
                    let Some(cfg) = worker.config()? else {
                        return Ok(None);
                    };
                    if !schedule.due(chrono::Utc::now().timestamp(), requested, should_poll) {
                        return Ok(Some(json!({"waiting":true})));
                    }
                    let raw = serde_json::to_string(&cfg).map_err(|_| "mvp_sync_invalid_config")?;
                    worker.running.store(true, Ordering::SeqCst);
                    let result = transport::run_headless_once(
                        worker.path.to_str().ok_or("mvp_sync_database_path")?,
                        &raw,
                    );
                    let result: Result<Value, String> = result.and_then(|v| {
                        serde_json::from_str(&v).map_err(|_| "mvp_sync_status_failed".into())
                    });
                    // A CLI status observer must see catch-up completion before
                    // it can see that the worker stopped running.
                    worker.pull_more.store(
                        result
                            .as_ref()
                            .map(|v| v["pull_more"] != false)
                            .unwrap_or(true),
                        Ordering::SeqCst,
                    );
                    worker.running.store(false, Ordering::SeqCst);
                    result.map(Some)
                })
                .await;
            match output {
                Ok(Ok(Some(value))) => {
                    if let Ok(Some(cfg)) = runtime.config() {
                        if let Ok(identity) = serde_json::to_string(&cfg) {
                            if socket_identity != identity {
                                if let Some(old) = socket.take() {
                                    old.abort();
                                }
                                socket = Some(tokio::spawn(stream(cfg, runtime.signal.clone())));
                                socket_identity = identity;
                            }
                        }
                    }
                    if value["waiting"] != true {
                        poll = Instant::now() + Duration::from_secs(120);
                        requested = value["pull_more"] == true;
                        if let Ok(mut error) = runtime.last_error.lock() {
                            *error = None;
                        }
                        let _=app.emit("mvp-sync-updated",json!({"views_changed":value["applied_rows"].as_u64().unwrap_or(0)>0,"revision":value["revision"]}));
                    }
                }
                Ok(Ok(None)) => {
                    if let Some(old) = socket.take() {
                        old.abort();
                    }
                    socket_identity.clear();
                    requested = true;
                }
                _ => {
                    if let Ok(mut error) = runtime.last_error.lock() {
                        *error = Some("mvp_sync_unavailable".into());
                    }
                    tokio::time::sleep(Duration::from_secs(15)).await;
                }
            }
            tokio::select! {_=runtime.signal.notified()=>{requested=true;},_=tokio::time::sleep(Duration::from_secs(1))=>{}}
        }
    });
}

#[cfg(test)]
#[path = "mvp_sync_tests.rs"]
mod tests;
