use super::*;
fn sync_rows(conn: &Connection) -> Vec<(String, String)> {
    conn.prepare("SELECT id,data FROM mvp_records ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}
fn clock() -> Clock {
    Clock {
        date: "2026-10-08".into(),
        offset: 840,
        utc: "2026-10-07T11:45:00Z".parse().unwrap(),
    }
}
fn seed(conn: &Connection) {
    crate::init_schema(conn).unwrap();
    conn.execute("INSERT INTO items(id,kind,title,date,duration_minutes,version,created_at,updated_at,status) VALUES('one','task','Synthetic One','2026-12-01',30,1,'2026-10-07T10:00:00Z','2026-10-07T10:00:00Z','task')",[]).unwrap();
    conn.execute("INSERT INTO items(id,kind,title,date,duration_minutes,version,created_at,updated_at,status) VALUES('two','task','Synthetic Two',NULL,20,1,'2026-10-07T10:00:00Z','2026-10-07T10:00:00Z','task')",[]).unwrap();
    for (id, typ, source) in [
        (1, "note", "one"),
        (2, "schedule", "[\"routine-original\",\"2026-10-07\",0]"),
        (3, "ai", "ai-original"),
    ] {
        conn.execute("INSERT INTO timeline_blocks(id,source_type,source_id,date,start_time,is_active,created_at,updated_at) VALUES(?1,?2,?3,'2026-10-07','10:45:00',1,'2026-10-07T10:45:00Z','2026-10-07T10:45:00Z')",params![id,typ,source]).unwrap();
    }
    conn.execute("INSERT INTO ui_state(key,value,updated_at) VALUES('calendar_task_run_exchange_v1','synthetic-unchanged','2026-10-07')",[]).unwrap();
}
fn fixture() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    seed(&conn);
    conn
}
fn preview(conn: &Connection, c: &Clock) -> Value {
    snapshot(conn, &load(conn).unwrap(), &c.date, c).unwrap()
}
fn request(conn: &Connection, c: &Clock, action: &str, ids: Vec<&str>) -> Request {
    let p = preview(conn, c);
    Request {
        operation_id: uuid::Uuid::new_v4().to_string(),
        action: action.into(),
        date: c.date.clone(),
        local_date: c.date.clone(),
        offset_minutes: c.offset,
        token: p["token"].as_str().unwrap().into(),
        task_ids: ids.into_iter().map(String::from).collect(),
    }
}
fn active(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM timeline_blocks WHERE is_active=1",
        [],
        |r| r.get(0),
    )
    .unwrap()
}
fn items(conn: &Connection) -> Vec<(String, Option<String>, i64, i64)> {
    conn.prepare("SELECT id,date,version,completed FROM items ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}
#[test]
fn preview_is_read_only_local_and_excludes_ai() {
    let conn = fixture();
    let c = clock();
    let p = preview(&conn, &c);
    assert_eq!(p["date"], "2026-10-08");
    assert_eq!(p["offset_minutes"], 840);
    assert_eq!(p["active_blocks"].as_array().unwrap().len(), 2);
    assert_eq!(p["active_blocks"][0]["seconds"], 3600);
    assert_eq!(active(&conn), 3);
    assert!(load(&conn).unwrap().days.is_empty());
}
#[test]
fn close_atomic_retry_and_reopen_preserve_tasks_ai_and_occurrence() {
    let mut conn = fixture();
    let c = clock();
    let before = items(&conn);
    let req = request(&conn, &c, "close", vec![]);
    let result = commit(&mut conn, req.clone(), &c).unwrap();
    assert_eq!(active(&conn), 1);
    assert_eq!(items(&conn), before);
    assert_eq!(
        result["summary"]["paused_blocks"][1]["source_id"],
        "[\"routine-original\",\"2026-10-07\",0]"
    );
    assert_eq!(
        conn.query_row("SELECT end_time FROM timeline_blocks WHERE id=1", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "01:45:00"
    );
    assert_eq!(
        conn.query_row(
            "SELECT value FROM ui_state WHERE key='calendar_task_run_exchange_v1'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "synthetic-unchanged"
    );
    assert_eq!(commit(&mut conn, req.clone(), &c).unwrap(), result);
    let reopen = request(&conn, &c, "reopen", vec![]);
    commit(&mut conn, reopen, &c).unwrap();
    assert_eq!(active(&conn), 1);
    let p = preview(&conn, &c);
    assert_eq!(p["day"]["closed"], false);
    assert_eq!(p["day"]["summaries"].as_array().unwrap().len(), 1);
    assert_eq!(commit(&mut conn, req, &c).unwrap(), result);
    assert_eq!(preview(&conn, &c)["day"]["closed"], false);
}
#[test]
fn stale_timer_or_task_changes_fail_without_pausing() {
    let mut conn = fixture();
    let c = clock();
    let req = request(&conn, &c, "close", vec![]);
    conn.execute("UPDATE timeline_blocks SET is_active=0 WHERE id=1", [])
        .unwrap();
    assert_eq!(
        commit(&mut conn, req, &c).unwrap_err(),
        "calendar_day_stale_preview"
    );
    assert_eq!(active(&conn), 2);
    let req = request(&conn, &c, "plan", vec!["one"]);
    conn.execute(
        "UPDATE items SET completed=1,version=version+1 WHERE id='one'",
        [],
    )
    .unwrap();
    assert_eq!(
        commit(&mut conn, req, &c).unwrap_err(),
        "calendar_day_stale_preview"
    );
    assert!(load(&conn).unwrap().days.is_empty());
}
#[test]
fn pause_and_receipt_rollback_together_on_any_failure() {
    for failure in ["CREATE TRIGGER fail_pause BEFORE UPDATE ON timeline_blocks WHEN NEW.id=2 BEGIN SELECT RAISE(ABORT,'synthetic second timer failure'); END;","CREATE TRIGGER fail_receipt BEFORE INSERT ON ui_state WHEN NEW.key='calendar_day_lifecycle_local_v1' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;"] {let mut conn=fixture();let c=clock();let req=request(&conn,&c,"close",vec![]);let before = sync_rows(&conn);conn.execute_batch(failure).unwrap();assert!(commit(&mut conn,req,&c).is_err());assert_eq!(active(&conn),3);assert!(load(&conn).unwrap().operations.is_empty());let after = sync_rows(&conn);assert_eq!(before,after);}
}
#[test]
fn explicit_plan_keeps_ids_deadlines_versions_and_no_blanket_routines() {
    let mut conn = fixture();
    let c = clock();
    let before = items(&conn);
    let req = request(&conn, &c, "plan", vec!["two"]);
    let result = commit(&mut conn, req.clone(), &c).unwrap();
    assert_eq!(result["date"], "2026-10-09");
    assert_eq!(result["day"]["plan_ids"], json!(["two"]));
    assert_eq!(items(&conn), before);
    assert_eq!(active(&conn), 3);
    assert_eq!(commit(&mut conn, req.clone(), &c).unwrap(), result);
    let mut changed = req;
    changed.task_ids = vec!["one".into()];
    assert_eq!(
        commit(&mut conn, changed, &c).unwrap_err(),
        "calendar_day_operation_conflict"
    );
    let empty = request(&conn, &c, "plan", vec![]);
    let cleared = commit(&mut conn, empty, &c).unwrap();
    assert_eq!(cleared["day"]["plan_ids"], json!([]));
    assert_eq!(items(&conn), before);
}
#[test]
fn local_midnight_and_offset_change_reject_new_commit_but_not_receipt_retry() {
    let mut conn = fixture();
    let c = clock();
    let req = request(&conn, &c, "close", vec![]);
    let mut later = c.clone();
    later.date = "2026-10-09".into();
    assert_eq!(
        commit(&mut conn, req.clone(), &later).unwrap_err(),
        "calendar_day_context_changed"
    );
    later = c.clone();
    later.offset = 0;
    assert_eq!(
        commit(&mut conn, req.clone(), &later).unwrap_err(),
        "calendar_day_context_changed"
    );
    let result = commit(&mut conn, req.clone(), &c).unwrap();
    assert_eq!(commit(&mut conn, req, &later).unwrap(), result);
}
#[test]
fn lost_response_survives_database_restart() {
    let path =
        std::env::temp_dir().join(format!("cicada-day-synthetic-{}.db", uuid::Uuid::new_v4()));
    let c = clock();
    let (req, result) = {
        let mut conn = Connection::open(&path).unwrap();
        seed(&conn);
        let req = request(&conn, &c, "close", vec![]);
        let result = commit(&mut conn, req.clone(), &c).unwrap();
        (req, result)
    };
    {
        let mut conn = Connection::open(&path).unwrap();
        let mut next = c.clone();
        next.date = "2026-10-09".into();
        assert_eq!(commit(&mut conn, req, &next).unwrap(), result);
        assert_eq!(active(&conn), 1);
    }
    std::fs::remove_file(&path).unwrap();
}
#[test]
fn unavailable_and_duplicate_selection_and_unknown_schema_fail_closed() {
    let mut conn = fixture();
    let c = clock();
    for ids in [
        vec!["one", "one"],
        vec!["missing"],
        vec!["routine-original"],
    ] {
        let req = request(&conn, &c, "plan", ids);
        assert!(commit(&mut conn, req, &c).is_err());
    }
    conn.execute("INSERT INTO ui_state(key,value,updated_at) VALUES(?1,'{\"version\":2,\"days\":{},\"operations\":{}}','synthetic')",[KEY]).unwrap();
    assert_eq!(load(&conn).err().unwrap(), "calendar_day_unknown_schema");
    assert_eq!(active(&conn), 3);
}

#[test]
fn reopen_previous_local_day_keeps_original_summary_offset_and_no_restart() {
    let mut conn = fixture();
    let c = clock();
    let close = request(&conn, &c, "close", vec![]);
    commit(&mut conn, close, &c).unwrap();
    let mut later = c.clone();
    later.date = "2026-10-09".into();
    later.offset = 780;
    let p = snapshot(&conn, &load(&conn).unwrap(), &c.date, &later).unwrap();
    let req = Request {
        operation_id: uuid::Uuid::new_v4().to_string(),
        action: "reopen".into(),
        date: c.date.clone(),
        local_date: later.date.clone(),
        offset_minutes: later.offset,
        token: p["token"].as_str().unwrap().into(),
        task_ids: vec![],
    };
    let result = commit(&mut conn, req, &later).unwrap();
    assert_eq!(result["day"]["closed"], false);
    assert_eq!(result["day"]["summaries"][0]["offset_minutes"], 840);
    assert_eq!(active(&conn), 1);
}
#[test]
fn concurrent_plan_previews_conflict_instead_of_overwriting_selected_ids() {
    let mut conn = fixture();
    let c = clock();
    let first = request(&conn, &c, "plan", vec!["one"]);
    let second = request(&conn, &c, "plan", vec!["two"]);
    commit(&mut conn, first, &c).unwrap();
    assert_eq!(
        commit(&mut conn, second, &c).unwrap_err(),
        "calendar_day_stale_preview"
    );
    assert_eq!(preview(&conn, &c)["next_day"]["plan_ids"], json!(["one"]));
}
#[test]
fn day_ledger_is_device_local_and_existing_timeline_sync_stays_native() {
    let mut conn = fixture();
    let c = clock();
    let req = request(&conn, &c, "close", vec![]);
    commit(&mut conn, req, &c).unwrap();
    let local: i64 = conn
        .query_row(
            "SELECT count(*) FROM mvp_records WHERE json_extract(data,'$.key[0]')=?1",
            [KEY],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(local, 0);
    let timed:i64=conn.query_row("SELECT count(*) FROM mvp_records WHERE json_extract(data,'$.kind')='timeline_blocks' AND json_extract(data,'$.value.is_active')=0",[],|r|r.get(0)).unwrap();
    assert_eq!(timed, 2);
}

#[test]
fn recovery_lookup_requires_every_original_request_field() {
    let mut conn=fixture(); let c=clock(); let original=request(&conn,&c,"plan",vec!["one"]);
    assert_eq!(operation_result(&conn,&original).unwrap(),None);
    let receipt=commit(&mut conn,original.clone(),&c).unwrap();
    assert_eq!(operation_result(&conn,&original).unwrap(),Some(receipt));
    let before=sync_rows(&conn); let ledger_before=load(&conn).unwrap().operations.len();
    for field in ["action","date","local_date","offset_minutes","token","task_ids"] {
        let mut changed=original.clone();
        match field {
            "action"=>changed.action="close".into(),
            "date"=>changed.date="2026-10-09".into(),
            "local_date"=>changed.local_date="2026-10-09".into(),
            "offset_minutes"=>changed.offset_minutes=0,
            "token"=>changed.token="different".into(),
            "task_ids"=>changed.task_ids=vec!["two".into()],
            _=>unreachable!(),
        }
        assert_eq!(operation_result(&conn,&changed).unwrap_err(),"calendar_day_operation_conflict","{field}");
    }
    assert_eq!(sync_rows(&conn),before);assert_eq!(load(&conn).unwrap().operations.len(),ledger_before);
}
