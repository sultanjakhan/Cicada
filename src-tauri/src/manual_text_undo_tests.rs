use super::*;
use crate::{calendar_compat as api, init_schema};
use std::sync::Mutex;
use tauri::{
    test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY},
    Manager,
};

struct Fixture {
    app: tauri::App<MockRuntime>,
    view: tauri::WebviewWindow<MockRuntime>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let state = self.app.state::<AppState>();
        let mut conn = state.0.lock().unwrap();
        let old = std::mem::replace(&mut *conn, Connection::open_in_memory().unwrap());
        old.close().unwrap();
    }
}
fn fixture(conn: Connection) -> Fixture {
    init_schema(&conn).unwrap();
    let app = mock_builder()
        .manage(AppState(Mutex::new(conn)))
        .invoke_handler(move |invoke| {
            let handler: fn(tauri::ipc::Invoke<MockRuntime>) -> bool = tauri::generate_handler![
                save_calendar_task_manual_edit,
                stage::save_calendar_task_manual_stage,
                undo_calendar_task_manual_edit,
                api::get_calendar_task,
                api::save_calendar_task,
                api::set_ui_state,
                api::get_active_blocks
            ];
            crate::isolated_test::dispatch(true, invoke, handler)
        })
        .build(mock_context(noop_assets()))
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    Fixture { app, view }
}
fn call(f: &Fixture, command: &str, args: Value) -> std::result::Result<Value, Value> {
    get_ipc_response(
        &f.view,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: f.view.url().unwrap(),
            body: tauri::ipc::InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}
fn seed(conn: &Connection) {
    init_schema(conn).unwrap();
    conn.execute("INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,priority,archived,tags,content_blocks,status) VALUES('manual-native-id','task','  old title  ','old\ntext','2026-10-08','12:34',25,0,1,'created','created','task','#123456',5,0,'task-sphere:personal,task-stage:doing,task-waiting:true,task-stage-log:fixture',NULL,'task')",[]).unwrap();
    conn.execute("INSERT INTO calendar_goals(id,title,target_value,current_value,created_at,updated_at) VALUES('goal-id','Synthetic goal',10,3,'created','created')",[]).unwrap();
    conn.execute("INSERT INTO calendar_task_goals(source_type,source_id,goal_id,created_at) VALUES('note','manual-native-id','goal-id','created')",[]).unwrap();
    conn.execute("INSERT INTO timeline_blocks(source_type,source_id,date,start_time,duration_minutes,duration_seconds,is_active,created_at,updated_at) VALUES('note','manual-native-id','2026-10-08','12:34',7,421,1,'created','created')",[]).unwrap();
    conn.execute("INSERT INTO ui_state(key,value,updated_at) VALUES('calendar_task_workflow_v1:cicada:note:manual-native-id','{\"result\":\"saved result\",\"steps\":[\"step-id\"]}','created')",[]).unwrap();
}
fn input(op: &str, revision: i64, title: &str, content: &str, blocks: Value) -> Value {
    json!({"input":{"id":"manual-native-id","operationId":op,"expectedVersion":revision,"edit":{"kind":"text","title":title,"content":content,"contentBlocks":blocks}}})
}
fn cancel(receipt: &Value, revision: i64) -> Value {
    json!({"input":{"receiptId":receipt,"expectedVersion":revision}})
}
fn stable(conn: &Connection) -> Value {
    let row: String = task(conn, "manual-native-id").unwrap().full;
    let mut row: Value = serde_json::from_str(&row).unwrap();
    for key in ["title", "notes", "content_blocks", "version", "updated_at"] {
        row.as_object_mut().unwrap().remove(key);
    }
    let mut tables = vec![row];
    for table in [
        "calendar_goals",
        "calendar_task_goals",
        "timeline_blocks",
        "ui_state",
    ] {
        let mut query = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
        let columns = query.column_count();
        let rows: Vec<Value> = query
            .query_map([], |r| {
                Ok(Value::Array(
                    (0..columns)
                        .map(|i| match r.get_ref(i).unwrap() {
                            ValueRef::Null => json!(null),
                            ValueRef::Integer(v) => json!(v),
                            ValueRef::Real(v) => json!(v),
                            ValueRef::Text(v) => json!(v),
                            ValueRef::Blob(v) => json!(v),
                        })
                        .collect(),
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        tables.push(json!(rows));
    }
    json!(tables)
}
fn observed(f: &Fixture) -> (String, String) {
    let state = f.app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    (
        task(&conn, "manual-native-id").unwrap().full,
        lineage(&conn, "manual-native-id").unwrap(),
    )
}
#[test]
fn native_save_restart_undo_retry_keeps_ids_history_results_and_timer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.db");
    let conn = Connection::open(&path).unwrap();
    seed(&conn);
    let before = stable(&conn);
    let f = fixture(conn);
    let request = input(
        "manual-save-1",
        1,
        " new title ",
        "new text",
        json!("{\"version\":1}"),
    );
    let ack = call(&f, "save_calendar_task_manual_edit", request.clone()).unwrap();
    assert_eq!(ack["taskId"], "manual-native-id");
    assert_eq!(ack["taskRevision"], 2);
    assert!(ack["undoReceipt"].is_string());
    let saved = observed(&f);
    drop(f);
    let f = fixture(Connection::open(&path).unwrap());
    assert_eq!(
        call(&f, "save_calendar_task_manual_edit", request.clone()).unwrap(),
        ack
    );
    assert_eq!(observed(&f), saved);
    let detail = call(&f, "get_calendar_task", json!({"id":"manual-native-id"})).unwrap();
    assert_eq!(detail["title"], "new title");
    assert_eq!(detail["content"], "new text");
    assert_eq!(detail["goal_id"], "goal-id");
    let undo_request = cancel(&ack["undoReceipt"], 2);
    let undone = call(&f, "undo_calendar_task_manual_edit", undo_request.clone()).unwrap();
    assert_eq!(undone["taskRevision"], 3);
    let restored = call(&f, "get_calendar_task", json!({"id":"manual-native-id"})).unwrap();
    assert_eq!(restored["title"], "  old title  ");
    assert_eq!(restored["content"], "old\ntext");
    assert!(restored["content_blocks"].is_null());
    let state = f.app.state::<AppState>();
    assert_eq!(stable(&state.0.lock().unwrap()), before);
    let after = observed(&f);
    drop(f);
    let f = fixture(Connection::open(&path).unwrap());
    assert_eq!(
        call(&f, "undo_calendar_task_manual_edit", undo_request.clone()).unwrap(),
        undone
    );
    assert_eq!(observed(&f), after);
    // A late exact retry acknowledges its own commit, never restores over newer text.
    call(
        &f,
        "save_calendar_task_manual_edit",
        input("manual-save-2", 3, "later", "later", json!(null)),
    )
    .unwrap();
    let later = observed(&f);
    assert_eq!(
        call(&f, "undo_calendar_task_manual_edit", undo_request).unwrap(),
        undone
    );
    assert_eq!(
        call(&f, "save_calendar_task_manual_edit", request).unwrap(),
        ack
    );
    assert_eq!(observed(&f), later);
    assert_eq!(
        call(
            &f,
            "undo_calendar_task_manual_edit",
            cancel(&ack["undoReceipt"], 4)
        )
        .unwrap_err(),
        json!("undo_request_conflict")
    );
}
#[test]
fn newer_native_generic_edit_blocks_first_undo_and_cannot_mint_receipts() {
    let conn = Connection::open_in_memory().unwrap();
    seed(&conn);
    let f = fixture(conn);
    let ack = call(
        &f,
        "save_calendar_task_manual_edit",
        input("edit-1", 1, "edited", "edited", json!(null)),
    )
    .unwrap();
    call(&f,"save_calendar_task",json!({"id":"manual-native-id","title":"generic newer","dueDate":"2026-10-08","estimateMinutes":25,"goalId":"goal-id","expectedVersion":2})).unwrap();
    let before = observed(&f);
    assert_eq!(
        call(
            &f,
            "undo_calendar_task_manual_edit",
            cancel(&ack["undoReceipt"], 2)
        )
        .unwrap_err(),
        json!("undo_revision_conflict")
    );
    assert_eq!(
        call(
            &f,
            "undo_calendar_task_manual_edit",
            cancel(&ack["undoReceipt"], 3)
        )
        .unwrap_err(),
        json!("undo_revision_conflict")
    );
    assert_eq!(observed(&f), before);
    let state = f.app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM manual_task_undo_receipts", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row("SELECT consumed FROM manual_task_undo_receipts", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
}
#[test]
fn noop_and_edited_request_retries_are_durable_and_do_not_write_native_state() {
    let conn = Connection::open_in_memory().unwrap();
    seed(&conn);
    let f = fixture(conn);
    // First normalize the existing title, then submit an actual no-op.
    call(
        &f,
        "save_calendar_task_manual_edit",
        input("normalize", 1, "old title", "old\ntext", json!(null)),
    )
    .unwrap();
    let before = observed(&f);
    let request = input("no-op", 2, " old title ", "old\ntext", json!(null));
    let ack = call(&f, "save_calendar_task_manual_edit", request.clone()).unwrap();
    assert_eq!(ack["taskRevision"], 2);
    assert!(ack["undoReceipt"].is_null());
    assert_eq!(
        call(&f, "save_calendar_task_manual_edit", request).unwrap(),
        ack
    );
    assert_eq!(observed(&f), before);
    assert_eq!(
        call(
            &f,
            "save_calendar_task_manual_edit",
            input("no-op", 2, "changed", "old\ntext", json!(null))
        )
        .unwrap_err(),
        json!("undo_request_conflict")
    );
    assert_eq!(observed(&f), before);
}
#[test]
fn native_payload_requires_full_text_and_rejects_stage_owner_inverse_and_invalid_blocks() {
    let conn = Connection::open_in_memory().unwrap();
    seed(&conn);
    let f = fixture(conn);
    let before = observed(&f);
    for (key, value) in [
        ("owner", json!("injected")),
        ("inverse", json!({})),
        ("stage", json!("doing")),
    ] {
        let mut request = input("bad", 1, "new", "new", json!(null));
        request["input"][key] = value;
        assert!(call(&f, "save_calendar_task_manual_edit", request).is_err());
    }
    let mut missing = input("missing", 1, "new", "new", json!(null));
    missing["input"]["edit"]
        .as_object_mut()
        .unwrap()
        .remove("contentBlocks");
    assert!(call(&f, "save_calendar_task_manual_edit", missing).is_err());
    let mut stage = input("stage", 1, "new", "new", json!(null));
    stage["input"]["edit"]["kind"] = json!("stage");
    assert!(call(&f, "save_calendar_task_manual_edit", stage).is_err());
    for blocks in [json!({}), json!("invalid-json")] {
        assert_eq!(
            call(
                &f,
                "save_calendar_task_manual_edit",
                input("bad-blocks", 1, "new", "new", blocks)
            )
            .unwrap_err(),
            json!("undo_invalid_blocks")
        );
    }
    assert_eq!(observed(&f), before);
}
#[test]
fn undo_of_second_edit_does_not_reenable_first_receipt() {
    let mut conn = Connection::open_in_memory().unwrap();
    seed(&conn);
    let a = edit(
        &mut conn,
        serde_json::from_value(input("a", 1, "a", "a", json!(null))["input"].clone()).unwrap(),
    )
    .unwrap();
    let b = edit(
        &mut conn,
        serde_json::from_value(input("b", 2, "b", "b", json!(null))["input"].clone()).unwrap(),
    )
    .unwrap();
    undo(
        &mut conn,
        UndoInput {
            receipt_id: b.undo_receipt.unwrap(),
            expected_version: 3,
        },
    )
    .unwrap();
    assert_eq!(task(&conn, "manual-native-id").unwrap().title, "a");
    assert_eq!(
        undo(
            &mut conn,
            UndoInput {
                receipt_id: a.undo_receipt.unwrap(),
                expected_version: 4
            }
        )
        .unwrap_err(),
        "undo_revision_conflict"
    );
}
// Process harness opens only a caller-marked fictional DB; no app startup, network or GUI.
#[test]
#[ignore]
fn stdio_bridge_worker() {
    use std::io::{BufRead, Write};
    let root = std::path::PathBuf::from(
        std::env::var_os("CICADA_MANUAL_UNDO_SYNTHETIC_ROOT").expect("synthetic fixture root"),
    );
    assert!(root.is_absolute());
    assert_eq!(
        std::fs::read_to_string(root.join("synthetic-manual-undo-fixture.txt")).unwrap(),
        "synthetic-only"
    );
    let f = fixture(Connection::open(root.join("calendar.db")).unwrap());
    for line in std::io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let response = match call(
            &f,
            request["command"].as_str().unwrap(),
            request["args"].clone(),
        ) {
            Ok(value) => json!({"seq":request["seq"],"result":value}),
            Err(error) => json!({"seq":request["seq"],"error":error}),
        };
        println!("MANUAL_UNDO_IPC_JSON:{response}");
        std::io::stdout().flush().unwrap();
    }
}
