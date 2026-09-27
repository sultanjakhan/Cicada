//! Canonical reflection records live beside recurring state, never inside a
//! legacy writer's replaceable plan/day payload. All public writes use a bundle
//! transaction and explicit intent; missing fields are not deletion requests.
use chrono::Local;
use rusqlite::{Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

pub(crate) const KEY: &str = "calendar_reflections_v1";
pub(crate) const RECURRING: &str = "calendar_recurring_v1";
const LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bundle {
    pub recurring: Option<String>,
    pub reflections: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Change {
    Plan {
        id: String,
        #[serde(deserialize_with = "nullable_prompt")]
        prompt: Option<String>,
    },
    Answer {
        id: String,
        date: String,
        answer: Answer,
    },
}

fn nullable_prompt<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Answer {
    rule_outcome: String,
    restoration: String,
    #[serde(default)]
    trigger: String,
}

fn error(_: impl std::fmt::Display) -> String {
    "reflection_storage_failed".into()
}
fn invalid<T>() -> Result<T, String> {
    Err("reflection_invalid_data".into())
}
fn valid_id(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= 128 && !id.chars().any(char::is_control)
}
fn text(value: &Value, limit: usize) -> bool {
    value.as_str().is_some_and(|v| {
        !v.trim().is_empty() && v.chars().count() <= limit && !v.chars().any(char::is_control)
    })
}
fn valid_answer(value: &Value) -> bool {
    let Ok(answer) = serde_json::from_value::<Answer>(value.clone()) else {
        return false;
    };
    matches!(
        answer.rule_outcome.as_str(),
        "kept" | "broken" | "no_answer"
    ) && matches!(
        answer.restoration.as_str(),
        "better" | "same" | "worse" | "no_answer"
    ) && answer.trigger.chars().count() <= 500
        && !answer
            .trigger
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
}
fn valid_snapshot(snapshot: &Value, id: &str) -> bool {
    let Some(object) = snapshot.as_object() else {
        return false;
    };
    object.get("id").and_then(Value::as_str) == Some(id)
        && snapshot["kind"] == "action"
        && snapshot["mode"].as_str().unwrap_or("check") == "check"
        && text(&snapshot["title"], 160)
        && snapshot["weekdays"].as_array().is_some_and(|days| {
            !days.is_empty()
                && days.len() <= 7
                && days.iter().all(|day| day.as_u64().is_some_and(|n| n <= 6))
        })
        && ["startsOn", "endsOn", "createdOn"].iter().all(|field| {
            snapshot[*field].as_str().is_some_and(|day| {
                day.is_empty() && *field != "createdOn" || crate::validate_date(day).is_ok()
            })
        })
        && snapshot["time"]
            .as_str()
            .is_some_and(|time| time.is_empty() || crate::validate_time(time).is_ok())
        && snapshot["active"].is_boolean()
        && snapshot["required"].is_boolean()
        && snapshot["steps"].as_array().is_none_or(Vec::is_empty)
        && !object.contains_key("reflection")
}
fn empty() -> Value {
    json!({"version":1,"plans":{},"days":{}})
}
fn parse(raw: Option<&str>, reflection: bool) -> Result<Value, String> {
    let Some(raw) = raw else {
        return Ok(if reflection {
            empty()
        } else {
            json!({"version":1,"plans":[],"days":{}})
        });
    };
    if raw.len() > LIMIT {
        return invalid();
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| "reflection_invalid_data")?;
    if value["version"] != 1
        || !value["days"].is_object()
        || if reflection {
            !value["plans"].is_object()
        } else {
            !value["plans"].is_array()
        }
    {
        return invalid();
    }
    Ok(value)
}
fn read(conn: &Connection) -> Result<Bundle, String> {
    Ok(Bundle {
        recurring: crate::mvp_sync_db::read_ui(conn, RECURRING)?,
        reflections: crate::mvp_sync_db::read_ui(conn, KEY)?,
    })
}
fn path(group: &str, id: &str, date: Option<&str>) -> Vec<Value> {
    if let Some(date) = date {
        vec![json!(KEY), json!(group), json!(date), json!(id)]
    } else {
        vec![json!(KEY), json!(group), json!(id)]
    }
}
fn exists(conn: &Connection, keys: &[Value]) -> Result<bool, String> {
    // A tombstone also owns the identity and prevents future migration seeds.
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM mvp_records WHERE id=?1)",
        [json!(["ui", keys]).to_string()],
        |r| r.get(0),
    )
    .map_err(error)
}
fn write(conn: &Connection, keys: Vec<Value>, value: Value) -> Result<(), String> {
    crate::mvp_sync_db::write_reflection_record(conn, keys, value)
}
fn clean_snapshot(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("reflection");
    }
    value
}

