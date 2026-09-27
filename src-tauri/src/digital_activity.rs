//! Local ActivityWatch connector and calendar projection.
//! Only aggregate app durations are retained; raw events never enter SQLite.

use chrono::{DateTime, Local, NaiveDate, Utc};
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use tauri::{Emitter, State};
use uuid::Uuid;

const SETTINGS_KEY: &str = "digital_activity_connections_v1";
const SECRET_SERVICE: &str = "app.hanni.mvp.activity";
const MAX_RESPONSE: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityConnection {
    pub id: String,
    pub label: String,
    pub port: u16,
    pub endpoint: String,
    pub enabled: bool,
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceStatus {
    id: String,
    label: String,
    source: String,
    endpoint: String,
    port: u16,
    enabled: bool,
    capabilities: Vec<String>,
    last_success: Option<String>,
    last_error: Option<String>,
    records: i64,
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
struct Bucket { #[serde(default)] id: String, #[serde(default)] client: String, #[serde(default)] r#type: String, #[serde(default)] hostname: String, #[serde(default)] events: Vec<Event> }

#[derive(Debug, Deserialize)]
struct Event { timestamp: String, duration: f64, data: Value }

#[derive(Debug, Clone)]
struct Aggregate { day: NaiveDate, foreground_seconds: i64, active_seconds: i64, apps: BTreeMap<String, i64> }

fn err(e: impl ToString) -> String { e.to_string() }

pub fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS digital_activity_status (device_id TEXT PRIMARY KEY, last_success TEXT, last_error TEXT, records INTEGER NOT NULL DEFAULT 0);")
        .map_err(err)
}

/// Starts the bounded one-minute poller. It owns its own read/write connection,
/// so HTTP work never holds the UI database mutex.
pub fn start_background(app: tauri::AppHandle) {
    std::thread::Builder::new().name("cicada-activity-import".into()).spawn(move || {
        loop {
            let _ = background_once(&app);
            std::thread::sleep(Duration::from_secs(60));
        }
    }).ok();
}

fn background_once(app: &tauri::AppHandle) -> Result<(), String> {
    let path = crate::app_data_dir(app)?.join("calendar.db");
    let mut conn = Connection::open(path).map_err(err)?;
    initialize(&conn)?;
    let configs = read_connections(&conn)?;
    let client = client()?;
    let today = Local::now().date_naive();
    let yesterday = today.pred_opt().unwrap_or(today);
    let mut changed = 0i64;
    for cfg in configs.into_iter().filter(|v| v.enabled) {
        let token = load_token(app, &cfg)?;
        match read_device(&client, &cfg, token.as_deref()) {
            Ok(values) => {
                let selected: Vec<_> = values.into_iter().filter(|v| v.day == today || v.day == yesterday).collect();
                changed += project(&mut conn, &cfg, &selected)?;
                conn.execute("INSERT INTO digital_activity_status(device_id,last_success,last_error,records) VALUES(?1,?2,NULL,?3) ON CONFLICT(device_id) DO UPDATE SET last_success=excluded.last_success,last_error=NULL,records=excluded.records", params![cfg.id,Utc::now().to_rfc3339(),selected.len() as i64]).map_err(err)?;
            }
            Err(error) => { conn.execute("INSERT INTO digital_activity_status(device_id,last_error) VALUES(?1,?2) ON CONFLICT(device_id) DO UPDATE SET last_error=excluded.last_error", params![cfg.id,error]).map_err(err)?; }
        }
    }
    if changed > 0 { let _ = app.emit("digital-activity-updated", json!({"changed": changed})); }
    Ok(())
}

fn read_connections(conn: &Connection) -> Result<Vec<ActivityConnection>, String> {
    let raw: Option<String> = conn.query_row("SELECT value FROM app_settings WHERE key=?1", [SETTINGS_KEY], |r| r.get(0)).optional().map_err(err)?;
    raw.map(|v| serde_json::from_str(&v).map_err(err)).unwrap_or(Ok(Vec::new()))
}

fn validate_endpoint(endpoint: &str, port: u16) -> Result<String, String> {
    let value = endpoint.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(value).map_err(|_| "digital_activity_invalid_endpoint")?;
    if parsed.scheme() != "http" || !matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost")) || parsed.username() != "" || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() || parsed.path() != "" && parsed.path() != "/" {
        return Err("digital_activity_loopback_only".into());
    }
    if let Some(explicit) = parsed.port() { if explicit != port { return Err("digital_activity_port_mismatch".into()); } }
    Ok(format!("http://127.0.0.1:{port}"))
}

fn client() -> Result<Client, String> {
    Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(5)).build().map_err(err)
}

