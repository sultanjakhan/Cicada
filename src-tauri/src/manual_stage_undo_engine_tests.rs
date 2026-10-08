use super::super::{undo, UndoInput};
use super::*;
use rusqlite::types::Value as SqlValue;

pub(super) fn fixture() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::init_schema(&conn).unwrap();
    conn.execute("INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,priority,archived,tags,status) VALUES('a','task','Synthetic A','notes','2026-10-08','12:34',25,0,1,'2020-01-01T09:00:00Z','2020-01-01T09:00:00Z','task','#123456',5,0,'foreign,task-process:p-a,task-stage:a,task-waiting,task-stage-log:a@2020-01-01T09:00:00Z','task')",[]).unwrap();
    conn.execute("INSERT INTO items(id,kind,title,notes,duration_minutes,completed,version,created_at,updated_at,status) VALUES('b','task','Synthetic B','parallel',25,0,1,'2020-01-01T09:00:00Z','2020-01-01T09:00:00Z','task')",[]).unwrap();
    crate::mvp_sync_db::set_ui(&conn, "calendar_processes_v1",
        &json!({"version":1,"processes":[{"id":"p-a","title":"Synthetic process","stages":[{"id":"a","title":"A"},{"id":"b","title":"B"}]}]}).to_string(), Some("")).unwrap();
    conn.execute("INSERT INTO calendar_goals(id,title,target_value,current_value,created_at,updated_at) VALUES('g','Synthetic goal',10,3,'created','created')",[]).unwrap();
    conn.execute("INSERT INTO calendar_task_goals(source_type,source_id,goal_id,created_at) VALUES('note','a','g','created')",[]).unwrap();
    for id in ["a", "b"] {
        conn.execute("INSERT INTO timeline_blocks(source_type,source_id,date,start_time,duration_minutes,duration_seconds,is_active,created_at,updated_at) VALUES('note',?1,'2026-10-08','12:34',7,421,1,'2020-01-01T09:00:00Z','created')",[id]).unwrap();
    }
    conn
}
pub(super) fn input(op: &str, version: i64, stage: &str) -> StageInput {
    serde_json::from_value(
        json!({"id":"a","operationId":op,"expectedVersion":version,"stage":stage}),
    )
    .unwrap()
}
pub(super) fn fields(conn: &Connection) -> (String, i64) {
    conn.query_row("SELECT tags,version FROM items WHERE id='a'", [], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .unwrap()
}
pub(super) fn undo_request(ack: &Ack, revision: i64) -> UndoInput {
    serde_json::from_value(json!({"receiptId":ack.undo_receipt,"expectedVersion":revision}))
        .unwrap()
}
pub(super) fn rows(conn: &Connection, table: &str) -> Vec<Vec<SqlValue>> {
    let mut query = conn
        .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
        .unwrap();
    let count = query.column_count();
    query
        .query_map([], |row| (0..count).map(|index| row.get(index)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}
fn stable_task(conn: &Connection) -> Value {
    let mut value: Value = serde_json::from_str(&task(conn, "a").unwrap().full).unwrap();
    for key in ["tags", "version", "updated_at"] {
        value.as_object_mut().unwrap().remove(key);
    }
    value
}
#[test]
fn change_and_compensation_preserve_elapsed_time_parallel_timers_and_identity() {
    let mut conn = fixture();
    let before = stable_task(&conn);
    let goals = rows(&conn, "calendar_task_goals");
    let save = edit_stage(&mut conn, input("stage-1", 1, "b")).unwrap();
    assert_eq!(save.task_revision, 2);
    let changed = fields(&conn).0;
    let log: Vec<_> = attributes::stage_log(&changed)
        .into_iter()
        .map(|(s, t)| (s.to_owned(), t.to_owned()))
        .collect();
    assert_eq!(
        log.iter().map(|(s, _)| s.as_str()).collect::<Vec<_>>(),
        ["a", "b"]
    );
    // Simulate real elapsed accounting AFTER the edit; no task-row mutation.
    conn.execute(
        "UPDATE timeline_blocks SET duration_seconds=999,updated_at='later-accounted'",
        [],
    )
    .unwrap();
    let blocks = rows(&conn, "timeline_blocks");
    let result = undo(&mut conn, undo_request(&save, 2)).unwrap();
    assert_eq!(result.task_revision, 3);
    assert!(result.undo_receipt.is_none());
    let restored = fields(&conn).0;
    assert_eq!(attributes::stage(&restored), Some("a"));
    assert!(attributes::waiting(&restored));
    let restored_log = attributes::stage_log(&restored);
    assert_eq!(restored_log.len(), 3);
    assert_eq!(restored_log[0], (log[0].0.as_str(), log[0].1.as_str()));
    assert_eq!(restored_log[1], (log[1].0.as_str(), log[1].1.as_str()));
    assert_eq!(restored_log[2].0, "a");
    assert_eq!(stable_task(&conn), before);
    assert_eq!(rows(&conn, "timeline_blocks"), blocks);
    assert_eq!(rows(&conn, "calendar_task_goals"), goals);
}
#[test]
fn committed_stage_retries_are_immutable_after_newer_edits_and_process_deletion() {
    let mut conn = fixture();
    let save = edit_stage(&mut conn, input("stable-op", 1, "b")).unwrap();
    assert_eq!(
        edit_stage(&mut conn, input("stable-op", 1, "b")).unwrap(),
        save
    );
    assert_eq!(
        edit_stage(&mut conn, input("stable-op", 1, "a")).unwrap_err(),
        "undo_request_conflict"
    );
    let undone = undo(&mut conn, undo_request(&save, 2)).unwrap();
    crate::calendar_compat::set_task_stage(&mut conn, "a", Some("b"), None).unwrap();
    conn.execute("UPDATE ui_state SET value='{\"version\":1,\"processes\":[]}' WHERE key='calendar_processes_v1'",[]).unwrap();
    let before = task(&conn, "a").unwrap().full;
    let receipts = rows(&conn, "manual_task_undo_receipts");
    assert_eq!(
        edit_stage(&mut conn, input("stable-op", 1, "b")).unwrap(),
        save
    );
    assert_eq!(undo(&mut conn, undo_request(&save, 2)).unwrap(), undone);
    assert_eq!(task(&conn, "a").unwrap().full, before);
    assert_eq!(rows(&conn, "manual_task_undo_receipts"), receipts);
}
#[test]
fn newer_stage_or_process_assignment_never_restores_over_newer_data() {
    for tags in [
        "task-process:p-a,task-stage:a",
        "task-process:p-b,task-stage:b",
    ] {
        let mut conn = fixture();
        let save = edit_stage(&mut conn, input("first", 1, "b")).unwrap();
        conn.execute(
            "UPDATE items SET tags=?1,version=version+1 WHERE id='a'",
            [tags],
        )
        .unwrap();
        let before = task(&conn, "a").unwrap().full;
        for revision in [2, 3] {
            assert_eq!(
                undo(&mut conn, undo_request(&save, revision)).unwrap_err(),
                "undo_revision_conflict"
            );
        }
        assert_eq!(task(&conn, "a").unwrap().full, before);
        assert_eq!(
            rows(&conn, "manual_task_undo_receipts")[0][7],
            SqlValue::Integer(0)
        );
    }
}
#[test]
fn deleted_process_or_restore_stage_is_a_conflict_without_consumption() {
    for state in [
        json!({"version":1,"processes":[]}),
        json!({"version":1,"processes":[{"id":"p-a","title":"Synthetic process","stages":[{"id":"b","title":"B"}]}]}),
    ] {
        let mut conn = fixture();
        let save = edit_stage(&mut conn, input("first", 1, "b")).unwrap();
        conn.execute(
            "UPDATE ui_state SET value=?1 WHERE key='calendar_processes_v1'",
            [state.to_string()],
        )
        .unwrap();
        let before = task(&conn, "a").unwrap().full;
        let receipts = rows(&conn, "manual_task_undo_receipts");
        assert!(undo(&mut conn, undo_request(&save, 2)).is_err());
        assert_eq!(task(&conn, "a").unwrap().full, before);
        assert_eq!(rows(&conn, "manual_task_undo_receipts"), receipts);
        assert_eq!(rows(&conn, "manual_text_undo_operations").len(), 1);
    }
}
#[test]
fn failed_receipt_or_outcome_write_rolls_back_task_history_and_receipt() {
    let mut conn = fixture();
    let before = task(&conn, "a").unwrap().full;
    conn.execute_batch("CREATE TRIGGER reject_stage_receipt BEFORE INSERT ON manual_task_undo_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;").unwrap_err();
    // Initialize only via an ordinary no-op; never mint a stage receipt for it.
    edit_stage(&mut conn, input("noop", 1, "a")).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_stage_receipt BEFORE INSERT ON manual_task_undo_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;").unwrap();
    assert_eq!(
        edit_stage(&mut conn, input("stage-failure", 1, "b")).unwrap_err(),
        "undo_storage_failed"
    );
    assert_eq!(task(&conn, "a").unwrap().full, before);
    assert!(rows(&conn, "manual_task_undo_receipts").is_empty());
    conn.execute_batch("DROP TRIGGER reject_stage_receipt;")
        .unwrap();
    let save = edit_stage(&mut conn, input("stage-failure", 1, "b")).unwrap();
    let after = task(&conn, "a").unwrap().full;
    let receipts = rows(&conn, "manual_task_undo_receipts");
    conn.execute_batch("CREATE TRIGGER reject_undo_outcome BEFORE INSERT ON manual_text_undo_operations WHEN NEW.command='undo' BEGIN SELECT RAISE(ABORT,'synthetic outcome failure'); END;").unwrap();
    assert_eq!(
        undo(&mut conn, undo_request(&save, 2)).unwrap_err(),
        "undo_storage_failed"
    );
    assert_eq!(task(&conn, "a").unwrap().full, after);
    assert_eq!(rows(&conn, "manual_task_undo_receipts"), receipts);
    conn.execute_batch("DROP TRIGGER reject_undo_outcome;")
        .unwrap();
    undo(&mut conn, undo_request(&save, 2)).unwrap();
}

#[test]
fn native_process_delete_recreate_same_definition_conflicts_without_losing_data() {
    let mut conn = fixture();
    let raw = crate::mvp_sync_db::read_ui(&conn, "calendar_processes_v1")
        .unwrap()
        .unwrap();
    let save = edit_stage(&mut conn, input("stage-incarnation", 1, "b")).unwrap();
    let before = task(&conn, "a").unwrap().full;
    let receipts = rows(&conn, "manual_task_undo_receipts");
    let empty = r#"{"version":1,"processes":[]}"#;
    crate::mvp_sync_db::set_ui(&conn, "calendar_processes_v1", empty, Some(&raw)).unwrap();
    crate::mvp_sync_db::set_ui(&conn, "calendar_processes_v1", &raw, Some(empty)).unwrap();
    assert_eq!(
        crate::mvp_sync_db::read_ui(&conn, "calendar_processes_v1")
            .unwrap()
            .as_deref(),
        Some(raw.as_str())
    );
    assert_eq!(
        undo(&mut conn, undo_request(&save, 2)).unwrap_err(),
        "undo_stage_conflict"
    );
    assert_eq!(task(&conn, "a").unwrap().full, before);
    assert_eq!(rows(&conn, "manual_task_undo_receipts"), receipts);
    assert_eq!(
        edit_stage(&mut conn, input("stage-incarnation", 1, "b")).unwrap(),
        save
    );
    assert_eq!(task(&conn, "a").unwrap().full, before);
}

#[test]
fn process_envelope_or_writer_change_blocks_undo_even_with_identical_task_and_process() {
    for writer in [false, true] {
        let mut conn = fixture();
        let save = edit_stage(&mut conn, input("stage-proof", 1, "b")).unwrap();
        let before = task(&conn, "a").unwrap().full;
        let receipts = rows(&conn, "manual_task_undo_receipts");
        let process = crate::mvp_sync_db::read_ui(&conn, "calendar_processes_v1").unwrap();
        let key = json!(["ui", ["calendar_processes_v1", "processes", "p-a"]]).to_string();
        let changed = if writer {
            conn.execute("UPDATE sync_row_versions SET device_id='synthetic-new-writer' WHERE table_name='mvp_records' AND row_id=?1",[&key]).unwrap()
        } else {
            conn.execute(
                "UPDATE mvp_records SET updated_at='2099-01-01T00:00:00.000Z' WHERE id=?1",
                [&key],
            )
            .unwrap()
        };
        assert_eq!(changed, 1, "the real native process record must exist");
        assert_eq!(
            crate::mvp_sync_db::read_ui(&conn, "calendar_processes_v1").unwrap(),
            process
        );
        assert_eq!(
            undo(&mut conn, undo_request(&save, 2)).unwrap_err(),
            "undo_stage_conflict"
        );
        assert_eq!(task(&conn, "a").unwrap().full, before);
        assert_eq!(rows(&conn, "manual_task_undo_receipts"), receipts);
    }
}
