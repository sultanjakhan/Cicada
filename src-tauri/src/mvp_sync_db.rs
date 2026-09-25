//! MVP record adapter for the existing encrypted content relay.
//! Source rows keep their original identity; wire records address composite keys
//! and individual JSON records without transporting device settings.
use chrono::{DateTime, Local, SecondsFormat, Utc};
use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

#[path = "mvp_sync_conflicts.rs"]
pub(crate) mod conflicts;

pub(crate) const SYNC_TABLES: &[&str] = &["mvp_records"];
const TABLES: &[(&str, &[&str])] = &[
    ("items", &["id"]),
    ("calendar_goals", &["id"]),
    ("calendar_task_goals", &["source_type", "source_id"]),
    ("event_categories", &["id"]),
    ("timeline_blocks", &["id"]),
];
const UI_KEYS: &[&str] = &[
    "calendar_development_v1",
    "calendar_recurring_v1",
    "calendar_now_v1",
    "calendar_wishes_v1",
    // Task processes (2026-09-25), one record per process. Older versions pause
    // receiving at the first such record until they update (see split_ui).
    "calendar_processes_v1",
];
pub(crate) const DAY_KEY: &str = "calendar_day_start_v1";
pub(crate) fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|_| "mvp_sync_database_failed".into())
}
pub(crate) fn canonical_sync_timestamp(raw: &str, _: &str) -> Result<String, String> {
    DateTime::parse_from_rfc3339(raw)
        .map(|v| {
            v.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
        .map_err(|_| "content_sync_invalid_timestamp".into())
}
pub(crate) fn get_setting_checked(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    sql(conn
        .query_row("SELECT value FROM app_settings WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional())
}
pub(crate) fn column_is_text(_: &Connection, _: &str, _: &str) -> bool {
    true
}
pub(crate) fn row_to_json(
    conn: &Connection,
    _: &str,
    id: &SqlValue,
) -> Result<Option<Value>, String> {
    sql(conn.query_row("SELECT id,data,updated_at FROM mvp_records WHERE id=?1", [id], |r|
        Ok(json!({"id":r.get::<_,String>(0)?,"data":r.get::<_,String>(1)?,"updated_at":r.get::<_,String>(2)?}))).optional())
}
fn exists(conn: &Connection, table: &str) -> Result<bool, String> {
    sql(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |r| r.get(0),
    ))
}
fn columns(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut query = sql(conn.prepare(&format!("PRAGMA table_info({table})")))?;
    let rows = sql(query.query_map([], |r| r.get(1)))?;
    sql(rows.collect())
}
fn key(kind: &str, keys: &[Value]) -> String {
    json!([kind, keys]).to_string()
}
fn clock(conn: &Connection) -> Result<String, String> {
    sql(conn.execute("UPDATE mvp_sync_meta SET clock=MAX(clock+1,CAST(unixepoch('subsec')*1000 AS INTEGER)) WHERE id=1", []))?;
    sql(conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ',clock/1000.0,'unixepoch') FROM mvp_sync_meta WHERE id=1", [], |r|r.get(0)))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    v: u8,
    kind: String,
    key: Vec<Value>,
    value: Value,
    deleted: bool,
    identity: Option<Value>,
    parent: Option<String>,
    parent_writer: Option<String>,
}

pub(crate) fn initialize(conn: &Connection) -> Result<(), String> {
    let tx = sql(conn.unchecked_transaction())?;
    sql(tx.execute_batch("CREATE TABLE IF NOT EXISTS mvp_sync_meta(id INTEGER PRIMARY KEY CHECK(id=1),clock INTEGER NOT NULL DEFAULT 0,last_success TEXT,initialized INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO mvp_sync_meta(id) VALUES(1);
        CREATE TABLE IF NOT EXISTS content_sync_control(id INTEGER PRIMARY KEY CHECK(id=1),applying INTEGER NOT NULL);
        INSERT OR IGNORE INTO content_sync_control VALUES(1,0);
        CREATE TABLE IF NOT EXISTS content_sync_dirty(seq INTEGER PRIMARY KEY AUTOINCREMENT,table_name TEXT NOT NULL,row_id TEXT NOT NULL,UNIQUE(table_name,row_id));
        CREATE TABLE IF NOT EXISTS mvp_records(id TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sync_row_versions(table_name TEXT NOT NULL,row_id TEXT NOT NULL,updated_at TEXT NOT NULL,device_id TEXT NOT NULL,PRIMARY KEY(table_name,row_id));
        CREATE TABLE IF NOT EXISTS sync_tombstones(table_name TEXT NOT NULL,row_id TEXT NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(table_name,row_id));
        CREATE TABLE IF NOT EXISTS mvp_sync_conflicts(id TEXT NOT NULL,stamp TEXT NOT NULL,writer TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,stamp,writer));
        CREATE TABLE IF NOT EXISTS mvp_sync_conflict_resolutions(id TEXT NOT NULL,stamp TEXT NOT NULL,writer TEXT NOT NULL,payload_hash TEXT NOT NULL,choice TEXT NOT NULL,resolved_at TEXT NOT NULL,PRIMARY KEY(id,stamp,writer,payload_hash));
        CREATE TABLE IF NOT EXISTS mvp_sync_resolution_archive(id TEXT NOT NULL,stamp TEXT NOT NULL,writer TEXT NOT NULL,payload_hash TEXT NOT NULL,data TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(id,stamp,writer,payload_hash));
        CREATE TABLE IF NOT EXISTS mvp_day_starts(id TEXT PRIMARY KEY,started_at_utc TEXT NOT NULL);
        DROP TRIGGER IF EXISTS mvp_records_insert;
        CREATE TRIGGER mvp_records_insert AFTER INSERT ON mvp_records WHEN (SELECT applying FROM content_sync_control WHERE id=1)=0 BEGIN DELETE FROM content_sync_dirty WHERE table_name='mvp_records' AND row_id=NEW.id; INSERT INTO content_sync_dirty(table_name,row_id) VALUES('mvp_records',NEW.id); END;
        DROP TRIGGER IF EXISTS mvp_records_update;
        CREATE TRIGGER mvp_records_update AFTER UPDATE ON mvp_records WHEN (SELECT applying FROM content_sync_control WHERE id=1)=0 BEGIN DELETE FROM content_sync_dirty WHERE table_name='mvp_records' AND row_id=NEW.id; INSERT INTO content_sync_dirty(table_name,row_id) VALUES('mvp_records',NEW.id); END;"))?;
    sql(tx.execute(
        "INSERT OR IGNORE INTO app_settings(key,value,updated_at) VALUES('device_id',?1,?2)",
        params![uuid::Uuid::new_v4().to_string(), Utc::now().to_rfc3339()],
    ))?;
    let initialized: bool = sql(tx.query_row(
        "SELECT initialized FROM mvp_sync_meta WHERE id=1",
        [],
        |r| r.get(0),
    ))?;
    for &(table, keys) in TABLES {
        if !exists(&tx, table)? {
            continue;
        }
        let fields = columns(&tx, table)?;
        for (action, alias, deleted) in [
            ("INSERT", "NEW", false),
            ("UPDATE", "NEW", false),
            ("DELETE", "OLD", true),
        ] {
            let row_json = if deleted {
                "NULL".into()
            } else {
                format!(
                    "json_object({})",
                    fields
                        .iter()
                        .map(|f| format!("'{f}',{alias}.{f}"))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            };
            let keys_json = format!(
                "json_array({})",
                keys.iter()
                    .map(|f| format!("{alias}.{f}"))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            let record_id = format!("json_array('{table}',{keys_json})");
            let stamp="(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',clock/1000.0,'unixepoch') FROM mvp_sync_meta WHERE id=1)";
            let identity = if table == "timeline_blocks" {
                format!("json_array({alias}.created_at,{alias}.source_type,{alias}.source_id)")
            } else {
                "NULL".into()
            };
            let body=format!("UPDATE mvp_sync_meta SET clock=MAX(clock+1,CAST(unixepoch('subsec')*1000 AS INTEGER)) WHERE id=1;
                INSERT INTO mvp_records(id,data,updated_at) VALUES({record_id},json_object('v',1,'kind','{table}','key',{keys_json},'value',{row_json},'deleted',json('{}'),'identity',{identity},'parent',(SELECT updated_at FROM mvp_records WHERE id={record_id}),'parent_writer',(SELECT device_id FROM sync_row_versions WHERE table_name='mvp_records' AND row_id={record_id})),{stamp}) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at;
                INSERT INTO sync_row_versions(table_name,row_id,updated_at,device_id) VALUES('mvp_records',{record_id},{stamp},(SELECT value FROM app_settings WHERE key='device_id')) ON CONFLICT(table_name,row_id) DO UPDATE SET updated_at=excluded.updated_at,device_id=excluded.device_id;",if deleted {"true"} else {"false"});
            sql(tx.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS mvp_capture_{table}_{action} AFTER {action} ON {table} WHEN (SELECT applying FROM content_sync_control WHERE id=1)=0 BEGIN {body} END;")))?;
        }
        if !initialized {
            let mut query = sql(tx.prepare(&format!("SELECT {} FROM {table}", fields.join(","))))?;
            let rows = sql(query.query_map([], |r| {
                let mut value = Map::new();
                for (i, name) in fields.iter().enumerate() {
                    value.insert(name.clone(), sql_json(r.get::<_, SqlValue>(i)?));
                }
                Ok(value)
            }))?;
            for row in rows {
                let row = sql(row)?;
                record_local(
                    &tx,
                    table,
                    keys.iter().map(|k| row[*k].clone()).collect(),
                    Value::Object(row),
                    false,
                )?;
            }
        }
    }
    if exists(&tx, "ui_state")? && !initialized {
        if let Some(raw) = read_ui(&tx, DAY_KEY)? {
            merge_day_ledger(&tx, &raw)?;
        }
        for name in UI_KEYS {
            if let Some(raw) = read_ui(&tx, name)? {
                let value = parse(&raw)?;
                for (path, value) in split_ui(name, &value)? {
                    record_local(&tx, "ui", parse_keys(&path)?, value, false)?;
                }
            }
        }
    }
    sql(tx.execute("UPDATE mvp_sync_meta SET initialized=1 WHERE id=1", []))?;
    sql(tx.pragma_update(None, "user_version", crate::SCHEMA_VERSION))?;
    sql(tx.commit())
}

fn sql_json(value: SqlValue) -> Value {
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(v) => json!(v),
        SqlValue::Real(v) => json!(v),
        SqlValue::Text(v) => json!(v),
        SqlValue::Blob(_) => Value::Null,
    }
}
fn parse(raw: &str) -> Result<Value, String> {
    serde_json::from_str(raw).map_err(|_| "mvp_sync_invalid_json".into())
}
fn parse_keys(raw: &str) -> Result<Vec<Value>, String> {
    serde_json::from_str(raw).map_err(|_| "mvp_sync_invalid_key".into())
}
fn record_local(
    conn: &Connection,
    kind: &str,
    keys: Vec<Value>,
    value: Value,
    deleted: bool,
) -> Result<(), String> {
    let id = key(kind, &keys);
    let parent: Option<(String,String)>=sql(conn.query_row("SELECT updated_at,device_id FROM sync_row_versions WHERE table_name='mvp_records' AND row_id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?))).optional())?;
    let identity = if kind == "timeline_blocks" {
        Some(json!([
            value["created_at"],
            value["source_type"],
            value["source_id"]
        ]))
    } else {
        None
    };
    let record = Record {
        v: 1,
        kind: kind.into(),
        key: keys,
        value,
        deleted,
        identity,
        parent: parent.as_ref().map(|p| p.0.clone()),
        parent_writer: parent.map(|p| p.1),
    };
    let stamp = clock(conn)?;
    let writer = get_setting_checked(conn, "device_id")?.ok_or("mvp_sync_missing_writer")?;
    store(conn, &id, &record, &stamp, &writer)
}
fn store(
    conn: &Connection,
    id: &str,
    record: &Record,
    stamp: &str,
    writer: &str,
) -> Result<(), String> {
    let data = serde_json::to_string(record).map_err(|_| "mvp_sync_encode_failed")?;
    sql(conn.execute("INSERT INTO mvp_records VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",params![id,data,stamp]))?;
    sql(conn.execute("INSERT INTO sync_row_versions VALUES('mvp_records',?1,?2,?3) ON CONFLICT(table_name,row_id) DO UPDATE SET updated_at=excluded.updated_at,device_id=excluded.device_id",params![id,stamp,writer]))?;
    Ok(())
}
fn decoded(fields: &Map<String, Value>) -> Result<(String, Record, String, String), String> {
    if fields.len() != 5
        || !["id", "data", "updated_at", "_updated_at", "_device_id"]
            .iter()
            .all(|k| fields.contains_key(*k))
    {
        return Err("content_sync_unknown_schema".into());
    }
    let get = |k: &str| {
        fields
            .get(k)
            .and_then(Value::as_str)
            .ok_or_else(|| "content_sync_unknown_schema".to_string())
    };
    let record: Record =
        serde_json::from_str(get("data")?).map_err(|_| "content_sync_unknown_schema")?;
    let id = get("id")?.to_owned();
    if record.v != 1
        || id != key(&record.kind, &record.key)
        || record.key.len() > 8
        || record.key.is_empty()
        || record.key.iter().any(|v| !v.is_string() && !v.is_i64())
    {
        return Err("content_sync_unknown_schema".into());
    }
    let stamp = canonical_sync_timestamp(get("updated_at")?, "")?;
    if stamp != canonical_sync_timestamp(get("_updated_at")?, "")? {
        return Err("content_sync_invalid_timestamp".into());
    }
    let writer = get("_device_id")?.to_owned();
    if writer.is_empty() || writer.len() > 128 {
        return Err("content_sync_unknown_schema".into());
    }
    if let Some(parent) = &record.parent {
        canonical_sync_timestamp(parent, "")?;
    }
    Ok((id, record, stamp, writer))
}
pub(crate) fn validate_record(
    conn: &Connection,
    fields: &Map<String, Value>,
) -> Result<(), String> {
    let (_, record, _, _) = decoded(fields)?;
    match record.kind.as_str() {
        "day" => {
            if record.key.len() != 1
                || record.deleted
                || record.key[0].as_str() != record.value["id"].as_str()
            {
                return Err("content_sync_unknown_schema".into());
            }
            day_entry(&record.value)?;
        }
        "ui" => {
            validate_ui_record(&record)?;
        }
        table => {
            let (_, keys) = TABLES
                .iter()
                .find(|(name, _)| *name == table)
                .ok_or("content_sync_unknown_schema")?;
            if !exists(conn, table)? || record.key.len() != keys.len() {
                return Err("content_sync_unknown_schema".into());
            }
            if table == "timeline_blocks" {
                if !record.key[0].is_i64() {
                    return Err("content_sync_unknown_schema".into());
                }
            } else if record
                .key
                .iter()
                .any(|v| v.as_str().is_none_or(str::is_empty))
            {
                return Err("content_sync_unknown_schema".into());
            }
            if table == "timeline_blocks" {
                let identity = record
                    .identity
                    .as_ref()
                    .and_then(Value::as_array)
                    .ok_or("content_sync_unknown_schema")?;
                if identity.len() != 3 || !identity.iter().all(Value::is_string) {
                    return Err("content_sync_unknown_schema".into());
                }
                if !record.deleted
                    && record.identity
                        != Some(json!([
                            record.value["created_at"],
                            record.value["source_type"],
                            record.value["source_id"]
                        ]))
                {
                    return Err("content_sync_unknown_schema".into());
                }
            }
            if !record.deleted {
                let object = record
                    .value
                    .as_object()
                    .ok_or("content_sync_unknown_schema")?;
                let expected = columns(conn, table)?;
                if object.len() != expected.len()
                    || !expected.iter().all(|c| object.contains_key(c))
                {
                    return Err("content_sync_unknown_schema".into());
                }
                for (i, name) in keys.iter().enumerate() {
                    if object[*name] != record.key[i] {
                        return Err("content_sync_unknown_schema".into());
                    }
                }
                if object.values().any(|v| v.is_object() || v.is_array()) {
                    return Err("content_sync_unknown_schema".into());
                }
            }
        }
    }
    Ok(())
}
fn keep_conflict(
    conn: &Connection,
    id: &str,
    stamp: &str,
    writer: &str,
    record: &Record,
) -> Result<(), String> {
    if conflicts::was_resolved(conn, id, stamp, writer, record)? {
        return Ok(());
    }
    sql(conn.execute(
        "INSERT OR IGNORE INTO mvp_sync_conflicts VALUES(?1,?2,?3,?4)",
        params![
            id,
            stamp,
            writer,
            serde_json::to_string(record).map_err(|_| "mvp_sync_encode_failed")?
        ],
    ))?;
    Ok(())
}
pub(crate) fn checkpoint_conflicts(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = sql(conn
        .prepare("SELECT id,stamp,writer,data FROM mvp_sync_conflicts UNION SELECT id,stamp,writer,data FROM mvp_sync_resolution_archive ORDER BY id,stamp,writer"))?;
    let rows = sql(statement.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"stamp":r.get::<_,String>(1)?,"writer":r.get::<_,String>(2)?,"data":r.get::<_,String>(3)?}))))?;
    sql(rows.collect())
}
pub(crate) fn checkpoint_publishable(conn: &Connection) -> Result<bool, String> {
    // A local dismissal cannot certify that this primary materialized the shared prefix.
    // Older receipts without retained payload/provenance also cannot provide that proof.
    sql(conn.query_row("SELECT NOT EXISTS(SELECT 1 FROM mvp_sync_conflict_resolutions r LEFT JOIN mvp_sync_resolution_archive a ON a.id=r.id AND a.stamp=r.stamp AND a.writer=r.writer AND a.payload_hash=r.payload_hash WHERE a.id IS NULL OR a.source NOT IN ('archive','pending') OR (r.choice='current' AND a.source='pending'))",[],|r|r.get(0)))
}
pub(crate) fn checkpoint_merge_conflict(conn: &Connection, value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or("content_sync_unknown_schema")?;
    if object.len() != 4 {
        return Err("content_sync_unknown_schema".into());
    }
    let get = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .ok_or("content_sync_unknown_schema")
    };
    let (id, stamp, writer, data) = (get("id")?, get("stamp")?, get("writer")?, get("data")?);
    let fields =
        json!({"id":id,"data":data,"updated_at":stamp,"_updated_at":stamp,"_device_id":writer});
    validate_record(conn, fields.as_object().unwrap())?;
    let (_, record, stamp, writer) = decoded(fields.as_object().unwrap())?;
    let prior: Option<String> = sql(conn
        .query_row(
            "SELECT data FROM mvp_sync_conflicts WHERE id=?1 AND stamp=?2 AND writer=?3",
            params![id, stamp, writer],
            |r| r.get(0),
        )
        .optional())?;
    if let Some(prior) = prior {
        let prior: Value =
            serde_json::from_str(&prior).map_err(|_| "mvp_sync_invalid_local_record")?;
        let incoming: Value =
            serde_json::from_str(data).map_err(|_| "content_sync_unknown_schema")?;
        if prior != incoming {
            return Err("content_sync_version_conflict".into());
        }
    }
    keep_conflict(conn, id, &stamp, &writer, &record)
}
pub(crate) fn apply_record(conn: &Connection, fields: &Map<String, Value>) -> Result<bool, String> {
    validate_record(conn, fields)?;
    let (id, record, stamp, writer) = decoded(fields)?;
    if conflicts::was_resolved(conn, &id, &stamp, &writer, &record)? {
        return Ok(false);
    }
    let prior:Option<(String,String,String)>=sql(conn.query_row("SELECT r.data,r.updated_at,v.device_id FROM mvp_records r JOIN sync_row_versions v ON v.table_name='mvp_records' AND v.row_id=r.id WHERE r.id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional())?;
    if let Some((data, local_stamp, local_writer)) = prior {
        let local: Record =
            serde_json::from_str(&data).map_err(|_| "mvp_sync_invalid_local_record")?;
        if record.kind == "timeline_blocks" && record.identity != local.identity {
            return Err("content_sync_legacy_identity_collision".into());
        }
        let mut local_value = local.value.clone();
        let mut remote_value = record.value.clone();
        if record.kind == "event_categories" && record.key == vec![json!("general")] {
            if let Some(v) = local_value.as_object_mut() {
                v.remove("created_at");
            }
            if let Some(v) = remote_value.as_object_mut() {
                v.remove("created_at");
            }
        }
        let different = local.deleted != record.deleted || local_value != remote_value;
        if (stamp.as_str(), writer.as_str()) == (local_stamp.as_str(), local_writer.as_str()) {
            if different {
                return Err("content_sync_version_conflict".into());
            }
            return Ok(false);
        }
        let follows = record.parent.as_deref() == Some(&local_stamp)
            && record.parent_writer.as_deref() == Some(&local_writer);
        let precedes = local.parent.as_deref() == Some(&stamp)
            && local.parent_writer.as_deref() == Some(&writer);
        let wins =
            (stamp.as_str(), writer.as_str()) > (local_stamp.as_str(), local_writer.as_str());
        if different && !follows && !precedes {
            if wins {
                keep_conflict(conn, &id, &local_stamp, &local_writer, &local)?;
            } else {
                keep_conflict(conn, &id, &stamp, &writer, &record)?;
            }
        }
        if !wins {
            return Ok(false);
        }
    }
    let milliseconds = DateTime::parse_from_rfc3339(&stamp)
        .map_err(|_| "content_sync_invalid_timestamp")?
        .timestamp_millis();
    sql(conn.execute(
        "UPDATE mvp_sync_meta SET clock=MAX(clock,?1) WHERE id=1",
        [milliseconds],
    ))?;
    store(conn, &id, &record, &stamp, &writer)?;
    materialize(conn, &record)?;
    Ok(true)
}
fn materialize(conn: &Connection, record: &Record) -> Result<(), String> {
    match record.kind.as_str() {
        "day" => {
            let (id, stamp) = day_entry(&record.value)?;
            let existing: Option<String> = sql(conn
                .query_row(
                    "SELECT started_at_utc FROM mvp_day_starts WHERE id=?1",
                    [&id],
                    |r| r.get(0),
                )
                .optional())?;
            if existing.is_some_and(|v| v != stamp) {
                return Err("content_sync_day_identity_conflict".into());
            }
            sql(conn.execute(
                "INSERT OR IGNORE INTO mvp_day_starts VALUES(?1,?2)",
                params![id, stamp],
            ))?;
            write_day_projection(conn)?;
        }
        "ui" => apply_ui_record(conn, record)?,
        table => {
            check_relations(conn, record)?;
            let (_, keys) = TABLES
                .iter()
                .find(|(t, _)| *t == table)
                .ok_or("content_sync_unknown_schema")?;
            if record.deleted {
                sql(conn.execute(
                    &format!(
                        "DELETE FROM {table} WHERE {}",
                        keys.iter()
                            .enumerate()
                            .map(|(i, k)| format!("{k}=?{}", i + 1))
                            .collect::<Vec<_>>()
                            .join(" AND ")
                    ),
                    rusqlite::params_from_iter(
                        record
                            .key
                            .iter()
                            .map(json_sql)
                            .collect::<Result<Vec<_>, _>>()?,
                    ),
                ))?;
            } else {
                let mut row = record
                    .value
                    .as_object()
                    .ok_or("content_sync_unknown_schema")?
                    .clone();
                if table == "items" {
                    let local: Option<i64> = sql(conn
                        .query_row(
                            "SELECT version FROM items WHERE id=?1",
                            [record.key[0]
                                .as_str()
                                .ok_or("content_sync_unknown_schema")?],
                            |r| r.get(0),
                        )
                        .optional())?;
                    if let Some(local) = local {
                        let incoming = row["version"]
                            .as_i64()
                            .ok_or("content_sync_unknown_schema")?;
                        let next = local
                            .max(incoming)
                            .checked_add(1)
                            .ok_or("content_sync_version_exhausted")?;
                        row.insert("version".into(), json!(next));
                    }
                }
                let fields: Vec<_> = row.keys().cloned().collect();
                let updates = fields
                    .iter()
                    .filter(|f| !keys.contains(&f.as_str()))
                    .map(|f| format!("{f}=excluded.{f}"))
                    .collect::<Vec<_>>()
                    .join(",");
                let statement = format!(
                    "INSERT INTO {table}({}) VALUES({}) ON CONFLICT({}) DO UPDATE SET {updates}",
                    fields.join(","),
                    (1..=fields.len())
                        .map(|i| format!("?{i}"))
                        .collect::<Vec<_>>()
                        .join(","),
                    keys.join(",")
                );
                sql(conn.execute(
                    &statement,
                    rusqlite::params_from_iter(
                        fields
                            .iter()
                            .map(|f| json_sql(&row[f]))
                            .collect::<Result<Vec<_>, _>>()?,
                    ),
                ))?;
            }
        }
    }
    Ok(())
}
fn check_relations(conn: &Connection, record: &Record) -> Result<(), String> {
    let exists = |table: &str, id: &Value| -> Result<bool, String> {
        sql(conn.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1)"),
            [json_sql(id)?],
            |r| r.get(0),
        ))
    };
    if record.kind == "calendar_goals" {
        let id = record.key[0]
            .as_str()
            .ok_or("content_sync_unknown_schema")?;
        if record.deleted {
            let dependents:bool=sql(conn.query_row("SELECT EXISTS(SELECT 1 FROM calendar_goals WHERE parent_goal_id=?1) OR EXISTS(SELECT 1 FROM calendar_task_goals WHERE goal_id=?1)",[id],|r|r.get(0)))?;
            if dependents {
                return Err("content_sync_dependent_records".into());
            }
        } else {
            let mut parent = record.value["parent_goal_id"].as_str().map(str::to_owned);
            let mut seen = std::collections::HashSet::new();
            seen.insert(id.to_string());
            while let Some(current) = parent {
                if !seen.insert(current.clone()) {
                    return Err("content_sync_goal_cycle".into());
                }
                let row: Option<(Option<String>, String)> = sql(conn
                    .query_row(
                        "SELECT parent_goal_id,goal_kind FROM calendar_goals WHERE id=?1",
                        [&current],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional())?;
                let Some((next, kind)) = row else {
                    return Err("content_sync_parent_missing".into());
                };
                if kind == "daily_norm" {
                    return Err("content_sync_invalid_parent".into());
                }
                parent = next;
            }
        }
    } else if record.kind == "calendar_task_goals" && !record.deleted {
        if !exists("calendar_goals", &record.value["goal_id"])?
            || !exists("items", &record.value["source_id"])?
        {
            return Err("content_sync_parent_missing".into());
        }
        let source = record.value["source_type"]
            .as_str()
            .ok_or("content_sync_unknown_schema")?;
        let expected = match source {
            "note" => "task",
            "event" => "event",
            _ => return Err("content_sync_unknown_schema".into()),
        };
        let actual: String = sql(conn.query_row(
            "SELECT kind FROM items WHERE id=?1",
            [json_sql(&record.value["source_id"])?],
            |r| r.get(0),
        ))?;
        if actual != expected {
            return Err("content_sync_invalid_relation".into());
        }
    } else if record.kind == "items" && record.deleted {
        let linked: bool = sql(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM calendar_task_goals WHERE source_id=?1)",
            [json_sql(&record.key[0])?],
            |r| r.get(0),
        ))?;
        if linked {
            return Err("content_sync_dependent_records".into());
        }
    }
    Ok(())
}
fn json_sql(value: &Value) -> Result<SqlValue, String> {
    match value {
        Value::Null => Ok(SqlValue::Null),
        Value::Bool(v) => Ok(SqlValue::Integer(i64::from(*v))),
        Value::Number(v) => v
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| v.as_f64().map(SqlValue::Real))
            .ok_or("content_sync_invalid_value".into()),
        Value::String(v) => Ok(SqlValue::Text(v.clone())),
        _ => Err("content_sync_invalid_value".into()),
    }
}

pub(crate) fn read_ui(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    sql(conn
        .query_row("SELECT value FROM ui_state WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional())
}
fn write_ui(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    sql(conn.execute("INSERT INTO ui_state VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",params![key,value,Utc::now().to_rfc3339()]))?;
    Ok(())
}
pub(crate) fn set_ui(
    conn: &Connection,
    key: &str,
    value: &str,
    expected: Option<&str>,
) -> Result<(), String> {
    let tx = sql(conn.unchecked_transaction())?;
    set_ui_in_transaction(&tx, key, value, expected)?;
    sql(tx.commit())
}
pub(crate) fn set_ui_in_transaction(
    tx: &Transaction<'_>,
    key: &str,
    value: &str,
    expected: Option<&str>,
) -> Result<(), String> {
    let prior = read_ui(&tx, key)?;
    if let Some(expected) = expected {
        if prior.as_deref().unwrap_or("") != expected {
            return Err("mvp_sync_stale_ui_state".into());
        }
    }
    if key == DAY_KEY {
        merge_day_ledger(&tx, value)?;
    } else {
        if UI_KEYS.contains(&key) {
            let next = split_ui(key, &parse(value)?)?;
            let old = match prior.as_ref() {
                Some(raw) => split_ui(key, &parse(raw)?)?,
                None => BTreeMap::new(),
            };
            for (path, record) in &next {
                if old.get(path) != Some(record) {
                    record_local(&tx, "ui", parse_keys(path)?, record.clone(), false)?;
                }
            }
            for path in old.keys() {
                if !next.contains_key(path) {
                    record_local(&tx, "ui", parse_keys(path)?, Value::Null, true)?;
                }
            }
        }
        write_ui(&tx, key, value)?;
    }
    Ok(())
}
fn object(value: &Value) -> Result<&Map<String, Value>, String> {
    value.as_object().ok_or("mvp_sync_invalid_snapshot".into())
}
fn array(value: &Value) -> Result<&Vec<Value>, String> {
    value.as_array().ok_or("mvp_sync_invalid_snapshot".into())
}
fn split_ui(name: &str, value: &Value) -> Result<BTreeMap<String, Value>, String> {
    let mut out = BTreeMap::new();
    if name == "calendar_now_v1" {
        object(value)?;
        out.insert(json!([name]).to_string(), value.clone());
        return Ok(out);
    }
    if value["version"] != 1 {
        return Err("mvp_sync_invalid_snapshot".into());
    }
    if name == "calendar_development_v1" {
        for (goal, data) in object(&value["goals"])? {
            let mut meta = object(data)?.clone();
            meta.remove("skills");
            meta.remove("stages");
            out.insert(json!([name, goal, "meta"]).to_string(), Value::Object(meta));
            for field in ["skills", "stages"] {
                for (position, row) in array(&data[field])?.iter().enumerate() {
                    let id = row["id"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("mvp_sync_invalid_snapshot")?;
                    if out
                        .insert(
                            json!([name, goal, field, id]).to_string(),
                            json!({"position":position,"row":row}),
                        )
                        .is_some()
                    {
                        return Err("mvp_sync_invalid_snapshot".into());
                    }
                }
            }
        }
    } else if name == "calendar_wishes_v1" {
        // One record per wish, so edits of different wishes on two devices merge.
        for (position, row) in array(&value["wishes"])?.iter().enumerate() {
            let id = row["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 128)
                .ok_or("mvp_sync_invalid_snapshot")?;
            if out
                .insert(
                    json!([name, "wishes", id]).to_string(),
                    json!({"position":position,"row":row}),
                )
                .is_some()
            {
                return Err("mvp_sync_invalid_snapshot".into());
            }
        }
    } else if name == "calendar_processes_v1" {
        // One record per process: edits of different processes on two devices
        // merge, and a process edited on both keeps the newer version with the
        // other one in conflict review. The built-in process is not stored until
        // the owner saves the editor, so nothing is sent before that. A 0.3.33 or
        // older replica does not know this key: it rejects the page that carries
        // the record (content_sync_unknown_schema) and keeps its receive cursor
        // there, so it stops receiving (it still uploads) until it is updated,
        // then resumes from that page without losing anything.
        for (position, row) in array(&value["processes"])?.iter().enumerate() {
            if !process_row(row) {
                return Err("mvp_sync_invalid_snapshot".into());
            }
            let id = row["id"].as_str().unwrap_or_default();
            if out
                .insert(
                    json!([name, "processes", id]).to_string(),
                    json!({"position":position,"row":row}),
                )
                .is_some()
            {
                return Err("mvp_sync_invalid_snapshot".into());
            }
        }
    } else if name == "calendar_recurring_v1" {
        for (position, row) in array(&value["plans"])?.iter().enumerate() {
            let id = row["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("mvp_sync_invalid_snapshot")?;
            if out
                .insert(
                    json!([name, "plans", id]).to_string(),
                    json!({"position":position,"row":row}),
                )
                .is_some()
            {
                return Err("mvp_sync_invalid_snapshot".into());
            }
        }
        for (day, rows) in object(&value["days"])? {
            crate::validate_date(day)?;
            for (id, row) in object(rows)? {
                if row["snapshot"]["id"].as_str() != Some(id) {
                    return Err("mvp_sync_invalid_snapshot".into());
                }
                out.insert(json!([name, "days", day, id]).to_string(), row.clone());
            }
        }
    } else {
        return Err("mvp_sync_invalid_snapshot".into());
    }
    Ok(out)
}
/// A process: a well-formed id, a name and 1–50 stages with unique ids and
/// names. Other fields are kept, so a newer version may add them.
fn process_row(row: &Value) -> bool {
    let text = |value: &Value| value.as_str().is_some_and(|v| !v.trim().is_empty() && v.chars().count() <= 200);
    let Some(stages) = row["stages"].as_array() else {
        return false;
    };
    let mut seen = std::collections::HashSet::new();
    row["id"].as_str().is_some_and(crate::task_attributes::valid_id)
        && text(&row["title"])
        && (1..=50).contains(&stages.len())
        && stages.iter().all(|stage| {
            stage["id"].as_str().is_some_and(|id| crate::task_attributes::valid_id(id) && seen.insert(id.to_owned()))
                && text(&stage["title"])
        })
}
fn validate_ui_record(record: &Record) -> Result<(), String> {
    let keys: Vec<_> = record
        .key
        .iter()
        .map(|v| v.as_str().ok_or("content_sync_unknown_schema"))
        .collect::<Result<_, _>>()?;
    let valid = match keys.as_slice() {
        ["calendar_now_v1"] => !record.deleted && record.value.is_object(),
        ["calendar_development_v1", goal, "meta"] => {
            !goal.is_empty() && (record.deleted || record.value.is_object())
        }
        ["calendar_development_v1", goal, field, id] => {
            !goal.is_empty()
                && matches!(*field, "skills" | "stages")
                && !id.is_empty()
                && (record.deleted
                    || (record.value["row"]["id"] == *id && record.value["position"].is_u64()))
        }
        ["calendar_wishes_v1", "wishes", id] => {
            !id.is_empty()
                && id.len() <= 128
                && (record.deleted
                    || (record.value["row"]["id"] == *id && record.value["position"].is_u64()))
        }
        ["calendar_processes_v1", "processes", id] => {
            crate::task_attributes::valid_id(id)
                && (record.deleted
                    || (record.value["row"]["id"] == *id
                        && record.value["position"].is_u64()
                        && process_row(&record.value["row"])))
        }
        ["calendar_recurring_v1", "plans", id] => {
            !id.is_empty()
                && (record.deleted
                    || (record.value["row"]["id"] == *id && record.value["position"].is_u64()))
        }
        ["calendar_recurring_v1", "days", day, id] => {
            crate::validate_date(day).is_ok()
                && !id.is_empty()
                && (record.deleted || record.value["snapshot"]["id"] == *id)
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("content_sync_unknown_schema".into())
    }
}
fn apply_ui_record(conn: &Connection, record: &Record) -> Result<(), String> {
    let name = record.key[0]
        .as_str()
        .ok_or("content_sync_unknown_schema")?;
    if name == "calendar_now_v1" {
        return write_ui(conn, name, &record.value.to_string());
    }
    let mut state = if name == "calendar_development_v1" {
        json!({"version":1,"goals":{}})
    } else if name == "calendar_wishes_v1" {
        json!({"version":1,"wishes":[]})
    } else if name == "calendar_processes_v1" {
        json!({"version":1,"processes":[]})
    } else {
        json!({"version":1,"plans":[],"days":{}})
    };
    let mut query=sql(conn.prepare("SELECT data FROM mvp_records WHERE json_extract(data,'$.kind')='ui' AND json_extract(data,'$.key[0]')=?1 ORDER BY id"))?;
    let mapped = sql(query.query_map([name], |r| r.get::<_, String>(0)))?;
    let mut records = Vec::new();
    for raw in mapped {
        let data: Record =
            serde_json::from_str(&sql(raw)?).map_err(|_| "mvp_sync_invalid_snapshot")?;
        if !data.deleted {
            records.push(data);
        }
    }
    // A shared ordinal plus stable record ID converges after simultaneous inserts.
    records.sort_by(|a, b| {
        a.value["position"]
            .as_u64()
            .unwrap_or(0)
            .cmp(&b.value["position"].as_u64().unwrap_or(0))
            .then_with(|| {
                a.key
                    .to_vec()
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .cmp(&b.key.iter().map(Value::to_string).collect::<Vec<_>>())
            })
    });
    for row in records {
        let keys: Vec<_> = row.key.iter().map(|v| v.as_str().unwrap_or("")).collect();
        if name == "calendar_development_v1" {
            let goal = keys[1];
            if state["goals"].get(goal).is_none() {
                state["goals"][goal] =
                    json!({"skills":[],"stages":[],"activeStageId":null,"focusId":null});
            }
            if keys[2] == "meta" {
                for (k, v) in object(&row.value)? {
                    state["goals"][goal][k] = v.clone();
                }
            } else {
                state["goals"][goal][keys[2]]
                    .as_array_mut()
                    .ok_or("mvp_sync_invalid_snapshot")?
                    .push(row.value["row"].clone());
            }
        } else if name == "calendar_wishes_v1" {
            state["wishes"]
                .as_array_mut()
                .ok_or("mvp_sync_invalid_snapshot")?
                .push(row.value["row"].clone());
        } else if name == "calendar_processes_v1" {
            state["processes"]
                .as_array_mut()
                .ok_or("mvp_sync_invalid_snapshot")?
                .push(row.value["row"].clone());
        } else if keys[1] == "plans" {
            state["plans"]
                .as_array_mut()
                .unwrap()
                .push(row.value["row"].clone());
        } else {
            if state["days"].get(keys[2]).is_none() {
                state["days"][keys[2]] = json!({});
            }
            state["days"][keys[2]][keys[3]] = row.value.clone();
        }
    }
    write_ui(conn, name, &state.to_string())
}
fn day_entry(value: &Value) -> Result<(String, String), String> {
    let id = value["id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or("mvp_sync_invalid_day")?;
    let raw = value["started_at_utc"]
        .as_str()
        .ok_or("mvp_sync_invalid_day")?;
    DateTime::parse_from_rfc3339(raw).map_err(|_| "mvp_sync_invalid_day")?;
    Ok((id.into(), raw.into()))
}
fn merge_day_ledger(conn: &Connection, raw: &str) -> Result<(), String> {
    let value = parse(raw)?;
    if value["version"] != 1 {
        return Err("mvp_sync_invalid_day".into());
    }
    for entry in array(&value["entries"])? {
        let (id, stamp) = day_entry(entry)?;
        let previous: Option<String> = sql(conn
            .query_row(
                "SELECT started_at_utc FROM mvp_day_starts WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional())?;
        if let Some(previous) = previous {
            if previous != stamp {
                return Err("mvp_sync_day_identity_conflict".into());
            }
        } else {
            sql(conn.execute(
                "INSERT INTO mvp_day_starts VALUES(?1,?2)",
                params![id, stamp],
            ))?;
            record_local(
                conn,
                "day",
                vec![json!(id)],
                json!({"id":id,"started_at_utc":stamp}),
                false,
            )?;
        }
    }
    write_day_projection(conn)
}
pub(crate) fn day_ledger(conn: &Connection) -> Result<Value, String> {
    let mut query = sql(
        conn.prepare("SELECT id,started_at_utc FROM mvp_day_starts ORDER BY started_at_utc,id")
    )?;
    let rows = sql(query.query_map([], |r| {
        Ok(json!({"id":r.get::<_,String>(0)?,"started_at_utc":r.get::<_,String>(1)?}))
    }))?;
    Ok(json!({"version":1,"entries":sql(rows.collect::<Result<Vec<_>,_>>())?}))
}
fn write_day_projection(conn: &Connection) -> Result<(), String> {
    write_ui(conn, DAY_KEY, &day_ledger(conn)?.to_string())
}
pub(crate) fn start_day(conn: &Connection) -> Result<Value, String> {
    let tx = sql(conn.unchecked_transaction())?;
    let ledger = day_ledger(&tx)?;
    let today = Local::now().date_naive();
    let started = ledger["entries"].as_array().unwrap().iter().any(|entry| {
        entry["started_at_utc"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .is_some_and(|d| d.with_timezone(&Local).date_naive() == today)
    });
    if !started {
        let entry = json!({"id":uuid::Uuid::new_v4().to_string(),"started_at_utc":Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true)});
        merge_day_ledger(&tx, &json!({"version":1,"entries":[entry]}).to_string())?;
    }
    let ledger = day_ledger(&tx)?;
    sql(tx.commit())?;
    Ok(ledger)
}
/// Same JavaScript-safe random INTEGER range used by Hanni's sync allocator.
pub(crate) fn timeline_id(conn: &Connection) -> Result<i64, String> {
    for _ in 0..16 {
        let bytes = uuid::Uuid::new_v4().into_bytes();
        let random = u64::from_be_bytes(bytes[8..].try_into().unwrap()) & ((1_u64 << 52) - 1);
        let id = ((1_u64 << 52) | random) as i64;
        let exists: bool = sql(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_blocks WHERE id=?1)",
            [id],
            |r| r.get(0),
        ))?;
        if !exists {
            return Ok(id);
        }
    }
    Err("mvp_sync_identity_allocation_failed".into())
}
