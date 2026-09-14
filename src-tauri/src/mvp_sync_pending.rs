//! Durable, local-only quarantine for one ambiguous incoming content record.
//! The transport decides when to retry; this module never sends its payload.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

const MAX_ENTRIES: i64 = 4096;
const MAX_RETRY_PAGE: usize = 128;
const MAX_BYTES: i64 = 32 * 1024 * 1024;
const CONTENT_EXCLUDED: &[&str] = &[];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub sender: String,
    pub table_name: String,
    pub remote_id: String,
    pub kind: String,
    pub stamp: String,
    pub payload: String,
    pub error_code: String,
}

fn err<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|_| "pending_database_failed".into())
}

fn validated(pending: &Pending) -> Result<Pending, String> {
    if pending.sender.is_empty()
        || pending.sender.len() > 256
        || pending.remote_id.is_empty()
        || pending.remote_id.len() > 1024
    {
        return Err("pending_identity_invalid".into());
    }
    if !crate::mvp_sync_db::SYNC_TABLES.contains(&pending.table_name.as_str())
        || CONTENT_EXCLUDED.contains(&pending.table_name.as_str())
    {
        return Err("pending_table_invalid".into());
    }
    if pending.kind != "row" && pending.kind != "tomb" {
        return Err("pending_kind_invalid".into());
    }
    if pending.payload.len() > MAX_BYTES as usize
        || !matches!(
            serde_json::from_str::<Value>(&pending.payload),
            Ok(Value::Object(_))
        )
    {
        return Err("pending_payload_invalid".into());
    }
    if !pending
        .error_code
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-' | ':'))
        || pending.error_code.is_empty()
        || pending.error_code.len() > 128
    {
        return Err("pending_error_code_invalid".into());
    }
    Ok(Pending {
        stamp: crate::mvp_sync_db::canonical_sync_timestamp(&pending.stamp, "pending record")?,
        ..pending.clone()
    })
}

