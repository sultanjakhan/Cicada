//! Adapted from Hanni content_sync.rs: durable envelopes, ACKs and fragments.
//! MVP uses a separate cryptographic profile and an explicit SQLite adapter.

use super::RelayConfig;
#[path = "mvp_sync_lease.rs"]
mod run_lease;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use hmac::{Hmac, Mac};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{io::Read, sync::OnceLock, time::Duration};

#[path = "mvp_sync_checkpoint.rs"]
mod checkpoint;
#[path = "mvp_sync_pending.rs"]
mod pending;
pub(super) const CHECKPOINT_SCHEMA: &str = "hanni-mvp-checkpoint-v1";

const DOMAIN: &str = "hanni-mvp-content-v1";
const PLAIN_LIMIT: usize = 60_000;
const RECORD_LIMIT: usize = 16 * 1024 * 1024;
const RESPONSE_LIMIT: usize = 600 * 1024;
type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    v: u8,
    alg: String,
    key_id: String,
    nonce: String,
    ciphertext: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    client_seq: i64,
    batch_id: String,
    envelope: Envelope,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    t: String,
    f: Map<String, Value>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Tomb {
    tt: String,
    id: Value,
    deleted_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    v: u8,
    kind: String,
    applied_seq: i64,
    rows: Vec<Row>,
    tombs: Vec<Tomb>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fragment: Option<Fragment>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fragment {
    record_id: String,
    part: u32,
    total: u32,
    bytes: String,
}
#[derive(Deserialize)]
struct Stored {
    seq: i64,
    client_seq: i64,
    sender_device_id: String,
    batch_id: String,
    envelope: Envelope,
    envelope_sha256: String,
}
#[derive(Deserialize)]
struct Page {
    batches: Vec<Stored>,
    next_cursor: i64,
    latest_seq: i64,
    has_more: bool,
}
#[derive(Deserialize)]
struct Ack {
    seq: i64,
    client_seq: i64,
    sender_device_id: String,
    batch_id: String,
    envelope_sha256: String,
}

fn sql<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|_| "content_sync_database_failed".into())
}
fn scalar(conn: &Connection, query: &str) -> Result<i64, String> {
    sql(conn.query_row(query, [], |r| r.get(0)))
}
fn hash(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}
fn envelope_hash(value: &Envelope) -> Result<String, String> {
    serde_json::to_vec(value)
        .map(|v| hash(&v))
        .map_err(|_| "content_sync_encode_failed".into())
}

fn tables() -> impl Iterator<Item = &'static str> {
    ["mvp_records"].into_iter()
}

/// HKDF-SHA256 extract+expand without a second crypto dependency.  The input
/// relay key is never used directly by this channel.
fn derived_key(cfg: &RelayConfig) -> Result<[u8; 32], String> {
    let input = super::decode(&cfg.key, 32)?;
    let mut extract =
        HmacSha256::new_from_slice(DOMAIN.as_bytes()).map_err(|_| "content_sync_key_invalid")?;
    extract.update(&input);
    let prk = extract.finalize().into_bytes();
    let mut expand = HmacSha256::new_from_slice(&prk).map_err(|_| "content_sync_key_invalid")?;
    expand.update(DOMAIN.as_bytes());
    expand.update(&[1]);
    let bytes = expand.finalize().into_bytes();
    Ok(bytes.into())
}

fn content_key(cfg: &RelayConfig) -> Result<[u8; 32], String> {
    super::decode(&cfg.key, 32)?
        .try_into()
        .map_err(|_| "content_sync_key_invalid".into())
}

/// Derive the content-only routing config from validated health credentials.
/// The source parser remains the authority for transport and token validation.
pub(crate) fn derive_config(base: &RelayConfig) -> Result<RelayConfig, String> {
    let mut cfg = base.clone();
    let key = derived_key(base)?;
    cfg.endpoint = format!("{}/content", base.endpoint.trim_end_matches('/'));
    cfg.key = B64.encode(key);
    Ok(cfg)
}

fn aad(sender: &str, batch: &str, key_id: &str, client_seq: i64) -> Vec<u8> {
    serde_json::to_vec(&json!([
        DOMAIN, "content", sender, batch, key_id, client_seq
    ]))
    .expect("static AAD serializes")
}

fn encrypt(cfg: &RelayConfig, payload: &Payload, seq: i64) -> Result<Batch, String> {
    if !(1..=9_007_199_254_740_991).contains(&seq) {
        return Err("content_sync_sequence_invalid".into());
    }
    let plain = serde_json::to_vec(payload).map_err(|_| "content_sync_encode_failed")?;
    if plain.len() > PLAIN_LIMIT {
        return Err("content_sync_record_too_large".into());
    }
    let key = content_key(cfg)?;
    let batch_id = uuid::Uuid::new_v4().to_string();
    let blob = super::encrypt_bytes(
        &key,
        &aad(&cfg.device_id, &batch_id, &cfg.key_id, seq),
        &plain,
    )?;
    Ok(Batch {
        client_seq: seq,
        batch_id,
        envelope: Envelope {
            v: 1,
            alg: "XChaCha20-Poly1305".into(),
            key_id: cfg.key_id.clone(),
            nonce: B64.encode(&blob[..24]),
            ciphertext: B64.encode(&blob[24..]),
        },
    })
}

