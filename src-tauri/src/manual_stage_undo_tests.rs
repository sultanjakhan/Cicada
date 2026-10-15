use super::*;
use crate::task_attributes::{process as task_process, waiting};
use serde_json::json;

const T0: &str = "2026-10-08T08:00:00.000Z";
const T1: &str = "2026-10-08T09:00:00.000Z";
const T2: &str = "2026-10-08T09:30:00.000Z";
const STATE: &str = r#"{"version":1,"processes":[{"id":"p","title":"Synthetic process","stages":[{"id":"a","title":"First"},{"id":"b","title":"Second"}]}]}"#;

fn snapshot() -> ProcessSnapshot<'static> {
    ProcessSnapshot {
        raw: Some(STATE),
        proof: "synthetic-p-incarnation-1",
    }
}
fn tags() -> String {
    format!("calendar,task-process:p,task-stage:a,task-stage-log:a@{T0},task-waiting,external:kept")
}
fn stages(tags: &str) -> Vec<(String, String)> {
    stage_log(tags)
        .into_iter()
        .map(|(stage, at)| (stage.into(), at.into()))
        .collect()
}

#[test]
fn restore_appends_compensation_preserving_history_waiting_process_and_foreign_tags() {
    let original = tags();
    let prepared = prepare_change(&original, snapshot(), "b", T1, T0)
        .unwrap()
        .unwrap();
    assert_eq!(stage(&prepared.tags), Some("b"));
    assert_eq!(
        stages(&prepared.tags),
        vec![("a".into(), T0.into()), ("b".into(), T1.into())]
    );
    let restored = prepare_restore(&prepared.tags, snapshot(), &prepared.inverse, T2, T0).unwrap();
    assert_eq!(stage(&restored), Some("a"));
    assert_eq!(
        stages(&restored),
        vec![
            ("a".into(), T0.into()),
            ("b".into(), T1.into()),
            ("a".into(), T2.into())
        ]
    );
    assert_eq!(task_process(&restored), Some("p"));
    assert!(waiting(&restored));
    assert!(restored.split(',').any(|tag| tag == "calendar"));
    assert!(restored.split(',').any(|tag| tag == "external:kept"));
    assert_eq!(original, tags(), "preparation never mutates its source");
}

#[test]
fn clearing_a_stage_and_restoring_none_are_real_logged_transitions() {
    let prepared = prepare_change(&tags(), snapshot(), "", T1, T0)
        .unwrap()
        .unwrap();
    assert_eq!(stage(&prepared.tags), None);
    let restored = prepare_restore(&prepared.tags, snapshot(), &prepared.inverse, T2, T0).unwrap();
    assert_eq!(
        stages(&restored),
        vec![
            ("a".into(), T0.into()),
            ("".into(), T1.into()),
            ("a".into(), T2.into())
        ]
    );
    let none = "task-process:p,task-waiting,external:kept";
    let prepared = prepare_change(none, snapshot(), "b", T1, "unneeded")
        .unwrap()
        .unwrap();
    let restored = prepare_restore(
        &prepared.tags,
        snapshot(),
        &prepared.inverse,
        T2,
        "unneeded",
    )
    .unwrap();
    assert_eq!(stage(&restored), None);
    assert_eq!(
        stages(&restored),
        vec![("b".into(), T1.into()), ("".into(), T2.into())]
    );
    assert!(waiting(&restored));
}

