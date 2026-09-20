use chrono::{NaiveDate, NaiveTime, Utc};
use rusqlite::{
    backup::{Backup, StepResult},
    params, Connection, OptionalExtension,
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Manager, State};
use uuid::Uuid;

mod app_updates;
mod update_background;
mod update_journal;
mod calendar_compat;
mod desktop_launch;
mod mvp_sync;
mod mvp_sync_crypto;
mod mvp_sync_db;
#[cfg(test)]
mod workspace_ipc_tests;

const SCHEMA_VERSION: i64 = 5;

pub struct AppState(Mutex<Connection>);
pub struct AppInstanceLock(std::fs::File);

fn acquire_instance_lock(data_dir: &std::path::Path) -> Result<AppInstanceLock, String> {
    let file = std::fs::OpenOptions::new().read(true).write(true).create(true)
        .open(data_dir.join("hanni-mvp.instance.lock"))
        .map_err(|_| fail("open application instance lock"))?;
    file.try_lock().map_err(|_| fail("Hanni MVP is already open for this profile"))?;
    Ok(AppInstanceLock(file))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub notes: String,
    pub date: Option<String>,
    pub time: Option<String>,
    pub duration_minutes: i64,
    pub completed: bool,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct ItemInput {
    pub id: Option<String>,
    pub expected_version: Option<i64>,
    pub kind: String,
    pub title: String,
    pub notes: String,
    pub date: Option<String>,
    pub time: Option<String>,
    pub duration_minutes: i64,
    pub completed: bool,
}

fn fail(message: impl Into<String>) -> String {
    message.into()
}

fn validate_date(value: &str) -> Result<(), String> {
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| fail("date must be a real YYYY-MM-DD date"))?;
    if parsed.format("%Y-%m-%d").to_string() != value {
        return Err(fail("date must be a real YYYY-MM-DD date"));
    }
    Ok(())
}

fn validate_time(value: &str) -> Result<(), String> {
    let parsed =
        NaiveTime::parse_from_str(value, "%H:%M").map_err(|_| fail("time must be HH:MM"))?;
    if parsed.format("%H:%M").to_string() != value {
        return Err(fail("time must be HH:MM"));
    }
    Ok(())
}

