//! Health Connect owns these events. Only its importer changes them; the existing
//! item journal carries their projection to older MVP replicas without a new wire schema.
#[cfg(any(target_os = "android", test))]
use chrono::{DateTime, FixedOffset, Utc};
use rusqlite::Connection;
#[cfg(any(target_os = "android", test))]
use rusqlite::{params, TransactionBehavior};
#[cfg(any(target_os = "android", test))]
use serde::Deserialize;
use serde_json::{json, Value};
#[cfg(any(target_os = "android", test))]
use sha2::{Digest, Sha256};

const PREFIX: &str = "hc-sleep:";
fn failure(_: impl std::fmt::Display) -> String {
    "health_sleep_storage_failed".into()
}

pub fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS health_sleep_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT, last_success TEXT,
        history_limited INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO health_sleep_state(singleton) VALUES(1);
        CREATE TABLE IF NOT EXISTS health_sleep_links (
        id TEXT PRIMARY KEY, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL);",
    )
    .map_err(failure)
}

pub fn editable(id: &str) -> Result<(), String> {
    if id.starts_with(PREFIX) {
        Err("health_sleep_readonly".into())
    } else {
        Ok(())
    }
}

#[cfg(any(target_os = "android", test))]
fn id(raw: &str) -> String {
    format!("{PREFIX}{}", hex::encode(Sha256::digest(raw.as_bytes())))
}

#[cfg(any(target_os = "android", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sleep {
    id: String,
    origin: String,
    start_ms: i64,
    end_ms: i64,
    offset_seconds: i32,
    asleep_ms: Option<i64>,
    awake_ms: Option<i64>,
}

#[cfg(any(target_os = "android", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Batch {
    expected_token: Option<String>,
    next_token: String,
    records: Vec<Sleep>,
    deleted: Vec<String>,
    snapshot_start_ms: Option<i64>,
    snapshot_end_ms: Option<i64>,
    complete: bool,
}

#[cfg(any(target_os = "android", test))]
fn read_state(conn: &Connection) -> Result<Value, String> {
    conn.query_row("SELECT token,last_success,history_limited,(SELECT COUNT(*) FROM health_sleep_links) FROM health_sleep_state WHERE singleton=1", [], |r| {
        Ok(json!({"token":r.get::<_, Option<String>>(0)?,"lastSuccess":r.get::<_, Option<String>>(1)?,"historyLimited":r.get::<_, bool>(2)?,"records":r.get::<_,i64>(3)?}))
    }).map_err(failure)
}

