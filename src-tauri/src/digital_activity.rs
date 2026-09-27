//! Local ActivityWatch importer. Raw events stay in memory; only daily app totals
//! enter the ordinary calendar journal. Configuration and credentials stay local.
use chrono::{DateTime, Local, NaiveDate, TimeZone, Utc};
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Mutex,
    time::Duration,
};
use tauri::{Emitter, State};
use uuid::Uuid;

#[path = "digital_activity_erasure.rs"]
pub(crate) mod erasure;

const SETTINGS_KEY: &str = "digital_activity_connections_v1";
const SECRET_SERVICE: &str = "app.hanni.mvp.activity";
const MAX_RESPONSE: usize = 8 * 1024 * 1024;
const MAX_DEVICES: usize = 8;
const MAX_SECRET_BYTES: usize = 4096;
const MAX_EVENT_SECONDS: f64 = 7.0 * 86400.0;
const EVENT_LIMIT: usize = 100_000;
// Imports serialize, but saves do not wait for HTTP. Saves and commits use this
// short mutex in the same order, then a SQLite transaction for cross-connection CAS.
static IMPORT_LOCK: Mutex<()> = Mutex::new(());
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityConnection {
    pub id: String,
    pub label: String,
    pub port: u16,
    pub endpoint: String,
    pub enabled: bool,
    pub source: String,
    #[serde(default)]
    revision: String,
    #[serde(default)]
    token_slot: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveConnectionInput {
    pub id: Option<String>,
    pub label: String,
    pub port: u16,
    pub endpoint: Option<String>,
    pub enabled: bool,
    pub token: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Bucket {
    client: String,
    r#type: String,
    #[serde(default)]
    hostname: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Event {
    #[serde(default, rename = "id")]
    _id: Option<Value>,
    timestamp: String,
    duration: f64,
    data: Value,
}

#[derive(Debug, Clone)]
struct Aggregate {
    day: NaiveDate,
    foreground_seconds: f64,
    active_seconds: Option<f64>,
    apps: BTreeMap<String, f64>,
}

struct Reading {
    aggregates: Vec<Aggregate>,
    has_active: bool,
}

fn storage_error(_: impl std::fmt::Display) -> String {
    "digital_activity_storage_failed".into()
}

pub fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS digital_activity_status (
        device_id TEXT PRIMARY KEY, last_success TEXT, last_error TEXT,
        records INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS digital_activity_capabilities (
        device_id TEXT PRIMARY KEY, has_active INTEGER NOT NULL);",
    )
    .map_err(storage_error)
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.len() != 36
        || Uuid::parse_str(id)
            .map(|v| v.to_string() != id)
            .unwrap_or(true)
    {
        return Err("digital_activity_invalid_device_id".into());
    }
    Ok(())
}

fn validate_endpoint(endpoint: &str, port: u16) -> Result<String, String> {
    let parsed =
        reqwest::Url::parse(endpoint.trim()).map_err(|_| "digital_activity_invalid_endpoint")?;
    if port == 0
        || parsed.scheme() != "http"
        || !matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost"))
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err("digital_activity_loopback_only".into());
    }
    if parsed.port().is_some_and(|p| p != port) {
        return Err("digital_activity_port_mismatch".into());
    }
    Ok(format!("http://127.0.0.1:{port}"))
}

fn validate_config(cfg: &ActivityConnection) -> Result<(), String> {
    validate_id(&cfg.id)?;
    if cfg.label.trim().is_empty()
        || cfg.label.chars().count() > 100
        || cfg.label.chars().any(char::is_control)
        || !matches!(cfg.source.as_str(), "windows" | "android")
    {
        return Err("digital_activity_invalid_config".into());
    }
    validate_endpoint(&cfg.endpoint, cfg.port)?;
    if let Some(slot) = &cfg.token_slot {
        validate_id(slot)?;
    }
    Ok(())
}

fn read_connections(conn: &Connection) -> Result<Vec<ActivityConnection>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key=?1",
            [SETTINGS_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    let list: Vec<ActivityConnection> = raw
        .map(|v| {
            serde_json::from_str(&v).map_err(|_| "digital_activity_invalid_config".to_string())
        })
        .transpose()?
        .unwrap_or_default();
    if list.len() > MAX_DEVICES {
        return Err("digital_activity_device_limit".into());
    }
    let mut ids = BTreeSet::new();
    for cfg in &list {
        validate_config(cfg)?;
        if !ids.insert(&cfg.id) {
            return Err("digital_activity_duplicate_device".into());
        }
    }
    Ok(list)
}

fn read_secrets(path: &Path) -> Result<BTreeMap<String, String>, String> {
    let raw = crate::mvp_sync::secrets::read_for(path, SECRET_SERVICE)?;
    decode_secrets(raw.as_deref())
}

fn decode_secrets(raw: Option<&str>) -> Result<BTreeMap<String, String>, String> {
    let raw = raw.unwrap_or("{}");
    if raw.len() > MAX_SECRET_BYTES {
        return Err("digital_activity_secret_invalid".into());
    }
    let map: BTreeMap<String, String> =
        serde_json::from_str(raw).map_err(|_| "digital_activity_secret_invalid")?;
    if map.len() > MAX_DEVICES + 1
        || map.iter().any(|(k, v)| {
            validate_id(k).is_err()
                || v.is_empty()
                || v.len() > 1024
                || v.chars().any(char::is_control)
        })
    {
        return Err("digital_activity_secret_invalid".into());
    }
    Ok(map)
}

fn encode_secrets(map: &BTreeMap<String, String>) -> Result<String, String> {
    let raw = serde_json::to_string(map).map_err(storage_error)?;
    decode_secrets(Some(&raw))?;
    Ok(raw)
}

fn token_for(
    cfg: &ActivityConnection,
    map: &BTreeMap<String, String>,
) -> Result<Option<String>, String> {
    // Previous versions keyed tokens by device UUID; migrate on the next save.
    if cfg.token_slot.is_none() && !cfg.revision.is_empty() {
        return Ok(None);
    }
    let slot = cfg.token_slot.as_deref().unwrap_or(&cfg.id);
    if cfg.token_slot.is_some() && !map.contains_key(slot) {
        return Err("digital_activity_secret_missing".into());
    }
    Ok(map.get(slot).cloned())
}

fn references_slot(cfg: &ActivityConnection, slot: &str) -> bool {
    cfg.token_slot.as_deref() == Some(slot)
        || (cfg.revision.is_empty() && cfg.token_slot.is_none() && cfg.id == slot)
}

fn save_connection(
    conn: &mut Connection,
    path: &Path,
    input: SaveConnectionInput,
) -> Result<String, String> {
    let _guard = CONFIG_LOCK.lock().map_err(storage_error)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let mut list = read_connections(&tx)?;
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let previous = list.iter().find(|v| v.id == id);
    let mut cfg = ActivityConnection {
        id: id.clone(),
        label: input.label.trim().into(),
        port: input.port,
        endpoint: validate_endpoint(
            input.endpoint.as_deref().unwrap_or("http://127.0.0.1"),
            input.port,
        )?,
        enabled: input.enabled,
        source: input.source.unwrap_or_else(|| "windows".into()),
        revision: Uuid::new_v4().to_string(),
        token_slot: previous.and_then(|v| v.token_slot.clone()),
    };
    validate_config(&cfg)?;
    if previous.is_none() && list.len() >= MAX_DEVICES {
        return Err("digital_activity_device_limit".into());
    }
    let mut secrets = read_secrets(path)?;
    // Remove abandoned slots from a prior interrupted save, retaining every slot
    // referenced by the committed configuration before staging a replacement.
    secrets.retain(|slot, _| list.iter().any(|v| references_slot(v, slot)));
    let old_token = previous
        .map(|old| token_for(old, &secrets))
        .transpose()?
        .flatten();
    let token = match input.token {
        None => old_token.clone(),
        Some(token) if token.is_empty() => None,
        Some(token) => Some(token),
    };
    let source_changed = previous.is_none_or(|old| {
        old.endpoint != cfg.endpoint
            || old.port != cfg.port
            || old.source != cfg.source
            || old_token != token
    });
    cfg.token_slot = match token {
        Some(token) if old_token.as_deref() == Some(&token) && cfg.token_slot.is_some() => {
            cfg.token_slot
        }
        Some(token) => {
            let slot = Uuid::new_v4().to_string();
            secrets.insert(slot.clone(), token);
            Some(slot)
        }
        None => None,
    };
    list.retain(|v| v.id != id);
    list.push(cfg.clone());
    let staged = encode_secrets(&secrets)?;
    crate::mvp_sync::secrets::write_for(path, SECRET_SERVICE, &staged)?;
    tx.execute(
        "INSERT INTO app_settings(key,value,updated_at) VALUES(?1,?2,?3)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        params![
            SETTINGS_KEY,
            serde_json::to_string(&list).map_err(storage_error)?,
            cfg.revision
        ],
    )
    .map_err(storage_error)?;
    if source_changed {
        tx.execute("UPDATE digital_activity_status SET last_success=NULL,last_error=NULL WHERE device_id=?1",[&id]).map_err(storage_error)?;
        tx.execute(
            "DELETE FROM digital_activity_capabilities WHERE device_id=?1",
            [&id],
        )
        .map_err(storage_error)?;
    }
    tx.commit().map_err(storage_error)?;
    // Old slots survive until configuration commit, making a crash or DB error
    // harmless to the previous configuration. Cleanup is recoverable on next save.
    secrets.retain(|slot, _| list.iter().any(|v| references_slot(v, slot)));
    if let Ok(raw) = encode_secrets(&secrets) {
        let _ = crate::mvp_sync::secrets::write_for(path, SECRET_SERVICE, &raw);
    }
    Ok(id)
}

