//! Task kind and sphere (issue #96), process, work stage and stage history
//! (2026-09-24/25) stored in existing synchronized columns.
//!
//! The encrypted relay transports every `items` row as one JSON object and a
//! receiver rejects an object whose columns differ from its own table
//! (`content_sync_unknown_schema`), which also stops its receive cursor. A new
//! `items` column would therefore stall every 0.3.29 replica. Instead:
//! - time of day uses the existing `items.time` column (NULL for untimed tasks);
//! - kind, sphere, process (`task-process:<id>`), work stage (`task-stage:<id>`),
//!   «Жду ответа» (`task-waiting`) and every stage transition
//!   (`task-stage-log:<stage>@<RFC 3339 UTC>`, in the order they happened) are
//!   reserved tokens in the existing comma-separated `items.tags` column.
//! The 0.3.29 interface never rewrites `time` or `tags` of a task: its task
//! save, completion, archive and timer statements leave both columns alone, its
//! note editor (the only `tags` writer) handles `status='note'` rows and re-sends
//! the tags it has just read, and the v1 `save_item` command has no UI caller. Its full-row capture therefore carries the values unchanged
//! when it edits, completes or re-sends a task. 0.3.33 rewrites only the
//! `task-stage:` and `task-waiting` tokens and keeps every other one, including
//! the process and the history. Concurrent edits of one task on two devices
//! resolve per row, as for every other field: the newer row wins and the other
//! version is kept for conflict review.
//!
//! Process definitions (names and ordered stages) live in the synchronized UI
//! key `calendar_processes_v1`, one sync record per process. Stage ids are
//! stable slugs, so renaming a stage never touches tasks; a task whose stage
//! was deleted keeps the id until the user picks another stage.

pub const KIND_NORMAL: &str = "normal";
pub const KIND_INSTANT: &str = "instant";
pub const SPHERES: &[&str] = &["work", "home", "health", "growth", "personal"];
/// The built-in process. A task with a stage or «Жду ответа» but no process
/// tag (0.3.33 records) belongs to it.
pub const DEFAULT_PROCESS: &str = "system-analysis";
/// Stages of the built-in process in their display order (DEFAULT_PROCESS in task-processes.js).
/// Stage ids are no longer validated against it; the tests keep both lists aligned.
#[cfg_attr(not(test), allow(dead_code))]
pub const STAGES: &[&str] = &[
    "understanding",
    "requirements",
    "analysis",
    "description",
    "agreement",
    "decomposition",
    "development",
    "acceptance",
];
/// History entries kept per task; the oldest go first. Time before the first
/// kept entry reads as «Без стадии».
pub const MAX_LOG: usize = 200;
const KIND_PREFIX: &str = "task-kind:";
const SPHERE_PREFIX: &str = "task-sphere:";
const PROCESS_PREFIX: &str = "task-process:";
const STAGE_PREFIX: &str = "task-stage:";
const LOG_PREFIX: &str = "task-stage-log:";
const WAITING: &str = "task-waiting";

fn tokens(tags: &str) -> impl Iterator<Item = &str> {
    tags.split(',').map(str::trim).filter(|token| !token.is_empty())
}

/// Process and stage ids: 1–64 of `a-z 0-9 _ -`, starting with a letter or digit.
/// They never contain the `,` `:` `@` separators of the tag tokens.
pub fn valid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-' || *b == b'_')
}

/// Kind is `instant` only for its explicit token; everything else is `normal`.
pub fn kind(tags: &str) -> &'static str {
    if tokens(tags).any(|token| token == "task-kind:instant") {
        KIND_INSTANT
    } else {
        KIND_NORMAL
    }
}

/// A known sphere, or None. Unknown values stay in `tags` until replaced.
pub fn sphere(tags: &str) -> Option<&'static str> {
    tokens(tags)
        .filter_map(|token| token.strip_prefix(SPHERE_PREFIX))
        .find_map(|value| SPHERES.iter().copied().find(|known| *known == value))
}

/// The stored stage id, or None. Stages are editable, so any well-formed id is
/// reported; the interface shows an id missing from its process as «Стадия удалена».
pub fn stage(tags: &str) -> Option<&str> {
    tokens(tags)
        .filter_map(|token| token.strip_prefix(STAGE_PREFIX))
        .find(|value| valid_id(value))
}

