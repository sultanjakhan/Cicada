//! Exercise the actual Tauri command deserializer and SQLite implementation.
//! MockRuntime creates no native window and is not live UI evidence.
use crate::{calendar_compat as api, init_schema, AppState};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::test::{
    get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
};
use tauri::Manager;

fn fixture() -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
    fixture_with_connection(Connection::open_in_memory().unwrap())
}

fn fixture_with_connection(
    conn: Connection,
) -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
    init_schema(&conn).unwrap();
    let app = mock_builder()
        .manage(AppState(Mutex::new(conn)))
        .invoke_handler(tauri::generate_handler![
            crate::delete_item,
            api::get_goals,
            api::save_calendar_goal,
            api::delete_goal,
            api::get_calendar_task_goals,
            api::set_calendar_task_goal,
            api::get_calendar_task,
            api::save_calendar_task,
            api::get_calendar_tasks,
            api::get_calendar_records,
            api::complete_calendar_task,
            api::create_note,
            api::update_note,
            api::update_note_status,
            api::get_note,
            api::get_notes,
            api::toggle_note_archive,
            api::create_event,
            api::update_event,
            api::get_all_events,
            api::delete_event,
            api::start_task_block,
            api::pause_task_block,
            api::finish_task_block,
            api::skip_recurring_step,
            api::get_active_block,
            api::get_active_blocks,
            api::get_timeline_blocks,
            api::get_latest_task_block,
            api::get_calendar_task_minutes,
            api::get_calendar_task_seconds,
            api::get_ui_state,
            api::get_schedules,
            api::start_calendar_day,
            api::set_ui_state,
            api::list_event_categories,
            api::create_event_category,
            api::update_event_category,
            api::delete_event_category
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (app, webview)
}

fn call(
    webview: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    args: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: if cfg!(target_os = "windows") {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: tauri::ipc::InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize::<Value>().unwrap())
}

fn goal(webview: &tauri::WebviewWindow<MockRuntime>, title: &str, parent: Value) -> Value {
    call(
        webview,
        "save_calendar_goal",
        json!({"id":null,"title":title,"targetValue":1.0,
        "unit":"","deadline":null,"goalKind":"goal","description":"","criteria":"",
        "parentGoalId":parent,"clearParent":false,"currentValue":null}),
    )
    .unwrap()
}

fn mutation_fixture_sql(conn: &Connection) {
    conn.execute_batch(
        "INSERT INTO event_categories(id,name,color,icon,created_at) VALUES
            ('category-a','Example A','#123456','A','test'),
            ('category-b','Example B','#654321','B','test');
        INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at,category) VALUES
            ('event-a','event','Example event A',30,1,'test','test','Example A'),
            ('event-b','event','Example event B',30,1,'test','test','Example B'),
            ('task-a','task','Example task',30,1,'test','test','task');
        INSERT INTO calendar_goals(id,title,created_at,updated_at) VALUES
            ('goal-a','Example goal A','test','test'),
            ('goal-b','Example goal B','test','test');
        INSERT INTO calendar_task_goals(source_type,source_id,goal_id,created_at) VALUES
            ('note','task-a','goal-a','test'),
            ('event','event-b','goal-b','test');",
    )
    .unwrap();
}

fn category_cascade_fixture_sql(conn: &Connection) {
    mutation_fixture_sql(conn);
    conn.execute_batch(
        "INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at,category,status) VALUES
            ('task-matching-category','task','Matching task',30,1,'original','original','Example A','task'),
            ('note-matching-category','task','Matching note',30,1,'original','original','Example A','note');
         INSERT INTO timeline_blocks(source_type,source_id,date,start_time,duration_minutes,is_active,created_at,updated_at) VALUES
            ('event','event-a','2026-09-13','10:00',30,0,'fixture','fixture'),
            ('event','event-b','2026-09-13','11:00',30,0,'fixture','fixture');",
    )
    .unwrap();
}

fn category_revision(conn: &Connection, id: &str) -> (String, i64, String) {
    conn.query_row(
        "SELECT category,version,updated_at FROM items WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .unwrap()
}

fn calendar_list_fixture() -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
    let (app, view) = fixture();
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        conn.execute_batch("INSERT INTO items(id,kind,title,date,time,duration_minutes,completed,status,archived,version,created_at,updated_at,category,color,priority) VALUES
            ('t-undated','task','t-undated',NULL,NULL,0,0,'task',0,1,'fixture','fixture','Example','#123456',3),
            ('t-open','task','t-open','2026-09-12','15:00',45,0,'task',0,1,'fixture','fixture','Example','#123456',3),
            ('t-done','task','t-done','2026-09-12',NULL,0,1,'done',0,1,'fixture','fixture','Example','#123456',3),
            ('t-legacy','task','t-legacy','2026-09-13',NULL,20,1,'task',0,1,'fixture','fixture','Example','#123456',3),
            ('t-out','task','t-out','2026-10-01',NULL,25,0,'task',0,1,'fixture','fixture','Example','#123456',3),
            ('t-note','task','t-note','2026-09-12',NULL,0,0,'note',0,1,'fixture','fixture','Example','#123456',3),
            ('t-arch','task','t-arch','2026-09-12',NULL,0,0,'task',1,1,'fixture','fixture','Example','#123456',3),
            ('e-cross','event','e-cross','2026-08-31','23:30',60,0,'task',0,1,'fixture','fixture','Example','#123456',3),
            ('e-edge','event','e-edge','2026-08-31','23:30',30,0,'task',0,1,'fixture','fixture','Example','#123456',3),
            ('e-old','event','e-old','2026-08-31',NULL,0,0,'task',0,1,'fixture','fixture','Example','#123456',3),
            ('e-all','event','e-all','2026-09-01',NULL,0,0,'task',0,1,'fixture','fixture','Example','#123456',3),
            ('e-empty','event','e-empty','2026-09-01','',0,0,'task',0,1,'fixture','fixture','Example','#123456',3),
            ('e-legacy','event','e-legacy','2026-09-12','09:00',30,1,'task',0,1,'fixture','fixture','Example','#123456',3),
            ('e-end','event','e-end','2026-09-30','23:30',60,0,'task',0,1,'fixture','fixture','Example','#123456',3),
            ('e-out','event','e-out','2026-10-01','08:00',30,0,'task',0,1,'fixture','fixture','Example','#123456',3),
            ('e-arch','event','e-arch','2026-09-01',NULL,0,0,'task',1,1,'fixture','fixture','Example','#123456',3);
            INSERT INTO timeline_blocks(source_type,source_id,date,start_time,duration_minutes,is_active,created_at,updated_at) VALUES
            ('note','t-open','2026-09-12','10:00',7,0,'fixture','fixture'),
            ('note','t-open','2026-09-12','11:00',8,0,'fixture','fixture'),
            ('note','t-open','2026-09-12','12:00',100,1,'fixture','fixture'),
            ('event','t-open','2026-09-12','12:00',999,0,'fixture','fixture'),
            ('note','t-done','2026-09-12','12:00',0,0,'fixture','fixture'),
            ('event','e-cross','2026-08-31','23:30',3,0,'fixture','fixture'),
            ('event','e-cross','2026-09-01','00:01',100,1,'fixture','fixture'),
            ('note','e-cross','2026-09-01','00:01',999,0,'fixture','fixture'),
            ('event','e-legacy','2026-09-12','09:00',11,0,'fixture','fixture'),
            ('note','historical','2025-01-01','09:00',9999,1,'fixture','fixture');").unwrap();
    }
    (app, view)
}

fn expected_list_record(
    id: &str,
    source: &str,
    date: Option<&str>,
    time: Option<&str>,
    duration: Option<i64>,
) -> Value {
    json!({"source_type":source,"source_id":id,"title":id,"date":date,"planned_time":time,
        "duration_minutes":duration,"category":"Example","color":"#123456","completed":false,
        "status_extra":"task","priority":3,"tracking_mode":if source=="note" {"check"}else{"track"},
        "is_active":false,"actual_minutes":0,"has_work":false})
}

#[test]
fn calendar_lists_preserve_payloads_filters_and_timeline_totals() {
    let (_app, view) = calendar_list_fixture();
    let undated = expected_list_record("t-undated", "note", None, None, None);
    let mut cross = expected_list_record(
        "e-cross",
        "event",
        Some("2026-08-31"),
        Some("23:30"),
        Some(60),
    );
    cross["is_active"] = json!(true);
    cross["has_work"] = json!(true);
    cross["actual_minutes"] = json!(3);
    let all_day = expected_list_record("e-all", "event", Some("2026-09-01"), None, Some(0));
    let empty_time =
        expected_list_record("e-empty", "event", Some("2026-09-01"), Some(""), Some(0));
    let mut done = expected_list_record("t-done", "note", Some("2026-09-12"), None, None);
    done["completed"] = json!(true);
    done["status_extra"] = json!("done");
    done["has_work"] = json!(true);
    let mut event_legacy = expected_list_record(
        "e-legacy",
        "event",
        Some("2026-09-12"),
        Some("09:00"),
        Some(30),
    );
    event_legacy["completed"] = json!(true);
    event_legacy["status_extra"] = json!("done");
    event_legacy["actual_minutes"] = json!(11);
    event_legacy["has_work"] = json!(true);
    let mut open = expected_list_record(
        "t-open",
        "note",
        Some("2026-09-12"),
        Some("15:00"),
        Some(45),
    );
    open["is_active"] = json!(true);
    open["has_work"] = json!(true);
    open["actual_minutes"] = json!(15);
    let mut legacy = expected_list_record("t-legacy", "note", Some("2026-09-13"), None, Some(20));
    legacy["completed"] = json!(true);
    legacy["status_extra"] = json!("done");
    let end = expected_list_record(
        "e-end",
        "event",
        Some("2026-09-30"),
        Some("23:30"),
        Some(60),
    );
    assert_eq!(
        call(
            &view,
            "get_calendar_records",
            json!({"start":"2026-09-01","end":"2026-09-30"})
        )
        .unwrap(),
        json!([
            undated,
            cross,
            all_day,
            empty_time,
            done,
            event_legacy,
            open,
            legacy,
            end
        ])
    );

    // Task list has its own order, no date-range filter, and a deliberately smaller payload.
    let as_task = |mut value: Value| {
        let fields = value.as_object_mut().unwrap();
        fields.remove("category");
        fields.remove("color");
        fields.insert("planned_time".into(), Value::Null);
        value
    };
    let outside = expected_list_record("t-out", "note", Some("2026-10-01"), None, Some(25));
    let remaining = json!([
        as_task(open.clone()),
        as_task(outside.clone()),
        as_task(undated.clone())
    ]);
    assert_eq!(
        call(&view, "get_calendar_tasks", json!({})).unwrap(),
        remaining
    );
    assert_eq!(
        call(
            &view,
            "get_calendar_tasks",
            json!({"includeCompleted":false})
        )
        .unwrap(),
        remaining
    );
    assert_eq!(
        call(
            &view,
            "get_calendar_tasks",
            json!({"includeCompleted":true})
        )
        .unwrap(),
        json!([
            as_task(done),
            as_task(open),
            as_task(legacy),
            as_task(outside),
            as_task(undated)
        ])
    );
    assert!(call(
        &view,
        "get_calendar_records",
        json!({"start":"bad","end":"2026-09-30"})
    )
    .is_err());
}

