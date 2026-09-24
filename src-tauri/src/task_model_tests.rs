//! Task time of day, kind and sphere (#96) and work stages (2026-09-24):
//! persistence, legacy records and mixed-version synchronization with 0.3.29
//! replicas. Also «Отменить запуск» of a running block.
use super::*;

// Exact statements that 0.3.29 executes for tasks (calendar_compat.rs at e4a71bd).
const V0329_TASK_INSERT: &str = "INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,priority,archived,tags,status) VALUES(?1,'task',?2,'',?3,NULL,COALESCE(?4,0),0,1,?5,?5,'task','#9B9B9B',COALESCE(?6,0),0,'','task')";
const V0329_TASK_UPDATE: &str = "UPDATE items SET title=?1,date=?2,duration_minutes=COALESCE(?3,0),updated_at=?4,version=version+1,priority=COALESCE(?7,priority) WHERE id=?5 AND kind='task' AND status IN ('task','done') AND (?6 IS NULL OR version=?6)";
const V0329_TASK_COMPLETE: &str = "UPDATE items SET completed=1,status='done',version=version+1,updated_at=?1 WHERE id=?2 AND kind='task' AND archived=0 AND status IN ('task','done') AND NOT EXISTS(SELECT 1 FROM timeline_blocks WHERE source_type='note' AND source_id=?2 AND is_active=1)";

