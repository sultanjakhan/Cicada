//! Calendar Workspace persistence. Sync uses the separate MVP record adapter;
//! this module never opens the legacy application database.
use crate::{fail, get_item, validate_date, validate_time, AppState, Item};
use chrono::{Local, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::State;
use uuid::Uuid;

fn now() -> String {
    Utc::now().to_rfc3339()
}
const RECURRING_KEY: &str = "calendar_recurring_v1";
fn recurring_raw(conn: &Connection) -> Result<String, String> {
    crate::mvp_sync_db::read_ui(conn, RECURRING_KEY)?
        .ok_or_else(|| fail("recurring state not found"))
}
fn schedule_context(
    conn: &Connection,
    source_id: &str,
) -> Result<(String, String, usize, Value, String), String> {
    let parts: Vec<Value> =
        serde_json::from_str(source_id).map_err(|_| fail("invalid schedule source"))?;
    if parts.len() != 3 {
        return Err(fail("invalid schedule source"));
    }
    let plan_id = parts[0]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| fail("invalid schedule source"))?
        .to_string();
    let origin = parts[1]
        .as_str()
        .ok_or_else(|| fail("invalid schedule source"))?
        .to_string();
    validate_date(&origin)?;
    let today = Local::now().format("%Y-%m-%d").to_string();
    if origin > today {
        return Err(fail("schedule date is in the future"));
    }
    let index = parts[2]
        .as_u64()
        .filter(|v| *v <= 10_000)
        .ok_or_else(|| fail("invalid schedule source"))? as usize;
    let canonical = json!([plan_id, origin, index]).to_string();
    if canonical != source_id {
        return Err(fail("invalid schedule source"));
    }
    let state: Value =
        serde_json::from_str(&recurring_raw(conn)?).map_err(|_| fail("invalid recurring state"))?;
    let record = state["days"][&origin][&plan_id].clone();
    if record.is_null() || record["status"] != "pending" {
        return Err(fail("schedule run is not pending"));
    }
    let snapshot = record["snapshot"].clone();
    if state["version"] != 1
        || snapshot["id"].as_str() != Some(plan_id.as_str())
        || snapshot["kind"] != "action"
    {
        return Err(fail("schedule snapshot is not runnable"));
    }
    let mode = snapshot["mode"].as_str().unwrap_or("check");
    if !matches!(mode, "activity" | "chain") {
        return Err(fail("schedule is not runnable"));
    }
    let snapshot_title = snapshot["title"]
        .as_str()
        .ok_or_else(|| fail("schedule title is invalid"))?;
    validate_title(snapshot_title)?;
    let activity_steps = vec![json!({"title": snapshot_title})];
    let snapshot_steps = if mode == "activity" { Some(&activity_steps) } else { snapshot["steps"]
        .as_array()
        .filter(|steps| (1..=50).contains(&steps.len())) }
        .ok_or_else(|| fail("schedule steps are invalid"))?;
    for step in snapshot_steps {
        validate_title(
            step["title"]
                .as_str()
                .ok_or_else(|| fail("schedule step title is invalid"))?,
        )?;
    }
    let steps = record["run"]["steps"]
        .as_array()
        .ok_or_else(|| fail("schedule run has no steps"))?;
    if steps.len() != snapshot_steps.len() {
        return Err(fail("schedule run steps do not match snapshot"));
    }
    let created_at = record["run"]["createdAt"]
        .as_str()
        .ok_or_else(|| fail("schedule run timestamp is invalid"))?;
    chrono::DateTime::parse_from_rfc3339(created_at)
        .map_err(|_| fail("schedule run timestamp is invalid"))?;
    for step in steps {
        if !matches!(step["status"].as_str(), Some("pending" | "done" | "skipped")) {
            return Err(fail("schedule step status is invalid"));
        }
        validate_title(
            step["title"]
                .as_str()
                .ok_or_else(|| fail("schedule step title is invalid"))?,
        )?;
    }
    let first_pending = steps
        .iter()
        .position(|step| step["status"] == "pending")
        .ok_or_else(|| fail("schedule run is complete"))?;
    if index != first_pending {
        return Err(fail("schedule step is not current"));
    }
    let step = steps
        .get(index)
        .ok_or_else(|| fail("schedule step not found"))?;
    if step["status"] != "pending" {
        return Err(fail("schedule step is not pending"));
    }
    let title = if mode == "chain" {
        format!(
            "{} · {}",
            snapshot["title"].as_str().unwrap_or(""),
            step["title"].as_str().unwrap_or("")
        )
    } else {
        snapshot["title"].as_str().unwrap_or("").to_string()
    };
    validate_title(&title)?;
    Ok((plan_id, origin, index, state, title))
}
fn set_schedule_step(
    tx: &rusqlite::Transaction<'_>,
    source_id: &str,
    status: &str,
) -> Result<(), String> {
    if !matches!(status, "done" | "skipped") {
        return Err(fail("invalid schedule step status"));
    }
    let raw = crate::mvp_sync_db::read_ui(tx, RECURRING_KEY)?
        .ok_or_else(|| fail("recurring state not found"))?;
    let (plan_id, origin, index, mut state, _) = schedule_context(tx, source_id)?;
    let record = state["days"][&origin][&plan_id]
        .as_object_mut()
        .ok_or_else(|| fail("schedule run not found"))?;
    let steps = record["run"]["steps"]
        .as_array_mut()
        .ok_or_else(|| fail("schedule run has no steps"))?;
    steps[index]["status"] = json!(status);
    let has_pending = steps.iter().any(|step| step["status"] == "pending");
    let has_skipped = steps.iter().any(|step| step["status"] == "skipped");
    record.insert(
        "status".into(),
        json!(if has_pending {
            "pending"
        } else if has_skipped {
            "skipped"
        } else {
            "done"
        }),
    );
    crate::mvp_sync_db::set_ui_in_transaction(tx, RECURRING_KEY, &state.to_string(), Some(&raw))
}
fn schedule_projections(
    conn: &Connection,
    start: Option<&str>,
    end: Option<&str>,
) -> Result<Vec<Value>, String> {
    let raw = match crate::mvp_sync_db::read_ui(conn, RECURRING_KEY)? {
        Some(v) => v,
        None => return Ok(Vec::new()),
    };
    let state: Value = serde_json::from_str(&raw).map_err(|_| fail("invalid recurring state"))?;
    let mut aggregates: HashMap<String, (bool, i64, i64, Option<i64>, Option<String>)> =
        HashMap::new();
    let mut statement = conn
        .prepare(
            "SELECT source_id, COALESCE(MAX(is_active),0), COALESCE(SUM(CASE WHEN duration_seconds>0 THEN duration_seconds ELSE duration_minutes*60 END),0), COUNT(*), (SELECT id FROM timeline_blocks latest WHERE latest.source_type='schedule' AND latest.source_id=timeline_blocks.source_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1), (SELECT date FROM timeline_blocks latest WHERE latest.source_type='schedule' AND latest.source_id=timeline_blocks.source_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1) FROM timeline_blocks WHERE source_type='schedule' GROUP BY source_id",
        )
        .map_err(|e| fail(e.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? != 0,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .map_err(|e| fail(e.to_string()))?;
    for row in rows {
        let (source_id, active, seconds, has_work, block_id, block_date) =
            row.map_err(|e| fail(e.to_string()))?;
        aggregates.insert(source_id, (active, seconds, has_work, block_id, block_date));
    }
    drop(statement);
    let mut out = Vec::new();
    if let Some(days) = state["days"].as_object() {
        for (origin, records) in days {
            if start.is_some_and(|v| origin.as_str() < v)
                || end.is_some_and(|v| origin.as_str() > v)
            {
                continue;
            }
            if let Some(records) = records.as_object() {
                for (plan_id, record) in records {
                    let Some(steps) = record["run"]["steps"].as_array() else {
                        continue;
                    };
                    let snapshot = &record["snapshot"];
                    let mode = snapshot["mode"].as_str().unwrap_or("check");
                    if !matches!(mode, "activity" | "chain") {
                        continue;
                    }
                    for (index, step) in steps.iter().enumerate() {
                        let source_id = json!([plan_id, origin, index]).to_string();
                        let (active, seconds, has_work, block_id, block_date) = aggregates
                            .get(&source_id)
                            .cloned()
                            .unwrap_or((false, 0, 0, None, None));
                        let title = if mode == "chain" {
                            format!(
                                "{} · {}",
                                snapshot["title"].as_str().unwrap_or(""),
                                step["title"].as_str().unwrap_or("")
                            )
                        } else {
                            snapshot["title"].as_str().unwrap_or("").to_string()
                        };
                        let status = step["status"].as_str().unwrap_or("pending");
                        out.push(json!({"id":source_id,"source_type":"schedule","source_id":source_id,"title":title,"date":origin,"completion_date":origin,"block_id":block_id,"block_date":block_date,"completed":status!="pending","status_extra":status,"tracking_mode":"track","is_active":active,"has_work":has_work>0,"actual_minutes":seconds/60}));
                    }
                }
            }
        }
    }
    Ok(out)
}
fn lock<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, Connection>, String> {
    state.0.lock().map_err(|_| fail("database lock poisoned"))
}
fn date(v: &Option<String>) -> Result<(), String> {
    if let Some(v) = v {
        validate_date(v)?;
    }
    Ok(())
}
fn item_value(
    item: &Item,
    category: String,
    color: String,
    priority: i64,
    archived: bool,
    tags: String,
    blocks: Option<String>,
    status: String,
) -> Value {
    let duration_minutes = if item.kind == "task" && item.duration_minutes == 0 {
        None
    } else {
        Some(item.duration_minutes)
    };
    let mut value = json!({"id":item.id,"title":item.title,"content":item.notes,"description":item.notes,"date":item.date,"time":item.time,"duration_minutes":duration_minutes,"category":category,"color":color,"priority":priority,"completed":item.completed,"version":item.version,"created_at":item.created_at,"updated_at":item.updated_at,"source":"manual","linked_tab":"","tags":tags,"archived":archived,"tab_name":if item.kind=="task" {"calendar"} else {""},"status":if item.completed && status=="task" {"done"} else {&status},"due_date":if item.kind=="task" {item.date.clone()} else {None},"content_blocks":blocks});
    crate::health_sleep::decorate(&mut value, &item.id, &tags);
    value
}
fn load(conn: &Connection, id: &str) -> Result<Value, String> {
    let item = get_item(conn, id)?;
    let meta = conn
        .query_row(
            "SELECT category,color,priority,archived,tags,content_blocks,status FROM items WHERE id=?1",
            [id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get::<_, i64>(3)? != 0,
                    r.get(4)?,
                    r.get(5)?,r.get(6)?,
                ))
            },
        )
        .map_err(|e| fail(format!("read calendar item: {e}")))?;
    Ok(item_value(
        &item, meta.0, meta.1, meta.2, meta.3, meta.4, meta.5, meta.6,
    ))
}
fn item_id(value: &str) -> Result<&str, String> {
    if value.is_empty() {
        Err(fail("record id is required"))
    } else {
        Ok(value)
    }
}
fn validate_title(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.trim().chars().count() > 500 {
        Err(fail("title must contain 1 to 500 characters"))
    } else {
        Ok(())
    }
}
fn validate_note_status(value: &str) -> Result<(), String> {
    if matches!(value, "note" | "task" | "done") {
        Ok(())
    } else {
        Err(fail("status must be note, task or done"))
    }
}
fn duration(value: i64) -> Result<(), String> {
    if (1..=5_256_000).contains(&value) {
        Ok(())
    } else {
        Err(fail("duration_minutes must be a positive safe duration"))
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_events(month: u32, year: i32, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    if !(1..=12).contains(&month) {
        return Err(fail("month must be 1..12"));
    }
    let conn = lock(&state)?;
    let prefix = format!("{year}-{month:02}%");
    let mut s=conn.prepare("SELECT id FROM items WHERE kind='event' AND archived=0 AND date LIKE ?1 ORDER BY date,time,id").map_err(|e|fail(e.to_string()))?;
    let ids = s
        .query_map([prefix], |r| r.get::<_, String>(0))
        .map_err(|e| fail(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| fail(e.to_string()))?;
    drop(s);
    ids.into_iter().map(|id| load(&conn, &id)).collect()
}
#[tauri::command]
pub fn get_all_events(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let conn = lock(&state)?;
    let mut s=conn.prepare("SELECT id FROM items WHERE kind='event' AND archived=0 ORDER BY date DESC,time DESC,id").map_err(|e|fail(e.to_string()))?;
    let ids = s
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| fail(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| fail(e.to_string()))?;
    drop(s);
    ids.into_iter().map(|id| load(&conn, &id)).collect()
}
#[tauri::command(rename_all = "camelCase")]
pub fn create_event(
    title: String,
    description: String,
    date: String,
    time: String,
    duration_minutes: i64,
    category: String,
    color: String,
    priority: Option<i64>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    validate_title(&title)?;
    validate_date(&date)?;
    if !time.is_empty() {
        validate_time(&time)?;
    }
    if time.is_empty() {
        if duration_minutes != 0 {
            duration(duration_minutes)?;
        }
    } else {
        duration(duration_minutes)?;
    }
    let conn = lock(&state)?;
    let id = Uuid::new_v4().to_string();
    let n = now();
    conn.execute("INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,priority,archived,tags) VALUES(?1,'event',?2,?3,?4,?5,?6,0,1,?7,?7,?8,?9,?10,0,'')",params![id,title.trim(),description,date,time,duration_minutes,n,category,color,priority.unwrap_or(0)]).map_err(|e|fail(e.to_string()))?;
    Ok(id)
}
#[tauri::command(rename_all = "camelCase")]
pub fn update_event(
    id: String,
    title: Option<String>,
    description: Option<String>,
    date: Option<String>,
    time: Option<String>,
    duration_minutes: Option<i64>,
    category: Option<String>,
    color: Option<String>,
    completed: Option<bool>,
    priority: Option<i64>,
    expected_version: Option<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = lock(&state)?;
    crate::health_sleep::editable(&id)?;
    let current = get_item(&conn, item_id(&id)?)?;
    if current.kind != "event" {
        return Err(fail("event not found"));
    }
    let new_date = date.unwrap_or_else(|| current.date.unwrap_or_default());
    validate_date(&new_date)?;
    if let Some(ref value) = title {
        validate_title(value)?;
    }
    let effective_time = time
        .as_deref()
        .unwrap_or(current.time.as_deref().unwrap_or(""));
    if let Some(ref value) = time {
        if !value.is_empty() {
            validate_time(value)?;
        }
    }
    if let Some(value) = duration_minutes {
        if !(effective_time.is_empty() && value == 0) {
            duration(value)?;
        }
    }
    let affected=conn.execute("UPDATE items SET title=COALESCE(?1,title),notes=COALESCE(?2,notes),date=?3,time=COALESCE(?4,time),duration_minutes=COALESCE(?5,duration_minutes),completed=COALESCE(?6,completed),category=COALESCE(?7,category),color=COALESCE(?8,color),priority=COALESCE(?9,priority),version=version+1,updated_at=?10 WHERE id=?11 AND kind='event' AND (?12 IS NULL OR version=?12)",params![title.map(|v|v.trim().to_string()),description,new_date,time,duration_minutes,completed.map(|v|v as i64),category,color,priority,now(),id,expected_version]).map_err(|e|fail(e.to_string()))?;
    if affected != 1 {
        Err(fail("event changed elsewhere or was deleted"))
    } else {
        Ok(())
    }
}
#[tauri::command]
pub fn delete_event(id: String, state: State<'_, AppState>) -> Result<(), String> {
    crate::health_sleep::editable(&id)?;
    let mut conn = lock(&state)?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| fail(e.to_string()))?;
    let active: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_blocks WHERE source_type='event' AND source_id=?1 AND is_active=1)",
            [&id],
            |r| r.get(0),
        )
        .map_err(|e| fail(e.to_string()))?;
    if active {
        return Err(fail("event has an active timer"));
    }
    transaction
        .execute(
            "DELETE FROM calendar_task_goals WHERE source_type='event' AND source_id=?1",
            [&id],
        )
        .map_err(|e| fail(e.to_string()))?;
    let affected = transaction
        .execute("DELETE FROM items WHERE id=?1 AND kind='event'", [&id])
        .map_err(|e| fail(e.to_string()))?;
    if affected != 1 {
        return Err(fail("event not found"));
    }
    transaction.commit().map_err(|e| fail(e.to_string()))?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_notes(
    filter: Option<String>,
    search: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let conn = lock(&state)?;
    let mut q = "SELECT id FROM items WHERE kind='task'".to_string();
    if filter.as_deref() == Some("tasks") {
        q.push_str(" AND archived=0 AND status IN ('task','done')");
    } else if filter.as_deref() == Some("tab:calendar") {
        q.push_str(" AND archived=0 AND status='note'");
    } else {
        q.push_str(" AND status='note'");
    }
    if search.as_deref().is_some_and(|v| !v.trim().is_empty()) {
        q.push_str(" AND (title LIKE ?1 OR notes LIKE ?1)");
    }
    q.push_str(" ORDER BY completed,date,updated_at DESC");
    let mut s = conn.prepare(&q).map_err(|e| fail(e.to_string()))?;
    let ids = match search {
        Some(q) => s
            .query_map([format!("%{q}%")], |r| r.get::<_, String>(0))
            .map_err(|e| fail(e.to_string()))?
            .collect::<Result<Vec<_>, _>>(),
        None => s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| fail(e.to_string()))?
            .collect::<Result<Vec<_>, _>>(),
    }
    .map_err(|e| fail(e.to_string()))?;
    drop(s);
    ids.into_iter().map(|id| load(&conn, &id)).collect()
}
#[tauri::command(rename_all = "camelCase")]
pub fn get_note(id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = lock(&state)?;
    let item = get_item(&conn, &id)?;
    if item.kind != "task" {
        return Err(fail("note not found"));
    }
    load(&conn, &id)
}
#[tauri::command(rename_all = "camelCase")]
pub fn create_note(
    title: String,
    content: String,
    tags: String,
    status: Option<String>,
    due_date: Option<String>,
    priority: Option<i64>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    validate_title(&title)?;
    date(&due_date)?;
    let record_status = status.unwrap_or_else(|| "note".into());
    validate_note_status(&record_status)?;
    let conn = lock(&state)?;
    let id = Uuid::new_v4().to_string();
    let n = now();
    conn.execute("INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,priority,archived,tags,status) VALUES(?1,'task',?2,?3,?4,NULL,30,?5,1,?6,?6,'task','#9B9B9B',?7,0,?8,?9)",params![id,title.trim(),content,due_date,(record_status=="done") as i64,n,priority.unwrap_or(0),tags,record_status]).map_err(|e|fail(e.to_string()))?;
    Ok(id)
}
#[tauri::command(rename_all = "camelCase")]
pub fn update_note(
    id: String,
    title: String,
    content: String,
    tags: String,
    archived: Option<bool>,
    due_date: Option<String>,
    content_blocks: Option<String>,
    priority: Option<i64>,
    expected_version: Option<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    date(&due_date)?;
    let conn = lock(&state)?;
    let n = now();
    let changed=conn.execute("UPDATE items SET title=?1,notes=?2,tags=?3,archived=COALESCE(?4,archived),date=COALESCE(?5,date),content_blocks=COALESCE(?6,content_blocks),priority=COALESCE(?7,priority),version=version+1,updated_at=?8 WHERE id=?9 AND kind='task' AND (?10 IS NULL OR version=?10)",params![title.trim(),content,tags,archived.map(|v|v as i64),due_date,content_blocks,priority,n,id,expected_version]).map_err(|e|fail(e.to_string()))?;
    if changed == 1 {
        Ok(())
    } else {
        Err(fail("note changed elsewhere or was deleted"))
    }
}
#[tauri::command]
pub fn update_note_status(
    id: String,
    status: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_note_status(&status)?;
    let conn = lock(&state)?;
    let changed=conn.execute("UPDATE items SET completed=?1,version=version+1,updated_at=?2 WHERE id=?3 AND kind='task'",params![(status=="done") as i64,now(),id]).map_err(|e|fail(e.to_string()))?;
    if changed == 1 {
        Ok(())
    } else {
        Err(fail("task not found"))
    }
}
#[tauri::command]
pub fn toggle_note_archive(id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let conn = lock(&state)?;
    conn.execute("UPDATE items SET archived=1-archived,version=version+1,updated_at=?1 WHERE id=?2 AND kind='task'",params![now(),id]).map_err(|e|fail(e.to_string()))?;
    conn.query_row("SELECT archived!=0 FROM items WHERE id=?1", [id], |r| {
        r.get(0)
    })
    .map_err(|_| fail("note not found"))
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_calendar_tasks(
    include_completed: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let conn = lock(&state)?;
    let predicate = if include_completed.unwrap_or(false) {
        "kind='task' AND archived=0 AND status IN ('task','done')"
    } else {
        "kind='task' AND archived=0 AND status='task' AND completed=0"
    };
    calendar_list(&conn, predicate, "s.date IS NULL,s.date,s.id", &[], true)
}

// Only the two list commands supply these static SQL fragments. External values
// remain bound parameters. The mapper performs no per-record database reads.
fn calendar_list(
    conn: &Connection,
    predicate: &str,
    order: &str,
    args: &[&dyn rusqlite::ToSql],
    tasks_only: bool,
) -> Result<Vec<Value>, String> {
    let sql = format!(
        "WITH selected AS (
            SELECT id,kind,title,date,time,duration_minutes,category,color,completed,status,priority,tags,
                CASE WHEN kind='event' THEN 'event' ELSE 'note' END AS source_type
            FROM items WHERE {predicate}
        ), timeline AS (
            SELECT t.source_type,t.source_id,MAX(t.is_active) AS active,
                SUM(CASE WHEN t.is_active=0 THEN CASE WHEN t.duration_seconds > 0 THEN t.duration_seconds ELSE t.duration_minutes * 60 END ELSE 0 END) AS seconds,
                COUNT(*) AS has_work
            FROM timeline_blocks t JOIN selected s
                ON s.source_type=t.source_type AND s.id=t.source_id
            GROUP BY t.source_type,t.source_id
        )
        SELECT s.id,s.kind,s.title,s.date,s.time,s.duration_minutes,s.category,s.color,
            s.completed,s.status,s.priority,COALESCE(t.active,0),COALESCE(t.seconds,0),COALESCE(t.has_work,0),s.tags
        FROM selected s LEFT JOIN timeline t ON t.source_type=s.source_type AND t.source_id=s.id
        ORDER BY {order}"
    );
    let mut statement = conn.prepare(&sql).map_err(|e| fail(e.to_string()))?;
    let rows = statement
        .query_map(args, |row| {
            let kind: String = row.get(1)?;
            let is_task = kind == "task";
            let completed: bool = row.get(8)?;
            let status: String = row.get(9)?;
            let duration: i64 = row.get(5)?;
            let mut value = json!({
                "source_type": if is_task {"note"} else {"event"},
                "source_id": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(2)?,
                "date": row.get::<_, Option<String>>(3)?,
                "planned_time": if tasks_only {None} else {row.get::<_, Option<String>>(4)?},
                "duration_minutes": if is_task && duration==0 {None} else {Some(duration)},
                "completed": completed,
                "status_extra": if completed && status=="task" {"done"} else {&status},
                "priority": row.get::<_, i64>(10)?,
                "tracking_mode": if is_task {"check"} else {"track"},
                "is_active": row.get::<_, i64>(11)? != 0,
                "actual_minutes": row.get::<_, i64>(12)? / 60,
                "has_work": row.get::<_, i64>(13)? > 0,
            });
            if !tasks_only {
                value["category"] = json!(row.get::<_, String>(6)?);
                value["color"] = json!(row.get::<_, String>(7)?);
            }
            crate::health_sleep::decorate(&mut value, &row.get::<_,String>(0)?, &row.get::<_,String>(14)?);
            Ok(value)
        })
        .map_err(|e| fail(e.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| fail(e.to_string()))
}
#[tauri::command]
pub fn get_calendar_task(id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = lock(&state)?;
    let mut value = load(&conn, &id)?;
    if value["status"] != "task" && value["status"] != "done" {
        return Err(fail("task not found"));
    }
    let goal: Option<String> = conn
        .query_row(
            "SELECT goal_id FROM calendar_task_goals WHERE source_type='note' AND source_id=?1",
            [&id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| fail(e.to_string()))?;
    value["goal_id"] = json!(goal);
    Ok(value)
}
#[tauri::command(rename_all = "camelCase")]
pub fn save_calendar_task(
    id: Option<String>,
    title: String,
    due_date: Option<String>,
    estimate_minutes: Option<i64>,
    goal_id: Option<String>,
    expected_version: Option<i64>,
    important: Option<bool>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    validate_title(&title)?;
    date(&due_date)?;
    if let Some(value) = estimate_minutes {
        duration(value)?;
    }
    // Omitted importance preserves existing priorities for date-only edits and
    // older clients. The task UI exposes only the explicit highest priority.
    let priority = important.map(|value| if value { 5_i64 } else { 0_i64 });
    let mut conn = lock(&state)?;
    let transaction = conn.transaction().map_err(|e| fail(e.to_string()))?;
    if let Some(goal) = goal_id.as_deref() {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM calendar_goals WHERE id=?1)",
                [goal],
                |r| r.get(0),
            )
            .map_err(|e| fail(e.to_string()))?;
        if !exists {
            return Err(fail("goal not found"));
        }
    }
    let item_id = match id {
        Some(id) => {
            let changed=transaction.execute("UPDATE items SET title=?1,date=?2,duration_minutes=COALESCE(?3,0),updated_at=?4,version=version+1,priority=COALESCE(?7,priority) WHERE id=?5 AND kind='task' AND status IN ('task','done') AND (?6 IS NULL OR version=?6)",params![title.trim(),due_date,estimate_minutes,now(),id,expected_version,priority]).map_err(|e|fail(e.to_string()))?;
            if changed != 1 {
                return Err(fail("task changed elsewhere or was deleted"));
            }
            id
        }
        None => {
            if expected_version.is_some() {
                return Err(fail("new task cannot have expected version"));
            }
            let id = Uuid::new_v4().to_string();
            let n = now();
            transaction.execute("INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,priority,archived,tags,status) VALUES(?1,'task',?2,'',?3,NULL,COALESCE(?4,0),0,1,?5,?5,'task','#9B9B9B',COALESCE(?6,0),0,'','task')",params![id,title.trim(),due_date,estimate_minutes,n,priority]).map_err(|e|fail(e.to_string()))?;
            id
        }
    };
    if let Some(goal) = goal_id {
        transaction.execute("INSERT INTO calendar_task_goals(source_type,source_id,goal_id,created_at) VALUES('note',?1,?2,?3) ON CONFLICT(source_type,source_id) DO UPDATE SET goal_id=excluded.goal_id",params![&item_id,goal,now()]).map_err(|e|fail(e.to_string()))?;
    } else {
        transaction
            .execute(
                "DELETE FROM calendar_task_goals WHERE source_type='note' AND source_id=?1",
                [&item_id],
            )
            .map_err(|e| fail(e.to_string()))?;
    }
    transaction.commit().map_err(|e| fail(e.to_string()))?;
    Ok(item_id)
}
#[tauri::command]
pub fn complete_calendar_task(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = lock(&state)?;
    let changed=conn.execute("UPDATE items SET completed=1,status='done',version=version+1,updated_at=?1 WHERE id=?2 AND kind='task' AND archived=0 AND status IN ('task','done') AND NOT EXISTS(SELECT 1 FROM timeline_blocks WHERE source_type='note' AND source_id=?2 AND is_active=1)",params![now(),id]).map_err(|e|fail(e.to_string()))?;
    if changed == 1 {
        Ok(())
    } else {
        Err(fail("task is active or no longer available"))
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_calendar_records(
    start: String,
    end: String,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    validate_date(&start)?;
    validate_date(&end)?;
    let conn = lock(&state)?;
    let mut rows = calendar_list(
        &conn,
        "archived=0 AND status!='note' AND ((kind='event' AND date<=?2 AND ((date>=?1 AND NULLIF(time,'') IS NULL) OR (NULLIF(time,'') IS NOT NULL AND datetime(date || ' ' || substr(time,1,5), '+' || duration_minutes || ' minutes')>datetime(?1)))) OR (kind='task' AND (date BETWEEN ?1 AND ?2 OR date IS NULL)))",
        "s.date,s.time,s.id",
        params![start, end],
        false,
    )?;
    rows.extend(schedule_projections(&conn, Some(&start), Some(&end))?);
    Ok(rows)
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_ui_state(key: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = lock(&state)?;
    conn.query_row("SELECT value FROM ui_state WHERE key=?1", [key], |r| {
        r.get(0)
    })
    .optional()
    .map_err(|e| fail(e.to_string()))
}
#[tauri::command(rename_all = "camelCase")]
pub fn set_ui_state(
    key: String,
    value: String,
    expected_value: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = lock(&state)?;
    crate::mvp_sync_db::set_ui(&conn, &key, &value, expected_value.as_deref())
}
#[tauri::command]
pub fn start_calendar_day(state: State<'_, AppState>) -> Result<Value, String> {
    let conn = lock(&state)?;
    crate::mvp_sync_db::start_day(&conn)
}

#[tauri::command]
pub fn get_goals(
    _tab_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let conn = lock(&state)?;
    let mut s=conn.prepare("SELECT id,title,target_value,current_value,unit,deadline,goal_kind,description,criteria,parent_goal_id FROM calendar_goals ORDER BY created_at").map_err(|e|fail(e.to_string()))?;
    let rows=s.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"target_value":r.get::<_,f64>(2)?,"current_value":r.get::<_,Option<f64>>(3)?,"unit":r.get::<_,String>(4)?,"deadline":r.get::<_,Option<String>>(5)?,"goal_kind":r.get::<_,String>(6)?,"description":r.get::<_,String>(7)?,"criteria":r.get::<_,String>(8)?,"parent_goal_id":r.get::<_,Option<String>>(9)?,"status":"active"}))).map_err(|e|fail(e.to_string()))?.collect::<Result<Vec<_>,_>>().map_err(|e|fail(e.to_string()))?;
    drop(s);
    Ok(rows)
}
#[tauri::command(rename_all = "camelCase")]
pub fn save_calendar_goal(
    id: Option<String>,
    title: String,
    target_value: f64,
    unit: String,
    deadline: Option<String>,
    goal_kind: Option<String>,
    description: String,
    criteria: String,
    parent_goal_id: Option<String>,
    clear_parent: bool,
    current_value: Option<f64>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    date(&deadline)?;
    if title.trim().is_empty()
        || title.chars().count() > 500
        || !target_value.is_finite()
        || target_value <= 0.0
    {
        return Err(fail("invalid goal"));
    }
    let mut conn = lock(&state)?;
    let existing = id.is_some();
    let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let goal_kind = goal_kind.unwrap_or_else(|| "goal".into());
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| fail(e.to_string()))?;
    let previous_kind = if existing {
        Some(
            transaction
                .query_row(
                    "SELECT goal_kind FROM calendar_goals WHERE id=?1",
                    [&id],
                    |r| r.get::<_, String>(0),
                )
                .map_err(|_| fail("goal not found"))?,
        )
    } else {
        None
    };
    let effective_parent = if clear_parent {
        None
    } else {
        parent_goal_id.as_deref()
    };
    if let Some(parent) = effective_parent {
        if parent == id {
            return Err(fail("goal cannot be its own parent"));
        }
        if goal_kind != "goal" {
            return Err(fail("only goal can have a parent"));
        }
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM calendar_goals WHERE id=?1 AND goal_kind='goal')",
                [parent],
                |r| r.get(0),
            )
            .map_err(|e| fail(e.to_string()))?;
        if !exists {
            return Err(fail("parent goal not found or cannot have children"));
        }
        let cycle: bool=transaction.query_row("WITH RECURSIVE descendants(id) AS (SELECT id FROM calendar_goals WHERE parent_goal_id=?1 UNION ALL SELECT g.id FROM calendar_goals g JOIN descendants d ON g.parent_goal_id=d.id) SELECT EXISTS(SELECT 1 FROM descendants WHERE id=?2)",params![id,parent],|r|r.get(0)).map_err(|e|fail(e.to_string()))?;
        if cycle {
            return Err(fail("goal parent would create a cycle"));
        }
    }
    let n = now();
    if existing {
        let changed = transaction.execute("UPDATE calendar_goals SET title=?1,target_value=?2,current_value=?3,unit=?4,deadline=?5,goal_kind=?6,description=?7,criteria=?8,parent_goal_id=?9,updated_at=?10 WHERE id=?11",params![title.trim(),target_value,current_value,unit,deadline,goal_kind,description,criteria,effective_parent,n,&id]).map_err(|e|fail(e.to_string()))?;
        if changed != 1 {
            return Err(fail("goal not found"));
        }
        if previous_kind.as_deref() != Some("daily_norm") && goal_kind == "daily_norm" {
            transaction.execute("UPDATE calendar_goals SET parent_goal_id=NULL,updated_at=?1 WHERE parent_goal_id=?2",params![now(),&id]).map_err(|e|fail(e.to_string()))?;
        }
    } else {
        transaction.execute("INSERT INTO calendar_goals(id,title,target_value,current_value,unit,deadline,goal_kind,description,criteria,parent_goal_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",params![&id,title.trim(),target_value,current_value,unit,deadline,goal_kind,description,criteria,effective_parent,n]).map_err(|e|fail(e.to_string()))?;
    }
    transaction.commit().map_err(|e| fail(e.to_string()))?;
    Ok(id)
}
#[tauri::command]
pub fn delete_goal(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut conn = lock(&state)?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| fail(e.to_string()))?;
    transaction
        .execute("DELETE FROM calendar_task_goals WHERE goal_id=?1", [&id])
        .map_err(|e| fail(e.to_string()))?;
    transaction
        .execute(
            "UPDATE calendar_goals SET parent_goal_id=NULL,updated_at=?1 WHERE parent_goal_id=?2",
            params![now(), &id],
        )
        .map_err(|e| fail(e.to_string()))?;
    transaction
        .execute("DELETE FROM calendar_goals WHERE id=?1", [id])
        .map_err(|e| fail(e.to_string()))?;
    transaction.commit().map_err(|e| fail(e.to_string()))?;
    Ok(())
}
#[tauri::command]
pub fn get_calendar_task_goals(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let conn = lock(&state)?;
    let mut s = conn
        .prepare("SELECT source_type,source_id,goal_id FROM calendar_task_goals")
        .map_err(|e| fail(e.to_string()))?;
    let rows=s.query_map([],|r|Ok(json!({"source_type":r.get::<_,String>(0)?,"source_id":r.get::<_,String>(1)?,"goal_id":r.get::<_,String>(2)?}))).map_err(|e|fail(e.to_string()))?.collect::<Result<Vec<_>,_>>().map_err(|e|fail(e.to_string()))?;
    drop(s);
    Ok(rows)
}
#[tauri::command(rename_all = "camelCase")]
pub fn set_calendar_task_goal(
    source_type: String,
    source_id: String,
    goal_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    crate::health_sleep::editable(&source_id)?;
    if !matches!(source_type.as_str(), "note" | "event") {
        return Err(fail("invalid source type"));
    }
    let conn = lock(&state)?;
    let expected_kind = if source_type == "note" {
        "task"
    } else {
        "event"
    };
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM items WHERE id=?1 AND kind=?2)",
            params![&source_id, expected_kind],
            |r| r.get(0),
        )
        .map_err(|e| fail(e.to_string()))?;
    if !exists {
        return Err(fail("source record not found"));
    }
    if let Some(goal) = goal_id {
        let goal_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM calendar_goals WHERE id=?1)",
                [&goal],
                |r| r.get(0),
            )
            .map_err(|e| fail(e.to_string()))?;
        if !goal_exists {
            return Err(fail("goal not found"));
        }
        conn.execute("INSERT INTO calendar_task_goals(source_type,source_id,goal_id,created_at) VALUES(?1,?2,?3,?4) ON CONFLICT(source_type,source_id) DO UPDATE SET goal_id=excluded.goal_id",params![source_type,source_id,goal,now()]).map_err(|e|fail(e.to_string()))?;
    } else {
        conn.execute(
            "DELETE FROM calendar_task_goals WHERE source_type=?1 AND source_id=?2",
            params![source_type, source_id],
        )
        .map_err(|e| fail(e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_event_categories(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let conn = lock(&state)?;
    let mut s = conn
        .prepare(
            "SELECT id,name,color,icon,sort_order FROM event_categories ORDER BY sort_order,name",
        )
        .map_err(|e| fail(e.to_string()))?;
    let rows=s.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"color":r.get::<_,String>(2)?,"icon":r.get::<_,String>(3)?,"sort_order":r.get::<_,i64>(4)?}))).map_err(|e|fail(e.to_string()))?.collect::<Result<Vec<_>,_>>().map_err(|e|fail(e.to_string()))?;
    drop(s);
    Ok(rows)
}
#[tauri::command]
pub fn create_event_category(
    name: String,
    color: String,
    icon: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err(fail("category name is required"));
    }
    let conn = lock(&state)?;
    let id = Uuid::new_v4().to_string();
    conn.execute("INSERT INTO event_categories(id,name,color,icon,sort_order,created_at) VALUES(?1,?2,?3,?4,(SELECT COALESCE(MAX(sort_order),0)+1 FROM event_categories),?5)",params![id,name.trim(),color,icon,now()]).map_err(|e|fail(e.to_string()))?;
    Ok(id)
}
#[tauri::command(rename_all = "camelCase")]
pub fn update_event_category(
    id: String,
    name: Option<String>,
    color: Option<String>,
    icon: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = lock(&state)?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| fail(e.to_string()))?;
    let old: String = transaction
        .query_row(
            "SELECT name FROM event_categories WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .map_err(|_| fail("category not found"))?;
    if let Some(ref v) = name {
        if v.trim().is_empty() {
            return Err(fail("category name is required"));
        }
    }
    transaction.execute("UPDATE event_categories SET name=COALESCE(?1,name),color=COALESCE(?2,color),icon=COALESCE(?3,icon) WHERE id=?4",params![name.as_ref().map(|v|v.trim()),color,icon,id]).map_err(|e|fail(e.to_string()))?;
    if let Some(name) = name {
        let name = name.trim();
        if name != old {
            transaction
                .execute(
                    "UPDATE items SET category=?1,version=version+1,updated_at=?2 WHERE kind='event' AND category=?3",
                    params![name, now(), old],
                )
                .map_err(|e| fail(e.to_string()))?;
        }
    }
    transaction.commit().map_err(|e| fail(e.to_string()))?;
    Ok(())
}
#[tauri::command(rename_all = "camelCase")]
pub fn delete_event_category(
    id: String,
    reassign_to: Option<String>,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let mut conn = lock(&state)?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| fail(e.to_string()))?;
    let name: String = transaction
        .query_row(
            "SELECT name FROM event_categories WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .map_err(|_| fail("category not found"))?;
    let target = reassign_to.unwrap_or_else(|| "general".into());
    if target == name {
        return Err(fail(
            "replacement category must differ from the deleted category",
        ));
    }
    let target_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM event_categories WHERE name=?1)",
            [&target],
            |row| row.get(0),
        )
        .map_err(|e| fail(e.to_string()))?;
    if !target_exists {
        return Err(fail("replacement category not found"));
    }
    let n = transaction
        .execute(
            "UPDATE items SET category=?1,version=version+1,updated_at=?2 WHERE kind='event' AND category=?3",
            params![target, now(), name],
        )
        .map_err(|e| fail(e.to_string()))? as i64;
    transaction
        .execute("DELETE FROM event_categories WHERE id=?1", [id])
        .map_err(|e| fail(e.to_string()))?;
    transaction.commit().map_err(|e| fail(e.to_string()))?;
    Ok(n)
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_timeline_blocks(date: String, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    validate_date(&date)?;
    let conn = lock(&state)?;
    let mut s=conn.prepare("SELECT id,source_type,source_id,date,start_time,end_time,duration_minutes,CASE WHEN duration_seconds > 0 THEN duration_seconds ELSE duration_minutes * 60 END,is_active,completion_date FROM timeline_blocks WHERE date=?1 ORDER BY id").map_err(|e|fail(e.to_string()))?;
    let rows=s.query_map([date],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"source_type":r.get::<_,String>(1)?,"source_id":r.get::<_,String>(2)?,"date":r.get::<_,String>(3)?,"start_time":r.get::<_,String>(4)?,"end_time":r.get::<_,Option<String>>(5)?,"duration_minutes":r.get::<_,i64>(6)?,"duration_seconds":r.get::<_,i64>(7)?,"is_active":r.get::<_,i64>(8)?!=0,"completion_date":r.get::<_,Option<String>>(9)?}))).map_err(|e|fail(e.to_string()))?.collect::<Result<Vec<_>,_>>().map_err(|e|fail(e.to_string()))?;
    drop(s);
    Ok(rows)
}
#[tauri::command]
pub fn get_latest_task_block(state: State<'_, AppState>) -> Result<Option<Value>, String> {
    let conn = lock(&state)?;
    conn.query_row(
        "SELECT id,source_type,source_id,date,start_time,end_time,duration_minutes,CASE WHEN duration_seconds > 0 THEN duration_seconds ELSE duration_minutes * 60 END,is_active,completion_date,created_at FROM timeline_blocks WHERE source_type IN ('note','event','schedule') ORDER BY created_at DESC,id DESC LIMIT 1",
        [],
        |r| Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "source_type": r.get::<_, String>(1)?,
            "source_id": r.get::<_, String>(2)?,
            "date": r.get::<_, String>(3)?,
            "start_time": r.get::<_, String>(4)?,
            "end_time": r.get::<_, Option<String>>(5)?,
            "duration_minutes": r.get::<_, i64>(6)?,
            "duration_seconds": r.get::<_, i64>(7)?,
            "is_active": r.get::<_, i64>(8)? != 0,
            "completion_date": r.get::<_, Option<String>>(9)?,
            "created_at": r.get::<_, String>(10)?
        })),
    )
    .optional()
    .map_err(|e| fail(e.to_string()))
}
#[tauri::command]
pub fn get_active_block(state: State<'_, AppState>) -> Result<Option<Value>, String> {
    let conn = lock(&state)?;
    conn.query_row("SELECT id,source_type,source_id,date,start_time,completion_date FROM timeline_blocks WHERE is_active=1 ORDER BY id DESC LIMIT 1",[],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"source_type":r.get::<_,String>(1)?,"source_id":r.get::<_,String>(2)?,"date":r.get::<_,String>(3)?,"start_time":r.get::<_,String>(4)?,"completion_date":r.get::<_,Option<String>>(5)?}))).optional().map_err(|e|fail(e.to_string()))
}
#[tauri::command(rename_all = "camelCase")]
pub fn start_task_block(
    source_type: String,
    source_id: String,
    fail_if_active: Option<bool>,
    completion_date: Option<String>,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    crate::health_sleep::editable(&source_id)?;
    let conn = lock(&state)?;
    if source_type == "schedule" {
        let (_, origin, _, _, title) = schedule_context(&conn, &source_id)?;
        if conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM timeline_blocks WHERE is_active=1)",
                [],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|e| fail(e.to_string()))?
        {
            if let Some(id) = conn.query_row("SELECT id FROM timeline_blocks WHERE source_type='schedule' AND source_id=?1 AND is_active=1 ORDER BY id DESC LIMIT 1", [&source_id], |r| r.get(0)).optional().map_err(|e| fail(e.to_string()))? { return Ok(id); }
            return Err(fail("another task is active"));
        }
        let id = crate::mvp_sync_db::timeline_id(&conn)?;
        let timestamp = now();
        let date = Local::now().format("%Y-%m-%d").to_string();
        let t = Local::now().format("%H:%M:%S").to_string();
        conn.execute("INSERT INTO timeline_blocks(id,source_type,source_id,date,start_time,is_active,completion_date,created_at,updated_at) VALUES(?1,'schedule',?2,?3,?4,1,?5,?6,?6)", params![id,source_id,date,t,origin,timestamp]).map_err(|e| fail(e.to_string()))?;
        let _ = title;
        return Ok(id);
    }
    let expected_kind = if source_type == "note" {
        "task"
    } else if source_type == "event" {
        "event"
    } else {
        return Err(fail("invalid source type"));
    };
    let exists: bool = if source_type == "note" {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM items WHERE id=?1 AND kind='task' AND archived=0 AND completed=0 AND status='task')",
            [&source_id],
            |r| r.get(0),
        )
    } else {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM items WHERE id=?1 AND kind=?2 AND archived=0)",
            params![&source_id, expected_kind],
            |r| r.get(0),
        )
    }
    .map_err(|e| fail(e.to_string()))?;
    if !exists {
        return Err(fail("source record not found"));
    }
    if fail_if_active.unwrap_or(false)
        && conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM timeline_blocks WHERE is_active=1)",
                [],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|e| fail(e.to_string()))?
    {
        return Err(fail("another task is active"));
    }
    let completion_date =
        completion_date.unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    validate_date(&completion_date)?;
    let date = Local::now().format("%Y-%m-%d").to_string();
    let t = Local::now().format("%H:%M:%S").to_string();
    let id = crate::mvp_sync_db::timeline_id(&conn)?;
    let timestamp = now();
    conn.execute("INSERT INTO timeline_blocks(id,source_type,source_id,date,start_time,is_active,completion_date,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,1,?6,?7,?7)",params![id,source_type,source_id,date,t,completion_date,timestamp]).map_err(|e|fail(e.to_string()))?;
    Ok(id)
}
fn stop(conn: &Connection, id: i64, complete: bool) -> Result<(), String> {
    let (_start, active, typ, source, created): (String, bool, String, String, String) = conn
        .query_row(
            "SELECT start_time,is_active,source_type,source_id,created_at FROM timeline_blocks WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?,r.get::<_,i64>(1)?!=0,r.get(2)?,r.get(3)?,r.get(4)?)),
        )
        .map_err(|_| fail("block not found"))?;
    if active {
        let end = Local::now().format("%H:%M:%S").to_string();
        let began = chrono::DateTime::parse_from_rfc3339(&created)
            .map_err(|_| fail("invalid block timestamp"))?;
        let duration_seconds = Utc::now()
            .signed_duration_since(began.with_timezone(&Utc))
            .num_seconds()
            .max(0);
        let duration_minutes = duration_seconds / 60;
        let updated = now();
        conn.execute("UPDATE timeline_blocks SET end_time=?1,duration_minutes=?2,duration_seconds=?3,is_active=0,updated_at=?4 WHERE id=?5",params![end,duration_minutes,duration_seconds,updated,id]).map_err(|e|fail(e.to_string()))?;
    }
    if complete {
        if typ == "note" || typ == "event" {
            conn.execute("UPDATE items SET completed=1,status=CASE WHEN kind='task' THEN 'done' ELSE status END,version=version+1,updated_at=?1 WHERE id=?2",params![now(),source]).map_err(|e|fail(e.to_string()))?;
        }
    }
    Ok(())
}
#[tauri::command(rename_all = "camelCase")]
pub fn pause_task_block(block_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let conn = lock(&state)?;
    stop(&conn, block_id, false)
}
#[tauri::command(rename_all = "camelCase")]
pub fn finish_task_block(block_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let mut conn = lock(&state)?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| fail(e.to_string()))?;
    let (active, source_type, source_id): (bool, String, String) = transaction
        .query_row(
            "SELECT is_active,source_type,source_id FROM timeline_blocks WHERE id=?1",
            [block_id],
            |r| Ok((r.get::<_, i64>(0)? != 0, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| fail("block not found"))?;
    if source_type == "schedule" {
        // A paused block may finish only when it is the latest block for the
        // current pending step and no other block of this source is active.
        let _ = schedule_context(&transaction, &source_id)?;
        let other_active: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM timeline_blocks WHERE source_type='schedule' AND source_id=?1 AND is_active=1 AND id<>?2)",
                params![&source_id, block_id],
                |r| r.get(0),
            )
            .map_err(|e| fail(e.to_string()))?;
        let latest_id: Option<i64> = transaction
            .query_row(
                "SELECT id FROM timeline_blocks WHERE source_type='schedule' AND source_id=?1 ORDER BY created_at DESC,id DESC LIMIT 1",
                [&source_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| fail(e.to_string()))?;
        if other_active || latest_id != Some(block_id) {
            return Err(fail("stale schedule block"));
        }
        stop(&transaction, block_id, false)?;
        set_schedule_step(&transaction, &source_id, "done")?;
        return transaction.commit().map_err(|e| fail(e.to_string()));
    }
    if !active {
        stop(&transaction, block_id, true)?;
        return transaction.commit().map_err(|e| fail(e.to_string()));
    }
    stop(&transaction, block_id, true)?;
    transaction.commit().map_err(|e| fail(e.to_string()))
}