/// The explicit process tag, or None.
pub fn process(tags: &str) -> Option<&str> {
    tokens(tags)
        .filter_map(|token| token.strip_prefix(PROCESS_PREFIX))
        .find(|value| valid_id(value))
}

/// The process a task belongs to. Migration on read: a 0.3.33 task with a
/// stage or «Жду ответа» and no process tag belongs to the built-in process.
pub fn effective_process(tags: &str) -> Option<&str> {
    process(tags).or_else(|| (stage(tags).is_some() || waiting(tags)).then_some(DEFAULT_PROCESS))
}

/// «Жду ответа» is shown over any stage, including none.
pub fn waiting(tags: &str) -> bool {
    tokens(tags).any(|token| token == WAITING)
}

/// Stage transitions in the order they were recorded: (stage id or '' for
/// «no stage», RFC 3339 UTC time). Malformed entries are skipped.
pub fn stage_log(tags: &str) -> Vec<(&str, &str)> {
    tokens(tags)
        .filter_map(|token| token.strip_prefix(LOG_PREFIX))
        .filter_map(|entry| entry.rsplit_once('@'))
        .filter(|(stage, at)| (stage.is_empty() || valid_id(stage)) && chrono::DateTime::parse_from_rfc3339(at).is_ok())
        .collect()
}

/// Russian labels for the synchronization conflict review.
pub fn kind_label(kind: &str) -> &'static str {
    if kind == KIND_INSTANT { "Моментальная" } else { "Обычная" }
}
pub fn sphere_label(sphere: &str) -> &'static str {
    match sphere {
        "work" => "Работа",
        "home" => "Дом",
        "health" => "Здоровье",
        "growth" => "Развитие",
        "personal" => "Личное",
        _ => "",
    }
}
/// Built-in stage names; a stage added in the settings has only its stored name.
pub fn stage_label(stage: &str) -> &'static str {
    match stage {
        "understanding" => "Понимание",
        "requirements" => "Требования",
        "analysis" => "Анализ и модели",
        "description" => "Описание",
        "agreement" => "Согласование",
        "decomposition" => "Декомпозиция",
        "development" => "В разработке",
        "acceptance" => "Приёмка",
        _ => "",
    }
}
/// Names of a process and a stage from the stored process state
/// (`calendar_processes_v1`), falling back to the built-in names and then to the id.
pub fn names(processes_json: Option<&str>, process: &str, stage: Option<&str>) -> (String, Option<String>) {
    let state: serde_json::Value = processes_json.and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or_default();
    let stored = state["processes"].as_array().and_then(|rows| rows.iter().find(|row| row["id"] == process));
    let process_name = stored
        .and_then(|row| row["title"].as_str().map(str::to_owned))
        .unwrap_or_else(|| if process == DEFAULT_PROCESS { "Системный анализ".into() } else { process.into() });
    let stage_name = stage.map(|id| {
        let mut all = state["processes"].as_array().into_iter().flatten().flat_map(|row| row["stages"].as_array().into_iter().flatten());
        all.find(|row| row["id"] == id)
            .and_then(|row| row["title"].as_str().map(str::to_owned))
            .or_else(|| Some(stage_label(id)).filter(|label| !label.is_empty()).map(str::to_owned))
            .unwrap_or_else(|| id.into())
    });
    (process_name, stage_name)
}

pub fn validate_kind(value: &str) -> Result<(), String> {
    if matches!(value, KIND_NORMAL | KIND_INSTANT) {
        Ok(())
    } else {
        Err("task_kind must be normal or instant".into())
    }
}

/// An empty value clears the sphere.
pub fn validate_sphere(value: &str) -> Result<(), String> {
    if value.is_empty() || SPHERES.contains(&value) {
        Ok(())
    } else {
        Err("sphere must be work, home, health, growth, personal or empty".into())
    }
}

/// An empty value clears the stage. Stage ids come from the editable processes.
pub fn validate_stage(value: &str) -> Result<(), String> {
    if value.is_empty() || valid_id(value) {
        Ok(())
    } else {
        Err("stage must be a stage id (a-z, 0-9, - or _) or empty".into())
    }
}

