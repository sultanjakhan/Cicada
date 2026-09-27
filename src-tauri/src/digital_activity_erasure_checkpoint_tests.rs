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

fn event(conn: &Connection, device: &str, day: &str) -> String {
    let id = format!("digital-activity:{device}:{day}");
    let tags = json!([
        "digital-activity:v1",
        format!("digital-activity-device:{device}"),
        format!("digital-activity-day:{day}")
    ])
    .to_string();
    conn.execute("INSERT INTO items(id,kind,title,date,duration_minutes,version,created_at,updated_at,tags) VALUES(?1,'event','Synthetic aggregate',?2,2,1,'2026-01-15T00:00:00Z','2026-01-15T00:00:00Z',?3)",params![id,day,tags]).unwrap();
    id
}
fn snapshot(conn: &Connection, kind: &str, keys: Value) -> Row {
    snapshot_row(
        conn,
        "mvp_records",
        &json!([kind, keys]).to_string(),
        "source",
    )
    .unwrap()
}
fn plain(rows: Vec<Row>) -> Vec<u8> {
    let mut bytes = Vec::new();
    append(
        &mut bytes,
        &Line::Header(Header {
            v: 1,
            schema: SCHEMA.into(),
            tables: tables(),
            base_seq: 5,
            applied_seq: 5,
            receipts: vec![],
            watermarks: vec![Watermark {
                device_id: "source".into(),
                client_seq: 1,
                server_seq: 5,
            }],
        }),
    )
    .unwrap();
    for row in rows {
        append(&mut bytes, &Line::Row(row)).unwrap();
    }
    bytes
}
#[test]
fn erasure_encrypted_checkpoint_reorders_marker_and_live_rows_without_resurrection() {
    use crate::digital_activity::erasure::{self, KEY};
    let cfg = config("source");
    let mut source = connection(&cfg);
    let device = uuid::Uuid::new_v4().to_string();
    let id = event(&source, &device, "2026-01-15");
    let mut live = snapshot(&source, "items", json!([id]));
    live.f
        .insert("updated_at".into(), json!("2099-01-01T00:00:00.000Z"));
    live.f
        .insert("_updated_at".into(), json!("2099-01-01T00:00:00.000Z"));
    erasure::erase(&mut source, &device, "2026-01-17", Some(1)).unwrap();
    let marker = snapshot(&source, "ui", json!([KEY, device]));
    for rows in [
        vec![live.clone(), marker.clone()],
        vec![marker.clone(), live.clone()],
    ] {
        let peer_cfg = config("receiver");
        let mut peer = connection(&peer_cfg);
        let own = event(&peer, &device, "2026-01-16");
        peer.execute("INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at) VALUES('ordinary','event','Unrelated',0,1,'a','a')",[]).unwrap();
        let d = stage_plain(&peer, &cfg, &plain(rows), 5, 5);
        install(&mut peer, &peer_cfg, &d).unwrap();
        assert_eq!(
            erasure::cutoff(&peer, &device).unwrap().as_deref(),
            Some("2026-01-17")
        );
        assert_eq!(scalar(&peer, "SELECT count(*) FROM items").unwrap(), 1);
        assert_eq!(
            peer.query_row("SELECT id FROM items", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ordinary"
        );
        let own_record = snapshot(&peer, "items", json!([own]));
        assert_eq!(
            serde_json::from_str::<Value>(own_record.f["data"].as_str().unwrap()).unwrap()
                ["deleted"],
            true
        );
        assert_eq!(
            scalar(&peer, "SELECT count(*) FROM content_sync_pending").unwrap(),
            0
        );
    }
    // An old backup checkpoint with a newer live version cannot remove an
    // already-present boundary or restore its event (the restore is a merge).
    let peer_cfg = config("receiver");
    let mut peer = connection(&peer_cfg);
    event(&peer, &device, "2026-01-15");
    erasure::erase(&mut peer, &device, "2026-01-17", None).unwrap();
    let d = stage_plain(&peer, &cfg, &plain(vec![live]), 5, 5);
    install(&mut peer, &peer_cfg, &d).unwrap();
    assert_eq!(scalar(&peer, "SELECT count(*) FROM items").unwrap(), 0);
    assert_eq!(
        erasure::cutoff(&peer, &device).unwrap().as_deref(),
        Some("2026-01-17")
    );
}
#[test]
fn erasure_invalid_checkpoint_marker_rolls_back_atomically() {
    use crate::digital_activity::erasure::{self, KEY};
    let cfg = config("source");
    let mut source = connection(&cfg);
    let device = uuid::Uuid::new_v4().to_string();
    let id = event(&source, &device, "2026-01-15");
    let live = snapshot(&source, "items", json!([id]));
    erasure::erase(&mut source, &device, "2026-01-15", None).unwrap();
    let mut marker = snapshot(&source, "ui", json!([KEY, device]));
    let mut data: Value = serde_json::from_str(marker.f["data"].as_str().unwrap()).unwrap();
    data["value"]["deletedThrough"] = json!("2026-02-30");
    marker.f.insert("data".into(), json!(data.to_string()));
    let peer_cfg = config("receiver");
    let mut peer = connection(&peer_cfg);
    let d = stage_plain(&peer, &cfg, &plain(vec![live, marker]), 5, 5);
    assert_eq!(
        install(&mut peer, &peer_cfg, &d).unwrap_err(),
        "content_sync_unknown_schema"
    );
    assert_eq!(scalar(&peer, "SELECT count(*) FROM items").unwrap(), 0);
    assert_eq!(
        scalar(&peer, "SELECT receive_seq FROM content_sync_state").unwrap(),
        0
    );
    assert!(erasure::cutoff(&peer, &device).unwrap().is_none());
}
