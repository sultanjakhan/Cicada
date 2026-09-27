use super::*;
use serde_json::Map;

fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    crate::init_schema(&c).unwrap();
    c
}
fn config() -> ActivityConnection {
    ActivityConnection {
        id: Uuid::new_v4().to_string(),
        label: "Synthetic".into(),
        port: 5600,
        endpoint: "http://127.0.0.1:5600".into(),
        enabled: true,
        source: "windows".into(),
        revision: Uuid::new_v4().to_string(),
        token_slot: None,
    }
}
fn configure(c: &Connection, configs: &[ActivityConnection]) {
    c.execute("INSERT INTO app_settings(key,value,updated_at) VALUES(?1,?2,'fixture') ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![SETTINGS_KEY,serde_json::to_string(configs).unwrap()]).unwrap();
}
fn aggregate(day: &str) -> Aggregate {
    Aggregate {
        day: NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap(),
        foreground_seconds: 120.0,
        active_seconds: None,
        apps: BTreeMap::from([("Fixture".into(), 120.0)]),
    }
}
fn seed(c: &Connection, cfg: &ActivityConnection, day: &str) -> String {
    project(c, cfg, &[aggregate(day)]).unwrap();
    format!("digital-activity:{}:{day}", cfg.id)
}
fn exists(c: &Connection, id: &str) -> bool {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM items WHERE id=?1)",
        [id],
        |r| r.get(0),
    )
    .unwrap()
}
fn wire(c: &Connection, kind: &str, keys: Value) -> Map<String, Value> {
    let id = json!([kind, keys]).to_string();
    c.query_row("SELECT r.data,r.updated_at,v.device_id FROM mvp_records r JOIN sync_row_versions v ON v.table_name='mvp_records' AND v.row_id=r.id WHERE r.id=?1",[&id],|r| {
        let stamp: String = r.get(1)?;
        Ok(json!({"id":id,"data":r.get::<_,String>(0)?,"updated_at":stamp,"_updated_at":stamp,"_device_id":r.get::<_,String>(2)?}).as_object().unwrap().clone())
    }).unwrap()
}
fn stamp(mut record: Map<String, Value>, time: &str, writer: &str) -> Map<String, Value> {
    record.insert("updated_at".into(), json!(time));
    record.insert("_updated_at".into(), json!(time));
    record.insert("_device_id".into(), json!(writer));
    record
}
fn receive(c: &mut Connection, records: &[Map<String, Value>]) -> Result<(), String> {
    let tx = c.transaction().unwrap();
    tx.execute("UPDATE content_sync_control SET applying=1", [])
        .unwrap();
    for row in records {
        crate::mvp_sync_db::apply_record(&tx, row)?;
    }
    tx.execute("UPDATE content_sync_control SET applying=0", [])
        .unwrap();
    tx.commit().unwrap();
    Ok(())
}

