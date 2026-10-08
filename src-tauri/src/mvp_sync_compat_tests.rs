use super::*;

fn snapshot(conn: &Connection) -> Value {
    let out: Vec<Value> = conn.prepare("SELECT local_seq,batch_id,body,envelope_hash FROM content_sync_outbox ORDER BY local_seq").unwrap()
        .query_map([], |r| Ok(json!([r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?]))).unwrap().collect::<Result<_,_>>().unwrap();
    let parts: Vec<Value> = conn.prepare("SELECT table_name,row_id,record_id,part,total,body FROM content_sync_outbound_fragments ORDER BY record_id,part").unwrap()
        .query_map([], |r| Ok(json!([r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,u32>(3)?,r.get::<_,u32>(4)?,B64.encode(r.get::<_,Vec<u8>>(5)?)]))).unwrap().collect::<Result<_,_>>().unwrap();
    json!({"outbox":out,"parts":parts,"sequence":scalar(conn,"SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='content_sync_outbox'),0)").unwrap()})
}
fn graph_row(conn: &Connection, group: &str, version: u8, mode: &str, large: bool) -> Row {
    let title = if large {
        "x".repeat(140_000)
    } else {
        "Graph".into()
    };
    crate::mvp_sync_db::set_ui(
        conn,
        "calendar_recurring_v1",
        &recurring_state(mode, &title).to_string(),
        None,
    )
    .unwrap();
    let id = if group == "plans" {
        json!(["ui", ["calendar_recurring_v1", group, "graph-plan"]])
    } else {
        json!([
            "ui",
            ["calendar_recurring_v1", group, "2026-09-28", "graph-plan"]
        ])
    }
    .to_string();
    let mut outgoing = row(conn, &id);
    let mut data: Value = serde_json::from_str(outgoing.f["data"].as_str().unwrap()).unwrap();
    data["v"] = json!(version);
    outgoing.f["data"] = json!(data.to_string());
    outgoing
}
fn stage_batch(conn: &Connection, cfg: &RelayConfig, payload: &Payload) -> Batch {
    let seq = scalar(
        conn,
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='content_sync_outbox'),0)+1",
    )
    .unwrap();
    let batch = encrypt(cfg, payload, seq).unwrap();
    conn.execute("INSERT INTO content_sync_outbox(local_seq,batch_id,body,envelope_hash) VALUES(?1,?2,?3,?4)",params![seq,batch.batch_id,serde_json::to_string(&batch).unwrap(),envelope_hash(&batch.envelope).unwrap()]).unwrap();
    batch
}
fn changes(rows: Vec<Row>) -> Payload {
    Payload {
        v: 1,
        kind: "changes".into(),
        applied_seq: 900,
        rows,
        tombs: vec![],
        fragment: None,
    }
}
fn ack(cfg: &RelayConfig, body: &str) -> Ack {
    let batch: Batch = serde_json::from_str(body).unwrap();
    Ack {
        seq: 1000,
        client_seq: batch.client_seq,
        sender_device_id: cfg.device_id.clone(),
        batch_id: batch.batch_id,
        envelope_sha256: envelope_hash(&batch.envelope).unwrap(),
    }
}
fn stage_legacy_parts(conn: &Connection, outgoing: &Row, missing_prefix: bool) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let raw = serde_json::to_vec(outgoing).unwrap();
    let chunks: Vec<_> = raw.chunks(42_000).collect();
    assert!(!chunks.is_empty());
    for (part, bytes) in chunks.iter().enumerate().skip(usize::from(missing_prefix)) {
        conn.execute(
            "INSERT INTO content_sync_outbound_fragments VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                outgoing.t,
                outgoing.f["id"].as_str().unwrap(),
                id,
                part as u32,
                chunks.len() as u32,
                *bytes
            ],
        )
        .unwrap();
    }
    id
}
fn stage_part_outbox(conn: &Connection, cfg: &RelayConfig, record_id: &str) {
    let (part,total,body): (u32,u32,Vec<u8>)=conn.query_row("SELECT part,total,body FROM content_sync_outbound_fragments WHERE record_id=?1 ORDER BY part LIMIT 1",[record_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    stage_batch(
        conn,
        cfg,
        &Payload {
            v: 1,
            kind: "fragment".into(),
            applied_seq: 900,
            rows: vec![],
            tombs: vec![],
            fragment: Some(Fragment {
                record_id: record_id.into(),
                part,
                total,
                bytes: B64.encode(body),
            }),
        },
    );
    conn.execute(
        "DELETE FROM content_sync_outbound_fragments WHERE record_id=?1 AND part=?2",
        params![record_id, part],
    )
    .unwrap();
}

#[test]
fn issue122_delta_guard_checks_exact_immutable_batch_without_server_position() {
    for group in ["plans", "days"] {
        for (mode, version, blocked) in [
            ("graph", 1, true),
            ("graph", 2, false),
            ("chain", 1, false),
            ("check", 1, false),
        ] {
            let (mut conn, cfg) = replica("compat-delta");
            let outgoing = graph_row(&conn, group, version, mode, false);
            task(&conn, "plain", "Ordinary v1 task");
            let ordinary = row(&conn, &json!(["items", ["plain"]]).to_string());
            stage_batch(&conn, &cfg, &changes(vec![ordinary, outgoing]));
            let before = snapshot(&conn);
            if blocked {
                assert_eq!(
                    enqueue(&mut conn, &cfg).unwrap_err(),
                    "content_sync_legacy_graph_queue"
                );
                assert_eq!(
                    upload_with(&conn, &cfg, |_| panic!("legacy graph reached transport"))
                        .unwrap_err(),
                    "content_sync_legacy_graph_queue"
                );
            } else {
                assert!(enqueue(&mut conn, &cfg).unwrap());
                let prepared = compat::outbox(&conn, &cfg).unwrap().unwrap();
                assert_eq!(prepared.1, before["outbox"][0][2].as_str().unwrap());
            }
            assert_eq!(snapshot(&conn), before, "{group}/{mode}/v{version}");
        }
    }
    let (mut conn, cfg) = replica("compat-receipt");
    stage_batch(
        &conn,
        &cfg,
        &Payload {
            v: 1,
            kind: "receipt".into(),
            applied_seq: 900,
            rows: vec![],
            tombs: vec![],
            fragment: None,
        },
    );
    assert!(
        enqueue(&mut conn, &cfg).unwrap(),
        "valid receipt applied_seq may exceed local/client sequence"
    );
}

#[test]
fn issue122_legacy_graph_outbox_restart_persists_diagnostic_without_upload() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy-queue.db");
    let mut conn = Connection::open(&path).unwrap();
    crate::init_schema(&conn).unwrap();
    let base = config("compat-restart");
    let cfg = derive_config(&base).unwrap();
    conn.execute(
        "UPDATE app_settings SET value=?1 WHERE key='device_id'",
        [&cfg.device_id],
    )
    .unwrap();
    initialize(&mut conn, &cfg).unwrap();
    conn.execute("INSERT INTO app_settings(key,value,updated_at) VALUES('content_sync_enabled','true','synthetic')",[]).unwrap();
    let outgoing = graph_row(&conn, "plans", 1, "graph", false);
    stage_batch(&conn, &cfg, &changes(vec![outgoing]));
    conn.execute(
        "UPDATE content_sync_state SET pull_not_before=?1",
        [chrono::Utc::now().timestamp() + 3600],
    )
    .unwrap();
    let before = snapshot(&conn);
    drop(conn);
    for _ in 0..2 {
        let result: Value = serde_json::from_str(
            &run_headless_once(
                path.to_str().unwrap(),
                &serde_json::to_string(&base).unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["uploaded_batches"], 0);
        assert_eq!(result["error_code"], "content_sync_legacy_graph_queue");
        let conn = Connection::open(&path).unwrap();
        assert_eq!(snapshot(&conn), before);
        assert_eq!(
            database_status(&conn).unwrap()["error_code"],
            "content_sync_legacy_graph_queue"
        );
    }
}

#[test]
fn issue122_safe_lost_ack_retries_exact_bytes_and_deletes_only_on_matching_ack() {
    let (mut conn, cfg) = replica("compat-ack");
    task(&conn, "plain", "Safe task");
    stage_batch(
        &conn,
        &cfg,
        &changes(vec![row(&conn, &json!(["items", ["plain"]]).to_string())]),
    );
    let before = snapshot(&conn);
    assert_eq!(
        upload_with(&conn, &cfg, |body| {
            assert_eq!(body, before["outbox"][0][2].as_str().unwrap());
            Err("content_sync_network_unavailable".into())
        })
        .unwrap_err(),
        "content_sync_network_unavailable"
    );
    initialize(&mut conn, &cfg).unwrap();
    assert_eq!(snapshot(&conn), before);
    assert_eq!(
        upload_with(&conn, &cfg, |body| {
            let mut response = ack(&cfg, body);
            response.batch_id = uuid::Uuid::new_v4().to_string();
            Ok(response)
        })
        .unwrap_err(),
        "content_sync_invalid_ack"
    );
    assert_eq!(snapshot(&conn), before);
    assert_eq!(
        upload_with(&conn, &cfg, |body| {
            assert_eq!(body, before["outbox"][0][2].as_str().unwrap());
            Ok(ack(&cfg, body))
        })
        .unwrap(),
        1
    );
    assert_eq!(
        scalar(&conn, "SELECT count(*) FROM content_sync_outbox").unwrap(),
        0
    );
    assert_eq!(snapshot(&conn)["sequence"], before["sequence"]);
}

#[test]
fn issue122_legacy_complete_and_incomplete_fragments_preserve_every_original_byte() {
    for group in ["plans", "days"] {
        for missing_prefix in [false, true] {
            for in_outbox in [false, true] {
                let (mut conn, cfg) = replica("compat-legacy-parts");
                let outgoing = graph_row(&conn, group, 1, "graph", true);
                let record_id = stage_legacy_parts(&conn, &outgoing, missing_prefix);
                if in_outbox {
                    stage_part_outbox(&conn, &cfg, &record_id);
                }
                let before = snapshot(&conn);
                crate::mvp_sync_db::initialize(&conn).unwrap();
                let expected = if missing_prefix {
                    "content_sync_legacy_fragment_unverified"
                } else {
                    "content_sync_legacy_graph_queue"
                };
                assert_eq!(enqueue(&mut conn, &cfg).unwrap_err(), expected);
                if in_outbox {
                    assert_eq!(
                        upload_with(&conn, &cfg, |_| panic!("legacy fragment reached transport"))
                            .unwrap_err(),
                        expected
                    );
                }
                assert_eq!(snapshot(&conn), before);
                assert_eq!(
                    scalar(&conn, "SELECT count(*) FROM content_sync_fragment_compat").unwrap(),
                    0
                );
            }
        }
    }
}

#[test]
fn issue122_safe_legacy_fragments_gain_durable_proof_and_finish_after_restart_and_lost_ack() {
    for (mode, version) in [("graph", 2), ("chain", 1)] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("safe-fragments.db");
        let mut conn = Connection::open(&path).unwrap();
        crate::init_schema(&conn).unwrap();
        let cfg = derive_config(&config("compat-safe-parts")).unwrap();
        conn.execute(
            "UPDATE app_settings SET value=?1 WHERE key='device_id'",
            [&cfg.device_id],
        )
        .unwrap();
        initialize(&mut conn, &cfg).unwrap();
        let outgoing = graph_row(&conn, "plans", version, mode, true);
        let record_id = stage_legacy_parts(&conn, &outgoing, false);
        conn.execute("DELETE FROM content_sync_dirty", []).unwrap();
        assert!(enqueue(&mut conn, &cfg).unwrap());
        let count = scalar(&conn, "SELECT count(*) FROM content_sync_fragment_compat").unwrap();
        assert!(count > 2);
        assert_eq!(
            upload_with(&conn, &cfg, |body| Ok(ack(&cfg, body))).unwrap(),
            1
        );
        drop(conn);
        let mut conn = Connection::open(&path).unwrap();
        crate::init_schema(&conn).unwrap();
        initialize(&mut conn, &cfg).unwrap();
        for _ in 0..10 {
            if !enqueue(&mut conn, &cfg).unwrap() {
                break;
            }
            if scalar(
                &conn,
                "SELECT count(*) FROM content_sync_outbound_fragments",
            )
            .unwrap()
                == 0
            {
                let before = snapshot(&conn);
                assert_eq!(
                    upload_with(&conn, &cfg, |_| Err(
                        "content_sync_network_unavailable".into()
                    ))
                    .unwrap_err(),
                    "content_sync_network_unavailable"
                );
                assert_eq!(snapshot(&conn), before);
                assert_eq!(
                    scalar(&conn, "SELECT count(*) FROM content_sync_fragment_compat").unwrap(),
                    count
                );
                drop(conn);
                conn = Connection::open(&path).unwrap();
                initialize(&mut conn, &cfg).unwrap();
                assert_eq!(snapshot(&conn), before);
            }
            assert_eq!(
                upload_with(&conn, &cfg, |body| Ok(ack(&cfg, body))).unwrap(),
                1
            );
        }
        assert_eq!(
            scalar(&conn, "SELECT count(*) FROM content_sync_outbox").unwrap(),
            0
        );
        assert_eq!(
            scalar(
                &conn,
                "SELECT count(*) FROM content_sync_outbound_fragments"
            )
            .unwrap(),
            0
        );
        assert_eq!(
            scalar(&conn, "SELECT count(*) FROM content_sync_fragment_compat").unwrap(),
            0
        );
        assert!(!record_id.is_empty());
    }
}

#[test]
fn issue122_new_safe_fragments_are_proven_atomically_and_corruption_is_blocked() {
    let (mut conn, cfg) = replica("compat-new-parts");
    let outgoing = graph_row(&conn, "plans", 2, "graph", true);
    conn.execute(
        "DELETE FROM content_sync_dirty WHERE row_id!=?1",
        [outgoing.f["id"].as_str().unwrap()],
    )
    .unwrap();
    assert!(enqueue(&mut conn, &cfg).unwrap());
    assert!(scalar(&conn, "SELECT count(*) FROM content_sync_fragment_compat").unwrap() > 2);
    upload_with(&conn, &cfg, |body| Ok(ack(&cfg, body))).unwrap();
    conn.execute(
        "UPDATE content_sync_outbound_fragments SET body=zeroblob(length(body)) WHERE part=1",
        [],
    )
    .unwrap();
    let before = snapshot(&conn);
    assert_eq!(
        enqueue(&mut conn, &cfg).unwrap_err(),
        "content_sync_fragment_conflict"
    );
    assert_eq!(snapshot(&conn), before);
}

#[test]
fn issue122_null_recurring_tombstones_remain_compatible_in_delta_and_fragment_bytes() {
    for group in ["plans", "days"] {
        for version in [1, 2] {
            for fragmented in [false, true] {
                let (mut conn, cfg) = replica("compat-tombstone");
                let mut outgoing = graph_row(&conn, group, version, "graph", false);
                let mut data: Value =
                    serde_json::from_str(outgoing.f["data"].as_str().unwrap()).unwrap();
                data["deleted"] = json!(true);
                data["value"] = Value::Null;
                outgoing.f["data"] = json!(data.to_string());
                if fragmented {
                    let id = stage_legacy_parts(&conn, &outgoing, false);
                    stage_part_outbox(&conn, &cfg, &id);
                } else {
                    stage_batch(&conn, &cfg, &changes(vec![outgoing]));
                }
                let before = snapshot(&conn);
                // A null deletion exposes no unsupported graph value. v1 is also the
                // exact existing format for safe check/chain deletions.
                assert!(enqueue(&mut conn, &cfg).unwrap());
                assert_eq!(
                    compat::outbox(&conn, &cfg).unwrap().unwrap().1,
                    before["outbox"][0][2].as_str().unwrap()
                );
                assert_eq!(snapshot(&conn), before);
            }
        }
    }
}
