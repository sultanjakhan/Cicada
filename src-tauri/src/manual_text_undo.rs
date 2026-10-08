//! Explicit manual text edits and local durable Undo. No generic save/import caller.
//! Acknowledgements describe the committed operation; get_calendar_task reads live state.
use crate::AppState;
use chrono::Utc;
use rusqlite::{params, types::ValueRef, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

type Result<T> = std::result::Result<T, String>;
const MAX_REVISION: i64 = 9_007_199_254_740_991;
fn sql<T>(value: rusqlite::Result<T>) -> Result<T> {
    value.map_err(|_| "undo_storage_failed".into())
}

// Retain the old review receipt format. Outcomes are additive local records,
// excluded from native sync capture. No global schema version or items change.
fn initialize(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS manual_task_undo_receipts (
        id TEXT PRIMARY KEY NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=1),
        task_id TEXT NOT NULL, owner TEXT NOT NULL, inverse TEXT NOT NULL,
        after_row TEXT NOT NULL, after_lineage TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)));
        CREATE TABLE IF NOT EXISTS manual_text_undo_operations (
        id TEXT PRIMARY KEY NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=1),
        owner TEXT NOT NULL, task_id TEXT NOT NULL, command TEXT NOT NULL,
        request TEXT NOT NULL, response TEXT NOT NULL);",
    ))?;
    for (table, expected) in [
        (
            "manual_task_undo_receipts",
            vec![
                "id",
                "schema_version",
                "task_id",
                "owner",
                "inverse",
                "after_row",
                "after_lineage",
                "consumed",
            ],
        ),
        (
            "manual_text_undo_operations",
            vec![
                "id",
                "schema_version",
                "owner",
                "task_id",
                "command",
                "request",
                "response",
            ],
        ),
    ] {
        let mut query = sql(conn.prepare(&format!("PRAGMA table_info({table})")))?;
        let columns: Vec<(String, String, i64, Option<String>, i64)> = sql(query
            .query_map([], |r| {
                Ok((r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            }))?
        .collect::<rusqlite::Result<_>>()
        .map_err(|_| "undo_storage_failed")?;
        if columns.len() != expected.len()
            || columns.iter().zip(expected).any(
                |((name, kind, required, default, pk), expected)| {
                    let integer = matches!(expected, "schema_version" | "consumed");
                    name != expected
                        || kind != if integer { "INTEGER" } else { "TEXT" }
                        || *required != 1
                        || *pk != i64::from(expected == "id")
                        || default.as_deref()
                            != if expected == "consumed" {
                                Some("0")
                            } else {
                                None
                            }
                },
            )
        {
            return Err("undo_schema_unsupported".into());
        }
        let invalid: bool = sql(conn.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE schema_version IS NULL OR schema_version!=1)"), [], |r| r.get(0)))?;
        if invalid {
            return Err("undo_schema_unsupported".into());
        }
    }
    let invalid: bool = sql(conn.query_row("SELECT EXISTS(SELECT 1 FROM manual_task_undo_receipts WHERE consumed IS NULL OR consumed NOT IN (0,1))",[],|r|r.get(0)))?;
    if invalid {
        return Err("undo_schema_unsupported".into());
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditInput {
    id: String,
    operation_id: String,
    expected_version: i64,
    edit: TextEdit,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum TextEdit {
    Text {
        title: String,
        content: String,
        // Value makes this field required; null explicitly clears rich blocks.
        #[serde(rename = "contentBlocks")]
        content_blocks: Value,
    },
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UndoInput {
    receipt_id: String,
    expected_version: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ack {
    task_id: String,
    task_revision: i64,
    undo_receipt: Option<String>,
}

fn validate_revision(version: i64) -> Result<()> {
    if !(1..=MAX_REVISION).contains(&version) {
        return Err("undo_invalid_revision".into());
    }
    Ok(())
}
fn validate_key(key: &str) -> Result<()> {
    if key.trim().is_empty() || key.len() > 256 {
        return Err("undo_invalid_id".into());
    }
    Ok(())
}
fn encode<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|_| "undo_receipt_invalid".into())
}
fn replay(
    conn: &Connection,
    key: &str,
    owner: &str,
    command: &str,
    request: &str,
) -> Result<Option<Ack>> {
    let stored: Option<(String, String, String, String, String)> = sql(conn.query_row(
        "SELECT owner,task_id,command,request,response FROM manual_text_undo_operations WHERE id=?1 AND schema_version=1",
        [key], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional())?;
    let Some((actor, id, original_command, original_request, response)) = stored else {
        return Ok(None);
    };
    if actor != owner {
        return Err("undo_receipt_unavailable".into());
    }
    task(conn, &id)?;
    if original_command != command || original_request != request {
        return Err("undo_request_conflict".into());
    }
    let ack: Ack = serde_json::from_str(&response).map_err(|_| "undo_receipt_invalid")?;
    if ack.task_id != id {
        return Err("undo_receipt_invalid".into());
    }
    Ok(Some(ack))
}
fn record(
    conn: &Connection,
    key: &str,
    owner: &str,
    command: &str,
    request: &str,
    ack: &Ack,
) -> Result<()> {
    sql(conn.execute("INSERT INTO manual_text_undo_operations(id,schema_version,owner,task_id,command,request,response) VALUES(?1,1,?2,?3,?4,?5,?6)",
        params![key,owner,ack.task_id,command,request,encode(ack)?]))?;
    Ok(())
}
fn context(conn: &Connection) -> Result<String> {
    let applying: i64 = sql(conn.query_row(
        "SELECT applying FROM content_sync_control WHERE id=1",
        [],
        |r| r.get(0),
    ))?;
    if applying != 0 {
        return Err("undo_sync_applying".into());
    }
    let owner: String = sql(conn.query_row(
        "SELECT value FROM app_settings WHERE key='device_id'",
        [],
        |r| r.get(0),
    ))?;
    if owner.is_empty() {
        return Err("undo_owner_unavailable".into());
    }
    Ok(owner)
}

struct Task {
    full: String,
    title: String,
    notes: String,
    blocks: Option<String>,
    version: i64,
}
fn task(conn: &Connection, id: &str) -> Result<Task> {
    if id.is_empty() {
        return Err("undo_invalid_id".into());
    }
    crate::health_sleep::editable(id)?;
    let mut query = sql(conn
        .prepare("SELECT * FROM items WHERE id=?1 AND kind='task' AND status IN ('task','done')"))?;
    let names: Vec<String> = query.column_names().iter().map(|v| v.to_string()).collect();
    let value = sql(query
        .query_row([id], |r| {
            let mut full = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                let value = match r.get_ref(i)? {
                    ValueRef::Null => json!(["null"]),
                    ValueRef::Integer(v) => json!(["integer", v]),
                    ValueRef::Real(v) => json!(["real", v.to_bits().to_string()]),
                    ValueRef::Text(v) => json!(["text", v]),
                    ValueRef::Blob(v) => json!(["blob", v]),
                };
                full.insert(name.clone(), value);
            }
            Ok(Task {
                full: Value::Object(full).to_string(),
                title: r.get("title")?,
                notes: r.get("notes")?,
                blocks: r.get("content_blocks")?,
                version: r.get("version")?,
            })
        })
        .optional())?
    .ok_or("undo_task_unavailable")?;
    if !(1..=MAX_REVISION).contains(&value.version) {
        return Err("undo_invalid_revision".into());
    }
    Ok(value)
}

fn lineage(conn: &Connection, id: &str) -> Result<String> {
    let key = json!(["items", [id]]).to_string();
    let envelope: Option<(String, String)> = sql(conn
        .query_row(
            "SELECT data,updated_at FROM mvp_records WHERE id=?1",
            [&key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())?;
    let writer: Option<(String, String)> = sql(conn.query_row("SELECT updated_at,device_id FROM sync_row_versions WHERE table_name='mvp_records' AND row_id=?1", [&key], |r|Ok((r.get(0)?,r.get(1)?))).optional())?;
    Ok(json!([envelope, writer]).to_string())
}

fn edit(conn: &mut Connection, input: EditInput) -> Result<Ack> {
    validate_key(&input.id)?;
    validate_key(&input.operation_id)?;
    validate_revision(input.expected_version)?;
    let request = encode(&input)?;
    let key = format!("edit:{}", input.operation_id);
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    initialize(&tx)?;
    let owner = context(&tx)?;
    let old = task(&tx, &input.id)?;
    if let Some(ack) = replay(&tx, &key, &owner, "text", &request)? {
        return Ok(ack);
    }
    if old.version != input.expected_version {
        return Err("undo_revision_conflict".into());
    }
    let TextEdit::Text {
        title,
        content,
        content_blocks,
    } = &input.edit;
    if title.trim().is_empty() || title.trim().chars().count() > 500 {
        return Err("undo_invalid_title".into());
    }
    let blocks = if content_blocks.is_null() {
        None
    } else {
        Some(content_blocks.as_str().ok_or("undo_invalid_blocks")?)
    };
    if let Some(blocks) = blocks {
        serde_json::from_str::<Value>(blocks).map_err(|_| "undo_invalid_blocks")?;
    }
    let receipt = if old.title == title.trim()
        && old.notes == *content
        && old.blocks.as_deref() == blocks
    {
        None
    } else {
        if old.version > MAX_REVISION - 2 {
            return Err("undo_invalid_revision".into());
        }
        if sql(tx.execute("UPDATE items SET title=?1,notes=?2,content_blocks=?3,version=version+1,updated_at=?4 WHERE id=?5 AND version=?6",
            params![title.trim(),content,blocks,Utc::now().to_rfc3339(),input.id,input.expected_version]))? != 1 {
            return Err("undo_revision_conflict".into());
        }
        let receipt = uuid::Uuid::new_v4().to_string();
        let inverse =
            json!({"kind":"text","title":old.title,"notes":old.notes,"blocks":old.blocks});
        sql(tx.execute("INSERT INTO manual_task_undo_receipts(id,schema_version,task_id,owner,inverse,after_row,after_lineage) VALUES(?1,1,?2,?3,?4,?5,?6)",
            params![receipt,input.id,owner,inverse.to_string(),task(&tx,&input.id)?.full,lineage(&tx,&input.id)?]))?;
        Some(receipt)
    };
    let ack = Ack {
        task_id: input.id.clone(),
        task_revision: task(&tx, &input.id)?.version,
        undo_receipt: receipt,
    };
    record(&tx, &key, &owner, "text", &request, &ack)?;
    sql(tx.commit())?;
    Ok(ack)
}

fn undo(conn: &mut Connection, input: UndoInput) -> Result<Ack> {
    validate_key(&input.receipt_id)?;
    validate_revision(input.expected_version)?;
    let request = encode(&input)?;
    let key = format!("undo:{}", input.receipt_id);
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    initialize(&tx)?;
    let owner = context(&tx)?;
    if let Some(ack) = replay(&tx, &key, &owner, "undo", &request)? {
        return Ok(ack);
    }
    let stored: Option<(String,String,String,String,String)> = sql(tx.query_row(
        "SELECT task_id,owner,inverse,after_row,after_lineage FROM manual_task_undo_receipts WHERE id=?1 AND schema_version=1 AND consumed=0", [&input.receipt_id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional())?;
    let (id, actor, inverse, after, after_lineage) = stored.ok_or("undo_receipt_unavailable")?;
    if owner != actor {
        return Err("undo_receipt_unavailable".into());
    }
    let current = task(&tx, &id)?;
    if current.version == MAX_REVISION {
        return Err("undo_invalid_revision".into());
    }
    if current.version != input.expected_version
        || current.full != after
        || lineage(&tx, &id)? != after_lineage
    {
        return Err("undo_revision_conflict".into());
    }
    let inverse: Value = serde_json::from_str(&inverse).map_err(|_| "undo_receipt_invalid")?;
    if inverse["kind"] != "text" {
        return Err("undo_receipt_invalid".into());
    }
    let title = inverse["title"].as_str().ok_or("undo_receipt_invalid")?;
    let notes = inverse["notes"].as_str().ok_or("undo_receipt_invalid")?;
    let blocks = if inverse["blocks"].is_null() {
        None
    } else {
        Some(inverse["blocks"].as_str().ok_or("undo_receipt_invalid")?)
    };
    if sql(tx.execute("UPDATE items SET title=?1,notes=?2,content_blocks=?3,version=version+1,updated_at=?4 WHERE id=?5 AND version=?6",
        params![title,notes,blocks,Utc::now().to_rfc3339(),id,input.expected_version]))? != 1 { return Err("undo_revision_conflict".into()); }
    if sql(tx.execute(
        "UPDATE manual_task_undo_receipts SET consumed=1 WHERE id=?1 AND consumed=0",
        [&input.receipt_id],
    ))? != 1
    {
        return Err("undo_receipt_unavailable".into());
    }
    let ack = Ack {
        task_id: id,
        task_revision: input.expected_version + 1,
        undo_receipt: None,
    };
    record(&tx, &key, &owner, "undo", &request, &ack)?;
    sql(tx.commit())?;
    Ok(ack)
}

#[tauri::command]
pub fn save_calendar_task_manual_edit(input: EditInput, state: State<'_, AppState>) -> Result<Ack> {
    let mut conn = state.0.lock().map_err(|_| "undo_storage_failed")?;
    edit(&mut conn, input)
}
#[tauri::command]
pub fn undo_calendar_task_manual_edit(input: UndoInput, state: State<'_, AppState>) -> Result<Ack> {
    let mut conn = state.0.lock().map_err(|_| "undo_storage_failed")?;
    undo(&mut conn, input)
}

#[cfg(test)]
#[path = "manual_text_undo_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "manual_text_undo_edge_tests.rs"]
mod edge_tests;