/// Called by the sync adapter too. Provenance is part of the immutable wire
/// payload: authored records/tombstones dominate migration seeds regardless of
/// delivery order, clock skew or an old pre-encrypted outbox.
pub(crate) fn valid_row(keys: &[&str], value: &Value, deleted: bool) -> bool {
    let valid_path = match keys {
        [KEY, "plans", id] => valid_id(id),
        [KEY, "days", date, id] => valid_id(id) && crate::validate_date(date).is_ok(),
        _ => false,
    };
    if !valid_path {
        return false;
    }
    if deleted {
        return true;
    }
    let Some(object) = value.as_object() else {
        return false;
    };
    if !value["legacy"].is_boolean() {
        return false;
    }
    match keys {
        [KEY, "plans", _] => {
            object.len() == 3
                && value["enabled"].is_boolean()
                && if value["enabled"] == true {
                    text(&value["prompt"], 160)
                } else {
                    value["prompt"].is_null()
                }
        }
        [KEY, "days", _, id] => {
            object.len() == 5
                && text(&value["prompt"], 160)
                && valid_snapshot(&value["snapshot"], id)
                && matches!(
                    value["status"].as_str(),
                    Some("pending" | "done" | "skipped")
                )
                && (value["answer"].is_null() || valid_answer(&value["answer"]))
        }
        _ => false,
    }
}

pub(crate) fn priority(keys: &[Value], value: &Value, deleted: bool) -> Option<u8> {
    if keys.first().and_then(Value::as_str) != Some(KEY) {
        return None;
    }
    // Explicit authorship/deletion wins over every migration. Among seeds,
    // absence of an answer cannot erase an answer migrated on another device.
    Some(if deleted || value["legacy"] != true {
        2
    } else if keys.get(1).and_then(Value::as_str) == Some("days") && !value["answer"].is_null() {
        1
    } else {
        0
    })
}

fn seed_plan(conn: &Connection, plan: &Value) -> Result<(), String> {
    let Some(prompt) = plan.get("reflection").filter(|v| !v.is_null()) else {
        return Ok(());
    };
    let id = plan["id"].as_str().ok_or("reflection_invalid_data")?;
    let keys = path("plans", id, None);
    if exists(conn, &keys)? {
        return Ok(());
    }
    if !valid_snapshot(&clean_snapshot(plan), id) || !text(&prompt["prompt"], 160) {
        return invalid();
    }
    write(
        conn,
        keys,
        json!({"legacy":true,"enabled":true,"prompt":prompt["prompt"]}),
    )
}
fn seed_day(conn: &Connection, date: &str, id: &str, day: &Value) -> Result<(), String> {
    let keys = path("days", id, Some(date));
    if exists(conn, &keys)? {
        return Ok(());
    }
    let snapshot = &day["snapshot"];
    let Some(prompt) = snapshot.get("reflection").filter(|v| !v.is_null()) else {
        if day.get("reflection").is_some_and(|v| !v.is_null()) {
            return invalid();
        }
        return Ok(());
    };
    write(
        conn,
        keys,
        json!({"legacy":true,"prompt":prompt["prompt"],"snapshot":clean_snapshot(snapshot),"status":day["status"],"answer":day.get("reflection").cloned().unwrap_or(Value::Null)}),
    )
}

pub(crate) fn migrate_record(
    conn: &Connection,
    keys: &[Value],
    value: &Value,
    deleted: bool,
) -> Result<(), String> {
    if deleted {
        return Ok(());
    }
    let keys: Vec<_> = keys.iter().map(|v| v.as_str().unwrap_or("")).collect();
    match keys.as_slice() {
        [RECURRING, "plans", _] => seed_plan(conn, &value["row"]),
        [RECURRING, "days", date, id] => seed_day(conn, date, id, value),
        _ => Ok(()),
    }
}
fn migrate(conn: &Connection) -> Result<(), String> {
    let raw = crate::mvp_sync_db::read_ui(conn, RECURRING)?;
    let state = parse(raw.as_deref(), false)?;
    for plan in state["plans"].as_array().unwrap() {
        seed_plan(conn, plan)?;
    }
    for (date, days) in state["days"].as_object().unwrap() {
        let days = days.as_object().ok_or("reflection_invalid_data")?;
        for (id, day) in days {
            seed_day(conn, date, id, day)?;
        }
    }
    Ok(())
}
pub(crate) fn initialize(conn: &Connection) -> Result<(), String> {
    // Partial historical schema fixtures can legitimately have no UI state.
    // Match the sync initializer: there is nothing to migrate in that case.
    let has_ui: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='ui_state')",
            [],
            |row| row.get(0),
        )
        .map_err(error)?;
    if !has_ui {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(error)?;
    migrate(&tx)?;
    tx.commit().map_err(error)
}
pub(crate) fn get_bundle(conn: &mut Connection) -> Result<Bundle, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    migrate(&tx)?;
    let result = read(&tx)?;
    tx.commit().map_err(error)?;
    Ok(result)
}