fn client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "digital_activity_client_failed".into())
}

fn fetch_json(
    client: &Client,
    cfg: &ActivityConnection,
    token: Option<&str>,
    path: &str,
    query: &[(&str, String)],
) -> Result<Value, String> {
    use std::io::Read;
    let mut request = client.get(format!("{}{}", cfg.endpoint, path)).query(query);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let mut response = request
        .send()
        .map_err(|_| "digital_activity_connection_failed")?;
    if !response.status().is_success() {
        return Err(format!(
            "digital_activity_http_{}",
            response.status().as_u16()
        ));
    }
    if response.content_length().unwrap_or(0) > MAX_RESPONSE as u64 {
        return Err("digital_activity_response_too_large".into());
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(MAX_RESPONSE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "digital_activity_response_failed")?;
    if bytes.len() > MAX_RESPONSE {
        return Err("digital_activity_response_too_large".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "digital_activity_invalid_response".into())
}

fn app_name(event: &Event, android: bool) -> Result<String, String> {
    let object = event
        .data
        .as_object()
        .ok_or("digital_activity_invalid_event")?;
    if !android
        && (object.keys().any(|k| k != "app" && k != "title")
            || object.get("title").and_then(Value::as_str) != Some("excluded"))
    {
        return Err("digital_activity_unredacted_title".into());
    }
    if android
        && object
            .keys()
            .any(|k| !matches!(k.as_str(), "app" | "package" | "classname"))
    {
        return Err("digital_activity_android_sensitive_fields".into());
    }
    let name = object
        .get("app")
        .and_then(Value::as_str)
        .ok_or("digital_activity_missing_app")?
        .trim();
    if name.is_empty() || name.len() > 200 || name.chars().any(char::is_control) {
        return Err("digital_activity_invalid_app".into());
    }
    Ok(name.to_string())
}

type Interval = (f64, f64);
fn interval(event: &Event) -> Result<Interval, String> {
    let stamp = DateTime::parse_from_rfc3339(&event.timestamp)
        .map_err(|_| "digital_activity_invalid_timestamp")?;
    if !event.duration.is_finite() || event.duration < 0.0 || event.duration > MAX_EVENT_SECONDS {
        return Err("digital_activity_invalid_duration".into());
    }
    let start = stamp.timestamp() as f64 + f64::from(stamp.timestamp_subsec_nanos()) / 1e9;
    Ok((start, start + event.duration))
}

fn merge(mut values: Vec<Interval>) -> Vec<Interval> {
    values.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<Interval> = Vec::new();
    for (a, b) in values {
        if b <= a {
            continue;
        }
        if let Some(last) = out.last_mut() {
            if a <= last.1 {
                last.1 = last.1.max(b);
                continue;
            }
        }
        out.push((a, b));
    }
    out
}

fn subtract(active: Vec<Interval>, away: Vec<Interval>) -> Vec<Interval> {
    let away = merge(away);
    let mut index = 0;
    let mut result = Vec::new();
    for (a, b) in merge(active) {
        let mut cursor = a;
        while index < away.len() && away[index].1 <= cursor {
            index += 1;
        }
        while index < away.len() && away[index].0 < b {
            let (start, end) = away[index];
            if start > cursor {
                result.push((cursor, start.min(b)));
            }
            cursor = cursor.max(end);
            if end >= b {
                break;
            }
            index += 1;
        }
        if cursor < b {
            result.push((cursor, b));
        }
    }
    result
}

/// A sweep over every window AND AFK boundary. Latest window start wins;
/// simultaneous starts use the app name for stable order independent of API order.
/// Durations retain fractions; no rounding is done per segment.
fn allocate(
    events: &[(f64, f64, String)],
    allowed: &[Interval],
    lo: f64,
    hi: f64,
) -> BTreeMap<String, f64> {
    let mut ordered: Vec<_> = events.iter().collect();
    ordered.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.2.cmp(&b.2)));
    // Marks contain (time, window rank or None for allowed interval, opening).
    let mut marks = Vec::new();
    for (rank, (a, b, _)) in ordered.iter().enumerate() {
        if *b > lo && *a < hi && b > a {
            marks.push((a.max(lo), Some(rank), true));
            marks.push((b.min(hi), Some(rank), false));
        }
    }
    for &(a, b) in allowed {
        if b > lo && a < hi && b > a {
            marks.push((a.max(lo), None, true));
            marks.push((b.min(hi), None, false));
        }
    }
    marks.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut result = BTreeMap::new();
    let mut running: BTreeSet<usize> = BTreeSet::new();
    let mut allowed_count = 0i64;
    let mut previous = lo;
    for (at, rank, opening) in marks {
        if at > previous && allowed_count > 0 {
            if let Some(rank) = running.last() {
                let name: &String = &ordered[*rank].2;
                *result.entry(name.clone()).or_insert(0.0) += at - previous;
            }
        }
        match rank {
            Some(rank) if opening => {
                running.insert(rank);
            }
            Some(rank) => {
                running.remove(&rank);
            }
            None => allowed_count += if opening { 1 } else { -1 },
        }
        previous = at;
    }
    result
}