#[tauri::command(rename_all = "camelCase")]
pub fn skip_recurring_step(source_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut conn = lock(&state)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| fail(e.to_string()))?;
    let _ = schedule_context(&tx, &source_id)?;
    let active_other: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_blocks WHERE is_active=1 AND (source_type<>'schedule' OR source_id<>?1))",
            [&source_id],
            |r| r.get(0),
        )
        .map_err(|e| fail(e.to_string()))?;
    if active_other {
        return Err(fail("another task is active"));
    }
    let block: Option<i64> = tx
        .query_row("SELECT id FROM timeline_blocks WHERE source_type='schedule' AND source_id=?1 AND is_active=1 ORDER BY id DESC LIMIT 1", [&source_id], |r| r.get(0))
        .optional()
        .map_err(|e| fail(e.to_string()))?;
    if let Some(block_id) = block {
        stop(&tx, block_id, false)?;
    }
    set_schedule_step(&tx, &source_id, "skipped")?;
    tx.commit().map_err(|e| fail(e.to_string()))
}
fn calendar_task_seconds(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
) -> Result<i64, String> {
    conn.query_row("SELECT COALESCE(SUM(CASE WHEN duration_seconds > 0 THEN duration_seconds ELSE duration_minutes * 60 END),0) FROM timeline_blocks WHERE source_type=?1 AND source_id=?2 AND is_active=0",params![source_type,source_id],|r|r.get(0)).map_err(|e|fail(e.to_string()))
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_calendar_task_minutes(
    source_type: String,
    source_id: String,
    completion_date: Option<String>,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let conn = lock(&state)?;
    let _ = completion_date;
    Ok(calendar_task_seconds(&conn, &source_type, &source_id)? / 60)
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_calendar_task_seconds(
    source_type: String,
    source_id: String,
    completion_date: Option<String>,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let conn = lock(&state)?;
    let _ = completion_date;
    calendar_task_seconds(&conn, &source_type, &source_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_schedules(
    _category: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let conn = lock(&state)?;
    schedule_projections(&conn, None, None)
}

#[tauri::command]
pub fn get_task_pins(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    drop(lock(&state)?);
    Ok(Vec::new())
}

#[tauri::command]
pub fn get_app_setting(key: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = lock(&state)?;
    conn.query_row("SELECT value FROM app_settings WHERE key=?1", [key], |r| {
        r.get(0)
    })
    .optional()
    .map_err(|e| fail(e.to_string()))
}

#[tauri::command]
pub fn set_app_setting(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute("INSERT INTO app_settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params![key,value,now()])
        .map_err(|e| fail(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn health_events_are_readonly_in_calendar_lists_and_native_actions() {
        use tauri::Manager;
        let conn = Connection::open_in_memory().unwrap();
        crate::init_schema(&conn).unwrap();
        conn.execute("INSERT INTO items(id,kind,title,date,time,duration_minutes,version,created_at,updated_at,tags)
            VALUES('hc-sleep:fixture','event','Fictional sleep','2026-01-01','23:00',480,1,'x','x',?1)",
            [json!(["health:sleep:v1","health:asleep:420","health:origin:com.example.sleep"]).to_string()]).unwrap();
        let rows = calendar_list(&conn,"kind='event'","s.id",&[],false).unwrap();
        assert_eq!(rows[0]["readonly"],true);
        assert_eq!(rows[0]["sleep_minutes"],420);
        assert_eq!(rows[0]["health_kind"],"sleep");
        assert_eq!(load(&conn,"hc-sleep:fixture").unwrap()["source"],"health_connect");
        let app = tauri::test::mock_builder().manage(AppState(std::sync::Mutex::new(conn)))
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        assert_eq!(delete_event("hc-sleep:fixture".into(),app.state()).unwrap_err(),"health_sleep_readonly");
        assert_eq!(start_task_block("event".into(),"hc-sleep:fixture".into(),None,None,app.state()).unwrap_err(),"health_sleep_readonly");
        assert_eq!(set_calendar_task_goal("event".into(),"hc-sleep:fixture".into(),None,app.state()).unwrap_err(),"health_sleep_readonly");
    }
    #[test]
    fn timer_closes_and_marks_only_a_task_complete() {
        let conn = Connection::open_in_memory().unwrap();
        crate::init_schema(&conn).unwrap();
        conn.execute("INSERT INTO items(id,kind,title,notes,duration_minutes,completed,version,created_at,updated_at) VALUES('task','task','T','',30,0,1,'a','a')",[]).unwrap();
        conn.execute("INSERT INTO timeline_blocks(source_type,source_id,date,start_time,is_active,completion_date,created_at,updated_at) VALUES('note','task','2026-09-11','00:00:00',1,'2026-09-11','2026-09-11T00:00:00Z','2026-09-11T00:00:00Z')",[]).unwrap();
        stop(&conn, 1, true).unwrap();
        assert_eq!(
            conn.query_row("SELECT completed FROM items WHERE id='task'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT is_active FROM timeline_blocks WHERE id=1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
    #[test]
    fn goal_link_schema_keeps_task_when_goal_is_removed() {
        let conn = Connection::open_in_memory().unwrap();
        crate::init_schema(&conn).unwrap();
        conn.execute("INSERT INTO items(id,kind,title,notes,duration_minutes,completed,version,created_at,updated_at) VALUES('task','task','T','',30,0,1,'a','a')",[]).unwrap();
        conn.execute(
            "INSERT INTO calendar_goals(id,title,created_at,updated_at) VALUES('goal','G','a','a')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO calendar_task_goals(source_type,source_id,goal_id,created_at) VALUES('note','task','goal','a')",[]).unwrap();
        conn.execute_batch("DELETE FROM calendar_task_goals WHERE goal_id='goal'; DELETE FROM calendar_goals WHERE id='goal';").unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM items WHERE id='task'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    fn recurring_fixture(conn: &Connection) {
        crate::init_schema(conn).unwrap();
        conn.execute("INSERT OR REPLACE INTO app_settings(key,value,updated_at) VALUES('device_id','test-device','now')", []).unwrap();
        let state: Value = serde_json::from_str(include_str!("../../tests/fixtures/recurring-chain.json")).unwrap();
        conn.execute(
            "INSERT INTO ui_state(key,value,updated_at) VALUES('calendar_recurring_v1',?1,'now')",
            [state.to_string()],
        )
        .unwrap();
    }
    #[test]
    fn schedule_step_is_filtered_by_run_and_updates_one_step_atomically() {
        let conn = Connection::open_in_memory().unwrap();
        recurring_fixture(&conn);
        let source = json!(["p", "2026-09-20", 0]).to_string();
        let (_, origin, index, _, title) = schedule_context(&conn, &source).unwrap();
        assert_eq!(
            (origin, index, title),
            ("2026-09-20".to_string(), 0, "Chain · First".to_string())
        );
        let tx = conn.unchecked_transaction().unwrap();
        set_schedule_step(&tx, &source, "done").unwrap();
        tx.commit().unwrap();
        let raw = crate::mvp_sync_db::read_ui(&conn, RECURRING_KEY)
            .unwrap()
            .unwrap();
        let state: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(state["days"]["2026-09-20"]["p"]["status"], "pending");
        assert_eq!(
            state["days"]["2026-09-20"]["p"]["run"]["steps"][0]["status"],
            "done"
        );
        assert_eq!(
            state["days"]["2026-09-20"]["p"]["run"]["steps"][1]["status"],
            "pending"
        );
        let tx = conn.unchecked_transaction().unwrap();
        assert!(set_schedule_step(&tx, &source, "skipped").is_err());
    }
    #[test]
    fn schedule_projection_keeps_origin_and_last_block_identity() {
        let conn = Connection::open_in_memory().unwrap();
        recurring_fixture(&conn);
        let source = json!(["p", "2026-09-20", 0]).to_string();
        conn.execute("INSERT INTO timeline_blocks(id,source_type,source_id,date,start_time,duration_minutes,duration_seconds,is_active,completion_date,created_at,updated_at) VALUES(41,'schedule',?1,'2026-09-21','10:00',12,720,0,'2026-09-20','2026-09-21T10:00:00Z','2026-09-21T10:12:00Z')", [&source]).unwrap();
        let rows = schedule_projections(&conn, Some("2026-09-20"), Some("2026-09-20")).unwrap();
        let row = rows.iter().find(|row| row["source_id"] == source).unwrap();
        assert_eq!(row["title"], "Chain · First");
        assert_eq!(row["date"], "2026-09-20");
        assert_eq!(row["block_id"], 41);
        assert_eq!(row["block_date"], "2026-09-21");
        assert_eq!(row["actual_minutes"], 12);
    }
    #[test]
    fn legacy_check_schedule_cannot_start_or_mutate_history() {
        let conn = Connection::open_in_memory().unwrap();
        recurring_fixture(&conn);
        let source = json!(["p", "2026-09-20", 0]).to_string();
        let mut state: Value = serde_json::from_str(&recurring_raw(&conn).unwrap()).unwrap();
        state["days"]["2026-09-20"]["p"]["snapshot"]
            .as_object_mut()
            .unwrap()
            .insert("kind".into(), json!("rule"));
        conn.execute(
            "UPDATE ui_state SET value=?1 WHERE key='calendar_recurring_v1'",
            [state.to_string()],
        )
        .unwrap();
        assert!(schedule_context(&conn, &source).is_err());
    }
}
