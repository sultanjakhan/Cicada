//! Device-local day close/plan ledger. Native tasks and timeline remain authoritative.
use crate::AppState;
use chrono::{DateTime, FixedOffset, Local, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use tauri::State;

pub(crate) const KEY: &str = "calendar_day_lifecycle_local_v1";
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Day {
    revision: u64,
    closed: bool,
    summaries: Vec<Value>,
    plan_ids: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    version: u32,
    days: BTreeMap<String, Day>,
    operations: BTreeMap<String, Receipt>,
}
impl Default for Ledger {
    fn default() -> Self {
        Self {
            version: 1,
            days: BTreeMap::new(),
            operations: BTreeMap::new(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Request {
    operation_id: String,
    action: String,
    date: String,
    local_date: String,
    offset_minutes: i32,
    token: String,
    task_ids: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    request: Request,
    result: Value,
}
#[derive(Clone)]
struct Clock {
    date: String,
    offset: i32,
    utc: DateTime<Utc>,
}
impl Clock {
    fn now() -> Self {
        let local = Local::now();
        Self {
            date: local.format("%Y-%m-%d").to_string(),
            offset: local.offset().local_minus_utc() / 60,
            utc: local.with_timezone(&Utc),
        }
    }
}
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|_| "calendar_day_storage_error".into())
}
fn load(conn: &Connection) -> Result<Ledger, String> {
    let raw = sql(conn
        .query_row("SELECT value FROM ui_state WHERE key=?1", [KEY], |r| {
            r.get::<_, String>(0)
        })
        .optional())?;
    let ledger: Ledger = match raw {
        None => Ledger::default(),
        Some(s) => serde_json::from_str(&s).map_err(|_| "calendar_day_invalid_ledger")?,
    };
    if ledger.version != 1 {
        return Err("calendar_day_unknown_schema".into());
    }
    for (date, day) in &ledger.days {
        crate::validate_date(date)?;
        if day.plan_ids.iter().collect::<BTreeSet<_>>().len() != day.plan_ids.len() {
            return Err("calendar_day_invalid_ledger".into());
        }
    }
    Ok(ledger)
}
fn save(conn: &Connection, ledger: &Ledger, clock: &Clock) -> Result<(), String> {
    let raw = serde_json::to_string(ledger).map_err(|_| "calendar_day_invalid_ledger")?;
    sql(conn.execute("INSERT INTO ui_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",params![KEY,raw,clock.utc.to_rfc3339()]))?;
    Ok(())
}
fn timers(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut q=sql(conn.prepare("SELECT t.id,t.source_type,t.source_id,t.created_at,t.updated_at,t.date,t.start_time,i.title,i.version FROM timeline_blocks t LEFT JOIN items i ON t.source_type IN ('note','event') AND i.id=t.source_id WHERE t.is_active=1 AND t.source_type IN ('note','event','schedule') ORDER BY t.id"))?;
    let rows=sql(q.query_map([],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"source_type":r.get::<_,String>(1)?,"source_id":r.get::<_,String>(2)?,"created_at":r.get::<_,String>(3)?,"updated_at":r.get::<_,String>(4)?,"date":r.get::<_,String>(5)?,"start_time":r.get::<_,String>(6)?,"title":r.get::<_,Option<String>>(7)?,"source_version":r.get::<_,Option<i64>>(8)?}))))?;
    let mut rows: Vec<Value> = sql(rows.collect())?;
    for row in &mut rows {
        if row["source_type"] == "schedule" {
            if let Some(title) = crate::calendar_compat::day_timer_title(
                conn,
                row["source_id"]
                    .as_str()
                    .ok_or("calendar_day_invalid_timer")?,
            ) {
                row["title"] = json!(title);
            }
        }
    }
    Ok(rows)
}
fn candidates(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut q=sql(conn.prepare("SELECT id,title,date,version FROM items WHERE kind='task' AND status='task' AND archived=0 AND completed=0 ORDER BY id"))?;
    let rows=sql(q.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"deadline":r.get::<_,Option<String>>(2)?,"version":r.get::<_,i64>(3)?}))))?;
    sql(rows.collect())
}
fn next_date(date: &str) -> Result<String, String> {
    crate::validate_date(date)?;
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.succ_opt())
        .map(|d| d.format("%Y-%m-%d").to_string())
        .ok_or("calendar_day_invalid_date".into())
}
fn snapshot(
    conn: &Connection,
    ledger: &Ledger,
    date: &str,
    clock: &Clock,
) -> Result<Value, String> {
    crate::validate_date(date)?;
    let next = next_date(date)?;
    let day = ledger.days.get(date).cloned().unwrap_or_default();
    let next_day = ledger.days.get(&next).cloned().unwrap_or_default();
    let blocks = timers(conn)?;
    let tasks = candidates(conn)?;
    // No ticking duration in the token: time passing alone must not stale a preview.
    let signature = json!({"date":date,"local_date":clock.date,"offset_minutes":clock.offset,"day":day,"next_day":next_day,"active_blocks":blocks,"tasks":tasks});
    let token = hex::encode(Sha256::digest(
        serde_json::to_vec(&signature).map_err(|_| "calendar_day_invalid_snapshot")?,
    ));
    let mut shown = blocks;
    for row in &mut shown {
        let began = DateTime::parse_from_rfc3339(
            row["created_at"]
                .as_str()
                .ok_or("calendar_day_invalid_timer")?,
        )
        .map_err(|_| "calendar_day_invalid_timer")?;
        row["seconds"] = json!(clock.utc.signed_duration_since(began).num_seconds().max(0));
    }
    Ok(
        json!({"date":date,"local_date":clock.date,"offset_minutes":clock.offset,"next_date":next,"token":token,"day":day,"next_day":next_day,"active_blocks":shown,"candidates":tasks,"scope":"device_local","history":ledger.days.iter().filter(|(_,d)|!d.summaries.is_empty()).map(|(date,day)|json!({"date":date,"closed":day.closed,"summaries":day.summaries})).collect::<Vec<_>>()}),
    )
}
fn commit(conn: &mut Connection, request: Request, clock: &Clock) -> Result<Value, String> {
    uuid::Uuid::parse_str(&request.operation_id).map_err(|_| "calendar_day_invalid_operation")?;
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let mut ledger = load(&tx)?;
    // Retry remains valid after a restart, midnight, another operation, or reopen.
    if let Some(receipt) = ledger.operations.get(&request.operation_id) {
        return if receipt.request == request {
            Ok(receipt.result.clone())
        } else {
            Err("calendar_day_operation_conflict".into())
        };
    }
    if request.local_date != clock.date || request.offset_minutes != clock.offset {
        return Err("calendar_day_context_changed".into());
    }
    let preview = snapshot(&tx, &ledger, &request.date, clock)?;
    if preview["token"] != request.token {
        return Err("calendar_day_stale_preview".into());
    }
    if !request.task_ids.is_empty() && request.action != "plan" {
        return Err("calendar_day_invalid_selection".into());
    }
    let mut target = request.date.clone();
    let result = match request.action.as_str() {
        "close" => {
            if request.date != clock.date {
                return Err("calendar_day_context_changed".into());
            }
            if ledger.days.get(&target).is_some_and(|d| d.closed) {
                return Err("calendar_day_already_closed".into());
            }
            let blocks = preview["active_blocks"]
                .as_array()
                .ok_or("calendar_day_invalid_snapshot")?;
            let offset =
                FixedOffset::east_opt(clock.offset * 60).ok_or("calendar_day_invalid_offset")?;
            for row in blocks {
                let id = row["id"].as_i64().ok_or("calendar_day_invalid_timer")?;
                let seconds = row["seconds"]
                    .as_i64()
                    .ok_or("calendar_day_invalid_timer")?;
                if sql(tx.execute("UPDATE timeline_blocks SET end_time=?1,duration_minutes=?2,duration_seconds=?3,is_active=0,updated_at=?4 WHERE id=?5 AND is_active=1",params![clock.utc.with_timezone(&offset).format("%H:%M:%S").to_string(),seconds/60,seconds,clock.utc.to_rfc3339(),id]))?!=1 {return Err("calendar_day_stale_preview".into())}
            }
            let summary = json!({"operation_id":request.operation_id,"date":target,"offset_minutes":clock.offset,"closed_at_utc":clock.utc.to_rfc3339(),"paused_blocks":blocks});
            let day = ledger.days.entry(target.clone()).or_default();
            day.closed = true;
            day.revision += 1;
            day.summaries.push(summary.clone());
            json!({"operation_id":request.operation_id,"action":"close","date":target,"day":day,"summary":summary})
        }
        "reopen" => {
            let day = ledger
                .days
                .get_mut(&target)
                .ok_or("calendar_day_not_closed")?;
            if !day.closed {
                return Err("calendar_day_not_closed".into());
            }
            day.closed = false;
            day.revision += 1;
            json!({"operation_id":request.operation_id,"action":"reopen","date":target,"day":day})
        }
        "plan" => {
            if request.date != clock.date {
                return Err("calendar_day_context_changed".into());
            }
            let selected = request.task_ids.iter().collect::<BTreeSet<_>>();
            if selected.len() != request.task_ids.len() || selected.len() > 500 {
                return Err("calendar_day_invalid_selection".into());
            }
            let available = preview["candidates"]
                .as_array()
                .ok_or("calendar_day_invalid_snapshot")?
                .iter()
                .filter_map(|t| t["id"].as_str())
                .collect::<BTreeSet<_>>();
            if selected.iter().any(|id| !available.contains(id.as_str())) {
                return Err("calendar_day_task_unavailable".into());
            }
            target = preview["next_date"]
                .as_str()
                .ok_or("calendar_day_invalid_date")?
                .to_string();
            let day = ledger.days.entry(target.clone()).or_default();
            day.plan_ids = request.task_ids.clone();
            day.revision += 1;
            json!({"operation_id":request.operation_id,"action":"plan","date":target,"day":day})
        }
        _ => return Err("calendar_day_invalid_action".into()),
    };
    ledger.operations.insert(
        request.operation_id.clone(),
        Receipt {
            request,
            result: result.clone(),
        },
    );
    save(&tx, &ledger, clock)?;
    sql(tx.commit())?;
    Ok(result)
}
#[tauri::command]
pub fn read_calendar_day(
    date: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(|_| "calendar_day_lock")?;
    let clock = Clock::now();
    let tx = sql(conn.unchecked_transaction())?;
    let ledger = load(&tx)?;
    let result = snapshot(&tx, &ledger, date.as_deref().unwrap_or(&clock.date), &clock)?;
    sql(tx.commit())?;
    Ok(result)
}
#[tauri::command]
pub fn commit_calendar_day_action(
    input: Request,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(|_| "calendar_day_lock")?;
    commit(&mut conn, input, &Clock::now())
}
fn operation_result(conn: &Connection, input: &Request) -> Result<Option<Value>, String> {
    match load(conn)?.operations.get(&input.operation_id) {
        Some(receipt) if receipt.request == *input => Ok(Some(receipt.result.clone())),
        Some(_) => Err("calendar_day_operation_conflict".into()),
        None => Ok(None),
    }
}
#[tauri::command]
pub fn read_calendar_day_operation(
    input: Request,
    state: State<'_, AppState>,
) -> Result<Option<Value>, String> {
    let conn = state.0.lock().map_err(|_| "calendar_day_lock")?;
    operation_result(&conn, &input)
}

#[cfg(test)]
#[path = "calendar_day_lifecycle_tests.rs"]
mod tests;