fn validate(input: &ItemInput) -> Result<(), String> {
    if !matches!(input.kind.as_str(), "task" | "event") {
        return Err(fail("kind must be task or event"));
    }
    if input.title.trim().is_empty() || input.title.trim().chars().count() > 200 {
        return Err(fail("title must contain 1 to 200 characters"));
    }
    if input.notes.chars().count() > 10_000 {
        return Err(fail("notes must contain at most 10000 characters"));
    }
    if let Some(date) = &input.date {
        validate_date(date)?;
    }
    if let Some(time) = &input.time {
        validate_time(time)?;
        if input.date.is_none() {
            return Err(fail("time requires a date"));
        }
    }
    if !(1..=1440).contains(&input.duration_minutes) {
        return Err(fail("duration_minutes must be between 1 and 1440"));
    }
    if input.kind == "event" && input.date.is_none() {
        return Err(fail("event requires a date"));
    }
    if input.kind == "event" && input.completed {
        return Err(fail("event cannot be completed"));
    }
    Ok(())
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| fail(format!("read database version: {e}")))?;
    if version > SCHEMA_VERSION {
        return Err(fail("database was created by a newer Hanni MVP version"));
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('task','event')),
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        date TEXT,
        time TEXT,
        duration_minutes INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS items_calendar_order ON items(date, time, created_at);",
    )
    .map_err(|e| fail(format!("initialize database schema: {e}")))?;
    // v2 is additive: existing MVP records retain their ids and versions.
    if version < 2 {
        let transaction = conn
            .unchecked_transaction()
            .map_err(|e| fail(format!("begin v2 migration: {e}")))?;
        let columns: Vec<String> = transaction
            .prepare("PRAGMA table_info(items)")
            .map_err(|e| fail(format!("inspect items schema: {e}")))?
            .query_map([], |row| row.get(1))
            .map_err(|e| fail(format!("inspect items schema: {e}")))?
            .collect::<Result<_, _>>()
            .map_err(|e| fail(format!("inspect items schema: {e}")))?;
        for (name, declaration) in [
            ("category", "TEXT NOT NULL DEFAULT 'general'"),
            ("color", "TEXT NOT NULL DEFAULT '#9B9B9B'"),
            ("priority", "INTEGER NOT NULL DEFAULT 0"),
            ("archived", "INTEGER NOT NULL DEFAULT 0"),
            ("tags", "TEXT NOT NULL DEFAULT ''"),
            ("content_blocks", "TEXT"),
            ("status", "TEXT NOT NULL DEFAULT 'task'"),
        ] {
            if !columns.iter().any(|column| column == name) {
                transaction
                    .execute_batch(&format!(
                        "ALTER TABLE items ADD COLUMN {name} {declaration};"
                    ))
                    .map_err(|e| fail(format!("migrate items: {e}")))?;
            }
        }
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS event_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS calendar_goals (id TEXT PRIMARY KEY, title TEXT NOT NULL, target_value REAL NOT NULL DEFAULT 1, current_value REAL, unit TEXT NOT NULL DEFAULT '', deadline TEXT, goal_kind TEXT NOT NULL DEFAULT 'goal', description TEXT NOT NULL DEFAULT '', criteria TEXT NOT NULL DEFAULT '', parent_goal_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS calendar_task_goals (source_type TEXT NOT NULL, source_id TEXT NOT NULL, goal_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(source_type, source_id));
          CREATE TABLE IF NOT EXISTS ui_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS timeline_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, source_id TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT, duration_minutes INTEGER NOT NULL DEFAULT 0, duration_seconds INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 0, completion_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);")
          .map_err(|e| fail(format!("create calendar v2 tables: {e}")))?;
        transaction
            .pragma_update(None, "user_version", 2)
            .map_err(|e| fail(format!("write database version: {e}")))?;
        transaction
            .commit()
            .map_err(|e| fail(format!("commit v2 migration: {e}")))?;
    }
    if version < 3 {
        let transaction = conn
            .unchecked_transaction()
            .map_err(|e| fail(format!("begin v3 migration: {e}")))?;
        if transaction
            .prepare("SELECT status FROM items LIMIT 1")
            .is_err()
        {
            transaction
                .execute(
                    "ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'task'",
                    [],
                )
                .map_err(|e| fail(format!("migrate item status: {e}")))?;
        }
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);")
            .map_err(|e| fail(format!("create app settings: {e}")))?;
        transaction
            .pragma_update(None, "user_version", 3)
            .map_err(|e| fail(format!("write database version: {e}")))?;
        transaction
            .commit()
            .map_err(|e| fail(format!("commit v3 migration: {e}")))?;
    }
    // v4 stores exact stopped-block duration without changing legacy minute values.
    if version < 4 {
        let transaction = conn
            .unchecked_transaction()
            .map_err(|e| fail(format!("begin v4 migration: {e}")))?;
        let columns: Vec<String> = transaction
            .prepare("PRAGMA table_info(timeline_blocks)")
            .map_err(|e| fail(format!("inspect timeline schema: {e}")))?
            .query_map([], |row| row.get(1))
            .map_err(|e| fail(format!("inspect timeline schema: {e}")))?
            .collect::<Result<_, _>>()
            .map_err(|e| fail(format!("inspect timeline schema: {e}")))?;
        if !columns.iter().any(|column| column == "duration_seconds") {
            transaction
                .execute_batch("ALTER TABLE timeline_blocks ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 0;")
                .map_err(|e| fail(format!("migrate timeline seconds: {e}")))?;
        }
        transaction
            .pragma_update(None, "user_version", 4)
            .map_err(|e| fail(format!("write database version: {e}")))?;
        transaction
            .commit()
            .map_err(|e| fail(format!("commit v4 migration: {e}")))?;
    }
    conn.execute("INSERT OR IGNORE INTO event_categories(id,name,color,icon,sort_order,created_at) VALUES('general','general','#9B9B9B','',0,?1)", [Utc::now().to_rfc3339()])
        .map_err(|e| fail(format!("seed generic category: {e}")))?;
    mvp_sync_db::initialize(conn)?;
    Ok(())
}

