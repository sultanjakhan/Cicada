//! Local compatibility evidence for immutable outgoing fragments; never a wire marker.
use super::*;
use std::collections::BTreeMap;

pub(super) fn initialize(conn: &Connection) -> Result<(), String> {
    sql(conn.execute_batch("CREATE TABLE IF NOT EXISTS content_sync_fragment_compat(record_id TEXT NOT NULL,part INTEGER NOT NULL,total INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(record_id,part));"))
}

pub(super) fn row(conn: &Connection, row: &Row) -> Result<(), String> {
    if row.t != "mvp_records" {
        return Err("content_sync_invalid_table".into());
    }
    crate::mvp_sync_db::validate_publishable_record(conn, &row.f)
}

fn remember_parts(
    conn: &Connection,
    record_id: &str,
    parts: &BTreeMap<u32, Vec<u8>>,
) -> Result<(), String> {
    let bytes: usize = parts.values().map(Vec::len).sum();
    if bytes > RECORD_LIMIT {
        return Err("content_sync_record_too_large".into());
    }
    let raw: Vec<u8> = parts.values().flatten().copied().collect();
    let decoded: Row = serde_json::from_slice(&raw).map_err(|_| "content_sync_invalid_fragment")?;
    row(conn, &decoded)?;
    let total = parts.len() as u32;
    for (&part, body) in parts {
        sql(conn.execute("INSERT INTO content_sync_fragment_compat(record_id,part,total,digest) VALUES(?1,?2,?3,?4)", params![record_id,part,total,hash(body)]))?;
    }
    Ok(())
}

/// Called in the same transaction as initial splitting, before any original byte retires.
pub(super) fn remember(conn: &Connection, record_id: &str, raw: &[u8]) -> Result<(), String> {
    let parts = raw
        .chunks(42_000)
        .enumerate()
        .map(|(part, bytes)| (part as u32, bytes.to_vec()))
        .collect();
    remember_parts(conn, record_id, &parts)
}

pub(super) fn fragment(conn: &Connection, part: &Fragment) -> Result<(), String> {
    let body = B64
        .decode(&part.bytes)
        .map_err(|_| "content_sync_invalid_fragment")?;
    if part.total == 0 || part.total > 4096 || part.part >= part.total || body.len() > 42_000 {
        return Err("content_sync_invalid_fragment".into());
    }
    let proof: Option<(u32, String)> = sql(conn
        .query_row(
            "SELECT total,digest FROM content_sync_fragment_compat WHERE record_id=?1 AND part=?2",
            params![part.record_id, part.part],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())?;
    if let Some((total, digest)) = proof {
        return if total == part.total && digest == hash(&body) {
            Ok(())
        } else {
            Err("content_sync_fragment_conflict".into())
        };
    }
    let mut parts = BTreeMap::new();
    parts.insert(part.part, body);
    let mut statement = sql(conn.prepare("SELECT part,total,body FROM content_sync_outbound_fragments WHERE record_id=?1 ORDER BY part"))?;
    let rows = sql(statement.query_map([&part.record_id], |r| {
        Ok((
            r.get::<_, u32>(0)?,
            r.get::<_, u32>(1)?,
            r.get::<_, Vec<u8>>(2)?,
        ))
    }))?;
    let mut bytes = parts.values().map(Vec::len).sum::<usize>();
    for raw in rows {
        let (number, total, body) = sql(raw)?;
        if total != part.total || number >= total || body.len() > 42_000 {
            return Err("content_sync_fragment_conflict".into());
        }
        if let Some(existing) = parts.get(&number) {
            if existing != &body {
                return Err("content_sync_fragment_conflict".into());
            }
        } else {
            bytes += body.len();
            if bytes > RECORD_LIMIT {
                return Err("content_sync_record_too_large".into());
            }
            parts.insert(number, body);
        }
    }
    if parts.len() != part.total as usize || !parts.keys().copied().eq(0..part.total) {
        // ACKed prefixes cannot be recovered from the possibly edited/promoted current shadow.
        return Err("content_sync_legacy_fragment_unverified".into());
    }
    remember_parts(conn, &part.record_id, &parts)
}

pub(super) type Prepared = (String, String, String, i64, Option<String>);

/// Validate exactly the selected durable envelope, independent of an unknown relay server position.
pub(super) fn outbox(conn: &Connection, cfg: &RelayConfig) -> Result<Option<Prepared>, String> {
    let item: Option<(String,String,String,i64)> = sql(conn.query_row(
        "SELECT batch_id,body,envelope_hash,local_seq FROM content_sync_outbox ORDER BY local_seq LIMIT 1",
        [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))
    ).optional())?;
    let Some((id, body, digest, seq)) = item else {
        return Ok(None);
    };
    let batch: Batch = serde_json::from_str(&body).map_err(|_| "content_sync_invalid_envelope")?;
    if batch.batch_id != id || batch.client_seq != seq || envelope_hash(&batch.envelope)? != digest
    {
        return Err("content_sync_invalid_envelope".into());
    }
    let payload = unseal(cfg, &cfg.device_id, &batch)?;
    for record in &payload.rows {
        row(conn, record)?;
    }
    if !payload.tombs.is_empty() {
        return Err("content_sync_unknown_schema".into());
    }
    if let Some(part) = &payload.fragment {
        fragment(conn, part)?;
    }
    Ok(Some((
        id,
        body,
        digest,
        seq,
        payload.fragment.map(|part| part.record_id),
    )))
}
