//! Separate, same-account update authority. No task commands or caller safety claims.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_RECEIPT: usize = 16 * 1024;
const MAX_OPERATIONS: i64 = 1000;
pub(crate) const AUTHORIZATION: &str = "user-authorized-safe-update-v1";

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Payload {
    pub authorization: Option<String>,
    pub expected_version: Option<String>,
    pub prepared_id: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    version: u32,
    operation_id: String,
    action: String,
    payload: Payload,
}
#[derive(Clone, Deserialize, Serialize, Debug)]
#[serde(deny_unknown_fields)]
pub(crate) struct Receipt {
    pub operation_id: String,
    pub action: String,
    pub phase: String,
    pub result: Value,
}
pub(crate) fn parse(raw: &[u8]) -> Result<Request, String> {
    if raw.is_empty() || raw.len() > 4096 { return Err("control_invalid_frame".into()); }
    let r: Request = serde_json::from_slice(raw).map_err(|_| "control_invalid_request")?;
    let token = |s: &str| (8..=100).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c));
    if r.version != 1 || !token(&r.operation_id) || !["status", "receipt", "check", "prepare", "install"].contains(&r.action.as_str()) {
        return Err("control_invalid_request".into());
    }
    let p = &r.payload;
    if ["check", "prepare", "install"].contains(&r.action.as_str()) {
        if p.authorization.as_deref() != Some(AUTHORIZATION) { return Err("control_authorization_required".into()); }
    } else if p.authorization.is_some() { return Err("control_invalid_request".into()); }
    if r.action == "install" {
        if p.expected_version.as_ref().is_none_or(|v| v.len() > 40 || semver::Version::parse(v).is_err())
            || p.prepared_id.as_ref().is_none_or(|v| v.len() != 64 || !v.bytes().all(|c| c.is_ascii_hexdigit())) {
            return Err("control_prepared_identity_required".into());
        }
    } else if p.expected_version.is_some() || p.prepared_id.is_some() { return Err("control_invalid_request".into()); }
    Ok(r)
}

