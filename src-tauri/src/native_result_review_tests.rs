use super::*;
use crate::{calendar_compat as api, init_schema};
use serde_json::{json, Value};
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
fn fixture(conn: Connection, enabled: bool) -> Fixture {
    fixture_routed(conn, enabled, false, false)
}
fn fixture_routed(conn: Connection, enabled: bool, isolated: bool, real_scope: bool) -> Fixture {
    init_schema(&conn).unwrap();
    let app = mock_builder()
        .manage(AppState(Mutex::new(conn)))
        .manage(if real_scope {
            Scope::from_isolated(isolated)
        } else if enabled {
            Scope::fixture()
        } else {
            Scope(false)
        })
        .invoke_handler(move |invoke| {
            let handler: fn(tauri::ipc::Invoke<MockRuntime>) -> bool = tauri::generate_handler![
                prototype_publish_task_result,
                read_task_result_review,
                enqueue_task_result_review,
                commit_task_result_review,
                recover_task_result_review,
                api::save_calendar_task,
                api::get_calendar_task,
                api::get_active_blocks,
                api::get_ui_state,
                api::set_ui_state,
                api::create_note,
                api::update_note_status,
                crate::delete_item
            ];
            crate::isolated_test::dispatch(isolated, invoke, handler)
        })
        .build(mock_context(noop_assets()))
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    Fixture { app, view }
}
fn call(f: &Fixture, command: &str, args: Value) -> Result<Value, Value> {
    get_ipc_response(
        &f.view,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}
fn task(f: &Fixture) -> String {
    call(f,"save_calendar_task",json!({"id":null,"title":"Synthetic review task","dueDate":null,"estimateMinutes":null,"goalId":null})).unwrap().as_str().unwrap().into()
}
fn publication(f: &Fixture, id: &str, op: &str, revision: i64, content: &str) -> Value {
    call(f,"prototype_publish_task_result",json!({"input":{"task_id":id,"operation_id":op,"expected_revision":revision,"content":content}})).unwrap()
}
fn decision(id: &str, action: &str, operation: &str, revision: i64, version: i64) -> Value {
    let mut value = json!({"operation_id":operation,"action":action,"task_id":id,"expected_revision":revision,"result_version":version});
    if action == "rework" {
        value["comment"] = json!("Synthetic correction")
    }
    value
}
fn queued(f: &Fixture, input: Value) -> Value {
    call(f, "enqueue_task_result_review", json!({"input":input})).unwrap()
}
fn applied(f: &Fixture, op: &str) -> Value {
    call(f, "commit_task_result_review", json!({"operationId":op})).unwrap()
}
fn read_back(f: &Fixture, id: &str) -> Value {
    call(f, "read_task_result_review", json!({"taskId":id})).unwrap()
}
fn code(value: Value, expected: &str) {
    assert_eq!(value["code"], expected);
    assert!(value["status"] == 409 || value["status"] == 403)
}

#[test]
fn actual_handlers_commit_reopen_readback_and_original_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.db");
    let id;
    let request;
    let receipt;
    {
        let f = fixture(Connection::open(&path).unwrap(), true);
        id = task(&f);
        publication(&f, &id, "publish-1", 1, "Synthetic immutable result");
        request = decision(&id, "rework", "decision-1", 2, 1);
        assert_eq!(queued(&f, request.clone())["kind"], "queued");
    }
    {
        let f = fixture(Connection::open(&path).unwrap(), true);
        let bundle = call(&f, "recover_task_result_review", json!({"taskId":id})).unwrap();
        assert_eq!(bundle["pending"][0]["request"], request);
        assert_eq!(bundle["pending"][0]["state"], "queued");
        receipt = applied(&f, "decision-1");
        assert_eq!(receipt["projection"]["taskId"], id);
        assert_eq!(receipt["projection"]["reviewState"], "awaiting_dispatch");
    }
    {
        let f = fixture(Connection::open(&path).unwrap(), true);
        assert_eq!(
            queued(&f, request),
            json!({"kind":"queued","operation_id":"decision-1"})
        );
        assert_eq!(applied(&f, "decision-1"), receipt);
        let bundle = read_back(&f, &id);
        assert_eq!(bundle["projection"]["taskRevision"], 3);
        assert_eq!(
            bundle["projection"]["history"][1]["comment"],
            "Synthetic correction"
        );
        assert!(call(&f, "get_active_blocks", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        let state = f.app.state::<AppState>();
        let conn = state.0.lock().unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM local_review_intents", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM items", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
#[test]
fn accept_updates_existing_native_task_with_no_timer() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    publication(&f, &id, "pub", 1, "Synthetic result");
    queued(&f, decision(&id, "accept", "accept", 2, 1));
    let receipt = applied(&f, "accept");
    assert_eq!(receipt["projection"]["reviewState"], "accepted");
    let task = call(&f, "get_calendar_task", json!({"id":id})).unwrap();
    assert_eq!(task["version"], 3);
    assert_eq!(task["completed"], true);
    assert_eq!(task["status"], "done");
    assert!(call(&f, "get_active_blocks", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn disabled_profile_rejects_before_review_migration() {
    let f = fixture(Connection::open_in_memory().unwrap(), false);
    let id = task(&f);
    code(
        call(&f, "read_task_result_review", json!({"taskId":id})).unwrap_err(),
        "review_prototype_disabled",
    );
    let state = f.app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name LIKE 'local_review_%'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
#[test]
fn newer_review_component_schema_rejects_without_downgrade() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    publication(&f, &id, "pub", 1, "Synthetic");
    {
        let s = f.app.state::<AppState>();
        s.0.lock()
            .unwrap()
            .execute("UPDATE local_review_meta SET version=2", [])
            .unwrap();
    }
    code(
        call(&f, "read_task_result_review", json!({"taskId":id})).unwrap_err(),
        "newer_review_schema",
    );
}
#[test]
fn old_synthetic_v1_migration_preserves_identity_values_and_native_version() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE items(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',date TEXT,time TEXT,duration_minutes INTEGER NOT NULL,completed INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);PRAGMA user_version=1;INSERT INTO items VALUES('synthetic-old-task','task','Synthetic old fixture','Original manual note',NULL,NULL,30,0,7,'2026-01-01','2026-01-01');").unwrap();
    let f = fixture(conn, true);
    let task = call(&f, "get_calendar_task", json!({"id":"synthetic-old-task"})).unwrap();
    assert_eq!(task["version"], 7);
    assert_eq!(task["content"], "Original manual note");
    publication(
        &f,
        "synthetic-old-task",
        "pub-old",
        7,
        "Separate synthetic AI result",
    );
    let s = f.app.state::<AppState>();
    let c = s.0.lock().unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(
        c.query_row(
            "SELECT notes FROM items WHERE id='synthetic-old-task'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "Original manual note"
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM items", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn result_versions_immutable_and_stale_result_guard() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    publication(&f, &id, "pub-1", 1, "Synthetic first");
    publication(&f, &id, "pub-2", 2, "Synthetic second");
    queued(&f, decision(&id, "accept", "stale", 3, 1));
    code(
        call(
            &f,
            "commit_task_result_review",
            json!({"operationId":"stale"}),
        )
        .unwrap_err(),
        "stale_result_version",
    );
    let s = f.app.state::<AppState>();
    let c = s.0.lock().unwrap();
    assert!(c
        .execute(
            "UPDATE local_review_results SET content='overwrite' WHERE task_id=?1",
            [&id]
        )
        .is_err());
    assert_eq!(
        c.query_row(
            "SELECT content FROM local_review_results WHERE task_id=?1 AND result_version=1",
            [&id],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "Synthetic first"
    );
}
#[test]
fn stale_native_version_conflict_persists_original_comment() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    publication(&f, &id, "pub", 1, "Synthetic");
    let original = decision(&id, "rework", "stale", 2, 1);
    queued(&f, original.clone());
    publication(&f, &id, "pub-new", 2, "New synthetic");
    code(
        call(
            &f,
            "commit_task_result_review",
            json!({"operationId":"stale"}),
        )
        .unwrap_err(),
        "native_task_version_conflict",
    );
    let bundle = read_back(&f, &id);
    assert_eq!(bundle["pending"][0]["request"], original);
    assert_eq!(bundle["pending"][0]["state"], "conflict");
    assert_eq!(bundle["projection"]["taskRevision"], 3);
}
#[test]
fn changed_payload_double_click_and_wrong_native_task_rejected() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    publication(&f, &id, "pub", 1, "Synthetic");
    let original = decision(&id, "rework", "review", 2, 1);
    queued(&f, original.clone());
    queued(&f, original.clone());
    let mut changed = original;
    changed["comment"] = json!("Other comment");
    code(
        call(&f, "enqueue_task_result_review", json!({"input":changed})).unwrap_err(),
        "local_operation_payload_conflict",
    );
    let receipt = applied(&f, "review");
    assert_eq!(applied(&f, "review"), receipt);
    let wrong = decision("missing-native-task", "accept", "wrong", 2, 1);
    assert_eq!(
        call(&f, "enqueue_task_result_review", json!({"input":wrong})).unwrap_err()["status"],
        404
    );
}
#[test]
fn atomic_rollback_all_review_cutpoints() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    publication(&f, &id, "pub", 1, "Synthetic");
    queued(&f, decision(&id, "rework", "review", 2, 1));
    let s = f.app.state::<AppState>();
    let mut c = s.0.lock().unwrap();
    for phase in [
        "after_intent_audit",
        "after_task",
        "after_receipt",
        "after_outbox_ack",
    ] {
        let err = apply_with_fault(&mut c, "review", |actual| {
            if actual == phase {
                Err(error(500, "synthetic_fault"))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert_eq!(err.code, "synthetic_fault");
        assert_eq!(native_version(&c, &id).unwrap(), 2);
        assert_eq!(
            c.query_row("SELECT count(*) FROM local_review_intents", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM local_review_audit", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            c.query_row(
                "SELECT state FROM local_review_outbox WHERE operation_id='review'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "queued"
        );
    }
    commit(&mut c, "review").unwrap();
    assert_eq!(native_version(&c, &id).unwrap(), 3);
}
#[test]
fn actual_native_delete_and_status_handlers_cannot_orphan_intent() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    publication(&f, &id, "pub", 1, "Synthetic");
    queued(&f, decision(&id, "rework", "review", 2, 1));
    applied(&f, "review");
    assert!(call(&f, "delete_item", json!({"id":id,"expectedVersion":3})).is_err());
    assert!(call(&f, "update_note_status", json!({"id":id,"status":"done"})).is_err());
    assert_eq!(
        read_back(&f, &id)["projection"]["reviewState"],
        "awaiting_dispatch"
    );
}
#[test]
fn concurrent_disk_connections_commit_one_receipt_and_intent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.db");
    let id;
    {
        let f = fixture(Connection::open(&path).unwrap(), true);
        id = task(&f);
        publication(&f, &id, "pub", 1, "Synthetic");
        queued(&f, decision(&id, "rework", "review", 2, 1));
    }
    let mut handles = vec![];
    for _ in 0..2 {
        let path = path.clone();
        handles.push(std::thread::spawn(move || {
            let mut c = Connection::open(path).unwrap();
            c.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
            commit(&mut c, "review").unwrap()
        }));
    }
    let a = handles.remove(0).join().unwrap();
    let b = handles.remove(0).join().unwrap();
    assert_eq!(a, b);
    let c = Connection::open(path).unwrap();
    assert_eq!(native_version(&c, &id).unwrap(), 3);
    assert_eq!(
        c.query_row("SELECT count(*) FROM local_review_intents", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn old_ack_receipt_does_not_replace_fresh_native_read() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    publication(&f, &id, "pub", 1, "Synthetic");
    queued(&f, decision(&id, "accept", "review", 2, 1));
    let old = applied(&f, "review");
    {
        let s = f.app.state::<AppState>();
        s.0.lock()
            .unwrap()
            .execute(
                "UPDATE items SET title='Synthetic updated title',version=version+1 WHERE id=?1",
                [&id],
            )
            .unwrap();
    }
    assert_eq!(applied(&f, "review"), old);
    assert_eq!(read_back(&f, &id)["projection"]["taskRevision"], 4);
}
#[test]
fn unknown_owner_fields_rejected_by_actual_command_deserializer() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    publication(&f, &id, "pub", 1, "Synthetic");
    let mut input = decision(&id, "accept", "review", 2, 1);
    input["owner"] = json!("not-a-principal");
    assert!(call(&f, "enqueue_task_result_review", json!({"input":input})).is_err());
}

/// Test process only: stdio carries requests to actual registered MockRuntime handlers.
/// No listener, native GUI, application-side subprocess or production path API.
#[test]
#[ignore]
fn stdio_bridge_worker() {
    use std::io::{BufRead, Write};
    let root = std::path::PathBuf::from(
        std::env::var_os("CICADA_REVIEW_SYNTHETIC_ROOT").expect("synthetic root"),
    );
    assert!(root.is_absolute() && root.is_dir());
    assert_eq!(
        std::fs::read_to_string(root.join("synthetic-review-fixture.txt")).unwrap(),
        "synthetic-only"
    );
    let f = fixture_routed(
        Connection::open(root.join("calendar.db")).unwrap(),
        true,
        true,
        true,
    );
    for line in std::io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if request["command"] == "__fixture_crash_review" {
            let phase = request["args"]["phase"].as_str().unwrap();
            let state = f.app.state::<AppState>();
            let mut conn = state.0.lock().unwrap();
            apply_with_fault(
                &mut conn,
                request["args"]["operationId"].as_str().unwrap(),
                |actual| {
                    if actual == phase {
                        std::process::exit(77)
                    }
                    Ok(())
                },
            )
            .unwrap();
            panic!("Unknown crash phase");
        }
        let response = match call(
            &f,
            request["command"].as_str().unwrap(),
            request["args"].clone(),
        ) {
            Ok(value) => json!({"seq":request["seq"],"result":value}),
            Err(value) => json!({"seq":request["seq"],"error":value}),
        };
        println!("REVIEW_IPC_JSON:{}", response);
        std::io::stdout().flush().unwrap();
    }
}

#[test]
fn competing_user_decisions_cannot_enqueue_two_unresolved_clicks() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    publication(&f, &id, "pub", 1, "Synthetic");
    queued(&f, decision(&id, "rework", "first", 2, 1));
    code(
        call(
            &f,
            "enqueue_task_result_review",
            json!({"input":decision(&id,"accept","second",2,1)}),
        )
        .unwrap_err(),
        "unresolved_review_operation",
    );
    applied(&f, "first");
    queued(&f, decision(&id, "accept", "after-first", 3, 1));
    code(
        call(
            &f,
            "commit_task_result_review",
            json!({"operationId":"after-first"}),
        )
        .unwrap_err(),
        "result_already_decided",
    );
    let bundle = read_back(&f, &id);
    assert_eq!(bundle["projection"]["taskRevision"], 3);
    assert_eq!(bundle["projection"]["history"].as_array().unwrap().len(), 2);
}
#[test]
fn decision_id_collision_with_publication_is_rejected_before_enqueue() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    publication(&f, &id, "already-used", 1, "Synthetic");
    code(
        call(
            &f,
            "enqueue_task_result_review",
            json!({"input":decision(&id,"accept","already-used",2,1)}),
        )
        .unwrap_err(),
        "operation_payload_conflict",
    );
    assert!(read_back(&f, &id)["pending"].as_array().unwrap().is_empty());
}
#[test]
fn additive_review_migration_preserves_device_local_manual_result() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    let key = format!("calendar_task_workflow_v1:cicada:note:{id}");
    let manual=json!({"version":1,"taskId":format!("cicada:note:{id}"),"steps":[],"result":"Synthetic manual result stays manual","run":null}).to_string();
    call(
        &f,
        "set_ui_state",
        json!({"key":key,"value":manual,"expectedValue":""}),
    )
    .unwrap();
    publication(&f, &id, "pub", 1, "Separate synthetic immutable result");
    assert_eq!(
        call(&f, "get_ui_state", json!({"key":key})).unwrap(),
        json!(manual)
    );
    assert_eq!(
        read_back(&f, &id)["projection"]["content"],
        "Separate synthetic immutable result"
    );
}

#[test]
fn scope_requires_explicit_feature_and_validated_isolated_profile() {
    assert!(!Scope::from_isolated(false).0);
    assert_eq!(
        Scope::from_isolated(true).0,
        cfg!(feature = "local-result-review-prototype")
    );
}
#[test]
fn native_appstate_connection_does_not_read_another_profile_task() {
    let a = fixture(Connection::open_in_memory().unwrap(), true);
    let b = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&a);
    publication(&a, &id, "publish", 1, "Synthetic profile A result");
    assert_eq!(
        call(&b, "read_task_result_review", json!({"taskId":id})).unwrap_err()["status"],
        404
    );
    assert_eq!(
        call(
            &b,
            "enqueue_task_result_review",
            json!({"input":decision(&id,"accept","foreign-profile",2,1)})
        )
        .unwrap_err()["status"],
        404
    );
    assert_eq!(read_back(&a, &id)["projection"]["taskRevision"], 2);
}

#[test]
fn accepting_result_preserves_existing_active_timer_completion_guard() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    publication(&f, &id, "pub", 1, "Synthetic");
    {
        let state = f.app.state::<AppState>();
        state.0.lock().unwrap().execute("INSERT INTO timeline_blocks(source_type,source_id,date,start_time,is_active,created_at,updated_at) VALUES('note',?1,'2026-01-01','10:00',1,'2026-01-01T10:00:00Z','2026-01-01T10:00:00Z')",[&id]).unwrap();
    }
    queued(&f, decision(&id, "accept", "accept-active", 2, 1));
    code(
        call(
            &f,
            "commit_task_result_review",
            json!({"operationId":"accept-active"}),
        )
        .unwrap_err(),
        "native_task_active",
    );
    assert_eq!(read_back(&f, &id)["projection"]["taskRevision"], 2);
    assert_eq!(
        read_back(&f, &id)["projection"]["reviewState"],
        "awaiting_review"
    );
    assert_eq!(
        call(&f, "get_active_blocks", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn result_publication_preserves_existing_readonly_import_identity_rule() {
    let f = fixture(Connection::open_in_memory().unwrap(), true);
    let id = task(&f);
    {
        let state = f.app.state::<AppState>();
        state
            .0
            .lock()
            .unwrap()
            .execute("UPDATE items SET id='hc-walk:fixture' WHERE id=?1", [&id])
            .unwrap();
    }
    code(call(&f,"prototype_publish_task_result",json!({"input":{"task_id":"hc-walk:fixture","operation_id":"publish-readonly","expected_revision":1,"content":"Synthetic forbidden publication"}})).unwrap_err(),"native_task_readonly");
    let state = f.app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM local_review_results", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT version FROM items WHERE id='hc-walk:fixture'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

// External InvokeRequest -> shared application dispatcher -> registered handler.
// Same dispatch function is used by real Wry in lib.rs, not a copied test predicate.
#[test]
fn outer_dispatch_default_deny_or_feature_allowed_all_five_review_commands() {
    let f = fixture_routed(Connection::open_in_memory().unwrap(), true, true, true);
    let id = task(&f);
    let request = decision(&id, "rework", "routed-review", 2, 1);
    let calls = [
        (
            "prototype_publish_task_result",
            json!({"input":{"operation_id":"routed-publish","task_id":id,"expected_revision":1,"content":"Synthetic routed result"}}),
        ),
        ("read_task_result_review", json!({"taskId":id})),
        ("enqueue_task_result_review", json!({"input":request})),
        (
            "commit_task_result_review",
            json!({"operationId":"routed-review"}),
        ),
        ("recover_task_result_review", json!({"taskId":id})),
    ];
    for (command, args) in calls {
        let response = call(&f, command, args);
        if cfg!(feature = "local-result-review-prototype") {
            assert!(response.is_ok(), "{command}: {response:?}");
        } else {
            assert_eq!(
                response.unwrap_err(),
                json!("isolated_test_integration_disabled"),
                "{command}"
            );
        }
    }
    let state = f.app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    if cfg!(feature = "local-result-review-prototype") {
        assert_eq!(
            conn.query_row("SELECT version FROM items WHERE id=?1", [&id], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM local_review_intents", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    } else {
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name LIKE 'local_review_%'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT version FROM items WHERE id=?1", [&id], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
#[test]
fn outer_dispatch_ordinary_profile_stays_disabled_with_feature_present_or_absent() {
    let f = fixture_routed(Connection::open_in_memory().unwrap(), false, false, true);
    let id = task(&f);
    for (command, args) in [
        (
            "prototype_publish_task_result",
            json!({"input":{"operation_id":"normal-pub","task_id":id,"expected_revision":1,"content":"Synthetic forbidden result"}}),
        ),
        ("read_task_result_review", json!({"taskId":id})),
        (
            "enqueue_task_result_review",
            json!({"input":decision(&id,"accept","normal-review",1,1)}),
        ),
        (
            "commit_task_result_review",
            json!({"operationId":"normal-review"}),
        ),
        ("recover_task_result_review", json!({"taskId":id})),
    ] {
        code(
            call(&f, command, args).unwrap_err(),
            "review_prototype_disabled",
        );
    }
    let state = f.app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name LIKE 'local_review_%'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
#[test]
fn outer_dispatch_preserves_external_integration_and_unknown_command_deny() {
    let f = fixture_routed(Connection::open_in_memory().unwrap(), true, true, true);
    for command in [
        "health_sleep_connect",
        "mvp_sync_now",
        "mvp_update_install",
        "open_url",
        "choose_data_source",
        "inspect_data_source",
        "future_command",
        "read_task_result_review_extra",
    ] {
        assert_eq!(
            call(&f, command, json!({})).unwrap_err(),
            json!("isolated_test_integration_disabled"),
            "{command}"
        );
    }
    assert!(crate::isolated_test::allowed("save_calendar_task"));
}
