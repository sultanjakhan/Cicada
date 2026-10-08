#[path = "../../src-tauri/src/digital_activity_summary.rs"]
mod summary;

use chrono::{FixedOffset, MappedLocalTime, NaiveDate, NaiveDateTime, TimeZone};
use summary::*;

fn utc() -> FixedOffset {
    FixedOffset::east_opt(0).unwrap()
}
#[derive(Clone)]
struct Spring;
#[derive(Clone)]
struct Fall;
macro_rules! date_lit {
    ($y:literal, $m:literal, $d:literal) => {
        NaiveDate::from_ymd_opt($y, $m, $d).unwrap()
    };
}
fn synthetic_offset(date: &NaiveDate, spring: bool) -> FixedOffset {
    let pivot = if spring {
        date_lit!(2026, 3, 29)
    } else {
        date_lit!(2026, 10, 25)
    };
    let seconds = if spring {
        if *date > pivot {
            3600
        } else {
            0
        }
    } else {
        if *date > pivot {
            0
        } else {
            3600
        }
    };
    FixedOffset::east_opt(seconds).unwrap()
}
impl TimeZone for Spring {
    type Offset = FixedOffset;
    fn from_offset(_: &Self::Offset) -> Self {
        Self
    }
    fn offset_from_local_date(&self, date: &NaiveDate) -> MappedLocalTime<Self::Offset> {
        MappedLocalTime::Single(synthetic_offset(date, true))
    }
    fn offset_from_local_datetime(&self, dt: &NaiveDateTime) -> MappedLocalTime<Self::Offset> {
        self.offset_from_local_date(&dt.date())
    }
    fn offset_from_utc_date(&self, date: &NaiveDate) -> Self::Offset {
        synthetic_offset(date, true)
    }
    fn offset_from_utc_datetime(&self, dt: &NaiveDateTime) -> Self::Offset {
        synthetic_offset(&dt.date(), true)
    }
}
impl TimeZone for Fall {
    type Offset = FixedOffset;
    fn from_offset(_: &Self::Offset) -> Self {
        Self
    }
    fn offset_from_local_date(&self, date: &NaiveDate) -> MappedLocalTime<Self::Offset> {
        MappedLocalTime::Single(synthetic_offset(date, false))
    }
    fn offset_from_local_datetime(&self, dt: &NaiveDateTime) -> MappedLocalTime<Self::Offset> {
        self.offset_from_local_date(&dt.date())
    }
    fn offset_from_utc_date(&self, date: &NaiveDate) -> Self::Offset {
        synthetic_offset(date, false)
    }
    fn offset_from_utc_datetime(&self, dt: &NaiveDateTime) -> Self::Offset {
        synthetic_offset(&dt.date(), false)
    }
}
const DEVICE: &str = "123e4567-e89b-12d3-a456-426614174000";
fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
}
fn request(
    source: ActivitySource,
    dates: Vec<NaiveDate>,
    events: Vec<ForegroundEvent>,
) -> SummaryRequest {
    SummaryRequest {
        device_id: DEVICE.into(),
        source,
        dates,
        observed_at: Some("2026-10-08T12:34:56.789Z".into()),
        observation_status: ObservationStatus::Available,
        events,
    }
}
fn event(app: &str, start: &str, seconds: f64) -> ForegroundEvent {
    ForegroundEvent::new(app, start, seconds)
}
fn seconds(result: &SummaryResult, app: &str) -> f64 {
    result.dates[0]
        .summary
        .as_ref()
        .unwrap()
        .apps
        .iter()
        .find(|v| v.app == app)
        .unwrap()
        .seconds
}