/// An empty value removes the process together with its stage and «Жду ответа».
pub fn validate_process(value: &str) -> Result<(), String> {
    if value.is_empty() || valid_id(value) {
        Ok(())
    } else {
        Err("process must be a process id (a-z, 0-9, - or _) or empty".into())
    }
}

/// Replaces only the stage and waiting marks that are given; `None` keeps the
/// stored value, including a stage id this version does not know.
pub fn write_stage(tags: &str, stage: Option<&str>, waiting: Option<bool>) -> String {
    let mut out: Vec<String> = tokens(tags)
        .filter(|token| {
            !(stage.is_some() && token.starts_with(STAGE_PREFIX) || waiting.is_some() && *token == WAITING)
        })
        .map(str::to_owned)
        .collect();
    if let Some(value) = stage.filter(|value| !value.is_empty()) {
        out.push(format!("{STAGE_PREFIX}{value}"));
    }
    if waiting == Some(true) {
        out.push(WAITING.to_owned());
    }
    out.join(",")
}

/// One change of the process, stage and «Жду ответа» of a task; `None` keeps a value.
#[derive(Clone, Copy, Default)]
pub struct StageEdit<'a> {
    /// `Some("")` removes the process, the stage and «Жду ответа».
    pub process: Option<&'a str>,
    pub stage: Option<&'a str>,
    pub waiting: Option<bool>,
}

/// Applies `edit` and records a transition at `at` whenever the stage changes.
/// The first recorded transition of a task that already had a stage (0.3.33)
/// first records that stage from `since` (the task's creation), so its earlier
/// work stays with it. The process tag is not derived here: see [`with_process`].
pub fn edit_stage(tags: &str, edit: StageEdit<'_>, at: &str, since: &str) -> String {
    let before = stage(tags).map(str::to_owned);
    let cleared = edit.process == Some("");
    let (stage_change, waiting_change) = if cleared { (Some(""), Some(false)) } else { (edit.stage, edit.waiting) };
    // An unchanged value keeps its token in place, so repeating a choice changes nothing.
    let stage_change = stage_change.filter(|value| *value != before.as_deref().unwrap_or(""));
    let waiting_change = waiting_change.filter(|value| *value != waiting(tags));
    let edit = StageEdit { process: edit.process.filter(|value| process(tags) != Some(value) || value.is_empty()), ..edit };
    let mut out: Vec<String> = tokens(&write_stage(tags, stage_change, waiting_change)).map(str::to_owned).collect();
    if let Some(value) = edit.process {
        out.retain(|token| !token.starts_with(PROCESS_PREFIX));
        if !value.is_empty() {
            out.push(format!("{PROCESS_PREFIX}{value}"));
        }
    }
    let after = stage(&out.join(",")).map(str::to_owned);
    if before != after {
        if stage_log(tags).is_empty() {
            if let Some(previous) = &before {
                out.push(format!("{LOG_PREFIX}{previous}@{}", canonical_time(since)));
            }
        }
        out.push(format!("{LOG_PREFIX}{}@{}", after.unwrap_or_default(), canonical_time(at)));
        let entries = out.iter().filter(|token| token.starts_with(LOG_PREFIX)).count();
        let mut excess = entries.saturating_sub(MAX_LOG);
        out.retain(|token| {
            if excess > 0 && token.starts_with(LOG_PREFIX) {
                excess -= 1;
                false
            } else {
                true
            }
        });
    }
    out.join(",")
}

/// Migration on write: a task with a stage or «Жду ответа» but no process tag
/// gets the built-in process tag the next time it is edited.
pub fn with_process(tags: &str) -> String {
    if process(tags).is_some() || !(stage(tags).is_some() || waiting(tags)) {
        return tags.to_owned();
    }
    let mut out: Vec<&str> = tokens(tags).filter(|token| !token.starts_with(PROCESS_PREFIX)).collect();
    let tag = format!("{PROCESS_PREFIX}{DEFAULT_PROCESS}");
    out.push(&tag);
    out.join(",")
}

