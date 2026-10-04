//! Trusted isolated single-profile prototype. No cross-app principal or dispatcher.
use crate::AppState;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

const MAX_REVISION: i64 = 9_007_199_254_740_991;
pub(crate) struct Scope(bool);
impl Scope {
    pub(crate) fn from_isolated(isolated: bool) -> Self {
        Self(isolated && cfg!(feature = "local-result-review-prototype"))
    }
    #[cfg(test)]
    pub(crate) fn fixture() -> Self {
        Self(true)
    }
    fn require(&self) -> Result<(), ReviewError> {
        if self.0 {
            Ok(())
        } else {
            Err(error(403, "review_prototype_disabled"))
        }
    }
}
#[derive(Debug, Serialize, Clone)]
pub(crate) struct ReviewError {
    pub status: u16,
    pub code: String,
}
fn error(status: u16, code: &str) -> ReviewError {
    ReviewError {
        status,
        code: code.into(),
    }
}
fn sql<T>(value: rusqlite::Result<T>) -> Result<T, ReviewError> {
    value.map_err(|_| error(500, "review_database_failed"))
}
fn json<T: Serialize>(value: &T) -> Result<String, ReviewError> {
    serde_json::to_string(value).map_err(|_| error(400, "invalid_review_payload"))
}
fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, ReviewError> {
    serde_json::from_str(value).map_err(|_| error(500, "invalid_stored_review"))
}
fn id(value: &str) -> Result<(), ReviewError> {
    if value.is_empty() || value.chars().count() > 200 || value.chars().any(char::is_control) {
        Err(error(400, "invalid_review_id"))
    } else {
        Ok(())
    }
}
fn revision(value: i64) -> Result<(), ReviewError> {
    if (1..=MAX_REVISION).contains(&value) {
        Ok(())
    } else {
        Err(error(400, "invalid_revision"))
    }
}
fn text(value: &str) -> Result<String, ReviewError> {
    if value.trim().is_empty()
        || value.chars().count() > 8000
        || value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        Err(error(400, "invalid_review_text"))
    } else {
        Ok(value.trim().into())
    }
}
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Decision {
    pub operation_id: String,
    pub action: String,
    pub task_id: String,
    pub expected_revision: i64,
    pub result_version: i64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub comment: Option<String>,
}
impl Decision {
    fn normalize(mut self) -> Result<Self, ReviewError> {
        id(&self.operation_id)?;
        id(&self.task_id)?;
        revision(self.expected_revision)?;
        revision(self.result_version)?;
        match self.action.as_str() {
            "accept" if self.comment.is_none() => {}
            "rework" => {
                self.comment = Some(text(
                    self.comment
                        .as_deref()
                        .ok_or_else(|| error(400, "comment_required"))?,
                )?)
            }
            _ => return Err(error(400, "invalid_review_action")),
        }
        if json(&self)?.len() > 65536 {
            return Err(error(400, "review_payload_limit"));
        }
        Ok(self)
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Publication {
    pub operation_id: String,
    pub task_id: String,
    pub expected_revision: i64,
    pub content: String,
}
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Audit {
    pub action: String,
    pub result_version: i64,
    pub comment: Option<String>,
    pub operation_id: String,
    pub task_revision: i64,
    pub event_id: String,
}
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Projection {
    pub task_id: String,
    pub task_revision: i64,
    pub result_version: i64,
    pub content: String,
    pub review_state: String,
    pub history: Vec<Audit>,
}
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub(crate) struct Receipt {
    pub kind: String,
    pub operation_id: String,
    pub projection: Projection,
}
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub(crate) struct Pending {
    pub request: Decision,
    pub state: String,
    pub conflict: Option<String>,
    pub receipt: Option<Receipt>,
}
#[derive(Debug, Serialize)]
pub(crate) struct Bundle {
    pub projection: Projection,
    pub pending: Vec<Pending>,
}

/// Additive component schema, only invoked by scoped prototype handlers/tests.
/// Native global user_version is unchanged; review metadata rejects newer formats.
pub(crate) fn initialize(conn: &mut Connection) -> Result<(), ReviewError> {
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    sql(tx.execute_batch("CREATE TABLE IF NOT EXISTS local_review_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);"))?;
    let existing: Option<i64> = sql(tx
        .query_row(
            "SELECT version FROM local_review_meta WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional())?;
    if existing.is_some_and(|v| v != 1) {
        return Err(error(409, "newer_review_schema"));
    }
    sql(tx.execute_batch(r#"
      CREATE TABLE IF NOT EXISTS local_review_results(task_id TEXT NOT NULL,result_version INTEGER NOT NULL,content TEXT NOT NULL,published_task_version INTEGER NOT NULL,PRIMARY KEY(task_id,result_version));
      CREATE TABLE IF NOT EXISTS local_review_state(task_id TEXT PRIMARY KEY,result_version INTEGER NOT NULL,state TEXT NOT NULL,intent_id TEXT);
      CREATE TABLE IF NOT EXISTS local_review_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,operation_id TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_review_operations(operation_id TEXT PRIMARY KEY,request TEXT NOT NULL,receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_review_intents(intent_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,result_version INTEGER NOT NULL,task_version INTEGER NOT NULL,comment TEXT NOT NULL,state TEXT NOT NULL,event_id TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS local_review_outbox(operation_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,conflict TEXT);
      CREATE TRIGGER IF NOT EXISTS local_review_result_no_update BEFORE UPDATE ON local_review_results BEGIN SELECT RAISE(ABORT,'immutable_review_result'); END;
      CREATE TRIGGER IF NOT EXISTS local_review_result_no_delete BEFORE DELETE ON local_review_results BEGIN SELECT RAISE(ABORT,'immutable_review_result'); END;
      CREATE TRIGGER IF NOT EXISTS local_review_audit_no_update BEFORE UPDATE ON local_review_audit BEGIN SELECT RAISE(ABORT,'immutable_review_audit'); END;
      CREATE TRIGGER IF NOT EXISTS local_review_audit_no_delete BEFORE DELETE ON local_review_audit BEGIN SELECT RAISE(ABORT,'immutable_review_audit'); END;
      CREATE TRIGGER IF NOT EXISTS local_review_active_delete BEFORE DELETE ON items WHEN EXISTS(SELECT 1 FROM local_review_state WHERE task_id=OLD.id AND state='awaiting_dispatch') BEGIN SELECT RAISE(ABORT,'active_review_intent'); END;
      CREATE TRIGGER IF NOT EXISTS local_review_active_archive BEFORE UPDATE OF archived ON items WHEN NEW.archived<>0 AND EXISTS(SELECT 1 FROM local_review_state WHERE task_id=OLD.id AND state='awaiting_dispatch') BEGIN SELECT RAISE(ABORT,'active_review_intent'); END;
      CREATE TRIGGER IF NOT EXISTS local_review_status_guard BEFORE UPDATE OF completed,status ON items WHEN EXISTS(SELECT 1 FROM local_review_state WHERE task_id=OLD.id AND ((state='accepted' AND (NEW.completed<>1 OR NEW.status<>'done')) OR (state<>'accepted' AND (NEW.completed<>0 OR NEW.status<>'task')))) BEGIN SELECT RAISE(ABORT,'review_controls_status'); END;
      INSERT OR IGNORE INTO local_review_meta VALUES(1,1);
    "#))?;
    sql(tx.commit())
}
fn native_version(conn: &Connection, task_id: &str) -> Result<i64, ReviewError> {
    crate::health_sleep::editable(task_id).map_err(|_| error(403, "native_task_readonly"))?;
    let row: Option<(i64, String, i64, i64, String)> = sql(conn
        .query_row(
            "SELECT version,kind,archived,completed,status FROM items WHERE id=?1",
            [task_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional())?;
    let (version, kind, archived, _, status) =
        row.ok_or_else(|| error(404, "native_task_not_found"))?;
    if kind != "task" || archived != 0 || !matches!(status.as_str(), "task" | "done") {
        return Err(error(404, "native_task_not_found"));
    }
    revision(version)?;
    Ok(version)
}
fn state(conn: &Connection, task_id: &str) -> Result<Option<(i64, String)>, ReviewError> {
    sql(conn
        .query_row(
            "SELECT result_version,state FROM local_review_state WHERE task_id=?1",
            [task_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())
}
fn projection(conn: &Connection, task_id: &str) -> Result<Projection, ReviewError> {
    let task_revision = native_version(conn, task_id)?;
    let (result_version, review_state) =
        state(conn, task_id)?.ok_or_else(|| error(404, "no_review_result"))?;
    let content = sql(conn.query_row(
        "SELECT content FROM local_review_results WHERE task_id=?1 AND result_version=?2",
        params![task_id, result_version],
        |r| r.get(0),
    ))?;
    let mut statement =
        sql(conn.prepare("SELECT body FROM local_review_audit WHERE task_id=?1 ORDER BY seq"))?;
    let raw = sql(statement.query_map([task_id], |r| r.get::<_, String>(0)))?;
    let history = sql(raw.collect::<rusqlite::Result<Vec<_>>>())?
        .iter()
        .map(|v| decode(v))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Projection {
        task_id: task_id.into(),
        task_revision,
        result_version,
        content,
        review_state,
        history,
    })
}
fn pending(conn: &Connection, task_id: &str) -> Result<Vec<Pending>, ReviewError> {
    let mut statement=sql(conn.prepare("SELECT request,state,conflict,receipt FROM local_review_outbox WHERE task_id=?1 ORDER BY rowid"))?;
    let raw = sql(statement.query_map([task_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    }))?;
    sql(raw.collect::<rusqlite::Result<Vec<_>>>())?
        .into_iter()
        .map(|(request, state, conflict, receipt)| {
            Ok(Pending {
                request: decode(&request)?,
                state,
                conflict,
                receipt: receipt.map(|v| decode(&v)).transpose()?,
            })
        })
        .collect()
}
pub(crate) fn read(conn: &mut Connection, task_id: &str) -> Result<Bundle, ReviewError> {
    id(task_id)?;
    let tx = sql(conn.transaction())?;
    let bundle = Bundle {
        projection: projection(&tx, task_id)?,
        pending: pending(&tx, task_id)?,
    };
    sql(tx.commit())?;
    Ok(bundle)
}
fn existing(
    conn: &Connection,
    operation: &str,
    request: &str,
) -> Result<Option<Receipt>, ReviewError> {
    let row: Option<(String, String)> = sql(conn
        .query_row(
            "SELECT request,receipt FROM local_review_operations WHERE operation_id=?1",
            [operation],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())?;
    match row {
        Some((old, receipt)) if old == request => Ok(Some(decode(&receipt)?)),
        Some(_) => Err(error(409, "operation_payload_conflict")),
        None => Ok(None),
    }
}
fn advance(
    conn: &Connection,
    task_id: &str,
    expected: i64,
    accepted: bool,
) -> Result<(), ReviewError> {
    if expected >= MAX_REVISION {
        return Err(error(409, "revision_exhausted"));
    }
    let count=sql(conn.execute("UPDATE items SET version=version+1,completed=?1,status=?2,updated_at=?3 WHERE id=?4 AND version=?5",params![accepted as i64,if accepted{"done"}else{"task"},Utc::now().to_rfc3339(),task_id,expected]))?;
    if count != 1 {
        return Err(error(409, "native_task_version_conflict"));
    }
    Ok(())
}
pub(crate) fn publish(
    conn: &mut Connection,
    mut input: Publication,
) -> Result<Receipt, ReviewError> {
    id(&input.operation_id)?;
    id(&input.task_id)?;
    revision(input.expected_revision)?;
    input.content = text(&input.content)?;
    let request = json(&serde_json::json!({"action":"synthetic_publish_result","input":input}))?;
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    if let Some(receipt) = existing(&tx, &input.operation_id, &request)? {
        return Ok(receipt);
    }
    if native_version(&tx, &input.task_id)? != input.expected_revision {
        return Err(error(409, "native_task_version_conflict"));
    }
    let previous = state(&tx, &input.task_id)?;
    if previous
        .as_ref()
        .is_some_and(|(_, s)| s != "awaiting_review")
    {
        return Err(error(409, "result_publication_not_expected"));
    }
    let completed: i64 = sql(tx.query_row(
        "SELECT completed FROM items WHERE id=?1",
        [&input.task_id],
        |r| r.get(0),
    ))?;
    if completed != 0 {
        return Err(error(409, "task_already_completed"));
    }
    let version = previous.map_or(1, |(v, _)| v + 1);
    revision(version)?;
    sql(tx.execute(
        "INSERT INTO local_review_results VALUES(?1,?2,?3,?4)",
        params![
            input.task_id,
            version,
            input.content,
            input.expected_revision + 1
        ],
    ))?;
    sql(tx.execute(
        "INSERT OR REPLACE INTO local_review_state VALUES(?1,?2,'awaiting_review',NULL)",
        params![input.task_id, version],
    ))?;
    advance(&tx, &input.task_id, input.expected_revision, false)?;
    let audit = Audit {
        action: "synthetic_publish_result".into(),
        result_version: version,
        comment: None,
        operation_id: input.operation_id.clone(),
        task_revision: input.expected_revision + 1,
        event_id: Uuid::new_v4().to_string(),
    };
    sql(tx.execute(
        "INSERT INTO local_review_audit(task_id,operation_id,body) VALUES(?1,?2,?3)",
        params![input.task_id, input.operation_id, json(&audit)?],
    ))?;
    let receipt = Receipt {
        kind: "acknowledged".into(),
        operation_id: input.operation_id.clone(),
        projection: projection(&tx, &input.task_id)?,
    };
    sql(tx.execute(
        "INSERT INTO local_review_operations VALUES(?1,?2,?3)",
        params![input.operation_id, request, json(&receipt)?],
    ))?;
    sql(tx.commit())?;
    Ok(receipt)
}
pub(crate) fn enqueue(conn: &mut Connection, input: Decision) -> Result<(), ReviewError> {
    let input = input.normalize()?;
    let raw = json(&input)?;
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    // A retry retains a stale original payload and ID; do not rebase it.
    let old: Option<String> = sql(tx
        .query_row(
            "SELECT request FROM local_review_outbox WHERE operation_id=?1",
            [&input.operation_id],
            |r| r.get(0),
        )
        .optional())?;
    if let Some(old) = old {
        if old != raw {
            return Err(error(409, "local_operation_payload_conflict"));
        }
        return Ok(());
    }
    existing(&tx, &input.operation_id, &raw)?;
    native_version(&tx, &input.task_id)?;
    let queued: i64 = sql(tx.query_row(
        "SELECT count(*) FROM local_review_outbox WHERE task_id=?1 AND state='queued'",
        [&input.task_id],
        |r| r.get(0),
    ))?;
    if queued != 0 {
        return Err(error(409, "unresolved_review_operation"));
    }
    sql(tx.execute(
        "INSERT INTO local_review_outbox VALUES(?1,?2,?3,'queued',NULL,NULL)",
        params![input.operation_id, input.task_id, raw],
    ))?;
    sql(tx.commit())
}
pub(crate) fn commit(conn: &mut Connection, operation_id: &str) -> Result<Receipt, ReviewError> {
    apply_with_fault(conn, operation_id, |_| Ok(()))
}
fn apply_with_fault(
    conn: &mut Connection,
    operation_id: &str,
    fault: impl Fn(&str) -> Result<(), ReviewError>,
) -> Result<Receipt, ReviewError> {
    id(operation_id)?;
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let row: Option<(String, String, Option<String>)> = sql(tx
        .query_row(
            "SELECT request,state,receipt FROM local_review_outbox WHERE operation_id=?1",
            [operation_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional())?;
    let (raw, outcome, receipt) = row.ok_or_else(|| error(404, "review_operation_not_found"))?;
    if outcome == "acknowledged" {
        return decode(&receipt.ok_or_else(|| error(500, "invalid_stored_receipt"))?);
    }
    let input: Decision = decode(&raw)?;
    if let Some(receipt) = existing(&tx, operation_id, &raw)? {
        return Ok(receipt);
    }
    if outcome == "conflict" {
        return Err(error(409, "review_operation_conflict"));
    }
    let validation = (|| {
        if native_version(&tx, &input.task_id)? != input.expected_revision {
            return Err(error(409, "native_task_version_conflict"));
        }
        let (version, status) =
            state(&tx, &input.task_id)?.ok_or_else(|| error(409, "no_review_result"))?;
        if version != input.result_version {
            return Err(error(409, "stale_result_version"));
        }
        if status != "awaiting_review" {
            return Err(error(409, "result_already_decided"));
        }
        // Preserve existing complete_calendar_task semantics: no silent timer stop.
        if input.action == "accept" {
            let active:i64=sql(tx.query_row("SELECT count(*) FROM timeline_blocks WHERE source_type='note' AND source_id=?1 AND is_active=1",[&input.task_id],|r|r.get(0)))?;
            if active != 0 {
                return Err(error(409, "native_task_active"));
            }
        }
        Ok(())
    })();
    if let Err(err) = validation {
        sql(tx.execute(
            "UPDATE local_review_outbox SET state='conflict',conflict=?1 WHERE operation_id=?2",
            params![err.code, operation_id],
        ))?;
        sql(tx.commit())?;
        return Err(err);
    }
    let event_id = Uuid::new_v4().to_string();
    let accepted = input.action == "accept";
    sql(tx.execute(
        "UPDATE local_review_state SET state=?1,intent_id=?2 WHERE task_id=?3",
        params![
            if accepted {
                "accepted"
            } else {
                "awaiting_dispatch"
            },
            if accepted { None } else { Some(operation_id) },
            input.task_id
        ],
    ))?;
    if !accepted {
        sql(tx.execute(
            "INSERT INTO local_review_intents VALUES(?1,?2,?3,?4,?5,'awaiting_dispatch',?6)",
            params![
                operation_id,
                input.task_id,
                input.result_version,
                input.expected_revision + 1,
                input.comment,
                event_id
            ],
        ))?;
    }
    let audit = Audit {
        action: input.action.clone(),
        result_version: input.result_version,
        comment: input.comment.clone(),
        operation_id: operation_id.into(),
        task_revision: input.expected_revision + 1,
        event_id,
    };
    sql(tx.execute(
        "INSERT INTO local_review_audit(task_id,operation_id,body) VALUES(?1,?2,?3)",
        params![input.task_id, operation_id, json(&audit)?],
    ))?;
    fault("after_intent_audit")?;
    advance(&tx, &input.task_id, input.expected_revision, accepted)?;
    fault("after_task")?;
    let receipt = Receipt {
        kind: "acknowledged".into(),
        operation_id: operation_id.into(),
        projection: projection(&tx, &input.task_id)?,
    };
    sql(tx.execute(
        "INSERT INTO local_review_operations VALUES(?1,?2,?3)",
        params![operation_id, raw, json(&receipt)?],
    ))?;
    fault("after_receipt")?;
    sql(tx.execute("UPDATE local_review_outbox SET state='acknowledged',receipt=?1,conflict=NULL WHERE operation_id=?2",params![json(&receipt)?,operation_id]))?;
    fault("after_outbox_ack")?;
    sql(tx.commit())?;
    Ok(receipt)
}
fn connection<'a>(
    scope: &Scope,
    state: &'a AppState,
) -> Result<std::sync::MutexGuard<'a, Connection>, ReviewError> {
    scope.require()?;
    let mut conn = state
        .0
        .lock()
        .map_err(|_| error(500, "review_database_lock"))?;
    initialize(&mut conn)?;
    Ok(conn)
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) fn prototype_publish_task_result(
    input: Publication,
    scope: State<'_, Scope>,
    state: State<'_, AppState>,
) -> Result<Receipt, ReviewError> {
    {
        let mut conn = connection(&scope, &state)?;
        publish(&mut conn, input)
    }
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) fn read_task_result_review(
    task_id: String,
    scope: State<'_, Scope>,
    state: State<'_, AppState>,
) -> Result<Bundle, ReviewError> {
    {
        let mut conn = connection(&scope, &state)?;
        read(&mut conn, &task_id)
    }
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) fn enqueue_task_result_review(
    input: Decision,
    scope: State<'_, Scope>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, ReviewError> {
    let operation = input.operation_id.clone();
    let mut conn = connection(&scope, &state)?;
    enqueue(&mut conn, input)?;
    Ok(serde_json::json!({"kind":"queued","operation_id":operation}))
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) fn commit_task_result_review(
    operation_id: String,
    scope: State<'_, Scope>,
    state: State<'_, AppState>,
) -> Result<Receipt, ReviewError> {
    {
        let mut conn = connection(&scope, &state)?;
        commit(&mut conn, &operation_id)
    }
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) fn recover_task_result_review(
    task_id: String,
    scope: State<'_, Scope>,
    state: State<'_, AppState>,
) -> Result<Bundle, ReviewError> {
    {
        let mut conn = connection(&scope, &state)?;
        read(&mut conn, &task_id)
    }
}

#[cfg(test)]
#[path = "native_result_review_tests.rs"]
mod tests;
