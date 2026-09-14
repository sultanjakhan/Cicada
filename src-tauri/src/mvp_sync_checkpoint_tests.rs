use super::*;
fn config(device: &str) -> RelayConfig {
    let mut cfg = RelayConfig {
        v: 1,
        profile: "hanni-mvp-content-v1".into(),
        endpoint: "https://example.invalid".into(),
        device_id: device.into(),
        key_id: "synthetic_key".into(),
        token: B64.encode([7; 32]),
        key: B64.encode([8; 32]),
        enabled: true,
    };
    cfg = derive_config(&cfg).unwrap();
    cfg
}
fn connection(cfg: &RelayConfig) -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    crate::init_schema(&conn).unwrap();
    conn.execute(
        "UPDATE app_settings SET value=?1 WHERE key='device_id'",
        [&cfg.device_id],
    )
    .unwrap();
    super::super::initialize(&mut conn, cfg).unwrap();
    conn
}
fn drain_local(conn: &mut Connection, cfg: &RelayConfig, seq: &mut i64) {
    for _ in 0..1000 {
        if !enqueue(conn, cfg).unwrap() {
            break;
        }
        let body: String = conn
            .query_row(
                "SELECT body FROM content_sync_outbox ORDER BY local_seq LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let batch: Batch = serde_json::from_str(&body).unwrap();
        *seq += 1;
        let item = Stored {
            seq: *seq,
            client_seq: batch.client_seq,
            sender_device_id: cfg.device_id.clone(),
            batch_id: batch.batch_id.clone(),
            envelope_sha256: envelope_hash(&batch.envelope).unwrap(),
            envelope: batch.envelope,
        };
        let before = scalar(conn, "SELECT receive_seq FROM content_sync_state").unwrap();
        apply_page(
            conn,
            cfg,
            before,
            Page {
                batches: vec![item],
                next_cursor: *seq,
                latest_seq: *seq,
                has_more: false,
            },
        )
        .unwrap();
        conn.execute(
            "DELETE FROM content_sync_outbox WHERE batch_id=?1",
            [batch.batch_id],
        )
        .unwrap();
    }
}
fn source() -> (Connection, RelayConfig) {
    let cfg = config("source");
    let mut conn = connection(&cfg);
    crate::mvp_sync_db::start_day(&conn).unwrap();
    let mut seq = 0;
    drain_local(&mut conn, &cfg, &mut seq);
    assert!(capture(&mut conn, &cfg, 0).unwrap());
    (conn, cfg)
}
fn descriptor(source: &Connection, sender: &RelayConfig, receiver: &Connection) -> Descriptor {
    let job = load::<Upload>(source, "upload").unwrap().unwrap();
    for i in 0..job.chunk_count {
        let (env, digest) = load_part(source, "upload", i).unwrap();
        stage_part(receiver, "download", i, &env, &digest).unwrap();
    }
    Descriptor {
        checkpoint_id: job.checkpoint_id,
        base_seq: job.base_seq,
        generation: job.expected_generation + 1,
        uploader_device_id: sender.device_id.clone(),
        chunk_count: job.chunk_count,
        total_bytes: job.total_bytes,
        chunk_root_sha256: job.chunk_root_sha256,
        envelope_sha256: envelope_hash(&job.envelope).unwrap(),
        envelope: job.envelope,
    }
}
fn queues(conn: &Connection) -> (Vec<String>, Vec<String>) {
    let mut s = conn
        .prepare("SELECT body FROM content_sync_outbox ORDER BY local_seq")
        .unwrap();
    let out = s
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<String>>>()
        .unwrap();
    let mut s = conn
        .prepare("SELECT seq||':'||table_name||':'||row_id FROM content_sync_dirty ORDER BY seq")
        .unwrap();
    let dirty = s
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<String>>>()
        .unwrap();
    (out, dirty)
}
fn stage_plain(
    conn: &Connection,
    cfg: &RelayConfig,
    plain: &[u8],
    base: i64,
    applied: i64,
) -> Descriptor {
    let id = uuid::Uuid::new_v4().to_string();
    let mut digests = vec![];
    let mut total = 0;
    clear(conn, "download").unwrap();
    for (i, bytes) in plain.chunks(PART).enumerate() {
        let env = seal(cfg, &id, base, Some(i), bytes).unwrap();
        let digest = envelope_hash(&env).unwrap();
        total += encode(&env).unwrap().len();
        stage_part(conn, "download", i, &env, &digest).unwrap();
        digests.push(digest);
    }
    let root = hash(encode(&digests).unwrap().as_bytes());
    let Line::Header(h) = parse::<Line>(plain.split(|b| *b == b'\n').next().unwrap()).unwrap()
    else {
        panic!()
    };
    let m = Manifest {
        v: 1,
        schema: SCHEMA.into(),
        tables: tables(),
        base_seq: base,
        applied_seq: applied,
        chunk_count: digests.len(),
        chunk_root_sha256: root.clone(),
        plain_bytes: plain.len(),
        plain_sha256: hash(plain),
        receipts: h.receipts,
    };
    let env = seal(cfg, &id, base, None, encode(&m).unwrap().as_bytes()).unwrap();
    Descriptor {
        checkpoint_id: id,
        base_seq: base,
        generation: 1,
        uploader_device_id: cfg.device_id.clone(),
        chunk_count: digests.len(),
        total_bytes: total,
        chunk_root_sha256: root,
        envelope_sha256: envelope_hash(&env).unwrap(),
        envelope: env,
    }
}

#[test]
fn checkpoint_restores_day_and_preserves_local_outbox_and_writer() {
    let (source, cfg) = source();
    let peer_cfg = config("peer");
    let mut peer = connection(&peer_cfg);
    crate::mvp_sync_db::set_ui(
        &peer,
        "calendar_now_v1",
        &json!({"version":1,"entry":null}).to_string(),
        None,
    )
    .ok();
    enqueue(&mut peer, &peer_cfg).unwrap();
    let before = queues(&peer);
    let d = descriptor(&source, &cfg, &peer);
    install(&mut peer, &peer_cfg, &d).unwrap();
    assert_eq!(
        crate::mvp_sync_db::day_ledger(&peer).unwrap(),
        crate::mvp_sync_db::day_ledger(&source).unwrap()
    );
    assert_eq!(queues(&peer), before);
    assert_eq!(
        crate::mvp_sync_db::get_setting_checked(&peer, "device_id")
            .unwrap()
            .as_deref(),
        Some("peer")
    );
    assert_eq!(
        scalar(&peer, "SELECT receive_seq FROM content_sync_state").unwrap(),
        d.base_seq
    );
}
#[test]
fn checkpoint_capture_waits_for_dirty_outbox_pending_and_fragments() {
    let cfg = config("a");
    let mut conn = connection(&cfg);
    let mut seq = 0;
    drain_local(&mut conn, &cfg, &mut seq);
    for query in [
        "INSERT INTO content_sync_dirty(table_name,row_id) VALUES('mvp_records','synthetic')",
        "INSERT INTO content_sync_outbox(batch_id,body,envelope_hash) VALUES('synthetic','{}','synthetic')",
        "INSERT INTO content_sync_fragments_v2 VALUES('a','synthetic',0,2,X'00')",
        "INSERT INTO content_sync_outbound_fragments VALUES('mvp_records','synthetic','synthetic',0,2,X'00')",
        "INSERT INTO content_sync_pending(sender,table_name,remote_id,kind,stamp,payload,error_code) VALUES('a','mvp_records','synthetic','row','2026-09-01T00:00:00.000Z','{}','unresolved')"
    ] {
conn.execute(query,[]).unwrap();
        assert!(!capture(&mut conn,&cfg,0).unwrap());
        conn.execute_batch("DELETE FROM content_sync_dirty; DELETE FROM content_sync_outbox; DELETE FROM content_sync_fragments_v2; DELETE FROM content_sync_outbound_fragments; DELETE FROM content_sync_pending;").unwrap();
    }
}
#[test]
fn checkpoint_aad_binds_sender_base_index_and_manifest_namespace() {
    let cfg = config("sender");
    let id = uuid::Uuid::new_v4().to_string();
    let env = seal(&cfg, &id, 1, Some(0), b"synthetic").unwrap();
    assert_eq!(
        open(&cfg, "sender", &id, 1, Some(0), &env).unwrap(),
        b"synthetic"
    );
    for (sender, base, index) in [
        ("other", 1, Some(0)),
        ("sender", 2, Some(0)),
        ("sender", 1, Some(1)),
        ("sender", 1, None),
    ] {
        assert!(open(&cfg, sender, &id, base, index, &env).is_err());
    }
}
#[test]
fn checkpoint_corruption_and_unknown_schema_keep_rows_cursors_and_queues() {
    let (source, cfg) = source();
    let peer_cfg = config("peer");
    let mut peer = connection(&peer_cfg);
    let mut d = descriptor(&source, &cfg, &peer);
    let before = queues(&peer);
    let body: Vec<u8> = verified_plain(&peer, &peer_cfg, &d).unwrap().1;
    d.chunk_root_sha256 = "0".repeat(64);
    assert!(install(&mut peer, &peer_cfg, &d).is_err());
    assert_eq!(queues(&peer), before);
    assert_eq!(
        scalar(&peer, "SELECT receive_seq FROM content_sync_state").unwrap(),
        0
    );
    let mut lines = body
        .split(|b| *b == b'\n')
        .filter(|b| !b.is_empty())
        .map(|b| parse::<Line>(b).unwrap())
        .collect::<Vec<_>>();
    let Line::Row(row) = &mut lines[1] else {
        panic!()
    };
    row.f.insert("future_schema".into(), json!(true));
    let mut bad = vec![];
    for line in &lines {
        append(&mut bad, line).unwrap();
    }
    let d = stage_plain(&peer, &cfg, &bad, d.base_seq, d.base_seq);
    assert!(install(&mut peer, &peer_cfg, &d).is_err());
    assert_eq!(queues(&peer), before);
    assert_eq!(
        scalar(&peer, "SELECT receive_seq FROM content_sync_state").unwrap(),
        0
    );
    assert!(crate::mvp_sync_db::day_ledger(&peer).unwrap()["entries"]
        .as_array()
        .unwrap()
        .is_empty());
}

fn task(conn: &Connection, id: &str, title: &str) {
    conn.execute("INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at) VALUES(?1,'task',?2,30,1,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')",params![id,title]).unwrap();
}
fn sync_http(conn: &mut Connection, cfg: &RelayConfig) {
    for _ in 0..1000 {
        let queued = enqueue(conn, cfg).unwrap();
        if queued {
            upload(conn, cfg).unwrap();
        }
        let (_, more) = pull(conn, cfg, client().unwrap()).unwrap();
        if !queued && !more {
            return;
        }
    }
    panic!("synthetic sync did not settle");
}
#[test]
fn checkpoint_keeps_tomb_versions_without_resurrecting_stale_rows() {
    let cfg = config("source");
    let mut a = connection(&cfg);
    let peer_cfg = config("peer");
    let mut b = connection(&peer_cfg);
    task(&a, "deleted", "before deletion");
    let stale = snapshot_row(
        &a,
        "mvp_records",
        &json!(["items", ["deleted"]]).to_string(),
        "source",
    )
    .unwrap();
    a.execute("DELETE FROM items WHERE id='deleted'", [])
        .unwrap();
    let mut seq = 0;
    drain_local(&mut a, &cfg, &mut seq);
    capture(&mut a, &cfg, 0).unwrap();
    let d = descriptor(&a, &cfg, &b);
    install(&mut b, &peer_cfg, &d).unwrap();
    assert_eq!(
        scalar(&b, "SELECT COUNT(*) FROM items WHERE id='deleted'").unwrap(),
        0
    );
    crate::mvp_sync_db::apply_record(&b, &stale.f).unwrap();
    assert_eq!(
        scalar(&b, "SELECT COUNT(*) FROM items WHERE id='deleted'").unwrap(),
        0
    );
    assert_eq!(scalar(&b,"SELECT COUNT(*) FROM sync_row_versions WHERE table_name='mvp_records' AND row_id LIKE '%deleted%'").unwrap(),1);
}
#[test]
fn checkpoint_cannot_regress_authenticated_sender_positions() {
    let (source, cfg) = source();
    let peer_cfg = config("peer");
    let mut peer = connection(&peer_cfg);
    peer.execute(
        "INSERT INTO content_sync_sender_watermarks VALUES('missing-writer',1,1)",
        [],
    )
    .unwrap();
    let d = descriptor(&source, &cfg, &peer);
    assert_eq!(
        install(&mut peer, &peer_cfg, &d).unwrap_err(),
        "content_sync_checkpoint_watermark_missing"
    );
    assert_eq!(
        scalar(&peer, "SELECT receive_seq FROM content_sync_state").unwrap(),
        0
    );
}
#[test]
#[ignore = "requires the isolated local workerd checkpoint runner and synthetic configuration"]
fn mvp_sync_local_checkpoint_roundtrip() {
    let configs =
        std::env::var_os("HANNI_MVP_TEST_RELAY_CONFIG_DIR").expect("synthetic config directory");
    let dir = tempfile::tempdir().unwrap();
    let mut cfgs = vec![];
    let mut paths = vec![];
    for name in ["mac", "phone", "windows"] {
        let raw =
            std::fs::read_to_string(std::path::Path::new(&configs).join(format!("{name}.json")))
                .unwrap();
        let cfg = derive_config(&RelayConfig::parse(&raw).unwrap()).unwrap();
        let path = dir.path().join(format!("{name}.db"));
        let mut conn = Connection::open(&path).unwrap();
        crate::init_schema(&conn).unwrap();
        super::super::initialize(&mut conn, &cfg).unwrap();
        let status = request(
            client()
                .unwrap()
                .get(url(&cfg, "/v1/checkpoints/status"))
                .bearer_auth(&cfg.token),
        )
        .unwrap();
        assert_eq!(status.status, 200);
        cfgs.push(cfg);
        paths.push(path);
    }
    let (a_cfg, b_cfg, c_cfg) = (&cfgs[0], &cfgs[1], &cfgs[2]);
    let mut a = Connection::open(&paths[0]).unwrap();
    let mut b = Connection::open(&paths[1]).unwrap();
    let mut c = Connection::open(&paths[2]).unwrap();
    crate::mvp_sync_db::start_day(&a).unwrap();
    for index in 0..32 {
        let id = format!("large-{index:03}");
        task(&a, &id, "synthetic checkpoint task");
        a.execute(
            "UPDATE items SET notes=?1 WHERE id=?2",
            params!["synthetic".repeat(1000), id],
        )
        .unwrap();
    }
    task(&a, "removed", "synthetic removed");
    a.execute("DELETE FROM items WHERE id='removed'", [])
        .unwrap();
    assert!(!capture(&mut a, a_cfg, 0).unwrap());
    sync_http(&mut a, a_cfg);
    // B's append commits but its local queue never sees the ACK. Another device
    // can publish this prefix; retry must still acknowledge the exact packet.
    task(&b, "lost-ack", "synthetic retained ACK");
    assert!(enqueue(&mut b, b_cfg).unwrap());
    let b_before = queues(&b);
    let body = b_before.0[0].clone();
    let accepted = request(
        client()
            .unwrap()
            .post(url(b_cfg, "/v1/batches"))
            .bearer_auth(&b_cfg.token)
            .header("Content-Type", "application/json")
            .body(body.clone()),
    )
    .unwrap();
    assert_eq!(accepted.status, 201);
    sync_http(&mut a, a_cfg);
    assert!(capture(&mut a, a_cfg, 0).unwrap());
    let job = load::<Upload>(&a, "upload").unwrap().unwrap();
    assert!(job.chunk_count > 4);
    assert!(upload_step(&mut a, a_cfg, client().unwrap()).unwrap());
    drop(a);
    a = Connection::open(&paths[0]).unwrap();
    let mut lost_finalize_ack = false;
    for _ in 0..100 {
        match upload_step(&mut a, a_cfg, client().unwrap()) {
            Ok(false) => break,
            Ok(true) => {}
            Err(error) => {
                assert_eq!(error, "content_sync_checkpoint_http_error");
                lost_finalize_ack = true;
            }
        }
    }
    assert!(lost_finalize_ack);
    assert!(load::<Upload>(&a, "upload").unwrap().is_none());
    let published = latest(&a, a_cfg, client().unwrap()).unwrap().unwrap();
    let cleanup = request(
        client()
            .unwrap()
            .post(url(a_cfg, "/v1/maintenance"))
            .bearer_auth(&a_cfg.token)
            .json(&json!({})),
    )
    .unwrap();
    assert_eq!(cleanup.status, 200);
    assert!(cleanup.value["removed_rows"].as_u64().unwrap() > 0);
    assert_eq!(queues(&b), b_before);
    assert_eq!(upload(&b, b_cfg).unwrap(), 1);
    assert!(queues(&b).0.is_empty());
    // A newer suffix is written after the published immutable snapshot.
    task(&a, "suffix", "synthetic suffix");
    sync_http(&mut a, a_cfg);
    // C was offline throughout, and has both an immutable outgoing packet and a
    // newer local dirty edit. Download may merge but cannot acknowledge either.
    task(&c, "offline", "synthetic local draft");
    enqueue(&mut c, c_cfg).unwrap();
    c.execute(
        "UPDATE items SET title='synthetic newer local draft' WHERE id='offline'",
        [],
    )
    .unwrap();
    let c_before = queues(&c);
    let (_, more) = pull(&mut c, c_cfg, client().unwrap()).unwrap();
    assert!(more);
    assert!(load::<Download>(&c, "download").unwrap().is_some());
    drop(c);
    c = Connection::open(&paths[2]).unwrap();
    for _ in 0..100 {
        let (_, more) = pull(&mut c, c_cfg, client().unwrap()).unwrap();
        if !more {
            break;
        }
    }
    assert_eq!(queues(&c), c_before);
    assert_eq!(
        scalar(&c, "SELECT COUNT(*) FROM items WHERE id LIKE 'large-%'").unwrap(),
        32
    );
    assert_eq!(
        scalar(&c, "SELECT COUNT(*) FROM items WHERE id='removed'").unwrap(),
        0
    );
    assert_eq!(
        scalar(
            &c,
            "SELECT COUNT(*) FROM items WHERE id IN ('lost-ack','suffix','offline')"
        )
        .unwrap(),
        3
    );
    assert!(scalar(&c, "SELECT receive_seq FROM content_sync_state").unwrap() > published.base_seq);
    assert_eq!(
        crate::mvp_sync_db::day_ledger(&a).unwrap(),
        crate::mvp_sync_db::day_ledger(&c).unwrap()
    );
    assert_eq!(
        c.query_row("SELECT title FROM items WHERE id='offline'", [], |r| r
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "synthetic newer local draft"
    );
    sync_http(&mut b, b_cfg);
    sync_http(&mut c, c_cfg);
    sync_http(&mut a, a_cfg);
    assert_eq!(
        scalar(&a, "SELECT COUNT(*) FROM items WHERE id='offline'").unwrap(),
        1
    );
    assert_eq!(
        scalar(&b, "SELECT COUNT(*) FROM items WHERE id LIKE 'large-%'").unwrap(),
        32
    );
}

#[test]
fn checkpoint_archives_merge_and_respect_existing_local_dismissal_receipts() {
    let cfg = config("source");
    let mut a = connection(&cfg);
    task(&a, "conflicted", "synthetic older value");
    let id = json!(["items", ["conflicted"]]).to_string();
    let mut incoming = snapshot_row(&a, "mvp_records", &id, "source").unwrap();
    let mut data: Value = serde_json::from_str(incoming.f["data"].as_str().unwrap()).unwrap();
    data["value"]["title"] = json!("synthetic concurrent value");
    data["parent"] = Value::Null;
    data["parent_writer"] = Value::Null;
    incoming.f.insert("data".into(), json!(data.to_string()));
    let stamp = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::seconds(30))
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    incoming.f.insert("updated_at".into(), json!(stamp));
    incoming.f.insert("_updated_at".into(), json!(stamp));
    incoming
        .f
        .insert("_device_id".into(), json!("other-writer"));
    crate::mvp_sync_db::apply_record(&a, &incoming.f).unwrap();
    let archive = crate::mvp_sync_db::checkpoint_conflicts(&a).unwrap();
    assert_eq!(archive.len(), 1);
    let mut seq = 0;
    drain_local(&mut a, &cfg, &mut seq);
    capture(&mut a, &cfg, 0).unwrap();
    let peer_cfg = config("peer");
    let mut b = connection(&peer_cfg);
    let d = descriptor(&a, &cfg, &b);
    install(&mut b, &peer_cfg, &d).unwrap();
    assert_eq!(
        crate::mvp_sync_db::checkpoint_conflicts(&b).unwrap(),
        archive
    );
    let receipt_cfg = config("receipt-peer");
    let mut c = connection(&receipt_cfg);
    let entry = &archive[0];
    c.execute("INSERT INTO mvp_sync_conflict_resolutions VALUES(?1,?2,?3,?4,'current','synthetic-local-decision')",params![entry["id"].as_str(),entry["stamp"].as_str(),entry["writer"].as_str(),hash(entry["data"].as_str().unwrap().as_bytes())]).unwrap();
    let d = descriptor(&a, &cfg, &c);
    install(&mut c, &receipt_cfg, &d).unwrap();
    assert!(crate::mvp_sync_db::checkpoint_conflicts(&c)
        .unwrap()
        .is_empty());
    assert_eq!(
        scalar(&c, "SELECT COUNT(*) FROM mvp_sync_conflict_resolutions").unwrap(),
        1
    );
}
#[test]
fn checkpoint_dependency_order_materializes_children_and_links_without_quarantine() {
    let cfg = config("source");
    let mut a = connection(&cfg);
    for (id, parent) in [("z-parent", None), ("a-child", Some("z-parent"))] {
        a.execute("INSERT INTO calendar_goals(id,title,parent_goal_id,created_at,updated_at) VALUES(?1,?1,?2,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')",params![id,parent]).unwrap();
    }
    task(&a, "linked", "synthetic linked task");
    a.execute("INSERT INTO calendar_task_goals(source_type,source_id,goal_id,created_at) VALUES('note','linked','a-child','2026-09-14T00:00:00Z')",[]).unwrap();
    let mut seq = 0;
    drain_local(&mut a, &cfg, &mut seq);
    capture(&mut a, &cfg, 0).unwrap();
    let peer_cfg = config("peer");
    let mut b = connection(&peer_cfg);
    let d = descriptor(&a, &cfg, &b);
    install(&mut b, &peer_cfg, &d).unwrap();
    assert_eq!(
        scalar(&b, "SELECT COUNT(*) FROM calendar_goals").unwrap(),
        2
    );
    assert_eq!(
        scalar(&b, "SELECT COUNT(*) FROM calendar_task_goals").unwrap(),
        1
    );
    assert_eq!(pending::count(&b).unwrap(), 0);
}

#[test]
fn checkpoint_publication_requires_retained_resolution_provenance() {
    let cfg = config("source");
    let mut source = connection(&cfg);
    let mut seq = 0;
    drain_local(&mut source, &cfg, &mut seq);
    source.execute("INSERT INTO mvp_sync_conflict_resolutions VALUES('synthetic','2026-09-14T00:00:00.000Z','peer','unrecoverable-hash','current','2026-09-14T00:00:00.000Z')",[]).unwrap();
    assert!(!capture(&mut source, &cfg, 0).unwrap());
    assert_eq!(
        scalar(&source, "SELECT COUNT(*) FROM mvp_sync_checkpoint_jobs").unwrap(),
        0
    );
}

#[test]
fn checkpoint_abandoned_upload_without_successor_retires_only_transfer_cache() {
    use std::io::{Read, Write};
    for (status, code) in [(409, "checkpoint_not_staging"), (404, "checkpoint_missing")] {
        let (mut source, mut cfg) = source();
        task(
            &source,
            "later-local",
            "synthetic local value after capture",
        );
        enqueue(&mut source, &cfg).unwrap();
        let before = queues(&source);
        let cursor = scalar(&source, "SELECT receive_seq FROM content_sync_state").unwrap();
        let ledger = crate::mvp_sync_db::day_ledger(&source).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        cfg.endpoint = format!("http://{}/content", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            // The real Worker race is covered by its lease tests. These two
            // bounded responses exercise the native recovery branch itself.
            for (status, body) in [
                (status, json!({"error":code}).to_string()),
                (404, json!({"error":"checkpoint_missing"}).to_string()),
            ] {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(std::time::Instant::now() < deadline);
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => panic!("synthetic listener failed"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = vec![];
                let mut buffer = [0; 2048];
                loop {
                    let n = stream.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    assert!(bytes.len() < 16384);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = std::str::from_utf8(&bytes[..end]).unwrap();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.split_once(':')
                                    .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                                    .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                write!(stream,"HTTP/1.1 {status} Synthetic\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        assert!(upload_step(&mut source, &cfg, client().unwrap()).unwrap());
        server.join().unwrap();
        assert!(load::<Upload>(&source, "upload").unwrap().is_none());
        assert_eq!(queues(&source), before);
        assert_eq!(
            scalar(&source, "SELECT receive_seq FROM content_sync_state").unwrap(),
            cursor
        );
        assert_eq!(crate::mvp_sync_db::day_ledger(&source).unwrap(), ledger);
        assert!(!capture(&mut source, &cfg, 0).unwrap());
    }
}
