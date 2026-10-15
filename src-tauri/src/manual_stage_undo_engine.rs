//! Manual stage operations share the existing Undo journal, owner and CAS.
//! Production command registration is owned by the integrator.
use super::*;
use crate::task_attributes::{self as attributes, manual_stage_undo as domain};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageInput {
    id: String,
    operation_id: String,
    expected_version: i64,
    stage: String,
}

fn process_snapshot(conn: &Connection, tags: &str) -> Result<(Option<String>, String)> {
    let raw = crate::mvp_sync_db::read_ui(conn, "calendar_processes_v1")
        .map_err(|_| "undo_storage_failed")?;
    let process = attributes::effective_process(tags).ok_or("undo_process_unavailable")?;
    let state: Value = raw
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| "undo_process_unavailable")?
        .unwrap_or(Value::Null);
    // Include the target definition even if native capture is not populated yet.
    // Other process edits need not change this proof. Captured envelope/writer
    // distinguishes deletion/recreation of an identical process definition.
    let rows = state["processes"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|row| row["id"] == process)
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let key = json!(["ui", ["calendar_processes_v1", "processes", process]]).to_string();
    let proof = json!([rows, lineage_for_key(conn, &key)?]).to_string();
    Ok((raw, proof))
}

fn stage_fields(conn: &Connection, id: &str) -> Result<(String, String)> {
    sql(conn.query_row("SELECT tags,created_at FROM items WHERE id=?1 AND kind='task' AND status IN ('task','done')",
        [id], |row| Ok((row.get(0)?, row.get(1)?))))
}

fn edit_stage(conn: &mut Connection, input: StageInput) -> Result<Ack> {
    validate_key(&input.id)?;
    validate_key(&input.operation_id)?;
    validate_revision(input.expected_version)?;
    let request = encode(&input)?;
    // Same operation namespace as text: reuse for a different command conflicts.
    let key = format!("edit:{}", input.operation_id);
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    initialize(&tx)?;
    let owner = context(&tx)?;
    let old = task(&tx, &input.id)?;
    // Retry acknowledges its commit even after the process was deleted.
    if let Some(ack) = replay(&tx, &key, &owner, "stage", &request)? {
        return Ok(ack);
    }
    if old.version != input.expected_version {
        return Err("undo_revision_conflict".into());
    }
    let (tags, since) = stage_fields(&tx, &input.id)?;
    let (raw, proof) = process_snapshot(&tx, &tags)?;
    let at = Utc::now().to_rfc3339();
    let prepared = domain::prepare_change(
        &tags,
        domain::ProcessSnapshot {
            raw: raw.as_deref(),
            proof: &proof,
        },
        &input.stage,
        &at,
        &since,
    )?;
    let receipt = if let Some(prepared) = prepared {
        if old.version > MAX_REVISION - 2 {
            return Err("undo_invalid_revision".into());
        }
        if sql(tx.execute(
            "UPDATE items SET tags=?1,version=version+1,updated_at=?2 WHERE id=?3 AND version=?4",
            params![prepared.tags, at, input.id, input.expected_version],
        ))? != 1
        {
            return Err("undo_revision_conflict".into());
        }
        let receipt = uuid::Uuid::new_v4().to_string();
        sql(tx.execute("INSERT INTO manual_task_undo_receipts(id,schema_version,task_id,owner,inverse,after_row,after_lineage) VALUES(?1,1,?2,?3,?4,?5,?6)",
            params![receipt,input.id,owner,encode(&prepared.inverse)?,task(&tx,&input.id)?.full,lineage(&tx,&input.id)?]))?;
        Some(receipt)
    } else {
        None
    };
    let ack = Ack {
        task_id: input.id.clone(),
        task_revision: task(&tx, &input.id)?.version,
        undo_receipt: receipt,
    };
    record(&tx, &key, &owner, "stage", &request, &ack)?;
    sql(tx.commit())?;
    Ok(ack)
}

// Existing Undo calls this AFTER owner/revision/after-row/item-lineage checks,
// BEFORE receipt consumption/outcome; all mutations stay in its transaction.
pub(super) fn restore(conn: &Connection, id: &str, revision: i64, inverse: &Value) -> Result<()> {
    let inverse: domain::StageInverse =
        serde_json::from_value(inverse.clone()).map_err(|_| "undo_receipt_invalid")?;
    let (tags, since) = stage_fields(conn, id)?;
    let (raw, proof) = process_snapshot(conn, &tags)?;
    let at = Utc::now().to_rfc3339();
    let next = domain::prepare_restore(
        &tags,
        domain::ProcessSnapshot {
            raw: raw.as_deref(),
            proof: &proof,
        },
        &inverse,
        &at,
        &since,
    )?;
    if sql(conn.execute(
        "UPDATE items SET tags=?1,version=version+1,updated_at=?2 WHERE id=?3 AND version=?4",
        params![next, at, id, revision],
    ))? != 1
    {
        return Err("undo_revision_conflict".into());
    }
    Ok(())
}

#[tauri::command]
pub fn save_calendar_task_manual_stage(
    input: StageInput,
    state: State<'_, AppState>,
) -> Result<Ack> {
    let mut conn = state.0.lock().map_err(|_| "undo_storage_failed")?;
    edit_stage(&mut conn, input)
}

#[cfg(test)]
#[path = "manual_stage_undo_engine_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "manual_stage_undo_edge_tests.rs"]
mod edge_tests;