fn strip_inline(state: &mut Value) {
    for plan in state["plans"].as_array_mut().unwrap() {
        if let Some(object) = plan.as_object_mut() {
            object.remove("reflection");
        }
    }
    for days in state["days"].as_object_mut().unwrap().values_mut() {
        if let Some(days) = days.as_object_mut() {
            days.retain(|_, day| day["_reflectionOnly"] != true);
            for day in days.values_mut() {
                if let Some(object) = day.as_object_mut() {
                    object.remove("reflection");
                    object.remove("_reflectionOnly");
                }
                if let Some(snapshot) = day["snapshot"].as_object_mut() {
                    snapshot.remove("reflection");
                }
            }
        }
    }
}
fn record_for<'a>(state: &'a Value, id: &str, date: &str) -> Option<&'a Value> {
    state["days"][date].get(id)
}
fn plan_for<'a>(state: &'a Value, id: &str) -> Option<&'a Value> {
    state["plans"].as_array()?.iter().find(|p| p["id"] == id)
}
fn validate_date(date: &str) -> Result<(), String> {
    crate::validate_date(date)?;
    if date > Local::now().format("%Y-%m-%d").to_string().as_str() {
        return invalid();
    }
    Ok(())
}
fn applies(snapshot: &Value, date: &str) -> bool {
    use chrono::Datelike;
    let Ok(day) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
        return false;
    };
    let start = snapshot["startsOn"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or(snapshot["createdOn"].as_str().unwrap_or(""));
    let end = snapshot["endsOn"].as_str().unwrap_or("");
    snapshot["active"] == true
        && date >= start
        && (end.is_empty() || date <= end)
        && snapshot["weekdays"]
            .as_array()
            .is_some_and(|days| days.contains(&json!(day.weekday().num_days_from_sunday())))
}

