//! Encrypted, resumable checkpoint transport. Working data is changed only after
//! every authenticated part and the complete JSONL snapshot have been verified.
use super::super::{decode, opaque_id};
use super::*;

const SCHEMA: &str = "hanni-mvp-checkpoint-v1";
const MAX_PLAIN: usize = 64 * 1024 * 1024;
const MAX_ENCRYPTED: usize = 128 * 1024 * 1024;
const PART: usize = 60_000;
const MAX_PARTS: usize = MAX_PLAIN.div_ceil(PART);
const REQUESTS_PER_STEP: usize = 4;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Receipt {
    device_id: String,
    applied_seq: i64,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Watermark {
    device_id: String,
    client_seq: i64,
    server_seq: i64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    v: u8,
    schema: String,
    tables: Vec<String>,
    base_seq: i64,
    applied_seq: i64,
    receipts: Vec<Receipt>,
    watermarks: Vec<Watermark>,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", deny_unknown_fields)]
enum Line {
    Header(Header),
    Row(Row),
    Conflict(Value),
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    v: u8,
    schema: String,
    tables: Vec<String>,
    base_seq: i64,
    applied_seq: i64,
    chunk_count: usize,
    chunk_root_sha256: String,
    plain_bytes: usize,
    plain_sha256: String,
    receipts: Vec<Receipt>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Summary {
    checkpoint_id: String,
    base_seq: i64,
    generation: i64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    checkpoint_id: String,
    base_seq: i64,
    generation: i64,
    uploader_device_id: String,
    chunk_count: usize,
    total_bytes: usize,
    chunk_root_sha256: String,
    envelope_sha256: String,
    envelope: Envelope,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Upload {
    checkpoint_id: String,
    expected_generation: i64,
    base_seq: i64,
    chunk_count: usize,
    total_bytes: usize,
    chunk_root_sha256: String,
    envelope: Envelope,
    next_part: usize,
    lease_epoch: Option<i64>,
    expires_at: i64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Download {
    summary: Summary,
    read_lease_id: Option<String>,
    expires_at: i64,
    descriptor: Option<Descriptor>,
    next_part: usize,
}

pub(super) fn initialize(conn: &Connection) -> Result<(), String> {
    sql(conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mvp_sync_checkpoint_state(
      id INTEGER PRIMARY KEY CHECK(id=1), next_attempt INTEGER NOT NULL DEFAULT 0,
      checked_at INTEGER NOT NULL DEFAULT 0, last_base INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0, last_error TEXT);
      INSERT OR IGNORE INTO mvp_sync_checkpoint_state(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS mvp_sync_checkpoint_jobs(
      direction TEXT PRIMARY KEY CHECK(direction IN ('upload','download')),body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_sync_checkpoint_parts(
      direction TEXT NOT NULL CHECK(direction IN ('upload','download')),part INTEGER NOT NULL,
      envelope TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(direction,part));",
    ))
}
fn tables() -> Vec<String> {
    vec!["mvp_records".into()]
}
fn url(cfg: &RelayConfig, path: &str) -> String {
    format!("{}{}", cfg.endpoint, path)
}
fn digest_valid(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id)
        .ok()
        .map(|v| v.to_string())
        .as_deref()
        == Some(id)
}
fn sequence(value: i64) -> bool {
    (1..=9_007_199_254_740_991).contains(&value)
}
fn valid_summary(s: &Summary) -> bool {
    valid_id(&s.checkpoint_id) && sequence(s.base_seq) && sequence(s.generation)
}
fn encode<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| "content_sync_checkpoint_encode_failed".into())
}
fn parse<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    serde_json::from_slice(bytes).map_err(|_| "content_sync_checkpoint_invalid_data".into())
}
fn load<T: serde::de::DeserializeOwned>(
    conn: &Connection,
    direction: &str,
) -> Result<Option<T>, String> {
    let body: Option<String> = sql(conn
        .query_row(
            "SELECT body FROM mvp_sync_checkpoint_jobs WHERE direction=?1",
            [direction],
            |r| r.get(0),
        )
        .optional())?;
    body.map(|v| parse(v.as_bytes())).transpose()
}
fn save<T: Serialize>(conn: &Connection, direction: &str, job: &T) -> Result<(), String> {
    sql(conn.execute(
        "INSERT INTO mvp_sync_checkpoint_jobs VALUES(?1,?2)
        ON CONFLICT(direction) DO UPDATE SET body=excluded.body",
        params![direction, encode(job)?],
    ))?;
    Ok(())
}
fn clear(conn: &Connection, direction: &str) -> Result<(), String> {
    sql(conn.execute(
        "DELETE FROM mvp_sync_checkpoint_parts WHERE direction=?1",
        [direction],
    ))?;
    sql(conn.execute(
        "DELETE FROM mvp_sync_checkpoint_jobs WHERE direction=?1",
        [direction],
    ))?;
    Ok(())
}
fn part_aad(sender: &str, id: &str, key: &str, base: i64, index: Option<usize>) -> Vec<u8> {
    let value = match index {
        Some(i) => json!(["hanni-mvp-checkpoint-part-v1", sender, id, key, base, i]),
        None => json!(["hanni-mvp-checkpoint-manifest-v1", sender, id, key, base]),
    };
    serde_json::to_vec(&value).expect("JSON primitives serialize")
}
fn seal(
    cfg: &RelayConfig,
    id: &str,
    base: i64,
    index: Option<usize>,
    plain: &[u8],
) -> Result<Envelope, String> {
    if plain.len() > PART {
        return Err("content_sync_checkpoint_manifest_too_large".into());
    }
    let key: [u8; 32] = decode(&cfg.key, 32)?
        .try_into()
        .map_err(|_| "relay_invalid_key")?;
    let blob = super::super::encrypt_bytes(
        &key,
        &part_aad(&cfg.device_id, id, &cfg.key_id, base, index),
        plain,
    )?;
    Ok(Envelope {
        v: 1,
        alg: "XChaCha20-Poly1305".into(),
        key_id: cfg.key_id.clone(),
        nonce: B64.encode(&blob[..24]),
        ciphertext: B64.encode(&blob[24..]),
    })
}
fn open(
    cfg: &RelayConfig,
    sender: &str,
    id: &str,
    base: i64,
    index: Option<usize>,
    env: &Envelope,
) -> Result<Vec<u8>, String> {
    if env.v != 1
        || env.alg != "XChaCha20-Poly1305"
        || env.key_id != cfg.key_id
        || !opaque_id(sender)
        || !valid_id(id)
        || !sequence(base)
    {
        return Err("content_sync_checkpoint_invalid_envelope".into());
    }
    let mut blob = decode(&env.nonce, 24)?;
    let ciphertext = B64
        .decode(&env.ciphertext)
        .map_err(|_| "relay_invalid_encoding")?;
    if !(16..=65536).contains(&ciphertext.len()) || B64.encode(&ciphertext) != env.ciphertext {
        return Err("content_sync_checkpoint_invalid_envelope".into());
    }
    blob.extend(ciphertext);
    let key: [u8; 32] = decode(&cfg.key, 32)?
        .try_into()
        .map_err(|_| "relay_invalid_key")?;
    super::super::decrypt_bytes(&key, &part_aad(sender, id, &cfg.key_id, base, index), &blob)
}
fn append(plain: &mut Vec<u8>, line: &Line) -> Result<(), String> {
    let bytes = serde_json::to_vec(line).map_err(|_| "content_sync_checkpoint_encode_failed")?;
    if plain.len().saturating_add(bytes.len()).saturating_add(1) > MAX_PLAIN {
        return Err("content_sync_checkpoint_capacity_exceeded".into());
    }
    plain.extend(bytes);
    plain.push(b'\n');
    Ok(())
}
fn receipts(conn: &Connection) -> Result<Vec<Receipt>, String> {
    let mut s = sql(
        conn.prepare("SELECT device_id,applied_seq FROM content_sync_receipts ORDER BY device_id")
    )?;
    let rows = sql(s.query_map([], |r| {
        Ok(Receipt {
            device_id: r.get(0)?,
            applied_seq: r.get(1)?,
        })
    }))?;
    sql(rows.collect())
}
fn watermarks(conn: &Connection) -> Result<Vec<Watermark>, String> {
    let mut s = sql(conn.prepare("SELECT device_id,client_seq,server_seq FROM content_sync_sender_watermarks ORDER BY device_id"))?;
    let rows = sql(s.query_map([], |r| {
        Ok(Watermark {
            device_id: r.get(0)?,
            client_seq: r.get(1)?,
            server_seq: r.get(2)?,
        })
    }))?;
    sql(rows.collect())
}
fn snapshot_row(conn: &Connection, table: &str, id: &str, _writer: &str) -> Result<Row, String> {
    let Some(Value::Object(mut f)) =
        crate::mvp_sync_db::row_to_json(conn, table, &rusqlite::types::Value::Text(id.into()))
            .map_err(|_| "content_sync_checkpoint_row_failed")?
    else {
        return Err("content_sync_checkpoint_row_failed".into());
    };
    let ts = f
        .get("updated_at")
        .and_then(Value::as_str)
        .ok_or("relay_missing_timestamp")?;
    let ts = crate::mvp_sync_db::canonical_sync_timestamp(ts, "relay")
        .map_err(|_| "relay_invalid_timestamp")?;
    let version: Option<(String, String)> = sql(conn
        .query_row(
            "SELECT updated_at,device_id FROM sync_row_versions
        WHERE table_name=?1 AND row_id=?2",
            params![table, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())?;
    let origin = version
        .filter(|(v, _)| {
            crate::mvp_sync_db::canonical_sync_timestamp(v, "relay")
                .ok()
                .as_deref()
                == Some(&ts)
        })
        .map(|(_, d)| d)
        .ok_or("content_sync_checkpoint_row_version_missing")?;
    f.insert("updated_at".into(), json!(ts));
    f.insert("_updated_at".into(), json!(ts));
    f.insert("_device_id".into(), json!(origin));
    crate::mvp_sync_db::validate_record(conn, &f)?;
    Ok(Row { t: table.into(), f })
}

/// Capture and encrypted staging commit are one SQLite transaction. The staging
/// tables contain ciphertext only; encryption is never repeated on an HTTP retry.
fn capture(
    conn: &mut Connection,
    cfg: &RelayConfig,
    expected_generation: i64,
) -> Result<bool, String> {
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    if load::<Upload>(&tx, "upload")?.is_some() {
        return Ok(true);
    }
    let base = scalar(&tx, "SELECT receive_seq FROM content_sync_state WHERE id=1")?;
    if base == 0 {
        return Ok(false);
    }
    // A snapshot can cover only a completely materialized, acknowledged prefix.
    // Incomplete fragments, local edits and quarantined rows are never discarded.
    if !capture_ready(&tx)? {
        return Ok(false);
    }
    let applied = base;
    let writer: String = sql(tx.query_row(
        "SELECT value FROM app_settings WHERE key='device_id'",
        [],
        |r| r.get(0),
    ))?;
    let receipts = receipts(&tx)?;
    let header = Header {
        v: 1,
        schema: SCHEMA.into(),
        tables: tables(),
        base_seq: base,
        applied_seq: base,
        receipts: receipts.clone(),
        watermarks: watermarks(&tx)?,
    };
    validate_header(&header)?;
    let mut plain = vec![];
    append(&mut plain, &Line::Header(header))?;
    let mut statement = sql(tx.prepare("SELECT id FROM mvp_records ORDER BY id"))?;
    let mut rows = sql(statement.query([]))?;
    while let Some(row) = sql(rows.next())? {
        append(
            &mut plain,
            &Line::Row(snapshot_row(
                &tx,
                "mvp_records",
                &sql(row.get::<_, String>(0))?,
                &writer,
            )?),
        )?;
    }
    drop(rows);
    drop(statement);
    for conflict in crate::mvp_sync_db::checkpoint_conflicts(&tx)? {
        crate::mvp_sync_db::checkpoint_merge_conflict(&tx, &conflict)?;
        append(&mut plain, &Line::Conflict(conflict))?;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut digests = vec![];
    let mut total = 0;
    for (index, part) in plain.chunks(PART).enumerate() {
        let envelope = seal(cfg, &id, base, Some(index), part)?;
        let body = encode(&envelope)?;
        let digest = hash(body.as_bytes());
        total += body.len();
        sql(tx.execute(
            "INSERT INTO mvp_sync_checkpoint_parts VALUES('upload',?1,?2,?3)",
            params![index, body, digest],
        ))?;
        digests.push(digest);
    }
    if total > MAX_ENCRYPTED || digests.is_empty() || digests.len() > MAX_PARTS {
        return Err("content_sync_checkpoint_capacity_exceeded".into());
    }
    let root = hash(encode(&digests)?.as_bytes());
    let manifest = Manifest {
        v: 1,
        schema: SCHEMA.into(),
        tables: tables(),
        base_seq: base,
        applied_seq: applied,
        chunk_count: digests.len(),
        chunk_root_sha256: root.clone(),
        plain_bytes: plain.len(),
        plain_sha256: hash(&plain),
        receipts,
    };
    let upload = Upload {
        checkpoint_id: id.clone(),
        expected_generation,
        base_seq: base,
        chunk_count: digests.len(),
        total_bytes: total,
        chunk_root_sha256: root,
        envelope: seal(cfg, &id, base, None, encode(&manifest)?.as_bytes())?,
        next_part: 0,
        lease_epoch: None,
        expires_at: 0,
    };
    save(&tx, "upload", &upload)?;
    sql(tx.commit())?;
    Ok(true)
}

fn capture_ready(conn: &Connection) -> Result<bool, String> {
    if !crate::mvp_sync_db::checkpoint_publishable(conn)? {
        return Ok(false);
    }
    Ok(scalar(conn,"SELECT (SELECT COUNT(*) FROM content_sync_dirty)+(SELECT COUNT(*) FROM content_sync_outbox)+(SELECT COUNT(*) FROM content_sync_outbound_fragments)+(SELECT COUNT(*) FROM content_sync_fragments)+(SELECT COUNT(*) FROM content_sync_fragments_v2)+(SELECT COUNT(*) FROM content_sync_pending)+(SELECT COUNT(*) FROM sync_tombstones WHERE table_name='mvp_records')")?==0)
}
fn validate_header(h: &Header) -> Result<(), String> {
    if h.v != 1
        || h.schema != SCHEMA
        || h.tables != tables()
        || !sequence(h.base_seq)
        || h.applied_seq != h.base_seq
        || h.receipts.len() > 64
        || h.watermarks.len() > 64
    {
        return Err("content_sync_checkpoint_invalid_header".into());
    }
    let mut ids = std::collections::HashSet::new();
    for r in &h.receipts {
        if !opaque_id(&r.device_id)
            || !(0..=h.base_seq).contains(&r.applied_seq)
            || !ids.insert(&r.device_id)
        {
            return Err("content_sync_checkpoint_invalid_receipt".into());
        }
    }
    ids.clear();
    for w in &h.watermarks {
        if !opaque_id(&w.device_id)
            || !sequence(w.client_seq)
            || !(1..=h.base_seq).contains(&w.server_seq)
            || !ids.insert(&w.device_id)
        {
            return Err("content_sync_checkpoint_invalid_watermark".into());
        }
    }
    if h.watermarks.iter().map(|w| w.server_seq).max() != Some(h.base_seq) {
        return Err("content_sync_checkpoint_invalid_watermark".into());
    }
    Ok(())
}
fn manifest(cfg: &RelayConfig, d: &Descriptor) -> Result<Manifest, String> {
    if !valid_summary(&Summary {
        checkpoint_id: d.checkpoint_id.clone(),
        base_seq: d.base_seq,
        generation: d.generation,
    }) || d.chunk_count == 0
        || d.chunk_count > MAX_PARTS
        || d.total_bytes == 0
        || d.total_bytes > MAX_ENCRYPTED
        || !digest_valid(&d.chunk_root_sha256)
        || envelope_hash(&d.envelope)? != d.envelope_sha256
    {
        return Err("content_sync_checkpoint_invalid_descriptor".into());
    }
    let m: Manifest = parse(&open(
        cfg,
        &d.uploader_device_id,
        &d.checkpoint_id,
        d.base_seq,
        None,
        &d.envelope,
    )?)?;
    if m.v != 1
        || m.schema != SCHEMA
        || m.tables != tables()
        || m.base_seq != d.base_seq
        || m.chunk_count != d.chunk_count
        || m.chunk_root_sha256 != d.chunk_root_sha256
        || m.plain_bytes == 0
        || m.plain_bytes > MAX_PLAIN
        || !digest_valid(&m.plain_sha256)
        || !(0..=m.base_seq).contains(&m.applied_seq)
        || m.receipts.len() > 64
    {
        return Err("content_sync_checkpoint_invalid_manifest".into());
    }
    Ok(m)
}

fn stage_part(
    conn: &Connection,
    direction: &str,
    index: usize,
    envelope: &Envelope,
    digest: &str,
) -> Result<(), String> {
    let body = encode(envelope)?;
    if hash(body.as_bytes()) != digest {
        return Err("content_sync_checkpoint_part_hash_mismatch".into());
    }
    let existing: Option<String> = sql(conn
        .query_row(
            "SELECT digest FROM mvp_sync_checkpoint_parts
        WHERE direction=?1 AND part=?2",
            params![direction, index],
            |r| r.get(0),
        )
        .optional())?;
    if existing.as_ref().is_some_and(|v| v != digest) {
        return Err("content_sync_checkpoint_part_changed".into());
    }
    sql(conn.execute(
        "INSERT OR IGNORE INTO mvp_sync_checkpoint_parts VALUES(?1,?2,?3,?4)",
        params![direction, index, body, digest],
    ))?;
    Ok(())
}
fn load_part(
    conn: &Connection,
    direction: &str,
    index: usize,
) -> Result<(Envelope, String), String> {
    let (body, digest): (String, String) = sql(conn.query_row(
        "SELECT envelope,digest FROM mvp_sync_checkpoint_parts
        WHERE direction=?1 AND part=?2",
        params![direction, index],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    let envelope: Envelope = parse(body.as_bytes())?;
    if envelope_hash(&envelope)? != digest {
        return Err("content_sync_checkpoint_part_hash_mismatch".into());
    }
    Ok((envelope, digest))
}
fn verified_plain(
    conn: &Connection,
    cfg: &RelayConfig,
    d: &Descriptor,
) -> Result<(Manifest, Vec<u8>), String> {
    let m = manifest(cfg, d)?;
    let mut plain = Vec::with_capacity(m.plain_bytes);
    let mut digests = vec![];
    let mut total = 0;
    for index in 0..d.chunk_count {
        let (env, digest) = load_part(conn, "download", index)?;
        total += encode(&env)?.len();
        let bytes = open(
            cfg,
            &d.uploader_device_id,
            &d.checkpoint_id,
            d.base_seq,
            Some(index),
            &env,
        )?;
        if bytes.is_empty()
            || bytes.len() > PART
            || plain.len().saturating_add(bytes.len()) > m.plain_bytes
        {
            return Err("content_sync_checkpoint_plain_size_mismatch".into());
        }
        plain.extend(bytes);
        digests.push(digest);
    }
    if total != d.total_bytes
        || hash(encode(&digests)?.as_bytes()) != d.chunk_root_sha256
        || plain.len() != m.plain_bytes
        || hash(&plain) != m.plain_sha256
        || plain.last() != Some(&b'\n')
    {
        return Err("content_sync_checkpoint_incomplete".into());
    }
    Ok((m, plain))
}
fn install(conn: &mut Connection, cfg: &RelayConfig, d: &Descriptor) -> Result<usize, String> {
    let (m, plain) = verified_plain(conn, cfg, d)?;
    let mut lines = plain[..plain.len() - 1].split(|b| *b == b'\n');
    let Line::Header(h) = parse(
        lines
            .next()
            .ok_or("content_sync_checkpoint_invalid_header")?,
    )?
    else {
        return Err("content_sync_checkpoint_invalid_header".into());
    };
    validate_header(&h)?;
    if h.base_seq != m.base_seq || h.applied_seq != m.applied_seq || h.receipts != m.receipts {
        return Err("content_sync_checkpoint_header_mismatch".into());
    }
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let before = scalar(&tx, "SELECT receive_seq FROM content_sync_state WHERE id=1")?;
    let mut records = vec![];
    let mut conflicts = vec![];
    let mut seen = std::collections::HashSet::new();
    for line in lines {
        match parse::<Line>(line)? {
            Line::Row(row) => {
                if row.t != "mvp_records" || !conflicts.is_empty() {
                    return Err("content_sync_checkpoint_row_order".into());
                }
                crate::mvp_sync_db::validate_record(&tx, &row.f)?;
                if !seen.insert(remote_id(
                    row.f.get("id").ok_or("content_sync_invalid_identity")?,
                )?) {
                    return Err("content_sync_checkpoint_duplicate_row".into());
                }
                records.push(row);
            }
            Line::Conflict(value) => conflicts.push(value),
            Line::Header(_) => return Err("content_sync_checkpoint_duplicate_header".into()),
        }
    }
    let mut applied = 0;
    if d.base_seq > before {
        for old in watermarks(&tx)? {
            let new = h
                .watermarks
                .iter()
                .find(|w| w.device_id == old.device_id)
                .ok_or("content_sync_checkpoint_watermark_missing")?;
            if new.client_seq < old.client_seq
                || new.server_seq < old.server_seq
                || (new.client_seq == old.client_seq && new.server_seq != old.server_seq)
            {
                return Err("content_sync_checkpoint_watermark_regressed".into());
            }
        }
        sql(tx.execute("UPDATE content_sync_control SET applying=1 WHERE id=1", []))?;
        // Merge keeps local dirty/outbox records and their archive. The producer
        // has fully assembled this prefix, so covered receiver fragments retire.
        let mut waiting = Vec::with_capacity(records.len());
        for row in records {
            waiting.push(pending::Pending {
                sender: d.uploader_device_id.clone(),
                table_name: row.t.clone(),
                remote_id: remote_id(row.f.get("id").ok_or("content_sync_invalid_identity")?)?,
                kind: "row".into(),
                stamp: row.f["updated_at"]
                    .as_str()
                    .ok_or("content_sync_missing_timestamp")?
                    .into(),
                payload: encode(&row)?,
                error_code: "content_sync_row_apply_failed".into(),
            });
        }
        // Snapshot order is canonical key order, not foreign-key order. Resolve
        // its dependencies before consuming the bounded durable quarantine.
        let mut attempts = 0;
        for _ in 0..64 {
            let mut remaining = vec![];
            let mut resolved = 0;
            for mut record in waiting {
                attempts += 1;
                if attempts > 1_000_000 {
                    return Err("content_sync_checkpoint_dependency_capacity".into());
                }
                match try_record(&tx, &record) {
                    Ok(changed) => {
                        applied += usize::from(changed);
                        resolved += 1;
                    }
                    Err(error) => {
                        record.error_code = error;
                        remaining.push(record);
                    }
                }
            }
            waiting = remaining;
            if resolved == 0 || waiting.is_empty() {
                break;
            }
        }
        for record in waiting {
            pending::put(&tx, &record)?;
        }
        for conflict in conflicts {
            crate::mvp_sync_db::checkpoint_merge_conflict(&tx, &conflict)?;
        }
        // Retry enough pages to resolve parent-before-child ordering while keeping
        // local incompatible edits quarantined, with the existing bounded queue.
        for _ in 0..32 {
            let n = retry_pending_in_transaction(&tx)?;
            applied += n;
            if pending::count(&tx)? == 0 {
                break;
            }
        }
        sql(tx.execute("DELETE FROM content_sync_fragments", []))?;
        sql(tx.execute("DELETE FROM content_sync_fragments_v2", []))?;
        for w in &h.watermarks {
            sql(tx.execute("INSERT INTO content_sync_sender_watermarks VALUES(?1,?2,?3) ON CONFLICT(device_id) DO UPDATE SET client_seq=excluded.client_seq,server_seq=excluded.server_seq",params![w.device_id,w.client_seq,w.server_seq]))?;
        }
        for r in &h.receipts {
            sql(tx.execute("INSERT INTO content_sync_receipts VALUES(?1,?2) ON CONFLICT(device_id) DO UPDATE SET applied_seq=MAX(applied_seq,excluded.applied_seq)",params![r.device_id,r.applied_seq]))?;
        }
        sql(tx.execute("UPDATE content_sync_state SET receive_seq=?1,receipt_needed=1,pull_error=NULL,pull_not_before=0 WHERE id=1",[d.base_seq]))?;
        sql(tx.execute("UPDATE content_sync_control SET applying=0 WHERE id=1", []))?;
    }
    clear(&tx, "download")?;
    if load::<Upload>(&tx, "upload")?.is_some_and(|u| d.generation > u.expected_generation) {
        clear(&tx, "upload")?;
    }
    sql(tx.execute("UPDATE mvp_sync_checkpoint_state SET last_base=MAX(last_base,?1),generation=MAX(generation,?2),last_error=NULL,next_attempt=0,checked_at=?3 WHERE id=1",params![d.base_seq,d.generation,chrono::Utc::now().timestamp()]))?;
    sql(tx.commit())?;
    Ok(applied)
}

struct Reply {
    status: u16,
    value: Value,
    retry: i64,
}
fn request(request: reqwest::blocking::RequestBuilder) -> Result<Reply, String> {
    let response = request.send().map_err(|_| "relay_network_unavailable")?;
    let status = response.status().as_u16();
    let retry = response
        .headers()
        .get("Retry-After")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(if status == 507 { 3600 } else { 60 })
        .clamp(1, 86400);
    let mut bytes = vec![];
    response
        .take((RESPONSE_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "relay_response_failed")?;
    if bytes.len() > RESPONSE_LIMIT {
        return Err("relay_response_too_large".into());
    }
    Ok(Reply {
        status,
        value: parse(&bytes)?,
        retry,
    })
}
fn success(conn: &Connection, reply: Reply) -> Result<Value, String> {
    if (200..300).contains(&reply.status) {
        return Ok(reply.value);
    }
    let code = reply
        .value
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("http_error");
    let allowed = code.len() <= 64 && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    let error = if allowed {
        format!("content_sync_checkpoint_{code}")
    } else {
        format!("content_sync_checkpoint_http_{}", reply.status)
    };
    sql(conn.execute(
        "UPDATE mvp_sync_checkpoint_state SET next_attempt=MAX(next_attempt,?1),last_error=?2 WHERE id=1",
        params![chrono::Utc::now().timestamp() + reply.retry,error],
    ))?;
    Err(error)
}

pub(super) fn retry_after(conn: &Connection) -> Result<i64, String> {
    Ok((scalar(
        conn,
        "SELECT next_attempt FROM mvp_sync_checkpoint_state WHERE id=1",
    )? - chrono::Utc::now().timestamp())
    .max(0))
}
fn from_value<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|_| "content_sync_checkpoint_invalid_response".into())
}
fn begin_download(conn: &mut Connection, summary: Summary) -> Result<(), String> {
    if !valid_summary(&summary) {
        return Err("content_sync_checkpoint_invalid_summary".into());
    }
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    if let Some(old) = load::<Download>(&tx, "download")? {
        if old.summary.checkpoint_id == summary.checkpoint_id {
            return Ok(());
        }
        if old.summary.generation > summary.generation {
            return Err("content_sync_checkpoint_generation_regressed".into());
        }
    }
    clear(&tx, "download")?;
    save(
        &tx,
        "download",
        &Download {
            summary,
            read_lease_id: None,
            expires_at: 0,
            descriptor: None,
            next_part: 0,
        },
    )?;
    sql(tx.commit())
}
fn latest(
    conn: &Connection,
    cfg: &RelayConfig,
    http: &reqwest::blocking::Client,
) -> Result<Option<Summary>, String> {
    let response = request(
        http.get(url(cfg, "/v1/checkpoints/latest"))
            .bearer_auth(&cfg.token),
    )?;
    if response.status == 404 {
        return Ok(None);
    }
    let summary: Summary = from_value(success(conn, response)?)?;
    if !valid_summary(&summary) {
        return Err("content_sync_checkpoint_invalid_summary".into());
    }
    Ok(Some(summary))
}

/// Resumes only encrypted transfer state across failures/restarts. Up to four
/// requests; a renewed read lease never changes checkpoint ID or working data.
fn download_step(
    conn: &mut Connection,
    cfg: &RelayConfig,
    http: &reqwest::blocking::Client,
) -> Result<(usize, bool), String> {
    for _ in 0..REQUESTS_PER_STEP {
        let Some(mut job) = load::<Download>(conn, "download")? else {
            return Ok((0, false));
        };
        if job.expires_at <= chrono::Utc::now().timestamp_millis() || job.read_lease_id.is_none() {
            let reply = request(
                http.post(url(
                    cfg,
                    &format!("/v1/checkpoints/{}/read-lease", job.summary.checkpoint_id),
                ))
                .bearer_auth(&cfg.token)
                .json(&json!({})),
            )?;
            if reply.status == 404
                && reply.value.get("error").and_then(Value::as_str) == Some("checkpoint_missing")
            {
                if let Some(summary) = latest(conn, cfg, http)? {
                    begin_download(conn, summary)?;
                    return Ok((0, true));
                }
            }
            if reply.status == 410 {
                let summary = reply
                    .value
                    .get("checkpoint")
                    .cloned()
                    .or_else(|| reply.value.get("latest").cloned());
                if let Some(s) = summary {
                    begin_download(conn, from_value(s)?)?;
                    continue;
                }
            }
            #[derive(Deserialize)]
            struct Lease {
                checkpoint_id: String,
                read_lease_id: String,
                expires_at: i64,
            }
            let lease: Lease = from_value(success(conn, reply)?)?;
            if lease.checkpoint_id != job.summary.checkpoint_id
                || !valid_id(&lease.read_lease_id)
                || lease.expires_at <= chrono::Utc::now().timestamp_millis()
            {
                return Err("content_sync_checkpoint_invalid_read_lease".into());
            }
            job.read_lease_id = Some(lease.read_lease_id);
            job.expires_at = lease.expires_at;
            save(conn, "download", &job)?;
            continue;
        }
        let path = if job.descriptor.is_none() {
            format!("/v1/checkpoints/{}", job.summary.checkpoint_id)
        } else {
            format!(
                "/v1/checkpoints/{}/chunks/{}",
                job.summary.checkpoint_id, job.next_part
            )
        };
        if let Some(d) = &job.descriptor {
            if job.next_part == d.chunk_count {
                return Ok((install(conn, cfg, d)?, true));
            }
        }
        let reply = request(
            http.get(url(cfg, &path)).bearer_auth(&cfg.token).header(
                "X-Hanni-Read-Lease",
                job.read_lease_id
                    .as_deref()
                    .ok_or("content_sync_checkpoint_missing_lease")?,
            ),
        )?;
        let code = reply.value.get("error").and_then(Value::as_str);
        if reply.status == 409 && code == Some("read_lease_expired") {
            job.read_lease_id = None;
            job.expires_at = 0;
            save(conn, "download", &job)?;
            continue;
        }
        if reply.status == 410 {
            if let Some(s) = latest(conn, cfg, http)? {
                begin_download(conn, s)?;
                return Ok((0, true));
            }
        }
        let value = success(conn, reply)?;
        if job.descriptor.is_none() {
            let d: Descriptor = from_value(value)?;
            if d.checkpoint_id != job.summary.checkpoint_id
                || d.base_seq != job.summary.base_seq
                || d.generation != job.summary.generation
            {
                return Err("content_sync_checkpoint_descriptor_changed".into());
            }
            manifest(cfg, &d)?;
            job.descriptor = Some(d);
            save(conn, "download", &job)?;
        } else {
            #[derive(Deserialize)]
            struct Chunk {
                checkpoint_id: String,
                index: usize,
                envelope_sha256: String,
                envelope: Envelope,
            }
            let part: Chunk = from_value(value)?;
            if part.checkpoint_id != job.summary.checkpoint_id || part.index != job.next_part {
                return Err("content_sync_checkpoint_wrong_part".into());
            }
            // Authenticate before retaining data on disk, then authenticate again
            // with manifest/root and every other part before the atomic merge.
            let d = job
                .descriptor
                .as_ref()
                .ok_or("content_sync_checkpoint_missing_descriptor")?;
            open(
                cfg,
                &d.uploader_device_id,
                &d.checkpoint_id,
                d.base_seq,
                Some(part.index),
                &part.envelope,
            )?;
            let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
            stage_part(
                &tx,
                "download",
                part.index,
                &part.envelope,
                &part.envelope_sha256,
            )?;
            job.next_part += 1;
            save(&tx, "download", &job)?;
            sql(tx.commit())?;
        }
    }
    Ok((0, true))
}

fn upload_step(
    conn: &mut Connection,
    cfg: &RelayConfig,
    http: &reqwest::blocking::Client,
) -> Result<bool, String> {
    for _ in 0..REQUESTS_PER_STEP {
        let Some(mut job) = load::<Upload>(conn, "upload")? else {
            return Ok(false);
        };
        // Finalize is retried first, even after lease time, because the previous
        // request might have committed while its ACK was lost.
        let finalizing = job.next_part == job.chunk_count && job.lease_epoch.is_some();
        let leasing = !finalizing
            && (job.lease_epoch.is_none()
                || job.expires_at <= chrono::Utc::now().timestamp_millis() + 30_000);
        let reply = if finalizing {
            request(http.post(url(cfg, &format!("/v1/checkpoints/{}/finalize",job.checkpoint_id))).bearer_auth(&cfg.token)
                .json(&json!({"lease_epoch":job.lease_epoch,"chunk_root_sha256":job.chunk_root_sha256,"envelope":job.envelope})))?
        } else if leasing {
            request(http.post(url(cfg, "/v1/checkpoints/lease")).bearer_auth(&cfg.token).json(&json!({
                "checkpoint_id":job.checkpoint_id,"expected_generation":job.expected_generation,"base_seq":job.base_seq,
                "chunk_count":job.chunk_count,"total_bytes":job.total_bytes})))?
        } else {
            let (envelope, _) = load_part(conn, "upload", job.next_part)?;
            request(
                http.put(url(
                    cfg,
                    &format!(
                        "/v1/checkpoints/{}/chunks/{}",
                        job.checkpoint_id, job.next_part
                    ),
                ))
                .bearer_auth(&cfg.token)
                .json(&json!({"lease_epoch":job.lease_epoch,"envelope":envelope})),
            )?
        };
        let code = reply
            .value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("");
        if reply.status == 409 && code == "checkpoint_lease_expired" {
            job.lease_epoch = None;
            job.expires_at = 0;
            save(conn, "upload", &job)?;
            continue;
        }
        if (reply.status == 409
            && matches!(
                code,
                "checkpoint_generation_changed" | "checkpoint_not_staging"
            ))
            || (reply.status == 404 && code == "checkpoint_missing")
        {
            if let Some(summary) = latest(conn, cfg, http)? {
                begin_download(conn, summary)?;
                return Ok(true);
            }
            if matches!(code, "checkpoint_not_staging" | "checkpoint_missing") {
                // A rival may abandon this upload and then disappear before
                // publishing. Only transfer cache retires; a new capture must
                // pass every current prefix/queue precondition again.
                let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
                clear(&tx, "upload")?;
                sql(tx.execute("UPDATE mvp_sync_checkpoint_state SET checked_at=0,next_attempt=0,last_error=NULL WHERE id=1",[]))?;
                sql(tx.commit())?;
                return Ok(true);
            }
        }
        if reply.status == 409 && code == "checkpoint_incomplete" {
            job.next_part = 0;
            save(conn, "upload", &job)?;
            return Ok(true);
        }
        let value = success(conn, reply)?;
        if finalizing {
            #[derive(Deserialize)]
            struct Ack {
                checkpoint_id: String,
                base_seq: i64,
                generation: i64,
                envelope_sha256: String,
                duplicate: bool,
            }
            let ack: Ack = from_value(value)?;
            if ack.checkpoint_id != job.checkpoint_id
                || ack.base_seq != job.base_seq
                || ack.generation != job.expected_generation + 1
                || ack.envelope_sha256 != envelope_hash(&job.envelope)?
            {
                return Err("content_sync_checkpoint_invalid_finalize_ack".into());
            }
            let _ = ack.duplicate;
            let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
            clear(&tx, "upload")?;
            sql(tx.execute(
                "UPDATE mvp_sync_checkpoint_state SET last_base=?1,generation=?2,checked_at=?3,
                next_attempt=0,last_error=NULL WHERE id=1",
                params![ack.base_seq, ack.generation, chrono::Utc::now().timestamp()],
            ))?;
            sql(tx.commit())?;
            return Ok(false);
        } else if leasing {
            #[derive(Deserialize)]
            struct Lease {
                checkpoint_id: String,
                lease_epoch: i64,
                expires_at: i64,
            }
            let lease: Lease = from_value(value)?;
            if lease.checkpoint_id != job.checkpoint_id
                || !sequence(lease.lease_epoch)
                || lease.expires_at <= chrono::Utc::now().timestamp_millis()
            {
                return Err("content_sync_checkpoint_invalid_lease".into());
            }
            job.lease_epoch = Some(lease.lease_epoch);
            job.expires_at = lease.expires_at;
            save(conn, "upload", &job)?;
        } else {
            #[derive(Deserialize)]
            struct Ack {
                checkpoint_id: String,
                index: usize,
                envelope_sha256: String,
                duplicate: bool,
            }
            let ack: Ack = from_value(value)?;
            let (_, digest) = load_part(conn, "upload", job.next_part)?;
            if ack.checkpoint_id != job.checkpoint_id
                || ack.index != job.next_part
                || ack.envelope_sha256 != digest
            {
                return Err("content_sync_checkpoint_invalid_part_ack".into());
            }
            let _ = ack.duplicate;
            job.next_part += 1;
            save(conn, "upload", &job)?;
        }
    }
    Ok(true)
}

/// Replacement for the ordinary pull closure. A compacted cursor enters durable
/// download state; it never advances to a server-advertised cursor by itself.
pub(super) fn pull(
    conn: &mut Connection,
    cfg: &RelayConfig,
    http: &reqwest::blocking::Client,
) -> Result<(usize, bool), String> {
    if load::<Download>(conn, "download")?.is_some() {
        if scalar(
            conn,
            "SELECT next_attempt FROM mvp_sync_checkpoint_state WHERE id=1",
        )? > chrono::Utc::now().timestamp()
        {
            return Ok((0, true));
        }
        return download_step(conn, cfg, http);
    }
    let before = scalar(
        conn,
        "SELECT receive_seq FROM content_sync_state WHERE id=1",
    )?;
    let response = http
        .get(url(cfg, &format!("/v1/batches?after={before}&limit=16")))
        .bearer_auth(&cfg.token)
        .send()
        .map_err(|_| "relay_network_unavailable")?;
    if response.status().as_u16() != 409 {
        let page: Page = parse(&read_response(conn, response, false)?)?;
        let more = page.has_more;
        return Ok((apply_page(conn, cfg, before, page)?, more));
    }
    let mut body = vec![];
    response
        .take((RESPONSE_LIMIT + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|_| "relay_response_failed")?;
    if body.len() > RESPONSE_LIMIT {
        return Err("relay_response_too_large".into());
    }
    let value: Value = parse(&body)?;
    if value.get("error").and_then(Value::as_str) != Some("checkpoint_required") {
        return Err("relay_http_409".into());
    }
    let summary: Summary = from_value(
        value
            .get("checkpoint")
            .cloned()
            .ok_or("content_sync_checkpoint_missing_summary")?,
    )?;
    if summary.base_seq <= before {
        return Err("content_sync_checkpoint_invalid_summary".into());
    }
    begin_download(conn, summary)?;
    download_step(conn, cfg, http)
}

/// Proactive compaction starts while ordinary delivery is healthy, not after a
/// capacity error. Calls perform at most one four-request upload/download step.
pub(super) fn maintain(
    conn: &mut Connection,
    cfg: &RelayConfig,
    http: &reqwest::blocking::Client,
    caught_up: bool,
) -> Result<bool, String> {
    let now = chrono::Utc::now().timestamp();
    if scalar(
        conn,
        "SELECT next_attempt FROM mvp_sync_checkpoint_state WHERE id=1",
    )? > now
    {
        return Ok(false);
    }
    if load::<Download>(conn, "download")?.is_some() {
        return Ok(true);
    }
    if load::<Upload>(conn, "upload")?.is_some() {
        return upload_step(conn, cfg, http);
    }
    if !caught_up {
        return Ok(false);
    }
    let base = scalar(
        conn,
        "SELECT receive_seq FROM content_sync_state WHERE id=1",
    )?;
    let (_last, checked): (i64, i64) = sql(conn.query_row(
        "SELECT last_base,checked_at FROM mvp_sync_checkpoint_state WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    if now - checked < 3600 {
        return Ok(false);
    }
    let response = request(
        http.get(url(cfg, "/v1/checkpoints/status"))
            .bearer_auth(&cfg.token),
    )?;
    if response.status == 404 {
        return Ok(false);
    }
    let status = success(conn, response)?;
    if status.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return Err("content_sync_checkpoint_unknown_schema".into());
    }
    if status.get("enabled") != Some(&json!(true)) || status.get("ready") != Some(&json!(true)) {
        sql(conn.execute(
            "UPDATE mvp_sync_checkpoint_state SET checked_at=?1 WHERE id=1",
            [now],
        ))?;
        return Ok(false);
    }
    let latest = latest(conn, cfg, http)?;
    let (generation, remote_base) = latest.map(|s| (s.generation, s.base_seq)).unwrap_or((0, 0));
    sql(conn.execute("UPDATE mvp_sync_checkpoint_state SET checked_at=?1,last_base=MAX(last_base,?2),generation=MAX(generation,?3) WHERE id=1",
        params![now,remote_base,generation]))?;
    if remote_base >= base || base - remote_base < 256 || !capture_ready(conn)? {
        return Ok(false);
    }
    if capture(conn, cfg, generation)? {
        upload_step(conn, cfg, http)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
#[path = "mvp_sync_checkpoint_tests.rs"]
mod tests;
