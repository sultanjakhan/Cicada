use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex as StdMutex},
};

fn cfg() -> ActivityConnection {
    ActivityConnection {
        id: Uuid::new_v4().to_string(),
        label: "ПК с Android в названии".into(),
        port: 5600,
        endpoint: "http://127.0.0.1:5600".into(),
        enabled: true,
        source: "windows".into(),
        revision: Uuid::new_v4().to_string(),
        token_slot: None,
    }
}
fn date() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 1, 15).unwrap()
}
fn event(start: f64, duration: f64, data: Value) -> Event {
    let seconds = start.floor() as i64;
    let nanos = ((start - seconds as f64) * 1e9).round() as u32;
    serde_json::from_value(json!({"id":1,"timestamp":DateTime::<Utc>::from_timestamp(seconds,nanos).unwrap().to_rfc3339(),"duration":duration,"data":data})).unwrap()
}
fn window(start: f64, duration: f64, app: &str) -> Event {
    event(start, duration, json!({"app":app,"title":"excluded"}))
}
fn afk(start: f64, duration: f64, status: &str) -> Event {
    event(start, duration, json!({"status":status}))
}
fn metadata(android: bool, active: bool) -> Value {
    let mut value = json!({"window/with space":{"id":"window/with space","client":if android {"aw-android"}else{"aw-watcher-window"},"type":"currentwindow","hostname":"fixture-host","created":"2026-01-01"}});
    if active {
        value["afk"] =
            json!({"client":"aw-watcher-afk","type":"afkstatus","hostname":"fixture-host"});
    }
    value
}
fn api_events(events: &[Event]) -> Value {
    Value::Array(
        events
            .iter()
            .map(|e| json!({"id":1,"timestamp":e.timestamp,"duration":e.duration,"data":e.data}))
            .collect(),
    )
}
// Real TCP server, real reqwest URL encoding and API JSON deserialization.
fn server(replies: Vec<Value>) -> (u16, Arc<StdMutex<Vec<String>>>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(StdMutex::new(Vec::new()));
    let capture = requests.clone();
    let handle = std::thread::spawn(move || {
        for reply in replies {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut buffer = Vec::new();
            while !buffer.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                buffer.push(byte[0]);
            }
            capture
                .lock()
                .unwrap()
                .push(String::from_utf8(buffer).unwrap());
            let body = reply.to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        }
    });
    (port, requests, handle)
}
fn connect(cfg: &mut ActivityConnection, port: u16) {
    cfg.port = port;
    cfg.endpoint = format!("http://127.0.0.1:{port}");
}
fn store_cfg(conn: &Connection, configs: &[ActivityConnection]) {
    conn.execute("INSERT INTO app_settings(key,value,updated_at) VALUES(?1,?2,'fixture') ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![SETTINGS_KEY,serde_json::to_string(configs).unwrap()]).unwrap();
}
fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::init_schema(&conn).unwrap();
    conn
}