fn decrypt(cfg: &RelayConfig, item: &Stored) -> Result<Payload, String> {
    let env = &item.envelope;
    if item.seq < 1
        || !(1..=9_007_199_254_740_991).contains(&item.client_seq)
        || env.v != 1
        || env.alg != "XChaCha20-Poly1305"
        || env.key_id != cfg.key_id
        || !super::opaque_id(&item.sender_device_id)
        || uuid::Uuid::parse_str(&item.batch_id)
            .ok()
            .map(|v| v.to_string())
            .as_deref()
            != Some(item.batch_id.as_str())
        || envelope_hash(env)? != item.envelope_sha256
    {
        return Err("content_sync_invalid_envelope".into());
    }
    let mut blob = super::decode(&env.nonce, 24)?;
    let ciphertext = B64
        .decode(&env.ciphertext)
        .map_err(|_| "content_sync_invalid_envelope")?;
    if ciphertext.len() < 16
        || ciphertext.len() > 65536
        || B64.encode(&ciphertext) != env.ciphertext
    {
        return Err("content_sync_invalid_envelope".into());
    }
    blob.extend(ciphertext);
    let plain = super::decrypt_bytes(
        &content_key(cfg)?,
        &aad(
            &item.sender_device_id,
            &item.batch_id,
            &env.key_id,
            item.client_seq,
        ),
        &blob,
    )?;
    let payload: Payload =
        serde_json::from_slice(&plain).map_err(|_| "content_sync_invalid_payload")?;
    if payload.v != 1
        || !matches!(payload.kind.as_str(), "changes" | "receipt" | "fragment")
        || payload.applied_seq < 0
        || payload.applied_seq >= item.seq
        || (payload.kind == "receipt"
            && (!payload.rows.is_empty()
                || !payload.tombs.is_empty()
                || payload.fragment.is_some()))
        || (payload.kind == "fragment"
            && (payload.fragment.is_none()
                || !payload.rows.is_empty()
                || !payload.tombs.is_empty()))
    {
        return Err("content_sync_invalid_payload".into());
    }
    if let Some(part) = &payload.fragment {
        if uuid::Uuid::parse_str(&part.record_id)
            .ok()
            .map(|v| v.to_string())
            .as_deref()
            != Some(part.record_id.as_str())
            || part.total == 0
            || part.part >= part.total
            || part.total > 4096
            || B64
                .decode(&part.bytes)
                .map_err(|_| "content_sync_invalid_fragment")?
                .len()
                > 42_000
        {
            return Err("content_sync_invalid_fragment".into());
        }
    }
    Ok(payload)
}