#[test]
fn provenance_identity_and_observed_metadata_are_preserved() {
    let mut req = request(
        ActivitySource::Windows,
        vec![date("2026-10-08")],
        vec![event("Editor", "2026-10-08T00:00:00.123456Z", 1.25)],
    );
    req.observation_status = ObservationStatus::Available;
    let out = summarize(&req, &utc()).unwrap();
    let row = &out.dates[0];
    assert_eq!(
        row.identity,
        "digital-activity:123e4567-e89b-12d3-a456-426614174000:2026-10-08"
    );
    assert_eq!(row.metadata.device_id, DEVICE);
    assert_eq!(row.metadata.observed_at, req.observed_at);
    assert_eq!(
        row.metadata.observation_status,
        ObservationStatus::Available
    );
    assert_eq!(row.summary.as_ref().unwrap().foreground_seconds, 1.25);
}

#[test]
fn duplicate_events_and_reordering_are_idempotent() {
    let a = event("Editor", "2026-10-08T00:00:00Z", 2.5);
    let b = event("Browser", "2026-10-08T00:00:01Z", 1.25);
    let first = summarize(
        &request(
            ActivitySource::Windows,
            vec![date("2026-10-08")],
            vec![a.clone(), b.clone(), a.clone()],
        ),
        &utc(),
    )
    .unwrap();
    let second = summarize(
        &request(
            ActivitySource::Windows,
            vec![date("2026-10-08")],
            vec![b, a],
        ),
        &utc(),
    )
    .unwrap();
    assert_eq!(first.dates, second.dates);
}

#[test]
fn windows_union_and_latest_original_start_wins_after_clip() {
    let req = request(
        ActivitySource::Windows,
        vec![date("2026-10-08")],
        vec![
            event("Old", "2026-10-07T23:59:59.500Z", 3.0),
            event("New", "2026-10-08T00:00:00.250Z", 2.0),
        ],
    );
    let out = summarize(&req, &utc()).unwrap();
    assert!((seconds(&out, "Old") - 0.5).abs() < 1e-9);
    assert!((seconds(&out, "New") - 2.0).abs() < 1e-9);
}

#[test]
fn equal_starts_choose_max_lexical_app() {
    let out = summarize(
        &request(
            ActivitySource::Windows,
            vec![date("2026-10-08")],
            vec![
                event("Alpha", "2026-10-08T00:00:00Z", 4.0),
                event("Zulu", "2026-10-08T00:00:00Z", 4.0),
            ],
        ),
        &utc(),
    )
    .unwrap();
    assert!(out.dates[0]
        .summary
        .as_ref()
        .unwrap()
        .apps
        .iter()
        .all(|v| v.app == "Zulu"));
}

#[test]
fn same_app_overlaps_merge_without_double_counting() {
    let out = summarize(
        &request(
            ActivitySource::Windows,
            vec![date("2026-10-08")],
            vec![
                event("Editor", "2026-10-08T00:00:00Z", 3.0),
                event("Editor", "2026-10-08T00:00:01Z", 3.0),
            ],
        ),
        &utc(),
    )
    .unwrap();
    assert_eq!(seconds(&out, "Editor"), 4.0);
}

#[test]
fn distinct_devices_keep_distinct_identity_and_are_never_collapsed() {
    let mut left = request(
        ActivitySource::Windows,
        vec![date("2026-10-08")],
        vec![event("Editor", "2026-10-08T00:00:00Z", 1.0)],
    );
    let mut right = left.clone();
    right.device_id = "123e4567-e89b-12d3-a456-426614174001".into();
    let a = summarize(&left, &utc()).unwrap();
    let b = summarize(&right, &utc()).unwrap();
    assert_ne!(a.dates[0].identity, b.dates[0].identity);
    assert_ne!(a.device_id, b.device_id);
    left.events.clear();
}

#[test]
fn fractional_duration_is_retained() {
    let out = summarize(
        &request(
            ActivitySource::Windows,
            vec![date("2026-10-08")],
            vec![event("Editor", "2026-10-08T00:00:00Z", 0.000000123)],
        ),
        &utc(),
    )
    .unwrap();
    assert!((seconds(&out, "Editor") - 0.000000123).abs() < 1e-9);
}

