//! Pure preparation for a manual stage change and its compensating Undo.
//! The shared durable Undo engine owns the transaction, receipt, complete
//! task-row/version CAS and replay. Exact replay precedes live preparation.
//! This module performs no database, timer, task identity, goal or UI writes.

use super::{
    edit_stage, effective_process, kind, stage, stage_log, valid_id, with_process, StageEdit,
    DEFAULT_PROCESS, KIND_INSTANT, MAX_LOG, STAGES,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

type Result<T> = std::result::Result<T, String>;
const CONFLICT: &str = "undo_stage_conflict";
const INVALID: &str = "undo_receipt_invalid";
const LOG_PREFIX: &str = "task-stage-log:";

/// Trusted server input. Proof includes the selected canonical process row and
/// its sync lineage, including absence/tombstones; IPC never supplies it.
pub(crate) struct ProcessSnapshot<'a> {
    pub(crate) raw: Option<&'a str>,
    pub(crate) proof: &'a str,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StageInverse {
    kind: InverseKind,
    process_id: String,
    process_proof: String,
    // A previously stored built-in process may not silently become the default.
    process_was_stored: bool,
    previous_stage: String,
    after_tags: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum InverseKind {
    Stage,
}

#[derive(Debug)]
pub(crate) struct PreparedChange {
    pub(crate) tags: String,
    pub(crate) inverse: StageInverse,
}

struct SelectedProcess {
    stored: bool,
    stages: Vec<String>,
}

fn process(snapshot: &ProcessSnapshot<'_>, process_id: &str) -> Result<SelectedProcess> {
    if !valid_id(process_id) || snapshot.proof.trim().is_empty() {
        return Err(CONFLICT.into());
    }
    let mut selected = None;
    if let Some(raw) = snapshot.raw.filter(|raw| !raw.is_empty()) {
        let state: Value = serde_json::from_str(raw).map_err(|_| CONFLICT)?;
        if !state.is_object() || state["version"].as_u64() != Some(1) {
            return Err(CONFLICT.into());
        }
        let rows = state["processes"].as_array().ok_or(CONFLICT)?;
        let mut process_ids = HashSet::new();
        for row in rows {
            let id = row["id"].as_str().ok_or(CONFLICT)?;
            let title = row["title"].as_str().ok_or(CONFLICT)?;
            let stages = row["stages"].as_array().ok_or(CONFLICT)?;
            if !row.is_object()
                || !valid_id(id)
                || !process_ids.insert(id)
                || title.trim().is_empty()
                || title.chars().count() > 200
                || !(1..=50).contains(&stages.len())
            {
                return Err(CONFLICT.into());
            }
            let mut seen = HashSet::new();
            let mut ids = Vec::new();
            for stage in stages {
                let stage_id = stage["id"].as_str().ok_or(CONFLICT)?;
                let name = stage["title"].as_str().ok_or(CONFLICT)?;
                if !stage.is_object()
                    || !valid_id(stage_id)
                    || !seen.insert(stage_id)
                    || name.trim().is_empty()
                    || name.chars().count() > 200
                {
                    return Err(CONFLICT.into());
                }
                ids.push(stage_id.to_owned());
            }
            if id == process_id {
                selected = Some(SelectedProcess {
                    stored: true,
                    stages: ids,
                });
            }
        }
    }
    selected
        .or_else(|| {
            (process_id == DEFAULT_PROCESS).then(|| SelectedProcess {
                stored: false,
                stages: STAGES.iter().map(|stage| (*stage).to_owned()).collect(),
            })
        })
        .ok_or_else(|| CONFLICT.into())
}

fn stage_exists(process: &SelectedProcess, value: &str) -> bool {
    value.is_empty() || (valid_id(value) && process.stages.iter().any(|stage| stage == value))
}

fn raw_log_count(tags: &str) -> usize {
    tags.split(',')
        .map(str::trim)
        .filter(|token| token.starts_with(LOG_PREFIX))
        .count()
}

fn append_time(tags: &str, at: &str, baseline_since: Option<&str>) -> Result<String> {
    let time = DateTime::parse_from_rfc3339(at).map_err(|_| "undo_stage_time_conflict")?;
    let canonical = time
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    // Compare what edit_stage actually appends, including millisecond truncation.
    let appended =
        DateTime::parse_from_rfc3339(&canonical).map_err(|_| "undo_stage_time_conflict")?;
    for (_, previous) in stage_log(tags) {
        let previous =
            DateTime::parse_from_rfc3339(previous).map_err(|_| "undo_stage_time_conflict")?;
        if appended < previous {
            return Err("undo_stage_time_conflict".into());
        }
    }
    if let Some(since) = baseline_since {
        let since = DateTime::parse_from_rfc3339(since).map_err(|_| "undo_stage_time_conflict")?;
        if since > appended {
            return Err("undo_stage_time_conflict".into());
        }
    }
    Ok(canonical)
}

/// A no-op creates neither a receipt nor history. A real change reserves room
/// for its later compensation before any write.
pub(crate) fn prepare_change(
    tags: &str,
    snapshot: ProcessSnapshot<'_>,
    requested_stage: &str,
    at: &str,
    since: &str,
) -> Result<Option<PreparedChange>> {
    if kind(tags) == KIND_INSTANT {
        return Err(CONFLICT.into());
    }
    let process_id = effective_process(tags).ok_or(CONFLICT)?;
    let selected = process(&snapshot, process_id)?;
    if !stage_exists(&selected, requested_stage) {
        return Err(CONFLICT.into());
    }
    let previous_stage = stage(tags).unwrap_or("");
    if requested_stage == previous_stage {
        return Ok(None);
    }
    // An unavailable old stage cannot yield an honest, usable inverse.
    if !stage_exists(&selected, previous_stage) {
        return Err(CONFLICT.into());
    }
    let baseline = !previous_stage.is_empty() && stage_log(tags).is_empty();
    let growth = 1 + usize::from(baseline);
    if raw_log_count(tags).saturating_add(growth + 1) > MAX_LOG {
        return Err("undo_stage_history_full".into());
    }
    let at = append_time(tags, at, baseline.then_some(since))?;
    // Migrate only a real legacy write. Migrating before edit_stage also retains
    // the effective process when clearing the last legacy stage.
    let migrated = with_process(tags);
    let changed = edit_stage(
        &migrated,
        StageEdit {
            stage: Some(requested_stage),
            ..StageEdit::default()
        },
        &at,
        since,
    );
    Ok(Some(PreparedChange {
        inverse: StageInverse {
            kind: InverseKind::Stage,
            process_id: process_id.to_owned(),
            process_proof: snapshot.proof.to_owned(),
            process_was_stored: selected.stored,
            previous_stage: previous_stage.to_owned(),
            after_tags: changed.clone(),
        },
        tags: changed,
    }))
}

/// Work spent in the changed stage remains in history. Timer rows and elapsed
/// durations are outside this helper.
pub(crate) fn prepare_restore(
    tags: &str,
    snapshot: ProcessSnapshot<'_>,
    inverse: &StageInverse,
    at: &str,
    since: &str,
) -> Result<String> {
    if tags != inverse.after_tags
        || snapshot.proof != inverse.process_proof
        || kind(tags) == KIND_INSTANT
        || effective_process(tags) != Some(inverse.process_id.as_str())
    {
        return Err(CONFLICT.into());
    }
    let selected = process(&snapshot, &inverse.process_id)?;
    if selected.stored != inverse.process_was_stored
        || !stage_exists(&selected, &inverse.previous_stage)
    {
        return Err(CONFLICT.into());
    }
    if stage(tags).unwrap_or("") == inverse.previous_stage {
        return Err(INVALID.into());
    }
    if raw_log_count(tags).saturating_add(1) > MAX_LOG {
        return Err("undo_stage_history_full".into());
    }
    let at = append_time(tags, at, None)?;
    Ok(edit_stage(
        tags,
        StageEdit {
            stage: Some(&inverse.previous_stage),
            ..StageEdit::default()
        },
        &at,
        since,
    ))
}

#[cfg(test)]
#[path = "manual_stage_undo_tests.rs"]
mod tests;