pub(super) fn validate_scope(conn: &Connection, cfg: &RelayConfig) -> Result<(), String> {
    let exists: i64 = sql(conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='content_sync_state'",
        [],
        |r| r.get(0),
    ))?;
    if exists == 0 {
        return Ok(());
    }
    let scope = hash(
        &serde_json::to_vec(&json!([cfg.endpoint, cfg.device_id, cfg.key_id, cfg.key]))
            .map_err(|_| "content_sync_encode_failed")?,
    );
    let previous: Option<String> = sql(conn
        .query_row("SELECT scope FROM content_sync_state WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional())?;
    if previous.is_some_and(|v| v != scope) {
        return Err("mvp_sync_pairing_changed".into());
    }
    Ok(())
}

fn initialize(conn: &mut Connection, cfg: &RelayConfig) -> Result<(), String> {
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    sql(tx.execute_batch("CREATE TABLE IF NOT EXISTS content_sync_state(
        id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL, receive_seq INTEGER NOT NULL DEFAULT 0,
        receipt_needed INTEGER NOT NULL DEFAULT 0, upload_not_before INTEGER NOT NULL DEFAULT 0,
        pull_not_before INTEGER NOT NULL DEFAULT 0, last_error TEXT, upload_error TEXT, pull_error TEXT);
      CREATE TABLE IF NOT EXISTS content_sync_control(id INTEGER PRIMARY KEY CHECK(id=1), applying INTEGER NOT NULL);
      INSERT OR IGNORE INTO content_sync_control VALUES(1,0);
      CREATE TABLE IF NOT EXISTS content_sync_dirty(seq INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL,row_id TEXT NOT NULL,UNIQUE(table_name,row_id));
      CREATE TABLE IF NOT EXISTS content_sync_outbox(local_seq INTEGER PRIMARY KEY AUTOINCREMENT,batch_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,envelope_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_sync_receipts(device_id TEXT PRIMARY KEY,applied_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS content_sync_sender_watermarks(device_id TEXT PRIMARY KEY,client_seq INTEGER NOT NULL,server_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS content_sync_seeded_tables(table_name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS content_sync_fragments(sender_device_id TEXT NOT NULL,batch_id TEXT NOT NULL,part INTEGER NOT NULL,total INTEGER NOT NULL,body BLOB NOT NULL,PRIMARY KEY(sender_device_id,batch_id,part));
      CREATE TABLE IF NOT EXISTS content_sync_fragments_v2(sender_device_id TEXT NOT NULL,record_id TEXT NOT NULL,part INTEGER NOT NULL,total INTEGER NOT NULL,body BLOB NOT NULL,PRIMARY KEY(sender_device_id,record_id,part));
      CREATE TABLE IF NOT EXISTS content_sync_outbound_fragments(table_name TEXT NOT NULL,row_id TEXT NOT NULL,record_id TEXT NOT NULL,part INTEGER NOT NULL,total INTEGER NOT NULL,body BLOB NOT NULL,PRIMARY KEY(record_id,part));
      CREATE TABLE IF NOT EXISTS content_sync_blocked(seq INTEGER PRIMARY KEY,error_code TEXT NOT NULL);"))?;
    sql(tx.execute_batch("CREATE TABLE IF NOT EXISTS content_sync_tomb_births(table_name TEXT,row_id TEXT,created_at TEXT,PRIMARY KEY(table_name,row_id));"))?;
    pending::initialize(&tx)?;
    checkpoint::initialize(&tx)?;
    let scope = hash(
        &serde_json::to_vec(&json!([cfg.endpoint, cfg.device_id, cfg.key_id, cfg.key]))
            .expect("static scope serializes"),
    );
    let previous: Option<String> = sql(tx
        .query_row("SELECT scope FROM content_sync_state WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional())?;
    if previous.as_ref().is_some_and(|v| v != &scope) {
        return Err("content_sync_pairing_changed".into());
    }
    if previous.is_none() {
        sql(tx.execute(
            "INSERT INTO content_sync_state(id,scope) VALUES(1,?1)",
            [scope],
        ))?;
    }
    sql(tx.execute("INSERT OR IGNORE INTO content_sync_dirty(table_name,row_id) SELECT 'mvp_records',id FROM mvp_records WHERE NOT EXISTS(SELECT 1 FROM content_sync_seeded_tables WHERE table_name='mvp_records')", []))?;
    sql(tx.execute(
        "INSERT OR IGNORE INTO content_sync_seeded_tables(table_name) VALUES('mvp_records')",
        [],
    ))?;
    sql(tx.commit())
}

fn id_value(conn: &Connection, table: &str, id: &str) -> Result<rusqlite::types::Value, String> {
    if crate::mvp_sync_db::column_is_text(conn, table, "id") {
        Ok(rusqlite::types::Value::Text(id.into()))
    } else {
        id.parse::<i64>()
            .map(rusqlite::types::Value::Integer)
            .map_err(|_| "content_sync_invalid_row_id".into())
    }
}

fn enqueue_next_fragment(tx: &Connection, cfg: &RelayConfig, cursor: i64) -> Result<bool, String> {
    let part: Option<(String, u32, u32, Vec<u8>)> = sql(tx.query_row(
        "SELECT record_id,part,total,body FROM content_sync_outbound_fragments ORDER BY record_id,part LIMIT 1",
        [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))
    ).optional())?;
    let Some((record_id, number, total, body)) = part else {
        return Ok(false);
    };
    let payload = Payload {
        v: 1,
        kind: "fragment".into(),
        applied_seq: cursor,
        rows: vec![],
        tombs: vec![],
        fragment: Some(Fragment {
            record_id: record_id.clone(),
            part: number,
            total,
            bytes: B64.encode(body),
        }),
    };
    let seq = scalar(
        tx,
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='content_sync_outbox'),0)+1",
    )?;
    let batch = encrypt(cfg, &payload, seq)?;
    let body = serde_json::to_string(&batch).map_err(|_| "content_sync_encode_failed")?;
    sql(tx.execute("INSERT INTO content_sync_outbox(local_seq,batch_id,body,envelope_hash) VALUES(?1,?2,?3,?4)", params![seq,batch.batch_id,body,envelope_hash(&batch.envelope)?]))?;
    sql(tx.execute(
        "DELETE FROM content_sync_outbound_fragments WHERE record_id=?1 AND part=?2",
        params![record_id, number],
    ))?;
    Ok(true)
}

fn enqueue(conn: &mut Connection, cfg: &RelayConfig) -> Result<bool, String> {
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    sql(tx.execute(
        "DELETE FROM content_sync_blocked WHERE seq NOT IN (SELECT seq FROM content_sync_dirty)",
        [],
    ))?;
    if scalar(&tx, "SELECT COUNT(*) FROM content_sync_outbox")? > 0 {
        return Ok(true);
    }
    let cursor = scalar(&tx, "SELECT receive_seq FROM content_sync_state WHERE id=1")?;
    if enqueue_next_fragment(&tx, cfg, cursor)? {
        sql(tx.commit())?;
        return Ok(true);
    }
    let mut payload = Payload {
        v: 1,
        kind: "changes".into(),
        applied_seq: cursor,
        rows: vec![],
        tombs: vec![],
        fragment: None,
    };
    let entries: Vec<(i64, String, String)> = {
        // Parents must precede children across packet boundaries as well as
        // within apply_page. Use the same complete FK ordering on both sides.
        let order = crate::mvp_sync_db::SYNC_TABLES
            .iter()
            .enumerate()
            .map(|(rank, table)| format!("WHEN '{table}' THEN {rank}"))
            .collect::<Vec<_>>()
            .join(" ");
        let mut q = sql(tx.prepare(&format!("SELECT seq,table_name,row_id FROM content_sync_dirty WHERE NOT EXISTS(SELECT 1 FROM content_sync_blocked WHERE content_sync_blocked.seq=content_sync_dirty.seq) ORDER BY CASE table_name {order} ELSE 999 END,seq LIMIT 128")))?;
        let rows = sql(q
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|_| "content_sync_database_failed")?
            .collect())?;
        rows
    };
    let writer: String = sql(tx.query_row(
        "SELECT value FROM app_settings WHERE key='device_id'",
        [],
        |r| r.get(0),
    ))?;
    if writer.is_empty() {
        return Err("content_sync_missing_writer".into());
    }
    let mut taken = Vec::new();
    for (seq, table, id) in entries {
        if !tables().any(|t| t == table) {
            return Err("content_sync_invalid_table".into());
        }
        let row_count = payload.rows.len();
        let tomb_count = payload.tombs.len();
        if let Some(Value::Object(mut fields)) =
            crate::mvp_sync_db::row_to_json(&tx, &table, &id_value(&tx, &table, &id)?)
                .map_err(|_| "content_sync_row_read_failed")?
        {
            let timestamp = match fields.get("updated_at").and_then(Value::as_str).and_then(
                |stamp| crate::mvp_sync_db::canonical_sync_timestamp(stamp, "content").ok(),
            ) {
                Some(timestamp) => timestamp,
                None => {
                    let blocked = scalar(&tx, "SELECT COUNT(*) FROM content_sync_blocked")?;
                    if blocked >= 4096 {
                        return Err("content_sync_blocked_capacity_exceeded".into());
                    }
                    sql(tx.execute("INSERT OR REPLACE INTO content_sync_blocked(seq,error_code) VALUES(?1,'content_sync_invalid_timestamp')", [seq]))?;
                    continue;
                }
            };
            fields.insert("updated_at".into(), json!(timestamp));
            fields.insert("_updated_at".into(), json!(timestamp));
            let origin: Option<(String, String)> = sql(tx.query_row(
                "SELECT updated_at,device_id FROM sync_row_versions WHERE table_name=?1 AND row_id=?2",
                params![table,id], |r| Ok((r.get(0)?,r.get(1)?))
            ).optional())?;
            let origin = origin
                .filter(|(stamp, _)| {
                    crate::mvp_sync_db::canonical_sync_timestamp(stamp, "content")
                        .ok()
                        .as_ref()
                        == Some(&timestamp)
                })
                .map(|(_, device)| device)
                .unwrap_or_else(|| writer.clone());
            fields.insert("_device_id".into(), json!(origin));
            payload.rows.push(Row {
                t: table.clone(),
                f: fields,
            });
        } else {
            let deleted_at: String = sql(tx.query_row(
                "SELECT deleted_at FROM sync_tombstones WHERE table_name=?1 AND row_id=?2",
                params![table, id],
                |r| r.get(0),
            ))?;
            let created_at: Option<String> = sql(tx.query_row(
                "SELECT created_at FROM content_sync_tomb_births WHERE table_name=?1 AND row_id=?2",
                params![table, id], |r| r.get(0),
            ).optional())?;
            payload.tombs.push(Tomb {
                tt: table.clone(),
                id: json!(id),
                deleted_at,
                created_at,
            });
        }
        if serde_json::to_vec(&payload)
            .map_err(|_| "content_sync_encode_failed")?
            .len()
            > PLAIN_LIMIT
        {
            if taken.is_empty() && payload.rows.len() == 1 {
                let row = payload.rows.pop().expect("one oversized row");
                let record = serde_json::to_vec(&row).map_err(|_| "content_sync_encode_failed")?;
                if record.len() > RECORD_LIMIT {
                    return Err("content_sync_record_too_large".into());
                }
                let record_id = uuid::Uuid::new_v4().to_string();
                let total = record.chunks(42_000).len() as u32;
                for (part, chunk) in record.chunks(42_000).enumerate() {
                    sql(tx.execute("INSERT INTO content_sync_outbound_fragments(table_name,row_id,record_id,part,total,body) VALUES(?1,?2,?3,?4,?5,?6)", params![table,id,record_id,part as u32,total,chunk]))?;
                }
                sql(tx.execute("DELETE FROM content_sync_dirty WHERE seq=?1", [seq]))?;
                enqueue_next_fragment(&tx, cfg, cursor)?;
                sql(tx.commit())?;
                return Ok(true);
            }
            payload.rows.truncate(row_count);
            payload.tombs.truncate(tomb_count);
            break;
        }
        taken.push(seq);
    }
    if taken.is_empty() {
        if scalar(
            &tx,
            "SELECT receipt_needed FROM content_sync_state WHERE id=1",
        )? == 0
        {
            sql(tx.commit())?;
            return Ok(false);
        }
        payload.kind = "receipt".into();
    }
    let seq = scalar(
        &tx,
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='content_sync_outbox'),0)+1",
    )?;
    let batch = encrypt(cfg, &payload, seq)?;
    let body = serde_json::to_string(&batch).map_err(|_| "content_sync_encode_failed")?;
    sql(tx.execute("INSERT INTO content_sync_outbox(local_seq,batch_id,body,envelope_hash) VALUES(?1,?2,?3,?4)", params![seq,batch.batch_id,body,envelope_hash(&batch.envelope)?]))?;
    for seq in taken {
        sql(tx.execute("DELETE FROM content_sync_dirty WHERE seq=?1", [seq]))?;
    }
    sql(tx.execute(
        "UPDATE content_sync_state SET receipt_needed=0 WHERE id=1",
        [],
    ))?;
    sql(tx.commit())?;
    Ok(true)
}

fn client() -> Result<&'static reqwest::blocking::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .default_headers({
                    let mut headers = reqwest::header::HeaderMap::new();
                    headers.insert(
                        "X-Hanni-MVP-Checkpoint",
                        reqwest::header::HeaderValue::from_static(CHECKPOINT_SCHEMA),
                    );
                    headers
                })
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(25))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "content_sync_http_init_failed".into())
        })
        .as_ref()
        .map_err(Clone::clone)
}
fn read_response(
    conn: &Connection,
    response: reqwest::blocking::Response,
    upload: bool,
) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        let retry = response
            .headers()
            .get("Retry-After")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(if response.status().as_u16() == 507 {
                3600
            } else {
                60
            })
            .clamp(1, 86400);
        let column = if upload {
            "upload_not_before"
        } else {
            "pull_not_before"
        };
        sql(conn.execute(
            &format!("UPDATE content_sync_state SET {column}=MAX({column},?1) WHERE id=1"),
            [chrono::Utc::now().timestamp() + retry],
        ))?;
        return Err(format!("content_sync_http_{}", response.status().as_u16()));
    }
    let mut out = vec![];
    response
        .take((RESPONSE_LIMIT + 1) as u64)
        .read_to_end(&mut out)
        .map_err(|_| "content_sync_response_failed")?;
    if out.len() > RESPONSE_LIMIT {
        Err("content_sync_response_too_large".into())
    } else {
        Ok(out)
    }
}
fn upload(conn: &Connection, cfg: &RelayConfig) -> Result<usize, String> {
    let item: Option<(String,String,String,i64)>=sql(conn.query_row("SELECT batch_id,body,envelope_hash,local_seq FROM content_sync_outbox ORDER BY local_seq LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
    let Some((id, body, digest, seq)) = item else {
        return Ok(0);
    };
    let response = client()?
        .post(format!("{}/v1/batches", cfg.endpoint))
        .bearer_auth(&cfg.token)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .map_err(|_| "content_sync_network_unavailable")?;
    let ack: Ack = serde_json::from_slice(&read_response(conn, response, true)?)
        .map_err(|_| "content_sync_invalid_ack")?;
    if ack.seq < 1
        || ack.client_seq != seq
        || ack.sender_device_id != cfg.device_id
        || ack.batch_id != id
        || ack.envelope_sha256 != digest
    {
        return Err("content_sync_invalid_ack".into());
    };
    sql(conn.execute(
        "DELETE FROM content_sync_outbox WHERE batch_id=?1 AND envelope_hash=?2",
        params![id, digest],
    ))?;
    Ok(1)
}

fn accept_fragment(conn: &Connection, sender: &str, part: Fragment) -> Result<Option<Row>, String> {
    let body = B64
        .decode(&part.bytes)
        .map_err(|_| "content_sync_invalid_fragment")?;
    if body.is_empty()
        || body.len() > 42_000
        || B64.encode(&body) != part.bytes
        || part.total == 0
        || part.total > RECORD_LIMIT.div_ceil(42_000) as u32
        || part.part >= part.total
    {
        return Err("content_sync_invalid_fragment".into());
    }
    let (small,large,bytes): (Option<u32>,Option<u32>,usize) = sql(conn.query_row(
        "SELECT MIN(total),MAX(total),COALESCE(SUM(length(body)),0) FROM content_sync_fragments_v2 WHERE sender_device_id=?1 AND record_id=?2",
        params![sender,part.record_id], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))))?;
    if small.is_some_and(|v| v != part.total) || large.is_some_and(|v| v != part.total) {
        return Err("content_sync_fragment_conflict".into());
    }
    let existing: Option<Vec<u8>> = sql(conn.query_row(
        "SELECT body FROM content_sync_fragments_v2 WHERE sender_device_id=?1 AND record_id=?2 AND part=?3",
        params![sender,part.record_id,part.part], |r| r.get(0)
    ).optional())?;
    if let Some(existing) = existing {
        if existing != body {
            return Err("content_sync_fragment_conflict".into());
        }
    } else {
        if bytes.saturating_add(body.len()) > RECORD_LIMIT {
            return Err("content_sync_record_too_large".into());
        }
        sql(conn.execute("INSERT INTO content_sync_fragments_v2(sender_device_id,record_id,part,total,body) VALUES(?1,?2,?3,?4,?5)",params![sender,part.record_id,part.part,part.total,body]))?;
    }
    let count: i64 = sql(conn.query_row(
        "SELECT COUNT(*) FROM content_sync_fragments_v2 WHERE sender_device_id=?1 AND record_id=?2",
        params![sender, part.record_id],
        |r| r.get(0),
    ))?;
    if count != i64::from(part.total) {
        return Ok(None);
    }
    let mut statement=sql(conn.prepare("SELECT body FROM content_sync_fragments_v2 WHERE sender_device_id=?1 AND record_id=?2 ORDER BY part"))?;
    let mapped = statement
        .query_map(params![sender, part.record_id], |r| r.get(0))
        .map_err(|_| "content_sync_database_failed")?;
    let chunks: Vec<Vec<u8>> = sql(mapped.collect())?;
    let mut assembled = Vec::new();
    for chunk in chunks {
        assembled.extend(chunk);
    }
    sql(conn.execute(
        "DELETE FROM content_sync_fragments_v2 WHERE sender_device_id=?1 AND record_id=?2",
        params![sender, part.record_id],
    ))?;
    serde_json::from_slice(&assembled)
        .map(Some)
        .map_err(|_| "content_sync_invalid_fragment".into())
}

