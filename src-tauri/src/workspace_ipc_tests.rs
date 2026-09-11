//! Exercise the actual Tauri command deserializer and SQLite implementation.
//! MockRuntime creates no native window and is not live UI evidence.
use crate::{calendar_compat as api, init_schema, AppState};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::test::{
    get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
};

fn fixture() -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    let app = mock_builder()
        .manage(AppState(Mutex::new(conn)))
        .invoke_handler(tauri::generate_handler![
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
            api::get_active_block,
            api::get_timeline_blocks,
            api::get_calendar_task_minutes,
            api::get_ui_state,
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
            url: "http://tauri.localhost".parse().unwrap(),
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
        "unit":"","deadline":null,"goalKind":"long_term","description":"","criteria":"",
        "parentGoalId":parent,"clearParent":false,"currentValue":null}),
    )
    .unwrap()
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
    assert!(call(&view, "get_active_block", json!({}))
        .unwrap()
        .is_null());
    call(&view, "finish_task_block", json!({"blockId":block})).unwrap();
    assert_eq!(
        call(&view, "get_note", json!({"id":task})).unwrap()["status"],
        "done"
    );
}