#[test]
fn loopback_windows_overlap_afk_midnight_and_query_date() {
    let day = date();
    let previous = day.pred_opt().unwrap();
    let (lo, hi) = day_bounds(&Local, day).unwrap();
    let windows = vec![
        window(lo + 8.0 * 3600.0, 3600.0, "A"),
        window(lo + 8.5 * 3600.0, 3600.0, "B"),
        window(lo - 300.0, 600.0, "Night"),
    ];
    let active = vec![
        afk(lo + 8.0 * 3600.0, 3000.0, "not-afk"),
        afk(lo + 8.0 * 3600.0 + 3000.0, 2400.0, "afk"),
        afk(lo - 300.0, 600.0, "not-afk"),
    ];
    let (port, requests, worker) = server(vec![
        metadata(false, true),
        api_events(&windows),
        api_events(&active),
    ]);
    let mut cfg = cfg();
    connect(&mut cfg, port);
    let result = read_device(&client().unwrap(), &cfg, None, &[previous, day]).unwrap();
    worker.join().unwrap();
    assert!(result.has_active);
    assert_eq!(result.aggregates.len(), 2);
    assert_eq!(result.aggregates[0].foreground_seconds, 300.0);
    assert_eq!(result.aggregates[0].active_seconds, Some(300.0));
    assert_eq!(result.aggregates[1].foreground_seconds, 5700.0);
    assert_eq!(result.aggregates[1].active_seconds, Some(3300.0));
    assert_eq!(result.aggregates[1].apps["A"], 1800.0);
    assert_eq!(result.aggregates[1].apps["B"], 3600.0);
    let requests = requests.lock().unwrap();
    let url = reqwest::Url::parse(&format!(
        "http://localhost{}",
        requests[1].split_whitespace().nth(1).unwrap()
    ))
    .unwrap();
    assert!(url.path().contains("window%2Fwith%20space"));
    let query: BTreeMap<_, _> = url
        .query_pairs()
        .map(|(a, b)| (a.into_owned(), b.into_owned()))
        .collect();
    assert!(query["start"].contains("+00:00"));
    assert!(!query["start"].contains(' '));
    assert_eq!(
        DateTime::parse_from_rfc3339(&query["end"])
            .unwrap()
            .timestamp(),
        hi as i64
    );
    assert_eq!(requested_days(Some("2026-01-15")).unwrap(), vec![day]);
    assert!(requested_days(Some("2026-1-15")).is_err());
    assert!(requested_days(Some("2026-02-30")).is_err());
}

#[test]
fn fractional_sweep_latest_start_ties_and_afk_subtraction() {
    let events = vec![
        (0.0, 1.0, "A".into()),
        (0.1, 0.7, "B".into()),
        (0.1, 0.5, "C".into()),
    ];
    let result = allocate(&events, &[(0.0, 0.25), (0.5, 0.75)], 0.0, 1.0);
    assert!((result.values().sum::<f64>() - 0.5).abs() < 1e-8);
    assert!((result["C"] - 0.15).abs() < 1e-8);
    assert!((result["B"] - 0.2).abs() < 1e-8);
    assert_eq!(
        subtract(
            vec![(0.0, 10.0), (5.0, 20.0)],
            vec![(3.0, 7.0), (6.0, 15.0)]
        ),
        vec![(0.0, 3.0), (15.0, 20.0)]
    );
}