#[test]
fn erasure_exact_source_dates_other_events_and_idempotence() {
    let mut c = db();
    let a = config();
    let b = config();
    configure(&c, &[a.clone(), b.clone()]);
    let old = seed(&c, &a, "2026-01-14");
    let boundary = seed(&c, &a, "2026-01-15");
    let future = seed(&c, &a, "2026-01-16");
    let other = seed(&c, &b, "2026-01-15");
    c.execute("INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at,tags) VALUES('ordinary','event','Synthetic',0,1,'a','a',?1)",[json!(["digital-activity:v1",format!("digital-activity-device:{}",a.id),"digital-activity-day:2026-01-15"]).to_string()]).unwrap();
    assert_eq!(preview(&c, &a.id, "2026-01-15").unwrap()["count"], 2);
    assert_eq!(
        erase(&mut c, &a.id, "2026-01-15", Some(1)).unwrap_err(),
        "digital_activity_erasure_count_changed"
    );
    assert!(cutoff(&c, &a.id).unwrap().is_none());
    assert!(exists(&c, &old));
    assert_eq!(
        erase(&mut c, &a.id, "2026-01-15", Some(2)).unwrap(),
        json!({"deleted":2,"deletedThrough":"2026-01-15"})
    );
    assert!(!exists(&c, &old));
    assert!(!exists(&c, &boundary));
    for id in [&future, &other, "ordinary"] {
        assert!(exists(&c, id));
    }
    let tombstone: Value =
        serde_json::from_str(wire(&c, "items", json!([old]))["data"].as_str().unwrap()).unwrap();
    assert_eq!(tombstone["deleted"], true);
    let marker = wire(&c, "ui", json!([KEY, a.id]));
    assert_eq!(
        erase(&mut c, &a.id, "2026-01-15", Some(0)).unwrap()["deleted"],
        0
    );
    assert_eq!(
        erase(&mut c, &a.id, "2026-01-01", Some(0)).unwrap()["deletedThrough"],
        "2026-01-15"
    );
    assert_eq!(wire(&c, "ui", json!([KEY, a.id])), marker);
    assert_eq!(project(&c, &a, &[aggregate("2026-01-15")]).unwrap(), 0);
    assert_eq!(
        crate::mvp_sync_db::set_ui(&c, KEY, "{}", None).unwrap_err(),
        "digital_activity_retention_read_only"
    );
}