#[test]
fn timer_seconds_preserve_new_precision_and_legacy_minute_totals() {
    let (app, view) = fixture();
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        conn.execute_batch("INSERT INTO items(id,kind,title,date,duration_minutes,version,created_at,updated_at) VALUES
            ('new-task','task','Exact task','2026-09-14',30,1,'fixture','fixture'),
            ('mixed-task','task','Mixed task','2026-09-14',30,1,'fixture','fixture');
            INSERT INTO timeline_blocks(source_type,source_id,date,start_time,duration_minutes,duration_seconds,is_active,created_at,updated_at) VALUES
            ('note','new-task','2026-09-13','23:59:00',1,90,0,'fixture','fixture'),
            ('note','new-task','2026-09-14','00:01:00',1,90,0,'fixture','fixture'),
            ('note','mixed-task','2026-09-14','00:02:00',1,0,0,'fixture','fixture'),
            ('note','mixed-task','2026-09-14','00:03:00',0,30,0,'fixture','fixture');").unwrap();
    }
    assert_eq!(
        call(
            &view,
            "get_calendar_task_seconds",
            json!({"sourceType":"note","sourceId":"new-task","completionDate":"2026-09-13"})
        )
        .unwrap(),
        json!(180)
    );
    assert_eq!(
        call(
            &view,
            "get_calendar_task_minutes",
            json!({"sourceType":"note","sourceId":"new-task","completionDate":"2026-09-13"})
        )
        .unwrap(),
        json!(3)
    );
    assert_eq!(
        call(
            &view,
            "get_calendar_task_seconds",
            json!({"sourceType":"note","sourceId":"mixed-task","completionDate":"2026-09-14"})
        )
        .unwrap(),
        json!(90)
    );
    assert_eq!(
        call(
            &view,
            "get_calendar_task_minutes",
            json!({"sourceType":"note","sourceId":"mixed-task","completionDate":"2026-09-14"})
        )
        .unwrap(),
        json!(1)
    );
    let midnight = call(&view, "get_timeline_blocks", json!({"date":"2026-09-14"})).unwrap();
    assert_eq!(midnight[0]["duration_seconds"], json!(90));
    assert_eq!(
        midnight[1]["duration_seconds"],
        json!(60),
        "legacy rows keep their stored whole minutes"
    );
    assert_eq!(midnight[2]["duration_seconds"], json!(30));
    for response in [
        call(
            &view,
            "get_calendar_tasks",
            json!({"includeCompleted":true}),
        )
        .unwrap(),
        call(
            &view,
            "get_calendar_records",
            json!({"start":"2026-09-14","end":"2026-09-14"}),
        )
        .unwrap(),
    ] {
        let actual = |id: &str| {
            response
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["source_id"] == id)
                .unwrap()["actual_minutes"]
                .clone()
        };
        assert_eq!(actual("new-task"), json!(3));
        assert_eq!(actual("mixed-task"), json!(1));
    }
}

#[test]
fn calendar_lists_keep_status_filters_independent_of_kind_and_completion() {
    let (app, view) = calendar_list_fixture();
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        conn.execute_batch(
            "UPDATE items SET status='note' WHERE id='e-all';
            UPDATE items SET completed=0 WHERE id='t-done';",
        )
        .unwrap();
    }
    let records = call(
        &view,
        "get_calendar_records",
        json!({"start":"2026-09-01","end":"2026-09-30"}),
    )
    .unwrap();
    assert!(!records
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["source_id"] == "e-all"));
    let remaining = call(
        &view,
        "get_calendar_tasks",
        json!({"includeCompleted":false}),
    )
    .unwrap();
    assert!(!remaining
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["source_id"] == "t-done"));
    let all = call(
        &view,
        "get_calendar_tasks",
        json!({"includeCompleted":true}),
    )
    .unwrap();
    let done = all
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["source_id"] == "t-done")
        .unwrap();
    assert_eq!(done["completed"], false);
    assert_eq!(done["status_extra"], "done");
}

#[test]
#[ignore = "manual synthetic IPC benchmark; no native UI latency claim"]
fn calendar_list_benchmark() {
    use std::hash::{DefaultHasher, Hash, Hasher};
    use std::time::Instant;
    for count in [100, 1000, 5000] {
        let (app, view) = fixture();
        {
            let state = app.state::<AppState>();
            let mut conn = state.0.lock().unwrap();
            let tx = conn.transaction().unwrap();
            for n in 0..count {
                let kind = if n % 2 == 0 { "event" } else { "task" };
                let source = if n % 2 == 0 { "event" } else { "note" };
                let id = format!("fixture-{n:05}");
                tx.execute("INSERT INTO items(id,kind,title,date,time,duration_minutes,version,created_at,updated_at) VALUES(?1,?2,?1,'2026-09-12',?3,30,1,'fixture','fixture')",rusqlite::params![id,kind,if kind=="event" {Some("09:00")} else {None}]).unwrap();
                for active in [false, true] {
                    tx.execute("INSERT INTO timeline_blocks(source_type,source_id,date,start_time,duration_minutes,is_active,created_at,updated_at) VALUES(?1,?2,'2026-09-12','09:00',10,?3,'fixture','fixture')",rusqlite::params![source,id,active]).unwrap();
                }
            }
            for n in 0..count * 4 {
                tx.execute("INSERT INTO timeline_blocks(source_type,source_id,date,start_time,duration_minutes,is_active,created_at,updated_at) VALUES('note',?1,'2025-01-01','09:00',30,0,'fixture','fixture')",[format!("historical-{n}")]).unwrap();
            }
            tx.commit().unwrap();
        }
        for (command, args) in [
            (
                "get_calendar_records",
                json!({"start":"2026-09-01","end":"2026-09-30"}),
            ),
            ("get_calendar_tasks", json!({"includeCompleted":true})),
        ] {
            let expected = call(&view, command, args.clone()).unwrap();
            let mut samples = Vec::new();
            for _ in 0..5 {
                let started = Instant::now();
                let actual = call(&view, command, args.clone()).unwrap();
                samples.push(started.elapsed().as_micros());
                assert_eq!(actual, expected);
            }
            samples.sort_unstable();
            let mut hash = DefaultHasher::new();
            expected.to_string().hash(&mut hash);
            println!("CALENDAR_BENCH records={count} command={command} rows={} median_us={} payload_hash={:016x}",expected.as_array().unwrap().len(),samples[2],hash.finish());
        }
    }
}

fn mutation_snapshot(conn: &Connection) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
    [
        "items",
        "event_categories",
        "calendar_goals",
        "calendar_task_goals",
        "timeline_blocks",
    ]
    .into_iter()
    .map(|table| {
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1,2"))
            .unwrap();
        let columns = stmt.column_count();
        stmt.query_map([], |row| (0..columns).map(|i| row.get(i)).collect())
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    })
    .collect()
}

