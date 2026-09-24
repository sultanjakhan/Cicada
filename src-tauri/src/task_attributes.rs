//! Task kind and sphere (issue #96) stored in existing synchronized columns.
//!
//! The encrypted relay transports every `items` row as one JSON object and a
//! receiver rejects an object whose columns differ from its own table
//! (`content_sync_unknown_schema`), which also stops its receive cursor. A new
//! `items` column would therefore stall every 0.3.29 replica. Instead:
//! - time of day uses the existing `items.time` column (NULL for untimed tasks);
//! - kind and sphere are reserved tokens in the existing comma-separated
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
const KIND_PREFIX: &str = "task-kind:";
const SPHERE_PREFIX: &str = "task-sphere:";

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
    fn validation_accepts_only_the_owner_list() {
        assert!(validate_kind("instant").is_ok() && validate_kind("normal").is_ok());
        assert!(validate_kind("routine").is_err());
        for value in ["", "work", "home", "health", "growth", "personal"] {
            assert!(validate_sphere(value).is_ok(), "{value}");
        }
        assert!(validate_sphere("finance").is_err());
        assert!(validate_sphere("Work").is_err());
    }
}