#[test]
fn legacy_baseline_and_process_are_kept_even_when_the_stage_is_cleared() {
    let original = "task-stage:analysis,external:kept";
    let snapshot = || ProcessSnapshot {
        raw: None,
        proof: "synthetic-absent-default",
    };
    let prepared = prepare_change(original, snapshot(), "", T1, T0)
        .unwrap()
        .unwrap();
    let empty = prepare_change(
        original,
        ProcessSnapshot {
            raw: Some(""),
            proof: "synthetic-absent-default",
        },
        "",
        T1,
        T0,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        empty.tags, prepared.tags,
        "empty and absent saved state share the built-in process"
    );
    assert_eq!(empty.inverse, prepared.inverse);
    assert!(prepare_restore(
        &empty.tags,
        ProcessSnapshot {
            raw: Some(""),
            proof: "synthetic-absent-default"
        },
        &empty.inverse,
        T2,
        T0
    )
    .is_ok());
    assert_eq!(task_process(&prepared.tags), Some(DEFAULT_PROCESS));
    assert_eq!(
        stages(&prepared.tags),
        vec![("analysis".into(), T0.into()), ("".into(), T1.into())]
    );
    let restored = prepare_restore(&prepared.tags, snapshot(), &prepared.inverse, T2, T0).unwrap();
    assert_eq!(task_process(&restored), Some(DEFAULT_PROCESS));
    assert_eq!(
        stages(&restored),
        vec![
            ("analysis".into(), T0.into()),
            ("".into(), T1.into()),
            ("analysis".into(), T2.into())
        ]
    );
}

fn history(count: usize, valid: bool) -> String {
    let mut tags = String::from("task-process:p,task-stage:a");
    for _ in 0..count {
        tags.push_str(if valid {
            ",task-stage-log:a@2026-10-08T08:00:00.000Z"
        } else {
            ",task-stage-log:malformed"
        });
    }
    tags
}

#[test]
fn original_change_reserves_exact_compensation_capacity_without_truncating() {
    let original = history(MAX_LOG - 2, true);
    let prepared = prepare_change(&original, snapshot(), "b", T1, T0)
        .unwrap()
        .unwrap();
    assert_eq!(raw_log_count(&prepared.tags), MAX_LOG - 1);
    let restored = prepare_restore(&prepared.tags, snapshot(), &prepared.inverse, T2, T0).unwrap();
    assert_eq!(raw_log_count(&restored), MAX_LOG);
    assert_eq!(stages(&restored)[..MAX_LOG - 2], stages(&original));
    for count in [MAX_LOG - 1, MAX_LOG, MAX_LOG + 1] {
        let original = history(count, true);
        assert_eq!(
            prepare_change(&original, snapshot(), "b", T1, T0).unwrap_err(),
            "undo_stage_history_full"
        );
        assert_eq!(original, history(count, true));
    }
}

#[test]
fn malformed_history_tokens_also_consume_capacity_and_legacy_baseline_room() {
    let original = history(MAX_LOG - 3, false);
    let prepared = prepare_change(&original, snapshot(), "b", T1, T0)
        .unwrap()
        .unwrap();
    assert_eq!(raw_log_count(&prepared.tags), MAX_LOG - 1);
    assert_eq!(
        prepared.tags.matches("task-stage-log:malformed").count(),
        MAX_LOG - 3
    );
    assert_eq!(
        stages(&prepared.tags),
        vec![("a".into(), T0.into()), ("b".into(), T1.into())]
    );
    let restored = prepare_restore(&prepared.tags, snapshot(), &prepared.inverse, T2, T0).unwrap();
    assert_eq!(raw_log_count(&restored), MAX_LOG);
    assert_eq!(
        restored.matches("task-stage-log:malformed").count(),
        MAX_LOG - 3
    );
    assert_eq!(
        prepare_change(&history(MAX_LOG - 2, false), snapshot(), "b", T1, T0).unwrap_err(),
        "undo_stage_history_full"
    );
}

#[test]
fn no_op_at_full_capacity_needs_no_new_history_or_valid_clock() {
    let original = history(MAX_LOG + 1, false);
    assert!(
        prepare_change(&original, snapshot(), "a", "invalid", "invalid")
            .unwrap()
            .is_none()
    );
    assert_eq!(original, history(MAX_LOG + 1, false));
}