#[test]
fn finishing_task_rolls_back_timer_on_failure_and_allows_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.db");
    let (app, view) = fixture_with_connection(Connection::open(&path).unwrap());
    let before = {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        mutation_fixture_sql(&conn);
        let began = (chrono::Utc::now() - chrono::Duration::minutes(3)).to_rfc3339();
        conn.execute("INSERT INTO timeline_blocks(id,source_type,source_id,date,start_time,is_active,created_at,updated_at) VALUES(100,'note','task-a','2026-09-12','10:00:00',1,?1,?1)", [&began]).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_task_completion BEFORE UPDATE OF completed ON items WHEN NEW.id='task-a' BEGIN SELECT RAISE(ABORT,'injected completion failure'); END;").unwrap();
        mutation_snapshot(&conn)
    };
    let error = call(&view, "finish_task_block", json!({"blockId":100})).unwrap_err();
    assert!(error
        .as_str()
        .unwrap()
        .contains("injected completion failure"));
    let observer = Connection::open(&path).unwrap();
    assert_eq!(
        mutation_snapshot(&observer),
        before,
        "failed completion must preserve both running timer and unfinished task"
    );
    observer
        .execute_batch("DROP TRIGGER reject_task_completion")
        .unwrap();
    assert_eq!(
        call(&view, "finish_task_block", json!({"blockId":100})).unwrap(),
        Value::Null
    );
    let (active, minutes, seconds): (bool, i64, i64) = observer
        .query_row(
            "SELECT is_active,duration_minutes,duration_seconds FROM timeline_blocks WHERE id=100",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert!(!active);
    assert!(minutes >= 3);
    assert!(seconds >= minutes * 60);
    let (completed, status): (bool, String) = observer
        .query_row(
            "SELECT completed,status FROM items WHERE id='task-a'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(completed);
    assert_eq!(status, "done");
    assert_eq!(
        observer
            .query_row("SELECT COUNT(*) FROM calendar_task_goals", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert!(app.state::<AppState>().0.lock().unwrap().is_autocommit());
}

fn seed_goal_tree(conn: &Connection) {
    mutation_fixture_sql(conn);
    conn.execute_batch("INSERT INTO calendar_goals(id,title,parent_goal_id,created_at,updated_at) VALUES
        ('child','Example child','goal-a','original','original'),
        ('grandchild','Example grandchild','child','original','original'),
        ('other-child','Example other child','goal-b','original','original');
        INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at) VALUES('child-task','task','Example child task',30,1,'original','original');
        INSERT INTO calendar_task_goals(source_type,source_id,goal_id,created_at) VALUES('note','child-task','child','original');").unwrap();
}

fn save_goal(
    view: &tauri::WebviewWindow<MockRuntime>,
    id: Value,
    title: &str,
    goal_kind: &str,
) -> Result<Value, Value> {
    call(
        view,
        "save_calendar_goal",
        json!({"id":id,"title":title,"targetValue":1.0,
        "unit":"","deadline":null,"goalKind":goal_kind,"description":"","criteria":"",
        "parentGoalId":null,"clearParent":false,"currentValue":null}),
    )
}

fn convert_goal_to_daily_norm(
    view: &tauri::WebviewWindow<MockRuntime>,
    id: &str,
) -> Result<Value, Value> {
    save_goal(view, json!(id), "Daily parent", "daily_norm")
}

#[test]
fn deleting_parent_goal_promotes_only_direct_children_and_preserves_tasks() {
    let (app, view) = fixture();
    let before_items = {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        seed_goal_tree(&conn);
        mutation_snapshot(&conn)[0].clone()
    };
    assert_eq!(
        call(&view, "delete_goal", json!({"id":"goal-a"})).unwrap(),
        Value::Null
    );
    let state = app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT parent_goal_id FROM calendar_goals WHERE id='child'",
            [],
            |r| r.get::<_, Option<String>>(0)
        )
        .unwrap(),
        None
    );
    assert_ne!(
        conn.query_row(
            "SELECT updated_at FROM calendar_goals WHERE id='child'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "original"
    );
    assert_eq!(
        conn.query_row(
            "SELECT parent_goal_id FROM calendar_goals WHERE id='grandchild'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "child"
    );
    assert_eq!(
        conn.query_row(
            "SELECT parent_goal_id FROM calendar_goals WHERE id='other-child'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "goal-b"
    );
    assert_eq!(
        conn.query_row(
            "SELECT goal_id FROM calendar_task_goals WHERE source_id='child-task'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "child"
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM calendar_task_goals WHERE goal_id='goal-a'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(mutation_snapshot(&conn)[0], before_items);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM calendar_goals child LEFT JOIN calendar_goals parent ON parent.id=child.parent_goal_id WHERE child.parent_goal_id IS NOT NULL AND parent.id IS NULL",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}

#[test]
fn failed_parent_deletion_restores_children_and_task_links() {
    let (app, view) = fixture();
    let before = {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        seed_goal_tree(&conn);
        conn.execute_batch("CREATE TRIGGER reject_parent_delete BEFORE DELETE ON calendar_goals WHEN OLD.id='goal-a' BEGIN SELECT RAISE(ABORT,'injected parent delete failure'); END;").unwrap();
        mutation_snapshot(&conn)
    };
    let error = call(&view, "delete_goal", json!({"id":"goal-a"})).unwrap_err();
    assert!(error
        .as_str()
        .unwrap()
        .contains("injected parent delete failure"));
    assert_eq!(
        mutation_snapshot(&app.state::<AppState>().0.lock().unwrap()),
        before
    );
}

#[test]
fn converting_parent_goal_to_daily_norm_promotes_only_direct_children() {
    let (app, view) = fixture();
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        seed_goal_tree(&conn);
        conn.execute_batch("INSERT INTO calendar_task_goals(source_type,source_id,goal_id,created_at) VALUES('event','event-a','child','original');").unwrap();
    }
    convert_goal_to_daily_norm(&view, "goal-a").unwrap();
    let state = app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT goal_kind FROM calendar_goals WHERE id='goal-a'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "daily_norm"
    );
    assert_eq!(
        conn.query_row(
            "SELECT parent_goal_id FROM calendar_goals WHERE id='child'",
            [],
            |r| r.get::<_, Option<String>>(0)
        )
        .unwrap(),
        None
    );
    assert_ne!(
        conn.query_row(
            "SELECT updated_at FROM calendar_goals WHERE id='child'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "original"
    );
    assert_eq!(
        conn.query_row(
            "SELECT parent_goal_id FROM calendar_goals WHERE id='grandchild'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "child"
    );
    assert_eq!(
        conn.query_row("SELECT goal_id FROM calendar_task_goals WHERE source_type='note' AND source_id='child-task'", [], |r| r.get::<_, String>(0)).unwrap(),
        "child"
    );
    assert_eq!(
        conn.query_row("SELECT goal_id FROM calendar_task_goals WHERE source_type='event' AND source_id='event-a'", [], |r| r.get::<_, String>(0)).unwrap(),
        "child"
    );
}

#[test]
fn stale_child_cannot_restore_a_daily_norm_parent() {
    let (app, view) = fixture();
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        seed_goal_tree(&conn);
    }
    convert_goal_to_daily_norm(&view, "goal-a").unwrap();
    let stale = call(
        &view,
        "save_calendar_goal",
        json!({"id":"child","title":"stale child","targetValue":1.0,
        "unit":"","deadline":null,"goalKind":"goal","description":"","criteria":"",
        "parentGoalId":"goal-a","clearParent":false,"currentValue":null}),
    )
    .unwrap_err();
    assert!(stale.as_str().unwrap().contains("cannot have children"));
    let daily_child = call(
        &view,
        "save_calendar_goal",
        json!({"id":null,"title":"invalid daily child","targetValue":1.0,
        "unit":"","deadline":null,"goalKind":"daily_norm","description":"","criteria":"",
        "parentGoalId":"goal-b","clearParent":false,"currentValue":null}),
    )
    .unwrap_err();
    assert!(daily_child
        .as_str()
        .unwrap()
        .contains("only goal can have a parent"));
    let unknown_child = call(
        &view,
        "save_calendar_goal",
        json!({"id":null,"title":"invalid unknown child","targetValue":1.0,
        "unit":"","deadline":null,"goalKind":"unknown","description":"","criteria":"",
        "parentGoalId":"goal-b","clearParent":false,"currentValue":null}),
    )
    .unwrap_err();
    assert!(unknown_child
        .as_str()
        .unwrap()
        .contains("only goal can have a parent"));
    {
        let state = app.state::<AppState>();
        state
            .0
            .lock()
            .unwrap()
            .execute(
                "UPDATE calendar_goals SET goal_kind='unknown' WHERE id='goal-b'",
                [],
            )
            .unwrap();
    }
    let unknown_parent = call(
        &view,
        "save_calendar_goal",
        json!({"id":null,"title":"invalid unknown parent","targetValue":1.0,
        "unit":"","deadline":null,"goalKind":"goal","description":"","criteria":"",
        "parentGoalId":"goal-b","clearParent":false,"currentValue":null}),
    )
    .unwrap_err();
    assert!(unknown_parent
        .as_str()
        .unwrap()
        .contains("cannot have children"));
    {
        let state = app.state::<AppState>();
        state
            .0
            .lock()
            .unwrap()
            .execute(
                "UPDATE calendar_goals SET goal_kind='goal' WHERE id='goal-b'",
                [],
            )
            .unwrap();
    }
    let cleared = call(
        &view,
        "save_calendar_goal",
        json!({"id":"child","title":"cleared daily","targetValue":1.0,
        "unit":"","deadline":null,"goalKind":"daily_norm","description":"","criteria":"",
        "parentGoalId":"goal-a","clearParent":true,"currentValue":null}),
    )
    .unwrap();
    assert_eq!(cleared, json!("child"));
    assert_eq!(
        call(
            &view,
            "save_calendar_goal",
            json!({"id":null,"title":"valid child","targetValue":1.0,
        "unit":"","deadline":null,"goalKind":"goal","description":"","criteria":"",
        "parentGoalId":"goal-b","clearParent":false,"currentValue":null})
        )
        .unwrap()
        .is_string(),
        true
    );
    let state = app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT parent_goal_id FROM calendar_goals WHERE id='child'",
            [],
            |r| r.get::<_, Option<String>>(0)
        )
        .unwrap(),
        None
    );
}

#[test]
fn failed_daily_norm_conversion_rolls_back_parent_and_children_then_allows_retry() {
    let (app, view) = fixture();
    let before = {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        seed_goal_tree(&conn);
        conn.execute_batch("CREATE TRIGGER reject_daily_child_promotion BEFORE UPDATE ON calendar_goals WHEN OLD.id='child' AND NEW.parent_goal_id IS NULL BEGIN SELECT RAISE(ABORT,'injected child promotion failure'); END;").unwrap();
        mutation_snapshot(&conn)
    };
    let error = convert_goal_to_daily_norm(&view, "goal-a").unwrap_err();
    assert!(error
        .as_str()
        .unwrap()
        .contains("injected child promotion failure"));
    assert_eq!(
        mutation_snapshot(&app.state::<AppState>().0.lock().unwrap()),
        before
    );
    {
        let state = app.state::<AppState>();
        state
            .0
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_daily_child_promotion;")
            .unwrap();
    }
    convert_goal_to_daily_norm(&view, "goal-a").unwrap();
    assert!(app.state::<AppState>().0.lock().unwrap().is_autocommit());
}

#[test]
fn deleted_goal_rejects_stale_save_while_valid_create_and_edit_succeed() {
    let (app, view) = fixture();
    let id = save_goal(&view, Value::Null, "Original", "goal").unwrap();
    save_goal(&view, id.clone(), "Edited", "goal").unwrap();
    call(&view, "delete_goal", json!({"id":id.clone()})).unwrap();
    let after_delete = mutation_snapshot(&app.state::<AppState>().0.lock().unwrap());
    assert!(save_goal(&view, id, "Stale", "goal").is_err());
    assert_eq!(
        mutation_snapshot(&app.state::<AppState>().0.lock().unwrap()),
        after_delete
    );
    let created = save_goal(&view, Value::Null, "Created", "goal").unwrap();
    assert_ne!(created, Value::Null);
}

#[test]
fn invalid_note_create_status_leaves_database_unchanged() {
    let (app, view) = fixture();
    let before = mutation_snapshot(&app.state::<AppState>().0.lock().unwrap());
    for status in [
        "unknown",
        "",
        " note ",
        "Done",
        "task'; DELETE FROM items; --",
    ] {
        let result = call(
            &view,
            "create_note",
            json!({"title":"Example note",
            "content":"Example content","tags":"","status":status,"dueDate":null,"priority":0}),
        );
        assert!(result.is_err(), "unsupported status {status:?} must fail");
        assert_eq!(
            mutation_snapshot(&app.state::<AppState>().0.lock().unwrap()),
            before
        );
    }
}

#[test]
fn invalid_note_update_status_leaves_database_unchanged() {
    let (app, view) = fixture();
    mutation_fixture_sql(&app.state::<AppState>().0.lock().unwrap());
    let before = mutation_snapshot(&app.state::<AppState>().0.lock().unwrap());
    for status in ["unknown", "", " task ", "Done"] {
        assert!(call(
            &view,
            "update_note_status",
            json!({"id":"task-a","status":status})
        )
        .is_err());
        assert_eq!(
            mutation_snapshot(&app.state::<AppState>().0.lock().unwrap()),
            before
        );
    }
}

#[test]
fn invalid_category_reassignment_leaves_database_unchanged() {
    let (app, view) = fixture();
    mutation_fixture_sql(&app.state::<AppState>().0.lock().unwrap());
    let before = mutation_snapshot(&app.state::<AppState>().0.lock().unwrap());
    for target in ["missing", "", "Example A", "category-b"] {
        assert!(
            call(
                &view,
                "delete_event_category",
                json!({"id":"category-a","reassignTo":target})
            )
            .is_err(),
            "invalid target {target:?} must fail (target uses a name, not an id)"
        );
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        assert_eq!(mutation_snapshot(&conn), before);
        assert!(conn.is_autocommit());
    }
    assert!(call(
        &view,
        "delete_event_category",
        json!({"id":"general","reassignTo":null})
    )
    .is_err());
    assert_eq!(
        mutation_snapshot(&app.state::<AppState>().0.lock().unwrap()),
        before
    );
    // A rejected request must not leave a transaction open or block a valid retry.
    assert_eq!(
        call(
            &view,
            "delete_event_category",
            json!({"id":"category-a","reassignTo":"Example B"})
        )
        .unwrap(),
        json!(1)
    );
    let state = app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM items WHERE kind='event' AND category='Example B'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
}

#[test]
fn supported_note_statuses_preserve_visibility_and_completion() {
    let (_app, view) = fixture();
    for (status, expected_status) in [
        (Value::Null, "note"),
        (json!("note"), "note"),
        (json!("task"), "task"),
        (json!("done"), "done"),
    ] {
        let id = call(
            &view,
            "create_note",
            json!({"title":"Example status","content":"Example body",
            "tags":"","status":status,"dueDate":null,"priority":0}),
        )
        .unwrap();
        let item = call(&view, "get_note", json!({"id":id})).unwrap();
        assert_eq!(item["status"], expected_status);
        assert_eq!(item["completed"], json!(expected_status == "done"));
        let notes = call(
            &view,
            "get_notes",
            json!({"filter":"tab:calendar","search":null}),
        )
        .unwrap();
        let tasks = call(
            &view,
            "get_calendar_tasks",
            json!({"includeCompleted":true}),
        )
        .unwrap();
        assert_eq!(
            notes.as_array().unwrap().iter().any(|n| n["id"] == id),
            expected_status == "note"
        );
        assert_eq!(
            tasks
                .as_array()
                .unwrap()
                .iter()
                .any(|n| n["source_id"] == id),
            expected_status != "note"
        );
    }
}

#[test]
fn supported_update_status_keeps_existing_completion_contract() {
    let (app, view) = fixture();
    mutation_fixture_sql(&app.state::<AppState>().0.lock().unwrap());
    for status in ["done", "task", "note"] {
        assert_eq!(
            call(
                &view,
                "update_note_status",
                json!({"id":"task-a","status":status})
            )
            .unwrap(),
            Value::Null
        );
        let item = call(&view, "get_note", json!({"id":"task-a"})).unwrap();
        assert_eq!(item["completed"], json!(status == "done"));
        // This compatibility command toggles completion; it does not move records between panes.
        assert_eq!(
            item["status"],
            if status == "done" { "done" } else { "task" }
        );
        assert_eq!(
            app.state::<AppState>()
                .0
                .lock()
                .unwrap()
                .query_row("SELECT status FROM items WHERE id='task-a'", [], |r| r
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            "task"
        );
    }
}

#[test]
fn atomic_category_rename_rolls_back_and_allows_retry_over_ipc() {
    assert_atomic_rollback(
        "update_event_category",
        json!({"id":"category-a","name":"Renamed","color":"#112233","icon":"R"}),
        "items",
        "UPDATE",
        Value::Null,
    );
}

#[test]
fn atomic_category_delete_rolls_back_and_allows_retry_over_ipc() {
    assert_atomic_rollback(
        "delete_event_category",
        json!({"id":"category-a","reassignTo":"Example B"}),
        "event_categories",
        "DELETE",
        json!(1),
    );
}

#[test]
fn atomic_goal_delete_rolls_back_and_allows_retry_over_ipc() {
    assert_atomic_rollback(
        "delete_goal",
        json!({"id":"goal-a"}),
        "calendar_goals",
        "DELETE",
        Value::Null,
    );
}

fn assert_atomic_rollback(
    command: &str,
    args: Value,
    trigger_table: &str,
    trigger_operation: &str,
    expected: Value,
) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.db");
    let (app, view) = fixture_with_connection(Connection::open(&path).unwrap());
    let before = {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        mutation_fixture_sql(&conn);
        conn.execute_batch(&format!(
            "CREATE TRIGGER reject_mutation BEFORE {trigger_operation} ON {trigger_table}
                 BEGIN SELECT RAISE(ABORT, 'injected mutation failure'); END;"
        ))
        .unwrap();
        mutation_snapshot(&conn)
    };
    let error = call(&view, command, args.clone()).unwrap_err();
    assert!(
        error
            .as_str()
            .unwrap()
            .contains("injected mutation failure"),
        "{command}: {error}"
    );
    // A fresh SQLite connection must see no partial writes, not just the caller's state.
    let observer = Connection::open(&path).unwrap();
    assert_eq!(
        mutation_snapshot(&observer),
        before,
        "{command} must roll back all changes"
    );
    observer
        .execute_batch("DROP TRIGGER reject_mutation")
        .unwrap();
    assert_eq!(call(&view, command, args).unwrap(), expected);
    assert_ne!(
        mutation_snapshot(&observer),
        before,
        "{command} retry must commit"
    );
    let state = app.state::<AppState>();
    assert!(
        state.0.lock().unwrap().is_autocommit(),
        "{command} left an open transaction"
    );
}

#[test]
fn atomic_category_success_preserves_cascade_counts_and_unrelated_records() {
    let (app, view) = fixture();
    {
        let state = app.state::<AppState>();
        mutation_fixture_sql(&state.0.lock().unwrap());
    }
    call(
        &view,
        "update_event_category",
        json!({"id":"category-a","name":" Renamed ","color":"#112233","icon":"R"}),
    )
    .unwrap();
    // Metadata-only edits must remain supported and must not rename event categories.
    call(
        &view,
        "update_event_category",
        json!({"id":"category-a","name":null,"color":"#abcdef","icon":null}),
    )
    .unwrap();
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        let category: (String, String, String) = conn
            .query_row(
                "SELECT name,color,icon FROM event_categories WHERE id='category-a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(category, ("Renamed".into(), "#abcdef".into(), "R".into()));
        assert_eq!(
            conn.query_row("SELECT category FROM items WHERE id='event-a'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "Renamed"
        );
    }
    // The default target is a category name, whereas the deleted category uses its id.
    assert_eq!(
        call(
            &view,
            "delete_event_category",
            json!({"id":"category-a","reassignTo":null})
        )
        .unwrap(),
        json!(1)
    );
    assert_eq!(
        call(
            &view,
            "delete_event_category",
            json!({"id":"category-b","reassignTo":"general"})
        )
        .unwrap(),
        json!(1)
    );
    let state = app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM items WHERE kind='event' AND category='general'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row("SELECT category FROM items WHERE id='task-a'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "task"
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM event_categories WHERE id IN ('category-a','category-b')",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM calendar_task_goals", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn renaming_event_category_skips_tasks_and_invalidates_stale_event_save() {
    let (app, view) = fixture();
    {
        let state = app.state::<AppState>();
        category_cascade_fixture_sql(&state.0.lock().unwrap());
    }
    call(
        &view,
        "update_event_category",
        json!({"id":"category-a","name":"Renamed","color":null,"icon":null}),
    )
    .unwrap();
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        assert_eq!(category_revision(&conn, "event-a").0, "Renamed");
        assert_eq!(category_revision(&conn, "event-a").1, 2);
        assert_ne!(category_revision(&conn, "event-a").2, "test");
        for id in [
            "task-matching-category",
            "note-matching-category",
            "task-a",
            "event-b",
        ] {
            let expected = if id == "task-a" { "task" } else { "Example A" };
            let updated_at = if id == "task-a" { "test" } else { "original" };
            if id == "event-b" {
                assert_eq!(
                    category_revision(&conn, id),
                    ("Example B".into(), 1, "test".into())
                );
            } else {
                assert_eq!(
                    category_revision(&conn, id),
                    (expected.into(), 1, updated_at.into())
                );
            }
        }
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM timeline_blocks WHERE source_type='event'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
    }
    assert!(call(
        &view,
        "update_event",
        json!({"id":"event-a","title":"Stale","date":"2026-09-13","expectedVersion":1})
    )
    .is_err());
    call(
        &view,
        "update_event",
        json!({"id":"event-a","title":"Fresh","date":"2026-09-13","category":"Renamed","expectedVersion":2}),
    )
    .unwrap();
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        assert_eq!(category_revision(&conn, "event-a").0, "Renamed");
        assert_eq!(category_revision(&conn, "event-a").1, 3);
    }
    // Repeating the same name and metadata-only edits must not make an open event stale.
    call(
        &view,
        "update_event_category",
        json!({"id":"category-a","name":" Renamed ","color":null,"icon":null}),
    )
    .unwrap();
    call(
        &view,
        "update_event_category",
        json!({"id":"category-a","name":null,"color":"#abcdef","icon":null}),
    )
    .unwrap();
    let state = app.state::<AppState>();
    assert_eq!(category_revision(&state.0.lock().unwrap(), "event-a").1, 3);
}

#[test]
fn deleting_event_category_skips_tasks_and_invalidates_stale_event_save() {
    let (app, view) = fixture();
    {
        let state = app.state::<AppState>();
        category_cascade_fixture_sql(&state.0.lock().unwrap());
    }
    assert_eq!(
        call(
            &view,
            "delete_event_category",
            json!({"id":"category-a","reassignTo":"Example B"})
        )
        .unwrap(),
        json!(1)
    );
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        assert_eq!(category_revision(&conn, "event-a").0, "Example B");
        assert_eq!(category_revision(&conn, "event-a").1, 2);
        assert_ne!(category_revision(&conn, "event-a").2, "test");
        assert_eq!(
            category_revision(&conn, "event-b"),
            ("Example B".into(), 1, "test".into())
        );
        for id in ["task-matching-category", "note-matching-category"] {
            assert_eq!(
                category_revision(&conn, id),
                ("Example A".into(), 1, "original".into())
            );
        }
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM timeline_blocks WHERE source_type='event'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
    }
    assert!(call(
        &view,
        "update_event",
        json!({"id":"event-a","title":"Stale","date":"2026-09-13","expectedVersion":1})
    )
    .is_err());
    call(
        &view,
        "update_event",
        json!({"id":"event-a","title":"Fresh","date":"2026-09-13","category":"Example B","expectedVersion":2}),
    )
    .unwrap();
    let state = app.state::<AppState>();
    assert_eq!(category_revision(&state.0.lock().unwrap(), "event-a").1, 3);
}

#[test]
fn atomic_goal_delete_preserves_tasks_and_other_goal_links() {
    let (app, view) = fixture();
    let before_items = {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        mutation_fixture_sql(&conn);
        mutation_snapshot(&conn)[0].clone()
    };
    assert_eq!(
        call(&view, "delete_goal", json!({"id":"goal-a"})).unwrap(),
        Value::Null
    );
    // Deleting an already removed goal keeps the existing idempotent contract.
    assert_eq!(
        call(&view, "delete_goal", json!({"id":"goal-a"})).unwrap(),
        Value::Null
    );
    let state = app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    assert_eq!(mutation_snapshot(&conn)[0], before_items);
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM calendar_goals WHERE id='goal-a'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM calendar_task_goals WHERE goal_id='goal-a'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT goal_id FROM calendar_task_goals WHERE source_id='event-b'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "goal-b"
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM calendar_goals WHERE id='goal-b'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn original_goal_task_and_event_forms_round_trip_over_ipc() {
    let (_app, view) = fixture();
    let parent = goal(&view, "Example parent", Value::Null);
    let child = goal(&view, "Example child", parent.clone());
    assert!(parent.as_str().unwrap().len() > 20);
    let task = call(
        &view,
        "save_calendar_task",
        json!({"id":null,"title":"Example task",
        "dueDate":"2026-09-11","estimateMinutes":45,"goalId":child,"expectedVersion":null}),
    )
    .unwrap();
    let item = call(&view, "get_calendar_task", json!({"id":task})).unwrap();
    assert_eq!(item["duration_minutes"], 45);
    assert_eq!(item["goal_id"], child);
    call(
        &view,
        "save_calendar_task",
        json!({"id":task,"title":"Edited task",
        "dueDate":null,"estimateMinutes":20,"goalId":null,"expectedVersion":item["version"]}),
    )
    .unwrap();
    let item = call(&view, "get_calendar_task", json!({"id":task})).unwrap();
    assert!(item["date"].is_null());
    assert!(item["goal_id"].is_null());
    assert_eq!(item["duration_minutes"], 20);
    let goals = call(&view, "get_goals", json!({"tabName":null})).unwrap();
    assert_eq!(
        goals
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == child)
            .unwrap()["parent_goal_id"],
        parent
    );
    let event = call(
        &view,
        "create_event",
        json!({"title":"Example event","description":"Context",
        "date":"2026-09-11","time":"10:30","durationMinutes":60,"category":"general",
        "color":"#9B9B9B","priority":1,"linkedTab":""}),
    )
    .unwrap();
    call(
        &view,
        "set_calendar_task_goal",
        json!({"sourceType":"event","sourceId":event,"goalId":child}),
    )
    .unwrap();
    let events = call(&view, "get_all_events", json!({})).unwrap();
    assert_eq!(events[0]["id"], event);
    assert_eq!(events[0]["description"], "Context");
    assert_eq!(events[0]["time"], "10:30");
    call(&view, "delete_event", json!({"id":event})).unwrap();
    assert_eq!(call(&view, "get_all_events", json!({})).unwrap(), json!([]));
}

#[test]
fn event_delete_removes_only_its_link_and_preserves_closed_history() {
    let (app, view) = fixture();
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        mutation_fixture_sql(&conn);
        conn.execute_batch(
            "INSERT INTO calendar_task_goals(source_type,source_id,goal_id,created_at) VALUES
                ('event','event-a','goal-a','fixture');
            INSERT INTO timeline_blocks(source_type,source_id,date,start_time,duration_minutes,is_active,created_at,updated_at) VALUES
                ('event','event-a','2026-09-12','10:00',12,0,'fixture','fixture'),
                ('note','task-a','2026-09-12','10:00',7,0,'fixture','fixture');",
        )
        .unwrap();
    }
    call(&view, "delete_event", json!({"id":"event-a"})).unwrap();
    let state = app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    for sql in [
        "SELECT COUNT(*) FROM items WHERE id='event-a'",
        "SELECT COUNT(*) FROM calendar_task_goals WHERE source_type='event' AND source_id='event-a'",
    ] {
        assert_eq!(conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
    assert_eq!(
        conn.query_row("SELECT goal_id FROM calendar_task_goals WHERE source_type='event' AND source_id='event-b'", [], |r| r.get::<_, String>(0)).unwrap(),
        "goal-b"
    );
    assert_eq!(
        conn.query_row("SELECT goal_id FROM calendar_task_goals WHERE source_type='note' AND source_id='task-a'", [], |r| r.get::<_, String>(0)).unwrap(),
        "goal-a"
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM timeline_blocks WHERE source_type='event' AND source_id='event-a' AND is_active=0", [], |r| r.get::<_, i64>(0)).unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM timeline_blocks WHERE source_type='note' AND source_id='task-a'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn event_delete_rolls_back_links_when_missing_or_source_delete_fails() {
    let (app, view) = fixture();
    let before = {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        mutation_fixture_sql(&conn);
        conn.execute_batch("INSERT INTO calendar_task_goals(source_type,source_id,goal_id,created_at) VALUES('event','event-a','goal-a','fixture')").unwrap();
        mutation_snapshot(&conn)
    };
    assert!(call(&view, "delete_event", json!({"id":"missing-event"})).is_err());
    assert_eq!(
        mutation_snapshot(&app.state::<AppState>().0.lock().unwrap()),
        before
    );
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        conn.execute_batch("CREATE TRIGGER reject_event_delete BEFORE DELETE ON items WHEN OLD.id='event-a' BEGIN SELECT RAISE(ABORT,'injected event delete failure'); END;").unwrap();
    }
    let error = call(&view, "delete_event", json!({"id":"event-a"})).unwrap_err();
    assert!(error
        .as_str()
        .unwrap()
        .contains("injected event delete failure"));
    assert_eq!(
        mutation_snapshot(&app.state::<AppState>().0.lock().unwrap()),
        before
    );
    assert!(app.state::<AppState>().0.lock().unwrap().is_autocommit());
}

#[test]
fn active_event_delete_rejects_then_paused_event_deletes_with_history() {
    let (app, view) = fixture();
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        mutation_fixture_sql(&conn);
        conn.execute_batch("INSERT INTO calendar_task_goals(source_type,source_id,goal_id,created_at) VALUES('event','event-a','goal-a','fixture')").unwrap();
    }
    let block = call(
        &view,
        "start_task_block",
        json!({"sourceType":"event","sourceId":"event-a","failIfActive":true}),
    )
    .unwrap();
    let before_rejection = mutation_snapshot(&app.state::<AppState>().0.lock().unwrap());
    let error = call(&view, "delete_event", json!({"id":"event-a"})).unwrap_err();
    assert!(error.as_str().unwrap().contains("active timer"));
    assert_eq!(
        mutation_snapshot(&app.state::<AppState>().0.lock().unwrap()),
        before_rejection
    );
    call(&view, "pause_task_block", json!({"blockId":block})).unwrap();
    call(&view, "delete_event", json!({"id":"event-a"})).unwrap();
    let state = app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM items WHERE id='event-a'", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM calendar_task_goals WHERE source_type='event' AND source_id='event-a'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM timeline_blocks WHERE id=?1 AND is_active=0",
            [block.as_i64().unwrap()],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
#[test]
fn original_note_form_saves_archives_and_restores_without_creating_a_task() {
    let (_app, view) = fixture();
    let id = call(&view, "create_note", json!({"title":"Example note","content":"Original text",
        "tags":"","tabName":"calendar","status":"note","dueDate":null,"reminderAt":null,"priority":null})).unwrap();
    let note = call(&view, "get_note", json!({"id":id})).unwrap();
    assert_eq!(note["status"], "note");
    assert_eq!(note["tab_name"], "calendar");
    assert_eq!(
        call(
            &view,
            "get_calendar_tasks",
            json!({"includeCompleted":true})
        )
        .unwrap(),
        json!([])
    );
    assert_eq!(
        call(
            &view,
            "get_calendar_records",
            json!({"start":"2026-09-01","end":"2026-09-30"})
        )
        .unwrap(),
        json!([])
    );
    call(
        &view,
        "update_note",
        json!({"id":id,"title":"Edited note","content":"Saved text","tags":"",
        "pinned":null,"archived":null,"tabName":null,"status":null,"dueDate":null,"reminderAt":null,
        "contentBlocks":"{\"blocks\":[]}","priority":null,"expectedVersion":note["version"]}),
    )
    .unwrap();
    assert_eq!(
        call(&view, "get_note", json!({"id":id})).unwrap()["content"],
        "Saved text"
    );
    assert_eq!(
        call(&view, "toggle_note_archive", json!({"id":id})).unwrap(),
        true
    );
    let archived = call(&view, "get_notes", json!({"filter":null,"search":null})).unwrap();
    assert!(archived
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x["id"] == id && x["archived"] == true));
    assert_eq!(
        call(&view, "toggle_note_archive", json!({"id":id})).unwrap(),
        false
    );
    assert_eq!(
        call(&view, "get_note", json!({"id":id})).unwrap()["content"],
        "Saved text"
    );
}

#[test]
fn task_timer_rejects_closed_plain_and_archived_notes_but_keeps_open_task_and_event() {
    let (app, view) = fixture();
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        conn.execute_batch(
            "INSERT INTO items(id,kind,title,duration_minutes,completed,status,archived,version,created_at,updated_at) VALUES
                ('completed-task','task','Completed',30,1,'task',0,1,'fixture','fixture'),
                ('done-status-task','task','Done status',30,0,'done',0,1,'fixture','fixture'),
                ('plain-note','task','Plain note',30,0,'note',0,1,'fixture','fixture'),
                ('archived-task','task','Archived',30,0,'task',1,1,'fixture','fixture'),
                ('open-task','task','Open',30,0,'task',0,1,'fixture','fixture'),
                ('open-event','event','Event',30,0,'event',0,1,'fixture','fixture');",
        )
        .unwrap();
    }
    for id in [
        "completed-task",
        "done-status-task",
        "plain-note",
        "archived-task",
    ] {
        assert!(
            call(
                &view,
                "start_task_block",
                json!({"sourceType":"note","sourceId":id,"failIfActive":true}),
            )
            .is_err(),
            "{id} must not be startable"
        );
    }
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM timeline_blocks", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "rejected notes must not create timeline blocks"
        );
    }
    let task_block = call(
        &view,
        "start_task_block",
        json!({"sourceType":"note","sourceId":"open-task","failIfActive":true}),
    )
    .unwrap();
    assert!(task_block.is_i64());
    call(&view, "pause_task_block", json!({"blockId":task_block})).unwrap();
    let event_block = call(
        &view,
        "start_task_block",
        json!({"sourceType":"event","sourceId":"open-event","failIfActive":true}),
    )
    .unwrap();
    assert!(event_block.is_i64());
}
#[test]
fn dashboard_timer_uses_numeric_blocks_and_can_finish_a_paused_task() {
    let (_app, view) = fixture();
    let task = call(
        &view,
        "save_calendar_task",
        json!({"id":null,"title":"Timed task",
        "dueDate":null,"estimateMinutes":30,"goalId":null}),
    )
    .unwrap();
    let block = call(
        &view,
        "start_task_block",
        json!({"sourceType":"note","sourceId":task,
        "failIfActive":true,"completionDate":"2026-09-11"}),
    )
    .unwrap();
    assert!(block.is_i64());
    let active = call(&view, "get_active_block", json!({})).unwrap();
    assert_eq!(active["id"], block);
    let tasks = call(
        &view,
        "get_calendar_tasks",
        json!({"includeCompleted":true}),
    )
    .unwrap();
    assert_eq!(tasks[0]["is_active"], true);
    assert!(call(&view, "complete_calendar_task", json!({"id":task})).is_err());
    assert_eq!(
        active["date"],
        chrono::Local::now().format("%Y-%m-%d").to_string()
    );
    assert!(call(
        &view,
        "start_task_block",
        json!({"sourceType":"note","sourceId":task,"failIfActive":true})
    )
    .is_err());
    call(&view, "pause_task_block", json!({"blockId":block})).unwrap();
    let tasks = call(
        &view,
        "get_calendar_tasks",
        json!({"includeCompleted":true}),
    )
    .unwrap();
    assert_eq!(tasks[0]["is_active"], false);
    assert!(call(&view, "get_active_block", json!({}))
        .unwrap()
        .is_null());
    call(&view, "finish_task_block", json!({"blockId":block})).unwrap();
    assert_eq!(
        call(&view, "get_note", json!({"id":task})).unwrap()["status"],
        "done"
    );
}

#[test]
fn latest_task_block_restores_the_last_paused_source_without_copying_rows() {
    let (_app, view) = fixture();
    let task1 = call(&view, "save_calendar_task", json!({"id":null,"title":"First","dueDate":null,"estimateMinutes":10,"goalId":null})).unwrap();
    let task2 = call(&view, "save_calendar_task", json!({"id":null,"title":"Second","dueDate":null,"estimateMinutes":10,"goalId":null})).unwrap();
    let block1 = call(&view, "start_task_block", json!({"sourceType":"note","sourceId":task1,"failIfActive":true})).unwrap();
    call(&view, "pause_task_block", json!({"blockId":block1})).unwrap();
    let block2 = call(&view, "start_task_block", json!({"sourceType":"note","sourceId":task2,"failIfActive":true})).unwrap();
    call(&view, "pause_task_block", json!({"blockId":block2})).unwrap();
    let latest = call(&view, "get_latest_task_block", json!({})).unwrap();
    assert_eq!(latest["id"], block2);
    assert_eq!(latest["source_type"], "note");
    assert_eq!(latest["source_id"], task2);
    assert_eq!(latest["is_active"], false);
    assert!(call(&view, "get_active_block", json!({})).unwrap().is_null());
    let rows = call(&view, "get_timeline_blocks", json!({"date":latest["date"]})).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 2);
    assert!(rows.as_array().unwrap().iter().any(|row| row["id"] == block1));
    assert!(rows.as_array().unwrap().iter().any(|row| row["id"] == block2));
}