#[test]
fn erasure_invalid_dates_and_unsafe_target_roll_back() {
    let mut c = db();
    let cfg = config();
    configure(&c, &[cfg.clone()]);
    let id = seed(&c, &cfg, "2026-01-15");
    for day in ["2026-1-15", "2026-02-30", "1969-12-31", "9999-12-31"] {
        assert_eq!(
            erase(&mut c, &cfg.id, day, None).unwrap_err(),
            "digital_activity_invalid_date"
        );
    }
    for (column, value) in [("kind", "task"), ("date", "2026-01-14"), ("tags", "[]")] {
        let old: String = c
            .query_row(
                &format!("SELECT {column} FROM items WHERE id=?1"),
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        c.execute(
            &format!("UPDATE items SET {column}=?1 WHERE id=?2"),
            params![value, id],
        )
        .unwrap();
        assert_eq!(
            erase(&mut c, &cfg.id, "2026-01-15", None).unwrap_err(),
            UNSAFE
        );
        assert!(cutoff(&c, &cfg.id).unwrap().is_none());
        assert!(exists(&c, &id));
        c.execute(
            &format!("UPDATE items SET {column}=?1 WHERE id=?2"),
            params![old, id],
        )
        .unwrap();
    }
    c.execute_batch("CREATE TRIGGER fixture_fail BEFORE DELETE ON items BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(erase(&mut c, &cfg.id, "2026-01-15", None).is_err());
    assert!(cutoff(&c, &cfg.id).unwrap().is_none());
    assert!(exists(&c, &id));
}

#[test]
fn erasure_survives_pause_disconnect_restart_and_new_uuid_is_independent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic.db");
    let mut c = Connection::open(&path).unwrap();
    crate::init_schema(&c).unwrap();
    let mut cfg = config();
    cfg.enabled = false;
    configure(&c, &[cfg.clone()]);
    let id = seed(&c, &cfg, "2026-01-15");
    crate::mvp_sync::secrets::write_for(&path, SECRET_SERVICE, "invalid synthetic secrets")
        .unwrap();
    erase(&mut c, &cfg.id, "2026-01-15", Some(1)).unwrap();
    crate::mvp_sync::secrets::write_for(&path, SECRET_SERVICE, "{}").unwrap();
    // Actual disconnect may clear local configuration and encrypted credentials,
    // but it must not clear either sync history or the deletion boundary.
    remove_connection(&mut c, &path, &cfg.id).unwrap();
    assert!(cutoff(&c, &cfg.id).unwrap().is_some());
    assert_eq!(preview(&c, &cfg.id, "2026-01-15").unwrap()["count"], 0);
    drop(c);
    let mut c = Connection::open(&path).unwrap();
    crate::init_schema(&c).unwrap();
    configure(&c, &[cfg.clone()]);
    assert_eq!(
        commit_reading(
            &mut c,
            &cfg,
            Ok(Reading {
                aggregates: vec![aggregate("2026-01-15")],
                has_active: false
            }),
            false
        )
        .unwrap()
        .unwrap()
        .1,
        0
    );
    assert!(!exists(&c, &id));
    let new_cfg = config();
    let fresh = seed(&c, &new_cfg, "2026-01-15");
    assert!(exists(&c, &fresh));
}

#[test]
fn erasure_three_replicas_reordered_markers_and_newer_stale_events_converge() {
    let mut a = db();
    let mut b = db();
    let cfg = config();
    configure(&a, &[cfg.clone()]);
    configure(&b, &[cfg.clone()]);
    let old = seed(&a, &cfg, "2026-01-15");
    let stale = stamp(
        wire(&a, "items", json!([old])),
        "2090-01-01T00:00:00.000Z",
        "stale-peer",
    );
    let peer_only = seed(&b, &cfg, "2026-01-16");
    erase(&mut a, &cfg.id, "2026-01-17", None).unwrap();
    let high = stamp(
        wire(&a, "ui", json!([KEY, cfg.id])),
        "2026-01-01T00:00:00.000Z",
        "a",
    );
    erase(&mut b, &cfg.id, "2026-01-15", None).unwrap();
    let low = stamp(
        wire(&b, "ui", json!([KEY, cfg.id])),
        "2091-01-01T00:00:00.000Z",
        "b",
    );
    // Three receiving replicas see the same immutable records in different
    // orders; B also owns an unsynchronized day absent from the sender's erase.
    let mut a = db();
    let mut b = db();
    let mut c = db();
    seed(&b, &cfg, "2026-01-16");
    receive(&mut a, &[low.clone(), stale.clone(), high.clone()]).unwrap();
    receive(&mut b, &[high.clone(), stale.clone(), low.clone()]).unwrap();
    receive(
        &mut c,
        &[stale.clone(), low.clone(), high.clone(), stale.clone()],
    )
    .unwrap();
    for peer in [&a, &b, &c] {
        assert_eq!(
            cutoff(peer, &cfg.id).unwrap().as_deref(),
            Some("2026-01-17")
        );
        assert_eq!(wire(peer, "ui", json!([KEY, cfg.id])), high);
        assert!(!exists(peer, &old));
        assert!(!exists(peer, &peer_only));
    }
    let deleted: Value = serde_json::from_str(
        wire(&b, "items", json!([peer_only]))["data"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(deleted["deleted"], true);
    assert!(b
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM content_sync_dirty WHERE row_id=?1)",
            [json!(["items", [peer_only]]).to_string()],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
}

#[test]
fn erasure_invalid_remote_marker_rolls_back_whole_batch() {
    let mut source = db();
    let cfg = config();
    configure(&source, &[cfg.clone()]);
    let id = seed(&source, &cfg, "2026-01-15");
    let live = wire(&source, "items", json!([id]));
    erase(&mut source, &cfg.id, "2026-01-15", None).unwrap();
    let marker = wire(&source, "ui", json!([KEY, cfg.id]));
    for invalid in [
        json!({"deletedThrough":"2026-02-30"}),
        json!({"deletedThrough":"2026-01-15","raw":"forbidden"}),
        Value::Null,
    ] {
        let mut bad = marker.clone();
        let mut data: Value = serde_json::from_str(bad["data"].as_str().unwrap()).unwrap();
        data["value"] = invalid;
        bad.insert("data".into(), json!(data.to_string()));
        let mut target = db();
        assert_eq!(
            receive(&mut target, &[live.clone(), bad]).unwrap_err(),
            "content_sync_unknown_schema"
        );
        assert!(!exists(&target, &id));
        assert!(cutoff(&target, &cfg.id).unwrap().is_none());
        assert_eq!(
            target
                .query_row("SELECT applying FROM content_sync_control", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    let mut bad = marker.clone();
    let mut data: Value = serde_json::from_str(bad["data"].as_str().unwrap()).unwrap();
    data["value"] = Value::Null;
    data["deleted"] = json!(true);
    bad.insert("data".into(), json!(data.to_string()));
    let mut target = db();
    assert!(receive(&mut target, &[bad]).is_err());
}

#[test]
fn erasure_conflict_restore_cannot_revive_history() {
    let mut c = db();
    let cfg = config();
    configure(&c, &[cfg.clone()]);
    let id = seed(&c, &cfg, "2026-01-15");
    let live = wire(&c, "items", json!([id]));
    erase(&mut c, &cfg.id, "2026-01-15", None).unwrap();
    c.execute(
        "INSERT INTO mvp_sync_conflicts VALUES(?1,?2,?3,?4)",
        params![
            live["id"].as_str(),
            live["updated_at"].as_str(),
            live["_device_id"].as_str(),
            live["data"].as_str()
        ],
    )
    .unwrap();
    let list = crate::mvp_sync_db::conflicts::list(&c, 0, 25).unwrap();
    let entry = &list["entries"][0];
    let result = crate::mvp_sync_db::conflicts::resolve_for_test(
        &mut c,
        entry["token"].as_str().unwrap(),
        entry["expected"].as_str().unwrap(),
        "incoming",
    );
    assert_eq!(result.unwrap_err(), "digital_activity_history_erased");
    assert!(!exists(&c, &id));
}

#[test]
fn erasure_during_http_does_not_wait_or_resurrect() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        time::Instant,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic.db");
    let mut c = Connection::open(&path).unwrap();
    crate::init_schema(&c).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut cfg = config();
    cfg.port = listener.local_addr().unwrap().port();
    cfg.endpoint = format!("http://127.0.0.1:{}", cfg.port);
    configure(&c, &[cfg.clone()]);
    let id = seed(&c, &cfg, "2026-01-15");
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let day = aggregate("2026-01-15").day;
    let start = day_bounds(&Local, day).unwrap().0;
    let server = std::thread::spawn(move || {
        for (index,body) in [json!({"window":{"client":"aw-watcher-window","type":"currentwindow","hostname":"fixture"}}),json!([{"id":1,"timestamp":DateTime::<Utc>::from_timestamp(start as i64+3600,0).unwrap().to_rfc3339(),"duration":120.0,"data":{"app":"Fixture","title":"excluded"}}])].into_iter().enumerate() {
            let (mut stream,_) = listener.accept().unwrap(); stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut request = Vec::new(); while !request.ends_with(b"\r\n\r\n") { let mut byte=[0]; stream.read_exact(&mut byte).unwrap(); request.push(byte[0]); }
            if index==0 { started_tx.send(()).unwrap(); release_rx.recv_timeout(Duration::from_secs(10)).unwrap(); }
            let body=body.to_string(); write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        }
    });
    let import_path = path.clone();
    let device = cfg.id.clone();
    let importer =
        std::thread::spawn(move || run_import(&import_path, Some(&device), &[day], true));
    started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let began = Instant::now();
    assert_eq!(
        erase(&mut c, &cfg.id, "2026-01-15", Some(1)).unwrap()["deleted"],
        1
    );
    assert!(began.elapsed() < Duration::from_secs(2));
    release_tx.send(()).unwrap();
    let outcome = importer.join().unwrap().unwrap();
    server.join().unwrap();
    assert_eq!(outcome["changed"], 0);
    assert_eq!(outcome["imported"], 0);
    assert!(!exists(&c, &id));
}
