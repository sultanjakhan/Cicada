use super::*;

const DAY_START: i64 = 1_792_627_200_000; // 2026-10-22T00:00:00Z, fictional samples only.
fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    initialize(&conn).unwrap();
    conn
}
fn save(
    conn: &mut Connection,
    revision: u64,
    enabled: bool,
    names: &[&str],
) -> Result<Status, String> {
    configure_for_platform(
        conn,
        ConfigureRequest {
            expected_revision: revision,
            enabled,
            selected_executables: names.iter().map(|v| v.to_string()).collect(),
        },
        true,
    )
}
fn enabled_db() -> Connection {
    let mut c = db();
    save(&mut c, 0, true, &["game.exe", "other.exe"]).unwrap();
    c
}
fn sample(t: u64) -> Sample {
    Sample {
        utc_ms: DAY_START + t as i64,
        tick_ms: t + 100_000,
        awake_ms: t + 100_000,
        continuity: 0,
        executable: Some("game.exe".into()),
        idle_ms: 0,
        unlocked: true,
    }
}
fn feed(conn: &mut Connection, r: &mut Reducer, s: Sample) {
    tick(conn, r, |_| Ok(s), true).unwrap();
}
fn rows(conn: &Connection) -> Vec<Interval> {
    day(
        conn,
        DayRequest {
            date: "2026-10-22".into(),
            start_ms: DAY_START,
            end_ms: DAY_START + 86_400_000,
        },
    )
    .unwrap()
    .intervals
}
fn total(conn: &Connection) -> i64 {
    rows(conn).iter().map(|v| v.end_ms - v.start_ms).sum()
}

#[test]
fn defaults_off_never_call_source_and_no_retroactive_start() {
    let mut conn = db();
    let mut reducer = Reducer::default();
    assert!(!status(&conn).unwrap().enabled);
    tick(
        &mut conn,
        &mut reducer,
        |_| panic!("source must not run while opted out"),
        true,
    )
    .unwrap();
    save(&mut conn, 0, true, &["game.exe"]).unwrap();
    feed(&mut conn, &mut reducer, sample(50_000));
    assert_eq!(total(&conn), 0);
    feed(&mut conn, &mut reducer, sample(55_000));
    assert_eq!(total(&conn), 5_000);
}

#[test]
fn validates_whole_allowlist_before_mutation_and_rejects_paths() {
    let mut conn = db();
    for invalid in [
        "C:\\Games\\game.exe",
        "../game.exe",
        "file:///game.exe",
        "*.exe",
        "game.exe:secret",
        ".exe",
        "game.exe\nsecret",
        "con.exe",
        "LPT1.exe",
    ] {
        assert!(
            save(&mut conn, 0, true, &["good.exe", invalid]).is_err(),
            "{invalid}"
        );
        assert_eq!(status(&conn).unwrap().revision, 0);
    }
    assert!(save(&mut conn, 0, true, &[]).is_err());
    let saved = save(&mut conn, 0, true, &[" GAME.EXE ", "game.exe"]).unwrap();
    assert_eq!(saved.selected_executables, ["game.exe"]);
    assert!(save(&mut conn, 0, false, &[]).is_err());
    assert!(status(&conn).unwrap().enabled);
}

#[test]
fn unsupported_platform_never_enables_collection() {
    let mut conn = db();
    assert!(configure_for_platform(
        &mut conn,
        ConfigureRequest {
            expected_revision: 0,
            enabled: true,
            selected_executables: vec!["game.exe".into()]
        },
        false
    )
    .is_err());
    assert_eq!(status(&conn).unwrap().revision, 0);
}

#[test]
fn app_switches_and_unselected_sources_do_not_bridge() {
    let mut conn = enabled_db();
    let mut r = Reducer::default();
    feed(&mut conn, &mut r, sample(0));
    feed(&mut conn, &mut r, sample(5_000));
    let mut other = sample(10_000);
    other.executable = Some("other.exe".into());
    feed(&mut conn, &mut r, other);
    feed(&mut conn, &mut r, sample(15_000));
    let mut unknown = sample(20_000);
    unknown.executable = None;
    feed(&mut conn, &mut r, unknown);
    feed(&mut conn, &mut r, sample(25_000));
    feed(&mut conn, &mut r, sample(30_000));
    assert_eq!(total(&conn), 10_000);
    assert!(rows(&conn).iter().all(|v| v.executable == "game.exe"));
}

#[test]
fn idle_lock_and_intermittent_desktop_switch_never_bridge() {
    for kind in ["idle", "locked", "hook"] {
        let mut conn = enabled_db();
        let mut r = Reducer::default();
        feed(&mut conn, &mut r, sample(0));
        let mut gap = sample(5_000);
        match kind {
            "idle" => gap.idle_ms = 60_000,
            "locked" => gap.unlocked = false,
            _ => gap.continuity = 1,
        }
        feed(&mut conn, &mut r, gap);
        let mut next = sample(10_000);
        if kind == "hook" {
            next.continuity = 1;
        }
        feed(&mut conn, &mut r, next);
        // Hook transition may start a new edge at5s but cannot count the prior gap.
        assert_eq!(total(&conn), if kind == "hook" { 5_000 } else { 0 });
    }
}

