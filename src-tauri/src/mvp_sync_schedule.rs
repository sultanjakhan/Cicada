//! SELECT-only scheduling; detailed queue counts belong to the status UI.
use rusqlite::{Connection, OptionalExtension};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Status {
    pub enabled: bool,
    initializing: bool,
    pending: bool,
    upload_not_before: i64,
    pull_not_before: i64,
    retry_pull: bool,
}

impl Status {
    pub fn due(self, now: i64, requested: bool, idle_poll: bool) -> bool {
        self.enabled
            && (self.initializing
                || (self.pending && now >= self.upload_not_before)
                || ((requested || idle_poll || self.retry_pull) && now >= self.pull_not_before))
    }
}

// Successful queue pages may continue without an empty one-second poll between
// them. Yield every page, and return to the normal wait after a bounded burst.
// Never defeat transport backoff, conflicts, disabled sync or a no-progress page.
pub(super) fn continue_catch_up(value: &serde_json::Value, consecutive: &mut u8) -> bool {
    let pending = value["more_pending"] == true || value["pull_more"] == true;
    let progress = value["uploaded_batches"].as_u64().unwrap_or(0) > 0
        || value["applied_rows"].as_u64().unwrap_or(0) > 0
        || value["pull_more"] == true;
    let ready = value["enabled"] == true
        && value["error_code"] == "none"
        && value["retry_after_secs"].as_u64() == Some(0)
        && pending && progress && *consecutive < 8;
    if ready { *consecutive += 1; } else { *consecutive = 0; }
    ready
}

fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|_| "content_sync_database_failed".into())
}