fn row_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<Item> {
    Ok(Item {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        notes: row.get(3)?,
        date: row.get(4)?,
        time: row.get(5)?,
        duration_minutes: row.get(6)?,
        completed: row.get::<_, i64>(7)? != 0,
        version: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn get_item(conn: &Connection, id: &str) -> Result<Item, String> {
    conn.query_row("SELECT id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at FROM items WHERE id=?1", [id], row_item)
        .optional().map_err(|e| fail(format!("read item: {e}")))?.ok_or_else(|| fail("item not found"))
}

fn list(conn: &Connection) -> Result<Vec<Item>, String> {
    let mut statement = conn.prepare("SELECT id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at FROM items ORDER BY date IS NULL, date, time IS NULL, time, created_at, id")
        .map_err(|e| fail(format!("list items: {e}")))?;
    let rows = statement
        .query_map([], row_item)
        .map_err(|e| fail(format!("list items: {e}")))?;
    let items = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| fail(format!("read item row: {e}")))?;
    Ok(items)
}

fn save(conn: &mut Connection, input: ItemInput) -> Result<Item, String> {
    validate(&input)?;
    let title = input.title.trim().to_string();
    let now = Utc::now().to_rfc3339();
    let transaction = conn
        .transaction()
        .map_err(|e| fail(format!("begin save: {e}")))?;
    let id = match input.id.as_deref() {
        None | Some("") => {
            if input.expected_version.is_some() {
                return Err(fail("new item cannot have expected_version"));
            }
            let id = Uuid::new_v4().to_string();
            transaction.execute("INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,?9,?9)",
                params![id, input.kind, title, input.notes, input.date, input.time, input.duration_minutes, input.completed as i64, now])
                .map_err(|e| fail(format!("create item: {e}")))?;
            id
        }
        Some(id) => {
            let expected = input
                .expected_version
                .ok_or_else(|| fail("updating an item requires expected_version"))?;
            let changed = transaction.execute("UPDATE items SET kind=?1,title=?2,notes=?3,date=?4,time=?5,duration_minutes=?6,completed=?7,version=version+1,updated_at=?8 WHERE id=?9 AND version=?10",
                params![input.kind, title, input.notes, input.date, input.time, input.duration_minutes, input.completed as i64, now, id, expected])
                .map_err(|e| fail(format!("update item: {e}")))?;
            if changed == 0 {
                let exists: bool = transaction
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM items WHERE id=?1)",
                        [id],
                        |row| row.get(0),
                    )
                    .map_err(|e| fail(format!("check item: {e}")))?;
                return Err(if exists {
                    fail("item changed elsewhere; reload before saving")
                } else {
                    fail("item not found")
                });
            }
            id.to_string()
        }
    };
    let item = get_item(&transaction, &id)?;
    transaction
        .commit()
        .map_err(|e| fail(format!("commit save: {e}")))?;
    Ok(item)
}

fn complete(
    conn: &mut Connection,
    id: &str,
    expected_version: i64,
    completed: bool,
) -> Result<Item, String> {
    let transaction = conn
        .transaction()
        .map_err(|e| fail(format!("begin completion: {e}")))?;
    let changed = transaction.execute("UPDATE items SET completed=?1,version=version+1,updated_at=?2 WHERE id=?3 AND version=?4 AND kind='task'", params![completed as i64, Utc::now().to_rfc3339(), id, expected_version])
        .map_err(|e| fail(format!("set completed: {e}")))?;
    if changed == 0 {
        let existing = get_item(&transaction, id)?;
        if existing.kind != "task" {
            return Err(fail("only tasks can be completed"));
        }
        return Err(fail("item changed elsewhere; reload before completing"));
    }
    let item = get_item(&transaction, id)?;
    transaction
        .commit()
        .map_err(|e| fail(format!("commit completion: {e}")))?;
    Ok(item)
}

