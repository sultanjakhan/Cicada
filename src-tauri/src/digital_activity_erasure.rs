//! Permanent, per-connection deletion boundaries for Cicada aggregates only.
//! ActivityWatch, relay archives and existing backups are not erased here.
use super::*;

pub(crate) const KEY: &str = "digital_activity_retention_v1";
const UNSAFE: &str = "digital_activity_erasure_unsafe_record";

pub(crate) fn valid_date(raw: &str) -> bool {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .is_ok_and(|day| day.to_string() == raw && raw >= "1970-01-01" && raw <= "9999-12-30")
}

pub(crate) fn valid_marker(device: &str, value: &Value, deleted: bool) -> bool {
    !deleted
        && validate_id(device).is_ok()
        && value.as_object().is_some_and(|v| v.len() == 1)
        && value["deletedThrough"].as_str().is_some_and(valid_date)
}

pub(crate) fn cutoff(conn: &Connection, device: &str) -> Result<Option<String>, String> {
    let id = json!(["ui", [KEY, device]]).to_string();
    let raw: Option<String> = conn
        .query_row("SELECT data FROM mvp_records WHERE id=?1", [&id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(storage_error)?;
    raw.map(|raw| {
        let record: Value = serde_json::from_str(&raw).map_err(storage_error)?;
        if record["kind"] != "ui"
            || record["key"] != json!([KEY, device])
            || !valid_marker(device, &record["value"], record["deleted"] != false)
        {
            return Err("digital_activity_invalid_retention".into());
        }
        Ok(record["value"]["deletedThrough"]
            .as_str()
            .unwrap()
            .to_owned())
    })
    .transpose()
}

fn identity(id: &str) -> Option<(&str, &str)> {
    let (device, day) = id.strip_prefix("digital-activity:")?.split_once(':')?;
    (validate_id(device).is_ok() && valid_date(day)).then_some((device, day))
}

fn exact_row(id: &str, kind: &str, date: Option<&str>, tags: &str) -> bool {
    let Some((device, day)) = identity(id) else {
        return false;
    };
    let Ok(tags) = serde_json::from_str::<Vec<String>>(tags) else {
        return false;
    };
    kind == "event"
        && date == Some(day)
        && tags.iter().any(|t| t == "digital-activity:v1")
        && tags
            .iter()
            .any(|t| t == &format!("digital-activity-device:{device}"))
        && tags
            .iter()
            .any(|t| t == &format!("digital-activity-day:{day}"))
        && tags
            .iter()
            .filter(|t| t.starts_with("digital-activity-device:"))
            .count()
            == 1
        && tags
            .iter()
            .filter(|t| t.starts_with("digital-activity-day:"))
            .count()
            == 1
}

/// Incoming live records must not resurrect a removed day, even with a newer stamp.
pub(crate) fn blocked_item(conn: &Connection, value: &Value) -> Result<bool, String> {
    let Some(id) = value["id"].as_str() else {
        return Ok(false);
    };
    let Some((device, day)) = identity(id) else {
        return Ok(false);
    };
    if !cutoff(conn, device)?.is_some_and(|limit| day <= limit.as_str()) {
        return Ok(false);
    }
    if !exact_row(
        id,
        value["kind"].as_str().unwrap_or(""),
        value["date"].as_str(),
        value["tags"].as_str().unwrap_or(""),
    ) {
        return Err(UNSAFE.into());
    }
    Ok(true)
}

fn targets(conn: &Connection, device: &str, through: &str) -> Result<Vec<String>, String> {
    let mut query = conn
        .prepare("SELECT id,kind,date,tags FROM items WHERE id GLOB ?1 ORDER BY id")
        .map_err(storage_error)?;
    let rows = query
        .query_map([format!("digital-activity:{device}:*")], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(storage_error)?;
    let mut ids = Vec::new();
    for row in rows {
        let (id, kind, date, tags) = row.map_err(storage_error)?;
        let Some((_, day)) = identity(&id) else {
            return Err(UNSAFE.into());
        };
        if day > through {
            continue;
        }
        if !exact_row(&id, &kind, date.as_deref(), &tags) {
            return Err(UNSAFE.into());
        }
        // Imported events cannot own task relations or execution. Do not cascade.
        let linked: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM calendar_task_goals WHERE source_id=?1) OR EXISTS(SELECT 1 FROM timeline_blocks WHERE source_id=?1)", [&id], |r| r.get(0)).map_err(storage_error)?;
        if linked {
            return Err(UNSAFE.into());
        }
        ids.push(id);
    }
    Ok(ids)
}

fn remove_rows(conn: &Connection, device: &str, through: &str) -> Result<usize, String> {
    let ids = targets(conn, device, through)?;
    let applying: bool = conn
        .query_row(
            "SELECT applying FROM content_sync_control WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    for id in &ids {
        conn.execute("DELETE FROM items WHERE id=?1", [id])
            .map_err(storage_error)?;
        if applying {
            // Remote/checkpoint projection suppresses item capture. Publish a fresh
            // explicit tombstone for this replica's additional, now-erased rows.
            crate::mvp_sync_db::record_local(conn, "items", vec![json!(id)], Value::Null, true)?;
            let record_id = json!(["items", [id]]).to_string();
            conn.execute("INSERT OR IGNORE INTO content_sync_dirty(table_name,row_id) VALUES('mvp_records',?1)", [record_id]).map_err(storage_error)?;
        }
    }
    conn.execute("UPDATE digital_activity_status SET records=(SELECT count(*) FROM items WHERE id GLOB ?2) WHERE device_id=?1", params![device,format!("digital-activity:{device}:*")]).map_err(storage_error)?;
    Ok(ids.len())
}

pub(crate) fn materialize_marker(conn: &Connection, device: &str) -> Result<(), String> {
    let through = cutoff(conn, device)?.ok_or("digital_activity_invalid_retention")?;
    remove_rows(conn, device, &through)?;
    // Projection is informational; the canonical sync records enforce the rule.
    let mut devices = serde_json::Map::new();
    let mut query = conn.prepare("SELECT data FROM mvp_records WHERE json_extract(data,'$.kind')='ui' AND json_extract(data,'$.key[0]')=?1").map_err(storage_error)?;
    let rows = query
        .query_map([KEY], |r| r.get::<_, String>(0))
        .map_err(storage_error)?;
    for raw in rows {
        let row: Value =
            serde_json::from_str(&raw.map_err(storage_error)?).map_err(storage_error)?;
        let id = row["key"][1]
            .as_str()
            .ok_or("digital_activity_invalid_retention")?;
        if !valid_marker(id, &row["value"], row["deleted"] != false) {
            return Err("digital_activity_invalid_retention".into());
        }
        devices.insert(id.into(), row["value"].clone());
    }
    let value = json!({"version":1,"devices":devices}).to_string();
    conn.execute("INSERT INTO ui_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params![KEY,value,Utc::now().to_rfc3339()]).map_err(storage_error)?;
    Ok(())
}

fn validate_request(conn: &Connection, device: &str, through: &str) -> Result<(), String> {
    validate_id(device)?;
    if !valid_date(through) || through > Local::now().date_naive().to_string().as_str() {
        return Err("digital_activity_invalid_date".into());
    }
    let history: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM items WHERE id GLOB ?1)",
            [format!("digital-activity:{device}:*")],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    if !history
        && cutoff(conn, device)?.is_none()
        && !read_connections(conn)?.iter().any(|v| v.id == device)
    {
        return Err("digital_activity_device_not_found".into());
    }
    Ok(())
}

pub(super) fn preview(conn: &Connection, device: &str, through: &str) -> Result<Value, String> {
    let _guard = CONFIG_LOCK.lock().map_err(storage_error)?;
    let tx = conn.unchecked_transaction().map_err(storage_error)?;
    validate_request(&tx, device, through)?;
    let count = targets(&tx, device, through)?.len();
    let result = json!({"deviceId":device,"throughDate":through,"count":count,"deletedThrough":cutoff(&tx,device)?});
    tx.commit().map_err(storage_error)?;
    Ok(result)
}

pub(crate) fn erase(
    conn: &mut Connection,
    device: &str,
    through: &str,
    expected: Option<usize>,
) -> Result<Value, String> {
    // Never acquire IMPORT_LOCK here: an importer may be waiting on HTTP. Its
    // commit uses CONFIG_LOCK and rechecks the marker in the same transaction.
    let _guard = CONFIG_LOCK.lock().map_err(storage_error)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    validate_request(&tx, device, through)?;
    let count = targets(&tx, device, through)?.len();
    if expected.is_some_and(|n| n != count) {
        return Err("digital_activity_erasure_count_changed".into());
    }
    let prior = cutoff(&tx, device)?;
    let limit = prior.as_deref().map_or(through, |v| v.max(through));
    if prior.as_deref() != Some(limit) {
        crate::mvp_sync_db::record_local(
            &tx,
            "ui",
            vec![json!(KEY), json!(device)],
            json!({"deletedThrough":limit}),
            false,
        )?;
    }
    materialize_marker(&tx, device)?;
    tx.commit().map_err(storage_error)?;
    Ok(json!({"deleted":count,"deletedThrough":limit}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn digital_activity_preview_erasure(
    device_id: String,
    through_date: String,
    state: State<'_, crate::AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(storage_error)?;
    preview(&conn, &device_id, &through_date)
}

#[tauri::command(rename_all = "camelCase")]
pub fn digital_activity_erase_history(
    device_id: String,
    through_date: String,
    expected_count: Option<usize>,
    app: tauri::AppHandle,
    state: State<'_, crate::AppState>,
) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(storage_error)?;
    let result = erase(&mut conn, &device_id, &through_date, expected_count)?;
    let _ = app.emit("digital-activity-updated", &result);
    Ok(result)
}

#[cfg(test)]
#[path = "digital_activity_erasure_tests.rs"]
mod tests;
