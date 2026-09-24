use super::*;

fn config(device: &str) -> RelayConfig {
    RelayConfig {
        v: 1,
        profile: "hanni-mvp-content-v1".into(),
        endpoint: "https://example.invalid/".into(),
        device_id: device.into(),
        key_id: "synthetic_key".into(),
        token: B64.encode([7; 32]),
        key: B64.encode([8; 32]),
        enabled: true,
    }
}
fn replica(device: &str) -> (Connection, RelayConfig) {
    let mut conn = Connection::open_in_memory().unwrap();
    crate::init_schema(&conn).unwrap();
    conn.execute(
        "UPDATE app_settings SET value=?1 WHERE key='device_id'",
        [device],
    )
    .unwrap();
    let cfg = derive_config(&config(device)).unwrap();
    initialize(&mut conn, &cfg).unwrap();
    (conn, cfg)
}
fn row(conn: &Connection, id: &str) -> Row {
    let value = crate::mvp_sync_db::row_to_json(
        conn,
        "mvp_records",
        &rusqlite::types::Value::Text(id.into()),
    )
    .unwrap()
    .unwrap();
    let mut fields = value.as_object().unwrap().clone();
    let (stamp, writer): (String, String) = conn
        .query_row(
            "SELECT updated_at,device_id FROM sync_row_versions WHERE row_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    fields.insert("_updated_at".into(), json!(stamp));
    fields.insert("_device_id".into(), json!(writer));
    Row {
        t: "mvp_records".into(),
        f: fields,
    }
}
fn stored(cfg: &RelayConfig, rows: Vec<Row>, seq: i64, client_seq: i64) -> Stored {
    let batch = encrypt(
        cfg,
        &Payload {
            v: 1,
            kind: "changes".into(),
            applied_seq: 0,
            rows,
            tombs: vec![],
            fragment: None,
        },
        client_seq,
    )
    .unwrap();
    Stored {
        seq,
        client_seq,
        sender_device_id: cfg.device_id.clone(),
        batch_id: batch.batch_id,
        envelope_sha256: envelope_hash(&batch.envelope).unwrap(),
        envelope: batch.envelope,
    }
}
fn apply(conn: &mut Connection, cfg: &RelayConfig, item: Stored) -> Result<usize, String> {
    let seq = item.seq;
    apply_page(
        conn,
        cfg,
        seq - 1,
        Page {
            batches: vec![item],
            next_cursor: seq,
            latest_seq: seq,
            has_more: false,
        },
    )
}
fn task(conn: &Connection, id: &str, title: &str) {
    conn.execute("INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at) VALUES(?1,'task',?2,30,1,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')",params![id,title]).unwrap();
}

#[test]
fn profile_and_aad_are_separate_from_legacy() {
    let cfg = derive_config(&config("mac")).unwrap();
    let mut item = stored(&cfg, vec![], 1, 1);
    assert_eq!(cfg.endpoint, "https://example.invalid/content");
    item.sender_device_id = "phone".into();
    assert!(decrypt(&cfg, &item).is_err());
    let raw = serde_json::to_string(&config("mac"))
        .unwrap()
        .replace("hanni-mvp-content-v1", "hanni-content-sync-v1");
    assert!(RelayConfig::parse(&raw).is_err());
}
#[test]
fn independent_records_updates_and_deletes_converge() {
    let (mut a, ac) = replica("mac");
    let (mut b, bc) = replica("phone");
    task(&a, "first", "Original");
    task(&b, "second", "Other");
    let first = json!(["items", ["first"]]).to_string();
    let second = json!(["items", ["second"]]).to_string();
    apply(&mut b, &bc, stored(&ac, vec![row(&a, &first)], 1, 1)).unwrap();
    apply(&mut a, &ac, stored(&bc, vec![row(&b, &second)], 1, 1)).unwrap();
    assert_eq!(
        a.query_row("SELECT count(*) FROM items", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    a.execute(
        "UPDATE items SET title='Changed',version=version+1 WHERE id='first'",
        [],
    )
    .unwrap();
    apply(&mut b, &bc, stored(&ac, vec![row(&a, &first)], 2, 2)).unwrap();
    assert_eq!(
        b.query_row("SELECT title FROM items WHERE id='first'", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "Changed"
    );
    a.execute("DELETE FROM items WHERE id='first'", []).unwrap();
    apply(&mut b, &bc, stored(&ac, vec![row(&a, &first)], 3, 3)).unwrap();
    assert_eq!(
        b.query_row("SELECT count(*) FROM items WHERE id='first'", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(b
        .query_row("SELECT data FROM mvp_records WHERE id=?1", [first], |r| {
            r.get::<_, String>(0)
        })
        .unwrap()
        .contains("\"deleted\":true"));
}
#[test]
fn unknown_schema_and_corrupt_packet_preserve_cursor() {
    let (mut conn, cfg) = replica("mac");
    let peer = derive_config(&config("phone")).unwrap();
    let mut item = stored(&peer, vec![], 1, 1);
    item.envelope.ciphertext.push('A');
    assert!(apply(&mut conn, &cfg, item).is_err());
    let invalid = Row {
        t: "mvp_records".into(),
        f: Map::from_iter([("id".into(), json!("foreign"))]),
    };
    assert!(apply(&mut conn, &cfg, stored(&peer, vec![invalid], 1, 1)).is_err());
    assert_eq!(
        scalar(&conn, "SELECT receive_seq FROM content_sync_state").unwrap(),
        0
    );
}
#[test]
fn fragments_survive_reopen_and_apply_only_when_complete() {
    let (mut source, sc) = replica("mac");
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fragments.db");
    let mut target = Connection::open(&path).unwrap();
    crate::init_schema(&target).unwrap();
    let tc = derive_config(&config("phone")).unwrap();
    initialize(&mut target, &tc).unwrap();
    task(&source, "large", "Large note");
    source
        .execute(
            "UPDATE items SET notes=?1 WHERE id='large'",
            ["x".repeat(140_000)],
        )
        .unwrap();
    source
        .execute(
            "DELETE FROM content_sync_dirty WHERE row_id!=?1",
            [json!(["items", ["large"]]).to_string()],
        )
        .unwrap();
    let mut seq = 0;
    loop {
        if !enqueue(&mut source, &sc).unwrap() {
            break;
        }
        let batch: Batch = serde_json::from_str(
            &source
                .query_row("SELECT body FROM content_sync_outbox LIMIT 1", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
        )
        .unwrap();
        seq += 1;
        let item = Stored {
            seq,
            client_seq: batch.client_seq,
            sender_device_id: sc.device_id.clone(),
            batch_id: batch.batch_id,
            envelope_sha256: envelope_hash(&batch.envelope).unwrap(),
            envelope: batch.envelope,
        };
        apply(&mut target, &tc, item).unwrap();
        source
            .execute("DELETE FROM content_sync_outbox", [])
            .unwrap();
        if seq == 1 {
            assert_eq!(scalar(&target, "SELECT count(*) FROM items").unwrap(), 0);
            drop(target);
            target = Connection::open(&path).unwrap();
        }
        if seq > 10 {
            panic!("fragment drain did not finish");
        }
    }
    assert!(seq > 1);
    assert_eq!(
        target
            .query_row(
                "SELECT length(notes) FROM items WHERE id='large'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        140_000
    );
}
#[test]
fn legacy_integer_collision_is_quarantined_and_new_ids_are_safe() {
    let (a, ac) = replica("mac");
    let (mut b, bc) = replica("phone");
    for (conn, source) in [(&a, "one"), (&b, "two")] {
        conn.execute("INSERT INTO timeline_blocks(id,source_type,source_id,date,start_time,created_at,updated_at) VALUES(1,'note',?1,'2026-09-14','09:00:00','2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')",[source]).unwrap();
    }
    apply(
        &mut b,
        &bc,
        stored(
            &ac,
            vec![row(&a, &json!(["timeline_blocks", [1]]).to_string())],
            1,
            1,
        ),
    )
    .unwrap();
    assert_eq!(
        b.query_row(
            "SELECT source_id FROM timeline_blocks WHERE id=1",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "two"
    );
    assert_eq!(pending::count(&b).unwrap(), 1);
    let id = crate::mvp_sync_db::timeline_id(&b).unwrap();
    assert!((1_i64 << 52..1_i64 << 53).contains(&id));
}

fn ui_rows(conn: &Connection) -> Vec<Row> {
    let mut query = conn
        .prepare("SELECT id FROM mvp_records WHERE json_extract(data,'$.kind')='ui' ORDER BY id")
        .unwrap();
    let ids = query
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    ids.iter().map(|id| row(conn, id)).collect()
}
#[test]
fn concurrent_array_insertions_converge_and_removed_goal_leaves_no_meta() {
    let (a, ac) = replica("mac");
    let (b, bc) = replica("phone");
    for (conn, id) in [(&a, "skill-a"), (&b, "skill-b")] {
        let state = json!({"version":1,"goals":{"g":{"skills":[{"id":id,"title":id}],"stages":[],"focusId":null,"activeStageId":null}}});
        crate::mvp_sync_db::set_ui(
            conn,
            "calendar_development_v1",
            &state.to_string(),
            Some(""),
        )
        .unwrap();
    }
    let left = ui_rows(&a);
    let right = ui_rows(&b);
    let (mut a, mut b) = (a, b);
    apply(&mut a, &ac, stored(&bc, right, 1, 1)).unwrap();
    apply(&mut b, &bc, stored(&ac, left, 1, 1)).unwrap();
    let state = crate::mvp_sync_db::read_ui(&a, "calendar_development_v1")
        .unwrap()
        .unwrap();
    assert_eq!(
        crate::mvp_sync_db::read_ui(&b, "calendar_development_v1")
            .unwrap()
            .unwrap(),
        state
    );
    assert_eq!(
        serde_json::from_str::<Value>(&state).unwrap()["goals"]["g"]["skills"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    crate::mvp_sync_db::set_ui(
        &a,
        "calendar_development_v1",
        "{\"version\":1,\"goals\":{}}",
        Some(&state),
    )
    .unwrap();
    apply(&mut b, &bc, stored(&ac, ui_rows(&a), 2, 2)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(
            &crate::mvp_sync_db::read_ui(&b, "calendar_development_v1")
                .unwrap()
                .unwrap()
        )
        .unwrap()["goals"],
        json!({})
    );
}
fn wishes(conn: &Connection) -> Value {
    serde_json::from_str::<Value>(
        &crate::mvp_sync_db::read_ui(conn, "calendar_wishes_v1")
            .unwrap()
            .unwrap(),
    )
    .unwrap()
}
#[test]
fn wishes_sync_per_record_so_edits_on_two_devices_merge() {
    let (a, ac) = replica("mac");
    let (b, bc) = replica("phone");
    let wish = |id: &str, status: &str| json!({"id":id,"title":format!("Синтетическое желание {id}"),"category":"other","price":null,"currency":"KZT","url":"","note":"","status":status,"goalId":null});
    for (conn, id) in [(&a, "wish-a"), (&b, "wish-b")] {
        let state = json!({"version":1,"wishes":[wish(id, "want")]});
        crate::mvp_sync_db::set_ui(conn, "calendar_wishes_v1", &state.to_string(), Some(""))
            .unwrap();
    }
    assert_eq!(ui_rows(&a).len(), 1, "one record per wish");
    let (left, right) = (ui_rows(&a), ui_rows(&b));
    let (mut a, mut b) = (a, b);
    apply(&mut a, &ac, stored(&bc, right, 1, 1)).unwrap();
    apply(&mut b, &bc, stored(&ac, left, 1, 1)).unwrap();
    assert_eq!(wishes(&a), wishes(&b));
    assert_eq!(wishes(&a)["wishes"].as_array().unwrap().len(), 2);
    // Mac marks its wish as saving while the phone deletes the other one.
    let mut on_a = wishes(&a);
    for row in on_a["wishes"].as_array_mut().unwrap() {
        if row["id"] == "wish-a" {
            row["status"] = json!("saving");
        }
    }
    let before_a = crate::mvp_sync_db::read_ui(&a, "calendar_wishes_v1").unwrap();
    crate::mvp_sync_db::set_ui(
        &a,
        "calendar_wishes_v1",
        &on_a.to_string(),
        before_a.as_deref(),
    )
    .unwrap();
    let mut on_b = wishes(&b);
    on_b["wishes"]
        .as_array_mut()
        .unwrap()
        .retain(|row| row["id"] != "wish-b");
    let before_b = crate::mvp_sync_db::read_ui(&b, "calendar_wishes_v1").unwrap();
    crate::mvp_sync_db::set_ui(
        &b,
        "calendar_wishes_v1",
        &on_b.to_string(),
        before_b.as_deref(),
    )
    .unwrap();
    let (left, right) = (ui_rows(&a), ui_rows(&b));
    apply(&mut a, &ac, stored(&bc, right, 2, 2)).unwrap();
    apply(&mut b, &bc, stored(&ac, left, 2, 2)).unwrap();
    assert_eq!(wishes(&a), wishes(&b));
    assert_eq!(
        wishes(&a)["wishes"],
        json!([wish("wish-a", "saving")]),
        "the status edit and the deletion both survive"
    );
}
#[test]
fn malformed_wish_snapshots_are_rejected_before_any_record() {
    let (a, _) = replica("mac");
    for state in [
        json!({"version":1,"wishes":[{"id":"","title":"Без id"}]}),
        json!({"version":1,"wishes":[{"id":"same","title":"A"},{"id":"same","title":"B"}]}),
        json!({"version":2,"wishes":[]}),
        json!({"version":1,"wishes":{}}),
    ] {
        assert_eq!(
            crate::mvp_sync_db::set_ui(&a, "calendar_wishes_v1", &state.to_string(), Some(""))
                .unwrap_err(),
            "mvp_sync_invalid_snapshot"
        );
    }
    assert!(ui_rows(&a).is_empty());
    assert!(crate::mvp_sync_db::read_ui(&a, "calendar_wishes_v1")
        .unwrap()
        .is_none());
}
#[test]
fn generic_seed_does_not_create_a_false_conflict() {
    let (mut a, ac) = replica("mac");
    let (mut b, bc) = replica("phone");
    let key = json!(["event_categories", ["general"]]).to_string();
    let left = row(&a, &key);
    let right = row(&b, &key);
    apply(&mut a, &ac, stored(&bc, vec![right], 1, 1)).unwrap();
    apply(&mut b, &bc, stored(&ac, vec![left], 1, 1)).unwrap();
    assert_eq!(
        scalar(&a, "SELECT count(*) FROM mvp_sync_conflicts").unwrap(),
        0
    );
    assert_eq!(
        scalar(&b, "SELECT count(*) FROM mvp_sync_conflicts").unwrap(),
        0
    );
}
#[test]
fn remote_same_version_invalidates_an_open_local_form() {
    let (mut a, ac) = replica("mac");
    let (b, bc) = replica("phone");
    task(&a, "same", "Local");
    task(&b, "same", "Peer");
    a.execute(
        "UPDATE items SET version=2,title='Local edit' WHERE id='same'",
        [],
    )
    .unwrap();
    b.execute("UPDATE mvp_sync_meta SET clock=clock+10000", [])
        .unwrap();
    b.execute(
        "UPDATE items SET version=2,title='Peer edit' WHERE id='same'",
        [],
    )
    .unwrap();
    apply(
        &mut a,
        &ac,
        stored(
            &bc,
            vec![row(&b, &json!(["items", ["same"]]).to_string())],
            1,
            1,
        ),
    )
    .unwrap();
    assert_eq!(
        a.query_row("SELECT version FROM items WHERE id='same'", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert!(crate::complete(&mut a, "same", 2, true).is_err());
}
#[test]
fn wrong_primary_key_type_rejects_the_whole_page() {
    let (a, ac) = replica("mac");
    let (mut b, bc) = replica("phone");
    task(&a, "7", "Keep");
    let mut packet = row(&a, &json!(["items", ["7"]]).to_string());
    let mut data: Value = serde_json::from_str(packet.f["data"].as_str().unwrap()).unwrap();
    data["key"] = json!([7]);
    data["value"]["id"] = json!(7);
    packet
        .f
        .insert("id".into(), json!(json!(["items", [7]]).to_string()));
    packet.f.insert("data".into(), json!(data.to_string()));
    assert!(apply(&mut b, &bc, stored(&ac, vec![packet], 1, 1)).is_err());
    assert_eq!(
        scalar(&b, "SELECT receive_seq FROM content_sync_state").unwrap(),
        0
    );
}
fn goal(conn: &Connection, id: &str, parent: Option<&str>) {
    conn.execute("INSERT INTO calendar_goals(id,title,parent_goal_id,created_at,updated_at) VALUES(?1,?1,?2,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')",params![id,parent]).unwrap();
}
#[test]
fn concurrent_goal_cycles_and_dependent_deletions_are_quarantined() {
    let (a, ac) = replica("mac");
    let (mut b, bc) = replica("phone");
    for conn in [&a, &b] {
        goal(conn, "x", None);
        goal(conn, "y", None);
    }
    let b_clock: i64 = scalar(&b, "SELECT clock FROM mvp_sync_meta").unwrap();
    a.execute(
        "UPDATE mvp_sync_meta SET clock=MAX(clock,?1) WHERE id=1",
        [b_clock],
    )
    .unwrap();
    a.execute(
        "UPDATE calendar_goals SET parent_goal_id='y' WHERE id='x'",
        [],
    )
    .unwrap();
    b.execute(
        "UPDATE calendar_goals SET parent_goal_id='x' WHERE id='y'",
        [],
    )
    .unwrap();
    let goal_x_key = json!(["calendar_goals", ["x"]]).to_string();
    let a_stamp: String = a
        .query_row(
            "SELECT updated_at FROM sync_row_versions WHERE row_id=?1",
            [&goal_x_key],
            |r| r.get(0),
        )
        .unwrap();
    let b_stamp: String = b
        .query_row(
            "SELECT updated_at FROM sync_row_versions WHERE row_id=?1",
            [&goal_x_key],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        a_stamp > b_stamp,
        "A edit must be newer than B seed: {a_stamp} <= {b_stamp}"
    );
    apply(
        &mut b,
        &bc,
        stored(
            &ac,
            vec![row(&a, &json!(["calendar_goals", ["x"]]).to_string())],
            1,
            1,
        ),
    )
    .unwrap();
    assert_eq!(pending::count(&b).unwrap(), 1);
    assert_eq!(
        b.query_row(
            "SELECT parent_goal_id FROM calendar_goals WHERE id='x'",
            [],
            |r| r.get::<_, Option<String>>(0)
        )
        .unwrap(),
        None
    );
    a.execute("DELETE FROM calendar_goals WHERE id='x'", [])
        .unwrap();
    apply(
        &mut b,
        &bc,
        stored(
            &ac,
            vec![row(&a, &json!(["calendar_goals", ["x"]]).to_string())],
            2,
            2,
        ),
    )
    .unwrap();
    assert_eq!(
        scalar(&b, "SELECT count(*) FROM calendar_goals WHERE id='x'").unwrap(),
        1
    );
}
#[test]
fn retry_rotation_recovers_after_a_full_page_of_unresolved_parents() {
    let (a, _) = replica("mac");
    let (mut b, _) = replica("phone");
    for index in 0..129 {
        let id = format!("child-{index:03}");
        let parent = format!("parent-{index:03}");
        goal(&a, &id, Some(&parent));
        let row = row(&a, &json!(["calendar_goals", [&id]]).to_string());
        pending::put(
            &b,
            &pending::Pending {
                sender: "mac".into(),
                table_name: "mvp_records".into(),
                remote_id: row.f["id"].as_str().unwrap().into(),
                kind: "row".into(),
                stamp: row.f["updated_at"].as_str().unwrap().into(),
                payload: serde_json::to_string(&row).unwrap(),
                error_code: "content_sync_parent_missing".into(),
            },
        )
        .unwrap();
    }
    goal(&b, "parent-128", None);
    retry_pending(&mut b).unwrap();
    retry_pending(&mut b).unwrap();
    assert_eq!(
        scalar(
            &b,
            "SELECT count(*) FROM calendar_goals WHERE id='child-128'"
        )
        .unwrap(),
        1
    );
    assert_eq!(pending::count(&b).unwrap(), 128);
}
#[test]
fn capacity_error_and_outbox_survive_independent_pull_backoff() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic.db");
    let mut conn = Connection::open(&path).unwrap();
    crate::init_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO app_settings VALUES('content_sync_enabled','true','synthetic')",
        [],
    )
    .unwrap();
    let base = config("mac");
    let cfg = derive_config(&base).unwrap();
    initialize(&mut conn, &cfg).unwrap();
    task(&conn, "pending", "Queued");
    enqueue(&mut conn, &cfg).unwrap();
    let before: String = conn
        .query_row("SELECT body FROM content_sync_outbox", [], |r| r.get(0))
        .unwrap();
    conn.execute("UPDATE content_sync_state SET upload_not_before=?1,pull_not_before=?1,upload_error='content_sync_http_507',last_error='content_sync_http_507'",[chrono::Utc::now().timestamp()+3600]).unwrap();
    apply_page(
        &mut conn,
        &cfg,
        0,
        Page {
            batches: vec![],
            next_cursor: 0,
            latest_seq: 0,
            has_more: false,
        },
    )
    .unwrap();
    drop(conn);
    let result: Value = serde_json::from_str(
        &run_headless_once(
            path.to_str().unwrap(),
            &serde_json::to_string(&base).unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(result["error_code"], "content_sync_http_507");
    assert_eq!(result["pull_more"], false);
    let conn = Connection::open(path).unwrap();
    assert_eq!(
        conn.query_row("SELECT body FROM content_sync_outbox", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        before
    );
    assert_eq!(
        conn.query_row("SELECT last_success FROM mvp_sync_meta", [], |r| r
            .get::<_, Option<String>>(0))
            .unwrap(),
        None
    );
}