fn remove(conn: &mut Connection, id: &str, expected_version: i64) -> Result<(), String> {
    let transaction = conn
        .transaction()
        .map_err(|e| fail(format!("begin delete: {e}")))?;
    let changed = transaction
        .execute(
            "DELETE FROM items WHERE id=?1 AND version=?2",
            params![id, expected_version],
        )
        .map_err(|e| fail(format!("delete item: {e}")))?;
    if changed == 0 {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM items WHERE id=?1)",
                [id],
                |row| row.get(0),
            )
            .map_err(|e| fail(format!("check item: {e}")))?;
        return Err(if exists {
            fail("item changed elsewhere; reload before deleting")
        } else {
            fail("item not found")
        });
    }
    transaction
        .commit()
        .map_err(|e| fail(format!("commit delete: {e}")))
}

fn backup(conn: &Connection, data_dir: &Path) -> Result<String, String> {
    let backups = data_dir.join("backups");
    std::fs::create_dir_all(&backups).map_err(|e| fail(format!("create backup directory: {e}")))?;
    let destination = backups.join(format!(
        "calendar-{}-{}.db",
        Utc::now().format("%Y%m%dT%H%M%SZ"),
        Uuid::new_v4()
    ));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|e| fail(format!("reserve backup destination: {e}")))?;
    let copied = (|| -> Result<(), String> {
        let mut output = Connection::open(&destination)
            .map_err(|e| fail(format!("open backup destination: {e}")))?;
        let backup =
            Backup::new(conn, &mut output).map_err(|e| fail(format!("start backup: {e}")))?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if Instant::now() >= deadline {
                return Err(fail("backup timed out"));
            }
            match backup
                .step(64)
                .map_err(|e| fail(format!("write backup: {e}")))?
            {
                StepResult::Done => break,
                StepResult::More | StepResult::Busy | StepResult::Locked => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                _ => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        drop(backup);
        let integrity: String = output
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|e| fail(format!("verify backup: {e}")))?;
        if integrity != "ok" {
            return Err(fail("backup integrity check failed"));
        }
        Ok(())
    })();
    if let Err(error) = copied {
        let _ = std::fs::remove_file(&destination);
        return Err(error);
    }
    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(debug_assertions)]
fn debug_data_dir(raw: Option<std::ffi::OsString>, standard: PathBuf) -> Result<PathBuf, String> {
    let Some(raw) = raw else {
        return Ok(standard);
    };
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(fail("HANNI_MVP_DATA_DIR must be an absolute path"));
    }
    let legacy_documents = dirs_like_legacy_documents_path();
    let legacy_app_data = standard.parent().unwrap_or(&standard).join("Hanni");
    if path == legacy_documents || path == legacy_app_data {
        return Err(fail(
            "HANNI_MVP_DATA_DIR must not point to legacy Hanni data",
        ));
    }
    Ok(path)
}

#[cfg(debug_assertions)]
fn dirs_like_legacy_documents_path() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join("Documents")
        .join("Hanni")
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let standard = app
        .path()
        .app_data_dir()
        .map_err(|e| fail(format!("resolve app data directory: {e}")))?;
    #[cfg(debug_assertions)]
    let directory = debug_data_dir(std::env::var_os("HANNI_MVP_DATA_DIR"), standard)?;
    #[cfg(not(debug_assertions))]
    let directory = standard;
    std::fs::create_dir_all(&directory)
        .map_err(|e| fail(format!("create app data directory: {e}")))?;
    Ok(directory)
}

#[tauri::command]
fn list_items(state: State<'_, AppState>) -> Result<Vec<Item>, String> {
    let conn = state.0.lock().map_err(|_| fail("database lock poisoned"))?;
    list(&conn)
}