// Kept outside calendar.db and synchronization. A started request is never
// re-executed after a disconnect/crash; receipt readback is the only recovery.
pub(crate) struct Journal { conn: Connection }
impl Journal {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|_| "control_journal_unavailable")?;
        conn.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_| "control_journal_unavailable")?;
        conn.execute_batch("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,digest TEXT NOT NULL,receipt TEXT NOT NULL,receipt_sha256 TEXT NOT NULL); CREATE TABLE IF NOT EXISTS install_commit(singleton INTEGER PRIMARY KEY CHECK(singleton=1),operation_id TEXT NOT NULL,version TEXT NOT NULL,prepared_id TEXT NOT NULL);").map_err(|_| "control_journal_corrupt")?;
        Ok(Self { conn })
    }
    pub fn read(&self, id: &str) -> Result<Option<Receipt>, String> {
        let raw: Option<(String,String)> = self.conn.query_row("SELECT CASE WHEN length(CAST(receipt AS BLOB))<=16384 THEN receipt ELSE NULL END,receipt_sha256 FROM operations WHERE id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_| "control_journal_corrupt")?;
        raw.map(|(raw, digest)| {
            if hex::encode(Sha256::digest(raw.as_bytes())) != digest { return Err("control_receipt_corrupt".into()); }
            if raw.len() > MAX_RECEIPT { return Err("control_receipt_corrupt".into()); }
            let r: Receipt = serde_json::from_str(&raw).map_err(|_| "control_receipt_corrupt")?;
            if r.operation_id != id || !["started", "deferred", "failed", "complete", "committing", "unknown"].contains(&r.phase.as_str()) { return Err("control_receipt_corrupt".into()); }
            Ok(r)
        }).transpose()
    }
    pub fn begin(&mut self, r: &Request) -> Result<Option<Receipt>, String> {
        let digest = hex::encode(Sha256::digest(serde_json::to_vec(r).map_err(|_| "control_invalid_request")?));
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "control_journal_busy")?;
        let old: Option<String> = tx.query_row("SELECT digest FROM operations WHERE id=?1", [&r.operation_id], |row| row.get(0)).optional().map_err(|_| "control_journal_corrupt")?;
        if let Some(old) = old {
            if old != digest { return Err("control_operation_conflict".into()); }
            drop(tx); return self.read(&r.operation_id);
        }
        let count: i64 = tx.query_row("SELECT count(*) FROM operations", [], |row| row.get(0)).map_err(|_| "control_journal_corrupt")?;
        if count >= MAX_OPERATIONS { return Err("control_receipt_capacity".into()); }
        let receipt = Receipt { operation_id: r.operation_id.clone(), action: r.action.clone(), phase: "started".into(), result: json!({"outcome":"unknown"}) };
        let raw = serde_json::to_string(&receipt).unwrap();
        tx.execute("INSERT INTO operations VALUES(?1,?2,?3,?4)", params![r.operation_id, digest, raw, hex::encode(Sha256::digest(raw.as_bytes()))]).map_err(|_| "control_journal_write")?;
        tx.commit().map_err(|_| "control_journal_write")?; Ok(None)
    }
    pub fn finish(&self, id: &str, phase: &str, result: Value) -> Result<Receipt, String> {
        let mut r = self.read(id)?.ok_or("control_receipt_missing")?;
        r.phase = phase.into(); r.result = result;
        let raw = serde_json::to_string(&r).map_err(|_| "control_receipt_corrupt")?;
        if raw.len() > MAX_RECEIPT { return Err("control_receipt_oversized".into()); }
        self.conn.execute("UPDATE operations SET receipt=?2,receipt_sha256=?3 WHERE id=?1", params![id, raw, hex::encode(Sha256::digest(raw.as_bytes()))]).map_err(|_| "control_journal_write")?; Ok(r)
    }
    pub fn install_committed(&self) -> Result<bool, String> {
        self.conn.query_row("SELECT EXISTS(SELECT 1 FROM install_commit)", [], |r| r.get(0)).map_err(|_| "control_journal_corrupt".into())
    }
    pub fn commit_install(&mut self, id: &str, version: &str, prepared_id: &str) -> Result<(), String> {
        self.read(id)?.ok_or("control_receipt_missing")?;
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "control_journal_busy")?;
        // No second operation can launch an installer while an outcome is unknown.
        tx.execute("INSERT INTO install_commit VALUES(1,?1,?2,?3)", params![id, version, prepared_id]).map_err(|_| "control_install_outcome_unknown")?;
        let raw: String = tx.query_row("SELECT CASE WHEN length(CAST(receipt AS BLOB))<=16384 THEN receipt ELSE NULL END FROM operations WHERE id=?1", [id], |r| r.get(0)).map_err(|_| "control_receipt_missing")?;
        if raw.len() > MAX_RECEIPT { return Err("control_receipt_corrupt".into()); }
        let mut r: Receipt = serde_json::from_str(&raw).map_err(|_| "control_receipt_corrupt")?;
        if r.operation_id != id || r.action != "install" || r.phase != "started" { return Err("control_receipt_corrupt".into()); }
        r.phase = "committing".into(); r.result = json!({"outcome":"unknown","version":version,"prepared_id":prepared_id});
        let raw = serde_json::to_string(&r).unwrap();
        tx.execute("UPDATE operations SET receipt=?2,receipt_sha256=?3 WHERE id=?1", params![id,raw,hex::encode(Sha256::digest(raw.as_bytes()))]).map_err(|_| "control_journal_write")?;
        tx.commit().map_err(|_| "control_journal_write".into())
    }
    // Reconcile only from the actually running immutable target version, never
    // from an installer exit code or a caller-supplied success claim.
    pub fn reconcile(&mut self, installed: &str) -> Result<(), String> {
        let target: Option<(String,String)> = self.conn.query_row("SELECT operation_id,version FROM install_commit WHERE singleton=1", [], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_| "control_journal_corrupt")?;
        if let Some((id, version)) = target {
            if installed == version {
                self.read(&id)?.ok_or("control_receipt_missing")?;
                let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "control_journal_busy")?;
                let raw: String = tx.query_row("SELECT CASE WHEN length(CAST(receipt AS BLOB))<=16384 THEN receipt ELSE NULL END FROM operations WHERE id=?1", [&id], |r| r.get(0)).map_err(|_| "control_receipt_missing")?;
                if raw.len() > MAX_RECEIPT { return Err("control_receipt_corrupt".into()); }
                let mut receipt: Receipt = serde_json::from_str(&raw).map_err(|_| "control_receipt_corrupt")?;
                if receipt.operation_id != id || receipt.action != "install" || !["committing","unknown"].contains(&receipt.phase.as_str()) { return Err("control_receipt_corrupt".into()); }
                receipt.phase = "complete".into(); receipt.result = json!({"outcome":"running_target_version","version":version});
                let raw = serde_json::to_string(&receipt).unwrap();
                tx.execute("UPDATE operations SET receipt=?2,receipt_sha256=?3 WHERE id=?1", params![id,raw,hex::encode(Sha256::digest(raw.as_bytes()))]).map_err(|_| "control_journal_write")?;
                tx.execute("DELETE FROM install_commit WHERE singleton=1", []).map_err(|_| "control_journal_write")?;
                tx.commit().map_err(|_| "control_journal_write")?;
            }
        } Ok(())
    }
}
pub(crate) fn journal_path(app: &tauri::AppHandle) -> Result<PathBuf,String> {
    let dir = crate::app_data_dir(app)?.join("update-control");
    std::fs::create_dir_all(&dir).map_err(|_| "control_journal_unavailable")?;
    Ok(dir.join("operations.sqlite"))
}
pub(crate) async fn execute(app: tauri::AppHandle, request: Request) -> Result<Value,String> {
    crate::app_updates::control_production_allowed(&app)?;
    let mut journal = Journal::open(&journal_path(&app)?)?;
    journal.reconcile(&app.package_info().version.to_string())?;
    if request.action == "status" { return crate::app_updates::control_status(&app); }
    if request.action == "receipt" { return Ok(json!({"receipt": journal.read(&request.operation_id)?})); }
    if let Some(receipt) = journal.begin(&request)? { return Ok(json!({"receipt":receipt})); }
    let result = match request.action.as_str() {
        "check" => crate::app_updates::mvp_update_check(app.clone(),app.state()).await.map(|_| ()),
        "prepare" => crate::app_updates::mvp_update_prepare(app.clone(),app.state()).await.map(|_| ()),
        "install" => crate::app_updates::control_install(app.clone(), &request.operation_id, request.payload.expected_version.as_deref().unwrap(), request.payload.prepared_id.as_deref().unwrap()).await.map(|_| ()),
        _ => unreachable!(),
    };
    // Windows may have exited during the existing signed installer handoff.
    // A return after commit cannot prove failure; preserve UNKNOWN and the latch.
    if journal.read(&request.operation_id)?.is_some_and(|r| r.phase == "committing") {
        return Ok(json!({"receipt":journal.finish(&request.operation_id,"unknown",json!({"outcome":"unknown","reason":"installer_handoff_requires_receipt_readback"}))?}));
    }
    let receipt = match result {
        Ok(()) => journal.finish(&request.operation_id,"complete",crate::app_updates::control_status(&app)?)?,
        Err(reason) => journal.finish(&request.operation_id,"deferred",json!({"reason":reason}))?,
    }; Ok(json!({"receipt":receipt}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(id: &str) -> Request { parse(format!(r#"{{"version":1,"operation_id":"{id}","action":"install","payload":{{"authorization":"{AUTHORIZATION}","expected_version":"9.0.0","prepared_id":"{}"}}}}"#,"a".repeat(64)).as_bytes()).unwrap() }
    #[test] fn safety_claims_and_missing_authorization_are_rejected() {
        let r = request("operation-a"); let mut v = serde_json::to_value(&r).unwrap();
        for field in ["activity","hidden","safeToInstall","draft","lease","automatic"] { v["payload"][field]=json!(true);assert!(parse(v.to_string().as_bytes()).is_err());v["payload"].as_object_mut().unwrap().remove(field); }
        v["payload"]["authorization"]=Value::Null;assert!(parse(v.to_string().as_bytes()).is_err());
    }
    #[test] fn durable_replay_conflict_crash_and_global_install_latch() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("ops.sqlite");let r=request("operation-a");
        {let mut j=Journal::open(&path).unwrap();assert!(j.begin(&r).unwrap().is_none());j.commit_install(&r.operation_id,"9.0.0",&"a".repeat(64)).unwrap();}
        let mut j=Journal::open(&path).unwrap();assert_eq!(j.begin(&r).unwrap().unwrap().phase,"committing");
        let mut changed=r.clone();changed.payload.expected_version=Some("9.0.1".into());assert!(j.begin(&changed).is_err());
        let separate=request("operation-b");j.begin(&separate).unwrap();assert!(j.commit_install(&separate.operation_id,"9.0.0",&"a".repeat(64)).is_err());
        j.reconcile("8.0.0").unwrap();assert!(j.install_committed().unwrap());j.reconcile("9.0.0").unwrap();assert!(!j.install_committed().unwrap());assert_eq!(j.read(&r.operation_id).unwrap().unwrap().phase,"complete");
    }
    #[test] fn corrupt_and_oversized_receipts_fail_closed() {
        let d=tempfile::tempdir().unwrap();let mut j=Journal::open(&d.path().join("ops.sqlite")).unwrap();let r=request("operation-a");j.begin(&r).unwrap();
        for raw in ["{".to_string(),"x".repeat(MAX_RECEIPT+1)] {j.conn.execute("UPDATE operations SET receipt=?1",[raw]).unwrap();assert!(j.begin(&r).is_err());assert!(j.commit_install(&r.operation_id,"9.0.0","a").is_err());}
        assert!(!j.install_committed().unwrap());
    }
    #[test] fn lost_first_reply_never_launches_twice_and_deferred_replay_is_stable() {
        let d=tempfile::tempdir().unwrap();let path=d.path().join("ops.sqlite");let r=request("operation-a");let mut launches=0;
        for _ in 0..3 {
            let mut j=Journal::open(&path).unwrap();
            if j.begin(&r).unwrap().is_none() { j.commit_install(&r.operation_id,"9.0.0",&"a".repeat(64)).unwrap(); launches+=1; }
        }
        assert_eq!(launches,1);
        let mut j=Journal::open(&path).unwrap();let unsafe_request=request("operation-deferred");j.begin(&unsafe_request).unwrap();
        let refused=j.finish(&unsafe_request.operation_id,"deferred",json!({"reason":"control_active_timeline"})).unwrap();
        assert_eq!(j.begin(&unsafe_request).unwrap().unwrap().result,refused.result);
        let mut changed=unsafe_request.clone();changed.payload.prepared_id=Some("b".repeat(64));assert!(j.begin(&changed).is_err());
    }
}
