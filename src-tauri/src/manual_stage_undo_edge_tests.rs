use super::super::{edit as edit_text, initialize, undo};
use super::tests::{fixture, input, rows, undo_request};
use super::*;
use rusqlite::types::ValueRef;
use serde_json::{json, Value};

// Capture the native sync side effects as well as the task/Undo journal.
fn snapshot(conn: &Connection) -> Value {
    let mut tables = Vec::new();
    for table in [
        "items",
        "mvp_records",
        "sync_row_versions",
        "content_sync_dirty",
        "mvp_sync_meta",
        "manual_task_undo_receipts",
        "manual_text_undo_operations",
        "timeline_blocks",
        "calendar_task_goals",
        "ui_state",
    ] {
        let mut query = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
            .unwrap();
        let count = query.column_count();
        let data: Vec<Value> = query
            .query_map([], |row| {
                let cells = (0..count)
                    .map(|index| {
                        Ok(match row.get_ref(index)? {
                            ValueRef::Null => json!(["null"]),
                            ValueRef::Integer(value) => json!(["integer", value]),
                            ValueRef::Real(value) => json!(["real", value.to_bits().to_string()]),
                            ValueRef::Text(value) => json!(["text", value]),
                            ValueRef::Blob(value) => json!(["blob", value]),
                        })
                    })
                    .collect::<rusqlite::Result<Vec<Value>>>()?;
                Ok(json!(cells))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        tables.push(json!([table, data]));
    }
    json!(tables)
}

fn text_input(operation: &str, version: i64) -> super::super::EditInput {
    serde_json::from_value(json!({
        "id":"a", "operationId":operation, "expectedVersion":version,
        "edit":{
            "kind":"text",
            "title":"Synthetic text edit",
            "content":"Synthetic text payload",
            "contentBlocks":null
        }
    }))
    .unwrap()
}

#[test]
fn stage_receipt_and_replays_survive_restart_and_never_restore_over_newer_edit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic-stage-undo.db");
    let memory = fixture();
    initialize(&memory).unwrap();
    // Seed only this fixture; VACUUM preserves the owner and actual capture rows.
    memory
        .execute("VACUUM INTO ?1", [path.to_str().unwrap()])
        .unwrap();
    drop(memory);

    let mut conn = Connection::open(&path).unwrap();
    let request = input("edge-durable-stage", 1, "b");
    let saved = edit_stage(&mut conn, request.clone()).unwrap();
    assert_eq!(saved.task_revision, 2);
    assert!(saved.undo_receipt.is_some());
    let after_save = snapshot(&conn);
    drop(conn);

    let mut conn = Connection::open(&path).unwrap();
    assert_eq!(edit_stage(&mut conn, request.clone()).unwrap(), saved);
    assert_eq!(snapshot(&conn), after_save);
    let cancel = undo_request(&saved, 2);
    let undone = undo(&mut conn, cancel.clone()).unwrap();
    assert_eq!(undone.task_revision, 3);
    let after_undo = snapshot(&conn);
    drop(conn);

    let mut conn = Connection::open(&path).unwrap();
    assert_eq!(undo(&mut conn, cancel.clone()).unwrap(), undone);
    assert_eq!(edit_stage(&mut conn, request.clone()).unwrap(), saved);
    assert_eq!(snapshot(&conn), after_undo);
    let newer = edit_stage(&mut conn, input("edge-newer-stage", 3, "b")).unwrap();
    assert_eq!(newer.task_revision, 4);
    let after_newer = snapshot(&conn);
    drop(conn);

    let mut conn = Connection::open(&path).unwrap();
    assert_eq!(undo(&mut conn, cancel).unwrap(), undone);
    assert_eq!(edit_stage(&mut conn, request).unwrap(), saved);
    assert_eq!(snapshot(&conn), after_newer);
    let tags: String = conn
        .query_row("SELECT tags FROM items WHERE id='a'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(attributes::stage(&tags), Some("b"));
    assert_eq!(
        attributes::stage_log(&tags)
            .iter()
            .map(|(stage, _)| *stage)
            .collect::<Vec<_>>(),
        ["a", "b", "a", "b"]
    );
}

#[test]
fn text_and_stage_share_one_operation_namespace_in_both_directions() {
    for stage_first in [false, true] {
        let mut conn = fixture();
        initialize(&conn).unwrap();
        if stage_first {
            edit_stage(&mut conn, input("edge-shared-operation", 1, "b")).unwrap();
            let before = snapshot(&conn);
            assert_eq!(
                edit_text(&mut conn, text_input("edge-shared-operation", 2)).unwrap_err(),
                "undo_request_conflict"
            );
            assert_eq!(snapshot(&conn), before);
        } else {
            edit_text(&mut conn, text_input("edge-shared-operation", 1)).unwrap();
            let before = snapshot(&conn);
            assert_eq!(
                edit_stage(&mut conn, input("edge-shared-operation", 2, "b")).unwrap_err(),
                "undo_request_conflict"
            );
            assert_eq!(snapshot(&conn), before);
        }
        assert_eq!(rows(&conn, "manual_task_undo_receipts").len(), 1);
        assert_eq!(rows(&conn, "manual_text_undo_operations").len(), 1);
    }
}

#[test]
fn failed_stage_ack_insert_rolls_back_receipt_task_and_actual_capture() {
    let mut conn = fixture();
    initialize(&conn).unwrap();
    let before = snapshot(&conn);
    conn.execute_batch(
        "CREATE TRIGGER edge_reject_stage_ack
         BEFORE INSERT ON manual_text_undo_operations WHEN NEW.command='stage'
         BEGIN SELECT RAISE(ABORT,'synthetic stage ACK failure'); END;",
    )
    .unwrap();
    let request = input("edge-stage-ack-failure", 1, "b");
    assert_eq!(
        edit_stage(&mut conn, request.clone()).unwrap_err(),
        "undo_storage_failed"
    );
    assert_eq!(snapshot(&conn), before);
    conn.execute_batch("DROP TRIGGER edge_reject_stage_ack;")
        .unwrap();
    let saved = edit_stage(&mut conn, request).unwrap();
    assert_eq!(saved.task_revision, 2);
    assert_eq!(rows(&conn, "manual_task_undo_receipts").len(), 1);
    assert_eq!(rows(&conn, "manual_text_undo_operations").len(), 1);
}

#[test]
fn failed_stage_undo_consumption_or_ack_rolls_back_history_and_actual_capture() {
    for consumption in [false, true] {
        let mut conn = fixture();
        let saved = edit_stage(&mut conn, input("edge-stage-before-undo-fault", 1, "b")).unwrap();
        let before = snapshot(&conn);
        let trigger = if consumption {
            "CREATE TRIGGER edge_reject_stage_undo
             BEFORE UPDATE OF consumed ON manual_task_undo_receipts
             BEGIN SELECT RAISE(ABORT,'synthetic stage consumption failure'); END;"
        } else {
            "CREATE TRIGGER edge_reject_stage_undo
             BEFORE INSERT ON manual_text_undo_operations WHEN NEW.command='undo'
             BEGIN SELECT RAISE(ABORT,'synthetic stage Undo ACK failure'); END;"
        };
        conn.execute_batch(trigger).unwrap();
        let cancel = undo_request(&saved, 2);
        assert_eq!(
            undo(&mut conn, cancel.clone()).unwrap_err(),
            "undo_storage_failed"
        );
        assert_eq!(snapshot(&conn), before);
        conn.execute_batch("DROP TRIGGER edge_reject_stage_undo;")
            .unwrap();
        assert_eq!(undo(&mut conn, cancel).unwrap().task_revision, 3);
        let tags: String = conn
            .query_row("SELECT tags FROM items WHERE id='a'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            attributes::stage_log(&tags)
                .iter()
                .map(|(stage, _)| *stage)
                .collect::<Vec<_>>(),
            ["a", "b", "a"]
        );
    }
}

#[test]
fn stage_payload_rejects_waiting_process_inverse_and_owner_without_native_write() {
    let conn = fixture();
    initialize(&conn).unwrap();
    let before = snapshot(&conn);
    for (field, value) in [
        ("waiting", json!(true)),
        ("process", json!("other")),
        ("inverse", json!({"kind":"stage"})),
        ("owner", json!("synthetic-forged-owner")),
    ] {
        let mut payload = json!({
            "id":"a", "operationId":"edge-strict-stage", "expectedVersion":1, "stage":"b"
        });
        payload[field] = value;
        assert!(
            serde_json::from_value::<StageInput>(payload).is_err(),
            "stage payload must reject {field}"
        );
        assert_eq!(snapshot(&conn), before);
    }
}
