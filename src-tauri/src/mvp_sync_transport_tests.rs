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

fn recurring_state(plan_mode: &str, title: &str) -> Value {
    json!({
        "version":1,
        "plans":[
            {"id":"graph-plan","title":title,"mode":plan_mode,"steps":[{"title":"Step"}]},
            {"id":"legacy-plan","title":"Legacy","mode":"chain","steps":[{"title":"Old step"}]}
        ],
        "days":{
            "2026-09-28":{
                "graph-plan":{"id":"graph-plan","snapshot":{"id":"graph-plan","title":title,"mode":plan_mode,"steps":[{"title":"Step"}]}},
                "legacy-plan":{"id":"legacy-plan","snapshot":{"id":"legacy-plan","title":"Legacy","mode":"chain","steps":[{"title":"Old step"}]}}
            }
        }
    })
}

fn recurring_version(conn: &Connection, record_id: &str) -> u8 {
    let data: String = conn
        .query_row("SELECT data FROM mvp_records WHERE id=?1", [record_id], |r| r.get(0))
        .unwrap();
    serde_json::from_str::<Value>(&data).unwrap()["v"].as_u64().unwrap() as u8
}

#[test]
fn goal_lifecycle_roundtrips_and_legacy_metadata_cannot_strip_it() {
    let (a, ac) = replica("goal-source");
    let (mut b, bc) = replica("goal-receiver");
    let key = "calendar_development_v1";
    let id = json!(["ui",[key,"g","meta"]]).to_string();
    let state = json!({"version":1,"goals":{"g":{"goalStatus":"achieved","achievedAt":"2026-10-04T12:00:00Z","achievement":"Checked result","numericProgress":true,"skills":[{"id":"s","title":"Skill","topic":"Topic","evidence":"Kept"}],"stages":[],"focusId":null,"activeStageId":null}}});
    crate::mvp_sync_db::set_ui(&a,key,&state.to_string(),None).unwrap();
    assert_eq!(recurring_version(&a,&id),2);
    apply(&mut b,&bc,stored(&ac,ui_rows(&a),1,1)).unwrap();
    let read = || serde_json::from_str::<Value>(&crate::mvp_sync_db::read_ui(&b,key).unwrap().unwrap()).unwrap();
    assert_eq!(read(),state);
    // Simulate a queued v1 write from before upgrade, newer even by timestamp.
    let mut legacy = row(&a,&id);
    let mut record: Value = serde_json::from_str(legacy.f["data"].as_str().unwrap()).unwrap();
    record["v"] = json!(1);
    record["value"] = json!({"focusId":null,"activeStageId":null});
    legacy.f["data"] = json!(record.to_string());
    legacy.f["updated_at"] = json!("2030-01-01T00:00:00.000Z");
    legacy.f["_updated_at"] = legacy.f["updated_at"].clone();
    legacy.f["_device_id"] = json!("legacy-device");
    apply(&mut b,&bc,stored(&ac,vec![legacy],2,2)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&crate::mvp_sync_db::read_ui(&b,key).unwrap().unwrap()).unwrap(),state);
    assert_eq!(recurring_version(&b,&id),2);
    assert_eq!(scalar(&b,"SELECT count(*) FROM mvp_sync_conflicts").unwrap(),1);
    crate::mvp_sync_db::set_ui(&a,key,"{\"version\":1,\"goals\":{}}",None).unwrap();
    assert_eq!(recurring_version(&a,&id),2,"deletion retains the upgrade gate");
}

#[test]
fn unknown_goal_meta_version_preserves_receive_cursor_and_page() {
    let (a, ac) = replica("goal-source");
    let (mut b, bc) = replica("goal-receiver");
    task(&a,"t","Synthetic task");
    crate::mvp_sync_db::set_ui(&a,"calendar_development_v1",&json!({"version":1,"goals":{"g":{"goalStatus":"achieved","skills":[],"stages":[]}}}).to_string(),None).unwrap();
    let mut meta = ui_rows(&a).remove(0);
    let mut record: Value = serde_json::from_str(meta.f["data"].as_str().unwrap()).unwrap();
    assert_eq!(record["v"],2);
    // A pre-upgrade decoder accepts v1 and recurrence v2 only. This exact new
    // metadata identity fails that predicate; simulate its unknown-version path.
    assert!(!(record["v"] == 1 || (record["v"] == 2 && record["key"][0] == "calendar_recurring_v1")));
    record["v"] = json!(3);
    meta.f["data"] = json!(record.to_string());
    assert_eq!(apply(&mut b,&bc,stored(&ac,vec![row(&a,&json!(["items",["t"]]).to_string()),meta],1,1)).unwrap_err(),"content_sync_unknown_schema");
    assert_eq!(scalar(&b,"SELECT receive_seq FROM content_sync_state").unwrap(),0);
    assert_eq!(scalar(&b,"SELECT count(*) FROM items WHERE id='t'").unwrap(),0);
    assert!(crate::mvp_sync_db::read_ui(&b,"calendar_development_v1").unwrap().is_none());
}

