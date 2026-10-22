//! Opt-in, device-local selected-game observation. Never writes task timers or sync records.
//!
//! A stored interval needs two adjacent, active observations of the same selected
//! basename. Startup, configuration changes, source failures and continuity breaks
//! discard the pending edge. Missing observations never become zero activity.
use chrono::{NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use uuid::Uuid;

#[cfg(windows)]
#[path = "personal_activity_windows.rs"]
mod windows;

pub const SAMPLE_PERIOD_MS: u64 = 5_000;
const MAX_BRIDGE_MS: u64 = 8_000;
const CLOCK_TOLERANCE_MS: u64 = 100;
const IDLE_LIMIT_MS: u64 = 60_000;
const CHUNK_MS: i64 = 60_000;

fn storage_error(_: impl std::fmt::Display) -> String {
    "personal_activity_storage_failed".into()
}

pub fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS personal_activity_config (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), device_id TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0,
          executables TEXT NOT NULL DEFAULT '[]', last_sample_ms INTEGER, last_error TEXT);
         CREATE TABLE IF NOT EXISTS personal_activity_intervals (
          id TEXT PRIMARY KEY, device_id TEXT NOT NULL, executable TEXT NOT NULL,
          start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL CHECK(end_ms>start_ms));
         CREATE INDEX IF NOT EXISTS personal_activity_interval_range
          ON personal_activity_intervals(start_ms,end_ms);",
    )
    .map_err(storage_error)?;
    conn.execute(
        "INSERT OR IGNORE INTO personal_activity_config(singleton,device_id) VALUES(1,?1)",
        [Uuid::new_v4().to_string()],
    )
    .map_err(storage_error)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub supported: bool,
    pub enabled: bool,
    pub revision: u64,
    pub selected_executables: Vec<String>,
    pub device_id: String,
    pub running: bool,
    pub last_sample_ms: Option<i64>,
    pub last_error: Option<String>,
    pub storage_scope: &'static str,
    pub controller_supported: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureRequest {
    pub expected_revision: u64,
    pub enabled: bool,
    pub selected_executables: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DayRequest {
    pub date: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Interval {
    pub id: String,
    pub device_id: String,
    pub executable: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    pub date: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub device_id: String,
    pub observation_state: &'static str,
    pub intervals: Vec<Interval>,
    pub observed_ms: Option<i64>,
    pub error: Option<String>,
    pub storage_scope: &'static str,
}

fn read_status(conn: &Connection, supported: bool, now: i64) -> Result<Status, String> {
    let (device_id, revision, enabled_raw, raw, last_sample_ms, last_error): (
        String,
        u64,
        i64,
        String,
        Option<i64>,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT device_id,revision,enabled,executables,last_sample_ms,last_error
         FROM personal_activity_config WHERE singleton=1",
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .map_err(storage_error)?;
    let selected_executables: Vec<String> = serde_json::from_str(&raw).map_err(storage_error)?;
    if Uuid::parse_str(&device_id).is_err()
        || ![0, 1].contains(&enabled_raw)
        || last_error
            .as_ref()
            .is_some_and(|v| v != "personal_activity_source_unavailable")
    {
        return Err("personal_activity_invalid_stored_config".into());
    }
    let enabled = enabled_raw == 1;
    // Corrupted source settings fail closed; they must never start observation.
    if validate_executables(&selected_executables)? != selected_executables {
        return Err("personal_activity_invalid_stored_config".into());
    }
    let fresh = last_sample_ms.is_some_and(|v| {
        now.checked_sub(v)
            .is_some_and(|age| (0..=12_000).contains(&age))
    });
    Ok(Status {
        supported,
        enabled,
        revision,
        selected_executables,
        device_id,
        running: supported && enabled && fresh && last_error.is_none(),
        last_sample_ms,
        last_error,
        storage_scope: "local",
        controller_supported: false,
    })
}

pub fn status(conn: &Connection) -> Result<Status, String> {
    read_status(conn, cfg!(windows), Utc::now().timestamp_millis())
}

fn validate_executables(names: &[String]) -> Result<Vec<String>, String> {
    if names.len() > 32 {
        return Err("personal_activity_invalid_executable".into());
    }
    let mut canonical = BTreeSet::new();
    for raw in names {
        let name = raw.trim().to_lowercase();
        // Explicit basenames only: no drive, UNC, stream, wildcard, device or relative paths.
        if name.len() < 5
            || name.len() > 200
            || !name.ends_with(".exe")
            || name.starts_with('.')
            || name.ends_with(' ')
            || name.contains("..")
            || name
                .chars()
                .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
        {
            return Err("personal_activity_invalid_executable".into());
        }
        let stem = name.split('.').next().unwrap_or("");
        if ["con", "prn", "aux", "nul"].contains(&stem)
            || (stem.len() == 4
                && (stem.starts_with("com") || stem.starts_with("lpt"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("personal_activity_invalid_executable".into());
        }
        canonical.insert(name);
    }
    Ok(canonical.into_iter().collect())
}

pub fn configure(conn: &mut Connection, request: ConfigureRequest) -> Result<Status, String> {
    configure_for_platform(conn, request, cfg!(windows))
}

fn configure_for_platform(
    conn: &mut Connection,
    request: ConfigureRequest,
    supported: bool,
) -> Result<Status, String> {
    // Validate the complete request before acquiring a write transaction or changing anything.
    let executables = validate_executables(&request.selected_executables)?;
    if request.enabled && !supported {
        return Err("personal_activity_unsupported".into());
    }
    if request.enabled && executables.is_empty() {
        return Err("personal_activity_select_game".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let old = read_status(&tx, supported, Utc::now().timestamp_millis())?;
    if old.revision != request.expected_revision {
        return Err("personal_activity_config_changed".into());
    }
    let next = old
        .revision
        .checked_add(1)
        .filter(|v| *v <= i64::MAX as u64)
        .ok_or("personal_activity_config_changed")?;
    tx.execute(
        "UPDATE personal_activity_config SET revision=?1,enabled=?2,executables=?3,
         last_sample_ms=NULL,last_error=NULL WHERE singleton=1",
        params![
            next,
            request.enabled,
            serde_json::to_string(&executables).map_err(storage_error)?
        ],
    )
    .map_err(storage_error)?;
    let result = read_status(&tx, supported, Utc::now().timestamp_millis())?;
    tx.commit().map_err(storage_error)?;
    Ok(result)
}

pub fn day(conn: &Connection, request: DayRequest) -> Result<Day, String> {
    let date = NaiveDate::parse_from_str(&request.date, "%Y-%m-%d")
        .map_err(|_| "personal_activity_invalid_day")?;
    if date.format("%Y-%m-%d").to_string() != request.date {
        return Err("personal_activity_invalid_day".into());
    }
    let utc_midnight = date
        .and_hms_opt(0, 0, 0)
        .ok_or("personal_activity_invalid_day")?
        .and_utc()
        .timestamp_millis();
    let span = request
        .end_ms
        .checked_sub(request.start_ms)
        .ok_or("personal_activity_invalid_day")?;
    // Caller supplies timezone-aware boundaries, including DST. Bound the query
    // to one civil day and verify that its start can belong to the named date.
    if !(18 * 3_600_000..=27 * 3_600_000).contains(&span)
        || request.start_ms.abs_diff(utc_midnight) > 14 * 3_600_000
    {
        return Err("personal_activity_invalid_day".into());
    }
    let state = status(conn)?;
    let mut query = conn
        .prepare(
            "SELECT id,device_id,executable,start_ms,end_ms FROM personal_activity_intervals
         WHERE start_ms<?2 AND end_ms>?1 ORDER BY start_ms,end_ms,id",
        )
        .map_err(storage_error)?;
    let rows = query
        .query_map(params![request.start_ms, request.end_ms], |r| {
            Ok(Interval {
                id: r.get(0)?,
                device_id: r.get(1)?,
                executable: r.get(2)?,
                start_ms: r.get(3)?,
                end_ms: r.get(4)?,
            })
        })
        .map_err(storage_error)?;
    let mut intervals = rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)?;
    for interval in &mut intervals {
        if Uuid::parse_str(&interval.id).is_err()
            || Uuid::parse_str(&interval.device_id).is_err()
            || validate_executables(&[interval.executable.clone()])?
                != [interval.executable.clone()]
            || interval.start_ms < 0
            || !interval
                .end_ms
                .checked_sub(interval.start_ms)
                .is_some_and(|span| (1..=CHUNK_MS).contains(&span))
        {
            return Err("personal_activity_invalid_stored_interval".into());
        }
        interval.start_ms = interval.start_ms.max(request.start_ms);
        interval.end_ms = interval.end_ms.min(request.end_ms);
    }
    // Retrieval is read-only, including when observation is disabled or unsupported.
    let observed_ms = state
        .last_sample_ms
        .filter(|v| *v >= request.start_ms && *v < request.end_ms);
    let observation_state = if !state.supported {
        "unsupported"
    } else if !state.enabled {
        "disabled"
    } else if state.last_error.is_some() || (!state.running && intervals.is_empty()) {
        "unavailable"
    } else {
        "partial"
    };
    Ok(Day {
        date: request.date,
        start_ms: request.start_ms,
        end_ms: request.end_ms,
        device_id: state.device_id,
        observation_state,
        intervals,
        observed_ms,
        error: state.last_error,
        storage_scope: "local",
    })
}

/// Sanitized sampler input. Only a basename already matched against the saved allowlist
/// may reach `executable`; unknown source results must be represented as an error.
#[derive(Debug, Clone)]
pub(crate) struct Sample {
    pub utc_ms: i64,
    pub tick_ms: u64,
    pub awake_ms: u64,
    pub continuity: u64,
    pub executable: Option<String>,
    pub idle_ms: u64,
    pub unlocked: bool,
}

#[derive(Default, Clone)]
pub(crate) struct Reducer {
    previous: Option<Sample>,
    revision: Option<u64>,
}

impl Reducer {
    fn reset(&mut self) {
        self.previous = None;
        self.revision = None;
    }

    fn accept(&mut self, sample: Sample, config: &Status) -> Option<Interval> {
        if !config.enabled {
            self.reset();
            return None;
        }
        if self.revision != Some(config.revision) {
            self.previous = None;
        }
        self.revision = Some(config.revision);
        let active = sample.unlocked
            && sample.idle_ms < IDLE_LIMIT_MS
            && sample
                .executable
                .as_ref()
                .is_some_and(|name| config.selected_executables.contains(name));
        if !active {
            self.previous = None;
            return None;
        }
        let prior = self.previous.replace(sample.clone())?;
        let wall = sample.utc_ms.checked_sub(prior.utc_ms).filter(|v| *v > 0)? as u64;
        let tick = sample.tick_ms.checked_sub(prior.tick_ms)?;
        let awake = sample.awake_ms.checked_sub(prior.awake_ms)?;
        if wall > MAX_BRIDGE_MS
            || tick > MAX_BRIDGE_MS
            || awake > MAX_BRIDGE_MS
            || tick == 0
            || awake == 0
            || wall.abs_diff(tick) > CLOCK_TOLERANCE_MS
            || tick.abs_diff(awake) > CLOCK_TOLERANCE_MS
            || sample.continuity != prior.continuity
            || sample.executable != prior.executable
        {
            return None;
        }
        Some(Interval {
            id: Uuid::new_v4().to_string(),
            device_id: config.device_id.clone(),
            executable: sample.executable?,
            start_ms: prior.utc_ms,
            end_ms: sample.utc_ms,
        })
    }
}

fn persist_interval(conn: &Connection, interval: &Interval) -> Result<(), String> {
    let prior: Option<(String, i64)> = conn
        .query_row(
            "SELECT id,start_ms FROM personal_activity_intervals WHERE device_id=?1
         AND executable=?2 AND end_ms=?3 ORDER BY start_ms DESC LIMIT 1",
            params![interval.device_id, interval.executable, interval.start_ms],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(storage_error)?;
    if let Some((id, _)) = prior.filter(|(_, start)| {
        interval
            .end_ms
            .checked_sub(*start)
            .is_some_and(|span| (1..=CHUNK_MS).contains(&span))
    }) {
        conn.execute(
            "UPDATE personal_activity_intervals SET end_ms=?2 WHERE id=?1",
            params![id, interval.end_ms],
        )
        .map_err(storage_error)?;
    } else {
        conn.execute("INSERT INTO personal_activity_intervals(id,device_id,executable,start_ms,end_ms) VALUES(?1,?2,?3,?4,?5)",
            params![interval.id, interval.device_id, interval.executable, interval.start_ms, interval.end_ms]).map_err(storage_error)?;
    }
    Ok(())
}

/// A transaction serializes the sample with configuration changes: after disabling
/// returns successfully, no later sample from the old revision can be persisted.
fn tick(
    conn: &mut Connection,
    reducer: &mut Reducer,
    source: impl FnOnce(&[String]) -> Result<Sample, String>,
    supported: bool,
) -> Result<(), String> {
    let result = (|| -> Result<Reducer, String> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let config = read_status(&tx, supported, Utc::now().timestamp_millis())?;
        let mut pending = reducer.clone();
        if !config.enabled || !supported {
            pending.reset();
            return Ok(pending);
        }
        match source(&config.selected_executables) {
            Ok(sample) => {
                let at = sample.utc_ms;
                if let Some(interval) = pending.accept(sample, &config) {
                    persist_interval(&tx, &interval)?;
                }
                tx.execute("UPDATE personal_activity_config SET last_sample_ms=?1,last_error=NULL WHERE singleton=1", [at]).map_err(storage_error)?;
            }
            Err(_) => {
                pending.reset();
                tx.execute("UPDATE personal_activity_config SET last_sample_ms=NULL,last_error='personal_activity_source_unavailable' WHERE singleton=1", []).map_err(storage_error)?;
            }
        }
        tx.commit().map_err(storage_error)?;
        Ok(pending)
    })();
    match result {
        Ok(pending) => {
            *reducer = pending;
            Ok(())
        }
        Err(error) => {
            reducer.reset();
            Err(error)
        }
    }
}

/// Start once per interactive application process, after schema initialization.
/// No OS scheduled task, background service or collector outside this process.
#[cfg(windows)]
pub fn start(path: std::path::PathBuf) -> Result<(), String> {
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
        time::Duration,
    };
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::AcqRel) {
        return Err("personal_activity_already_started".into());
    }
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let spawned = std::thread::Builder::new().name("cicada-personal-activity".into()).spawn(move || {
        let opened = (|| -> Result<Connection, String> {
            let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(storage_error)?;
            conn.busy_timeout(Duration::from_secs(2)).map_err(storage_error)?;
            conn.execute("UPDATE personal_activity_config SET last_sample_ms=NULL,last_error=NULL WHERE singleton=1", []).map_err(storage_error)?;
            Ok(conn)
        })();
        let mut conn = match opened {
            Ok(conn) => { let _ = ready_tx.send(Ok(())); conn },
            Err(error) => { let _ = ready_tx.send(Err(error)); return; }
        };
        let mut reducer = Reducer::default();
        // Native hooks exist only during an explicitly enabled collection session.
        let mut observer: Option<windows::Observer> = None;
        loop {
            let enabled = status(&conn).is_ok_and(|s| s.enabled);
            if !enabled { observer = None; reducer.reset(); }
            let result = tick(&mut conn, &mut reducer, |allowlist| {
                if observer.is_none() { observer = Some(windows::Observer::new()?); }
                observer.as_mut().ok_or("personal_activity_source_unavailable")?.sample(allowlist)
            }, true);
            if result.is_err() { reducer.reset(); }
            // Out-of-context WinEvent callbacks require this thread's message loop.
            // Pump frequently so a foreground/desktop transition is not lost while idle.
            if observer.is_none() {
                std::thread::sleep(Duration::from_millis(SAMPLE_PERIOD_MS));
            } else {
                for _ in 0..SAMPLE_PERIOD_MS / 100 {
                    if let Some(observer) = observer.as_mut() { observer.pump(); }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    });
    if spawned.is_err() {
        STARTED.store(false, Ordering::Release);
        return Err("personal_activity_start_failed".into());
    }
    match ready_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => {
            STARTED.store(false, Ordering::Release);
            Err(error)
        }
        Err(_) => Err("personal_activity_start_unconfirmed".into()),
    }
}

#[cfg(not(windows))]
pub fn start(_: std::path::PathBuf) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
#[path = "../../tests/personal-activity/cases.rs"]
mod tests;