fn fetch_json(client: &Client, cfg: &ActivityConnection, token: Option<&str>, path: &str) -> Result<Value, String> {
    let url = format!("{}{}", cfg.endpoint.trim_end_matches('/'), path);
    let mut request = client.get(url);
    if let Some(value) = token.filter(|v| !v.is_empty()) { request = request.bearer_auth(value); }
    let response = request.send().map_err(|_| "digital_activity_connection_failed")?;
    if !response.status().is_success() { return Err(format!("digital_activity_http_{}", response.status().as_u16())); }
    if response.content_length().unwrap_or(0) > MAX_RESPONSE as u64 { return Err("digital_activity_response_too_large".into()); }
    let mut bytes = Vec::new(); let mut stream = response;
    use std::io::Read;
    let mut chunk = [0u8; 16 * 1024];
    loop { let count = stream.read(&mut chunk).map_err(|_| "digital_activity_response_failed")?; if count == 0 { break; } if bytes.len() + count > MAX_RESPONSE { return Err("digital_activity_response_too_large".into()); } bytes.extend_from_slice(&chunk[..count]); }
    serde_json::from_slice(&bytes).map_err(|_| "digital_activity_invalid_response".into())
}

fn parse_timestamp(raw: &str) -> Result<DateTime<chrono::FixedOffset>, String> {
    DateTime::parse_from_rfc3339(raw).map_err(|_| "digital_activity_invalid_timestamp".into())
}

fn app_name(event: &Event, android: bool) -> Result<String, String> {
    let object = event.data.as_object().ok_or("digital_activity_invalid_event")?;
    if !android && (object.keys().any(|k| k != "app" && k != "title") || object.get("title").and_then(Value::as_str) != Some("excluded")) {
        return Err("digital_activity_unredacted_title".into());
    }
    if android && object.keys().any(|k| !matches!(k.as_str(), "app" | "package" | "classname")) { return Err("digital_activity_android_sensitive_fields".into()); }
    let key = object.get("app").and_then(Value::as_str).ok_or("digital_activity_missing_app")?;
    let clean = key.trim();
    if clean.is_empty() || clean.len() > 200 || clean.contains('\n') { return Err("digital_activity_invalid_app".into()); }
    Ok(clean.to_string())
}

