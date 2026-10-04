//! Explicit goal outcomes live in the existing synced, per-goal metadata.
//! Tasks, timers, skill evidence and the SQL goal identity remain independent.
use crate::{fail, AppState};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use tauri::State;

const KEY: &str = "calendar_development_v1";

pub(crate) fn read(conn: &Connection) -> Result<(Option<String>, Value), String> {
    let raw = crate::mvp_sync_db::read_ui(conn, KEY)?;
    let value = match raw.as_deref() {
        None | Some("") => json!({"version":1,"goals":{}}),
        Some(raw) => {
            serde_json::from_str::<Value>(raw).map_err(|_| fail("invalid goal metadata"))?
        }
    };
    if value["version"] != 1 || !value["goals"].is_object() {
        return Err(fail("unsupported goal metadata"));
    }
    for goal in value["goals"].as_object().unwrap().values() {
        if !goal.is_object()
            || goal
                .get("goalStatus")
                .is_some_and(|v| !matches!(v.as_str(), Some("active" | "achieved")))
            || goal.get("numericProgress").is_some_and(|v| !v.is_boolean())
        {
            return Err(fail("invalid goal metadata"));
        }
    }
    Ok((raw, value))
}

fn goal_mut<'a>(value: &'a mut Value, id: &str) -> Result<&'a mut Value, String> {
    let goals = value["goals"]
        .as_object_mut()
        .ok_or_else(|| fail("invalid goal metadata"))?;
    let goal = goals
        .entry(id.to_string())
        .or_insert_with(|| json!({"skills":[],"stages":[],"activeStageId":null,"focusId":null}));
    if !goal.is_object() {
        return Err(fail("invalid goal metadata"));
    }
    Ok(goal)
}

pub(crate) fn save_numeric(
    tx: &Transaction<'_>,
    id: &str,
    numeric: Option<bool>,
) -> Result<(), String> {
    let Some(numeric) = numeric else {
        return Ok(());
    };
    let (raw, mut value) = read(tx)?;
    goal_mut(&mut value, id)?["numericProgress"] = json!(numeric);
    crate::mvp_sync_db::set_ui_in_transaction(
        tx,
        KEY,
        &value.to_string(),
        Some(raw.as_deref().unwrap_or("")),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_calendar_goal_status(
    id: String,
    status: String,
    expected_status: String,
    expected_updated_at: Option<String>,
    achievement: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !matches!(status.as_str(), "active" | "achieved")
        || !matches!(expected_status.as_str(), "active" | "achieved")
    {
        return Err(fail("invalid goal status"));
    }
    let achievement = achievement.map(|value| value.trim().to_string());
    if achievement
        .as_ref()
        .is_some_and(|value| value.chars().count() > 2000)
    {
        return Err(fail("goal result is too long"));
    }
    let mut conn = state.0.lock().map_err(|_| fail("database lock failed"))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| fail(e.to_string()))?;
    let goal: Option<(String, String)> = tx
        .query_row(
            "SELECT goal_kind,updated_at FROM calendar_goals WHERE id=?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| fail(e.to_string()))?;
    let Some((kind, updated_at)) = goal else {
        return Err(fail("goal not found"));
    };
    if kind != "goal" {
        return Err(fail("goal has no outcome state"));
    }
    if expected_updated_at.is_some_and(|expected| expected != updated_at) {
        return Err(fail("goal changed; reopen the goal"));
    }
    let (raw, mut value) = read(&tx)?;
    let meta = goal_mut(&mut value, &id)?;
    let current = meta["goalStatus"].as_str().unwrap_or("active");
    // Retry of the same confirmed action is harmless, including its timestamp.
    if current == status
        && achievement
            .as_ref()
            .is_none_or(|text| meta["achievement"].as_str().unwrap_or("") == text)
    {
        return Ok(());
    }
    if current != expected_status {
        return Err(fail("goal status changed; reopen the goal"));
    }
    meta["goalStatus"] = json!(status);
    if status == "achieved" {
        meta["achievedAt"] = json!(Utc::now().to_rfc3339());
        if let Some(text) = achievement {
            meta["achievement"] = json!(text);
        }
    }
    // Reopening keeps the last recorded outcome as history, never as current status.
    crate::mvp_sync_db::set_ui_in_transaction(
        &tx,
        KEY,
        &value.to_string(),
        Some(raw.as_deref().unwrap_or("")),
    )?;
    tx.commit().map_err(|e| fail(e.to_string()))
}