fn remote_id(value: &Value) -> Result<String, String> {
    match value {
        Value::String(v) if !v.is_empty() => Ok(v.clone()),
        Value::Number(v) if v.is_i64() => Ok(v.to_string()),
        _ => Err("content_sync_invalid_identity".into()),
    }
}

// A constraint conflict must not partially change a row, its aliases or FTS.
// The caller durably preserves the original record before advancing the cursor.
fn try_record(conn: &Connection, record: &pending::Pending) -> Result<bool, String> {
    sql(conn.execute_batch("SAVEPOINT content_apply_record"))?;
    let result = (|| {
        if record.kind == "row" {
            let row: Row = serde_json::from_str(&record.payload)
                .map_err(|_| "content_sync_pending_invalid")?;
            if row.t != record.table_name || !tables().any(|v| v == row.t) {
                return Err("content_sync_pending_invalid".into());
            }
            crate::mvp_sync_db::apply_record(conn, &row.f)
        } else {
            Err("content_sync_unknown_schema".into())
        }
    })();
    if result.is_err() {
        sql(conn.execute_batch("ROLLBACK TO content_apply_record; RELEASE content_apply_record"))?;
    } else {
        sql(conn.execute_batch("RELEASE content_apply_record"))?;
    }
    result
}

fn apply_or_defer(conn: &Connection, mut record: pending::Pending) -> Result<usize, String> {
    match try_record(conn, &record) {
        Ok(changed) => Ok(usize::from(changed)),
        Err(code) => {
            record.error_code = code;
            pending::put(conn, &record)?;
            Ok(0)
        }
    }
}