#[test]
fn local_offset_midnight_clips_independently() {
    let req = request(
        ActivitySource::Windows,
        vec![date("2026-10-08")],
        vec![event("Editor", "2026-10-07T18:30:00Z", 86_400.0)],
    );

    let zone = FixedOffset::east_opt(5 * 3600 + 30 * 60).unwrap();
    let out = summarize(&req, &zone).unwrap();
    assert_eq!(
        out.dates[0].summary.as_ref().unwrap().foreground_seconds,
        86_400.0
    );
}

#[test]
fn simulated_dst_day_is_23_hours() {
    let zone = Spring;
    let req = request(
        ActivitySource::Windows,
        vec![date("2026-03-29")],
        vec![event("Editor", "2026-03-29T00:00:00Z", 86_400.0)],
    );
    let out = summarize(&req, &zone).unwrap();
    assert_eq!(
        out.dates[0].summary.as_ref().unwrap().foreground_seconds,
        82_800.0
    );
}

#[test]
fn simulated_dst_day_is_25_hours() {
    let zone = Fall;
    let req = request(
        ActivitySource::Windows,
        vec![date("2026-10-25")],
        vec![event("Editor", "2026-10-24T23:00:00Z", 90_000.0)],
    );
    let out = summarize(&req, &zone).unwrap();
    assert_eq!(
        out.dates[0].summary.as_ref().unwrap().foreground_seconds,
        90_000.0
    );
}

#[test]
fn missing_stale_unavailable_and_no_data_are_unknown_without_zero_summary() {
    for status in [
        ObservationStatus::Missing,
        ObservationStatus::Stale,
        ObservationStatus::Unavailable,
    ] {
        let mut req = request(ActivitySource::Windows, vec![date("2026-10-08")], vec![]);
        req.observation_status = status;
        req.observed_at = None;
        let row = &summarize(&req, &utc()).unwrap().dates[0];
        assert!(row.summary.is_none());
        assert_eq!(row.metadata.observed_at, None);
    }
    let out = summarize(
        &request(ActivitySource::Windows, vec![date("2026-10-08")], vec![]),
        &utc(),
    )
    .unwrap();
    assert!(out.dates[0].summary.is_none());
}

#[test]
fn no_observation_for_requested_day_is_unknown() {
    let req = request(
        ActivitySource::Windows,
        vec![date("2026-10-08")],
        vec![event("Editor", "2026-10-09T00:00:00Z", 5.0)],
    );
    assert!(summarize(&req, &utc()).unwrap().dates[0].summary.is_none());
}

#[test]
fn invalid_data_is_rejected_and_cannot_become_good_summary() {
    let mut req = request(
        ActivitySource::Windows,
        vec![date("2026-10-08")],
        vec![event("Editor", "bad", 1.0)],
    );
    assert!(matches!(
        summarize(&req, &utc()),
        Err(SummaryError::InvalidEvent {
            reason: "timestamp",
            ..
        })
    ));
    req.events = vec![event("", "2026-10-08T00:00:00Z", 1.0)];
    assert!(summarize(&req, &utc()).is_err());
    req.events = vec![event("Editor", "2026-10-08T00:00:00Z", f64::NAN)];
    assert!(summarize(&req, &utc()).is_err());
}

#[test]
fn android_different_app_overlap_is_explicitly_rejected() {
    let req = request(
        ActivitySource::Android,
        vec![date("2026-10-08")],
        vec![
            event("A", "2026-10-08T00:00:00Z", 5.0),
            event("B", "2026-10-08T00:00:01Z", 5.0),
        ],
    );
    assert!(matches!(
        summarize(&req, &utc()),
        Err(SummaryError::AmbiguousAndroidOverlap { .. })
    ));
}

#[test]
fn canonical_dates_and_timezone_errors_are_rejected() {
    let mut req = request(ActivitySource::Windows, vec![date("1969-12-31")], vec![]);
    assert!(matches!(
        summarize(&req, &utc()),
        Err(SummaryError::InvalidDate)
    ));
    req.dates = vec![date("2026-10-08")];
    assert!(summarize(&req, &utc()).is_ok());
}