/// RFC 3339 UTC with milliseconds; an unreadable value (very old records) reads as the epoch.
fn canonical_time(value: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&chrono::Utc))
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Replaces only the attributes that are given. Other tags keep their order.
pub fn write(tags: &str, kind: Option<&str>, sphere: Option<&str>) -> String {
    let mut out: Vec<String> = tokens(tags)
        .filter(|token| {
            !(kind.is_some() && token.starts_with(KIND_PREFIX)
                || sphere.is_some() && token.starts_with(SPHERE_PREFIX))
        })
        .map(str::to_owned)
        .collect();
    if kind == Some(KIND_INSTANT) {
        out.push(format!("{KIND_PREFIX}{KIND_INSTANT}"));
    }
    if let Some(value) = sphere.filter(|value| !value.is_empty()) {
        out.push(format!("{SPHERE_PREFIX}{value}"));
    }
    out.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    const T1: &str = "2026-09-25T09:00:00.000Z";
    const T2: &str = "2026-09-25T10:30:00.000Z";

    /// The 0.3.33 stage writer, verbatim, to check that it keeps the new tokens.
    fn write_stage_0333(tags: &str, stage: Option<&str>, waiting: Option<bool>) -> String {
        let mut out: Vec<String> = tags.split(',').map(str::trim).filter(|token| !token.is_empty())
            .filter(|token| !(stage.is_some() && token.starts_with("task-stage:") || waiting.is_some() && *token == "task-waiting"))
            .map(str::to_owned)
            .collect();
        if let Some(value) = stage.filter(|value| !value.is_empty()) {
            out.push(format!("task-stage:{value}"));
        }
        if waiting == Some(true) {
            out.push("task-waiting".to_owned());
        }
        out.join(",")
    }

    #[test]
    fn legacy_and_empty_tags_read_as_normal_without_sphere() {
        for tags in ["", "calendar", " , ", "task-sphere:unknown"] {
            assert_eq!(kind(tags), KIND_NORMAL);
            assert_eq!(sphere(tags), None);
            assert_eq!((process(tags), effective_process(tags), stage(tags)), (None, None, None));
            assert!(stage_log(tags).is_empty());
        }
    }

    #[test]
    fn write_replaces_only_given_attributes_and_keeps_foreign_tags() {
        let tags = write("calendar", Some(KIND_INSTANT), Some("home"));
        assert_eq!(tags, "calendar,task-kind:instant,task-sphere:home");
        assert_eq!((kind(&tags), sphere(&tags)), (KIND_INSTANT, Some("home")));
        let kept = write(&tags, None, Some("work"));
        assert_eq!(kept, "calendar,task-kind:instant,task-sphere:work");
        let normal = write(&kept, Some(KIND_NORMAL), None);
        assert_eq!(normal, "calendar,task-sphere:work");
        assert_eq!(write(&normal, None, Some("")), "calendar");
        assert_eq!(write("task-sphere:future", None, None), "task-sphere:future");
        let staged = "task-process:p-1,task-stage:s-2,task-stage-log:s-2@2026-09-25T09:00:00.000Z";
        assert_eq!(write(staged, Some(KIND_NORMAL), Some("work")), format!("{staged},task-sphere:work"));
    }

    #[test]
    fn stage_ids_are_slugs_and_any_stored_slug_is_reported() {
        for id in ["understanding", "analysis", "s-1a2b", "0", "a_b", &"x".repeat(64)] {
            assert!(valid_id(id), "{id}");
        }
        for id in ["", "Review", "-a", "_a", "a b", "a,b", "a:b", "a@b", "ж", &"x".repeat(65)] {
            assert!(!valid_id(id), "{id}");
        }
        for tags in ["", "calendar", "task-stage:", "task-stage:Bad", "task-waiting-not"] {
            assert_eq!(stage(tags), None, "{tags}");
            assert!(!waiting(tags), "{tags}");
        }
        assert_eq!(stage("calendar,task-stage:agreement,task-waiting"), Some("agreement"));
        assert_eq!(stage("task-stage:review"), Some("review"), "a deleted or custom stage keeps its id");
        assert!(waiting(" task-waiting ,calendar"));
        assert_eq!(stage("task-stage:Bad,task-stage:development"), Some("development"));
    }

    #[test]
    fn a_legacy_stage_or_waiting_mark_belongs_to_the_default_process() {
        assert_eq!(effective_process("task-stage:agreement"), Some(DEFAULT_PROCESS));
        assert_eq!(effective_process("task-waiting"), Some(DEFAULT_PROCESS));
        assert_eq!(effective_process("task-process:p-1,task-stage:agreement"), Some("p-1"));
        assert_eq!(effective_process("task-process:p-1"), Some("p-1"), "a process without a stage yet");
        assert_eq!(effective_process("task-sphere:work"), None);
        assert_eq!(with_process("calendar,task-stage:agreement"), "calendar,task-stage:agreement,task-process:system-analysis");
        assert_eq!(with_process("task-waiting"), "task-waiting,task-process:system-analysis");
        for tags in ["", "calendar", "task-process:p-1,task-stage:s", "task-sphere:home"] {
            assert_eq!(with_process(tags), tags, "{tags}");
        }
    }

    #[test]
    fn a_stage_change_records_a_transition_and_seeds_a_legacy_stage() {
        // A new stage: one transition.
        let tags = edit_stage("calendar", StageEdit { process: Some(DEFAULT_PROCESS), stage: Some("understanding"), waiting: None }, T1, "2026-09-20T08:00:00Z");
        assert_eq!(tags, format!("calendar,task-stage:understanding,task-process:system-analysis,task-stage-log:understanding@{T1}"));
        assert_eq!(stage_log(&tags), vec![("understanding", T1)]);
        // The same stage again, «Жду ответа» or an unchanged process record nothing.
        assert_eq!(edit_stage(&tags, StageEdit { stage: Some("understanding"), ..StageEdit::default() }, T2, T1), tags);
        let waiting_tags = edit_stage(&tags, StageEdit { waiting: Some(true), ..StageEdit::default() }, T2, T1);
        assert_eq!(stage_log(&waiting_tags).len(), 1);
        // The next stage appends; clearing records an empty stage.
        let moved = edit_stage(&waiting_tags, StageEdit { stage: Some("requirements"), ..StageEdit::default() }, T2, T1);
        assert_eq!(stage_log(&moved), vec![("understanding", T1), ("requirements", T2)]);
        let cleared = edit_stage(&moved, StageEdit { stage: Some(""), ..StageEdit::default() }, "2026-09-25T11:00:00+05:00", T1);
        assert_eq!(stage_log(&cleared).last(), Some(&("", "2026-09-25T06:00:00.000Z")), "stored in UTC");
        assert_eq!(stage(&cleared), None);
        // A 0.3.33 task that had a stage and no history keeps its earlier work with that stage.
        let legacy = edit_stage("task-stage:agreement,task-waiting", StageEdit { stage: Some("decomposition"), ..StageEdit::default() }, T2, "2026-09-20T08:00:00Z");
        assert_eq!(stage_log(&legacy), vec![("agreement", "2026-09-20T08:00:00.000Z"), ("decomposition", T2)]);
        assert_eq!(with_process(&legacy), format!("{legacy},task-process:system-analysis"));
        let unreadable = edit_stage("task-stage:agreement", StageEdit { stage: Some("development"), ..StageEdit::default() }, T2, "a");
        assert_eq!(stage_log(&unreadable)[0], ("agreement", "1970-01-01T00:00:00.000Z"));
    }

    #[test]
    fn removing_the_process_clears_stage_and_waiting_but_keeps_the_history() {
        let tags = "task-sphere:work,task-process:system-analysis,task-stage:analysis,task-waiting,task-stage-log:analysis@2026-09-25T09:00:00.000Z";
        let none = edit_stage(tags, StageEdit { process: Some(""), stage: Some("acceptance"), waiting: Some(true) }, T2, T1);
        assert_eq!(none, format!("task-sphere:work,task-stage-log:analysis@{T1},task-stage-log:@{T2}"));
        assert_eq!((process(&none), effective_process(&none), stage(&none), waiting(&none)), (None, None, None, false));
        // Another process: the process tag is replaced, the stage follows the edit.
        let other = edit_stage(tags, StageEdit { process: Some("p-2"), stage: Some("s-1"), waiting: None }, T2, T1);
        assert_eq!((process(&other), stage(&other), waiting(&other)), (Some("p-2"), Some("s-1"), true));
        assert_eq!(stage_log(&other), vec![("analysis", T1), ("s-1", T2)]);
    }

    #[test]
    fn the_history_is_bounded_and_malformed_entries_are_ignored() {
        let mut tags = String::from("task-process:p");
        for minute in 0..(MAX_LOG + 5) {
            let at = format!("2026-09-25T{:02}:{:02}:00.000Z", 8 + minute / 60, minute % 60);
            tags = edit_stage(&tags, StageEdit { stage: Some(if minute % 2 == 0 { "a" } else { "b" }), ..StageEdit::default() }, &at, T1);
        }
        let log = stage_log(&tags);
        assert_eq!(log.len(), MAX_LOG);
        assert_eq!(log[0].1, "2026-09-25T08:05:00.000Z", "the oldest entries go first");
        let noisy = "task-stage-log:a,task-stage-log:a@soon,task-stage-log:Bad@2026-09-25T09:00:00Z,task-stage-log:b@2026-09-25T09:00:00Z";
        assert_eq!(stage_log(noisy), vec![("b", "2026-09-25T09:00:00Z")]);
    }

    #[test]
    fn the_0333_stage_writer_keeps_process_and_history_tokens() {
        let tags = format!("task-process:p-1,task-stage:s-2,task-stage-log:s-2@{T1},task-sphere:work");
        let old = write_stage_0333(&tags, Some("agreement"), Some(true));
        assert_eq!(old, format!("task-process:p-1,task-stage-log:s-2@{T1},task-sphere:work,task-stage:agreement,task-waiting"));
        assert_eq!((process(&old), stage_log(&old).len()), (Some("p-1"), 1), "an older client never drops the new tokens");
        assert_eq!(write_stage_0333(&tags, None, None), tags);
    }

    #[test]
    fn write_stage_replaces_only_given_marks_and_keeps_foreign_tags() {
        let tags = write_stage("calendar,task-sphere:home", Some("requirements"), Some(true));
        assert_eq!(tags, "calendar,task-sphere:home,task-stage:requirements,task-waiting");
        assert_eq!((stage(&tags), waiting(&tags), sphere(&tags)), (Some("requirements"), true, Some("home")));
        let moved = write_stage(&tags, Some("acceptance"), None);
        assert_eq!(moved, "calendar,task-sphere:home,task-waiting,task-stage:acceptance");
        assert_eq!(write_stage(&moved, Some(""), Some(false)), "calendar,task-sphere:home");
        assert_eq!(write_stage("task-stage:a,task-stage:b", Some("agreement"), None), "task-stage:agreement");
        assert_eq!(write_stage("calendar", None, None), "calendar");
    }

    #[test]
    fn names_come_from_the_stored_processes_then_the_built_in_list() {
        let state = r#"{"version":1,"processes":[{"id":"system-analysis","title":"СА","stages":[{"id":"understanding","title":"Вникнуть"}]},{"id":"p-2","title":"Ремонт","stages":[{"id":"s-1","title":"Смета"}]}]}"#;
        assert_eq!(names(Some(state), "system-analysis", Some("understanding")), ("СА".into(), Some("Вникнуть".into())));
        assert_eq!(names(Some(state), "p-2", Some("s-1")), ("Ремонт".into(), Some("Смета".into())));
        assert_eq!(names(None, "system-analysis", Some("analysis")), ("Системный анализ".into(), Some("Анализ и модели".into())));
        assert_eq!(names(Some("broken"), "p-9", Some("gone")), ("p-9".into(), Some("gone".into())));
    }

    #[test]
    fn validation_accepts_only_the_owner_lists_and_slugs() {
        assert!(validate_kind("instant").is_ok() && validate_kind("normal").is_ok());
        assert!(validate_kind("routine").is_err());
        for value in ["", "work", "home", "health", "growth", "personal"] {
            assert!(validate_sphere(value).is_ok(), "{value}");
        }
        assert!(validate_sphere("finance").is_err());
        assert!(validate_sphere("Work").is_err());
        for value in std::iter::once("").chain(STAGES.iter().copied()) {
            assert!(validate_stage(value).is_ok(), "{value}");
            assert!(value.is_empty() || !stage_label(value).is_empty(), "{value}");
        }
        assert!(validate_stage("s-custom").is_ok());
        assert!(validate_stage("Development").is_err());
        assert!(validate_stage("a,b").is_err());
        assert!(validate_process("").is_ok() && validate_process(DEFAULT_PROCESS).is_ok());
        assert!(validate_process("Системный").is_err());
    }
}