#[test]
fn clocks_cannot_rewrite_previously_attributed_time() {
    let original = tags();
    for at in ["invalid", "2026-10-08T07:59:59.999Z"] {
        assert_eq!(
            prepare_change(&original, snapshot(), "b", at, T0).unwrap_err(),
            "undo_stage_time_conflict"
        );
    }
    let prepared = prepare_change(&original, snapshot(), "b", T1, T0)
        .unwrap()
        .unwrap();
    assert_eq!(
        prepare_restore(&prepared.tags, snapshot(), &prepared.inverse, T0, T0).unwrap_err(),
        "undo_stage_time_conflict"
    );
    let unsorted =
        format!("task-process:p,task-stage:a,task-stage-log:a@{T1},task-stage-log:a@{T0}");
    assert_eq!(
        prepare_change(&unsorted, snapshot(), "b", T0, T0).unwrap_err(),
        "undo_stage_time_conflict"
    );
    let precision = "task-process:p,task-stage:a,task-stage-log:a@2026-10-08T08:00:00.0005Z";
    assert_eq!(
        prepare_change(precision, snapshot(), "b", "2026-10-08T08:00:00.0007Z", T0).unwrap_err(),
        "undo_stage_time_conflict"
    );
    let prepared = prepare_change(
        &original,
        snapshot(),
        "b",
        "2026-10-08T11:00:00.000+02:00",
        T0,
    )
    .unwrap()
    .unwrap();
    assert_eq!(stages(&prepared.tags).last().unwrap().1, T1);
}

#[test]
fn invalid_or_future_legacy_creation_time_is_not_replaced_with_epoch() {
    let original = "task-process:p,task-stage:a";
    for since in ["invalid", T2, "2026-10-08T09:00:00.0005Z"] {
        assert_eq!(
            prepare_change(original, snapshot(), "b", T1, since).unwrap_err(),
            "undo_stage_time_conflict"
        );
    }
}

#[test]
fn instant_unassigned_unknown_and_deleted_stages_do_not_mint_inverse() {
    for original in [
        "task-kind:instant,task-process:p,task-stage:a",
        "calendar,task-sphere:work",
        "task-process:missing,task-stage:a",
        "task-process:p,task-stage:deleted",
    ] {
        assert_eq!(
            prepare_change(original, snapshot(), "b", T1, T0).unwrap_err(),
            CONFLICT
        );
    }
    for requested in ["Bad", "unknown", "a,b"] {
        assert_eq!(
            prepare_change(&tags(), snapshot(), requested, T1, T0).unwrap_err(),
            CONFLICT
        );
    }
}

#[test]
fn process_state_is_fail_closed_for_bad_shape_duplicates_and_invalid_stages() {
    for raw in [
        "broken",
        "null",
        "[]",
        r#"{"version":2,"processes":[]}"#,
        r#"{"version":1,"processes":{}}"#,
        r#"{"version":1,"processes":[{"id":"p","title":"P","stages":[]}]}"#,
        r#"{"version":1,"processes":[{"id":"p","title":"P","stages":[{"id":"a","title":"A"},{"id":"a","title":"Again"}]}]}"#,
        r#"{"version":1,"processes":[{"id":"p","title":"P","stages":[{"id":"Bad","title":"A"}]}]}"#,
        r#"{"version":1,"processes":[{"id":"p","title":"P","stages":[{"id":"a","title":" "}]}]}"#,
        r#"{"version":1,"processes":[{"id":"p","title":"P","stages":[{"id":"a","title":"A"}]},{"id":"p","title":"Again","stages":[{"id":"b","title":"B"}]}]}"#,
    ] {
        assert_eq!(
            prepare_change(
                &tags(),
                ProcessSnapshot {
                    raw: Some(raw),
                    proof: "synthetic-proof"
                },
                "b",
                T1,
                T0
            )
            .unwrap_err(),
            CONFLICT,
            "{raw}"
        );
    }
    assert_eq!(
        prepare_change(
            &tags(),
            ProcessSnapshot {
                raw: Some(STATE),
                proof: " "
            },
            "b",
            T1,
            T0
        )
        .unwrap_err(),
        CONFLICT
    );
}

#[test]
fn duplicate_stage_id_in_a_different_process_cannot_supply_the_inverse() {
    let raw = r#"{"version":1,"processes":[{"id":"p","title":"P","stages":[{"id":"b","title":"B"}]},{"id":"other","title":"Other","stages":[{"id":"a","title":"A"}]}]}"#;
    assert_eq!(
        prepare_change(
            &tags(),
            ProcessSnapshot {
                raw: Some(raw),
                proof: "synthetic"
            },
            "b",
            T1,
            T0
        )
        .unwrap_err(),
        CONFLICT
    );
}