#[test]
fn graph_records_are_v2_and_that_identity_stays_v2_after_graph_is_edited_away() {
    let (conn, _) = replica("graph-version");
    crate::mvp_sync_db::set_ui(
        &conn,
        "calendar_recurring_v1",
        &recurring_state("graph", "Graph" ).to_string(),
        None,
    )
    .unwrap();

    let graph_plan = json!(["ui", ["calendar_recurring_v1", "plans", "graph-plan"]]).to_string();
    let graph_day = json!(["ui", ["calendar_recurring_v1", "days", "2026-09-28", "graph-plan"]]).to_string();
    let legacy_plan = json!(["ui", ["calendar_recurring_v1", "plans", "legacy-plan"]]).to_string();
    let legacy_day = json!(["ui", ["calendar_recurring_v1", "days", "2026-09-28", "legacy-plan"]]).to_string();
    assert_eq!(recurring_version(&conn, &graph_plan), 2);
    assert_eq!(recurring_version(&conn, &graph_day), 2);
    assert_eq!(recurring_version(&conn, &legacy_plan), 1);
    assert_eq!(recurring_version(&conn, &legacy_day), 1);

    crate::mvp_sync_db::set_ui(
        &conn,
        "calendar_recurring_v1",
        &json!({"version":1,"plans":[{"id":"legacy-plan","title":"Legacy","mode":"chain","steps":[{"title":"Old step"}]}],"days":{"2026-09-28":{"legacy-plan":{"id":"legacy-plan","snapshot":{"id":"legacy-plan","title":"Legacy","mode":"chain","steps":[{"title":"Old step"}]}}}}}).to_string(),
        None,
    )
    .unwrap();
    for id in [&graph_plan, &graph_day] {
        let data: Value = serde_json::from_str(
            &conn.query_row("SELECT data FROM mvp_records WHERE id=?1", [id], |r| r.get::<_, String>(0)).unwrap(),
        ).unwrap();
        assert_eq!(data["v"], 2, "tombstones retain the upgraded identity version");
        assert_eq!(data["deleted"], true);
    }

    crate::mvp_sync_db::set_ui(
        &conn,
        "calendar_recurring_v1",
        &recurring_state("chain", "Edited chain").to_string(),
        None,
    )
    .unwrap();
    assert_eq!(recurring_version(&conn, &graph_plan), 2);
    assert_eq!(recurring_version(&conn, &graph_day), 2);
    assert_eq!(recurring_version(&conn, &legacy_plan), 1);
    assert_eq!(recurring_version(&conn, &legacy_day), 1);
}

#[test]
fn graph_version_is_decided_per_plan_and_run_snapshot() {
    for (plan_mode, run_mode, plan_version, run_version) in [("chain", "graph", 1, 2), ("graph", "chain", 2, 1)] {
        let (conn, _) = replica("mixed-graph-version");
        let mut state = recurring_state(plan_mode, "Mixed versions");
        state["days"]["2026-09-28"]["graph-plan"]["snapshot"]["mode"] = json!(run_mode);
        crate::mvp_sync_db::set_ui(&conn, "calendar_recurring_v1", &state.to_string(), None).unwrap();
        let plan = json!(["ui", ["calendar_recurring_v1", "plans", "graph-plan"]]).to_string();
        let run = json!(["ui", ["calendar_recurring_v1", "days", "2026-09-28", "graph-plan"]]).to_string();
        assert_eq!(recurring_version(&conn, &plan), plan_version);
        assert_eq!(recurring_version(&conn, &run), run_version);
    }
}

