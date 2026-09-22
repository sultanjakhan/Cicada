//! Health Connect walking sessions and daily step totals.
//!
//! This importer owns only its `hc-walk:` and `hc-steps:` projections.  It uses
//! bounded snapshots so a missing permission or an unavailable provider never
//! turns into a source deletion.

#[cfg(any(target_os = "android", test))]
use chrono::{DateTime, FixedOffset, NaiveDate, Utc};
use rusqlite::Connection;
#[cfg(any(target_os = "android", test))]
use rusqlite::{params, TransactionBehavior};
#[cfg(any(target_os = "android", test))]
use serde::Deserialize;
use serde_json::{json, Value};
#[cfg(any(target_os = "android", test))]
use sha2::{Digest, Sha256};

const WALK_PREFIX: &str = "hc-walk:";
const STEPS_PREFIX: &str = "hc-steps:all:";

fn failure(_: impl std::fmt::Display) -> String {
    "health_activity_storage_failed".into()
}

pub fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS health_activity_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT, last_success TEXT,
        walking_last_success TEXT, steps_last_success TEXT,
        history_limited INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO health_activity_state(singleton) VALUES(1);
        CREATE TABLE IF NOT EXISTS health_activity_links (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL);",
    ).map_err(failure)?;
    // Keep a locally-created candidate database usable if it predates the
    // per-kind freshness fields.  These fields never alter imported records.
    let mut columns = std::collections::HashSet::new();
    let mut query = conn
        .prepare("PRAGMA table_info(health_activity_state)")
        .map_err(failure)?;
    for row in query
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(failure)?
    {
        columns.insert(row.map_err(failure)?);
    }
    drop(query);
    for column in ["walking_last_success", "steps_last_success"] {
        if !columns.contains(column) {
            conn.execute(
                &format!("ALTER TABLE health_activity_state ADD COLUMN {column} TEXT"),
                [],
            )
            .map_err(failure)?;
        }
    }
    Ok(())
}

pub fn is_readonly(id: &str) -> bool {
    id.starts_with(WALK_PREFIX) || id.starts_with(STEPS_PREFIX)
}

#[cfg(any(target_os = "android", test))]
fn walking_id(raw: &str) -> String {
    format!(
        "{WALK_PREFIX}{}",
        hex::encode(Sha256::digest(raw.as_bytes()))
    )
}

#[cfg(any(target_os = "android", test))]
fn steps_id(date: &str) -> String {
    format!("{STEPS_PREFIX}{date}")
}

#[cfg(any(target_os = "android", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Walking {
    id: String,
    origin: String,
    start_ms: i64,
    end_ms: i64,
    offset_seconds: i32,
}

#[cfg(any(target_os = "android", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Steps {
    date: String,
    count: i64,
    #[serde(default = "default_scope")]
    origin_scope: String,
}

#[cfg(any(target_os = "android", test))]
fn default_scope() -> String {
    "all".into()
}

#[cfg(any(target_os = "android", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Batch {
    expected_token: Option<String>,
    next_token: String,
    #[serde(default)]
    walking_granted: bool,
    #[serde(default)]
    steps_granted: bool,
    #[serde(default)]
    walking: Vec<Walking>,
    #[serde(default)]
    steps: Vec<Steps>,
    #[serde(default)]
    deleted_walking: Vec<String>,
    #[serde(default)]
    deleted_steps: Vec<String>,
    snapshot_start_ms: Option<i64>,
    snapshot_end_ms: Option<i64>,
    steps_snapshot_start_date: Option<String>,
    steps_snapshot_end_date: Option<String>,
    complete: bool,
}

#[cfg(any(target_os = "android", test))]
fn read_state(conn: &Connection) -> Result<Value, String> {
    conn.query_row(
        "SELECT token,last_success,walking_last_success,steps_last_success,history_limited,
         (SELECT COUNT(*) FROM health_activity_links WHERE kind='walking'),
         (SELECT COUNT(*) FROM health_activity_links WHERE kind='steps')
         FROM health_activity_state WHERE singleton=1",
        [],
        |r| {
            Ok(json!({
                "token": r.get::<_, Option<String>>(0)?,
                "lastSuccess": r.get::<_, Option<String>>(1)?,
                "walkingLastSuccess": r.get::<_, Option<String>>(2)?,
                "stepsLastSuccess": r.get::<_, Option<String>>(3)?,
                "historyLimited": r.get::<_, bool>(4)?,
                "walkingRecords": r.get::<_, i64>(5)?,
                "stepsRecords": r.get::<_, i64>(6)?,
            }))
        },
    )
    .map_err(failure)
}