fn merge(mut values: Vec<(f64, f64)>) -> Vec<(f64, f64)> { values.sort_by(|a,b| a.0.total_cmp(&b.0)); let mut out: Vec<(f64,f64)> = Vec::new(); for (a,b) in values { if let Some(last)=out.last_mut() { if a <= last.1 { last.1=last.1.max(b); continue; } } out.push((a,b)); } out }
fn allocate(events: &[(f64, f64, String)], allowed: &[(f64, f64)], lo: f64, hi: f64) -> BTreeMap<String, i64> {
    let mut bounds = vec![lo, hi];
    let clipped: Vec<_> = events.iter().filter_map(|(a, b, n)| {
        let x = (*a).max(lo).min(hi); let y = (*b).min(hi).max(lo);
        if y > x { bounds.push(x); bounds.push(y); Some((*a, *b, n)) } else { None }
    }).collect();
    let allow = merge(allowed.iter().filter_map(|(a,b)| { let x=(*a).max(lo).min(hi); let y=(*b).min(hi).max(lo); if y>x {Some((x,y))} else {None} }).collect());
    bounds.sort_by(|a,b| a.total_cmp(b)); let mut result=BTreeMap::new();
    for pair in bounds.windows(2) { let (a,b)=(pair[0],pair[1]); if b<=a || !allow.iter().any(|(x,y)| *x<b && *y>a) {continue;} if let Some((_,_,name))=clipped.iter().filter(|(x,y,_)| *x<=a && *y>a).max_by(|x,y| x.0.total_cmp(&y.0).then_with(||x.2.cmp(y.2))) { *result.entry((*name).clone()).or_default() += (b-a).round() as i64; } }
    result
}
fn aggregate(bucket_values: &[Bucket], android: bool) -> Result<Vec<Aggregate>, String> {
    let mut windows=Vec::<(f64,f64,String)>::new(); let mut active=Vec::<(f64,f64)>::new(); let mut away=Vec::<(f64,f64)>::new(); let mut dates=BTreeMap::<NaiveDate,bool>::new();
    for bucket in bucket_values { for event in &bucket.events { let start=parse_timestamp(&event.timestamp)?.timestamp() as f64; if !event.duration.is_finite() || event.duration<0.0 || event.duration>86400.0 {return Err("digital_activity_invalid_duration".into())} let end=start+event.duration; let start_day=DateTime::<Utc>::from_timestamp(start as i64,0).unwrap().with_timezone(&Local).date_naive(); let end_day=DateTime::<Utc>::from_timestamp(end as i64,0).unwrap().with_timezone(&Local).date_naive(); dates.insert(start_day,true); dates.insert(end_day,true); if bucket.r#type=="currentwindow" { windows.push((start,end,app_name(event,android)?)); } else { let data=event.data.as_object().ok_or("digital_activity_invalid_event")?; if data.keys().any(|k|k!="status") || !matches!(data.get("status").and_then(Value::as_str),Some("afk")|Some("not-afk")) {return Err("digital_activity_invalid_afk".into())} if data["status"]=="afk" {away.push((start,end))} else {active.push((start,end))} } } }
    let mut result=Vec::new(); for (day,_) in dates { let lo=day.and_hms_opt(0,0,0).unwrap().and_local_timezone(*Local::now().offset()).single().map(|v|v.timestamp() as f64).unwrap_or(0.0); let hi=day.succ_opt().unwrap_or(day).and_hms_opt(0,0,0).unwrap().and_local_timezone(*Local::now().offset()).single().map(|v|v.timestamp() as f64).unwrap_or(lo+86400.0); let foreground=allocate(&windows,&[(lo,hi)],lo,hi); let clip=|vals:&Vec<(f64,f64)>| vals.iter().filter_map(|(a,b)|{let x=(*a).max(lo).min(hi);let y=(*b).min(hi).max(lo);if y>x{Some((x,y))}else{None}}).collect::<Vec<_>>(); let available=merge(clip(&active)); let blocked=merge(clip(&away)); let allowed=available.into_iter().flat_map(|(a,b)|{let mut cuts=vec![(a,b)];for(c,d)in &blocked{cuts=cuts.into_iter().flat_map(|(x,y)|if *d<=x||*c>=y{vec![(x,y)]}else{let mut v=Vec::new();if x<*c{v.push((x,*c))}if *d<y{v.push((*d,y))}v}).collect()}cuts}).collect::<Vec<_>>(); let input=allocate(&windows,&allowed,lo,hi); if !foreground.is_empty(){result.push(Aggregate{day,foreground_seconds:foreground.values().sum(),active_seconds:input.values().sum(),apps:foreground});} }
    Ok(result)
}

fn quote_segment(value: &str) -> String { value.bytes().map(|b| if b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.' { format!("{}", b as char) } else { format!("%{:02X}", b) }).collect() }

fn read_device(client: &Client, cfg: &ActivityConnection, token: Option<&str>) -> Result<Vec<Aggregate>, String> {
    let raw = fetch_json(client, cfg, token, "/api/0/buckets")?;
    let object = raw.as_object().ok_or("digital_activity_invalid_buckets")?;
    if object.len() > 32 { return Err("digital_activity_too_many_buckets".into()); }
    let mut buckets = Vec::new();
    let mut seen_clients = std::collections::HashSet::new();
    let today = Local::now().date_naive(); let previous = today.pred_opt().unwrap_or(today);
    let local_start = previous.and_hms_opt(0,0,0).unwrap().and_local_timezone(*Local::now().offset()).single().map(|v| v.timestamp()).unwrap_or_else(|| Utc::now().timestamp()-86400);
    let local_end = today.succ_opt().unwrap_or(today).and_hms_opt(0,0,0).unwrap().and_local_timezone(*Local::now().offset()).single().map(|v| v.timestamp()).unwrap_or_else(|| Utc::now().timestamp());
    for (id, value) in object {
        let bucket: Bucket = serde_json::from_value(value.clone()).map_err(|_| "digital_activity_invalid_bucket")?;
        let expected = if cfg.source == "android" { "aw-android" } else { "aw-watcher-window" };
        if bucket.client != expected && bucket.client != "aw-watcher-afk" { continue; }
        if !seen_clients.insert(bucket.client.clone()) { return Err("digital_activity_duplicate_client_bucket".into()); }
        let bucket = Bucket { id: id.clone(), ..bucket };
        let path = format!("/api/0/buckets/{}/events?start={}&end={}&limit=100000", quote_segment(id), DateTime::<Utc>::from_timestamp(local_start,0).unwrap().to_rfc3339(), DateTime::<Utc>::from_timestamp(local_end,0).unwrap().to_rfc3339());
        let events = fetch_json(client, cfg, token, &path)?;
        let rows: Vec<Event> = serde_json::from_value(events).map_err(|_| "digital_activity_invalid_events")?;
        if rows.len() >= 100_000 { return Err("digital_activity_event_limit".into()); }
        buckets.push(Bucket { id: bucket.id.clone(), client: bucket.client.clone(), r#type: bucket.r#type.clone(), hostname: bucket.hostname.clone(), events: rows });
    }
    aggregate(&buckets, cfg.label.to_lowercase().contains("android"))
}

fn duration_label(seconds: i64) -> String { format!("{} ч {} мин", seconds / 3600, (seconds % 3600) / 60) }

fn project(conn: &mut Connection, cfg: &ActivityConnection, aggregates: &[Aggregate]) -> Result<i64, String> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
    let now = Utc::now().to_rfc3339();
    let mut changed = 0;
    for aggregate in aggregates {
        if aggregate.foreground_seconds <= 0 { continue; }
        let key = format!("digital-activity:{}:{}", cfg.id, aggregate.day);
        let mut detail = format!("Источник: ActivityWatch. Активность на экране: {}. Ввод/не-AFK: {}. Приложения:", duration_label(aggregate.foreground_seconds), duration_label(aggregate.active_seconds));
        for (app, seconds) in aggregate.apps.iter().take(100) { detail.push_str(&format!("\n{} — {}", app, duration_label(*seconds))); }
        let title = format!("Активность · {} · {}", cfg.label, duration_label(aggregate.foreground_seconds));
        let tags = json!(["digital-activity:v1", format!("digital-activity-device:{}", cfg.id), format!("digital-activity-day:{}", aggregate.day)]).to_string();
        changed += tx.execute("INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,tags,status) VALUES(?1,'event',?2,?3,?4,NULL,?5,0,1,?6,?6,'general','#7A8C5B',?7,'event') ON CONFLICT(id) DO UPDATE SET title=excluded.title,notes=excluded.notes,date=excluded.date,time=NULL,duration_minutes=excluded.duration_minutes,tags=excluded.tags,version=items.version+1,updated_at=excluded.updated_at WHERE items.title<>excluded.title OR items.notes<>excluded.notes OR items.date<>excluded.date OR items.duration_minutes<>excluded.duration_minutes OR items.tags<>excluded.tags", params![key,title,detail,aggregate.day.to_string(),(aggregate.foreground_seconds+59)/60,now,tags]).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(changed as i64)
}

fn load_token(app: &tauri::AppHandle, cfg: &ActivityConnection) -> Result<Option<String>, String> {
    let path = crate::app_data_dir(app)?.join("calendar.db");
    let raw = crate::mvp_sync::secrets::read_for(&path, SECRET_SERVICE)?;
    raw.map(|v| serde_json::from_str::<BTreeMap<String,String>>(&v).map_err(|_| "digital_activity_secret_invalid".into()).map(|m| m.get(&cfg.id).cloned())).transpose().map(|v| v.flatten())
}

fn save_token(app: &tauri::AppHandle, id: &str, token: &str) -> Result<(), String> {
    let path = crate::app_data_dir(app)?.join("calendar.db");
    let current = crate::mvp_sync::secrets::read_for(&path, SECRET_SERVICE)?.unwrap_or_else(|| "{}".into());
    let mut values: BTreeMap<String,String> = serde_json::from_str(&current).unwrap_or_default();
    if token.is_empty() { values.remove(id); } else { if token.len() > 4096 { return Err("digital_activity_secret_too_large".into()); } values.insert(id.to_string(), token.to_string()); }
    crate::mvp_sync::secrets::write_for(&path, SECRET_SERVICE, &serde_json::to_string(&values).map_err(err)?)
}

pub fn decorate(value: &mut Value, key: &str, tags: &str) {
    if key.starts_with("digital-activity:") { value["readonly"] = json!(true); value["source"] = json!("activity_watch"); value["activity"] = json!(true); }
    let _ = tags;
}

#[tauri::command(rename_all = "camelCase")]
pub fn digital_activity_get_connections(state: State<'_, crate::AppState>) -> Result<Value, String> { let conn = state.0.lock().map_err(|_| "database lock poisoned")?; let devices = read_connections(&conn)?; Ok(json!({"enabled": devices.iter().any(|v| v.enabled), "devices": devices})) }

#[tauri::command(rename_all = "camelCase")]
pub fn digital_activity_save_connection(input: SaveConnectionInput, app: tauri::AppHandle, state: State<'_, crate::AppState>) -> Result<Value, String> {
    if input.label.trim().is_empty() || input.label.len() > 100 || input.port == 0 { return Err("digital_activity_invalid_config".into()); }
    let endpoint = validate_endpoint(input.endpoint.as_deref().unwrap_or("http://127.0.0.1"), input.port)?;
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let source = input.source.unwrap_or_else(|| "windows".into());
    if source != "windows" && source != "android" { return Err("digital_activity_invalid_source".into()); }
    if let Some(token) = input.token.as_deref() { save_token(&app, &id, token)?; }
    let conn = state.0.lock().map_err(|_| "database lock poisoned")?;
    let mut list = read_connections(&conn)?;
    list.retain(|v| v.id != id);
    list.push(ActivityConnection { id: id.clone(), label: input.label.trim().into(), port: input.port, endpoint, enabled: input.enabled, source });
    conn.execute("INSERT INTO app_settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params![SETTINGS_KEY,serde_json::to_string(&list).map_err(err)?,Utc::now().to_rfc3339()]).map_err(err)?;
    Ok(json!({"id": id, "saved": true}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn digital_activity_status(state: State<'_, crate::AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(|_| "database lock poisoned")?;
    let list = read_connections(&conn)?;
    let mut devices = Vec::new();
    for cfg in list { let row: Option<(Option<String>,Option<String>,i64)> = conn.query_row("SELECT last_success,last_error,records FROM digital_activity_status WHERE device_id=?1",[&cfg.id],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(err)?; let (success,error,records)=row.unwrap_or((None,None,0)); devices.push(DeviceStatus{id:cfg.id,label:cfg.label,source:cfg.source,endpoint:cfg.endpoint,port:cfg.port,enabled:cfg.enabled,capabilities:vec!["aggregate_app_durations".into(),"foreground_and_active_seconds".into()],last_success:success,last_error:error,records}); }
    Ok(json!({"enabled": devices.iter().any(|d| d.enabled), "devices": devices}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn digital_activity_import_now(device_id: Option<String>, local_date: Option<String>, app: tauri::AppHandle, state: State<'_, crate::AppState>) -> Result<Value, String> {
    let requested = local_date.as_deref().map(|v| NaiveDate::parse_from_str(v, "%Y-%m-%d").map_err(|_| "digital_activity_invalid_date" )).transpose()?;
    let configs = { let conn = state.0.lock().map_err(|_| "database lock poisoned")?; read_connections(&conn)? };
    let client = client()?; let mut imported=0; let mut changed=0; let mut errors=Vec::new(); let mut days=Vec::new();
    for cfg in configs.into_iter().filter(|v| v.enabled && device_id.as_deref().map_or(true, |id| id == v.id)) {
        let token = load_token(&app,&cfg)?;
        match read_device(&client,&cfg,token.as_deref()) {
            Ok(aggregates) => { let selected: Vec<_> = aggregates.into_iter().filter(|a| requested.map_or(true, |d| a.day == d)).collect(); changed += {let mut conn=state.0.lock().map_err(|_| "database lock poisoned")?; project(&mut conn,&cfg,&selected)?}; imported += selected.len() as i64; days.extend(selected.iter().map(|a| a.day.to_string())); let conn=state.0.lock().map_err(|_| "database lock poisoned")?; conn.execute("INSERT INTO digital_activity_status(device_id,last_success,last_error,records) VALUES(?1,?2,NULL,?3) ON CONFLICT(device_id) DO UPDATE SET last_success=excluded.last_success,last_error=NULL,records=excluded.records",params![cfg.id,Utc::now().to_rfc3339(),imported]).map_err(err)?; },
            Err(e) => { errors.push(json!({"deviceId":cfg.id,"error":e})); let conn=state.0.lock().map_err(|_| "database lock poisoned")?; conn.execute("INSERT INTO digital_activity_status(device_id,last_error) VALUES(?1,?2) ON CONFLICT(device_id) DO UPDATE SET last_error=excluded.last_error",params![cfg.id,e]).map_err(err)?; }
        }
    }
    if changed > 0 { let _ = app.emit("digital-activity-updated", json!({"changed": changed, "days": days})); }
    Ok(json!({"imported":imported,"changed":changed,"skipped":0,"errors":errors,"days":days}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_unredacted_windows_title() { let event=Event{timestamp:"2026-01-01T00:00:00+00:00".into(),duration:2.0,data:json!({"app":"Browser","title":"secret"})}; assert_eq!(app_name(&event,false).unwrap_err(),"digital_activity_unredacted_title"); }
    #[test] fn android_requires_whitelisted_app_and_rejects_sensitive_fields() { let event=Event{timestamp:"2026-01-01T00:00:00+00:00".into(),duration:2.0,data:json!({"app":"browser","classname":"Secret","url":"https://private"})}; assert!(app_name(&event,true).is_err()); assert_eq!(app_name(&Event{timestamp:"2026-01-01T00:00:00+00:00".into(),duration:2.0,data:json!({"app":"browser","classname":"Secret"})},true).unwrap(),"browser"); assert!(app_name(&Event{timestamp:"2026-01-01T00:00:00+00:00".into(),duration:2.0,data:json!({"package":"browser"})},true).is_err()); }
    #[test] fn aggregate_separates_days_and_apps() { let b=Bucket{id:"x".into(),client:"aw-watcher-window".into(),r#type:"currentwindow".into(),hostname:String::new(),events:vec![Event{timestamp:"2026-01-01T23:59:00+00:00".into(),duration:60.0,data:json!({"app":"A","title":"excluded"})},Event{timestamp:"2026-01-02T00:00:00+00:00".into(),duration:120.0,data:json!({"app":"B","title":"excluded"})}]}; let rows=aggregate(&[b],false).unwrap(); assert!(rows.len()>=1); assert_eq!(rows.iter().map(|x|x.foreground_seconds).sum::<i64>(),180); }
    #[test] fn endpoint_is_loopback_only() { assert!(validate_endpoint("https://example.com",5600).is_err()); assert!(validate_endpoint("http://127.0.0.1",5600).is_ok()); }
    #[test] fn projection_is_idempotent_and_does_not_create_zero_events() {
        let conn = Connection::open_in_memory().unwrap();
        crate::init_schema(&conn).unwrap();
        let mut conn = conn;
        let cfg = ActivityConnection { id: "pc".into(), label: "ПК".into(), port: 5600, endpoint: "http://127.0.0.1:5600".into(), enabled: true, source: "activitywatch".into() };
        let aggregate = Aggregate { day: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(), foreground_seconds: 120, active_seconds: 60, apps: BTreeMap::from([("Browser".into(), 120)]) };
        assert_eq!(project(&mut conn, &cfg, &[aggregate.clone()]).unwrap(), 1);
        let first: i64 = conn.query_row("SELECT version FROM items WHERE id='digital-activity:pc:2026-01-01'", [], |r| r.get(0)).unwrap();
        assert_eq!(project(&mut conn, &cfg, &[aggregate]).unwrap(), 0);
        let second: i64 = conn.query_row("SELECT version FROM items WHERE id='digital-activity:pc:2026-01-01'", [], |r| r.get(0)).unwrap();
        assert_eq!(first, second);
        assert_eq!(conn.query_row("SELECT count(*) FROM items WHERE id LIKE 'digital-activity:%' AND duration_minutes=0", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
}