#[test]
fn android_unknown_active_and_strict_source_independent_of_label() {
    let (lo, hi) = day_bounds(&Local, date()).unwrap();
    let events = vec![event(
        lo,
        90.25,
        json!({"app":"Reader","package":"private.package","classname":"PrivateClass"}),
    )];
    let (port, _, worker) = server(vec![metadata(true, false), api_events(&events)]);
    let mut cfg = cfg();
    cfg.source = "android".into();
    cfg.label = "Телефон".into();
    connect(&mut cfg, port);
    let result = read_device(&client().unwrap(), &cfg, None, &[date()]).unwrap();
    worker.join().unwrap();
    assert!(!result.has_active);
    assert_eq!(result.aggregates[0].active_seconds, None);
    let conn = db();
    project(&conn, &cfg, &result.aggregates).unwrap();
    let exported: String = conn
        .query_row("SELECT group_concat(data) FROM mvp_records", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(exported.contains("Reader"));
    assert!(!exported.contains("PrivateClass"));
    assert!(!exported.contains("private.package"));
    assert!(!exported.contains("fixture-host"));
    assert!(!exported.contains("timestamp"));
    let tags: String = conn
        .query_row("SELECT tags FROM items", [], |r| r.get(0))
        .unwrap();
    let mut decorated = json!({});
    decorate(&mut decorated, "digital-activity:fixture", &tags);
    assert!(decorated["activity_summary"]["active_seconds"].is_null());
    assert_eq!(decorated["activity_summary"]["foreground_seconds"], 90.25);

    for data in [
        json!({"app":"A","title":"excluded"}),
        json!({"app":"A","url":"https://private"}),
        json!({"package":"A"}),
    ] {
        assert!(aggregate(&[event(lo, 1.0, data)], None, true, &[(date(), (lo, hi))]).is_err());
    }
    let (port, _, worker) = server(vec![
        metadata(false, false),
        json!([{"timestamp":DateTime::<Utc>::from_timestamp(lo as i64,0).unwrap().to_rfc3339(),"duration":1,"data":{"app":"Browser","title":"secret"}}]),
    ]);
    cfg.source = "windows".into();
    cfg.label = "Android".into();
    connect(&mut cfg, port);
    assert_eq!(
        read_device(&client().unwrap(), &cfg, None, &[date()])
            .err()
            .unwrap(),
        "digital_activity_unredacted_title"
    );
    worker.join().unwrap();
}

#[test]
fn missing_duplicate_wrong_type_and_hostname_fail_before_event_fetch() {
    let mut duplicate = metadata(false, false);
    duplicate["second"] = duplicate["window/with space"].clone();
    let mut wrong = metadata(false, false);
    wrong["window/with space"]["type"] = json!("web.tab.current");
    let mut mismatch = metadata(false, true);
    mismatch["afk"]["hostname"] = json!("other-host");
    for (meta, expected) in [
        (json!({}), "digital_activity_missing_window_bucket"),
        (duplicate, "digital_activity_duplicate_client_bucket"),
        (wrong, "digital_activity_missing_window_bucket"),
        (mismatch, "digital_activity_hostname_mismatch"),
    ] {
        let (port, _, worker) = server(vec![meta]);
        let mut cfg = cfg();
        connect(&mut cfg, port);
        assert_eq!(
            read_device(&client().unwrap(), &cfg, None, &[date()])
                .err()
                .unwrap(),
            expected
        );
        worker.join().unwrap();
    }
}

#[test]
fn long_event_is_clipped_and_empty_or_missing_afk_is_distinct() {
    let (lo, hi) = day_bounds(&Local, date()).unwrap();
    let windows = vec![window(lo - 2.0 * 86400.0, 3.0 * 86400.0, "Long")];
    let result = aggregate(&windows, None, false, &[(date(), (lo, hi))]).unwrap();
    assert_eq!(result.aggregates[0].foreground_seconds, hi - lo);
    assert_eq!(result.aggregates[0].active_seconds, None);
    let result = aggregate(&windows, Some(&[]), false, &[(date(), (lo, hi))]).unwrap();
    assert_eq!(result.aggregates[0].active_seconds, None);
    assert!(!result.has_active);
    let away = vec![afk(lo, hi - lo, "afk")];
    let result = aggregate(&windows, Some(&away), false, &[(date(), (lo, hi))]).unwrap();
    assert_eq!(result.aggregates[0].active_seconds, Some(0.0));
    assert!(result.has_active);
    assert!(aggregate(
        &[window(lo, MAX_EVENT_SECONDS + 1.0, "A")],
        None,
        false,
        &[(date(), (lo, hi))]
    )
    .is_err());
}

fn reading() -> Reading {
    Reading {
        aggregates: vec![Aggregate {
            day: date(),
            foreground_seconds: 120.25,
            active_seconds: Some(60.5),
            apps: BTreeMap::from([("Reader".into(), 120.25)]),
        }],
        has_active: true,
    }
}
#[test]
fn transaction_is_idempotent_journaled_readonly_and_counts_each_device() {
    let mut conn = db();
    let first = cfg();
    let second = cfg();
    store_cfg(&conn, &[first.clone(), second.clone()]);
    assert_eq!(
        commit_reading(&mut conn, &first, Ok(reading()), true)
            .unwrap()
            .unwrap()
            .1,
        1
    );
    let journal: i64 = conn
        .query_row("SELECT count(*) FROM content_sync_dirty", [], |r| r.get(0))
        .unwrap();
    let version: (i64, String) = conn
        .query_row("SELECT version,updated_at FROM items", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(
        commit_reading(&mut conn, &first, Ok(reading()), true)
            .unwrap()
            .unwrap()
            .1,
        0
    );
    assert_eq!(
        version,
        conn.query_row("SELECT version,updated_at FROM items", [], |r| Ok((
            r.get(0)?,
            r.get(1)?
        )))
        .unwrap()
    );
    assert_eq!(
        journal,
        conn.query_row("SELECT count(*) FROM content_sync_dirty", [], |r| r
            .get::<_, i64>(0))
            .unwrap()
    );
    commit_reading(&mut conn, &second, Ok(reading()), true).unwrap();
    let counts: Vec<i64> = conn
        .prepare("SELECT records FROM digital_activity_status")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(counts, vec![1, 1]);
    commit_reading(
        &mut conn,
        &first,
        Err("digital_activity_connection_failed".into()),
        true,
    )
    .unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM items", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    let id = format!("digital-activity:{}:{}", first.id, date());
    assert_eq!(
        crate::remove(&mut conn, &id, 1).unwrap_err(),
        "digital_activity_readonly"
    );
    assert_eq!(
        crate::complete(&mut conn, &id, 1, true).unwrap_err(),
        "digital_activity_readonly"
    );
    let input = crate::ItemInput {
        id: Some(id.clone()),
        expected_version: Some(1),
        kind: "event".into(),
        title: "Changed".into(),
        notes: String::new(),
        date: Some(date().to_string()),
        time: None,
        duration_minutes: 3,
        completed: false,
    };
    assert_eq!(
        crate::save(&mut conn, input).unwrap_err(),
        "digital_activity_readonly"
    );
    use tauri::Manager;
    let app = tauri::test::mock_builder()
        .manage(crate::AppState(StdMutex::new(conn)))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    assert_eq!(
        crate::calendar_compat::delete_event(id.clone(), app.state()).unwrap_err(),
        "digital_activity_readonly"
    );
    assert_eq!(
        crate::calendar_compat::start_task_block(
            "event".into(),
            id.clone(),
            None,
            None,
            app.state()
        )
        .unwrap_err(),
        "digital_activity_readonly"
    );
    assert_eq!(
        crate::calendar_compat::set_calendar_task_goal(
            "event".into(),
            id.clone(),
            None,
            app.state()
        )
        .unwrap_err(),
        "digital_activity_readonly"
    );
    assert_eq!(
        crate::calendar_compat::toggle_note_archive(id.clone(), app.state()).unwrap_err(),
        "digital_activity_readonly"
    );
    assert_eq!(
        crate::calendar_compat::update_event(
            id,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            app.state()
        )
        .unwrap_err(),
        "digital_activity_readonly"
    );
    assert_eq!(
        crate::calendar_compat::set_app_setting(SETTINGS_KEY.into(), "[]".into(), app.state())
            .unwrap_err(),
        "digital_activity_use_connection_command"
    );
}

#[test]
fn stale_pause_source_and_token_generation_cancel_success_and_error() {
    let mut conn = db();
    let old = cfg();
    for mode in 0..3 {
        let mut current = old.clone();
        match mode {
            0 => current.enabled = false,
            1 => current.source = "android".into(),
            _ => current.revision = Uuid::new_v4().to_string(),
        }
        store_cfg(&conn, &[current]);
        assert!(commit_reading(&mut conn, &old, Ok(reading()), true)
            .unwrap()
            .is_none());
        assert!(commit_reading(
            &mut conn,
            &old,
            Err("digital_activity_connection_failed".into()),
            true
        )
        .unwrap()
        .is_none());
    }
    assert_eq!(
        conn.query_row("SELECT count(*) FROM items", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM digital_activity_status", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn config_tokens_keep_clear_fail_closed_and_db_commit_failure_preserves_old_token() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.db");
    let mut conn = Connection::open(&path).unwrap();
    crate::init_schema(&conn).unwrap();
    let input = |id: Option<String>, token: Option<&str>| SaveConnectionInput {
        id,
        label: "Device".into(),
        port: 5600,
        endpoint: None,
        enabled: true,
        token: token.map(str::to_string),
        source: Some("windows".into()),
    };
    let id = save_connection(&mut conn, &path, input(None, Some("fixture-secret"))).unwrap();
    let read_token = |conn: &Connection| {
        token_for(
            &read_connections(conn).unwrap()[0],
            &read_secrets(&path).unwrap(),
        )
        .unwrap()
    };
    assert_eq!(read_token(&conn).as_deref(), Some("fixture-secret"));
    save_connection(&mut conn, &path, input(Some(id.clone()), None)).unwrap();
    assert_eq!(read_token(&conn).as_deref(), Some("fixture-secret"));
    conn.execute_batch("CREATE TRIGGER fail_config BEFORE UPDATE ON app_settings WHEN NEW.key='digital_activity_connections_v1' BEGIN SELECT RAISE(ABORT,'synthetic'); END;").unwrap();
    assert!(save_connection(
        &mut conn,
        &path,
        input(Some(id.clone()), Some("new-secret"))
    )
    .is_err());
    assert_eq!(read_token(&conn).as_deref(), Some("fixture-secret"));
    conn.execute_batch("DROP TRIGGER fail_config").unwrap();
    save_connection(&mut conn, &path, input(Some(id.clone()), Some(""))).unwrap();
    assert_eq!(read_token(&conn), None);
    assert!(read_secrets(&path).unwrap().is_empty());
    crate::mvp_sync::secrets::write_for(&path, SECRET_SERVICE, "not json").unwrap();
    assert!(save_connection(&mut conn, &path, input(Some(id), None)).is_err());
    assert_eq!(
        crate::mvp_sync::secrets::read_for(&path, SECRET_SERVICE)
            .unwrap()
            .as_deref(),
        Some("not json")
    );
    assert!(decode_secrets(Some("[]")).is_err());
    assert!(validate_id("*' injection").is_err());
    assert!(validate_endpoint("http://example.com", 5600).is_err());
    assert!(validate_endpoint("http://127.0.0.1:5600/x", 5600).is_err());
}

#[test]
fn manual_import_while_paused_and_pause_during_http() {
    // A manual request works without enabling the one-minute poller.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.db");
    let conn = Connection::open(&path).unwrap();
    crate::init_schema(&conn).unwrap();
    let (lo, _) = day_bounds(&Local, date()).unwrap();
    let (port, _, server_worker) = server(vec![
        metadata(false, false),
        api_events(&[window(lo, 120.0, "Reader")]),
    ]);
    let mut paused = cfg();
    paused.enabled = false;
    connect(&mut paused, port);
    store_cfg(&conn, &[paused]);
    let result = run_import(&path, None, &[date()], true).unwrap();
    server_worker.join().unwrap();
    assert_eq!(result["changed"], 1);
    assert_eq!(result["errors"], json!([]));
    let result = run_import(&path, None, &[date()], false).unwrap();
    assert_eq!(result["imported"], 0);

    // The HTTP request is already pending when a separate DB connection commits
    // a pause. Neither an event nor stale successful status may be committed.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let api_worker = std::thread::spawn(move || {
        for (index, body) in [
            metadata(false, false),
            api_events(&[window(lo, 500.0, "Changed")]),
        ]
        .into_iter()
        .enumerate()
        {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            stream.read(&mut buffer).unwrap();
            if index == 0 {
                started_tx.send(()).unwrap();
                resume_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            }
            let body = body.to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        }
    });
    let mut enabled = cfg();
    connect(&mut enabled, port);
    store_cfg(&conn, &[enabled.clone()]);
    let import_path = path.clone();
    let worker = std::thread::spawn(move || run_import(&import_path, None, &[date()], false));
    started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    enabled.enabled = false;
    enabled.revision = Uuid::new_v4().to_string();
    store_cfg(&conn, &[enabled]);
    resume_tx.send(()).unwrap();
    let result = worker.join().unwrap().unwrap();
    api_worker.join().unwrap();
    assert_eq!(result["skipped"], 1);
    assert_eq!(result["changed"], 0);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM items", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM items WHERE title LIKE '%Changed%'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn local_boundaries_use_each_dates_offset_not_current_fixed_offset() {
    // Controlled timezone with a spring offset transition. The actual importer
    // supplies Local to this same helper; a fixed current offset would yield 24h.
    #[derive(Clone)]
    struct Spring;
    impl TimeZone for Spring {
        type Offset = chrono::FixedOffset;
        fn from_offset(_: &Self::Offset) -> Self {
            Spring
        }
        fn offset_from_local_date(&self, day: &NaiveDate) -> chrono::MappedLocalTime<Self::Offset> {
            chrono::MappedLocalTime::Single(
                chrono::FixedOffset::east_opt(if *day > date() { 3600 } else { 0 }).unwrap(),
            )
        }
        fn offset_from_local_datetime(
            &self,
            dt: &chrono::NaiveDateTime,
        ) -> chrono::MappedLocalTime<Self::Offset> {
            self.offset_from_local_date(&dt.date())
        }
        fn offset_from_utc_date(&self, day: &NaiveDate) -> Self::Offset {
            self.offset_from_local_date(day).unwrap()
        }
        fn offset_from_utc_datetime(&self, dt: &chrono::NaiveDateTime) -> Self::Offset {
            self.offset_from_utc_date(&dt.date())
        }
    }
    let (lo, hi) = day_bounds(&Spring, date()).unwrap();
    assert_eq!(hi - lo, 23.0 * 3600.0);
    assert!(requested_days(Some("9999-01-01")).is_err());
}

#[test]
fn aggregate_sync_capture_applies_to_peer_without_config_or_raw_data() {
    let source = db();
    let peer = db();
    let cfg = cfg();
    store_cfg(&source, &[cfg.clone()]);
    project(&source, &cfg, &reading().aggregates).unwrap();
    let mut stmt = source
        .prepare("SELECT id,data,updated_at FROM mvp_records")
        .unwrap();
    let records:Vec<Value>=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"data":r.get::<_,String>(1)?,"updated_at":r.get::<_,String>(2)?}))).unwrap().map(Result::unwrap).collect();
    peer.execute("UPDATE content_sync_control SET applying=1", [])
        .unwrap();
    for mut record in records {
        record["_updated_at"] = record["updated_at"].clone();
        record["_device_id"] = json!(source
            .query_row(
                "SELECT device_id FROM sync_row_versions WHERE row_id=?1",
                [record["id"].as_str().unwrap()],
                |r| r.get::<_, String>(0)
            )
            .unwrap());
        crate::mvp_sync_db::validate_record(&peer, record.as_object().unwrap()).unwrap();
        crate::mvp_sync_db::apply_record(&peer, record.as_object().unwrap()).unwrap();
    }
    let id = format!("digital-activity:{}:{}", cfg.id, date());
    let result: (String, Option<String>, String) = peer
        .query_row(
            "SELECT title,time,tags FROM items WHERE id=?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert!(result.0.contains("Активность"));
    assert!(result.1.is_none());
    let mut decorated = json!({});
    decorate(&mut decorated, &id, &result.2);
    assert_eq!(decorated["readonly"], true);
    assert_eq!(decorated["activity_summary"]["active_seconds"], 60.5);
    assert!(read_connections(&peer).unwrap().is_empty());
}