#[test]
fn observed_timestamp_is_validated_but_not_rewritten() {
    let mut req = request(ActivitySource::Windows, vec![date("2026-10-08")], vec![]);
    req.observed_at = Some("2026-10-08T12:34:56.789+05:30".into());
    let out = summarize(&req, &utc()).unwrap();
    assert_eq!(out.dates[0].metadata.observed_at, req.observed_at);
    req.observed_at = Some("not-a-time".into());
    assert!(matches!(
        summarize(&req, &utc()),
        Err(SummaryError::InvalidObservationTimestamp)
    ));
}

#[test]
fn source_is_preserved_per_result() {
    let out = summarize(
        &request(ActivitySource::Android, vec![date("2026-10-08")], vec![]),
        &utc(),
    )
    .unwrap();
    assert_eq!(out.source, ActivitySource::Android);
    assert_eq!(out.dates[0].metadata.source, ActivitySource::Android);
}

#[test]
fn zero_duration_is_no_observation_and_cannot_steal_or_ambiguous() {
    let windows = request(
        ActivitySource::Windows,
        vec![date("2026-10-08")],
        vec![
            event("Live", "2026-10-08T12:00:00Z", 10.0),
            event("Zero", "2026-10-08T12:00:05Z", 0.0),
        ],
    );
    let row = &summarize(&windows, &utc()).unwrap().dates[0];
    assert_eq!(row.summary.as_ref().unwrap().apps[0].app, "Live");
    assert_eq!(row.summary.as_ref().unwrap().foreground_seconds, 10.0);
    let empty = request(
        ActivitySource::Windows,
        vec![date("2026-10-08")],
        vec![event("Zero", "2026-10-08T12:00:00Z", 0.0)],
    );
    assert!(summarize(&empty, &utc()).unwrap().dates[0]
        .summary
        .is_none());
    let android = request(
        ActivitySource::Android,
        vec![date("2026-10-08")],
        vec![
            event("Live", "2026-10-08T12:00:00Z", 10.0),
            event("Zero", "2026-10-08T12:00:05Z", 0.0),
        ],
    );
    assert!(summarize(&android, &utc()).is_ok());
}

#[derive(Clone)]
struct MissingMidnight;
impl TimeZone for MissingMidnight {
    type Offset = FixedOffset;
    fn from_offset(_: &Self::Offset) -> Self {
        Self
    }
    fn offset_from_local_date(&self, _: &NaiveDate) -> MappedLocalTime<Self::Offset> {
        MappedLocalTime::None
    }
    fn offset_from_local_datetime(&self, _: &NaiveDateTime) -> MappedLocalTime<Self::Offset> {
        MappedLocalTime::None
    }
    fn offset_from_utc_date(&self, _: &NaiveDate) -> Self::Offset {
        utc()
    }
    fn offset_from_utc_datetime(&self, _: &NaiveDateTime) -> Self::Offset {
        utc()
    }
}

#[test]
fn missing_local_midnight_is_an_error() {
    let req = request(ActivitySource::Windows, vec![date("2026-10-08")], vec![]);
    assert!(
        matches!(summarize(&req, &MissingMidnight), Err(SummaryError::InvalidTimeZone(day)) if day == date("2026-10-08"))
    );
}

#[test]
fn prior_day_starts_use_original_start_order_after_midnight_clip() {
    let req = request(
        ActivitySource::Windows,
        vec![date("2026-10-08")],
        vec![
            event("Zulu", "2026-10-07T23:59:58Z", 6.0),
            event("Alpha", "2026-10-07T23:59:59Z", 3.0),
        ],
    );
    let row = &summarize(&req, &utc()).unwrap().dates[0];
    assert!((row.summary.as_ref().unwrap().foreground_seconds - 4.0).abs() < 1e-9);
    assert!(
        (seconds(
            &SummaryResult {
                device_id: DEVICE.into(),
                source: ActivitySource::Windows,
                dates: vec![row.clone()]
            },
            "Alpha"
        ) - 2.0)
            .abs()
            < 1e-9
    );
}