fn day_bounds<T: TimeZone>(zone: &T, date: NaiveDate) -> Result<Interval, String> {
    let next = date.succ_opt().ok_or("digital_activity_invalid_date")?;
    let midnight = |d: NaiveDate| {
        zone.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap())
            .earliest()
            .map(|v| v.timestamp() as f64)
            .ok_or("digital_activity_invalid_local_day".to_string())
    };
    Ok((midnight(date)?, midnight(next)?))
}

fn requested_days(date: Option<&str>) -> Result<Vec<NaiveDate>, String> {
    if let Some(raw) = date {
        let day = NaiveDate::parse_from_str(raw, "%Y-%m-%d")
            .map_err(|_| "digital_activity_invalid_date")?;
        if day > Local::now().date_naive()
            || day.to_string() != raw
            || !("1970-01-01"..="9999-12-30").contains(&raw)
        {
            return Err("digital_activity_invalid_date".into());
        }
        return Ok(vec![day]);
    }
    let today = Local::now().date_naive();
    Ok(vec![
        today.pred_opt().ok_or("digital_activity_invalid_date")?,
        today,
    ])
}

fn aggregate(
    windows: &[Event],
    afk: Option<&[Event]>,
    android: bool,
    days: &[(NaiveDate, Interval)],
) -> Result<Reading, String> {
    let mut events = Vec::new();
    for event in windows {
        let (a, b) = interval(event)?;
        events.push((a, b, app_name(event, android)?));
    }
    let mut active = Vec::new();
    let mut away = Vec::new();
    let mut observed = Vec::new();
    if let Some(afk) = afk {
        for event in afk {
            let part = interval(event)?;
            observed.push(part);
            let data = event
                .data
                .as_object()
                .ok_or("digital_activity_invalid_afk")?;
            if data.len() != 1 {
                return Err("digital_activity_invalid_afk".into());
            }
            match data.get("status").and_then(Value::as_str) {
                Some("not-afk") => active.push(part),
                Some("afk") => away.push(part),
                _ => return Err("digital_activity_invalid_afk".into()),
            }
        }
    }
    let allowed = subtract(active, away);
    let mut aggregates = Vec::new();
    for &(day, (lo, hi)) in days {
        let apps = allocate(&events, &[(lo, hi)], lo, hi);
        let foreground_seconds = apps.values().sum::<f64>();
        if foreground_seconds > 0.0 {
            let has_observations = observed.iter().any(|(a, b)| *b > lo && *a < hi && b > a);
            let active_seconds =
                has_observations.then(|| allocate(&events, &allowed, lo, hi).values().sum());
            aggregates.push(Aggregate {
                day,
                foreground_seconds,
                active_seconds,
                apps,
            });
        }
    }
    let has_active = aggregates.iter().any(|row| row.active_seconds.is_some());
    Ok(Reading {
        aggregates,
        has_active,
    })
}