#[test]
fn recurring_reflection_fields_survive_native_snapshot_and_sync_projection() {
    let conn = db();
    let raw=json!({"version":1,"plans":[{"id":"fixture","kind":"action","mode":"check","reflection":{"prompt":"Как прошёл отдых?"}}],
        "days":{"2026-01-15":{"fixture":{"snapshot":{"id":"fixture"},"reflection":{"ruleOutcome":"kept","restoration":"better","trigger":"fixture"}}}}}).to_string();
    crate::mvp_sync_db::set_ui(&conn, "calendar_recurring_v1", &raw, None).unwrap();
    let stored = crate::mvp_sync_db::read_ui(&conn, "calendar_recurring_v1")
        .unwrap()
        .unwrap();
    let parsed: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(
        parsed["plans"][0]["reflection"]["prompt"],
        "Как прошёл отдых?"
    );
    assert_eq!(
        parsed["days"]["2026-01-15"]["fixture"]["reflection"]["restoration"],
        "better"
    );
    let journal: String = conn
        .query_row("SELECT group_concat(data) FROM mvp_records", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(journal.contains("restoration"));
}

#[test]
fn disconnect_preserves_history_other_config_and_other_secret() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.db");
    let mut conn = Connection::open(&path).unwrap();
    crate::init_schema(&conn).unwrap();
    let input = |label: &str, token: &str| SaveConnectionInput {
        id: None,
        label: label.into(),
        port: 5600,
        endpoint: None,
        enabled: true,
        token: Some(token.into()),
        source: Some("windows".into()),
    };
    let first = save_connection(&mut conn, &path, input("First", "first-token")).unwrap();
    let second = save_connection(&mut conn, &path, input("Second", "second-token")).unwrap();
    let old = read_connections(&conn)
        .unwrap()
        .into_iter()
        .find(|v| v.id == first)
        .unwrap();
    commit_reading(&mut conn, &old, Ok(reading()), true).unwrap();
    remove_connection(&mut conn, &path, &first).unwrap();
    let configs = read_connections(&conn).unwrap();
    assert_eq!(configs.len(), 1);
    assert_eq!(configs[0].id, second);
    let secrets = read_secrets(&path).unwrap();
    assert_eq!(secrets.len(), 1);
    assert_eq!(
        token_for(&configs[0], &secrets).unwrap().as_deref(),
        Some("second-token")
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM items", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM digital_activity_status", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(commit_reading(&mut conn, &old, Ok(reading()), false)
        .unwrap()
        .is_none());
}

#[test]
fn pause_label_preserve_status_source_change_resets_verification_but_keeps_count() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.db");
    let mut conn = Connection::open(&path).unwrap();
    crate::init_schema(&conn).unwrap();
    let input = |id: Option<String>, enabled, source: &str, label: &str| SaveConnectionInput {
        id,
        label: label.into(),
        port: 5600,
        endpoint: None,
        enabled,
        token: None,
        source: Some(source.into()),
    };
    let id = save_connection(
        &mut conn,
        &path,
        input(None, true, "windows", &"я".repeat(100)),
    )
    .unwrap();
    let config = read_connections(&conn).unwrap().remove(0);
    commit_reading(&mut conn, &config, Ok(reading()), true).unwrap();
    save_connection(
        &mut conn,
        &path,
        input(Some(id.clone()), false, "windows", "Новое название"),
    )
    .unwrap();
    let success: Option<String> = conn
        .query_row(
            "SELECT last_success FROM digital_activity_status",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(success.is_some());
    save_connection(
        &mut conn,
        &path,
        input(Some(id.clone()), false, "android", "Телефон"),
    )
    .unwrap();
    let success: Option<String> = conn
        .query_row(
            "SELECT last_success FROM digital_activity_status",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(success.is_none());
    use tauri::Manager;
    let app = tauri::test::mock_builder()
        .manage(crate::AppState(StdMutex::new(conn)))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let status = digital_activity_status(app.state()).unwrap();
    assert_eq!(status["devices"][0]["records"], 1);
    assert!(!status["devices"][0]["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("active_seconds")));
}

#[test]
fn clearing_legacy_device_key_really_removes_secret() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.db");
    let mut conn = Connection::open(&path).unwrap();
    crate::init_schema(&conn).unwrap();
    let mut old = cfg();
    old.revision.clear();
    store_cfg(&conn, &[old.clone()]);
    crate::mvp_sync::secrets::write_for(
        &path,
        SECRET_SERVICE,
        &json!({old.id.clone():"legacy-secret"}).to_string(),
    )
    .unwrap();
    save_connection(
        &mut conn,
        &path,
        SaveConnectionInput {
            id: Some(old.id),
            label: "Device".into(),
            port: 5600,
            endpoint: None,
            enabled: true,
            token: Some(String::new()),
            source: Some("windows".into()),
        },
    )
    .unwrap();
    assert!(read_secrets(&path).unwrap().is_empty());
}