fn retry_pending_in_transaction(conn: &Connection) -> Result<usize, String> {
    let mut applied = 0;
    for record in pending::pending(conn, 128)? {
        pending::attempted(conn, &record)?;
        if let Ok(changed) = try_record(conn, &record) {
            pending::remove_exact(conn, &record)?;
            if changed {
                applied += 1;
                pending::record_recovered(conn)?;
            }
        }
    }
    Ok(applied)
}

fn retry_pending(conn: &mut Connection) -> Result<usize, String> {
    if pending::count(conn)? == 0 {
        return Ok(0);
    }
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    sql(tx.execute("UPDATE content_sync_control SET applying=1 WHERE id=1", []))?;
    let applied = retry_pending_in_transaction(&tx)?;
    sql(tx.execute("UPDATE content_sync_control SET applying=0 WHERE id=1", []))?;
    sql(tx.commit())?;
    Ok(applied)
}

fn apply_page(
    conn: &mut Connection,
    cfg: &RelayConfig,
    before: i64,
    page: Page,
) -> Result<usize, String> {
    let last = page.batches.last().map(|v| v.seq).unwrap_or(before);
    if page.next_cursor != last
        || page.latest_seq < last
        || (page.has_more && page.latest_seq <= last)
        || (!page.has_more && page.latest_seq != last)
        || page.batches.len() > 32
    {
        return Err("content_sync_invalid_page".into());
    };
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    if scalar(&tx, "SELECT receive_seq FROM content_sync_state WHERE id=1")? != before {
        return Err("content_sync_stale_cursor".into());
    };
    sql(tx.execute("UPDATE content_sync_control SET applying=1 WHERE id=1", []))?;
    let mut expected = before + 1;
    let mut applied = 0;
    for item in page.batches {
        if item.seq != expected {
            return Err("content_sync_sequence_gap".into());
        };
        expected += 1;
        let mut payload = decrypt(cfg, &item)?;
        let prior:i64=sql(tx.query_row("SELECT COALESCE((SELECT client_seq FROM content_sync_sender_watermarks WHERE device_id=?1),0)",[&item.sender_device_id],|r|r.get(0)))?;
        if item.client_seq != prior + 1 {
            return Err("content_sync_sender_sequence_gap".into());
        };
        sql(tx.execute("INSERT INTO content_sync_sender_watermarks VALUES(?1,?2,?3) ON CONFLICT(device_id) DO UPDATE SET client_seq=excluded.client_seq,server_seq=excluded.server_seq",params![item.sender_device_id,item.client_seq,item.seq]))?;
        if let Some(fragment) = payload.fragment.take() {
            if let Some(row) = accept_fragment(&tx, &item.sender_device_id, fragment)? {
                payload.kind = "changes".into();
                payload.rows.push(row);
            }
        }
        if item.sender_device_id != cfg.device_id {
            let mut rows = payload.rows;
            rows.sort_by_key(|row| {
                crate::mvp_sync_db::SYNC_TABLES
                    .iter()
                    .position(|t| *t == row.t)
                    .unwrap_or(usize::MAX)
            });
            for row in rows {
                crate::mvp_sync_db::validate_record(&tx, &row.f)?;
                if !tables().any(|t| t == row.t) {
                    return Err("content_sync_invalid_table".into());
                };
                let stamp = row
                    .f
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .ok_or("content_sync_missing_timestamp")?;
                if crate::mvp_sync_db::canonical_sync_timestamp(stamp, "content")
                    .map_err(|_| "content_sync_invalid_timestamp")?
                    != crate::mvp_sync_db::canonical_sync_timestamp(
                        row.f
                            .get("_updated_at")
                            .and_then(Value::as_str)
                            .ok_or("content_sync_missing_timestamp")?,
                        "content",
                    )
                    .map_err(|_| "content_sync_invalid_timestamp")?
                {
                    return Err("content_sync_timestamp_mismatch".into());
                };
                let record = pending::Pending {
                    sender: item.sender_device_id.clone(),
                    table_name: row.t.clone(),
                    remote_id: remote_id(row.f.get("id").ok_or("content_sync_invalid_identity")?)?,
                    kind: "row".into(),
                    stamp: stamp.into(),
                    payload: serde_json::to_string(&row)
                        .map_err(|_| "content_sync_encode_failed")?,
                    error_code: "content_sync_row_apply_failed".into(),
                };
                applied += apply_or_defer(&tx, record)?;
            }
            if !payload.tombs.is_empty() {
                return Err("content_sync_unknown_schema".into());
            }
            if payload.kind == "changes" {
                sql(tx.execute(
                    "UPDATE content_sync_state SET receipt_needed=1 WHERE id=1",
                    [],
                ))?;
            }
            sql(tx.execute(
                "INSERT INTO content_sync_receipts(device_id,applied_seq) VALUES(?1,?2)
                 ON CONFLICT(device_id) DO UPDATE SET applied_seq=MAX(applied_seq,excluded.applied_seq)",
                params![item.sender_device_id, payload.applied_seq],
            ))?;
        }
    }
    applied += retry_pending_in_transaction(&tx)?;
    sql(tx.execute("UPDATE content_sync_control SET applying=0 WHERE id=1", []))?;
    sql(tx.execute(
        "UPDATE content_sync_state SET receive_seq=?1 WHERE id=1",
        [last],
    ))?;
    sql(tx.commit())?;
    Ok(applied)
}
fn pull(conn: &mut Connection, cfg: &RelayConfig) -> Result<(usize, bool), String> {
    checkpoint::pull(conn, cfg, client()?)
}