pub fn initialize(conn: &Connection) -> Result<(), String> {
    err(conn.execute_batch("CREATE TABLE IF NOT EXISTS content_sync_pending(
        sender TEXT NOT NULL, table_name TEXT NOT NULL, remote_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('row','tomb')), stamp TEXT NOT NULL,
        payload TEXT NOT NULL, error_code TEXT NOT NULL, last_attempt INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(sender,table_name,remote_id,kind)
    );
    CREATE TABLE IF NOT EXISTS content_sync_pending_meta(id INTEGER PRIMARY KEY CHECK(id=1), recovered_count INTEGER NOT NULL, retry_seq INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO content_sync_pending_meta(id,recovered_count) VALUES(1,0);"))
}

pub fn put(conn: &Connection, pending: &Pending) -> Result<(), String> {
    initialize(conn)?;
    let pending = validated(pending)?;
    let existing: Option<(String, i64)> = err(conn.query_row(
        "SELECT stamp,length(CAST(payload AS BLOB)) FROM content_sync_pending WHERE sender=?1 AND table_name=?2 AND remote_id=?3 AND kind=?4",
        params![pending.sender, pending.table_name, pending.remote_id, pending.kind], |r| Ok((r.get(0)?, r.get(1)?))
    ).optional())?;
    if let Some((stamp, _)) = &existing {
        let stamp = crate::mvp_sync_db::canonical_sync_timestamp(stamp, "stored pending record")?;
        if pending.stamp <= stamp {
            return Ok(());
        }
    }
    let (count, bytes): (i64, i64) = err(conn.query_row(
        "SELECT COUNT(*),COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM content_sync_pending",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    if existing.is_none() && count >= MAX_ENTRIES {
        return Err("pending_capacity_exceeded".into());
    }
    let effective_bytes =
        bytes - existing.map(|(_, bytes)| bytes).unwrap_or(0) + pending.payload.len() as i64;
    if effective_bytes > MAX_BYTES {
        return Err("pending_payload_capacity_exceeded".into());
    }
    err(conn.execute("INSERT INTO content_sync_pending(sender,table_name,remote_id,kind,stamp,payload,error_code)
        VALUES(?1,?2,?3,?4,?5,?6,?7)
        ON CONFLICT(sender,table_name,remote_id,kind) DO UPDATE SET stamp=excluded.stamp,payload=excluded.payload,error_code=excluded.error_code,last_attempt=0",
        params![pending.sender,pending.table_name,pending.remote_id,pending.kind,pending.stamp,pending.payload,pending.error_code]))?;
    Ok(())
}

pub fn pending(conn: &Connection, limit: usize) -> Result<Vec<Pending>, String> {
    if limit > MAX_RETRY_PAGE {
        return Err("pending_limit_invalid".into());
    }
    if !exists(conn, "content_sync_pending")? {
        return Ok(Vec::new());
    }
    let order = crate::mvp_sync_db::SYNC_TABLES
        .iter()
        .enumerate()
        .map(|(rank, table)| format!("WHEN '{table}' THEN {rank}"))
        .collect::<Vec<_>>()
        .join(" ");
    let sql = format!("SELECT sender,table_name,remote_id,kind,stamp,payload,error_code FROM content_sync_pending
        ORDER BY last_attempt, CASE kind WHEN 'row' THEN 0 ELSE 1 END, CASE table_name {order} ELSE 999 END, sender,remote_id LIMIT ?1");
    let mut statement = err(conn.prepare(&sql))?;
    let mapped = err(statement.query_map([limit as i64], |row| {
        Ok(Pending {
            sender: row.get(0)?,
            table_name: row.get(1)?,
            remote_id: row.get(2)?,
            kind: row.get(3)?,
            stamp: row.get(4)?,
            payload: row.get(5)?,
            error_code: row.get(6)?,
        })
    }))?;
    let rows = err(mapped.collect::<rusqlite::Result<Vec<_>>>())?;
    Ok(rows)
}

pub fn remove_exact(conn: &Connection, pending: &Pending) -> Result<bool, String> {
    initialize(conn)?;
    let pending = validated(pending)?;
    Ok(err(conn.execute("DELETE FROM content_sync_pending WHERE sender=?1 AND table_name=?2 AND remote_id=?3 AND kind=?4 AND stamp=?5 AND payload=?6",
        params![pending.sender,pending.table_name,pending.remote_id,pending.kind,pending.stamp,pending.payload]))? == 1)
}

pub fn count(conn: &Connection) -> Result<i64, String> {
    if !exists(conn, "content_sync_pending")? {
        return Ok(0);
    }
    err(
        conn.query_row("SELECT COUNT(*) FROM content_sync_pending", [], |row| {
            row.get(0)
        }),
    )
}

pub fn recovered_count(conn: &Connection) -> Result<i64, String> {
    if !exists(conn, "content_sync_pending_meta")? {
        return Ok(0);
    }
    err(conn.query_row(
        "SELECT recovered_count FROM content_sync_pending_meta WHERE id=1",
        [],
        |row| row.get(0),
    ))
}

fn exists(conn: &Connection, table: &str) -> Result<bool, String> {
    err(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |r| r.get(0),
    ))
}

pub fn record_recovered(conn: &Connection) -> Result<(), String> {
    initialize(conn)?;
    err(conn.execute(
        "UPDATE content_sync_pending_meta SET recovered_count=recovered_count+1 WHERE id=1",
        [],
    ))?;
    Ok(())
}

pub fn attempted(conn: &Connection, record: &Pending) -> Result<(), String> {
    err(conn.execute(
        "UPDATE content_sync_pending_meta SET retry_seq=retry_seq+1 WHERE id=1",
        [],
    ))?;
    err(conn.execute("UPDATE content_sync_pending SET last_attempt=(SELECT retry_seq FROM content_sync_pending_meta WHERE id=1) WHERE sender=?1 AND table_name=?2 AND remote_id=?3 AND kind=?4 AND stamp=?5 AND payload=?6",params![record.sender,record.table_name,record.remote_id,record.kind,record.stamp,record.payload]))?;
    Ok(())
}