#[cfg(any(target_os = "android", test))]
fn apply(conn: &mut Connection, batch: Batch) -> Result<Value, String> {
    if batch.next_token.is_empty()
        || batch.next_token.len() > 16_384
        || batch.walking.len() > 100_000
        || batch.steps.len() > 100_000
        || batch.deleted_walking.len() > 100_000
        || batch.deleted_steps.len() > 100_000
        || batch.snapshot_start_ms.is_some() != batch.snapshot_end_ms.is_some()
        || batch.steps_snapshot_start_date.is_some() != batch.steps_snapshot_end_date.is_some()
        || batch
            .snapshot_start_ms
            .zip(batch.snapshot_end_ms)
            .is_some_and(|(s, e)| s >= e || !batch.complete)
    {
        return Err("health_activity_invalid_batch".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(failure)?;
    if read_state(&tx)?["token"].as_str() != batch.expected_token.as_deref() {
        return Err("health_activity_cursor_changed".into());
    }
    let now = Utc::now().to_rfc3339();
    let mut changed = 0;
    let mut seen = std::collections::HashSet::new();
    for record in batch.walking {
        let span = record
            .end_ms
            .checked_sub(record.start_ms)
            .filter(|v| *v > 0 && *v <= 7 * 86_400_000)
            .ok_or("health_activity_invalid_record")?;
        if record.id.is_empty()
            || record.id.len() > 1024
            || record.origin.is_empty()
            || record.origin.len() > 255
        {
            return Err("health_activity_invalid_record".into());
        }
        let offset =
            FixedOffset::east_opt(record.offset_seconds).ok_or("health_activity_invalid_record")?;
        let start = DateTime::from_timestamp_millis(record.start_ms)
            .ok_or("health_activity_invalid_record")?
            .with_timezone(&offset);
        let key = walking_id(&record.id);
        if !seen.insert(key.clone()) {
            return Err("health_activity_duplicate_walking".into());
        }
        let minutes = (span + 59_999) / 60_000;
        let notes = format!("Источник: {} через Health Connect.\nПериод прогулки: {} мин.\nИзменения и удаление — в приложении-источнике.", record.origin, minutes);
        let tags = json!([
            "health:walking:v1",
            format!("health:origin:{}", record.origin)
        ])
        .to_string();
        changed += tx.execute(
            "INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,tags,status)
             VALUES(?1,'event','Прогулка',?2,?3,?4,?5,0,1,?6,?6,'general','#5B8C85',?7,'event')
             ON CONFLICT(id) DO UPDATE SET notes=excluded.notes,date=excluded.date,time=excluded.time,
             duration_minutes=excluded.duration_minutes,tags=excluded.tags,version=items.version+1,updated_at=excluded.updated_at
             WHERE items.notes<>excluded.notes OR items.date IS NOT excluded.date OR items.time IS NOT excluded.time
             OR items.duration_minutes<>excluded.duration_minutes OR items.tags<>excluded.tags",
            params![key, notes, start.format("%Y-%m-%d").to_string(), start.format("%H:%M").to_string(), minutes, now, tags],
        ).map_err(failure)?;
        tx.execute(
            "INSERT INTO health_activity_links(id,kind,start_ms,end_ms) VALUES(?1,'walking',?2,?3)
             ON CONFLICT(id) DO UPDATE SET kind='walking',start_ms=excluded.start_ms,end_ms=excluded.end_ms",
            params![key, record.start_ms, record.end_ms],
        ).map_err(failure)?;
    }
    for record in batch.steps {
        if record.origin_scope != "all"
            || record.count < 0
            || record.count > 10_000_000
            || NaiveDate::parse_from_str(&record.date, "%Y-%m-%d").is_err()
        {
            return Err("health_activity_invalid_steps".into());
        }
        let key = steps_id(&record.date);
        if !seen.insert(key.clone()) {
            return Err("health_activity_duplicate_steps".into());
        }
        let notes = format!("Источник: Health Connect (все доступные источники).\nШагов за день: {}.\nИтог не имеет времени начала. Изменения — в приложении-источнике.", record.count);
        let tags = json!([
            "health:steps:v1",
            "health:origin-scope:all",
            format!("health:steps-count:{}", record.count)
        ])
        .to_string();
        changed += tx.execute(
            "INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,tags,status)
             VALUES(?1,'event','Шаги',?2,?3,NULL,0,0,1,?4,?4,'general','#7A8C5B',?5,'event')
             ON CONFLICT(id) DO UPDATE SET notes=excluded.notes,date=excluded.date,time=NULL,
             duration_minutes=0,tags=excluded.tags,version=items.version+1,updated_at=excluded.updated_at
             WHERE items.notes<>excluded.notes OR items.date IS NOT excluded.date OR items.time IS NOT NULL
             OR items.duration_minutes<>0 OR items.tags<>excluded.tags",
            params![key, notes, record.date, now, tags],
        ).map_err(failure)?;
        let day_start = NaiveDate::parse_from_str(&record.date, "%Y-%m-%d")
            .map_err(|_| "health_activity_invalid_steps")?;
        let start_ms = day_start
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis();
        let end_ms = day_start
            .succ_opt()
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis();
        tx.execute(
            "INSERT INTO health_activity_links(id,kind,start_ms,end_ms) VALUES(?1,'steps',?2,?3)
             ON CONFLICT(id) DO UPDATE SET kind='steps',start_ms=excluded.start_ms,end_ms=excluded.end_ms",
            params![key, start_ms, end_ms],
        ).map_err(failure)?;
    }
    let mut removed: Vec<String> = batch
        .deleted_walking
        .iter()
        .map(|v| walking_id(v))
        .collect();
    removed.extend(batch.deleted_steps.iter().map(|v| steps_id(v)));
    if let Some((start, end)) = batch.snapshot_start_ms.zip(batch.snapshot_end_ms) {
        let mut query = tx
            .prepare("SELECT id,kind FROM health_activity_links WHERE start_ms>=?1 AND end_ms<=?2")
            .map_err(failure)?;
        for row in query
            .query_map(params![start, end], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(failure)?
        {
            let (key, kind) = row.map_err(failure)?;
            if !seen.contains(&key) && kind == "walking" && batch.walking_granted {
                removed.push(key);
            }
        }
        tx.execute("UPDATE health_activity_state SET history_limited=EXISTS(SELECT 1 FROM health_activity_links WHERE start_ms<?1) WHERE singleton=1", [start]).map_err(failure)?;
    }
    if let Some((start, end)) = batch
        .steps_snapshot_start_date
        .as_deref()
        .zip(batch.steps_snapshot_end_date.as_deref())
    {
        let start = NaiveDate::parse_from_str(start, "%Y-%m-%d")
            .map_err(|_| "health_activity_invalid_batch")?;
        let end = NaiveDate::parse_from_str(end, "%Y-%m-%d")
            .map_err(|_| "health_activity_invalid_batch")?;
        if start >= end {
            return Err("health_activity_invalid_batch".into());
        }
        let start_ms = start
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis();
        let end_ms = end
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis();
        let mut query = tx.prepare("SELECT id FROM health_activity_links WHERE kind='steps' AND start_ms>=?1 AND start_ms<?2").map_err(failure)?;
        for row in query
            .query_map(params![start_ms, end_ms], |r| r.get::<_, String>(0))
            .map_err(failure)?
        {
            let key = row.map_err(failure)?;
            if !seen.contains(&key) && batch.steps_granted {
                removed.push(key);
            }
        }
    }
    for key in removed {
        let owned: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM health_activity_links WHERE id=?1)",
                [&key],
                |r| r.get(0),
            )
            .map_err(failure)?;
        if owned {
            changed += tx
                .execute("DELETE FROM items WHERE id=?1", [&key])
                .map_err(failure)?;
            tx.execute("DELETE FROM health_activity_links WHERE id=?1", [&key])
                .map_err(failure)?;
        }
    }
    tx.execute(
        "UPDATE health_activity_state SET token=?1,
         last_success=CASE WHEN ?2 THEN ?3 ELSE last_success END,
         walking_last_success=CASE WHEN ?2 AND ?4 THEN ?3 ELSE walking_last_success END,
         steps_last_success=CASE WHEN ?2 AND ?5 THEN ?3 ELSE steps_last_success END
         WHERE singleton=1",
        params![
            batch.next_token,
            batch.complete,
            now,
            batch.walking_granted,
            batch.steps_granted
        ],
    )
    .map_err(failure)?;
    let mut state = read_state(&tx)?;
    state["changed"] = json!(changed);
    tx.commit().map_err(failure)?;
    Ok(state)
}

pub fn decorate(value: &mut Value, key: &str, tags: &str) {
    let kind = if key.starts_with(WALK_PREFIX) {
        "walking"
    } else if key.starts_with(STEPS_PREFIX) {
        "steps"
    } else {
        return;
    };
    value["readonly"] = json!(true);
    value["health_kind"] = json!(kind);
    value["source"] = json!("health_connect");
    value["tracking_mode"] = json!("none");
    if let Ok(tags) = serde_json::from_str::<Vec<String>>(tags) {
        for tag in tags {
            if let Some(v) = tag.strip_prefix("health:origin:") {
                value["health_origin"] = json!(v);
            }
            if let Some(v) = tag.strip_prefix("health:steps-count:") {
                value["steps_count"] = v.parse::<u64>().ok().map_or(Value::Null, |v| json!(v));
            }
            if let Some(v) = tag.strip_prefix("health:origin-scope:") {
                value["health_origin_scope"] = json!(v);
            }
        }
    }
}

#[tauri::command]
pub async fn health_activity_status(app: tauri::AppHandle) -> Result<Value, String> {
    use hanni_mvp_android_installer::AndroidInstallerExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.android_installer().activity_command("activityStatus")
    })
    .await
    .map_err(failure)?
}
#[tauri::command]
pub async fn health_activity_connect(app: tauri::AppHandle) -> Result<Value, String> {
    use hanni_mvp_android_installer::AndroidInstallerExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.android_installer().activity_command("activityConnect")
    })
    .await
    .map_err(failure)?
}
#[tauri::command]
pub async fn health_activity_import(app: tauri::AppHandle) -> Result<Value, String> {
    use hanni_mvp_android_installer::AndroidInstallerExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.android_installer().activity_command("activityImport")
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
    let response = if raw.is_empty() {
        read_state(&conn)?
    } else {
        apply(
            &mut conn,
            serde_json::from_str(raw).map_err(|_| "health_activity_invalid_batch")?,
        )?
    };
    Ok(response.to_string())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_hanni_mvp_android_installer_ActivityNative_exchangeNative(
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
    .unwrap_or_else(|_| Err("health_activity_storage_failed".into()));
    env.new_string(result.unwrap_or_else(|e| json!({"error":e}).to_string()))
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
    fn batch(token: Option<&str>, next: &str, walking: Value, steps: Value) -> Batch {
        serde_json::from_value(json!({"expectedToken":token,"nextToken":next,"walkingGranted":true,"stepsGranted":true,"walking":walking,"steps":steps,"complete":true,"snapshotStartMs":1758326400000i64,"snapshotEndMs":1758333600000i64,"stepsSnapshotStartDate":"2025-09-20","stepsSnapshotEndDate":"2025-09-21"})).unwrap()
    }
    fn walk() -> Value {
        json!({"id":"fictional-walk","origin":"com.example.walk","startMs":1758326400000i64,"endMs":1758330000000i64,"offsetSeconds":18000})
    }
    fn steps() -> Value {
        json!({"date":"2025-09-20","count":3210,"originScope":"all"})
    }
    fn transfer(source: &Connection, target: &Connection, id: &str) {
        let key = json!(["items", [id]]).to_string();
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
        let (stamp, writer): (String, String) = source.query_row(
            "SELECT updated_at,device_id FROM sync_row_versions WHERE table_name='mvp_records' AND row_id=?1",
            [&key], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
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
    fn repeat_update_delete_and_cursor_are_atomic() {
        let mut c = db();
        assert_eq!(
            apply(&mut c, batch(None, "a", json!([walk()]), json!([steps()]))).unwrap()["changed"],
            2
        );
        assert_eq!(
            apply(
                &mut c,
                batch(Some("a"), "b", json!([walk()]), json!([steps()]))
            )
            .unwrap()["changed"],
            0
        );
        let mut changed = walk();
        changed["endMs"] = json!(1758333600000i64);
        assert_eq!(
            apply(
                &mut c,
                batch(
                    Some("b"),
                    "c",
                    json!([changed]),
                    json!([{"date":"2025-09-20","count":4000,"originScope":"all"}])
                )
            )
            .unwrap()["changed"],
            2
        );
        assert!(apply(&mut c, batch(Some("b"), "stale", json!([]), json!([]))).is_err());
        let empty = batch(Some("c"), "d", json!([]), json!([]));
        assert_eq!(apply(&mut c, empty).unwrap()["changed"], 2);
        assert_eq!(read_state(&c).unwrap()["token"], "d");
    }
    #[test]
    fn permission_scopes_preserve_unreadable_kind() {
        let mut c = db();
        apply(&mut c, batch(None, "a", json!([walk()]), json!([steps()]))).unwrap();
        let mut no_steps = batch(Some("a"), "b", json!([]), json!([]));
        no_steps.steps_granted = false;
        apply(&mut c, no_steps).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM items WHERE id LIKE 'hc-steps:%'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    #[test]
    fn freshness_is_recorded_per_granted_kind() {
        let mut c = db();
        let mut walking_only = batch(None, "a", json!([walk()]), json!([]));
        walking_only.steps_granted = false;
        apply(&mut c, walking_only).unwrap();
        let state = read_state(&c).unwrap();
        assert!(state["walkingLastSuccess"].is_string());
        assert!(state["stepsLastSuccess"].is_null());

        let mut still_walking = batch(Some("a"), "b", json!([]), json!([]));
        still_walking.steps_granted = false;
        apply(&mut c, still_walking).unwrap();
        assert!(read_state(&c).unwrap()["stepsLastSuccess"].is_null());

        let mut steps_empty = batch(Some("b"), "c", json!([]), json!([]));
        steps_empty.walking_granted = false;
        apply(&mut c, steps_empty).unwrap();
        assert!(read_state(&c).unwrap()["stepsLastSuccess"].is_string());
    }
    #[test]
    fn invalid_record_rolls_back_prior_record_and_cursor() {
        let mut c = db();
        apply(&mut c, batch(None, "a", json!([walk()]), json!([]))).unwrap();
        let bad = json!({"id":"bad","origin":"x","startMs":1,"endMs":1,"offsetSeconds":0});
        assert!(apply(
            &mut c,
            batch(Some("a"), "b", json!([walk(), bad]), json!([]))
        )
        .is_err());
        assert_eq!(read_state(&c).unwrap()["token"], "a");
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM items WHERE id LIKE 'hc-walk:%'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    #[test]
    fn absent_steps_are_removed_in_window_but_explicit_zero_is_data() {
        let mut c = db();
        apply(&mut c, batch(None, "a", json!([]), json!([steps()]))).unwrap();
        let zero = json!({"date":"2025-09-20","count":0,"originScope":"all"});
        assert_eq!(
            apply(&mut c, batch(Some("a"), "b", json!([]), json!([zero]))).unwrap()["changed"],
            1
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM items WHERE id LIKE 'hc-steps:%'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            apply(&mut c, batch(Some("b"), "c", json!([]), json!([]))).unwrap()["changed"],
            1
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM items WHERE id LIKE 'hc-steps:%'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
    #[test]
    fn imported_ids_are_readonly_for_calendar_commands() {
        assert_eq!(
            crate::health_sleep::editable("hc-walk:fixture").unwrap_err(),
            "health_activity_readonly"
        );
        assert_eq!(
            crate::health_sleep::editable("hc-steps:all:2025-09-20").unwrap_err(),
            "health_activity_readonly"
        );
    }
    #[test]
    fn existing_items_protocol_delivers_activity_update_and_tombstone_to_replica() {
        let mut phone = db();
        let desktop = db();
        desktop
            .execute_batch("DROP TABLE health_activity_links; DROP TABLE health_activity_state;")
            .unwrap();
        let walk_key = walking_id("fictional-walk");
        let steps_key = "hc-steps:all:2025-09-20";
        apply(
            &mut phone,
            batch(None, "a", json!([walk()]), json!([steps()])),
        )
        .unwrap();
        for key in [&walk_key, steps_key] {
            transfer(&phone, &desktop, key);
            transfer(&phone, &desktop, key);
            assert_eq!(
                desktop
                    .query_row("SELECT COUNT(*) FROM items WHERE id=?1", [key], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        let changed_walk = json!({"id":"fictional-walk","origin":"com.example.walk","startMs":1758326400000i64,"endMs":1758333600000i64,"offsetSeconds":18000});
        apply(
            &mut phone,
            batch(
                Some("a"),
                "b",
                json!([changed_walk]),
                json!([{"date":"2025-09-20","count":4321,"originScope":"all"}]),
            ),
        )
        .unwrap();
        transfer(&phone, &desktop, &walk_key);
        transfer(&phone, &desktop, steps_key);
        assert_eq!(
            desktop
                .query_row(
                    "SELECT duration_minutes FROM items WHERE id=?1",
                    [&walk_key],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            120
        );
        assert!(desktop
            .query_row("SELECT notes FROM items WHERE id=?1", [steps_key], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
            .contains("4321"));
        apply(&mut phone, batch(Some("b"), "c", json!([]), json!([]))).unwrap();
        for key in [&walk_key, steps_key] {
            transfer(&phone, &desktop, key);
            assert_eq!(
                desktop
                    .query_row("SELECT COUNT(*) FROM items WHERE id=?1", [key], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }
}
