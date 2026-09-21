use super::*;
use crate::mvp_sync_db;

fn fixture() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::init_schema(&conn).unwrap();
    conn
}

#[test]
fn credential_failure_is_shared_by_repeated_status_and_worker_reads() {
    let runtime = Runtime {
        path: PathBuf::from("unused-synthetic-profile"),
        config: Mutex::new(None),
        configuration: Mutex::new(()),
        signal: Arc::new(tokio::sync::Notify::new()),
        running: AtomicBool::new(false),
        pull_more: AtomicBool::new(true),
        last_error: Mutex::new(None),
        background_error: Mutex::new(None),
    };
    let calls = std::cell::Cell::new(0);
    for _ in 0..100 {
        let result = runtime.config_with(|_| {
            calls.set(calls.get() + 1);
            Err("mvp_sync_credentials_unavailable".into())
        });
        assert!(matches!(result, Err(e) if e == "mvp_sync_credentials_unavailable"));
    }
    assert_eq!(calls.get(), 1);
    *runtime.config.lock().unwrap() = Some(Ok(None));
    assert!(runtime
        .config_with(|_| panic!("must use saved configuration"))
        .unwrap()
        .is_none());
}

#[test]
fn migration_keeps_legacy_day_and_native_start_is_idempotent() {
    let conn = fixture();
    let raw=json!({"version":1,"entries":[{"id":"historical","started_at_utc":"2026-09-10T05:01:02.123Z"}]}).to_string();
    mvp_sync_db::set_ui(&conn, mvp_sync_db::DAY_KEY, &raw, None).unwrap();
    let first = mvp_sync_db::start_day(&conn).unwrap();
    let again = mvp_sync_db::start_day(&conn).unwrap();
    assert_eq!(first, again);
    assert!(first["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["started_at_utc"] == "2026-09-10T05:01:02.123Z"));
    mvp_sync_db::set_ui(&conn, mvp_sync_db::DAY_KEY, &raw, None).unwrap();
    assert_eq!(mvp_sync_db::day_ledger(&conn).unwrap(), first);
}
#[test]
fn cas_rejects_stale_snapshots_and_local_settings_never_enter_outbox() {
    let conn = fixture();
    let key = "calendar_development_v1";
    let first=json!({"version":1,"goals":{"goal":{"skills":[],"stages":[],"focusId":null,"activeStageId":null}}}).to_string();
    mvp_sync_db::set_ui(&conn, key, &first, Some("")).unwrap();
    assert_eq!(
        mvp_sync_db::set_ui(&conn, key, "{\"version\":1,\"goals\":{}}", Some("")).unwrap_err(),
        "mvp_sync_stale_ui_state"
    );
    assert_eq!(mvp_sync_db::read_ui(&conn, key).unwrap().unwrap(), first);
    mvp_sync_db::set_ui(&conn, "device_secret", "synthetic-secret", None).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM mvp_records WHERE data LIKE '%synthetic-secret%'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn legacy_v4_day_migration_is_atomic_and_repeatable() {
    let source = fixture();
    let legacy = Connection::open_in_memory().unwrap();
    let mut query=source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('items','calendar_goals','calendar_task_goals','event_categories','timeline_blocks','ui_state','app_settings')").unwrap();
    for schema in query.query_map([], |r| r.get::<_, String>(0)).unwrap() {
        legacy.execute_batch(&schema.unwrap()).unwrap();
    }
    legacy.execute_batch("PRAGMA user_version=4;").unwrap();
    legacy
        .execute(
            "INSERT INTO ui_state VALUES(?1,'not-json','unchanged')",
            [mvp_sync_db::DAY_KEY],
        )
        .unwrap();
    assert!(crate::init_schema(&legacy).is_err());
    assert_eq!(
        legacy
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        4
    );
    assert_eq!(
        mvp_sync_db::read_ui(&legacy, mvp_sync_db::DAY_KEY)
            .unwrap()
            .unwrap(),
        "not-json"
    );
    let raw=json!({"version":1,"entries":[{"id":"old-day","started_at_utc":"2026-09-12T12:34:56.789Z"}]}).to_string();
    legacy
        .execute(
            "UPDATE ui_state SET value=?1 WHERE key=?2",
            params![raw, mvp_sync_db::DAY_KEY],
        )
        .unwrap();
    crate::init_schema(&legacy).unwrap();
    let first = mvp_sync_db::day_ledger(&legacy).unwrap();
    crate::init_schema(&legacy).unwrap();
    assert_eq!(first, mvp_sync_db::day_ledger(&legacy).unwrap());
    assert_eq!(
        first["entries"][0]["started_at_utc"],
        "2026-09-12T12:34:56.789Z"
    );
    assert_eq!(
        legacy
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::SCHEMA_VERSION
    );
}

#[test]
#[ignore = "requires the isolated local workerd runner and synthetic configuration"]
fn mvp_sync_local_relay_roundtrip() {
    let configs = std::env::var_os("HANNI_MVP_TEST_RELAY_CONFIG_DIR")
        .expect("synthetic relay config directory");
    let configs = std::path::Path::new(&configs);
    let dir = tempfile::tempdir().unwrap();
    let mut paths = Vec::new();
    let mut raw = Vec::new();
    for name in ["mac", "windows", "phone"] {
        let config = std::fs::read_to_string(configs.join(format!("{name}.json"))).unwrap();
        RelayConfig::parse(&config).unwrap();
        let path = dir.path().join(format!("{name}.db"));
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        crate::init_schema(&conn).unwrap();
        enabled(&conn, true).unwrap();
        drop(conn);
        paths.push(path);
        raw.push(config);
    }
    let mac = Connection::open(&paths[0]).unwrap();
    mac.execute("INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at) VALUES('synthetic-task','task','Synthetic task',30,1,'2026-09-14T01:00:00Z','2026-09-14T01:00:00Z')",[]).unwrap();
    let day = mvp_sync_db::start_day(&mac).unwrap();
    drop(mac);
    let drain = |rounds: usize| {
        for _ in 0..rounds {
            for (i, path) in paths.iter().enumerate() {
                let result: Value = serde_json::from_str(
                    &transport::run_headless_once(path.to_str().unwrap(), &raw[i]).unwrap(),
                )
                .unwrap();
                assert_eq!(
                    result["error_code"], "none",
                    "synthetic native relay exchange failed"
                );
            }
        }
    };
    drain(12);
    let phone = Connection::open(&paths[2]).unwrap();
    assert_eq!(mvp_sync_db::day_ledger(&phone).unwrap(), day);
    assert_eq!(
        phone
            .query_row(
                "SELECT title FROM items WHERE id='synthetic-task'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "Synthetic task"
    );
    phone.execute("UPDATE items SET title='Offline phone edit',version=version+1 WHERE id='synthetic-task'",[]).unwrap();
    drop(phone);
    drain(8);
    let mac = Connection::open(&paths[0]).unwrap();
    assert_eq!(
        mac.query_row(
            "SELECT title FROM items WHERE id='synthetic-task'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "Offline phone edit"
    );
    mac.execute("DELETE FROM items WHERE id='synthetic-task'", [])
        .unwrap();
    drop(mac);
    drain(8);
    for path in paths {
        let conn = Connection::open(path).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM items WHERE id='synthetic-task'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(mvp_sync_db::day_ledger(&conn).unwrap(), day);
    }
}
