use super::*;
use crate::mvp_sync_db;

#[cfg(target_os = "macos")]
fn private_config() -> String {
    json!({"v":1,"profile":"hanni-mvp-content-v1","endpoint":"https://example.invalid/",
        "device_id":"synthetic-mac","key_id":"synthetic-group","token":B64.encode([1;32]),
        "key":B64.encode([2;32]),"enabled":true}).to_string()
}
#[cfg(target_os = "macos")]
fn private_profile() -> (tempfile::TempDir, PathBuf, Connection, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let physical = root.path().canonicalize().unwrap();
    let database = physical.join("calendar.db");
    let conn = Connection::open(&database).unwrap();
    crate::init_schema(&conn).unwrap();
    let input = physical.join("input.json");
    std::fs::write(&input, private_config()).unwrap();
    std::fs::set_permissions(&input, std::fs::Permissions::from_mode(0o600)).unwrap();
    let scope = transport::derive_config(&RelayConfig::parse(&private_config()).unwrap()).unwrap();
    let hash = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(serde_json::to_vec(&json!([scope.endpoint,scope.device_id,scope.key_id,scope.key])).unwrap()));
    conn.execute_batch("CREATE TABLE content_sync_state(id INTEGER PRIMARY KEY,scope TEXT,receive_seq INTEGER);").unwrap();
    conn.execute("INSERT INTO content_sync_state VALUES(1,?1,123)", [hash]).unwrap();
    (root, database, conn, input)
}
#[cfg(target_os = "macos")]
#[test]
fn wrong_scope_invalid_config_and_unsafe_file_cannot_partially_select_private_storage() {
    use std::os::unix::fs::PermissionsExt;
    for change in ["sender", "group", "key", "endpoint", "unknown-field", "unsafe"] {
        let (root, database, conn, input) = private_profile();
        let before = db::get_setting_checked(&conn, "content_sync_enabled").unwrap();
        let mut value: Value = serde_json::from_str(&private_config()).unwrap();
        match change {
            "sender" => value["device_id"] = json!("another-sender"),
            "group" => value["key_id"] = json!("another-group"),
            "key" => value["key"] = json!(B64.encode([9;32])),
            "endpoint" => value["endpoint"] = json!("https://another.invalid/"),
            "unknown-field" => value["unexpected"] = json!(true),
            "unsafe" => std::fs::set_permissions(&input, std::fs::Permissions::from_mode(0o644)).unwrap(),
            _ => unreachable!(),
        }
        std::fs::write(&input, value.to_string()).unwrap();
        assert!(configure_private_file(&conn, &database, &input).is_err(), "{change}");
        assert!(!root.path().join(".cicada-sync-backend.json").exists());
        assert!(!root.path().join(".cicada-sync-private").exists());
        assert_eq!(db::get_setting_checked(&conn, "content_sync_enabled").unwrap(), before);
        assert_eq!(conn.query_row("SELECT receive_seq FROM content_sync_state", [], |r| r.get::<_, i64>(0)).unwrap(), 123);
    }
}
#[cfg(target_os = "macos")]
#[test]
fn private_configuration_and_relocation_keep_the_same_sender_scope_and_queues() {
    use std::os::unix::fs::DirBuilderExt;
    let (root, database, conn, input) = private_profile();
    configure_private_file(&conn, &database, &input).unwrap();
    assert_eq!(secrets::storage_kind(&database).unwrap(), "private_file");
    assert_eq!(RelayConfig::parse(&secrets::read(&database).unwrap().unwrap()).unwrap().device_id, "synthetic-mac");
    assert_eq!(conn.query_row("SELECT receive_seq FROM content_sync_state", [], |r| r.get::<_, i64>(0)).unwrap(), 123);
    let expected = secrets::read(&database).unwrap();
    drop(conn);
    let target = tempfile::tempdir().unwrap();
    let target_db = target.path().join("calendar.db");
    std::fs::copy(&database, &target_db).unwrap();
    std::fs::copy(root.path().join(".cicada-sync-backend.json"), target.path().join(".cicada-sync-backend.json")).unwrap();
    std::fs::DirBuilder::new().mode(0o700).create(target.path().join(".cicada-sync-private")).unwrap();
    std::fs::copy(root.path().join(".cicada-sync-private/pairing.json"), target.path().join(".cicada-sync-private/pairing.json")).unwrap();
    assert!(private_file::selected(&target_db).is_err(), "a copied source marker is not a target binding");
    relocate_credentials(&database, &target_db).unwrap();
    assert_eq!(secrets::read(&target_db).unwrap(), expected);
    assert_eq!(secrets::storage_kind(&target_db).unwrap(), "private_file");
    let moved = Connection::open(&target_db).unwrap();
    assert_eq!(moved.query_row("SELECT receive_seq FROM content_sync_state", [], |r| r.get::<_, i64>(0)).unwrap(), 123);
}

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