#[test]
fn suspend_clock_changes_and_long_sampling_gaps_never_bridge() {
    for kind in ["suspend", "clock", "long", "reverse"] {
        let mut conn = enabled_db();
        let mut r = Reducer::default();
        feed(&mut conn, &mut r, sample(0));
        let mut gap = sample(5_000);
        match kind {
            "suspend" => gap.awake_ms -= 1_000,
            "clock" => gap.utc_ms += 1_000,
            "long" => gap = sample(30_000),
            _ => gap.tick_ms = 0,
        }
        feed(&mut conn, &mut r, gap);
        assert_eq!(total(&conn), 0, "{kind}");
    }
}

#[test]
fn failures_leave_unknown_and_recovery_starts_fresh() {
    let mut conn = enabled_db();
    let mut r = Reducer::default();
    feed(&mut conn, &mut r, sample(0));
    tick(
        &mut conn,
        &mut r,
        |_| Err("private source detail must not leak".into()),
        true,
    )
    .unwrap();
    assert_eq!(
        status(&conn).unwrap().last_error.as_deref(),
        Some("personal_activity_source_unavailable")
    );
    assert!(!status(&conn).unwrap().running);
    feed(&mut conn, &mut r, sample(5_000));
    assert_eq!(total(&conn), 0);
    feed(&mut conn, &mut r, sample(10_000));
    assert_eq!(total(&conn), 5_000);
}

#[test]
fn storage_failure_does_not_advance_pending_reducer_or_heartbeat() {
    let mut conn = enabled_db();
    let mut r = Reducer::default();
    feed(&mut conn, &mut r, sample(0));
    conn.execute_batch("CREATE TRIGGER fail_interval BEFORE INSERT ON personal_activity_intervals BEGIN SELECT RAISE(ABORT,'fictional failure'); END;").unwrap();
    assert!(tick(&mut conn, &mut r, |_| Ok(sample(5_000)), true).is_err());
    assert!(r.previous.is_none());
    assert_eq!(status(&conn).unwrap().last_sample_ms, Some(DAY_START));
    conn.execute_batch("DROP TRIGGER fail_interval;").unwrap();
    feed(&mut conn, &mut r, sample(6_000));
    assert_eq!(total(&conn), 0);
    feed(&mut conn, &mut r, sample(11_000));
    assert_eq!(total(&conn), 5_000);
}

#[test]
fn heartbeat_failure_rolls_back_interval_and_resets_reducer() {
    let mut conn = enabled_db();
    let mut r = Reducer::default();
    feed(&mut conn, &mut r, sample(0));
    conn.execute_batch("CREATE TRIGGER fail_heartbeat BEFORE UPDATE ON personal_activity_config BEGIN SELECT RAISE(ABORT,'fictional failure'); END;").unwrap();
    assert!(tick(&mut conn, &mut r, |_| Ok(sample(5_000)), true).is_err());
    assert_eq!(total(&conn), 0);
    assert!(r.previous.is_none());
}

#[test]
fn revocation_preserves_history_but_never_bridges_revision_or_restart() {
    let mut conn = enabled_db();
    let mut r = Reducer::default();
    feed(&mut conn, &mut r, sample(0));
    feed(&mut conn, &mut r, sample(5_000));
    save(&mut conn, 1, false, &["game.exe"]).unwrap();
    tick(
        &mut conn,
        &mut r,
        |_| panic!("disabled must not sample"),
        true,
    )
    .unwrap();
    assert_eq!(total(&conn), 5_000);
    save(&mut conn, 2, true, &["game.exe"]).unwrap();
    feed(&mut conn, &mut r, sample(6_000));
    assert_eq!(total(&conn), 5_000);
    let mut restart = Reducer::default();
    feed(&mut conn, &mut restart, sample(7_000));
    assert_eq!(total(&conn), 5_000);
    save(&mut conn, 3, true, &["other.exe"]).unwrap();
    feed(&mut conn, &mut restart, sample(8_000));
    assert_eq!(total(&conn), 5_000);
}

#[test]
fn midnight_clips_intervals_and_repeated_retrieval_is_readonly() {
    let mut conn = enabled_db();
    let mut r = Reducer::default();
    let mut before = sample(0);
    before.utc_ms = DAY_START - 2_000;
    let mut after = sample(5_000);
    after.utc_ms = DAY_START + 3_000;
    feed(&mut conn, &mut r, before);
    feed(&mut conn, &mut r, after);
    let first = rows(&conn);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].start_ms, DAY_START);
    assert_eq!(first[0].end_ms, DAY_START + 3_000);
    assert_eq!(first, rows(&conn));
    let actual: i64 = conn
        .query_row(
            "SELECT end_ms-start_ms FROM personal_activity_intervals",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(actual, 5_000);
}

