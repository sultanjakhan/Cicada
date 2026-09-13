//! Calendar Workspace persistence only.  It deliberately owns no sync, import,
//! health, routine, updater, or legacy database path.
use crate::{fail, get_item, validate_date, validate_time, AppState, Item};
use chrono::{Local, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use tauri::State;
use uuid::Uuid;

fn now() -> String {
    Utc::now().to_rfc3339()
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
    json!({"id":item.id,"title":item.title,"content":item.notes,"description":item.notes,"date":item.date,"time":item.time,"duration_minutes":duration_minutes,"category":category,"color":color,"priority":priority,"completed":item.completed,"version":item.version,"created_at":item.created_at,"updated_at":item.updated_at,"source":"manual","linked_tab":"","tags":tags,"archived":archived,"tab_name":if item.kind=="task" {"calendar"} else {""},"status":if item.completed && status=="task" {"done"} else {&status},"due_date":if item.kind=="task" {item.date.clone()} else {None},"content_blocks":blocks})
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
            SELECT id,kind,title,date,time,duration_minutes,category,color,completed,status,priority,
                CASE WHEN kind='event' THEN 'event' ELSE 'note' END AS source_type
            FROM items WHERE {predicate}
        ), timeline AS (
            SELECT t.source_type,t.source_id,MAX(t.is_active) AS active,
                SUM(CASE WHEN t.is_active=0 THEN t.duration_minutes ELSE 0 END) AS minutes,
                COUNT(*) AS has_work
            FROM timeline_blocks t JOIN selected s
                ON s.source_type=t.source_type AND s.id=t.source_id
            GROUP BY t.source_type,t.source_id
        )
        SELECT s.id,s.kind,s.title,s.date,s.time,s.duration_minutes,s.category,s.color,
            s.completed,s.status,s.priority,COALESCE(t.active,0),COALESCE(t.minutes,0),COALESCE(t.has_work,0)
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
                "actual_minutes": row.get::<_, i64>(12)?,
                "has_work": row.get::<_, i64>(13)? > 0,
            });
            if !tasks_only {
                value["category"] = json!(row.get::<_, String>(6)?);
                value["color"] = json!(row.get::<_, String>(7)?);
            }
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
    state: State<'_, AppState>,
) -> Result<String, String> {
    validate_title(&title)?;
    date(&due_date)?;
    if let Some(value) = estimate_minutes {
        duration(value)?;
    }
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
            let changed=transaction.execute("UPDATE items SET title=?1,date=?2,duration_minutes=COALESCE(?3,0),updated_at=?4,version=version+1 WHERE id=?5 AND kind='task' AND status IN ('task','done') AND (?6 IS NULL OR version=?6)",params![title.trim(),due_date,estimate_minutes,now(),id,expected_version]).map_err(|e|fail(e.to_string()))?;
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
            transaction.execute("INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,priority,archived,tags,status) VALUES(?1,'task',?2,'',?3,NULL,COALESCE(?4,0),0,1,?5,?5,'task','#9B9B9B',0,0,'','task')",params![id,title.trim(),due_date,estimate_minutes,n]).map_err(|e|fail(e.to_string()))?;
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
    calendar_list(
        &conn,
        "archived=0 AND status!='note' AND ((kind='event' AND date<=?2 AND ((date>=?1 AND NULLIF(time,'') IS NULL) OR (NULLIF(time,'') IS NOT NULL AND datetime(date || ' ' || substr(time,1,5), '+' || duration_minutes || ' minutes')>datetime(?1)))) OR (kind='task' AND (date BETWEEN ?1 AND ?2 OR date IS NULL)))",
        "s.date,s.time,s.id",
        params![start, end],
        false,
    )
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
pub fn set_ui_state(key: String, value: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute("INSERT INTO ui_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",params![key,value,now()]).map_err(|e|fail(e.to_string()))?;
    Ok(())
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
    if let Some(parent) = parent_goal_id.as_deref() {
        if clear_parent || parent == id {
            return Err(fail("goal cannot be its own parent"));
        }
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM calendar_goals WHERE id=?1)",
                [parent],
                |r| r.get(0),
            )
            .map_err(|e| fail(e.to_string()))?;
        if !exists {
            return Err(fail("parent goal not found"));
        }
        let cycle: bool=transaction.query_row("WITH RECURSIVE descendants(id) AS (SELECT id FROM calendar_goals WHERE parent_goal_id=?1 UNION ALL SELECT g.id FROM calendar_goals g JOIN descendants d ON g.parent_goal_id=d.id) SELECT EXISTS(SELECT 1 FROM descendants WHERE id=?2)",params![id,parent],|r|r.get(0)).map_err(|e|fail(e.to_string()))?;
        if cycle {
            return Err(fail("goal parent would create a cycle"));
        }
    }
    let n = now();
    if existing {
        let changed = transaction.execute("UPDATE calendar_goals SET title=?1,target_value=?2,current_value=?3,unit=?4,deadline=?5,goal_kind=?6,description=?7,criteria=?8,parent_goal_id=?9,updated_at=?10 WHERE id=?11",params![title.trim(),target_value,current_value,unit,deadline,goal_kind,description,criteria,if clear_parent{None}else{parent_goal_id},n,&id]).map_err(|e|fail(e.to_string()))?;
        if changed != 1 {
            return Err(fail("goal not found"));
        }
        if previous_kind.as_deref() != Some("daily_norm") && goal_kind == "daily_norm" {
            transaction.execute("UPDATE calendar_goals SET parent_goal_id=NULL,updated_at=?1 WHERE parent_goal_id=?2",params![now(),&id]).map_err(|e|fail(e.to_string()))?;
        }
    } else {
        transaction.execute("INSERT INTO calendar_goals(id,title,target_value,current_value,unit,deadline,goal_kind,description,criteria,parent_goal_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",params![&id,title.trim(),target_value,current_value,unit,deadline,goal_kind,description,criteria,if clear_parent{None}else{parent_goal_id},n]).map_err(|e|fail(e.to_string()))?;
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
    let conn = lock(&state)?;
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
    conn.execute("INSERT INTO timeline_blocks(source_type,source_id,date,start_time,is_active,completion_date,created_at,updated_at) VALUES(?1,?2,?3,?4,1,?5,?6,?6)",params![source_type,source_id,date,t,completion_date,now()]).map_err(|e|fail(e.to_string()))?;
    Ok(conn.last_insert_rowid())
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
        conn.execute("UPDATE timeline_blocks SET end_time=?1,duration_minutes=?2,duration_seconds=?3,is_active=0,updated_at=?4 WHERE id=?5",params![end,duration_minutes,duration_seconds,now(),id]).map_err(|e|fail(e.to_string()))?;
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
    stop(&transaction, block_id, true)?;
    transaction.commit().map_err(|e| fail(e.to_string()))
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

// The current Workspace always loads these auxiliary lists. Routine is out of
// scope, so an empty local projection is intentional and keeps its UI path
// functional without importing legacy schedules or task pins.
#[tauri::command]
pub fn get_schedules(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    drop(lock(&state)?);
    Ok(Vec::new())
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
}