fn read_device(
    client: &Client,
    cfg: &ActivityConnection,
    token: Option<&str>,
    dates: &[NaiveDate],
) -> Result<Reading, String> {
    validate_config(cfg)?;
    let raw = fetch_json(client, cfg, token, "/api/0/buckets/", &[])?;
    let object = raw.as_object().ok_or("digital_activity_invalid_buckets")?;
    if object.len() > 128 {
        return Err("digital_activity_too_many_buckets".into());
    }
    let expected = if cfg.source == "android" {
        "aw-android"
    } else {
        "aw-watcher-window"
    };
    let mut windows = Vec::new();
    let mut afk = Vec::new();
    for (id, value) in object {
        let bucket: Bucket =
            serde_json::from_value(value.clone()).map_err(|_| "digital_activity_invalid_bucket")?;
        if bucket.client == expected && bucket.r#type == "currentwindow" {
            windows.push((id, bucket));
        } else if cfg.source == "windows"
            && bucket.client == "aw-watcher-afk"
            && bucket.r#type == "afkstatus"
        {
            afk.push((id, bucket));
        }
    }
    if windows.len() > 1 || afk.len() > 1 {
        return Err("digital_activity_duplicate_client_bucket".into());
    }
    let (window_id, window) = windows
        .first()
        .ok_or("digital_activity_missing_window_bucket")?;
    if let Some((_, other)) = afk.first() {
        if window.hostname.is_empty()
            || other.hostname.is_empty()
            || window.hostname != other.hostname
        {
            return Err("digital_activity_hostname_mismatch".into());
        }
    }
    let days = dates
        .iter()
        .map(|day| Ok((*day, day_bounds(&Local, *day)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let lo = days.first().ok_or("digital_activity_invalid_date")?.1 .0;
    let hi = days.last().unwrap().1 .1;
    // AW filters on event start. This lookback covers the entire accepted duration
    // range, including an event beginning before yesterday and crossing midnight.
    let query = [
        (
            "start",
            DateTime::<Utc>::from_timestamp((lo - MAX_EVENT_SECONDS) as i64, 0)
                .ok_or("digital_activity_invalid_date")?
                .to_rfc3339(),
        ),
        (
            "end",
            DateTime::<Utc>::from_timestamp(hi as i64, 0)
                .ok_or("digital_activity_invalid_date")?
                .to_rfc3339(),
        ),
        ("limit", EVENT_LIMIT.to_string()),
    ];
    let fetch_events = |id: &str| -> Result<Vec<Event>, String> {
        let mut url = reqwest::Url::parse("http://127.0.0.1/api/0/buckets/").unwrap();
        url.path_segments_mut()
            .unwrap()
            .pop_if_empty()
            .push(id)
            .push("events");
        let raw = fetch_json(client, cfg, token, url.path(), &query)?;
        let events: Vec<Event> =
            serde_json::from_value(raw).map_err(|_| "digital_activity_invalid_events")?;
        if events.len() >= EVENT_LIMIT {
            return Err("digital_activity_event_limit".into());
        }
        Ok(events)
    };
    let window_events = fetch_events(window_id)?;
    let afk_events = afk.first().map(|(id, _)| fetch_events(id)).transpose()?;
    aggregate(
        &window_events,
        afk_events.as_deref(),
        cfg.source == "android",
        &days,
    )
}

fn duration_label(seconds: f64) -> String {
    let seconds = seconds.floor() as i64;
    format!("{} ч {} мин", seconds / 3600, (seconds % 3600) / 60)
}

fn project(
    conn: &Connection,
    cfg: &ActivityConnection,
    aggregates: &[Aggregate],
) -> Result<i64, String> {
    let now = Utc::now().to_rfc3339();
    let mut changed = 0;
    let deleted_through = erasure::cutoff(conn, &cfg.id)?;
    for aggregate in aggregates {
        if aggregate.foreground_seconds <= 0.0
            || deleted_through
                .as_ref()
                .is_some_and(|day| aggregate.day.to_string() <= *day)
        {
            continue;
        }
        let key = format!("digital-activity:{}:{}", cfg.id, aggregate.day);
        let active = aggregate
            .active_seconds
            .map(duration_label)
            .unwrap_or_else(|| "нет данных".into());
        let mut detail = format!(
            "Источник: ActivityWatch. Активность на экране: {}. Ввод/не-AFK: {}. Приложения:",
            duration_label(aggregate.foreground_seconds),
            active
        );
        for (app, seconds) in &aggregate.apps {
            detail.push_str(&format!("\n{} — {}", app, duration_label(*seconds)));
        }
        let title = format!(
            "Активность · {} · {}",
            cfg.label,
            duration_label(aggregate.foreground_seconds)
        );
        // Structured aggregate retained in tags so fractional changes remain
        // observable and the ordinary sync record carries exact daily metrics.
        let tags = json!([
            "digital-activity:v1",
            format!("digital-activity-device:{}", cfg.id),
            format!("digital-activity-day:{}", aggregate.day),
            format!(
                "digital-activity-summary:{}",
                json!({"foreground_seconds":aggregate.foreground_seconds,
                "active_seconds":aggregate.active_seconds,"apps":aggregate.apps})
            )
        ])
        .to_string();
        changed += conn.execute("INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,tags,status)
            VALUES(?1,'event',?2,?3,?4,NULL,?5,0,1,?6,?6,'general','#7A8C5B',?7,'event')
            ON CONFLICT(id) DO UPDATE SET title=excluded.title,notes=excluded.notes,date=excluded.date,time=NULL,
            duration_minutes=excluded.duration_minutes,tags=excluded.tags,version=items.version+1,updated_at=excluded.updated_at
            WHERE items.title IS NOT excluded.title OR items.notes IS NOT excluded.notes OR items.date IS NOT excluded.date
            OR items.time IS NOT NULL OR items.duration_minutes IS NOT excluded.duration_minutes OR items.tags IS NOT excluded.tags",
            params![key,title,detail,aggregate.day.to_string(),(aggregate.foreground_seconds/60.0).ceil() as i64,now,tags]).map_err(storage_error)?;
    }
    Ok(changed as i64)
}

/// Recheck inside the write transaction; stale successes AND errors cannot update
/// events or status after pause, endpoint/source changes, or token rotation.
fn commit_reading(
    conn: &mut Connection,
    cfg: &ActivityConnection,
    result: Result<Reading, String>,
    require_enabled: bool,
) -> Result<Option<(i64, i64, Vec<String>, Option<String>)>, String> {
    let _guard = CONFIG_LOCK.lock().map_err(storage_error)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    if !read_connections(&tx)?
        .iter()
        .any(|current| current == cfg && (!require_enabled || current.enabled))
    {
        return Ok(None);
    }
    let outcome = match result {
        Ok(mut reading) => {
            if let Some(limit) = erasure::cutoff(&tx, &cfg.id)? {
                reading.aggregates.retain(|a| a.day.to_string() > limit);
            }
            let changed = project(&tx, cfg, &reading.aggregates)?;
            let records: i64 = tx
                .query_row(
                    "SELECT count(*) FROM items WHERE id GLOB ?1",
                    [format!("digital-activity:{}:*", cfg.id)],
                    |r| r.get(0),
                )
                .map_err(storage_error)?;
            tx.execute("INSERT INTO digital_activity_status(device_id,last_success,last_error,records) VALUES(?1,?2,NULL,?3)
                ON CONFLICT(device_id) DO UPDATE SET last_success=excluded.last_success,last_error=NULL,records=excluded.records",
                params![cfg.id,Utc::now().to_rfc3339(),records]).map_err(storage_error)?;
            tx.execute(
                "INSERT INTO digital_activity_capabilities(device_id,has_active) VALUES(?1,?2)
                ON CONFLICT(device_id) DO UPDATE SET has_active=excluded.has_active",
                params![cfg.id, reading.has_active],
            )
            .map_err(storage_error)?;
            (
                reading.aggregates.len() as i64,
                changed,
                reading
                    .aggregates
                    .iter()
                    .map(|a| a.day.to_string())
                    .collect(),
                None,
            )
        }
        Err(error) => {
            tx.execute(
                "INSERT INTO digital_activity_status(device_id,last_error) VALUES(?1,?2)
                ON CONFLICT(device_id) DO UPDATE SET last_error=excluded.last_error",
                params![cfg.id, error],
            )
            .map_err(storage_error)?;
            (0, 0, Vec::new(), Some(error))
        }
    };
    tx.commit().map_err(storage_error)?;
    Ok(Some(outcome))
}

fn run_import(
    path: &Path,
    device_id: Option<&str>,
    dates: &[NaiveDate],
    manual: bool,
) -> Result<Value, String> {
    let _import = IMPORT_LOCK.lock().map_err(storage_error)?;
    let mut conn = Connection::open(path).map_err(storage_error)?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(storage_error)?;
    let snapshots = {
        let _guard = CONFIG_LOCK.lock().map_err(storage_error)?;
        let configs = read_connections(&conn)?;
        if device_id.is_some_and(|id| !configs.iter().any(|c| c.id == id)) {
            return Err("digital_activity_device_not_found".into());
        }
        let secrets = read_secrets(path);
        configs
            .into_iter()
            .filter(|c| (manual || c.enabled) && device_id.is_none_or(|id| c.id == id))
            .map(|cfg| {
                let token = secrets
                    .as_ref()
                    .map_err(Clone::clone)
                    .and_then(|m| token_for(&cfg, m));
                (cfg, token)
            })
            .collect::<Vec<_>>()
    };
    let client = client()?;
    let (mut imported, mut changed, mut skipped) = (0, 0, 0);
    let mut errors = Vec::new();
    let mut days = BTreeSet::new();
    for (cfg, token) in snapshots {
        let result = token.and_then(|token| read_device(&client, &cfg, token.as_deref(), dates));
        match commit_reading(&mut conn, &cfg, result, !manual)? {
            None => skipped += 1,
            Some((count, updates, dates, error)) => {
                imported += count;
                changed += updates;
                days.extend(dates);
                if let Some(error) = error {
                    errors.push(json!({"deviceId":cfg.id,"error":error}));
                }
            }
        }
    }
    Ok(json!({"imported":imported,"changed":changed,"skipped":skipped,"errors":errors,"days":days}))
}

pub fn decorate(value: &mut Value, key: &str, tags: &str) {
    if !key.starts_with("digital-activity:") {
        return;
    }
    value["readonly"] = json!(true);
    value["source"] = json!("activity_watch");
    value["activity"] = json!(true);
    if let Ok(tags) = serde_json::from_str::<Vec<String>>(tags) {
        if let Some(summary) = tags
            .iter()
            .find_map(|v| v.strip_prefix("digital-activity-summary:"))
        {
            if let Ok(summary) = serde_json::from_str::<Value>(summary) {
                value["activity_summary"] = summary;
            }
        }
    }
}

fn public_connection(cfg: &ActivityConnection) -> Value {
    json!({"id":cfg.id,"label":cfg.label,"port":cfg.port,"endpoint":cfg.endpoint,"enabled":cfg.enabled,"source":cfg.source})
}

#[tauri::command(rename_all = "camelCase")]
pub fn digital_activity_get_connections(
    state: State<'_, crate::AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(storage_error)?;
    let devices = read_connections(&conn)?;
    Ok(
        json!({"enabled":devices.iter().any(|v| v.enabled),"devices":devices.iter().map(public_connection).collect::<Vec<_>>()}),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn digital_activity_save_connection(
    input: SaveConnectionInput,
    app: tauri::AppHandle,
    state: State<'_, crate::AppState>,
) -> Result<Value, String> {
    let path = crate::app_data_dir(&app)?.join("calendar.db");
    let mut conn = state.0.lock().map_err(storage_error)?;
    let id = save_connection(&mut conn, &path, input)?;
    Ok(json!({"id":id,"saved":true}))
}

fn remove_connection(conn: &mut Connection, path: &Path, device_id: &str) -> Result<(), String> {
    validate_id(device_id)?;
    let _guard = CONFIG_LOCK.lock().map_err(storage_error)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let mut list = read_connections(&tx)?;
    if !list.iter().any(|cfg| cfg.id == device_id) {
        return Err("digital_activity_device_not_found".into());
    }
    let mut secrets = read_secrets(path)?;
    list.retain(|cfg| cfg.id != device_id);
    tx.execute(
        "UPDATE app_settings SET value=?1,updated_at=?2 WHERE key=?3",
        params![
            serde_json::to_string(&list).map_err(storage_error)?,
            Uuid::new_v4().to_string(),
            SETTINGS_KEY
        ],
    )
    .map_err(storage_error)?;
    tx.execute(
        "DELETE FROM digital_activity_status WHERE device_id=?1",
        [device_id],
    )
    .map_err(storage_error)?;
    tx.execute(
        "DELETE FROM digital_activity_capabilities WHERE device_id=?1",
        [device_id],
    )
    .map_err(storage_error)?;
    tx.commit().map_err(storage_error)?;
    secrets.retain(|slot, _| list.iter().any(|cfg| references_slot(cfg, slot)));
    // Commit disconnect first so no in-flight importer can write even if the OS
    // credential store fails. Report cleanup failure; a later save prunes it too.
    crate::mvp_sync::secrets::write_for(path, SECRET_SERVICE, &encode_secrets(&secrets)?)
        .map_err(|_| "digital_activity_disconnected_secret_cleanup_failed".into())
}

#[tauri::command(rename_all = "camelCase")]
pub fn digital_activity_remove_connection(
    device_id: String,
    app: tauri::AppHandle,
    state: State<'_, crate::AppState>,
) -> Result<Value, String> {
    let path = crate::app_data_dir(&app)?.join("calendar.db");
    let mut conn = state.0.lock().map_err(storage_error)?;
    remove_connection(&mut conn, &path, &device_id)?;
    Ok(json!({"id":device_id,"removed":true}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn digital_activity_status(state: State<'_, crate::AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(storage_error)?;
    let mut devices = Vec::new();
    for cfg in read_connections(&conn)? {
        let mut value = public_connection(&cfg);
        let row = conn.query_row("SELECT last_success,last_error,records FROM digital_activity_status WHERE device_id=?1",[&cfg.id],
            |r| Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,i64>(2)?))).optional().map_err(storage_error)?;
        let (success, error, _) = row.unwrap_or((None, None, 0));
        let records: i64 = conn
            .query_row(
                "SELECT count(*) FROM items WHERE id GLOB ?1",
                [format!("digital-activity:{}:*", cfg.id)],
                |r| r.get(0),
            )
            .map_err(storage_error)?;
        let has_active: bool = conn
            .query_row(
                "SELECT has_active FROM digital_activity_capabilities WHERE device_id=?1",
                [&cfg.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)?
            .unwrap_or(false);
        let mut capabilities = vec!["aggregate_app_durations", "foreground_seconds"];
        if has_active {
            capabilities.push("active_seconds");
        }
        value["capabilities"] = json!(capabilities);
        value["lastSuccess"] = json!(success);
        value["lastError"] = json!(error);
        value["records"] = json!(records);
        value["deletedThrough"] = json!(erasure::cutoff(&conn, &cfg.id)?);
        devices.push(value);
    }
    Ok(json!({"enabled":devices.iter().any(|v| v["enabled"] == true),"devices":devices}))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn digital_activity_import_now(
    device_id: Option<String>,
    local_date: Option<String>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    if let Some(id) = &device_id {
        validate_id(id)?;
    }
    let dates = requested_days(local_date.as_deref())?;
    let path = crate::app_data_dir(&app)?.join("calendar.db");
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_import(&path, device_id.as_deref(), &dates, true)
    })
    .await
    .map_err(|_| "digital_activity_worker_failed")??;
    if result["changed"].as_i64().unwrap_or(0) > 0 {
        let _ = app.emit("digital-activity-updated", &result);
    }
    Ok(result)
}

pub fn start_background(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new()
        .name("cicada-activity-import".into())
        .spawn(move || loop {
            if let (Ok(directory), Ok(dates)) = (crate::app_data_dir(&app), requested_days(None)) {
                if let Ok(result) = run_import(&directory.join("calendar.db"), None, &dates, false)
                {
                    if result["changed"].as_i64().unwrap_or(0) > 0 {
                        let _ = app.emit("digital-activity-updated", result);
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(60));
        });
}

#[cfg(test)]
#[path = "digital_activity_tests.rs"]
mod tests;