/// Headless bounded sync. It never enables the feature and returns only safe
/// aggregate diagnostics for UI polling/work scheduling.
pub(crate) fn run_headless_once(db_path: &str, health_config_json: &str) -> Result<String, String> {
    let base = RelayConfig::parse(health_config_json)?;
    let cfg = derive_config(&base)?;
    let mut conn = super::open_existing(db_path)?;
    let _lease = run_lease::acquire(std::path::Path::new(db_path))?;
    let enabled = crate::mvp_sync_db::get_setting_checked(&conn, "content_sync_enabled")?
        .as_deref()
        == Some("true");
    if !enabled {
        return Ok(json!({"enabled":false,"applied_rows":0,"revision":"0","pending_keys":0,"uploaded_batches":0,"more_pending":false,"retry_after_secs":0,"error_code":"none"}).to_string());
    };
    initialize(&mut conn, &cfg)?;
    let now = chrono::Utc::now().timestamp();
    let mut uploaded = 0;
    let mut applied = retry_pending(&mut conn)?;
    let mut more = false;
    let mut error = None;
    if scalar(
        &conn,
        "SELECT upload_not_before FROM content_sync_state WHERE id=1",
    )? <= now
    {
        match enqueue(&mut conn, &cfg)
            .and_then(|queued| if queued { upload(&conn, &cfg) } else { Ok(0) })
        {
            Ok(n) => {
                uploaded += n;
                sql(conn.execute(
                    "UPDATE content_sync_state SET upload_error=NULL WHERE id=1",
                    [],
                ))?;
            }
            Err(e) => {
                sql(conn.execute("UPDATE content_sync_state SET upload_not_before=MAX(upload_not_before,?1) WHERE id=1", [now + 15]))?;
                sql(conn.execute(
                    "UPDATE content_sync_state SET upload_error=?1 WHERE id=1",
                    [&e],
                ))?;
                error = Some(e);
            }
        }
    }
    if scalar(
        &conn,
        "SELECT pull_not_before FROM content_sync_state WHERE id=1",
    )? <= now
    {
        match pull(&mut conn, &cfg) {
            Ok((n, p)) => {
                sql(conn.execute(
                    "UPDATE content_sync_state SET pull_error=NULL WHERE id=1",
                    [],
                ))?;
                applied += n;
                more |= p
            }
            Err(e) => {
                sql(conn.execute("UPDATE content_sync_state SET pull_not_before=MAX(pull_not_before,?1) WHERE id=1", [now + 15]))?;
                sql(conn.execute(
                    "UPDATE content_sync_state SET pull_error=?1 WHERE id=1",
                    [&e],
                ))?;
                error.get_or_insert(e);
            }
        }
    }
    match checkpoint::maintain(&mut conn, &cfg, client()?, error.is_none() && !more) {
        Ok(p) => more |= p,
        Err(e) => {
            error.get_or_insert(e);
        }
    }
    let pending=scalar(&conn,"SELECT (SELECT COUNT(*) FROM content_sync_dirty WHERE NOT EXISTS(SELECT 1 FROM content_sync_blocked WHERE content_sync_blocked.seq=content_sync_dirty.seq))+(SELECT COUNT(*) FROM content_sync_outbox)+(SELECT COUNT(*) FROM content_sync_outbound_fragments)")?;
    let durable_error: Option<String> = sql(conn.query_row(
        "SELECT COALESCE(upload_error,pull_error,(SELECT last_error FROM mvp_sync_checkpoint_state WHERE id=1)) FROM content_sync_state WHERE id=1",
        [],
        |r| r.get(0),
    ))?;
    error = durable_error.or(error);
    if pending::count(&conn)?
        + scalar(
            &conn,
            "SELECT COUNT(*) FROM content_sync_blocked JOIN content_sync_dirty USING(seq)",
        )?
        > 0
    {
        error.get_or_insert_with(|| "content_sync_conflicts".into());
    }
    sql(conn.execute(
        "UPDATE content_sync_state SET last_error=?1 WHERE id=1",
        [error.as_deref()],
    ))?;
    let conflicts: i64 =
        sql(conn.query_row("SELECT COUNT(*) FROM mvp_sync_conflicts", [], |r| r.get(0)))?;
    if error.is_none() && pending == 0 && !more && conflicts == 0 {
        sql(conn.execute(
            "UPDATE mvp_sync_meta SET last_success=?1 WHERE id=1",
            [chrono::Utc::now().to_rfc3339()],
        ))?;
    }
    let revision = (scalar(
        &conn,
        "SELECT receive_seq FROM content_sync_state WHERE id=1",
    )? + pending::recovered_count(&conn)?)
    .to_string();
    let retry = scalar(
        &conn,
        "SELECT MAX(upload_not_before,pull_not_before) FROM content_sync_state WHERE id=1",
    )?;
    let mut result = json!({"enabled":true,"applied_rows":applied,"revision":revision,"pending_keys":pending,"uploaded_batches":uploaded,"more_pending":more||pending>0,"pull_more":more,"retry_after_secs":0,"error_code":error.unwrap_or_else(||"none".into())});
    let retry = (retry - now).max(checkpoint::retry_after(&conn)?).max(0);
    result["retry_after_secs"] = json!(retry);
    Ok(result.to_string())
}

