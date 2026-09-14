//! SELECT-only scheduling; detailed queue counts belong to the status UI.
use rusqlite::{Connection, OptionalExtension};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Status {
    pub enabled: bool,
    initializing: bool,
    pending: bool,
    upload_not_before: i64,
    pull_not_before: i64,
}

impl Status {
    pub fn due(self, now: i64, requested: bool, idle_poll: bool) -> bool {
        self.enabled
            && (self.initializing
                || (self.pending && now >= self.upload_not_before)
                || ((requested || idle_poll) && now >= self.pull_not_before))
    }
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
    let state: Option<(i64, i64, bool)> = sql(conn.query_row(
        "SELECT upload_not_before,pull_not_before,receipt_needed!=0 FROM content_sync_state WHERE id=1",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional())?;
    let Some((upload_not_before, pull_not_before, receipt)) = state else {
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
        initializing: false,
    })
}