pub(crate) fn save_bundle(
    conn: &mut Connection,
    value: &str,
    expected_recurring: &str,
    expected_reflections: &str,
    change: Option<Change>,
) -> Result<Bundle, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    migrate(&tx)?;
    let before = read(&tx)?;
    if before.recurring.as_deref().unwrap_or("") != expected_recurring
        || before.reflections.as_deref().unwrap_or("") != expected_reflections
    {
        return Err("mvp_sync_stale_ui_state".into());
    }
    let original = parse(before.recurring.as_deref(), false)?;
    let sidecar = parse(before.reflections.as_deref(), true)?;
    let mut state = parse(Some(value), false)?;
    let mut seen = std::collections::BTreeSet::new();
    if state["plans"].as_array().unwrap().len() > 1000 {
        return invalid();
    }
    for plan in state["plans"].as_array().unwrap() {
        let id = plan["id"].as_str().ok_or("reflection_invalid_data")?;
        if !valid_id(id) || !seen.insert(id) {
            return invalid();
        }
    }
    for (date, days) in state["days"].as_object().unwrap() {
        crate::validate_date(date)?;
        for (id, day) in days.as_object().ok_or("reflection_invalid_data")? {
            if !valid_id(id) || day["snapshot"]["id"] != *id {
                return invalid();
            }
        }
    }
    if let Some(change) = change {
        match change {
            Change::Plan { id, prompt } => {
                if !valid_id(&id) {
                    return invalid();
                }
                let plan = plan_for(&state, &id).ok_or("reflection_plan_missing")?;
                if prompt.is_some() && !valid_snapshot(&clean_snapshot(plan), &id) {
                    return invalid();
                }
                write(
                    &tx,
                    path("plans", &id, None),
                    json!({"legacy":false,"enabled":prompt.is_some(),"prompt":prompt}),
                )?;
            }
            Change::Answer { id, date, answer } => {
                validate_date(&date)?;
                if !valid_id(&id) {
                    return invalid();
                }
                let old_day = sidecar["days"][&date].get(&id);
                let snapshot = old_day
                    .map(|d| &d["snapshot"])
                    .or_else(|| record_for(&original, &id, &date).map(|d| &d["snapshot"]))
                    .or_else(|| plan_for(&original, &id))
                    .ok_or("reflection_plan_missing")?;
                let snapshot = clean_snapshot(snapshot);
                if !valid_snapshot(&snapshot, &id) {
                    return invalid();
                }
                if old_day.is_none()
                    && record_for(&original, &id, &date).is_none()
                    && !applies(&snapshot, &date)
                {
                    return invalid();
                }
                let prompt = old_day
                    .map(|d| d["prompt"].clone())
                    .unwrap_or_else(|| sidecar["plans"][&id]["prompt"].clone());
                if !text(&prompt, 160) {
                    return Err("reflection_not_enabled".into());
                }
                // A request cannot smuggle a different historical plan into the
                // protected record. Its source is the committed state above.
                let supplied = record_for(&state, &id, &date).ok_or("reflection_day_missing")?;
                let expected_snapshot = record_for(&original, &id, &date)
                    .map(|d| &d["snapshot"])
                    .or_else(|| old_day.map(|d| &d["snapshot"]))
                    .or_else(|| plan_for(&original, &id))
                    .ok_or("reflection_plan_missing")?;
                if clean_snapshot(&supplied["snapshot"]) != clean_snapshot(expected_snapshot) {
                    return invalid();
                }
                let status = record_for(&original, &id, &date)
                    .map(|d| d["status"].clone())
                    .or_else(|| old_day.map(|d| d["status"].clone()))
                    .unwrap_or(json!("pending"));
                if supplied["status"] != status {
                    return invalid();
                }
                write(
                    &tx,
                    path("days", &id, Some(&date)),
                    json!({"legacy":false,"prompt":prompt,"snapshot":snapshot,"status":status,"answer":answer}),
                )?;
            }
        }
    }
    // Capture the original question when a reflected occurrence first gets a
    // status, even before an answer. Later plan edits cannot rewrite that day.
    let current = parse(crate::mvp_sync_db::read_ui(&tx, KEY)?.as_deref(), true)?;
    for (date, days) in state["days"].as_object().unwrap() {
        for (id, day) in days.as_object().unwrap() {
            let keys = path("days", id, Some(date));
            if day["_reflectionOnly"] == true || exists(&tx, &keys)? {
                continue;
            }
            if current["plans"][id]["enabled"] == true {
                let snapshot = clean_snapshot(&day["snapshot"]);
                if !valid_snapshot(&snapshot, id) {
                    return invalid();
                }
                let committed = record_for(&original, id, date)
                    .map(|v| &v["snapshot"])
                    .or_else(|| plan_for(&state, id))
                    .ok_or("reflection_plan_missing")?;
                if clean_snapshot(committed) != snapshot {
                    return invalid();
                }
                write(
                    &tx,
                    keys,
                    json!({"legacy":false,"prompt":current["plans"][id]["prompt"],"snapshot":snapshot,"status":day["status"],"answer":null}),
                )?;
            }
        }
    }
    strip_inline(&mut state);
    crate::mvp_sync_db::set_ui_in_transaction(
        &tx,
        RECURRING,
        &state.to_string(),
        Some(expected_recurring),
    )?;
    let result = read(&tx)?;
    tx.commit().map_err(error)?;
    Ok(result)
}

#[tauri::command]
pub fn recurring_get_bundle(state: State<'_, crate::AppState>) -> Result<Bundle, String> {
    let mut conn = state.0.lock().map_err(error)?;
    get_bundle(&mut conn)
}
#[tauri::command(rename_all = "camelCase")]
pub fn recurring_save_bundle(
    value: String,
    expected_recurring: String,
    expected_reflections: String,
    reflection_change: Option<Change>,
    state: State<'_, crate::AppState>,
) -> Result<Bundle, String> {
    let mut conn = state.0.lock().map_err(error)?;
    save_bundle(
        &mut conn,
        &value,
        &expected_recurring,
        &expected_reflections,
        reflection_change,
    )
}

#[cfg(test)]
#[path = "recurring_reflections_tests.rs"]
pub(crate) mod tests;