/// SELECT-only status for settings and background scheduling.
pub(crate) fn database_status(conn: &Connection) -> Result<Value, String> {
    let enabled = crate::mvp_sync_db::get_setting_checked(conn, "content_sync_enabled")?.as_deref()
        == Some("true");
    let exists = scalar(
        conn,
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='content_sync_state'",
    )?;
    if exists == 0 {
        return Ok(json!({"enabled":enabled,"initializing":true,"revision":"0","pending_keys":0}));
    };
    let (revision, error): (i64, Option<String>) = sql(conn.query_row(
        "SELECT receive_seq,last_error FROM content_sync_state WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    let blocked_table = scalar(
        conn,
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='content_sync_blocked'",
    )?;
    let (pending, blocked) = if blocked_table == 0 {
        (scalar(conn,"SELECT (SELECT COUNT(*) FROM content_sync_dirty)+(SELECT COUNT(*) FROM content_sync_outbox)+(SELECT COUNT(*) FROM content_sync_outbound_fragments)")?,0)
    } else {
        (scalar(conn,"SELECT (SELECT COUNT(*) FROM content_sync_dirty WHERE NOT EXISTS(SELECT 1 FROM content_sync_blocked WHERE content_sync_blocked.seq=content_sync_dirty.seq))+(SELECT COUNT(*) FROM content_sync_outbox)+(SELECT COUNT(*) FROM content_sync_outbound_fragments)")?,scalar(conn,"SELECT COUNT(*) FROM content_sync_blocked JOIN content_sync_dirty USING(seq)")?)
    };
    Ok(
        json!({"enabled":enabled,"initializing":false,"revision":(revision + pending::recovered_count(conn)?).to_string(),"pending_keys":pending,"conflict_count":pending::count(conn)? + blocked,"error_code":error}),
    )
}

#[cfg(test)]
#[path = "mvp_sync_transport_tests.rs"]
mod tests;