#[test]
fn recurring_activity_runtime_uses_one_step_source_and_rejects_stale_finish() {
    let (_app, view) = fixture();
    let recurring: Value = serde_json::from_str(include_str!("../../tests/fixtures/recurring-chain.json")).unwrap();
    call(&view, "set_ui_state", json!({"key":"calendar_recurring_v1","value":recurring.to_string()})).unwrap();
    let first = json!(["p","2026-09-20",0]).to_string();
    let second = json!(["p","2026-09-20",1]).to_string();
    assert!(call(&view, "start_task_block", json!({"sourceType":"schedule","sourceId":second,"failIfActive":true})).is_err());
    let block = call(&view, "start_task_block", json!({"sourceType":"schedule","sourceId":first,"failIfActive":true,"completionDate":"2026-09-20"})).unwrap();
    assert_eq!(call(&view, "start_task_block", json!({"sourceType":"schedule","sourceId":first,"failIfActive":true})).unwrap(), block);
    call(&view, "pause_task_block", json!({"blockId":block})).unwrap();
    call(&view, "finish_task_block", json!({"blockId":block})).unwrap();
    assert!(call(&view, "finish_task_block", json!({"blockId":block})).is_err());
    let schedules = call(&view, "get_schedules", json!({"category":null})).unwrap();
    let first_row = schedules.as_array().unwrap().iter().find(|row| row["source_id"] == first).unwrap();
    assert_eq!(first_row["title"], "Chain · First"); assert_eq!(first_row["status_extra"], "done"); assert_eq!(first_row["completed"], true);
    let second_block = call(&view, "start_task_block", json!({"sourceType":"schedule","sourceId":second,"failIfActive":true})).unwrap();
    call(&view, "skip_recurring_step", json!({"sourceId":second})).unwrap();
    assert!(call(&view, "finish_task_block", json!({"blockId":second_block})).is_err());
    let schedules = call(&view, "get_schedules", json!({})).unwrap();
    let second_row = schedules.as_array().unwrap().iter().find(|row| row["source_id"] == second).unwrap();
    assert_eq!(second_row["status_extra"], "skipped"); assert_eq!(second_row["completed"], true);
}