#[cfg(any(target_os = "android", test))]
fn apply(conn: &mut Connection, batch: Batch) -> Result<Value, String> {
    if batch.next_token.is_empty()
        || batch.next_token.len() > 16384
        || batch.records.len() > 100_000
        || batch.deleted.len() > 100_000
        || batch.snapshot_start_ms.is_some() != batch.snapshot_end_ms.is_some()
        || batch
            .snapshot_start_ms
            .zip(batch.snapshot_end_ms)
            .is_some_and(|(s, e)| s >= e || !batch.complete)
    {
        return Err("health_sleep_invalid_batch".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(failure)?;
    if read_state(&tx)?["token"].as_str() != batch.expected_token.as_deref() {
        return Err("health_sleep_cursor_changed".into());
    }
    let now = Utc::now().to_rfc3339();
    let mut changed = 0;
    let mut seen = std::collections::HashSet::new();
    for record in batch.records {
        let span = record
            .end_ms
            .checked_sub(record.start_ms)
            .filter(|v| *v > 0 && *v <= 7 * 86_400_000)
            .ok_or("health_sleep_invalid_record")?;
        if record.id.is_empty()
            || record.id.len() > 1024
            || record.origin.is_empty()
            || record.origin.len() > 255
            || record.asleep_ms.is_some_and(|v| v < 0 || v > span)
            || record.awake_ms.is_some_and(|v| v < 0 || v > span)
            || record
                .asleep_ms
                .zip(record.awake_ms)
                .is_some_and(|(s, a)| s + a > span)
        {
            return Err("health_sleep_invalid_record".into());
        }
        let offset =
            FixedOffset::east_opt(record.offset_seconds).ok_or("health_sleep_invalid_record")?;
        let start = DateTime::from_timestamp_millis(record.start_ms)
            .ok_or("health_sleep_invalid_record")?
            .with_timezone(&offset);
        let key = id(&record.id);
        if !seen.insert(key.clone()) {
            return Err("health_sleep_duplicate_batch_record".into());
        }
        let minutes = (span + 59_999) / 60_000;
        let origin = if record.origin == "com.sec.android.app.shealth" {
            "Samsung Health"
        } else {
            &record.origin
        };
        let asleep = record
            .asleep_ms
            .map(|v| format!("{} мин", v / 60_000))
            .unwrap_or_else(|| "нет данных о стадиях".into());
        let notes = format!("Источник: {origin} через Health Connect.\nПериод сна: {minutes} мин. Во сне: {asleep}.\nИзменения и удаление — в приложении-источнике.");
        // Tags stay an ordinary JSON string array understood by existing replicas.
        let tags = json!([
            "health:sleep:v1",
            format!("health:origin:{}", record.origin),
            format!(
                "health:asleep:{}",
                record
                    .asleep_ms
                    .map(|v| (v / 60_000).to_string())
                    .unwrap_or_default()
            ),
            format!(
                "health:awake:{}",
                record
                    .awake_ms
                    .map(|v| (v / 60_000).to_string())
                    .unwrap_or_default()
            )
        ])
        .to_string();
        changed += tx.execute("INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,tags,status)
            VALUES(?1,'event','Сон',?2,?3,?4,?5,0,1,?6,?6,'general','#747AA5',?7,'event')
            ON CONFLICT(id) DO UPDATE SET notes=excluded.notes,date=excluded.date,time=excluded.time,
            duration_minutes=excluded.duration_minutes,tags=excluded.tags,version=items.version+1,updated_at=excluded.updated_at
            WHERE items.notes<>excluded.notes OR items.date IS NOT excluded.date OR items.time IS NOT excluded.time
            OR items.duration_minutes<>excluded.duration_minutes OR items.tags<>excluded.tags",
            params![key,notes,start.format("%Y-%m-%d").to_string(),start.format("%H:%M").to_string(),minutes,now,tags]).map_err(failure)?;
        tx.execute(
            "INSERT INTO health_sleep_links(id,start_ms,end_ms) VALUES(?1,?2,?3)
            ON CONFLICT(id) DO UPDATE SET start_ms=excluded.start_ms,end_ms=excluded.end_ms",
            params![key, record.start_ms, record.end_ms],
        )
        .map_err(failure)?;
    }
    let mut removed: Vec<String> = batch.deleted.iter().map(|v| id(v)).collect();
    if let Some((start, end)) = batch.snapshot_start_ms.zip(batch.snapshot_end_ms) {
        let mut query = tx
            .prepare("SELECT id FROM health_sleep_links WHERE start_ms>=?1 AND end_ms<=?2")
            .map_err(failure)?;
        for key in query
            .query_map(params![start, end], |r| r.get::<_, String>(0))
            .map_err(failure)?
        {
            let key = key.map_err(failure)?;
            if !seen.contains(&key) {
                removed.push(key);
            }
        }
        // Do not interpret an inaccessible historical record as a source deletion.
        tx.execute("UPDATE health_sleep_state SET history_limited=EXISTS(SELECT 1 FROM health_sleep_links WHERE start_ms<?1) WHERE singleton=1", [start]).map_err(failure)?;
    }
    for key in removed {
        let owned: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM health_sleep_links WHERE id=?1)",
                [&key],
                |r| r.get(0),
            )
            .map_err(failure)?;
        if owned {
            changed += tx
                .execute("DELETE FROM items WHERE id=?1", [&key])
                .map_err(failure)?;
            tx.execute("DELETE FROM health_sleep_links WHERE id=?1", [&key])
                .map_err(failure)?;
        }
    }
    tx.execute("UPDATE health_sleep_state SET token=?1,last_success=CASE WHEN ?2 THEN ?3 ELSE last_success END WHERE singleton=1",
        params![batch.next_token,batch.complete,now]).map_err(failure)?;
    let mut state = read_state(&tx)?;
    state["changed"] = json!(changed);
    state["records"] = json!(tx
        .query_row("SELECT COUNT(*) FROM health_sleep_links", [], |r| r
            .get::<_, i64>(0))
        .map_err(failure)?);
    tx.commit().map_err(failure)?;
    Ok(state)
}

