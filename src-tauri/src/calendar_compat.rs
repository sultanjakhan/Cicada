//! Calendar Workspace persistence only.  It deliberately owns no sync, import,
//! health, routine, updater, or legacy database path.
use crate::{fail, get_item, validate_date, AppState, Item, ItemInput};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::State;
use uuid::Uuid;

fn now() -> String {
    Utc::now().to_rfc3339()
}
fn lock(state: &State<'_, AppState>) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
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
    json!({"id":item.id,"title":item.title,"content":item.notes,"description":item.notes,"date":item.date,"time":item.time,"duration_minutes":item.duration_minutes,"category":category,"color":color,"priority":priority,"completed":item.completed,"version":item.version,"created_at":item.created_at,"updated_at":item.updated_at,"source":"manual","linked_tab":"","tags":tags,"archived":archived,"tab_name":if item.kind=="task" {"calendar"} else {""},"status":if item.completed && status=="task" {"done"} else {&status},"due_date":if item.kind=="task" {item.date.clone()} else {None},"content_blocks":blocks})
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

#[tauri::command(rename_all = "camelCase")]
pub fn get_events(month: u32, year: i32, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    if !(1..=12).contains(&month) {
        return Err(fail("month must be 1..12"));
    }
    let conn = lock(&state)?;
    let prefix = format!("{year}-{month:02}%");
    let mut s=conn.prepare("SELECT id FROM items WHERE kind='event' AND archived=0 AND date LIKE ?1 ORDER BY date,time,id").map_err(|e|fail(e.to_string()))?;
    s.query_map([prefix], |r| r.get::<_, String>(0))
        .map_err(|e| fail(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| fail(e.to_string()))?
        .into_iter()
        .map(|id| load(&conn, &id))
        .collect()
}
#[tauri::command]
pub fn get_all_events(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let conn = lock(&state)?;
    let mut s=conn.prepare("SELECT id FROM items WHERE kind='event' AND archived=0 ORDER BY date DESC,time DESC,id").map_err(|e|fail(e.to_string()))?;
    s.query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| fail(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| fail(e.to_string()))?
        .into_iter()
        .map(|id| load(&conn, &id))
        .collect()
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
    validate_date(&date)?;
    let mut conn = lock(&state)?;
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
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = lock(&state)?;
    let current = get_item(&conn, item_id(&id)?)?;
    if current.kind != "event" {
        return Err(fail("event not found"));
    }
    let new_date = date.unwrap_or_else(|| current.date.unwrap_or_default());
    validate_date(&new_date)?;
    let affected=conn.execute("UPDATE items SET title=COALESCE(?1,title),notes=COALESCE(?2,notes),date=?3,time=COALESCE(?4,time),duration_minutes=COALESCE(?5,duration_minutes),completed=COALESCE(?6,completed),category=COALESCE(?7,category),color=COALESCE(?8,color),priority=COALESCE(?9,priority),version=version+1,updated_at=?10 WHERE id=?11 AND kind='event'",params![title.map(|v|v.trim().to_string()),description,new_date,time,duration_minutes,completed.map(|v|v as i64),category,color,priority,now(),id]).map_err(|e|fail(e.to_string()))?;
    if affected != 1 {
        Err(fail("event not found"))
    } else {
        Ok(())
    }
}
#[tauri::command]
pub fn delete_event(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = lock(&state)?;
    if conn
        .execute("DELETE FROM items WHERE id=?1 AND kind='event'", [id])
        .map_err(|e| fail(e.to_string()))?
        == 1
    {
        Ok(())
    } else {
        Err(fail("event not found"))
    }
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
    let ids = if let Some(q) = search {
        s.query_map([format!("%{q}%")], |r| r.get::<_, String>(0))
    } else {
        s.query_map([], |r| r.get::<_, String>(0))
    }
    .map_err(|e| fail(e.to_string()))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| fail(e.to_string()))?;
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
    date(&due_date)?;
    let mut conn = lock(&state)?;
    let id = Uuid::new_v4().to_string();
    let n = now();
    let record_status = status.unwrap_or_else(|| "note".into());
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
    state: State<'_, AppState>,
) -> Result<(), String> {
    date(&due_date)?;
    let conn = lock(&state)?;
    let n = now();
    let changed=conn.execute("UPDATE items SET title=?1,notes=?2,tags=?3,archived=COALESCE(?4,archived),date=COALESCE(?5,date),content_blocks=COALESCE(?6,content_blocks),priority=COALESCE(?7,priority),version=version+1,updated_at=?8 WHERE id=?9 AND kind='task'",params![title.trim(),content,tags,archived.map(|v|v as i64),due_date,content_blocks,priority,n,id]).map_err(|e|fail(e.to_string()))?;
    if changed == 1 {
        Ok(())
    } else {
        Err(fail("note not found"))
    }
}
#[tauri::command]
pub fn update_note_status(
    id: String,
    status: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
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
    .map_err(|e| fail("note not found"))
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_calendar_tasks(
    include_completed: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let conn = lock(&state)?;
    let mut s=conn.prepare(if include_completed.unwrap_or(false){"SELECT id FROM items WHERE kind='task' AND archived=0 AND status IN ('task','done') ORDER BY date IS NULL,date,id"}else{"SELECT id FROM items WHERE kind='task' AND archived=0 AND status='task' AND completed=0 ORDER BY date IS NULL,date,id"}).map_err(|e|fail(e.to_string()))?;
    s.query_map([],|r|r.get::<_,String>(0)).map_err(|e|fail(e.to_string()))?.collect::<Result<Vec<_>,_>>().map_err(|e|fail(e.to_string()))?.into_iter().map(|id|{let v=load(&conn,&id)?;Ok(json!({"source_type":"note","source_id":id,"title":v["title"],"date":v["due_date"],"planned_time":null,"duration_minutes":v["duration_minutes"],"completed":v["completed"],"status_extra":v["status"],"priority":v["priority"],"tracking_mode":"track"}))}).collect()
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
    state: State<'_, AppState>,
) -> Result<String, String> {
    let item_id = match id {
        Some(id) => {
            let conn = lock(&state)?;
            let changed=conn.execute("UPDATE items SET title=?1,date=?2,duration_minutes=COALESCE(?3,duration_minutes),status='task',completed=0,updated_at=?4,version=version+1 WHERE id=?5 AND kind='task'",params![title.trim(),due_date,estimate_minutes,now(),id]).map_err(|e|fail(e.to_string()))?;
            if changed != 1 {
                return Err(fail("task not found"));
            }
            id
        }
        None => {
            let mut conn = lock(&state)?;
            let id = Uuid::new_v4().to_string();
            let n = now();
            conn.execute("INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,priority,archived,tags,status) VALUES(?1,'task',?2,'',?3,NULL,COALESCE(?4,30),0,1,?5,?5,'task','#9B9B9B',0,0,'','task')",params![id,title.trim(),due_date,estimate_minutes,n]).map_err(|e|fail(e.to_string()))?;
            id
        }
    };
    set_calendar_task_goal("note".into(), item_id.clone(), goal_id, state)?;
    Ok(item_id)
}
#[tauri::command]
pub fn complete_calendar_task(id: String, state: State<'_, AppState>) -> Result<(), String> {
    update_note_status(id, "done".into(), state)
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
    let mut s=conn.prepare("SELECT id,kind FROM items WHERE archived=0 AND status!='note' AND ((date BETWEEN ?1 AND ?2) OR (kind='task' AND date IS NULL)) ORDER BY date,time,id").map_err(|e|fail(e.to_string()))?;
    let rows = s
        .query_map(params![start, end], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| fail(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| fail(e.to_string()))?;
    rows.into_iter().map(|(id,kind)|{let v=load(&conn,&id)?;Ok(json!({"source_type":if kind=="event" {"event"}else{"note"},"source_id":id,"title":v["title"],"date":v["date"],"planned_time":v["time"],"duration_minutes":v["duration_minutes"],"category":v["category"],"color":v["color"],"completed":v["completed"],"status_extra":v["status"],"priority":v["priority"],"tracking_mode":"track"}))}).collect()
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
    s.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"target_value":r.get::<_,f64>(2)?,"current_value":r.get::<_,Option<f64>>(3)?,"unit":r.get::<_,String>(4)?,"deadline":r.get::<_,Option<String>>(5)?,"goal_kind":r.get::<_,String>(6)?,"description":r.get::<_,String>(7)?,"criteria":r.get::<_,String>(8)?,"parent_goal_id":r.get::<_,Option<String>>(9)?,"status":"active"}))).map_err(|e|fail(e.to_string()))?.collect::<Result<_,_>>().map_err(|e|fail(e.to_string()))
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
        || target_value <= 0
    {
        return Err(fail("invalid goal"));
    }
    let conn = lock(&state)?;
    let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let n = now();
    conn.execute("INSERT INTO calendar_goals(id,title,target_value,current_value,unit,deadline,goal_kind,description,criteria,parent_goal_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11) ON CONFLICT(id) DO UPDATE SET title=excluded.title,target_value=excluded.target_value,current_value=excluded.current_value,unit=excluded.unit,deadline=excluded.deadline,goal_kind=excluded.goal_kind,description=excluded.description,criteria=excluded.criteria,parent_goal_id=excluded.parent_goal_id,updated_at=excluded.updated_at",params![id,title.trim(),target_value,current_value,unit,deadline,goal_kind.unwrap_or_else(||"goal".into()),description,criteria,if clear_parent{None}else{parent_goal_id},n]).map_err(|e|fail(e.to_string()))?;
    Ok(id)
}
#[tauri::command]
pub fn delete_goal(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute("DELETE FROM calendar_task_goals WHERE goal_id=?1", [&id])
        .map_err(|e| fail(e.to_string()))?;
    conn.execute("DELETE FROM calendar_goals WHERE id=?1", [id])
        .map_err(|e| fail(e.to_string()))?;
    Ok(())
}
#[tauri::command]
pub fn get_calendar_task_goals(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let conn = lock(&state)?;
    let mut s = conn
        .prepare("SELECT source_type,source_id,goal_id FROM calendar_task_goals")
        .map_err(|e| fail(e.to_string()))?;
    s.query_map([],|r|Ok(json!({"source_type":r.get::<_,String>(0)?,"source_id":r.get::<_,String>(1)?,"goal_id":r.get::<_,String>(2)?}))).map_err(|e|fail(e.to_string()))?.collect::<Result<_,_>>().map_err(|e|fail(e.to_string()))
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
    if let Some(goal) = goal_id {
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
    s.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"color":r.get::<_,String>(2)?,"icon":r.get::<_,String>(3)?,"sort_order":r.get::<_,i64>(4)?}))).map_err(|e|fail(e.to_string()))?.collect::<Result<_,_>>().map_err(|e|fail(e.to_string()))
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
    let conn = lock(&state)?;
    let old: String = conn
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
    conn.execute("UPDATE event_categories SET name=COALESCE(?1,name),color=COALESCE(?2,color),icon=COALESCE(?3,icon) WHERE id=?4",params![name.as_ref().map(|v|v.trim()),color,icon,id]).map_err(|e|fail(e.to_string()))?;
    if let Some(name) = name {
        conn.execute(
            "UPDATE items SET category=?1 WHERE category=?2",
            params![name.trim(), old],
        )
        .map_err(|e| fail(e.to_string()))?;
    }
    Ok(())
}
#[tauri::command(rename_all = "camelCase")]
pub fn delete_event_category(
    id: String,
    reassign_to: Option<String>,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let conn = lock(&state)?;
    let name: String = conn
        .query_row(
            "SELECT name FROM event_categories WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .map_err(|_| fail("category not found"))?;
    let target = reassign_to.unwrap_or_else(|| "general".into());
    let n = conn
        .execute(
            "UPDATE items SET category=?1 WHERE kind='event' AND category=?2",
            params![target, name],
        )
        .map_err(|e| fail(e.to_string()))? as i64;
    conn.execute("DELETE FROM event_categories WHERE id=?1", [id])
        .map_err(|e| fail(e.to_string()))?;
    Ok(n)
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_timeline_blocks(date: String, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    validate_date(&date)?;
    let conn = lock(&state)?;
    let mut s=conn.prepare("SELECT id,source_type,source_id,date,start_time,end_time,duration_minutes,is_active,completion_date FROM timeline_blocks WHERE date=?1 ORDER BY id").map_err(|e|fail(e.to_string()))?;
    s.query_map([date],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"source_type":r.get::<_,String>(1)?,"source_id":r.get::<_,String>(2)?,"date":r.get::<_,String>(3)?,"start_time":r.get::<_,String>(4)?,"end_time":r.get::<_,Option<String>>(5)?,"duration_minutes":r.get::<_,i64>(6)?,"is_active":r.get::<_,i64>(7)?!=0,"completion_date":r.get::<_,Option<String>>(8)?}))).map_err(|e|fail(e.to_string()))?.collect::<Result<_,_>>().map_err(|e|fail(e.to_string()))
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
    let date = completion_date.unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());
    validate_date(&date)?;
    let t = Utc::now().format("%H:%M").to_string();
    conn.execute("INSERT INTO timeline_blocks(source_type,source_id,date,start_time,is_active,completion_date,created_at,updated_at) VALUES(?1,?2,?3,?4,1,?5,?6,?6)",params![source_type,source_id,date,t,date,now()]).map_err(|e|fail(e.to_string()))?;
    Ok(conn.last_insert_rowid())
}
fn stop(conn: &Connection, id: i64, complete: bool) -> Result<(), String> {
    let start: String = conn
        .query_row(
            "SELECT start_time FROM timeline_blocks WHERE id=?1 AND is_active=1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| fail("active block not found"))?;
    let end = Utc::now().format("%H:%M").to_string();
    let m = |v: &str| {
        v.get(0..2).and_then(|h| h.parse::<i64>().ok()).unwrap_or(0) * 60
            + v.get(3..5).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0)
    };
    let duration = (m(&end) - m(&start)).max(0);
    conn.execute("UPDATE timeline_blocks SET end_time=?1,duration_minutes=?2,is_active=0,updated_at=?3 WHERE id=?4",params![end,duration,now(),id]).map_err(|e|fail(e.to_string()))?;
    if complete {
        let (typ, source): (String, String) = conn
            .query_row(
                "SELECT source_type,source_id FROM timeline_blocks WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| fail(e.to_string()))?;
        if typ == "note" {
            conn.execute(
                "UPDATE items SET completed=1,version=version+1,updated_at=?1 WHERE id=?2",
                params![now(), source],
            )
            .map_err(|e| fail(e.to_string()))?;
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
    let conn = lock(&state)?;
    stop(&conn, block_id, true)
}
#[tauri::command(rename_all = "camelCase")]
pub fn get_calendar_task_minutes(
    source_type: String,
    source_id: String,
    completion_date: Option<String>,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let conn = lock(&state)?;
    conn.query_row("SELECT COALESCE(SUM(duration_minutes),0) FROM timeline_blocks WHERE source_type=?1 AND source_id=?2 AND is_active=0 AND (?3 IS NULL OR completion_date=?3)",params![source_type,source_id,completion_date],|r|r.get(0)).map_err(|e|fail(e.to_string()))
}

// The current Workspace always loads these auxiliary lists. Routine is out of
// scope, so an empty local projection is intentional and keeps its UI path
// functional without importing legacy schedules or task pins.
#[tauri::command]
pub fn get_schedules(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let _ = lock(&state)?;
    Ok(Vec::new())
}

#[tauri::command]
pub fn get_task_pins(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let _ = lock(&state)?;
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
        conn.execute("INSERT INTO timeline_blocks(source_type,source_id,date,start_time,is_active,completion_date,created_at,updated_at) VALUES('note','task','2026-09-11','00:00',1,'2026-09-11','a','a')",[]).unwrap();
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
        conn.execute("DELETE FROM calendar_task_goals WHERE goal_id='goal'; DELETE FROM calendar_goals WHERE id='goal';",[]).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM items WHERE id='task'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