#[test]
fn recurring_step_can_be_skipped_before_start_without_creating_a_block() {
    let (_app, view) = fixture();
    let recurring: Value = serde_json::from_str(include_str!("../../tests/fixtures/recurring-activity.json")).unwrap();
    call(&view, "set_ui_state", json!({"key":"calendar_recurring_v1","value":recurring.to_string()})).unwrap();
    let source = json!(["p","2026-09-20",0]).to_string();
    call(&view, "skip_recurring_step", json!({"sourceId":source})).unwrap();
    assert!(call(&view, "start_task_block", json!({"sourceType":"schedule","sourceId":source})).is_err());
    let blocks = call(&view, "get_timeline_blocks", json!({"date":"2026-09-20"})).unwrap();
    assert!(blocks.as_array().unwrap().iter().all(|block| block["source_id"] != source));
}

#[test]
fn recurring_activity_resumes_and_cannot_finish_an_obsolete_block() {
    let (_app, view) = fixture();
    let recurring: Value = serde_json::from_str(include_str!("../../tests/fixtures/recurring-activity.json")).unwrap();
    call(&view, "set_ui_state", json!({"key":"calendar_recurring_v1","value":recurring.to_string()})).unwrap();
    let source = json!(["p","2026-09-20",0]).to_string();
    let first=call(&view,"start_task_block",json!({"sourceType":"schedule","sourceId":source})).unwrap();
    call(&view,"pause_task_block",json!({"blockId":first})).unwrap();
    let second=call(&view,"start_task_block",json!({"sourceType":"schedule","sourceId":source})).unwrap();
    assert_ne!(first,second);
    assert!(call(&view,"finish_task_block",json!({"blockId":first})).is_err());
    call(&view,"pause_task_block",json!({"blockId":second})).unwrap();
    call(&view,"skip_recurring_step",json!({"sourceId":source})).unwrap();
    assert!(call(&view,"finish_task_block",json!({"blockId":second})).is_err());
    let row=call(&view,"get_schedules",json!({})).unwrap();
    assert_eq!(row[0]["status_extra"],"skipped");
}