fn replica() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::init_schema(&conn).unwrap();
    conn
}
fn fields(time: Option<&str>, kind: Option<&str>, sphere: Option<&str>) -> TaskFields {
    TaskFields { time: time.map(Into::into), task_kind: kind.map(Into::into), sphere: sphere.map(Into::into), ..TaskFields::default() }
}
fn create(conn: &mut Connection, title: &str, date: Option<&str>, extra: TaskFields) -> String {
    save_task(conn, None, title.into(), date.map(Into::into), None, None, None, Some(false), extra).unwrap()
}
fn edit(conn: &mut Connection, id: &str, date: Option<&str>, extra: TaskFields) -> Result<String, String> {
    let version = load(conn, id).unwrap()["version"].as_i64();
    save_task(conn, Some(id.into()), "Edited".into(), date.map(Into::into), Some(20), None, version, None, extra)
}
fn listed(conn: &Connection, id: &str, tasks_only: bool) -> Value {
    let rows = if tasks_only {
        calendar_list(conn, "kind='task' AND archived=0 AND status IN ('task','done')", "s.date IS NULL,s.date,NULLIF(s.time,'') IS NULL,s.time,s.id", &[], true)
    } else {
        calendar_list(conn, "kind='task'", "s.date,s.time,s.id", &[], false)
    }
    .unwrap();
    rows.into_iter().find(|row| row["source_id"] == id).unwrap()
}
fn stored(conn: &Connection, id: &str) -> (Option<String>, String) {
    conn.query_row("SELECT time,tags FROM items WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
}
/// The current relay record of one item, as the sender uploads it.
fn wire(source: &Connection, item: &str) -> serde_json::Map<String, Value> {
    wire_row(source, &json!(["items", [item]]).to_string())
}
/// The current relay record of any row key.
fn wire_row(source: &Connection, key: &str) -> serde_json::Map<String, Value> {
    let mut wire = crate::mvp_sync_db::row_to_json(source, "mvp_records", &rusqlite::types::Value::Text(key.to_owned()))
        .unwrap().unwrap().as_object().unwrap().clone();
    let (stamp, writer): (String, String) = source
        .query_row("SELECT updated_at,device_id FROM sync_row_versions WHERE table_name='mvp_records' AND row_id=?1", [key], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    wire.insert("_updated_at".into(), json!(stamp));
    wire.insert("_device_id".into(), json!(writer));
    wire
}
/// Applies a relay record exactly as the receiver does.
fn deliver(target: &Connection, wire: &serde_json::Map<String, Value>) -> Result<bool, String> {
    target.execute("UPDATE content_sync_control SET applying=1", []).unwrap();
    let applied = crate::mvp_sync_db::apply_record(target, wire);
    target.execute("UPDATE content_sync_control SET applying=0", []).unwrap();
    applied
}
fn transfer(source: &Connection, target: &Connection, item: &str) -> Result<bool, String> {
    deliver(target, &wire(source, item))
}
fn title(conn: &Connection, id: &str) -> String {
    conn.query_row("SELECT title FROM items WHERE id=?1", [id], |r| r.get(0)).unwrap()
}

#[test]
fn time_kind_and_sphere_round_trip_through_every_task_query() {
    let mut conn = replica();
    let id = create(&mut conn, "Call the fictional supplier", Some("2026-09-24"), fields(Some("14:30"), Some("instant"), Some("home")));
    assert_eq!(stored(&conn, &id), (Some("14:30".into()), "task-kind:instant,task-sphere:home".into()));
    let detail = load(&conn, &id).unwrap();
    assert_eq!((detail["time"].clone(), detail["task_kind"].clone(), detail["sphere"].clone()), (json!("14:30"), json!("instant"), json!("home")));
    for tasks_only in [true, false] {
        let row = listed(&conn, &id, tasks_only);
        assert_eq!((row["planned_time"].clone(), row["task_kind"].clone(), row["sphere"].clone()), (json!("14:30"), json!("instant"), json!("home")), "tasks_only={tasks_only}");
    }
    // A date-only edit (older caller) omits the new fields and keeps them.
    edit(&mut conn, &id, Some("2026-09-25"), TaskFields::default()).unwrap();
    assert_eq!(stored(&conn, &id), (Some("14:30".into()), "task-kind:instant,task-sphere:home".into()));
    // Explicit values replace or clear each field independently.
    edit(&mut conn, &id, Some("2026-09-25"), fields(Some("09:05"), Some("normal"), None)).unwrap();
    assert_eq!(stored(&conn, &id), (Some("09:05".into()), "task-sphere:home".into()));
    edit(&mut conn, &id, Some("2026-09-25"), fields(Some(""), None, Some(""))).unwrap();
    let detail = load(&conn, &id).unwrap();
    assert_eq!((detail["time"].clone(), detail["task_kind"].clone(), detail["sphere"].clone()), (Value::Null, json!("normal"), Value::Null));
    // Moving a task to «Без даты» also clears its time of day.
    edit(&mut conn, &id, Some("2026-09-25"), fields(Some("18:00"), None, None)).unwrap();
    edit(&mut conn, &id, None, TaskFields::default()).unwrap();
    assert_eq!(stored(&conn, &id).0, None);
}

#[test]
fn invalid_task_fields_are_rejected_without_writing() {
    let mut conn = replica();
    let id = create(&mut conn, "Fictional task", Some("2026-09-24"), TaskFields::default());
    let before = load(&conn, &id).unwrap();
    for (date, extra, error) in [
        (None, fields(Some("10:00"), None, None), "time requires a date"),
        (Some("2026-09-24"), fields(Some("24:00"), None, None), "HH:MM"),
        (Some("2026-09-24"), fields(Some("9:00"), None, None), "HH:MM"),
        (Some("2026-09-24"), fields(None, Some("routine"), None), "task_kind"),
        (Some("2026-09-24"), fields(None, None, Some("finance")), "sphere"),
    ] {
        assert!(edit(&mut conn, &id, date, extra).unwrap_err().contains(error), "{error}");
    }
    assert_eq!(load(&conn, &id).unwrap(), before);
    assert!(save_task(&mut conn, None, "New".into(), None, None, None, None, None, fields(Some("10:00"), None, None)).unwrap_err().contains("time requires a date"));
}

#[test]
fn timed_tasks_sort_by_time_within_their_day() {
    let mut conn = replica();
    for (title, date, time) in [("untimed", Some("2026-09-24"), None), ("late", Some("2026-09-24"), Some("18:00")), ("early", Some("2026-09-24"), Some("08:15")), ("next", Some("2026-09-25"), Some("07:00")), ("undated", None, None)] {
        create(&mut conn, title, date, fields(time, None, None));
    }
    let titles: Vec<_> = calendar_list(&conn, "kind='task' AND archived=0 AND status IN ('task','done')", "s.date IS NULL,s.date,NULLIF(s.time,'') IS NULL,s.time,s.id", &[], true)
        .unwrap().into_iter().map(|row| row["title"].as_str().unwrap().to_owned()).collect();
    assert_eq!(titles, ["early", "late", "untimed", "next", "undated"]);
}

#[test]
fn records_saved_before_the_task_model_load_unchanged_and_the_schema_stays_v5() {
    let conn = replica();
    let columns_before: Vec<String> = conn.prepare("PRAGMA table_info(items)").unwrap().query_map([], |r| r.get(1)).unwrap().collect::<Result<_, _>>().unwrap();
    conn.execute(V0329_TASK_INSERT, params!["legacy", "Legacy task", "2026-09-20", 30, "2026-09-20T08:00:00Z", 5]).unwrap();
    // A first-MVP (v1) task could carry date and time; a note keeps its own tags.
    conn.execute("INSERT INTO items(id,kind,title,date,time,duration_minutes,version,created_at,updated_at) VALUES('v1-task','task','Early MVP task','2026-09-11','09:30',30,3,'a','a')", []).unwrap();
    conn.execute("INSERT INTO items(id,kind,title,date,time,duration_minutes,version,created_at,updated_at) VALUES('v1-undated','task','Undated with time','2026-09-11','07:00',30,1,'a','a')", []).unwrap();
    conn.execute("UPDATE items SET date=NULL WHERE id='v1-undated'", []).unwrap();
    conn.execute("INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at,tags,status) VALUES('note','task','Note',30,1,'a','a','calendar','note')", []).unwrap();
    crate::init_schema(&conn).unwrap();
    crate::init_schema(&conn).unwrap();
    let columns_after: Vec<String> = conn.prepare("PRAGMA table_info(items)").unwrap().query_map([], |r| r.get(1)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(columns_after, columns_before, "no items column is added, so 0.3.29 replicas keep accepting item records");
    assert_eq!(conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), crate::SCHEMA_VERSION);
    assert_eq!(crate::SCHEMA_VERSION, 5, "0.3.29 can still open this profile after a downgrade");
    let legacy = load(&conn, "legacy").unwrap();
    assert_eq!((legacy["time"].clone(), legacy["task_kind"].clone(), legacy["sphere"].clone(), legacy["version"].clone(), legacy["priority"].clone()), (Value::Null, json!("normal"), Value::Null, json!(1), json!(5)));
    assert_eq!(listed(&conn, "v1-task", true)["planned_time"], "09:30");
    assert_eq!(load(&conn, "v1-undated").unwrap()["time"], Value::Null, "a time without its date is not shown");
    assert_eq!(listed(&conn, "v1-undated", false)["planned_time"], Value::Null);
    assert_eq!(load(&conn, "note").unwrap()["tags"], "calendar");
}

#[test]
fn a_0329_replica_accepts_carries_and_returns_the_new_fields() {
    let mut newer = replica();
    let older = replica();
    let id = create(&mut newer, "Water the fictional plants", Some("2026-09-24"), fields(Some("07:45"), Some("instant"), Some("home")));
    assert!(transfer(&newer, &older, &id).unwrap(), "the record has the 0.3.29 column set");
    assert_eq!(stored(&older, &id), (Some("07:45".into()), "task-kind:instant,task-sphere:home".into()));
    // The older client renames, reschedules and completes with its own statements.
    let version: i64 = older.query_row("SELECT version FROM items WHERE id=?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(older.execute(V0329_TASK_UPDATE, params!["Renamed on the old phone", "2026-09-26", None::<i64>, "2026-09-24T09:00:00Z", &id, version, None::<i64>]).unwrap(), 1);
    assert!(transfer(&older, &newer, &id).unwrap());
    let back = load(&newer, &id).unwrap();
    assert_eq!((back["title"].clone(), back["date"].clone(), back["time"].clone(), back["task_kind"].clone(), back["sphere"].clone()), (json!("Renamed on the old phone"), json!("2026-09-26"), json!("07:45"), json!("instant"), json!("home")));
    assert_eq!(older.execute(V0329_TASK_COMPLETE, params!["2026-09-24T10:00:00Z", &id]).unwrap(), 1);
    assert!(transfer(&older, &newer, &id).unwrap());
    let done = load(&newer, &id).unwrap();
    assert_eq!((done["status"].clone(), done["time"].clone(), done["task_kind"].clone(), done["sphere"].clone()), (json!("done"), json!("07:45"), json!("instant"), json!("home")));
    assert_eq!(newer.query_row("SELECT count(*) FROM mvp_sync_conflicts", [], |r| r.get::<_, i64>(0)).unwrap(), 0, "sequential edits are not conflicts");
    // A task created by the older client arrives as a normal untimed task.
    older.execute(V0329_TASK_INSERT, params!["old-created", "Created on 0.3.29", "2026-09-24", None::<i64>, "2026-09-24T11:00:00Z", 0]).unwrap();
    assert!(transfer(&older, &newer, "old-created").unwrap());
    let created = load(&newer, "old-created").unwrap();
    assert_eq!((created["time"].clone(), created["task_kind"].clone(), created["sphere"].clone()), (Value::Null, json!("normal"), Value::Null));
    // «Без даты» on 0.3.29 leaves the time in place; the newer client hides it.
    let version: i64 = older.query_row("SELECT version FROM items WHERE id=?1", [&id], |r| r.get(0)).unwrap();
    older.execute(V0329_TASK_UPDATE, params!["Renamed on the old phone", None::<String>, None::<i64>, "2026-09-24T12:00:00Z", &id, version, None::<i64>]).unwrap();
    assert!(transfer(&older, &newer, &id).unwrap());
    assert_eq!(load(&newer, &id).unwrap()["time"], Value::Null);
    assert_eq!(listed(&newer, &id, true)["planned_time"], Value::Null);
    // Assigning a day again on the newer client does not revive that stale time,
    // while kind and sphere stay.
    edit(&mut newer, &id, Some("2026-09-27"), TaskFields::default()).unwrap();
    assert_eq!(stored(&newer, &id), (None, "task-kind:instant,task-sphere:home".into()));
    // The newer client's result travels back to the older replica unchanged.
    assert!(transfer(&newer, &older, &id).unwrap());
    assert_eq!(stored(&older, &id), (None, "task-kind:instant,task-sphere:home".into()));
}

#[test]
fn a_date_only_edit_keeps_the_time_only_while_the_task_had_a_date() {
    let mut conn = replica();
    let id = create(&mut conn, "Fictional reminder", Some("2026-09-24"), fields(Some("16:10"), None, None));
    // Rescheduling keeps the time of day.
    edit(&mut conn, &id, Some("2026-09-26"), TaskFields::default()).unwrap();
    assert_eq!(stored(&conn, &id).0.as_deref(), Some("16:10"));
    // A time left without its date (older replica, first MVP) is dropped on the next dated save.
    conn.execute("UPDATE items SET date=NULL WHERE id=?1", [&id]).unwrap();
    edit(&mut conn, &id, Some("2026-09-28"), TaskFields::default()).unwrap();
    assert_eq!(stored(&conn, &id).0, None);
    // An explicit time is still accepted for a task that had no date.
    conn.execute("UPDATE items SET date=NULL WHERE id=?1", [&id]).unwrap();
    edit(&mut conn, &id, Some("2026-09-28"), fields(Some("07:00"), None, None)).unwrap();
    assert_eq!(stored(&conn, &id).0.as_deref(), Some("07:00"));
}

#[test]
fn concurrent_edits_on_a_0329_and_a_newer_replica_converge_and_keep_the_other_version() {
    let mut newer = replica();
    let older = replica();
    let id = create(&mut newer, "Fictional errand", Some("2026-09-24"), fields(Some("10:00"), None, Some("home")));
    assert!(transfer(&newer, &older, &id).unwrap());
    // Both replicas change the same received version before hearing from each other.
    edit(&mut newer, &id, Some("2026-09-24"), fields(None, Some("instant"), Some("work"))).unwrap();
    let version: i64 = older.query_row("SELECT version FROM items WHERE id=?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(older.execute(V0329_TASK_UPDATE, params!["Renamed offline", "2026-09-24", None::<i64>, "2026-09-24T09:00:00Z", &id, version, None::<i64>]).unwrap(), 1);
    let (from_newer, from_older) = (wire(&newer, &id), wire(&older, &id));
    deliver(&newer, &from_older).unwrap();
    deliver(&older, &from_newer).unwrap();
    // Row-level resolution: both replicas hold the same winning row ...
    assert_eq!(stored(&newer, &id), stored(&older, &id));
    assert_eq!(title(&newer, &id), title(&older, &id));
    // ... and each keeps the other version for review, so neither edit is lost silently.
    for conn in [&newer, &older] {
        let kept: Vec<String> = conn.prepare("SELECT data FROM mvp_sync_conflicts").unwrap()
            .query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(kept.len(), 1);
        let current = format!("{} {}", title(conn, &id), stored(conn, &id).1);
        let both = format!("{current} {}", kept[0]);
        assert!(both.contains("Renamed offline") && both.contains("task-sphere:work") && both.contains("task-kind:instant"), "{both}");
    }
}

#[test]
fn an_extra_items_column_would_stall_a_0329_receiver() {
    // Why no column was added: the receiver requires the exact local column set.
    let newer = replica();
    let older = replica();
    newer.execute(V0329_TASK_INSERT, params!["probe", "Probe", "2026-09-24", None::<i64>, "2026-09-24T08:00:00Z", 0]).unwrap();
    let key = json!(["items", ["probe"]]).to_string();
    let mut wire = crate::mvp_sync_db::row_to_json(&newer, "mvp_records", &rusqlite::types::Value::Text(key.clone())).unwrap().unwrap().as_object().unwrap().clone();
    let mut data: Value = serde_json::from_str(wire["data"].as_str().unwrap()).unwrap();
    data["value"]["sphere"] = json!("home");
    wire.insert("data".into(), json!(data.to_string()));
    let stamp = wire["updated_at"].clone();
    wire.insert("_updated_at".into(), stamp);
    wire.insert("_device_id".into(), json!("newer-device"));
    assert_eq!(crate::mvp_sync_db::validate_record(&older, &wire).unwrap_err(), "content_sync_unknown_schema");
}

// ---- Work stages and «Жду ответа» (2026-09-24) ----
fn with_stage(stage: Option<&str>, waiting: Option<bool>) -> TaskFields {
    TaskFields { stage: stage.map(Into::into), waiting, ..TaskFields::default() }
}
fn app(conn: Connection) -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .manage(crate::AppState(std::sync::Mutex::new(conn)))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}
fn stamp_of(conn: &Connection, key: &str) -> String {
    conn.query_row("SELECT updated_at FROM sync_row_versions WHERE table_name='mvp_records' AND row_id=?1", [key], |r| r.get(0)).unwrap()
}
fn block_key(id: i64) -> String {
    json!(["timeline_blocks", [id]]).to_string()
}
fn block(conn: &Connection, id: i64, source: &str, active: bool, seconds: i64) {
    conn.execute(
        "INSERT INTO timeline_blocks(id,source_type,source_id,date,start_time,end_time,duration_minutes,duration_seconds,is_active,completion_date,created_at,updated_at) VALUES(?1,'note',?2,'2026-09-24','09:00:00',CASE WHEN ?3=1 THEN NULL ELSE '09:30:00' END,?4/60,?4,?3,'2026-09-24',?5,?5)",
        params![id, source, active as i64, seconds, format!("2026-09-24T0{}:00:00Z", id % 10)],
    )
    .unwrap();
}
fn blocks(conn: &Connection) -> Vec<i64> {
    conn.prepare("SELECT id FROM timeline_blocks ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
}
fn conflicts(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM mvp_sync_conflicts", [], |r| r.get(0)).unwrap()
}

#[test]
fn stage_and_waiting_round_trip_through_every_task_query() {
    let mut conn = replica();
    let id = create(&mut conn, "Describe the fictional form", Some("2026-09-24"), with_stage(Some("description"), Some(true)));
    assert_eq!(stored(&conn, &id).1, "task-stage:description,task-waiting");
    let detail = load(&conn, &id).unwrap();
    assert_eq!((detail["stage"].clone(), detail["waiting"].clone()), (json!("description"), json!(true)));
    for tasks_only in [true, false] {
        let row = listed(&conn, &id, tasks_only);
        assert_eq!((row["stage"].clone(), row["waiting"].clone()), (json!("description"), json!(true)), "tasks_only={tasks_only}");
    }
    // Unset values read as '' and false, also for a record saved by 0.3.29.
    conn.execute(V0329_TASK_INSERT, params!["legacy", "Legacy task", "2026-09-20", 30, "2026-09-20T08:00:00Z", 0]).unwrap();
    for row in [listed(&conn, "legacy", true), load(&conn, "legacy").unwrap()] {
        assert_eq!((row["stage"].clone(), row["waiting"].clone()), (json!(""), json!(false)));
    }
    // An edit without the new fields keeps them; explicit values replace each one.
    edit(&mut conn, &id, Some("2026-09-25"), fields(None, Some("normal"), Some("work"))).unwrap();
    assert_eq!(stored(&conn, &id).1, "task-stage:description,task-waiting,task-sphere:work");
    edit(&mut conn, &id, Some("2026-09-25"), with_stage(Some("acceptance"), None)).unwrap();
    assert_eq!(stored(&conn, &id).1, "task-waiting,task-sphere:work,task-stage:acceptance");
    edit(&mut conn, &id, Some("2026-09-25"), with_stage(Some(""), Some(false))).unwrap();
    assert_eq!(stored(&conn, &id).1, "task-sphere:work");
    let before = load(&conn, &id).unwrap();
    assert!(edit(&mut conn, &id, Some("2026-09-25"), with_stage(Some("review"), None)).unwrap_err().contains("stage"));
    assert_eq!(load(&conn, &id).unwrap(), before, "an unknown stage is rejected without writing");
}

#[test]
fn the_stage_command_edits_one_task_like_other_edits_and_rejects_other_records() {
    use tauri::Manager;
    let conn = replica();
    conn.execute("INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at,tags,status) VALUES('task','task','Fictional task',30,4,'a','a','calendar,task-sphere:home','task'),('note','task','Fictional note',30,1,'a','a','','note')", []).unwrap();
    conn.execute("INSERT INTO items(id,kind,title,date,time,duration_minutes,version,created_at,updated_at,tags) VALUES('event','event','Fictional event','2026-09-24','10:00',30,1,'a','a',''),('hc-sleep:fixture','event','Fictional sleep','2026-09-24','23:00',480,1,'a','a','')", []).unwrap();
    let app = app(conn);
    let row = set_calendar_task_stage("task".into(), Some("agreement".into()), Some(true), app.state()).unwrap();
    assert_eq!((row["id"].clone(), row["stage"].clone(), row["waiting"].clone(), row["sphere"].clone(), row["version"].clone()), (json!("task"), json!("agreement"), json!(true), json!("home"), json!(5)));
    assert_ne!(row["updated_at"], "a", "updated_at moves so the edit syncs");
    assert!(row.as_object().unwrap().contains_key("goal_id"), "the same row shape as get_calendar_task");
    // An omitted value keeps the stored one; '' clears only the stage.
    let row = set_calendar_task_stage("task".into(), None, Some(false), app.state()).unwrap();
    assert_eq!((row["stage"].clone(), row["waiting"].clone(), row["version"].clone()), (json!("agreement"), json!(false), json!(6)));
    let row = set_calendar_task_stage("task".into(), Some(String::new()), None, app.state()).unwrap();
    assert_eq!((row["stage"].clone(), row["version"].clone()), (json!(""), json!(7)));
    // Repeating the current choice writes nothing.
    let row = set_calendar_task_stage("task".into(), Some(String::new()), Some(false), app.state()).unwrap();
    assert_eq!(row["version"], 7);
    assert_eq!(stored(&app.state::<crate::AppState>().0.lock().unwrap(), "task").1, "calendar,task-sphere:home");
    for (id, stage, error) in [
        ("note", Some("agreement"), "task not found"),
        ("event", Some("agreement"), "task not found"),
        ("missing", None, "task not found"),
        ("hc-sleep:fixture", Some("agreement"), "health_sleep_readonly"),
        ("task", Some("review"), "stage must be"),
        ("", Some(""), "record id is required"),
    ] {
        let error_text = set_calendar_task_stage(id.into(), stage.map(Into::into), Some(true), app.state()).unwrap_err();
        assert!(error_text.contains(error), "{id}: {error_text}");
    }
    let state = app.state::<crate::AppState>();
    let conn = state.0.lock().unwrap();
    for id in ["note", "event", "hc-sleep:fixture"] {
        assert_eq!(stored(&conn, id).1, "", "{id} is unchanged");
    }
}

#[test]
fn a_stage_written_here_travels_through_a_0329_replica_and_unknown_stages_survive() {
    let mut newer = replica();
    let older = replica();
    let id = create(&mut newer, "Agree the fictional contract", Some("2026-09-24"), TaskFields::default());
    set_task_stage(&mut newer, &id, Some("agreement"), Some(true)).unwrap();
    let key = json!(["items", [&id]]).to_string();
    let written = stamp_of(&newer, &key);
    set_task_stage(&mut newer, &id, Some("agreement"), Some(true)).unwrap();
    assert_eq!(stamp_of(&newer, &key), written, "an unchanged choice creates no sync record");
    assert!(transfer(&newer, &older, &id).unwrap(), "a tag write keeps the 0.3.29 column set");
    assert_eq!(stored(&older, &id).1, "task-stage:agreement,task-waiting");
    // The older client renames and reschedules with its own statement and keeps the tags.
    let version: i64 = older.query_row("SELECT version FROM items WHERE id=?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(older.execute(V0329_TASK_UPDATE, params!["Renamed on the old phone", "2026-09-26", None::<i64>, "2026-09-24T09:00:00Z", &id, version, None::<i64>]).unwrap(), 1);
    assert!(transfer(&older, &newer, &id).unwrap());
    let back = load(&newer, &id).unwrap();
    assert_eq!((back["title"].clone(), back["stage"].clone(), back["waiting"].clone()), (json!("Renamed on the old phone"), json!("agreement"), json!(true)));
    assert_eq!(conflicts(&newer), 0, "sequential edits are not conflicts");
    // A stage id from a newer version reads as unset but survives this version's edits.
    newer.execute("UPDATE items SET tags='task-stage:review,task-waiting' WHERE id=?1", [&id]).unwrap();
    assert_eq!(load(&newer, &id).unwrap()["stage"], "");
    edit(&mut newer, &id, Some("2026-09-27"), fields(None, None, Some("work"))).unwrap();
    set_task_stage(&mut newer, &id, None, Some(false)).unwrap();
    assert_eq!(stored(&newer, &id).1, "task-stage:review,task-sphere:work");
    assert!(transfer(&newer, &older, &id).unwrap());
    assert_eq!(stored(&older, &id).1, "task-stage:review,task-sphere:work");
    // Only an explicit choice replaces it.
    set_task_stage(&mut newer, &id, Some("development"), None).unwrap();
    assert_eq!(stored(&newer, &id).1, "task-sphere:work,task-stage:development");
}

#[test]
fn cancelling_a_running_block_discards_only_its_time_and_the_delete_syncs() {
    let mut phone = replica();
    let laptop = replica();
    let id = create(&mut phone, "Fictional analysis", Some("2026-09-24"), TaskFields::default());
    block(&phone, 1, &id, false, 1500);
    block(&phone, 2, &id, true, 0);
    assert!(transfer(&phone, &laptop, &id).unwrap());
    for item in [1, 2] {
        assert!(deliver(&laptop, &wire_row(&phone, &block_key(item))).unwrap());
    }
    // Paused or unknown blocks are never removed here: recorded work stays.
    assert_eq!(cancel_block(&mut phone, 1).unwrap_err(), "block is not active");
    assert_eq!(cancel_block(&mut phone, 99).unwrap_err(), "block not found");
    cancel_block(&mut phone, 2).unwrap();
    assert_eq!(blocks(&phone), [1]);
    assert_eq!(calendar_task_seconds(&phone, "note", &id).unwrap(), 1500);
    let row = listed(&phone, &id, true);
    assert_eq!((row["is_active"].clone(), row["actual_minutes"].clone()), (json!(false), json!(25)));
    assert_eq!(cancel_block(&mut phone, 2).unwrap_err(), "block not found", "a second cancel changes nothing");
    // The delete travels as a timeline tombstone with the block's birth identity.
    let tomb = wire_row(&phone, &block_key(2));
    let data: Value = serde_json::from_str(tomb["data"].as_str().unwrap()).unwrap();
    assert_eq!((data["deleted"].clone(), data["identity"].clone()), (json!(true), json!(["2026-09-24T02:00:00Z", "note", &id])));
    assert!(deliver(&laptop, &tomb).unwrap());
    assert_eq!(blocks(&laptop), [1]);
    assert_eq!(calendar_task_seconds(&laptop, "note", &id).unwrap(), 1500);
    assert_eq!(conflicts(&laptop), 0, "the tombstone follows the running version");
    // A replica that never received the start applies it as a no-op.
    let fresh = replica();
    assert!(deliver(&fresh, &tomb).unwrap());
    assert!(blocks(&fresh).is_empty());
}

#[test]
fn a_cancel_and_a_concurrent_pause_on_another_device_converge() {
    let mut phone = replica();
    let laptop = replica();
    let id = create(&mut phone, "Fictional review", Some("2026-09-24"), TaskFields::default());
    block(&phone, 5, &id, true, 0);
    assert!(transfer(&phone, &laptop, &id).unwrap());
    assert!(deliver(&laptop, &wire_row(&phone, &block_key(5))).unwrap());
    cancel_block(&mut phone, 5).unwrap();
    stop(&laptop, 5, false).unwrap();
    let (from_phone, from_laptop) = (wire_row(&phone, &block_key(5)), wire_row(&laptop, &block_key(5)));
    deliver(&laptop, &from_phone).unwrap();
    deliver(&phone, &from_laptop).unwrap();
    assert_eq!(blocks(&phone), blocks(&laptop), "both replicas keep the same winning version");
    for conn in [&phone, &laptop] {
        assert_eq!(conflicts(conn), 1, "the other version is kept for review");
    }
}

#[test]
fn running_blocks_carry_task_stage_and_cancel_is_a_registered_command() {
    use tauri::Manager;
    let mut conn = replica();
    let id = create(&mut conn, "Fictional decomposition", Some("2026-09-24"), with_stage(Some("decomposition"), Some(true)));
    conn.execute("INSERT INTO items(id,kind,title,date,time,duration_minutes,version,created_at,updated_at,tags) VALUES('event','event','Fictional call','2026-09-24','10:00',30,1,'a','a','')", []).unwrap();
    let app = app(conn);
    let task_block = start_task_block("note".into(), id.clone(), None, None, app.state()).unwrap();
    start_task_block("event".into(), "event".into(), None, None, app.state()).unwrap();
    let running = get_active_blocks(app.state()).unwrap();
    let task = running.iter().find(|row| row["source_type"] == "note").unwrap();
    assert_eq!((task["stage"].clone(), task["waiting"].clone(), task["task_kind"].clone()), (json!("decomposition"), json!(true), json!("normal")));
    let event = running.iter().find(|row| row["source_type"] == "event").unwrap();
    assert!(event.get("stage").is_none(), "events carry no task stage");
    cancel_task_block(task_block, app.state()).unwrap();
    let running = get_active_blocks(app.state()).unwrap();
    assert_eq!(running.len(), 1, "only the cancelled block is gone");
    assert_eq!(running[0]["source_type"], "event");
    assert_eq!(cancel_task_block(task_block, app.state()).unwrap_err(), "block not found");
    let state = app.state::<crate::AppState>();
    let conn = state.0.lock().unwrap();
    assert_eq!(calendar_task_seconds(&conn, "note", &id).unwrap(), 0, "as if it was never started");
}