#[test]
fn bounded_day_supports_dst_but_rejects_invalid_and_huge_ranges() {
    let conn = db();
    for hours in [23, 24, 25] {
        assert!(day(
            &conn,
            DayRequest {
                date: "2026-10-22".into(),
                start_ms: DAY_START,
                end_ms: DAY_START + hours * 3_600_000
            }
        )
        .is_ok());
    }
    for (date, end) in [
        ("2026-02-30", DAY_START + 86_400_000),
        ("2026-10-22", i64::MAX),
        ("2026-10-22", DAY_START),
    ] {
        assert!(day(
            &conn,
            DayRequest {
                date: date.into(),
                start_ms: DAY_START,
                end_ms: end
            }
        )
        .is_err());
    }
}

#[test]
fn persistence_identity_stable_and_chunks_bounded() {
    let mut conn = enabled_db();
    let identity = status(&conn).unwrap().device_id;
    initialize(&conn).unwrap();
    assert_eq!(identity, status(&conn).unwrap().device_id);
    let mut r = Reducer::default();
    for n in 0..=30 {
        feed(&mut conn, &mut r, sample(n * 5_000));
    }
    assert_eq!(total(&conn), 150_000);
    assert_eq!(rows(&conn).len(), 3);
    assert!(rows(&conn)
        .iter()
        .all(|v| v.device_id == identity && v.end_ms - v.start_ms <= 60_000));
}

#[test]
fn corrupt_stored_config_never_calls_source_or_returns_known_zero() {
    let mut conn = enabled_db();
    let mut r = Reducer::default();
    feed(&mut conn, &mut r, sample(0));
    conn.execute(
        "UPDATE personal_activity_config SET executables='[\"C:\\\\private\\\\game.exe\"]'",
        [],
    )
    .unwrap();
    assert!(tick(
        &mut conn,
        &mut r,
        |_| panic!("corrupt settings must not sample"),
        true
    )
    .is_err());
    assert!(r.previous.is_none());
    assert!(status(&conn).is_err());
    assert!(day(
        &conn,
        DayRequest {
            date: "2026-10-22".into(),
            start_ms: DAY_START,
            end_ms: DAY_START + 86_400_000
        }
    )
    .is_err());
}

#[test]
fn serialization_preserves_utc_bounds_and_has_no_path_or_window_fields() {
    let conn = db();
    let value = serde_json::to_value(status(&conn).unwrap()).unwrap();
    assert_eq!(value["storageScope"], "local");
    assert_eq!(value["controllerSupported"], false);
    assert!(value.get("windowTitle").is_none());
    assert!(value.get("path").is_none());
    let v = serde_json::to_value(Interval {
        id: "fictional".into(),
        device_id: "fictional".into(),
        executable: "game.exe".into(),
        start_ms: DAY_START,
        end_ms: DAY_START + 5_000,
    })
    .unwrap();
    assert_eq!(v["startMs"], DAY_START);
    assert_eq!(v["endMs"], DAY_START + 5_000);
}

#[test]
fn corrupt_interval_is_an_error_and_never_exposes_a_private_path() {
    let conn = db();
    let identity = status(&conn).unwrap().device_id;
    conn.execute(
        "INSERT INTO personal_activity_intervals VALUES(?1,?2,?3,?4,?5)",
        params![
            Uuid::new_v4().to_string(),
            identity,
            "C:\\private\\game.exe",
            DAY_START,
            DAY_START + 5_000
        ],
    )
    .unwrap();
    let error = day(
        &conn,
        DayRequest {
            date: "2026-10-22".into(),
            start_ms: DAY_START,
            end_ms: DAY_START + 86_400_000,
        },
    )
    .unwrap_err();
    assert!(!error.contains("private"));
}

#[test]
fn running_requires_fresh_success_and_source_failures_are_unknown() {
    let mut conn = enabled_db();
    let mut r = Reducer::default();
    let mut current = sample(0);
    current.utc_ms = Utc::now().timestamp_millis();
    let now = current.utc_ms;
    feed(&mut conn, &mut r, current);
    assert!(read_status(&conn, true, now).unwrap().running);
    assert!(!read_status(&conn, true, now + 12_001).unwrap().running);
    assert!(!read_status(&conn, true, now - 1).unwrap().running);
    tick(&mut conn, &mut r, |_| Err("failure".into()), true).unwrap();
    let state = read_status(&conn, true, now).unwrap();
    assert!(!state.running);
    assert_eq!(state.last_sample_ms, None);
    assert_eq!(
        state.last_error.as_deref(),
        Some("personal_activity_source_unavailable")
    );
}