#[tauri::command(rename_all = "camelCase")]
fn save_item(input: ItemInput, state: State<'_, AppState>) -> Result<Item, String> {
    let mut conn = state.0.lock().map_err(|_| fail("database lock poisoned"))?;
    save(&mut conn, input)
}

#[tauri::command(rename_all = "camelCase")]
fn set_completed(
    id: String,
    expected_version: i64,
    completed: bool,
    state: State<'_, AppState>,
) -> Result<Item, String> {
    let mut conn = state.0.lock().map_err(|_| fail("database lock poisoned"))?;
    complete(&mut conn, &id, expected_version, completed)
}

#[tauri::command(rename_all = "camelCase")]
fn delete_item(
    id: String,
    expected_version: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state.0.lock().map_err(|_| fail("database lock poisoned"))?;
    remove(&mut conn, &id, expected_version)
}

#[tauri::command]
fn create_backup(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.0.lock().map_err(|_| fail("database lock poisoned"))?;
    backup(&conn, &app_data_dir(&app)?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let options =
        desktop_launch::Options::from_env().unwrap_or_else(|_| desktop_launch::fail_and_exit());
    let mut context = tauri::generate_context!();
    options.apply_context(&mut context);
    let startup_options = options.clone();
    let builder = tauri::Builder::default();
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let built = builder
        .plugin(hanni_mvp_android_installer::init())
        .manage(app_updates::UpdateState::default())
        .setup(move |app| {
            let initialized = (|| -> Result<(), Box<dyn std::error::Error>> {
                let data_dir = app_data_dir(app.handle())?;
                let instance_lock = acquire_instance_lock(&data_dir)?;
                let connection = Connection::open(data_dir.join("calendar.db"))
                    .map_err(|e| fail(format!("open calendar database: {e}")))?;
                connection.pragma_update(None, "journal_mode", "WAL")?;
                connection.busy_timeout(Duration::from_secs(5))?;
                init_schema(&connection)?;
                app.manage(AppState(Mutex::new(connection)));
                app.manage(instance_lock);
                if !startup_options.is_update_background() {
                    mvp_sync::start(app.handle(), data_dir.join("calendar.db"));
                    app_updates::start(app.handle().clone());
                    app_updates::enroll_windows_task(app.handle().clone());
                }
                Ok(())
            })();
            if let Err(error) = initialized {
                if startup_options.is_update_background() && error.to_string().contains("already open for this profile") {
                    // An interactive instance owns this profile. This is a
                    // normal scheduled skip, not a failed installation.
                    std::process::exit(0);
                }
                if startup_options != desktop_launch::Options::Interactive {
                    desktop_launch::fail_and_exit();
                }
                return Err(error);
            }
            startup_options.after_setup(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_items,
            save_item,
            set_completed,
            delete_item,
            create_backup,
            app_updates::mvp_update_status,
            app_updates::mvp_update_check,
            app_updates::mvp_update_prepare,
            app_updates::mvp_update_install,
            app_updates::mvp_update_activity,
            app_updates::mvp_update_auto_install,
            app_updates::mvp_update_open_permission,
            app_updates::mvp_update_confirm,
            mvp_sync::mvp_sync_status,
            mvp_sync::mvp_sync_configure,
            mvp_sync::mvp_sync_set_enabled,
            mvp_sync::mvp_sync_now,
            mvp_sync_db::conflicts::mvp_sync_conflicts_list,
            mvp_sync_db::conflicts::mvp_sync_conflict_resolve,
            calendar_compat::start_calendar_day,
            calendar_compat::get_events,
            calendar_compat::get_all_events,
            calendar_compat::create_event,
            calendar_compat::update_event,
            calendar_compat::delete_event,
            calendar_compat::get_notes,
            calendar_compat::get_note,
            calendar_compat::create_note,
            calendar_compat::update_note,
            calendar_compat::update_note_status,
            calendar_compat::toggle_note_archive,
            calendar_compat::get_calendar_tasks,
            calendar_compat::get_calendar_task,
            calendar_compat::save_calendar_task,
            calendar_compat::complete_calendar_task,
            calendar_compat::get_calendar_records,
            calendar_compat::get_ui_state,
            calendar_compat::set_ui_state,
            calendar_compat::get_goals,
            calendar_compat::save_calendar_goal,
            calendar_compat::delete_goal,
            calendar_compat::get_calendar_task_goals,
            calendar_compat::set_calendar_task_goal,
            calendar_compat::list_event_categories,
            calendar_compat::create_event_category,
            calendar_compat::update_event_category,
            calendar_compat::delete_event_category,
            calendar_compat::get_timeline_blocks,
            calendar_compat::get_active_block,
            calendar_compat::start_task_block,
            calendar_compat::pause_task_block,
            calendar_compat::finish_task_block,
            calendar_compat::skip_recurring_step,
            calendar_compat::get_calendar_task_minutes,
            calendar_compat::get_calendar_task_seconds,
            calendar_compat::get_schedules,
            calendar_compat::get_task_pins,
            calendar_compat::get_app_setting,
            calendar_compat::set_app_setting
        ])
        .build(context);
    let mut app = built.unwrap_or_else(|error| {
        if options != desktop_launch::Options::Interactive {
            desktop_launch::fail_and_exit();
        }
        panic!("run Hanni MVP: {error:?}");
    });
    options.before_run(&mut app);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if options.is_one_shot() {
        // Wry 2.11.4 drops RequestExit's code; retain it through event-loop cleanup.
        let exit_code = std::rc::Rc::new(std::cell::Cell::new(1));
        let requested_exit = exit_code.clone();
        app.run_return(move |app, event| {
            if let tauri::RunEvent::ExitRequested {
                code: Some(code), ..
            } = &event
            {
                requested_exit.set(*code);
            }
            options.on_event(app, &event);
        });
        std::process::exit(exit_code.get());
    }
    app.run(move |app, event| options.on_event(app, &event));
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(kind: &str) -> ItemInput {
        ItemInput {
            id: None,
            expected_version: None,
            kind: kind.into(),
            title: "Write tests".into(),
            notes: String::new(),
            date: Some("2026-09-10".into()),
            time: Some("09:30".into()),
            duration_minutes: 30,
            completed: false,
        }
    }
    fn memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn create_update_complete_delete_are_versioned() {
        let mut conn = memory();
        let created = save(&mut conn, input("task")).unwrap();
        assert_eq!(created.version, 1);
        let mut update = input("task");
        update.id = Some(created.id.clone());
        update.expected_version = Some(1);
        update.title = "Updated".into();
        let updated = save(&mut conn, update).unwrap();
        assert_eq!(updated.version, 2);
        let done = complete(&mut conn, &updated.id, 2, true).unwrap();
        assert!(done.completed);
        assert_eq!(done.version, 3);
        remove(&mut conn, &done.id, 3).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn rejects_invalid_input_and_event_completion() {
        let mut conn = memory();
        let mut bad = input("event");
        bad.date = None;
        bad.time = None;
        assert!(save(&mut conn, bad).unwrap_err().contains("event requires"));
        let mut bad = input("task");
        bad.time = Some("25:00".into());
        assert!(save(&mut conn, bad).unwrap_err().contains("HH:MM"));
        let mut event = input("event");
        event.completed = true;
        assert!(save(&mut conn, event)
            .unwrap_err()
            .contains("cannot be completed"));
    }

    #[test]
    fn stale_versions_fail_without_overwriting() {
        let mut conn = memory();
        let created = save(&mut conn, input("task")).unwrap();
        let mut first = input("task");
        first.id = Some(created.id.clone());
        first.expected_version = Some(1);
        save(&mut conn, first).unwrap();
        let mut stale = input("task");
        stale.id = Some(created.id);
        stale.expected_version = Some(1);
        assert!(save(&mut conn, stale)
            .unwrap_err()
            .contains("changed elsewhere"));
    }

    #[test]
    fn reopen_and_backup_roundtrip() {
        let directory = tempfile::tempdir().unwrap();
        let db = directory.path().join("calendar.db");
        let mut conn = Connection::open(&db).unwrap();
        init_schema(&conn).unwrap();
        let created = save(&mut conn, input("task")).unwrap();
        let path = backup(&conn, directory.path()).unwrap();
        drop(conn);
        let reopened = Connection::open(db).unwrap();
        assert_eq!(
            get_item(&reopened, &created.id).unwrap().title,
            "Write tests"
        );
        let backup_conn = Connection::open(path).unwrap();
        assert_eq!(list(&backup_conn).unwrap().len(), 1);
    }

    #[test]
    fn debug_isolation_requires_absolute_nonlegacy_path() {
        let directory = tempfile::tempdir().unwrap();
        let standard = directory.path().join("default");
        assert!(debug_data_dir(Some("relative".into()), standard.clone()).is_err());
        assert!(debug_data_dir(
            Some(directory.path().join("Hanni").into_os_string()),
            standard.clone()
        )
        .is_err());
        assert_eq!(
            debug_data_dir(
                Some(directory.path().join("test").into_os_string()),
                standard
            )
            .unwrap(),
            directory.path().join("test")
        );
    }

    #[test]
    fn frontend_payload_uses_snake_case_inside_input_and_item_output() {
        let create: ItemInput = serde_json::from_value(serde_json::json!({
            "kind": "task", "title": "Create", "notes": "", "date": null,
            "time": null, "duration_minutes": 25, "completed": false
        }))
        .unwrap();
        assert_eq!(create.duration_minutes, 25);
        assert_eq!(create.expected_version, None);
        let update: ItemInput = serde_json::from_value(serde_json::json!({
            "id": "item-1", "expected_version": 2, "kind": "task", "title": "Update",
            "notes": "note", "date": "2026-09-10", "time": "09:30",
            "duration_minutes": 30, "completed": true
        }))
        .unwrap();
        assert_eq!(update.expected_version, Some(2));
        let output = serde_json::to_value(Item {
            id: "item-1".into(),
            kind: "task".into(),
            title: "Update".into(),
            notes: "note".into(),
            date: Some("2026-09-10".into()),
            time: Some("09:30".into()),
            duration_minutes: 30,
            completed: true,
            version: 3,
            created_at: "created".into(),
            updated_at: "updated".into(),
        })
        .unwrap();
        assert_eq!(output["duration_minutes"], 30);
        assert!(output.get("durationMinutes").is_none());
        assert!(output.get("created_at").is_some());
    }

    #[test]
    fn v1_items_survive_calendar_workspace_migration() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', date TEXT, time TEXT, duration_minutes INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          INSERT INTO items VALUES ('existing','task','Kept','text','2026-09-11',NULL,30,0,4,'a','b'); PRAGMA user_version=1;").unwrap();
        init_schema(&conn).unwrap();
        assert_eq!(get_item(&conn, "existing").unwrap().version, 4);
        assert_eq!(
            conn.query_row("SELECT category FROM items WHERE id='existing'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "general"
        );
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn v3_timeline_seconds_migration_preserves_rows_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', date TEXT, time TEXT, duration_minutes INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', color TEXT NOT NULL DEFAULT '#9B9B9B', priority INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '', content_blocks TEXT, status TEXT NOT NULL DEFAULT 'task');
          CREATE TABLE event_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
          CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE timeline_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, source_id TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT, duration_minutes INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 0, completion_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          INSERT INTO timeline_blocks(source_type,source_id,date,start_time,duration_minutes,is_active,created_at,updated_at) VALUES('note','legacy','2026-09-13','23:59:00',2,0,'old','old');
          PRAGMA user_version=3;").unwrap();
        init_schema(&conn).unwrap();
        assert_eq!(conn.query_row("SELECT duration_minutes,duration_seconds FROM timeline_blocks WHERE source_id='legacy'", [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))).unwrap(), (2, 0));
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        init_schema(&conn).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM timeline_blocks WHERE source_id='legacy'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
}