#[test]
fn fractional_cross_midnight_interval_splits_across_requested_dates() {
    let req = request(
        ActivitySource::Windows,
        vec![date("2026-10-08"), date("2026-10-09")],
        vec![event("Editor", "2026-10-08T23:59:59.5Z", 1.0)],
    );
    let out = summarize(&req, &utc()).unwrap();
    assert!((out.dates[0].summary.as_ref().unwrap().foreground_seconds - 0.5).abs() < 1e-9);
    assert!((out.dates[1].summary.as_ref().unwrap().foreground_seconds - 0.5).abs() < 1e-9);
    assert_ne!(out.dates[0].identity, out.dates[1].identity);
}

#[test]
fn android_same_app_union_and_out_of_day_overlap_are_safe() {
    let req = request(
        ActivitySource::Android,
        vec![date("2026-10-08")],
        vec![
            event("Editor", "2026-10-08T12:00:00Z", 10.0),
            event("Editor", "2026-10-08T12:00:05Z", 10.0),
            event("Other", "2026-10-09T12:00:00Z", 10.0),
            event("Third", "2026-10-09T12:00:05Z", 10.0),
        ],
    );
    let row = &summarize(&req, &utc()).unwrap().dates[0];
    assert!((row.summary.as_ref().unwrap().foreground_seconds - 15.0).abs() < 1e-9);
}

#[test]
fn unknown_android_state_skips_ownership_policy_and_preserves_none_timestamp() {
    for status in [
        ObservationStatus::Missing,
        ObservationStatus::Stale,
        ObservationStatus::Unavailable,
    ] {
        let mut req = request(
            ActivitySource::Android,
            vec![date("2026-10-08")],
            vec![
                event("A", "2026-10-08T12:00:00Z", 10.0),
                event("B", "2026-10-08T12:00:05Z", 10.0),
            ],
        );
        req.observation_status = status;
        req.observed_at = None;
        let row = &summarize(&req, &utc()).unwrap().dates[0];
        assert!(row.summary.is_none());
        assert_eq!(row.metadata.observed_at, None);
    }
}

#[test]
fn invalid_bounds_apps_uuid_and_special_durations_are_rejected() {
    let mut req = request(
        ActivitySource::Windows,
        vec![date("2026-10-08")],
        vec![event("Editor", "2026-10-08T00:00:00Z", -1.0)],
    );
    assert!(summarize(&req, &utc()).is_err());
    req.events = vec![event("Editor", "2026-10-08T00:00:00Z", f64::INFINITY)];
    assert!(summarize(&req, &utc()).is_err());
    req.events = vec![event("Editor", "2026-10-08T00:00:00Z", 604_800.000_001)];
    assert!(summarize(&req, &utc()).is_err());
    req.events = vec![event("bad\napp", "2026-10-08T00:00:00Z", 1.0)];
    assert!(summarize(&req, &utc()).is_err());
    req.device_id = "not-a-uuid".into();
    assert!(matches!(
        summarize(&req, &utc()),
        Err(SummaryError::InvalidDeviceId)
    ));
}

fn leap_request(events: Vec<ForegroundEvent>, dates: Vec<NaiveDate>) -> SummaryRequest {
    SummaryRequest {
        device_id: DEVICE.into(),
        source: ActivitySource::Windows,
        dates,
        observed_at: Some("2026-10-08T12:34:56Z".into()),
        observation_status: ObservationStatus::Available,
        events,
    }
}

#[test]
fn leap_second_at_midnight_is_rejected_without_day_shift() {
    let req = leap_request(
        vec![event("A", "2016-12-31T23:59:60Z", 0.5)],
        vec![date("2016-12-31"), date("2017-01-01")],
    );
    assert!(matches!(
        summarize(&req, &utc()),
        Err(SummaryError::InvalidEvent {
            reason: "timestamp_leap_second_unsupported",
            ..
        })
    ));
}