pub fn decorate(value: &mut Value, key: &str, tags: &str) {
    if !key.starts_with(PREFIX) {
        return;
    }
    value["readonly"] = json!(true);
    value["health_kind"] = json!("sleep");
    value["source"] = json!("health_connect");
    value["tracking_mode"] = json!("none");
    value["sleep_minutes"] = Value::Null;
    if let Ok(tags) = serde_json::from_str::<Vec<String>>(tags) {
        for tag in tags {
            if let Some(v) = tag.strip_prefix("health:asleep:") {
                value["sleep_minutes"] = v.parse::<u64>().ok().map_or(Value::Null, |v| json!(v));
            }
            if let Some(v) = tag.strip_prefix("health:origin:") {
                value["health_origin"] = json!(v);
            }
            if let Some(v) = tag.strip_prefix("health:awake:") {
                value["awake_minutes"] = v.parse::<u64>().ok().map_or(Value::Null, |v| json!(v));
            }
        }
    }
}

#[tauri::command]
pub async fn health_sleep_status(app: tauri::AppHandle) -> Result<Value, String> {
    use hanni_mvp_android_installer::AndroidInstallerExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.android_installer().sleep_command("sleepStatus")
    })
    .await
    .map_err(failure)?
}
#[tauri::command]
pub async fn health_sleep_connect(app: tauri::AppHandle) -> Result<Value, String> {
    use hanni_mvp_android_installer::AndroidInstallerExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.android_installer().sleep_command("sleepConnect")
    })
    .await
    .map_err(failure)?
}
#[tauri::command]
pub async fn health_sleep_import(app: tauri::AppHandle) -> Result<Value, String> {
    use hanni_mvp_android_installer::AndroidInstallerExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.android_installer().sleep_command("sleepImport")
    })
    .await
    .map_err(failure)?
}