#[test]
fn skipping_a_routine_never_stops_unrelated_work() {
    let (_app,view)=fixture();
    let recurring: Value=serde_json::from_str(include_str!("../../tests/fixtures/recurring-chain.json")).unwrap();
    call(&view,"set_ui_state",json!({"key":"calendar_recurring_v1","value":recurring.to_string()})).unwrap();
    let task=call(&view,"save_calendar_task",json!({"title":"Unrelated","id":null,"dueDate":null,"estimateMinutes":null,"goalId":null})).unwrap();
    let active=call(&view,"start_task_block",json!({"sourceType":"note","sourceId":task})).unwrap();
    // Parallel work (2026-09-24): the skip applies while unrelated work keeps running.
    let first=json!(["p","2026-09-20",0]).to_string();
    call(&view,"skip_recurring_step",json!({"sourceId":first})).unwrap();
    assert_eq!(call(&view,"get_active_block",json!({})).unwrap()["id"],active);
    let running=call(&view,"get_active_blocks",json!({})).unwrap();
    assert_eq!(running.as_array().unwrap().len(),1);
    assert_eq!(running[0]["id"],active);
    assert_eq!(running[0]["title"],"Unrelated");
    let rows=call(&view,"get_schedules",json!({})).unwrap();
    let step=|source:&str|rows.as_array().unwrap().iter().find(|row|row["source_id"]==source).unwrap()["status_extra"].clone();
    assert_eq!(step(&first),"skipped");
    assert_eq!(step(&json!(["p","2026-09-20",1]).to_string()),"pending");
}