#[test]
fn leap_second_fraction_and_offset_are_rejected() {
    for timestamp in ["2016-12-31T23:59:60.25Z", "2017-01-01T05:29:60.25+05:30"] {
        let req = leap_request(
            vec![event("A", timestamp, 0.5)],
            vec![date("2016-12-31"), date("2017-01-01")],
        );
        assert!(matches!(
            summarize(&req, &utc()),
            Err(SummaryError::InvalidEvent {
                reason: "timestamp_leap_second_unsupported",
                ..
            })
        ));
    }
}

#[test]
fn leap_second_in_second_event_reports_index_without_partial_success() {
    let req = leap_request(
        vec![
            event("Good", "2016-12-31T23:59:58Z", 1.0),
            event("Leap", "2016-12-31T23:59:60Z", 0.5),
        ],
        vec![date("2016-12-31")],
    );
    assert!(matches!(
        summarize(&req, &utc()),
        Err(SummaryError::InvalidEvent {
            index: 1,
            reason: "timestamp_leap_second_unsupported"
        })
    ));
}

#[test]
fn ordinary_fractional_second_crosses_midnight_normally() {
    let req = leap_request(
        vec![event("A", "2016-12-31T23:59:59.75Z", 0.5)],
        vec![date("2016-12-31"), date("2017-01-01")],
    );
    let out = summarize(&req, &utc()).unwrap();
    assert_eq!(
        out.dates[0].summary.as_ref().unwrap().foreground_seconds,
        0.25
    );
    assert_eq!(
        out.dates[1].summary.as_ref().unwrap().foreground_seconds,
        0.25
    );
}
#[test]
fn ordinary_next_midnight_and_original_start_order_remain_normal() {
    let req = leap_request(
        vec![
            event("Zulu", "2016-12-31T23:59:58Z", 6.0),
            event("Alpha", "2016-12-31T23:59:59Z", 3.0),
            event("Next", "2017-01-01T00:00:04Z", 1.0),
        ],
        vec![date("2016-12-31"), date("2017-01-01")],
    );
    let out = summarize(&req, &utc()).unwrap();
    assert_eq!(
        out.dates[0].summary.as_ref().unwrap(),
        &ActivitySummary {
            foreground_seconds: 2.0,
            apps: vec![
                AppDuration {
                    app: "Alpha".into(),
                    seconds: 1.0
                },
                AppDuration {
                    app: "Zulu".into(),
                    seconds: 1.0
                },
            ],
        }
    );
    assert_eq!(
        out.dates[1].summary.as_ref().unwrap(),
        &ActivitySummary {
            foreground_seconds: 5.0,
            apps: vec![
                AppDuration {
                    app: "Alpha".into(),
                    seconds: 2.0
                },
                AppDuration {
                    app: "Next".into(),
                    seconds: 1.0
                },
                AppDuration {
                    app: "Zulu".into(),
                    seconds: 2.0
                },
            ],
        }
    );
}
#[test]
fn leap_observed_at_is_metadata_only_and_preserved() {
    let mut req = leap_request(
        vec![event("A", "2016-12-31T23:59:59Z", 0.5)],
        vec![date("2016-12-31")],
    );
    req.observed_at = Some("2016-12-31T23:59:60.25Z".into());
    let out = summarize(&req, &utc()).unwrap();
    assert_eq!(out.dates[0].metadata.observed_at, req.observed_at);
}

#[test]
fn ordinary_fractional_midnight_uses_device_timezone_on_neighbor_dates() {
    let zone = FixedOffset::east_opt(5 * 3600 + 30 * 60).unwrap();
    for timestamp in ["2016-12-31T18:29:59.75Z", "2016-12-31T23:59:59.75+05:30"] {
        let req = leap_request(
            vec![event("A", timestamp, 0.5)],
            vec![date("2016-12-31"), date("2017-01-01")],
        );
        let out = summarize(&req, &zone).unwrap();
        for day in &out.dates {
            assert_eq!(
                day.summary.as_ref().unwrap(),
                &ActivitySummary {
                    foreground_seconds: 0.25,
                    apps: vec![AppDuration {
                        app: "A".into(),
                        seconds: 0.25
                    }],
                }
            );
        }
    }
}