pub(super) fn read(conn: &Connection) -> Result<Status, String> {
    let enabled: bool = sql(conn.query_row(
        "SELECT COALESCE((SELECT value FROM app_settings WHERE key='content_sync_enabled'),'false')='true'",
        [], |row| row.get(0),
    ))?;
    if !enabled {
        return Ok(Status::default());
    }
    let exists: bool = sql(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='content_sync_state')",
        [], |row| row.get(0),
    ))?;
    if !exists {
        return Ok(Status {
            enabled,
            initializing: true,
            ..Status::default()
        });
    }
    let state: Option<(i64, i64, bool, bool)> = sql(conn.query_row(
        "SELECT upload_not_before,pull_not_before,receipt_needed!=0,pull_error IS NOT NULL FROM content_sync_state WHERE id=1",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional())?;
    let Some((upload_not_before, pull_not_before, receipt, retry_pull)) = state else {
        return Ok(Status {
            enabled,
            initializing: true,
            ..Status::default()
        });
    };
    let blocked: bool = sql(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='content_sync_blocked')",
        [], |row| row.get(0),
    ))?;
    let pending = if receipt {
        true
    } else {
        let query = if blocked {
            "SELECT EXISTS(SELECT 1 FROM content_sync_dirty WHERE NOT EXISTS(SELECT 1 FROM content_sync_blocked WHERE content_sync_blocked.seq=content_sync_dirty.seq)) OR EXISTS(SELECT 1 FROM content_sync_outbox) OR EXISTS(SELECT 1 FROM content_sync_outbound_fragments)"
        } else {
            "SELECT EXISTS(SELECT 1 FROM content_sync_dirty) OR EXISTS(SELECT 1 FROM content_sync_outbox) OR EXISTS(SELECT 1 FROM content_sync_outbound_fragments)"
        };
        sql(conn.query_row(query, [], |row| row.get(0)))?
    };
    Ok(Status {
        enabled,
        pending,
        upload_not_before,
        pull_not_before,
        // Failed pulls must retry even after the worker consumes the original wake.
        // Transport owns both clearing the error and renewing the backoff deadline.
        retry_pull,
        initializing: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
            INSERT INTO app_settings VALUES('content_sync_enabled','true');
            CREATE TABLE content_sync_state(id INTEGER PRIMARY KEY,upload_not_before INTEGER NOT NULL,
                pull_not_before INTEGER NOT NULL,receipt_needed INTEGER NOT NULL,
                upload_error TEXT,pull_error TEXT);
            INSERT INTO content_sync_state VALUES(1,0,0,0,NULL,NULL);
            CREATE TABLE content_sync_dirty(seq INTEGER PRIMARY KEY);
            CREATE TABLE content_sync_outbox(local_seq INTEGER PRIMARY KEY);
            CREATE TABLE content_sync_outbound_fragments(id INTEGER PRIMARY KEY);").unwrap();
        conn
    }

    #[test]
    fn failed_pull_retries_at_durable_deadline_without_another_wake() {
        let conn = database();
        conn.execute("UPDATE content_sync_state SET pull_error='content_sync_network',pull_not_before=1015", []).unwrap();
        let changes: i64 = conn.query_row("SELECT total_changes()", [], |r| r.get(0)).unwrap();
        let status = read(&conn).unwrap();
        assert!(!status.due(1014, false, false));
        assert!(!status.due(1014, true, true), "wakes cannot bypass pull backoff");
        assert!(status.due(1015, false, false), "a failed pull retries without socket/UI wakes");
        assert_eq!(conn.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0)).unwrap(), changes,
            "scheduler reads never change durable state");
    }

    #[test]
    fn failed_retry_renews_backoff_and_success_returns_to_quiet_idle() {
        let conn = database();
        conn.execute("UPDATE content_sync_state SET pull_error='content_sync_network',pull_not_before=1015", []).unwrap();
        assert!(read(&conn).unwrap().due(1015, false, false));
        // The transport persists a fresh deadline after another failed pull.
        conn.execute("UPDATE content_sync_state SET pull_not_before=1030", []).unwrap();
        assert!(!read(&conn).unwrap().due(1016, false, false));
        assert!(read(&conn).unwrap().due(1030, false, false));
        // A successful pull already clears pull_error in the transport.
        conn.execute("UPDATE content_sync_state SET pull_error=NULL", []).unwrap();
        let status = read(&conn).unwrap();
        assert!(!status.due(1030, false, false));
        assert!(status.due(1030, true, false));
        assert!(status.due(1030, false, true));
    }

    #[test]
    fn upload_errors_do_not_create_pull_retries_or_bypass_upload_backoff() {
        let conn = database();
        conn.execute("UPDATE content_sync_state SET upload_error='content_sync_http_507',upload_not_before=4600", []).unwrap();
        assert!(!read(&conn).unwrap().due(4600, false, false), "no work remains to upload");
        conn.execute("INSERT INTO content_sync_dirty VALUES(1)", []).unwrap();
        let status = read(&conn).unwrap();
        assert!(!status.due(4599, false, false));
        assert!(status.due(4600, false, false));
        conn.execute("UPDATE content_sync_state SET pull_error='content_sync_network',pull_not_before=1015", []).unwrap();
        let status = read(&conn).unwrap();
        assert!(!status.due(1014, false, false));
        assert!(status.due(1015, false, false), "pull recovery is independent of upload backoff");
        assert_eq!(status.upload_not_before, 4600, "transport must retain its independent upload gate");
    }

    #[test]
    fn disabled_sync_stays_idle_and_uninitialized_sync_still_initializes() {
        let conn = database();
        conn.execute("UPDATE content_sync_state SET pull_error='content_sync_network',pull_not_before=1015", []).unwrap();
        conn.execute("UPDATE app_settings SET value='false'", []).unwrap();
        assert!(!read(&conn).unwrap().due(2000, true, true));
        conn.execute("UPDATE app_settings SET value='true'", []).unwrap();
        conn.execute("DELETE FROM content_sync_state", []).unwrap();
        assert!(read(&conn).unwrap().due(0, false, false));
        conn.execute("DROP TABLE content_sync_state", []).unwrap();
        assert!(read(&conn).unwrap().due(0, false, false));
        conn.execute("UPDATE app_settings SET value='false'", []).unwrap();
        assert!(!read(&conn).unwrap().due(2000, true, true));
    }

    fn page() -> serde_json::Value {
        json!({"enabled":true,"error_code":"none","retry_after_secs":0,
            "more_pending":true,"pull_more":false,"uploaded_batches":1,"applied_rows":0})
    }

    #[test]
    fn progressing_pages_drain_without_idle_polls_and_stop_when_empty() {
        let mut burst = 0;
        for _ in 0..3 { assert!(continue_catch_up(&page(), &mut burst)); }
        assert_eq!(burst, 3);
        let mut empty = page();
        empty["more_pending"] = json!(false);
        empty["uploaded_batches"] = json!(0);
        assert!(!continue_catch_up(&empty, &mut burst));
        assert_eq!(burst, 0);
    }

    #[test]
    fn disabled_errors_backoff_and_no_progress_never_spin() {
        for (key, value) in [
            ("enabled", json!(false)), ("error_code", json!("content_sync_network")),
            ("error_code", json!("content_sync_conflicts")), ("retry_after_secs", json!(15)),
            ("retry_after_secs", serde_json::Value::Null), ("uploaded_batches", json!(0)),
        ] {
            let mut status = page(); status[key] = value;
            let mut burst = 3;
            assert!(!continue_catch_up(&status, &mut burst), "{key}");
            assert_eq!(burst, 0);
        }
    }

    #[test]
    fn pull_backlog_can_continue_but_each_burst_is_bounded() {
        let mut status = page(); status["uploaded_batches"] = json!(0); status["pull_more"] = json!(true);
        let mut burst = 0;
        for _ in 0..8 { assert!(continue_catch_up(&status, &mut burst)); }
        assert!(!continue_catch_up(&status, &mut burst));
        assert_eq!(burst, 0);
        assert!(continue_catch_up(&status, &mut burst));
    }
}