#[test]
fn several_tasks_run_at_once_but_one_source_never_gets_two_running_blocks() {
    let (app, view) = fixture();
    let first = call(&view, "save_calendar_task", json!({"id":null,"title":"First parallel","dueDate":null,"estimateMinutes":null,"goalId":null})).unwrap();
    let second = call(&view, "save_calendar_task", json!({"id":null,"title":"Second parallel","dueDate":null,"estimateMinutes":null,"goalId":null})).unwrap();
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        conn.execute_batch("INSERT INTO items(id,kind,title,date,time,duration_minutes,completed,status,archived,version,created_at,updated_at) VALUES
            ('parallel-event','event','Parallel event','2026-09-24','10:00',30,0,'event',0,1,'fixture','fixture');").unwrap();
    }
    let event = json!("parallel-event");
    assert!(call(&view, "get_active_blocks", json!({})).unwrap().as_array().unwrap().is_empty());
    let block1 = call(&view, "start_task_block", json!({"sourceType":"note","sourceId":first})).unwrap();
    // A running task no longer blocks a different one, even for strict callers.
    let block2 = call(&view, "start_task_block", json!({"sourceType":"note","sourceId":second,"failIfActive":true})).unwrap();
    let block3 = call(&view, "start_task_block", json!({"sourceType":"event","sourceId":event,"failIfActive":true})).unwrap();
    assert_ne!(block1, block2);
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        for (block, stamp) in [(&block1, "2026-09-24T08:00:00+00:00"), (&block2, "2026-09-24T08:05:00+00:00"), (&block3, "2026-09-24T08:10:00+00:00")] {
            conn.execute("UPDATE timeline_blocks SET created_at=?1 WHERE id=?2", rusqlite::params![stamp, block.as_i64().unwrap()]).unwrap();
        }
    }
    let active = call(&view, "get_active_blocks", json!({})).unwrap();
    let ids: Vec<Value> = active.as_array().unwrap().iter().map(|row| row["id"].clone()).collect();
    assert_eq!(ids, vec![block3.clone(), block2.clone(), block1.clone()], "newest first");
    let titles: Vec<Value> = active.as_array().unwrap().iter().map(|row| row["title"].clone()).collect();
    assert_eq!(titles, vec![json!("Parallel event"), json!("Second parallel"), json!("First parallel")]);
    for row in active.as_array().unwrap() {
        for field in ["id", "source_type", "source_id", "date", "start_time", "completion_date", "title"] {
            assert!(row.get(field).is_some(), "{field} is part of the row");
        }
    }
    // The single-row command stays available and still answers with one running block.
    assert!(ids.contains(&call(&view, "get_active_block", json!({})).unwrap()["id"]));
    // Starting the same source again adopts its running block; a strict caller is refused.
    assert_eq!(call(&view, "start_task_block", json!({"sourceType":"note","sourceId":first})).unwrap(), block1);
    assert!(call(&view, "start_task_block", json!({"sourceType":"note","sourceId":first,"failIfActive":true})).is_err());
    assert_eq!(call(&view, "start_task_block", json!({"sourceType":"event","sourceId":event})).unwrap(), block3);
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM timeline_blocks", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
    }
    // Pausing and finishing act on one block only.
    call(&view, "pause_task_block", json!({"blockId":block2})).unwrap();
    call(&view, "finish_task_block", json!({"blockId":block3})).unwrap();
    let ids: Vec<Value> = call(&view, "get_active_blocks", json!({})).unwrap().as_array().unwrap().iter().map(|row| row["id"].clone()).collect();
    assert_eq!(ids, vec![block1.clone()]);
    let resumed = call(&view, "start_task_block", json!({"sourceType":"note","sourceId":second,"failIfActive":true})).unwrap();
    assert_ne!(resumed, block2, "resume opens a new segment");
    assert_eq!(call(&view, "get_active_blocks", json!({})).unwrap().as_array().unwrap().len(), 2);
    let state = app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    assert_eq!(conn.query_row("SELECT completed FROM items WHERE id='parallel-event'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn routine_step_starts_beside_running_work_but_never_twice() {
    let (_app, view) = fixture();
    let recurring: Value = serde_json::from_str(include_str!("../../tests/fixtures/recurring-chain.json")).unwrap();
    call(&view, "set_ui_state", json!({"key":"calendar_recurring_v1","value":recurring.to_string()})).unwrap();
    let task = call(&view, "save_calendar_task", json!({"id":null,"title":"Running task","dueDate":null,"estimateMinutes":null,"goalId":null})).unwrap();
    let note = call(&view, "start_task_block", json!({"sourceType":"note","sourceId":task,"failIfActive":true})).unwrap();
    let first = json!(["p","2026-09-20",0]).to_string();
    let step = call(&view, "start_task_block", json!({"sourceType":"schedule","sourceId":first,"failIfActive":true})).unwrap();
    assert_ne!(step, note);
    assert_eq!(call(&view, "start_task_block", json!({"sourceType":"schedule","sourceId":first,"failIfActive":true})).unwrap(), step);
    assert_eq!(call(&view, "start_task_block", json!({"sourceType":"schedule","sourceId":first})).unwrap(), step);
    let active = call(&view, "get_active_blocks", json!({})).unwrap();
    assert_eq!(active.as_array().unwrap().len(), 2);
    let routine = active.as_array().unwrap().iter().find(|row| row["source_type"] == "schedule").unwrap();
    assert_eq!(routine["id"], step);
    assert_eq!(routine["title"], "Chain · First");
    assert_eq!(routine["completion_date"], "2026-09-20");
    // Only the current step starts; finishing it leaves the unrelated task running.
    assert!(call(&view, "start_task_block", json!({"sourceType":"schedule","sourceId":json!(["p","2026-09-20",1]).to_string()})).is_err());
    call(&view, "finish_task_block", json!({"blockId":step})).unwrap();
    let ids: Vec<Value> = call(&view, "get_active_blocks", json!({})).unwrap().as_array().unwrap().iter().map(|row| row["id"].clone()).collect();
    assert_eq!(ids, vec![note]);
}

#[test]
fn stale_forms_and_missing_goals_cannot_overwrite_or_leave_phantom_tasks() {
    let (_app, view) = fixture();
    assert!(call(
        &view,
        "save_calendar_task",
        json!({"id":null,"title":"Missing goal",
        "dueDate":null,"estimateMinutes":30,"goalId":"missing-goal"})
    )
    .is_err());
    assert_eq!(
        call(
            &view,
            "get_calendar_tasks",
            json!({"includeCompleted":true})
        )
        .unwrap(),
        json!([])
    );
    let id = call(
        &view,
        "save_calendar_task",
        json!({"id":null,"title":"Task",
        "dueDate":null,"estimateMinutes":30,"goalId":null}),
    )
    .unwrap();
    call(
        &view,
        "save_calendar_task",
        json!({"id":id,"title":"New title",
        "dueDate":null,"estimateMinutes":30,"goalId":null,"expectedVersion":1}),
    )
    .unwrap();
    assert!(call(
        &view,
        "save_calendar_task",
        json!({"id":id,"title":"Stale title",
        "dueDate":null,"estimateMinutes":30,"goalId":null,"expectedVersion":1})
    )
    .is_err());
    let fresh = call(&view, "get_calendar_task", json!({"id":id})).unwrap();
    assert_eq!(fresh["title"], "New title");
    call(
        &view,
        "save_calendar_task",
        json!({"id":id,"title":"New title",
        "dueDate":null,"estimateMinutes":null,"goalId":null,"expectedVersion":fresh["version"]}),
    )
    .unwrap();
    assert!(
        call(&view, "get_calendar_task", json!({"id":id})).unwrap()["duration_minutes"].is_null()
    );
    call(&view, "complete_calendar_task", json!({"id":id})).unwrap();
    let done = call(&view, "get_calendar_task", json!({"id":id})).unwrap();
    call(
        &view,
        "save_calendar_task",
        json!({"id":id,"title":"Edited completed task",
        "dueDate":null,"estimateMinutes":30,"goalId":null,"expectedVersion":done["version"]}),
    )
    .unwrap();
    assert_eq!(
        call(&view, "get_calendar_task", json!({"id":id})).unwrap()["completed"],
        true
    );
    let parent = goal(&view, "Parent", Value::Null);
    let child = goal(&view, "Child", parent.clone());
    assert!(call(
        &view,
        "save_calendar_goal",
        json!({"id":parent,"title":"Parent","targetValue":1.0,
        "unit":"","deadline":null,"goalKind":"long_term","description":"","criteria":"",
        "parentGoalId":child,"clearParent":false,"currentValue":null})
    )
    .is_err());
}

#[test]
fn task_importance_survives_rescheduling_without_changing_execution() {
    let (_app, view) = fixture();
    let id = call(&view, "save_calendar_task", json!({
        "title":"Important task", "dueDate":"2026-09-20", "estimateMinutes":25,
        "important":true
    })).unwrap();
    let fresh = || call(&view, "get_calendar_task", json!({"id":id})).unwrap();
    assert_eq!(fresh()["priority"], 5);
    let block = call(&view, "start_task_block", json!({
        "sourceType":"note", "sourceId":id, "failIfActive":true
    })).unwrap();
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    let blocks = || call(&view, "get_timeline_blocks", json!({"date":day})).unwrap();
    let running = blocks();
    call(&view, "save_calendar_task", json!({
        "id":id, "title":"Important task", "dueDate":"2026-09-21",
        "estimateMinutes":25, "expectedVersion":fresh()["version"], "important":false
    })).unwrap();
    assert_eq!(fresh()["priority"], 0);
    assert_eq!(blocks(), running, "importance must not change the running block");
    call(&view, "pause_task_block", json!({"blockId":block})).unwrap();
    let paused = blocks();
    call(&view, "save_calendar_task", json!({
        "id":id, "title":"Important task", "dueDate":null,
        "estimateMinutes":25, "expectedVersion":fresh()["version"], "important":true
    })).unwrap();
    for date in [Value::Null, json!("2026-09-19"), json!("2026-09-22")] {
        call(&view, "save_calendar_task", json!({
            "id":id, "title":"Important task", "dueDate":date,
            "estimateMinutes":25, "expectedVersion":fresh()["version"]
        })).unwrap();
        assert_eq!(fresh()["priority"], 5, "date-only clients preserve importance");
        assert_eq!(fresh()["date"], date);
        assert_eq!(blocks(), paused, "editing a paused task must not resume it");
    }
    let tasks = call(&view, "get_calendar_tasks", json!({"includeCompleted":false})).unwrap();
    assert_eq!(tasks.as_array().unwrap().len(), 1, "same task identity, no copy");
    assert_eq!(tasks[0]["source_id"], id);
    call(&view, "complete_calendar_task", json!({"id":id})).unwrap();
    assert_eq!(fresh()["priority"], 5);
    assert!(call(&view, "get_calendar_tasks", json!({"includeCompleted":false}))
        .unwrap().as_array().unwrap().is_empty());
    call(&view, "delete_item", json!({"id":id,"expectedVersion":fresh()["version"]})).unwrap();
    assert!(call(&view, "save_calendar_task", json!({
        "id":id, "title":"Deleted task", "important":true
    })).is_err(), "a deleted important task cannot be recreated by a stale form");
}

#[test]
fn task_importance_preserves_legacy_values_and_rejects_stale_or_invalid_edits() {
    let (app, view) = fixture();
    let id = call(&view, "save_calendar_task", json!({"title":"Existing task"})).unwrap();
    assert_eq!(call(&view, "get_calendar_task", json!({"id":id})).unwrap()["priority"], 0);
    {
        let state = app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        conn.execute("UPDATE items SET priority=3 WHERE id=?1", [id.as_str().unwrap()]).unwrap();
    }
    call(&view, "save_calendar_task", json!({
        "id":id, "title":"Renamed task", "expectedVersion":1, "important":null
    })).unwrap();
    assert_eq!(call(&view, "get_calendar_task", json!({"id":id})).unwrap()["priority"], 3);
    call(&view, "save_calendar_task", json!({
        "id":id, "title":"Renamed task", "expectedVersion":2, "important":true
    })).unwrap();
    let before = call(&view, "get_calendar_task", json!({"id":id})).unwrap();
    for args in [
        json!({"id":id,"title":"Stale task","expectedVersion":2,"important":false}),
        json!({"id":id,"title":"Invalid task","expectedVersion":3,"important":"false"}),
        json!({"id":id,"title":"Invalid goal","expectedVersion":3,"important":false,"goalId":"missing"}),
    ] {
        assert!(call(&view, "save_calendar_task", args).is_err());
        assert_eq!(call(&view, "get_calendar_task", json!({"id":id})).unwrap(), before);
    }
}

#[test]
fn event_form_accepts_all_day_and_cross_midnight_and_rejects_stale_updates() {
    let (_app, view) = fixture();
    let id = call(
        &view,
        "create_event",
        json!({"title":"All day","description":"",
        "date":"2026-09-11","time":"","durationMinutes":0,"category":"general",
        "color":"#9B9B9B","priority":0}),
    )
    .unwrap();
    call(
        &view,
        "update_event",
        json!({"id":id,"title":"Overnight","time":"23:30",
        "durationMinutes":120,"expectedVersion":1}),
    )
    .unwrap();
    assert!(call(
        &view,
        "update_event",
        json!({"id":id,"title":"Stale","expectedVersion":1})
    )
    .is_err());
    let events = call(&view, "get_all_events", json!({})).unwrap();
    assert_eq!(events[0]["title"], "Overnight");
    assert_eq!(events[0]["duration_minutes"], 120);
    let following_day = call(
        &view,
        "get_calendar_records",
        json!({"start":"2026-09-12","end":"2026-09-12"}),
    )
    .unwrap();
    assert!(following_day
        .as_array()
        .unwrap()
        .iter()
        .any(|record| record["source_id"] == id));
    call(
        &view,
        "update_event",
        json!({"id":id,"durationMinutes":2880,"expectedVersion":2}),
    )
    .unwrap();
    assert!(call(
        &view,
        "create_event",
        json!({"title":"","description":"","date":"2026-09-11",
        "time":"10:00","durationMinutes":30,"category":"general","color":"#9B9B9B"})
    )
    .is_err());
}

#[test]
fn atomic_day_and_snapshot_cas_use_the_real_ipc_contract() {
    let (_app, webview) = fixture();
    let first = call(&webview, "start_calendar_day", json!({})).unwrap();
    assert_eq!(
        call(&webview, "start_calendar_day", json!({})).unwrap(),
        first
    );
    let raw = call(
        &webview,
        "get_ui_state",
        json!({"key":"calendar_day_start_v1"}),
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(raw.as_str().unwrap()).unwrap(),
        first
    );
    let key = "calendar_recurring_v1";
    let initial = "{\"version\":1,\"plans\":[],\"days\":{}}";
    call(
        &webview,
        "set_ui_state",
        json!({"key":key,"value":initial,"expectedValue":""}),
    )
    .unwrap();
    let error = call(
        &webview,
        "set_ui_state",
        json!({"key":key,"value":"{}","expectedValue":""}),
    )
    .unwrap_err();
    assert_eq!(error, "mvp_sync_stale_ui_state");
    assert_eq!(
        call(&webview, "get_ui_state", json!({"key":key})).unwrap(),
        initial
    );
}
