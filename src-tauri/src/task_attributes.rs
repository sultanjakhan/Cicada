//! Task kind and sphere (issue #96) and work stage (2026-09-24) stored in
//! existing synchronized columns.
//!
//! The encrypted relay transports every `items` row as one JSON object and a
//! receiver rejects an object whose columns differ from its own table
//! (`content_sync_unknown_schema`), which also stops its receive cursor. A new
//! `items` column would therefore stall every 0.3.29 replica. Instead:
//! - time of day uses the existing `items.time` column (NULL for untimed tasks);
//! - kind, sphere, work stage (`task-stage:<id>`) and «Жду ответа»
//!   (`task-waiting`) are reserved tokens in the existing comma-separated
//!   `items.tags` column of a task.
//! The 0.3.29 interface never rewrites `time` or `tags` of a task: its task
//! save, completion, archive and timer statements leave both columns alone, its
//! note editor (the only `tags` writer) handles `status='note'` rows and re-sends
//! the tags it has just read, and the v1 `save_item` command has no UI caller. Its full-row capture therefore carries the values unchanged
//! when it edits, completes or re-sends a task. Concurrent edits of one task on
//! two devices resolve per row, as for every other field: the newer row wins and
//! the other version is kept for conflict review, where kind and sphere appear.

pub const KIND_NORMAL: &str = "normal";
pub const KIND_INSTANT: &str = "instant";
pub const SPHERES: &[&str] = &["work", "home", "health", "growth", "personal"];
/// Work stages in their display order (`TASK_STAGES` in task-model.js).
pub const STAGES: &[&str] = &[
    "understanding",
    "requirements",
    "description",
    "agreement",
    "decomposition",
    "development",
    "acceptance",
];
const KIND_PREFIX: &str = "task-kind:";
const SPHERE_PREFIX: &str = "task-sphere:";
const STAGE_PREFIX: &str = "task-stage:";
const WAITING: &str = "task-waiting";

fn tokens(tags: &str) -> impl Iterator<Item = &str> {
    tags.split(',').map(str::trim).filter(|token| !token.is_empty())
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

/// A known stage, or None. A stage id written by a newer version stays in
/// `tags` (and is reported as unset) until the user picks another stage.
pub fn stage(tags: &str) -> Option<&'static str> {
    tokens(tags)
        .filter_map(|token| token.strip_prefix(STAGE_PREFIX))
        .find_map(|value| STAGES.iter().copied().find(|known| *known == value))
}

/// «Жду ответа» is shown over any stage, including none.
pub fn waiting(tags: &str) -> bool {
    tokens(tags).any(|token| token == WAITING)
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
pub fn stage_label(stage: &str) -> &'static str {
    match stage {
        "understanding" => "Понимание",
        "requirements" => "Требования",
        "description" => "Описание",
        "agreement" => "Согласование",
        "decomposition" => "Декомпозиция",
        "development" => "В разработке",
        "acceptance" => "Приёмка",
        _ => "",
    }
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

/// An empty value clears the stage.
pub fn validate_stage(value: &str) -> Result<(), String> {
    if value.is_empty() || STAGES.contains(&value) {
        Ok(())
    } else {
        Err("stage must be one of the task stages or empty".into())
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

    #[test]
    fn legacy_and_empty_tags_read_as_normal_without_sphere() {
        for tags in ["", "calendar", " , ", "task-sphere:unknown"] {
            assert_eq!(kind(tags), KIND_NORMAL);
            assert_eq!(sphere(tags), None);
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
    }

    #[test]
    fn stage_and_waiting_read_known_values_and_keep_unknown_ones() {
        for tags in ["", "calendar", "task-stage:", "task-stage:review", "task-waiting-not"] {
            assert_eq!(stage(tags), None, "{tags}");
            assert!(!waiting(tags), "{tags}");
        }
        assert_eq!(stage("calendar,task-stage:agreement,task-waiting"), Some("agreement"));
        assert!(waiting(" task-waiting ,calendar"));
        // A newer stage id is ignored for display but survives other writes.
        assert_eq!(stage("task-stage:review,task-stage:development"), Some("development"));
        let kept = write("task-stage:review,task-waiting", Some(KIND_INSTANT), Some("work"));
        assert_eq!(kept, "task-stage:review,task-waiting,task-kind:instant,task-sphere:work");
        assert_eq!(write_stage(&kept, None, Some(false)), "task-stage:review,task-kind:instant,task-sphere:work");
        assert_eq!(write_stage("task-stage:review", None, Some(true)), "task-stage:review,task-waiting");
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
    fn validation_accepts_only_the_owner_list() {
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
        assert!(validate_stage("review").is_err());
        assert!(validate_stage("Development").is_err());
    }
}
