//! Explicit peer-authoritative local recovery; never publishes a server checkpoint.
use super::*;
use crate::mvp_sync_db as db;
use std::{path::Path, time::Instant};
use std::os::unix::fs::PermissionsExt;

const DOMAIN: &str = "cicada-private-content-restore-v1";
const RECEIPT: &str = "content_sync_private_restore_v1";
const MAX_FILE: u64 = 96 * 1024 * 1024;
const MAX_PAYLOAD: usize = 64 * 1024 * 1024;
const INVALID: &str = "mvp_sync_private_restore_invalid";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    profile: String,
    endpoint: String,
    key_id: String,
    target_device_id: String,
    target_scope: String,
    source_device_id: String,
    schema_version: i64,
    captured_at_utc: String,
    receive_seq: i64,
    payload_bytes: usize,
    payload_sha256: String,
    tasks_semantic_sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    v: u8,
    schema: String,
    operation_id: String,
    metadata: Metadata,
    payload_base64url: String,
    hmac: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRecord {
    id: String,
    data: String,
    updated_at: String,
    _updated_at: String,
    _device_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Watermark {
    device_id: String,
    client_seq: i64,
    server_seq: i64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Conflict {
    id: String,
    stamp: String,
    writer: String,
    data: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    records: Vec<WireRecord>,
    watermarks: Vec<Watermark>,
    conflicts: Vec<Conflict>,
}
fn canonical(input: &Input) -> Result<Vec<u8>, String> {
    let m = &input.metadata;
    serde_json::to_vec(&json!([1,DOMAIN,input.operation_id,m.profile,m.endpoint,m.key_id,
        m.target_device_id,m.target_scope,m.source_device_id,m.schema_version,
        m.captured_at_utc,m.receive_seq,m.payload_bytes,m.payload_sha256,m.tasks_semantic_sha256]))
        .map_err(|_| INVALID.into())
}
fn signing_key(cfg: &RelayConfig) -> Result<Vec<u8>, String> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&super::super::decode(&cfg.key, 32)?)
        .map_err(|_| INVALID)?;
    mac.update(DOMAIN.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}
fn hexadecimal(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
fn authenticated(input: &Input, cfg: &RelayConfig, scope: &str) -> Result<Snapshot, String> {
    let m = &input.metadata;
    if input.v != 1 || input.schema != DOMAIN
        || uuid::Uuid::parse_str(&input.operation_id).ok().map(|v| v.to_string()).as_deref() != Some(input.operation_id.as_str())
        || m.profile != super::super::PROFILE || m.endpoint != cfg.endpoint.trim_end_matches('/')
        || m.key_id != cfg.key_id || m.target_device_id != cfg.device_id || m.target_scope != scope
        || !hexadecimal(scope) || !super::super::opaque_id(&m.source_device_id)
        || m.source_device_id == cfg.device_id || m.schema_version != crate::SCHEMA_VERSION
        || m.captured_at_utc.len() > 40 || chrono::DateTime::parse_from_rfc3339(&m.captured_at_utc).is_err()
        || !(1..=9_007_199_254_740_991).contains(&m.receive_seq)
        || m.payload_bytes == 0 || m.payload_bytes > MAX_PAYLOAD
        || !hexadecimal(&m.payload_sha256) || !hexadecimal(&m.tasks_semantic_sha256) || !hexadecimal(&input.hmac)
    { return Err(INVALID.into()); }
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&signing_key(cfg)?).map_err(|_| INVALID)?;
    mac.update(&canonical(input)?);
    mac.verify_slice(&hex::decode(&input.hmac).map_err(|_| INVALID)?)
        .map_err(|_| "mvp_sync_private_restore_authentication_failed")?;
    let bytes = B64.decode(&input.payload_base64url).map_err(|_| INVALID)?;
    if bytes.len() != m.payload_bytes || B64.encode(&bytes) != input.payload_base64url || hash(&bytes) != m.payload_sha256 {
        return Err(INVALID.into());
    }
    let snapshot: Snapshot = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
    if snapshot.records.len() > 100_000 || snapshot.conflicts.len() > 100_000 || snapshot.watermarks.is_empty() || snapshot.watermarks.len() > 64
        || !snapshot.records.windows(2).all(|v| v[0].id < v[1].id)
        || !snapshot.watermarks.windows(2).all(|v| v[0].device_id < v[1].device_id)
        || snapshot.records.iter().any(|r| r.data.len() > RECORD_LIMIT)
        || snapshot.conflicts.iter().any(|r| r.data.len() > RECORD_LIMIT)
        || snapshot.watermarks.iter().any(|w| !super::super::opaque_id(&w.device_id)
            || !(1..=9_007_199_254_740_991).contains(&w.client_seq) || !(1..=m.receive_seq).contains(&w.server_seq))
        || snapshot.watermarks.iter().map(|w| w.server_seq).max() != Some(m.receive_seq)
        || !snapshot.watermarks.iter().any(|w| w.device_id == m.source_device_id)
    { return Err(INVALID.into()); }
    Ok(snapshot)
}
fn field_maps(snapshot: &Snapshot) -> Result<Vec<Map<String, Value>>, String> {
    snapshot.records.iter().map(|r| serde_json::to_value(r).map_err(|_| INVALID.into())
        .and_then(|v| v.as_object().cloned().ok_or_else(|| INVALID.into()))).collect()
}
fn task_digest(conn: &Connection) -> Result<String, String> {
    let mut q = sql(conn.prepare("SELECT id,kind,status,completed,archived,date,time,duration_minutes,priority,tags,updated_at FROM items WHERE kind='task' AND archived=0 AND status IN ('task','done') ORDER BY id"))?;
    let rows = sql(q.query_map([], |r| {
        Ok(json!([r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?,
            r.get::<_,Option<String>>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,i64>(7)?,r.get::<_,i64>(8)?,r.get::<_,String>(9)?,r.get::<_,String>(10)?]))
    }))?;
    Ok(hash(&serde_json::to_vec(&sql(rows.collect::<rusqlite::Result<Vec<_>>>())?).map_err(|_| INVALID)?))
}
fn ready(conn: &Connection, input: &Input, snapshot: &Snapshot, cfg: &RelayConfig) -> Result<i64, String> {
    if cfg.enabled || db::get_setting_checked(conn,"content_sync_enabled")?.as_deref() != Some("false") {
        return Err("mvp_sync_private_restore_requires_disabled".into());
    }
    if sql(conn.pragma_query_value(None,"user_version",|r| r.get::<_,i64>(0)))? != crate::SCHEMA_VERSION {
        return Err(INVALID.into());
    }
    if scalar(conn,"SELECT (SELECT count(*) FROM content_sync_outbox)+(SELECT count(*) FROM content_sync_outbound_fragments)")? != 0 {
        return Err("mvp_sync_private_restore_outbox_not_empty".into());
    }
    let sequence = scalar(conn,"SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='content_sync_outbox'),0)")?;
    let covered = snapshot.watermarks.iter().find(|w| w.device_id == cfg.device_id).map_or(0, |w| w.client_seq);
    if covered != sequence || input.metadata.receive_seq < scalar(conn,"SELECT receive_seq FROM content_sync_state WHERE id=1")? {
        return Err("mvp_sync_private_restore_position_mismatch".into());
    }
    let mut q = sql(conn.prepare("SELECT device_id,client_seq,server_seq FROM content_sync_sender_watermarks"))?;
    let rows = sql(q.query_map([],|r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?))))?;
    for row in rows {
        let (id, client, server) = sql(row)?;
        if snapshot.watermarks.iter().find(|w| w.device_id == id).is_none_or(|w|
            w.client_seq < client || w.server_seq < server || (w.client_seq == client && w.server_seq != server)) {
            return Err("mvp_sync_private_restore_position_mismatch".into());
        }
    }
    Ok(sequence)
}
fn copy_database(source: &Connection, target: &mut Connection) -> Result<(), String> {
    let backup = sql(rusqlite::backup::Backup::new(source, target))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if Instant::now() >= deadline { return Err("mvp_sync_private_restore_backup_failed".into()); }
        if matches!(sql(backup.step(64))?, rusqlite::backup::StepResult::Done) { return Ok(()); }
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn apply_one(conn: &Connection, fields: &Map<String, Value>) -> Result<(), String> {
    sql(conn.execute_batch("SAVEPOINT private_restore_record"))?;
    let result = db::apply_record(conn, fields);
    sql(conn.execute_batch(if result.is_err() { "ROLLBACK TO private_restore_record; RELEASE private_restore_record" } else { "RELEASE private_restore_record" }))?;
    result.map(|_| ())
}
fn replace(conn: &mut Connection, input: &Input, snapshot: &Snapshot, fields: &[Map<String, Value>], cfg: &RelayConfig, receipt: &Value) -> Result<(), String> {
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    ready(&tx,input,snapshot,cfg)?;
    for row in fields { db::validate_publishable_record(&tx,row)?; }
    db::clear_private_restore_business(&tx)?;
    let mut waiting: Vec<_> = fields.iter().collect();
    let mut attempts = 0;
    for _ in 0..64 {
        let before = waiting.len();
        let mut remaining = vec![];
        for row in waiting {
            attempts += 1;
            if attempts > 1_000_000 { return Err(INVALID.into()); }
            if apply_one(&tx,row).is_err() { remaining.push(row); }
        }
        waiting = remaining;
        if waiting.is_empty() || waiting.len() == before { break; }
    }
    if !waiting.is_empty() { return Err("mvp_sync_private_restore_dependency_failed".into()); }
    for conflict in &snapshot.conflicts {
        db::checkpoint_merge_conflict(&tx,&serde_json::to_value(conflict).map_err(|_| INVALID)?)?;
    }
    if task_digest(&tx)? != input.metadata.tasks_semantic_sha256 {
        return Err("mvp_sync_private_restore_projection_mismatch".into());
    }
    let review_table = scalar(&tx,"SELECT count(*) FROM sqlite_master WHERE type='table' AND name='local_review_state'")?;
    if review_table != 0 && scalar(&tx,"SELECT count(*) FROM local_review_state r JOIN items i ON i.id=r.task_id WHERE (r.state='accepted' AND (i.completed<>1 OR i.status<>'done')) OR (r.state<>'accepted' AND (i.completed<>0 OR i.status<>'task'))")? != 0 {
        return Err("mvp_sync_private_restore_local_review_conflict".into());
    }
    sql(tx.execute("DELETE FROM content_sync_sender_watermarks",[]))?;
    for w in &snapshot.watermarks {
        sql(tx.execute("INSERT INTO content_sync_sender_watermarks VALUES(?1,?2,?3)",params![w.device_id,w.client_seq,w.server_seq]))?;
    }
    sql(tx.execute("UPDATE content_sync_state SET receive_seq=?1,receipt_needed=1,pull_error=NULL,pull_not_before=0,last_error=NULL WHERE id=1",[input.metadata.receive_seq]))?;
    sql(tx.execute("UPDATE content_sync_control SET applying=0 WHERE id=1",[]))?;
    if scalar(&tx,"SELECT (SELECT count(*) FROM content_sync_dirty)+(SELECT count(*) FROM content_sync_outbox)+(SELECT count(*) FROM content_sync_outbound_fragments)")? != 0 {
        return Err("mvp_sync_private_restore_dirty_projection".into());
    }
    let integrity: String = sql(tx.query_row("PRAGMA integrity_check",[],|r| r.get(0)))?;
    let foreign_rows = {
        let mut query = sql(tx.prepare("PRAGMA foreign_key_check"))?;
        let mut rows = sql(query.query([]))?;
        sql(rows.next())?.is_some()
    };
    if integrity != "ok" || foreign_rows {
        return Err("mvp_sync_private_restore_integrity_failed".into());
    }
    sql(tx.execute("INSERT INTO app_settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",params![RECEIPT,receipt.to_string(),chrono::Utc::now().to_rfc3339()]))?;
    sql(tx.commit())
}
pub(crate) fn restore(conn: &mut Connection, database: &Path, path: &Path) -> Result<Value,String> {
    let raw = super::super::private_file::read_selected(database)?.ok_or("mvp_sync_private_restore_requires_private_storage")?;
    let cfg = RelayConfig::parse(&raw)?;
    validate_scope(conn,&derive_config(&cfg)?)?;
    let scope: String = sql(conn.query_row("SELECT scope FROM content_sync_state WHERE id=1",[],|r| r.get(0)))?;
    let input: Input = serde_json::from_str(&super::super::private_file::read_external_limited(path,MAX_FILE)?)
        .map_err(|_| INVALID)?;
    let snapshot = authenticated(&input,&cfg,&scope)?;
    if let Some(prior) = db::get_setting_checked(conn,RECEIPT)? {
        let prior: Value = serde_json::from_str(&prior).map_err(|_| INVALID)?;
        if prior["operation_id"] == input.operation_id {
            if prior["payload_sha256"] == input.metadata.payload_sha256 { return Ok(prior); }
            return Err("mvp_sync_private_restore_operation_conflict".into());
        }
        if prior["receive_seq"].as_i64().is_none_or(|v| input.metadata.receive_seq <= v) {
            return Err("mvp_sync_private_restore_stale_snapshot".into());
        }
    }
    let sequence = ready(conn,&input,&snapshot,&cfg)?;
    let fields = field_maps(&snapshot)?;
    for row in &fields { db::validate_publishable_record(conn,row)?; }
    let backup_root = super::super::private_file::recovery_directory(database)?;
    let backup = crate::backup(conn,&backup_root).map_err(|_| "mvp_sync_private_restore_backup_failed")?;
    std::fs::set_permissions(&backup,std::fs::Permissions::from_mode(0o600)).map_err(|_| "mvp_sync_private_restore_backup_failed")?;
    let mut backup_file = std::fs::File::open(&backup).map_err(|_| "mvp_sync_private_restore_backup_failed")?;
    let mut digest = Sha256::new();
    let mut buffer = [0;65536];
    loop { let n = backup_file.read(&mut buffer).map_err(|_| "mvp_sync_private_restore_backup_failed")?; if n == 0 { break; } digest.update(&buffer[..n]); }
    let receipt = json!({"ok":true,"operation_id":input.operation_id,"payload_sha256":input.metadata.payload_sha256,
        "receive_seq":input.metadata.receive_seq,"tasks_semantic_sha256":input.metadata.tasks_semantic_sha256,
        "backup":backup,"backup_sha256":hex::encode(digest.finalize()),"client_seq":sequence,"enabled":false,"network_started":false});
    let mut staged = sql(Connection::open_in_memory())?;
    copy_database(conn,&mut staged)?;
    replace(&mut staged,&input,&snapshot,&fields,&cfg,&receipt)?;
    replace(conn,&input,&snapshot,&fields,&cfg,&receipt)?;
    Ok(receipt)
}

#[cfg(test)]
#[path = "mvp_sync_private_restore_tests.rs"]
mod tests;