#[test]
fn initialize_upgrades_historical_local_graph_envelopes_and_queues_them() {
    let (conn, _) = replica("graph-migration");
    crate::mvp_sync_db::set_ui(
        &conn,
        "calendar_recurring_v1",
        &recurring_state("graph", "Graph").to_string(),
        None,
    )
    .unwrap();
    let graph_plan = json!(["ui", ["calendar_recurring_v1", "plans", "graph-plan"]]).to_string();
    let graph_day = json!(["ui", ["calendar_recurring_v1", "days", "2026-09-28", "graph-plan"]]).to_string();
    let before: (String, String) = conn
        .query_row(
            "SELECT updated_at,device_id FROM sync_row_versions WHERE row_id=?1",
            [&graph_plan],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let before_record: Value = serde_json::from_str(
        &conn.query_row("SELECT data FROM mvp_records WHERE id=?1", [&graph_plan], |r| r.get::<_, String>(0)).unwrap(),
    ).unwrap();
    for id in [&graph_plan, &graph_day] {
        let mut data: Value = serde_json::from_str(
            &conn
                .query_row("SELECT data FROM mvp_records WHERE id=?1", [id], |r| r.get::<_, String>(0))
                .unwrap(),
        )
        .unwrap();
        data["v"] = json!(1);
        conn.execute("UPDATE mvp_records SET data=?1 WHERE id=?2", params![data.to_string(), id])
            .unwrap();
    }
    conn.execute(
        "DELETE FROM content_sync_dirty WHERE row_id IN (?1,?2)",
        params![graph_plan, graph_day],
    )
    .unwrap();

    crate::mvp_sync_db::initialize(&conn).unwrap();

    assert_eq!(recurring_version(&conn, &graph_plan), 2);
    assert_eq!(recurring_version(&conn, &graph_day), 2);
    let after: (String, String, String) = conn
        .query_row(
            "SELECT r.updated_at,v.device_id,r.data FROM mvp_records r JOIN sync_row_versions v ON v.row_id=r.id WHERE r.id=?1",
            [&graph_plan],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    let promoted: Value = serde_json::from_str(&after.2).unwrap();
    assert_eq!(promoted["parent"], before.0);
    assert_eq!(promoted["parent_writer"], before.1);
    assert!(after.0 > before.0);
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM content_sync_dirty WHERE row_id IN (?1,?2)",
            params![graph_plan, graph_day],
            |r| r.get::<_, i64>(0),
        )
        .unwrap(),
        2
    );
    let mut ancestor = before_record;
    ancestor["v"] = json!(1);
    ancestor["value"]["row"]["title"] = json!("Older divergent payload");
    let ancestor_fields = json!({
        "id":graph_plan,
        "data":ancestor.to_string(),
        "updated_at":before.0,
        "_updated_at":before.0,
        "_device_id":before.1
    });
    assert!(!crate::mvp_sync_db::apply_record(&conn, ancestor_fields.as_object().unwrap()).unwrap());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM mvp_sync_conflicts", [], |r| r.get::<_, i64>(0)).unwrap(),
        0,
        "a known pre-upgrade ancestor is not a divergence"
    );
}