#[test]
fn changed_process_proof_deleted_previous_stage_or_newer_tags_block_restore() {
    let prepared = prepare_change(&tags(), snapshot(), "b", T1, T0)
        .unwrap()
        .unwrap();
    let before = prepared.tags.clone();
    assert_eq!(
        prepare_restore(
            &before,
            ProcessSnapshot {
                raw: Some(STATE),
                proof: "synthetic-p-incarnation-2"
            },
            &prepared.inverse,
            T2,
            T0
        )
        .unwrap_err(),
        CONFLICT
    );
    let deleted = r#"{"version":1,"processes":[{"id":"p","title":"Synthetic process","stages":[{"id":"b","title":"Second"}]}]}"#;
    assert_eq!(
        prepare_restore(
            &before,
            ProcessSnapshot {
                raw: Some(deleted),
                proof: "synthetic-p-incarnation-1"
            },
            &prepared.inverse,
            T2,
            T0
        )
        .unwrap_err(),
        CONFLICT
    );
    assert_eq!(
        prepare_restore(
            &before,
            ProcessSnapshot {
                raw: Some(r#"{"version":1,"processes":[]}"#),
                proof: "synthetic-p-incarnation-1"
            },
            &prepared.inverse,
            T2,
            T0
        )
        .unwrap_err(),
        CONFLICT
    );
    for changed in [
        format!("{before},newer:edit"),
        before.replace("task-process:p", "task-process:other"),
    ] {
        assert_eq!(
            prepare_restore(&changed, snapshot(), &prepared.inverse, T2, T0).unwrap_err(),
            CONFLICT
        );
    }
    assert_eq!(before, prepared.tags);
}

#[test]
fn a_deleted_stored_builtin_cannot_silently_fall_back_to_implicit_builtin() {
    let raw = r#"{"version":1,"processes":[{"id":"system-analysis","title":"Saved","stages":[{"id":"analysis","title":"A"},{"id":"acceptance","title":"B"}]}]}"#;
    let original = "task-process:system-analysis,task-stage:analysis";
    let prepared = prepare_change(
        original,
        ProcessSnapshot {
            raw: Some(raw),
            proof: "synthetic-default",
        },
        "acceptance",
        T1,
        T0,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        prepare_restore(
            &prepared.tags,
            ProcessSnapshot {
                raw: None,
                proof: "synthetic-default"
            },
            &prepared.inverse,
            T2,
            T0
        )
        .unwrap_err(),
        CONFLICT
    );
}

#[test]
fn unrelated_process_changes_are_allowed_with_unchanged_selected_process_proof() {
    let prepared = prepare_change(&tags(), snapshot(), "b", T1, T0)
        .unwrap()
        .unwrap();
    let mut raw: Value = serde_json::from_str(STATE).unwrap();
    raw["processes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"other","title":"Unrelated","stages":[{"id":"a","title":"Other A"}]}));
    let raw = raw.to_string();
    assert!(prepare_restore(
        &prepared.tags,
        ProcessSnapshot {
            raw: Some(&raw),
            proof: "synthetic-p-incarnation-1"
        },
        &prepared.inverse,
        T2,
        T0
    )
    .is_ok());
}

#[test]
fn inverse_is_typed_and_rejects_unknown_kind_or_fields() {
    let prepared = prepare_change(&tags(), snapshot(), "b", T1, T0)
        .unwrap()
        .unwrap();
    let value = serde_json::to_value(&prepared.inverse).unwrap();
    assert_eq!(value["kind"], "stage");
    assert_eq!(
        serde_json::from_value::<StageInverse>(value.clone()).unwrap(),
        prepared.inverse
    );
    let mut bad = value.clone();
    bad["kind"] = json!("text");
    assert!(serde_json::from_value::<StageInverse>(bad).is_err());
    let mut bad = value;
    bad["waiting"] = json!(false);
    assert!(serde_json::from_value::<StageInverse>(bad).is_err());
}
