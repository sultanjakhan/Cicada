use super::*;
use std::sync::{Arc, Barrier};
use std::time::Duration;

fn fixture(conn: Connection) -> (Connection, String) {
    crate::init_schema(&conn).unwrap();
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    let item = crate::calendar_compat::create_note_in_transaction(
        &conn,
        "Synthetic original",
        "Original\ntext",
        "task-sphere:personal",
        "task",
        &None,
        None,
    )
    .unwrap();
    initialize(&conn).unwrap();
    (conn, item.id)
}
fn memory() -> (Connection, String) {
    fixture(Connection::open_in_memory().unwrap())
}
fn request(id: &str, operation: &str, version: i64, title: &str) -> EditInput {
    serde_json::from_value(json!({
        "id":id,"operationId":operation,"expectedVersion":version,
        "edit":{"kind":"text","title":title,"content":"Edited text","contentBlocks":null}
    }))
    .unwrap()
}
fn saved(conn: &mut Connection, id: &str) -> Ack {
    edit(conn, request(id, "edge-save-original", 1, "Edited title")).unwrap()
}
fn undo_request(ack: &Ack) -> UndoInput {
    serde_json::from_value(json!({
        "receiptId":ack.undo_receipt.as_ref().unwrap(),"expectedVersion":ack.task_revision
    }))
    .unwrap()
}
// Include actual capture/dirty/clock records, not merely the edited title/version.
fn snapshot(conn: &Connection) -> Value {
    let mut tables = Vec::new();
    for table in [
        "items",
        "mvp_records",
        "sync_row_versions",
        "content_sync_dirty",
        "mvp_sync_meta",
        "content_sync_control",
        "app_settings",
        "manual_task_undo_receipts",
        "manual_text_undo_operations",
    ] {
        let mut query = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let count = query.column_count();
        let rows: Vec<Value> = query
            .query_map([], |row| {
                let mut cells = Vec::new();
                for i in 0..count {
                    cells.push(match row.get_ref(i)? {
                        ValueRef::Null => json!(["null"]),
                        ValueRef::Integer(v) => json!(["integer", v]),
                        ValueRef::Real(v) => json!(["real", v.to_bits().to_string()]),
                        ValueRef::Text(v) => json!(["text", v]),
                        ValueRef::Blob(v) => json!(["blob", v]),
                    });
                }
                Ok(json!(cells))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        tables.push(json!([table, rows]));
    }
    json!(tables)
}
fn table_definition(conn: &Connection, name: &str) -> String {
    conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn receipt_insert_failure_rolls_back_edit_and_real_capture() {
    let (mut conn, id) = memory();
    let before = snapshot(&conn);
    conn.execute_batch("CREATE TRIGGER edge_reject_receipt BEFORE INSERT ON manual_task_undo_receipts BEGIN SELECT RAISE(ABORT,'synthetic fault'); END;").unwrap();
    assert_eq!(
        edit(
            &mut conn,
            request(&id, "edge-save-receipt-fault", 1, "Changed")
        )
        .unwrap_err(),
        "undo_storage_failed"
    );
    assert_eq!(snapshot(&conn), before);
}
#[test]
fn edit_ack_insert_failure_rolls_back_receipt_task_and_real_capture() {
    let (mut conn, id) = memory();
    let before = snapshot(&conn);
    conn.execute_batch("CREATE TRIGGER edge_reject_edit_ack BEFORE INSERT ON manual_text_undo_operations BEGIN SELECT RAISE(ABORT,'synthetic fault'); END;").unwrap();
    assert_eq!(
        edit(&mut conn, request(&id, "edge-save-ack-fault", 1, "Changed")).unwrap_err(),
        "undo_storage_failed"
    );
    assert_eq!(snapshot(&conn), before);
}
#[test]
fn receipt_consumption_failure_rolls_back_undo_and_real_capture() {
    let (mut conn, id) = memory();
    let ack = saved(&mut conn, &id);
    let before = snapshot(&conn);
    conn.execute_batch("CREATE TRIGGER edge_reject_consumption BEFORE UPDATE OF consumed ON manual_task_undo_receipts BEGIN SELECT RAISE(ABORT,'synthetic fault'); END;").unwrap();
    assert_eq!(
        undo(&mut conn, undo_request(&ack)).unwrap_err(),
        "undo_storage_failed"
    );
    assert_eq!(snapshot(&conn), before);
}
#[test]
fn undo_ack_insert_failure_rolls_back_consumption_and_real_capture() {
    let (mut conn, id) = memory();
    let ack = saved(&mut conn, &id);
    let before = snapshot(&conn);
    conn.execute_batch("CREATE TRIGGER edge_reject_undo_ack BEFORE INSERT ON manual_text_undo_operations WHEN NEW.command='undo' BEGIN SELECT RAISE(ABORT,'synthetic fault'); END;").unwrap();
    assert_eq!(
        undo(&mut conn, undo_request(&ack)).unwrap_err(),
        "undo_storage_failed"
    );
    assert_eq!(snapshot(&conn), before);
    conn.execute_batch("DROP TRIGGER edge_reject_undo_ack;")
        .unwrap();
    assert_eq!(
        undo(&mut conn, undo_request(&ack)).unwrap().task_revision,
        3
    );
}
#[test]
fn unknown_columns_are_preserved_without_partial_edit() {
    for table in ["manual_task_undo_receipts", "manual_text_undo_operations"] {
        let (mut conn, id) = memory();
        let _ack = saved(&mut conn, &id);
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN future_field TEXT NOT NULL DEFAULT 'retained';"
        ))
        .unwrap();
        let definition = table_definition(&conn, table);
        let before = snapshot(&conn);
        assert_eq!(
            edit(&mut conn, request(&id, "edge-schema-column", 2, "Changed")).unwrap_err(),
            "undo_schema_unsupported"
        );
        assert_eq!(snapshot(&conn), before);
        assert_eq!(table_definition(&conn, table), definition);
    }
}
#[test]
fn same_names_with_unknown_key_type_are_preserved_and_rejected() {
    for (table,extra) in [
        ("manual_task_undo_receipts","task_id TEXT NOT NULL,owner TEXT NOT NULL,inverse TEXT NOT NULL,after_row TEXT NOT NULL,after_lineage TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN(0,1))"),
        ("manual_text_undo_operations","owner TEXT NOT NULL,task_id TEXT NOT NULL,command TEXT NOT NULL,request TEXT NOT NULL,response TEXT NOT NULL"),
    ] {
        let (mut conn,id) = memory();
        conn.execute_batch(&format!("DROP TABLE {table}; CREATE TABLE {table}(id INTEGER PRIMARY KEY NOT NULL,schema_version INTEGER NOT NULL CHECK(schema_version=1),{extra});")).unwrap();
        if table == "manual_task_undo_receipts" {
            conn.execute("INSERT INTO manual_task_undo_receipts(id,schema_version,task_id,owner,inverse,after_row,after_lineage) VALUES(7,1,'synthetic-retained','owner','{}','[]','[]')",[]).unwrap();
        } else {
            conn.execute("INSERT INTO manual_text_undo_operations VALUES(7,1,'owner','synthetic-retained','text','{}','{}')",[]).unwrap();
        }
        let definition = table_definition(&conn,table);
        let before = snapshot(&conn);
        assert_eq!(edit(&mut conn,request(&id,"edge-schema-key-type",1,"Changed")).unwrap_err(),"undo_schema_unsupported");
        assert_eq!(snapshot(&conn),before);
        assert_eq!(table_definition(&conn,table),definition);
    }
}
#[test]
fn newer_stored_versions_are_preserved_and_fail_closed() {
    for table in ["manual_task_undo_receipts", "manual_text_undo_operations"] {
        let (mut conn, id) = memory();
        let ack = saved(&mut conn, &id);
        conn.execute_batch(&format!("PRAGMA ignore_check_constraints=ON; UPDATE {table} SET schema_version=2; PRAGMA ignore_check_constraints=OFF;")).unwrap();
        let before = snapshot(&conn);
        assert_eq!(
            undo(&mut conn, undo_request(&ack)).unwrap_err(),
            "undo_schema_unsupported"
        );
        assert_eq!(snapshot(&conn), before);
    }
}
#[test]
fn owner_and_sync_apply_rejections_do_not_consume_or_edit() {
    let (mut conn, id) = memory();
    let ack = saved(&mut conn, &id);
    let owner: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key='device_id'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    conn.execute(
        "UPDATE app_settings SET value='synthetic-other-owner' WHERE key='device_id'",
        [],
    )
    .unwrap();
    let before = snapshot(&conn);
    assert_eq!(
        undo(&mut conn, undo_request(&ack)).unwrap_err(),
        "undo_receipt_unavailable"
    );
    assert_eq!(
        edit(
            &mut conn,
            request(&id, "edge-save-original", 1, "Edited title")
        )
        .unwrap_err(),
        "undo_receipt_unavailable"
    );
    assert_eq!(snapshot(&conn), before);
    conn.execute(
        "UPDATE app_settings SET value=?1 WHERE key='device_id'",
        [owner],
    )
    .unwrap();
    conn.execute("UPDATE content_sync_control SET applying=1 WHERE id=1", [])
        .unwrap();
    let before = snapshot(&conn);
    assert_eq!(
        undo(&mut conn, undo_request(&ack)).unwrap_err(),
        "undo_sync_applying"
    );
    assert_eq!(
        edit(
            &mut conn,
            request(&id, "edge-save-during-sync", 2, "Changed")
        )
        .unwrap_err(),
        "undo_sync_applying"
    );
    assert_eq!(snapshot(&conn), before);
}
#[test]
fn equal_revision_foreign_row_change_blocks_old_receipt() {
    let (mut conn, id) = memory();
    let ack = saved(&mut conn, &id);
    conn.execute("UPDATE content_sync_control SET applying=1 WHERE id=1", [])
        .unwrap();
    conn.execute(
        "UPDATE items SET notes='Synthetic foreign text' WHERE id=?1",
        [&id],
    )
    .unwrap();
    conn.execute("UPDATE content_sync_control SET applying=0 WHERE id=1", [])
        .unwrap();
    assert_eq!(task(&conn, &id).unwrap().version, ack.task_revision);
    let before = snapshot(&conn);
    assert_eq!(
        undo(&mut conn, undo_request(&ack)).unwrap_err(),
        "undo_revision_conflict"
    );
    assert_eq!(snapshot(&conn), before);
}
#[test]
fn unchanged_row_with_new_envelope_or_writer_blocks_old_receipt() {
    for writer_only in [false, true] {
        let (mut conn, id) = memory();
        let ack = saved(&mut conn, &id);
        let full = task(&conn, &id).unwrap().full;
        let key = json!(["items", [&id]]).to_string();
        if writer_only {
            conn.execute("UPDATE sync_row_versions SET device_id='synthetic-new-writer' WHERE table_name='mvp_records' AND row_id=?1",[&key]).unwrap();
        } else {
            conn.execute(
                "UPDATE mvp_records SET updated_at='2099-01-01T00:00:00.000Z' WHERE id=?1",
                [&key],
            )
            .unwrap();
        }
        assert_eq!(task(&conn, &id).unwrap().full, full);
        let before = snapshot(&conn);
        assert_eq!(
            undo(&mut conn, undo_request(&ack)).unwrap_err(),
            "undo_revision_conflict"
        );
        assert_eq!(snapshot(&conn), before);
    }
}
#[test]
fn imported_readonly_ids_cannot_create_manual_receipts() {
    for (readonly, expected) in [
        ("hc-sleep:synthetic", "health_sleep_readonly"),
        ("hc-walk:synthetic", "health_activity_readonly"),
        ("hc-steps:all:synthetic", "health_activity_readonly"),
    ] {
        let (mut conn, id) = memory();
        conn.execute("UPDATE items SET id=?1 WHERE id=?2", params![readonly, id])
            .unwrap();
        let before = snapshot(&conn);
        assert_eq!(
            edit(
                &mut conn,
                request(readonly, "edge-save-readonly", 1, "Changed")
            )
            .unwrap_err(),
            expected
        );
        assert_eq!(snapshot(&conn), before);
    }
}
#[test]
fn two_connections_competing_text_edits_commit_exactly_one_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.db");
    let (conn, id) = fixture(Connection::open(&path).unwrap());
    drop(conn);
    let barrier = Arc::new(Barrier::new(2));
    let mut workers = Vec::new();
    for operation in ["edge-concurrent-first", "edge-concurrent-second"] {
        let path = path.clone();
        let id = id.clone();
        let barrier = barrier.clone();
        workers.push(std::thread::spawn(move || {
            let mut conn = Connection::open(path).unwrap();
            conn.busy_timeout(Duration::from_secs(5)).unwrap();
            barrier.wait();
            edit(&mut conn, request(&id, operation, 1, operation))
        }));
    }
    let outcomes: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(outcomes.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|r| r.as_ref().is_err_and(|e| e == "undo_revision_conflict"))
            .count(),
        1
    );
    let conn = Connection::open(path).unwrap();
    assert_eq!(task(&conn, &id).unwrap().version, 2);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM manual_task_undo_receipts", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM manual_text_undo_operations",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
#[test]
fn concurrent_identical_undo_retries_return_one_durable_outcome() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.db");
    let (mut conn, id) = fixture(Connection::open(&path).unwrap());
    let ack = saved(&mut conn, &id);
    drop(conn);
    let barrier = Arc::new(Barrier::new(2));
    let mut workers = Vec::new();
    for _ in 0..2 {
        let path = path.clone();
        let input = undo_request(&ack);
        let barrier = barrier.clone();
        workers.push(std::thread::spawn(move || {
            let mut conn = Connection::open(path).unwrap();
            conn.busy_timeout(Duration::from_secs(5)).unwrap();
            barrier.wait();
            undo(&mut conn, input).unwrap()
        }));
    }
    let a = workers.remove(0).join().unwrap();
    let b = workers.remove(0).join().unwrap();
    assert_eq!(a, b);
    let conn = Connection::open(path).unwrap();
    assert_eq!(task(&conn, &id).unwrap().version, 3);
    assert_eq!(
        conn.query_row("SELECT consumed FROM manual_task_undo_receipts", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM manual_text_undo_operations WHERE command='undo'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