#[test]
fn stale_v1_recurring_edit_and_delete_are_quarantined_and_cursor_advances() {
    let (mut receiver, receiver_cfg) = replica("receiver");
    crate::mvp_sync_db::set_ui(
        &receiver,
        "calendar_recurring_v1",
        &recurring_state("graph", "Local graph").to_string(),
        None,
    )
    .unwrap();
    let id = json!(["ui", ["calendar_recurring_v1", "plans", "graph-plan"]]).to_string();
    let mut stale = row(&receiver, &id);
    let mut record: Value = serde_json::from_str(stale.f["data"].as_str().unwrap()).unwrap();
    record["v"] = json!(1);
    stale.f["data"] = json!(record.to_string());
    stale.f["updated_at"] = json!("2026-09-28T12:00:00.000Z");
    stale.f["_updated_at"] = stale.f["updated_at"].clone();
    stale.f["_device_id"] = json!("legacy-peer");
    let legacy_cfg = derive_config(&config("legacy-peer")).unwrap();
    apply(&mut receiver, &receiver_cfg, stored(&legacy_cfg, vec![stale.clone()], 1, 1)).unwrap();
    assert_eq!(
        receiver
            .query_row("SELECT count(*) FROM mvp_sync_conflicts", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0,
        "an identical v1 replay is harmless and should not create a conflict"
    );

    record["value"]["row"]["title"] = json!("Old v1 edit");
    stale.f["data"] = json!(record.to_string());
    stale.f["updated_at"] = json!("2026-09-28T12:01:00.000Z");
    stale.f["_updated_at"] = stale.f["updated_at"].clone();
    apply(&mut receiver, &receiver_cfg, stored(&legacy_cfg, vec![stale.clone()], 2, 2)).unwrap();

    record["deleted"] = json!(true);
    record["value"] = Value::Null;
    stale.f["data"] = json!(record.to_string());
    stale.f["updated_at"] = json!("2026-09-28T12:02:00.000Z");
    stale.f["_updated_at"] = stale.f["updated_at"].clone();
    apply(&mut receiver, &receiver_cfg, stored(&legacy_cfg, vec![stale], 3, 3)).unwrap();

    let saved: Value = serde_json::from_str(
        &crate::mvp_sync_db::read_ui(&receiver, "calendar_recurring_v1")
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(saved["plans"][0]["title"], "Local graph");
    assert_eq!(recurring_version(&receiver, &id), 2);
    assert_eq!(
        receiver
            .query_row("SELECT count(*) FROM mvp_sync_conflicts", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        receiver
            .query_row("SELECT receive_seq FROM content_sync_state", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
}

#[test]
fn v2_is_rejected_for_unscoped_rows_before_receive_cursor_advances() {
    let (mut receiver, cfg) = replica("scope-check");
    task(&receiver, "plain-task", "Plain task");
    let id = json!(["items", ["plain-task"]]).to_string();
    let mut incoming = row(&receiver, &id);
    let mut record: Value = serde_json::from_str(incoming.f["data"].as_str().unwrap()).unwrap();
    record["v"] = json!(2);
    incoming.f["data"] = json!(record.to_string());
    let peer_cfg = derive_config(&config("scope-peer")).unwrap();
    let error = apply(&mut receiver, &cfg, stored(&peer_cfg, vec![incoming], 1, 1)).unwrap_err();
    assert_eq!(error, "content_sync_unknown_schema");
    assert_eq!(
        receiver
            .query_row("SELECT receive_seq FROM content_sync_state", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
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
// ---- Task processes (2026-09-25) ----
fn processes(conn: &Connection) -> Value {
    serde_json::from_str::<Value>(&crate::mvp_sync_db::read_ui(conn, "calendar_processes_v1").unwrap().unwrap()).unwrap()
}
#[test]
fn archived_version_equivocation_retains_both_payloads_for_review() {
    let (a, ac) = replica("sender");
    let (mut b, bc) = replica("receiver");
    task(&a, "t", "Source");
    task(&b, "t", "Current");
    let id = json!(["items", ["t"]]).to_string();
    let mut old = row(&a, &id);
    old.f["updated_at"] = json!("2026-09-14T01:00:00.000Z");
    old.f["_updated_at"] = old.f["updated_at"].clone();
    assert_eq!(apply(&mut b, &bc, stored(&ac, vec![old.clone()], 1, 1)).unwrap(), 0);
    assert_eq!(scalar(&b, "SELECT count(*) FROM mvp_sync_conflicts").unwrap(), 1);
    let archived: String = b.query_row("SELECT data FROM mvp_sync_conflicts", [], |r| r.get(0)).unwrap();
    assert_eq!(apply(&mut b, &bc, stored(&ac, vec![old.clone()], 2, 2)).unwrap(), 0);
    assert_eq!(scalar(&b, "SELECT count(*) FROM content_sync_pending").unwrap(), 0);
    let mut changed: Value = serde_json::from_str(old.f["data"].as_str().unwrap()).unwrap();
    changed["value"]["title"] = json!("Changed payload at the archived version");
    old.f["data"] = json!(changed.to_string());
    assert_eq!(apply(&mut b, &bc, stored(&ac, vec![old], 3, 3)).unwrap(), 0);
    assert_eq!(scalar(&b, "SELECT receive_seq FROM content_sync_state").unwrap(), 3);
    assert_eq!(scalar(&b, "SELECT count(*) FROM content_sync_pending").unwrap(), 1);
    let (payload, error): (String, String) = b.query_row("SELECT payload,error_code FROM content_sync_pending", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(error, "content_sync_version_conflict");
    let pending: Row = serde_json::from_str(&payload).unwrap();
    assert_eq!(serde_json::from_str::<Value>(pending.f["data"].as_str().unwrap()).unwrap(), changed);
    assert_eq!(b.query_row("SELECT data FROM mvp_sync_conflicts", [], |r| r.get::<_, String>(0)).unwrap(), archived);
    assert_eq!(b.query_row("SELECT title FROM items WHERE id='t'", [], |r| r.get::<_, String>(0)).unwrap(), "Current");
}
fn process(id: &str, title: &str, stages: &[(&str, &str)]) -> Value {
    json!({"id":id,"title":title,"stages":stages.iter().map(|(id, title)| json!({"id":id,"title":title})).collect::<Vec<_>>()})
}
fn save_processes(conn: &Connection, rows: Vec<Value>) {
    let before = crate::mvp_sync_db::read_ui(conn, "calendar_processes_v1").unwrap();
    let state = json!({"version":1,"processes":rows});
    crate::mvp_sync_db::set_ui(conn, "calendar_processes_v1", &state.to_string(), Some(before.as_deref().unwrap_or(""))).unwrap();
}
#[test]
fn processes_sync_per_record_so_edits_of_different_processes_merge() {
    let (a, ac) = replica("mac");
    let (b, bc) = replica("phone");
    let analysis = |stages: &[(&str, &str)]| process("system-analysis", "Системный анализ", stages);
    save_processes(&a, vec![analysis(&[("understanding", "Понимание"), ("analysis", "Анализ и модели")])]);
    save_processes(&b, vec![analysis(&[("understanding", "Понимание"), ("analysis", "Анализ и модели")]), process("p-repair", "Ремонт", &[("s-estimate", "Смета")])]);
    assert_eq!(ui_rows(&a).len(), 1, "one record per process");
    let (mut a, mut b) = (a, b);
    apply(&mut a, &ac, stored(&bc, ui_rows(&b), 1, 1)).unwrap();
    apply(&mut b, &bc, stored(&ac, ui_rows(&a), 1, 1)).unwrap();
    assert_eq!(processes(&a), processes(&b));
    assert_eq!(processes(&a)["processes"].as_array().unwrap().len(), 2);
    // The Mac renames and reorders stages of one process while the phone renames the other.
    let mut on_a = processes(&a)["processes"].as_array().unwrap().clone();
    on_a[0] = analysis(&[("analysis", "Модели"), ("understanding", "Понимание")]);
    save_processes(&a, on_a);
    let mut on_b = processes(&b)["processes"].as_array().unwrap().clone();
    on_b[1] = process("p-repair", "Ремонт кухни", &[("s-estimate", "Смета")]);
    save_processes(&b, on_b);
    let (left, right) = (ui_rows(&a), ui_rows(&b));
    apply(&mut a, &ac, stored(&bc, right, 2, 2)).unwrap();
    apply(&mut b, &bc, stored(&ac, left, 2, 2)).unwrap();
    assert_eq!(processes(&a), processes(&b));
    assert_eq!(processes(&a)["processes"], json!([analysis(&[("analysis", "Модели"), ("understanding", "Понимание")]), process("p-repair", "Ремонт кухни", &[("s-estimate", "Смета")])]));
    assert_eq!(scalar(&a, "SELECT count(*) FROM mvp_sync_conflicts").unwrap(), 0, "different processes do not conflict");
    // Both devices edit the same process: the newer version wins everywhere, the other is kept for review.
    let mut on_a = processes(&a)["processes"].as_array().unwrap().clone();
    on_a[1] = process("p-repair", "Ремонт A", &[("s-estimate", "Смета")]);
    save_processes(&a, on_a);
    let mut on_b = processes(&b)["processes"].as_array().unwrap().clone();
    on_b[1] = process("p-repair", "Ремонт B", &[("s-estimate", "Смета"), ("s-buy", "Закупка")]);
    save_processes(&b, on_b);
    let (left, right) = (ui_rows(&a), ui_rows(&b));
    apply(&mut a, &ac, stored(&bc, right, 3, 3)).unwrap();
    apply(&mut b, &bc, stored(&ac, left, 3, 3)).unwrap();
    assert_eq!(processes(&a), processes(&b));
    for conn in [&a, &b] {
        assert_eq!(scalar(conn, "SELECT count(*) FROM mvp_sync_conflicts").unwrap(), 1, "the losing version is kept");
    }
    let listed = crate::mvp_sync_db::conflicts::list(&a, 0, 25).unwrap();
    let text = listed.to_string();
    assert!(text.contains("Процесс задач") && text.contains("Стадии"), "{text}");
}
#[test]
fn malformed_process_snapshots_are_rejected_before_any_record() {
    let (a, _) = replica("mac");
    for rows in [
        vec![process("Bad Id", "Процесс", &[("s", "Стадия")])],
        vec![process("p", "", &[("s", "Стадия")])],
        vec![process("p", "Процесс", &[])],
        vec![process("p", "Процесс", &[("s", "A"), ("s", "B")])],
        vec![process("p", "Процесс", &[("s,1", "A")])],
        vec![process("p", "Процесс", &[("s", "A")]), process("p", "Копия", &[("s", "A")])],
    ] {
        let state = json!({"version":1,"processes":rows});
        assert_eq!(crate::mvp_sync_db::set_ui(&a, "calendar_processes_v1", &state.to_string(), Some("")).unwrap_err(), "mvp_sync_invalid_snapshot", "{state}");
    }
    assert!(ui_rows(&a).is_empty());
    assert!(crate::mvp_sync_db::read_ui(&a, "calendar_processes_v1").unwrap().is_none());
}
#[test]
fn additive_process_fields_survive_replay_local_edit_and_conflict_archive() {
    let (a, ac) = replica("newer");
    let (mut b, bc) = replica("older");
    let mut extended = process("p", "Process", &[("s", "Stage")]);
    extended["futureProcess"] = json!({"nested":[null, false, {"number":7}]});
    extended["stages"][0]["futureStage"] = json!({"policy":"preserved"});
    save_processes(&a, vec![extended.clone()]);
    assert_eq!(apply(&mut b, &bc, stored(&ac, ui_rows(&a), 1, 1)).unwrap(), 1);
    assert_eq!(processes(&b)["processes"][0], extended);
    assert_eq!(apply(&mut b, &bc, stored(&ac, ui_rows(&a), 2, 2)).unwrap(), 0);
    assert_eq!(scalar(&b, "SELECT count(*) FROM mvp_sync_conflicts").unwrap(), 0);
    let mut edited = processes(&b)["processes"][0].clone();
    edited["title"] = json!("Known field edited by older replica");
    save_processes(&b, vec![edited.clone()]);
    let id = json!(["ui", ["calendar_processes_v1", "processes", "p"]]).to_string();
    let older_row = row(&b, &id);
    assert_eq!(serde_json::from_str::<Value>(older_row.f["data"].as_str().unwrap()).unwrap()["value"]["row"], edited);
    let mut competing = row(&a, &id);
    competing.f["updated_at"] = json!("2030-01-01T00:00:00.000Z");
    competing.f["_updated_at"] = competing.f["updated_at"].clone();
    let mut data: Value = serde_json::from_str(competing.f["data"].as_str().unwrap()).unwrap();
    data["value"]["row"]["title"] = json!("Competing newer edit");
    competing.f["data"] = json!(data.to_string());
    assert_eq!(apply(&mut b, &bc, stored(&ac, vec![competing], 3, 3)).unwrap(), 1);
    assert_eq!(processes(&b)["processes"][0], data["value"]["row"]);
    let archived: String = b.query_row("SELECT data FROM mvp_sync_conflicts WHERE id=?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&archived).unwrap()["value"]["row"], edited);
}
#[test]
fn unknown_record_envelope_member_preserves_page_cursor_and_local_outbox() {
    let (a, ac) = replica("newer");
    let (mut b, bc) = replica("older");
    task(&a, "remote", "Remote task");
    task(&b, "local", "Unsent local task");
    assert!(enqueue(&mut b, &bc).unwrap());
    let queued: String = b.query_row("SELECT body FROM content_sync_outbox ORDER BY local_seq LIMIT 1", [], |r| r.get(0)).unwrap();
    let mut remote = row(&a, &json!(["items", ["remote"]]).to_string());
    let mut data: Value = serde_json::from_str(remote.f["data"].as_str().unwrap()).unwrap();
    data["futureEnvelopeField"] = json!({"unknown":"preserve remotely"});
    remote.f["data"] = json!(data.to_string());
    assert_eq!(apply(&mut b, &bc, stored(&ac, vec![remote], 1, 1)).unwrap_err(), "content_sync_unknown_schema");
    assert_eq!(scalar(&b, "SELECT receive_seq FROM content_sync_state").unwrap(), 0);
    assert_eq!(scalar(&b, "SELECT count(*) FROM items WHERE id='remote'").unwrap(), 0);
    assert_eq!(scalar(&b, "SELECT count(*) FROM content_sync_pending").unwrap(), 0);
    assert_eq!(b.query_row("SELECT body FROM content_sync_outbox ORDER BY local_seq LIMIT 1", [], |r| r.get::<_, String>(0)).unwrap(), queued);
}
/// What a 0.3.33 replica does with a process record: its UI key list lacks
/// `calendar_processes_v1`, so the record reads exactly like this unknown key.
/// The page is rejected and the cursor stays; nothing of the page is applied.
/// This version applies the same kind of page, so after the update the older
/// device resumes from the held cursor without losing anything.
#[test]
fn an_older_replica_pauses_receiving_at_an_unknown_ui_record_and_this_version_applies_it() {
    let (a, ac) = replica("mac");
    let (mut older, oc) = replica("phone");
    task(&a, "t", "Fictional task");
    save_processes(&a, vec![process("system-analysis", "Системный анализ", &[("understanding", "Понимание")])]);
    let task_row = row(&a, &json!(["items", ["t"]]).to_string());
    let mut unknown = ui_rows(&a).remove(0);
    let renamed = unknown.f["id"].as_str().unwrap().replace("calendar_processes_v1", "calendar_processes_v0");
    let data = unknown.f["data"].as_str().unwrap().replace("calendar_processes_v1", "calendar_processes_v0");
    unknown.f.insert("id".into(), json!(renamed));
    unknown.f.insert("data".into(), json!(data));
    assert_eq!(apply(&mut older, &oc, stored(&ac, vec![task_row.clone(), unknown], 1, 1)).unwrap_err(), "content_sync_unknown_schema");
    assert_eq!(scalar(&older, "SELECT receive_seq FROM content_sync_state").unwrap(), 0, "the cursor waits for the update");
    assert_eq!(scalar(&older, "SELECT count(*) FROM items WHERE id='t'").unwrap(), 0, "nothing of the page is applied");
    // The updated device knows the key: the same page applies in full.
    let (mut updated, uc) = replica("tablet");
    apply(&mut updated, &uc, stored(&ac, vec![task_row, ui_rows(&a).remove(0)], 1, 1)).unwrap();
    assert_eq!(scalar(&updated, "SELECT receive_seq FROM content_sync_state").unwrap(), 1);
    assert_eq!(scalar(&updated, "SELECT count(*) FROM items WHERE id='t'").unwrap(), 1);
    assert_eq!(processes(&updated), processes(&a));
}
#[test]
fn stage_history_travels_in_the_task_row_and_both_devices_read_the_same_history() {
    let (mut a, ac) = replica("mac");
    let (mut b, bc) = replica("phone");
    let id = crate::calendar_compat::save_task(&mut a, None, "Fictional analysis".into(), None, None, None, None, Some(false), crate::calendar_compat::TaskFields { process: Some("system-analysis".into()), stage: Some("understanding".into()), ..Default::default() }).unwrap();
    crate::calendar_compat::set_task_stage(&mut a, &id, Some("requirements"), None).unwrap();
    let key = json!(["items", [&id]]).to_string();
    apply(&mut b, &bc, stored(&ac, vec![row(&a, &key)], 1, 1)).unwrap();
    let tags = |conn: &Connection| conn.query_row("SELECT tags FROM items WHERE id=?1", [&id], |r| r.get::<_, String>(0)).unwrap();
    assert_eq!(tags(&a), tags(&b));
    let log = crate::task_attributes::stage_log(&tags(&b)).into_iter().map(|(stage, _)| stage.to_owned()).collect::<Vec<_>>();
    assert_eq!(log, ["understanding", "requirements"]);
    // The phone moves on; the Mac receives the longer history with the row.
    crate::calendar_compat::set_task_stage(&mut b, &id, Some("analysis"), None).unwrap();
    apply(&mut a, &ac, stored(&bc, vec![row(&b, &key)], 1, 1)).unwrap();
    assert_eq!(crate::task_attributes::stage_log(&tags(&a)).len(), 3);
    assert_eq!(crate::task_attributes::stage(&tags(&a)), Some("analysis"));
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

#[test]
fn diagnosis_database_status_is_select_only_and_exposes_no_payload() {
    let (conn, _) = replica("synthetic-status");
    task(&conn, "synthetic-status-task", "Private synthetic title");
    conn.execute("UPDATE content_sync_state SET upload_error='content_sync_http_507',last_error='content_sync_http_507'", []).unwrap();
    let before = conn.total_changes();
    conn.pragma_update(None, "query_only", true).unwrap();
    let state = database_status(&conn).unwrap();
    assert_eq!(state["pending_keys"], scalar(&conn, "SELECT COUNT(*) FROM content_sync_dirty").unwrap());
    assert_eq!(state["error_code"], "content_sync_http_507");
    assert_eq!(conn.total_changes(), before);
    let raw = state.to_string();
    assert!(!raw.contains("Private synthetic title"));
    assert!(!raw.contains("synthetic-status-task"));
    assert!(!raw.contains("token"));
    assert!(!raw.contains("endpoint"));
}

fn initializing_status_fixture() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT); INSERT INTO app_settings VALUES('content_sync_enabled','true','synthetic');").unwrap();
    conn
}

#[test]
fn initializing_status_counts_existing_dirty_records_without_writes() {
    let conn = initializing_status_fixture();
    conn.execute_batch("CREATE TABLE content_sync_dirty(seq INTEGER PRIMARY KEY,table_name TEXT,row_id TEXT); INSERT INTO content_sync_dirty VALUES(1,'mvp_records','synthetic-first'),(2,'mvp_records','synthetic-second');").unwrap();
    let before = conn.total_changes();
    conn.pragma_update(None, "query_only", true).unwrap();
    let state = database_status(&conn).unwrap();
    assert_eq!(state["initializing"], true);
    assert_eq!(state["pending_keys"], 2);
    assert_eq!(conn.total_changes(), before);
    assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE name='content_sync_state'").unwrap(), 0);
}

#[test]
fn initializing_status_missing_dirty_table_returns_zero_without_creating_it() {
    let conn = initializing_status_fixture();
    let before = conn.total_changes();
    conn.pragma_update(None, "query_only", true).unwrap();
    let state = database_status(&conn).unwrap();
    assert_eq!(state["enabled"], true);
    assert_eq!(state["initializing"], true);
    assert_eq!(state["pending_keys"], 0);
    assert_eq!(conn.total_changes(), before);
    assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('content_sync_dirty','content_sync_state')").unwrap(), 0);
}

#[test]
fn initializing_status_empty_dirty_table_returns_zero() {
    let conn = initializing_status_fixture();
    conn.execute_batch("CREATE TABLE content_sync_dirty(seq INTEGER PRIMARY KEY,table_name TEXT,row_id TEXT);").unwrap();
    conn.pragma_update(None, "query_only", true).unwrap();
    assert_eq!(database_status(&conn).unwrap()["pending_keys"], 0);
}

#[test]
fn database_status_sql_errors_are_not_reported_as_empty_queues() {
    let missing_settings = Connection::open_in_memory().unwrap();
    missing_settings.pragma_update(None, "query_only", true).unwrap();
    assert_eq!(database_status(&missing_settings).unwrap_err(), "mvp_sync_database_failed");
    let malformed_state = initializing_status_fixture();
    malformed_state.execute_batch("CREATE TABLE content_sync_state(id INTEGER PRIMARY KEY);").unwrap();
    malformed_state.pragma_update(None, "query_only", true).unwrap();
    assert_eq!(database_status(&malformed_state).unwrap_err(), "content_sync_database_failed");
    let failed_dirty_count = initializing_status_fixture();
    failed_dirty_count.execute_batch("CREATE TABLE content_sync_dirty(seq INTEGER PRIMARY KEY); CREATE TEMP VIEW content_sync_dirty AS SELECT * FROM missing_synthetic_table;").unwrap();
    failed_dirty_count.pragma_update(None, "query_only", true).unwrap();
    assert_eq!(database_status(&failed_dirty_count).unwrap_err(), "content_sync_database_failed");
}

fn task_filter_view_filters() -> Value {
    json!({
        "filter":"active","search":"","goal":"","sphere":"","personal":"",
        "groupBy":"date","source":"","project":"","tag":""
    })
}

#[test]
fn task_filter_views_remain_local_and_use_durable_compare_and_swap() {
    const KEY: &str = "calendar_task_filter_views_v1";
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("filter-views.db");
    let mut conn = Connection::open(&path).unwrap();
    crate::init_schema(&conn).unwrap();
    let cfg = derive_config(&config("filter-view-device")).unwrap();
    initialize(&mut conn, &cfg).unwrap();
    task(&conn, "existing-task", "Fictional task");
    let task_before: (String, i64, String) = conn
        .query_row(
            "SELECT title,version,updated_at FROM items WHERE id='existing-task'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    let records_before = scalar(&conn, "SELECT count(*) FROM mvp_records").unwrap();
    let active_filters = task_filter_view_filters();
    let mut personal_filters = active_filters.clone();
    personal_filters["sphere"] = json!("personal");
    let first = json!({"version":1,"views":[
        {"id":"work","title":"Work","filters":active_filters.clone()},
        {"id":"personal","title":"Personal","filters":personal_filters.clone()}
    ]})
    .to_string();
    crate::mvp_sync_db::set_ui(&conn, KEY, &first, Some("")).unwrap();
    assert!(ui_rows(&conn).is_empty(), "local view definitions must not enter sync");
    drop(conn);

    let conn = Connection::open(&path).unwrap();
    assert_eq!(crate::mvp_sync_db::read_ui(&conn, KEY).unwrap().as_deref(), Some(first.as_str()));
    let edited = json!({"version":1,"views":[
        {"id":"work","title":"Current work","filters":active_filters.clone()},
        {"id":"personal","title":"Personal","filters":personal_filters.clone()}
    ]})
    .to_string();
    crate::mvp_sync_db::set_ui(&conn, KEY, &edited, Some(&first)).unwrap();
    assert_eq!(
        crate::mvp_sync_db::set_ui(&conn, KEY, &first, Some(&first)).unwrap_err(),
        "mvp_sync_stale_ui_state",
        "a stale save cannot replace the edited definition"
    );
    let deleted = json!({"version":1,"views":[
        {"id":"personal","title":"Personal","filters":personal_filters.clone()}
    ]})
    .to_string();
    assert_eq!(
        crate::mvp_sync_db::set_ui(&conn, KEY, &deleted, Some(&first)).unwrap_err(),
        "mvp_sync_stale_ui_state",
        "a stale deletion cannot remove a definition"
    );
    assert_eq!(crate::mvp_sync_db::read_ui(&conn, KEY).unwrap().as_deref(), Some(edited.as_str()));
    crate::mvp_sync_db::set_ui(&conn, KEY, &deleted, Some(&edited)).unwrap();
    assert_eq!(crate::mvp_sync_db::read_ui(&conn, KEY).unwrap().as_deref(), Some(deleted.as_str()));
    let task_after: (String, i64, String) = conn
        .query_row(
            "SELECT title,version,updated_at FROM items WHERE id='existing-task'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(task_after, task_before, "deleting a view must not edit task rows");
    assert_eq!(scalar(&conn, "SELECT count(*) FROM mvp_records").unwrap(), records_before);
    assert!(ui_rows(&conn).is_empty(), "view edits must not create sync records");
}

#[test]
fn task_filter_view_sqlite_write_failure_preserves_the_saved_snapshot() {
    const KEY: &str = "calendar_task_filter_views_v1";
    let (conn, _) = replica("filter-view-device");
    let original = json!({"version":1,"views":[{"id":"work","title":"Work","filters":task_filter_view_filters()}]}).to_string();
    crate::mvp_sync_db::set_ui(&conn, KEY, &original, Some("")).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER reject_filter_view_update BEFORE UPDATE ON ui_state
         WHEN NEW.key='calendar_task_filter_views_v1'
         BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;",
    )
    .unwrap();
    let changed = json!({"version":1,"views":[]}).to_string();
    assert_eq!(
        crate::mvp_sync_db::set_ui(&conn, KEY, &changed, Some(&original)).unwrap_err(),
        "mvp_sync_database_failed"
    );
    assert_eq!(crate::mvp_sync_db::read_ui(&conn, KEY).unwrap().as_deref(), Some(original.as_str()));
    assert!(ui_rows(&conn).is_empty());
}

#[path = "mvp_sync_compat_tests.rs"]
mod compatibility_tests;