#[cfg(target_os = "android")]
fn native(path: &str, raw: &str) -> Result<String, String> {
    let mut conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(failure)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(failure)?;
    // Application initialization owns schema migrations. A worker never creates a profile.
    let response = if raw.is_empty() {
        read_state(&conn)?
    } else {
        apply(
            &mut conn,
            serde_json::from_str(raw).map_err(|_| "health_sleep_invalid_batch")?,
        )?
    };
    Ok(response.to_string())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_hanni_mvp_android_installer_SleepNative_exchangeNative(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    path: jni::objects::JString,
    raw: jni::objects::JString,
) -> jni::sys::jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let path: String = env.get_string(&path).map_err(failure)?.into();
        let raw: String = env.get_string(&raw).map_err(failure)?.into();
        native(&path, &raw)
    }))
    .unwrap_or_else(|_| Err("health_sleep_storage_failed".into()));
    let response = result.unwrap_or_else(|e| json!({"error":e}).to_string());
    env.new_string(response)
        .map(|v| v.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::init_schema(&c).unwrap();
        c
    }
    fn batch(token: Option<&str>, next: &str, records: Value, deleted: Value) -> Batch {
        serde_json::from_value(json!({"expectedToken":token,"nextToken":next,"records":records,"deleted":deleted,"complete":true})).unwrap()
    }
    fn record() -> Value {
        json!({"id":"fictional-sleep","origin":"com.example.sleep","startMs":1758326400000i64,"endMs":1758355200000i64,"offsetSeconds":18000,"asleepMs":25200000,"awakeMs":3600000})
    }
    #[test]
    fn repeat_update_delete_and_cursor_are_atomic() {
        let mut c = db();
        assert_eq!(
            apply(&mut c, batch(None, "a", json!([record()]), json!([]))).unwrap()["changed"],
            1
        );
        assert_eq!(
            apply(&mut c, batch(Some("a"), "b", json!([record()]), json!([]))).unwrap()["changed"],
            0
        );
        let mut r = record();
        r["asleepMs"] = json!(24000000);
        assert_eq!(
            apply(&mut c, batch(Some("b"), "c", json!([r]), json!([]))).unwrap()["changed"],
            1
        );
        assert!(apply(
            &mut c,
            batch(Some("b"), "stale", json!([]), json!(["fictional-sleep"]))
        )
        .is_err());
        assert_eq!(
            apply(
                &mut c,
                batch(Some("c"), "d", json!([]), json!(["fictional-sleep"]))
            )
            .unwrap()["changed"],
            1
        );
        assert_eq!(read_state(&c).unwrap()["token"], "d");
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM items", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn invalid_page_preserves_data_and_cursor() {
        let mut c = db();
        let mut bad = record();
        bad["endMs"] = json!(0);
        assert!(apply(&mut c, batch(None, "a", json!([record(), bad]), json!([]))).is_err());
        assert!(read_state(&c).unwrap()["token"].is_null());
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM items", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn snapshot_prunes_only_proven_window_and_preserves_manual_events() {
        let mut c = db();
        apply(&mut c, batch(None, "a", json!([record()]), json!([]))).unwrap();
        c.execute("INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at) VALUES('manual','event','Fictional',1,1,'x','x')",[]).unwrap();
        let mut b = batch(Some("a"), "b", json!([]), json!([]));
        b.snapshot_start_ms = Some(1758326400000);
        b.snapshot_end_ms = Some(1758355200000);
        assert_eq!(apply(&mut c, b).unwrap()["changed"], 1);
        assert_eq!(
            c.query_row("SELECT id FROM items", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "manual"
        );
    }
    #[test]
    fn projection_preserves_sleep_stages_and_source_without_changing_wire_columns() {
        let mut c = db();
        apply(&mut c, batch(None, "a", json!([record()]), json!([]))).unwrap();
        let (key, tags, span): (String, String, i64) = c
            .query_row("SELECT id,tags,duration_minutes FROM items", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        let mut v = json!({});
        decorate(&mut v, &key, &tags);
        assert_eq!(span, 480);
        assert_eq!(v["sleep_minutes"], 420);
        assert_eq!(v["awake_minutes"], 60);
        assert_eq!(v["health_origin"], "com.example.sleep");
        assert!(editable(&key).is_err());
        assert!(!tags.contains("fictional-sleep"));
    }
    fn transfer(source: &Connection, target: &Connection, sleep_id: &str) {
        let key = json!(["items", [sleep_id]]).to_string();
        let mut fields = crate::mvp_sync_db::row_to_json(
            source,
            "mvp_records",
            &rusqlite::types::Value::Text(key.clone()),
        )
        .unwrap()
        .unwrap()
        .as_object()
        .unwrap()
        .clone();
        let (stamp,writer): (String,String) = source.query_row("SELECT updated_at,device_id FROM sync_row_versions WHERE table_name='mvp_records' AND row_id=?1",[&key],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        fields.insert("_updated_at".into(), json!(stamp));
        fields.insert("_device_id".into(), json!(writer));
        target
            .execute("UPDATE content_sync_control SET applying=1", [])
            .unwrap();
        crate::mvp_sync_db::apply_record(target, &fields).unwrap();
        target
            .execute("UPDATE content_sync_control SET applying=0", [])
            .unwrap();
    }
    #[test]
    fn existing_replica_protocol_delivers_sleep_updates_and_tombstones() {
        let mut phone = db();
        let desktop = db();
        // A replica without the importer must still accept the exact v1 item schema.
        desktop
            .execute_batch("DROP TABLE health_sleep_links; DROP TABLE health_sleep_state;")
            .unwrap();
        apply(&mut phone, batch(None, "a", json!([record()]), json!([]))).unwrap();
        let key = id("fictional-sleep");
        transfer(&phone, &desktop, &key);
        transfer(&phone, &desktop, &key);
        assert_eq!(
            desktop
                .query_row("SELECT COUNT(*) FROM items", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let mut updated = record();
        updated["endMs"] = json!(1758358800000i64);
        apply(
            &mut phone,
            batch(Some("a"), "b", json!([updated]), json!([])),
        )
        .unwrap();
        transfer(&phone, &desktop, &key);
        assert_eq!(
            desktop
                .query_row("SELECT duration_minutes FROM items", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            540
        );
        apply(
            &mut phone,
            batch(Some("b"), "c", json!([]), json!(["fictional-sleep"])),
        )
        .unwrap();
        transfer(&phone, &desktop, &key);
        assert_eq!(
            desktop
                .query_row("SELECT COUNT(*) FROM items", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            crate::mvp_sync_db::day_ledger(&phone).unwrap(),
            crate::mvp_sync_db::day_ledger(&desktop).unwrap()
        );
    }
}
