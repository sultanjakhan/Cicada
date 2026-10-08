//! Pure daily digital-activity summarization over already-sanitized foreground events.
//!
//! Redaction and source validation happen upstream. Each request covers exactly
//! one device/source and applies its caller-supplied status to every requested
//! date; no age cutoff, completeness, rest, or restoration state is inferred.
//! Supply separate requests when dates have different observation states.
//! Device timezone boundaries come from the supplied chrono `TimeZone`.
//! Results are per-device records and never sum across devices. Available input
//! still yields `summary: None` when no day observation exists. Durations retain
//! fractional seconds without per-segment quantization.
use chrono::{DateTime, LocalResult, NaiveDate, TimeZone, Utc};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;
const MAX_EVENT_SECONDS: f64 = 7.0 * 86_400.0;
#[derive(Debug, Clone, PartialEq)]
pub struct ForegroundEvent {
    pub app: String,
    pub timestamp: String,
    pub duration_seconds: f64,
}
impl ForegroundEvent {
    pub fn new(
        app: impl Into<String>,
        timestamp: impl Into<String>,
        duration_seconds: f64,
    ) -> Self {
        Self {
            app: app.into(),
            timestamp: timestamp.into(),
            duration_seconds,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservationStatus {
    Available,
    Missing,
    Stale,
    Unavailable,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivitySource {
    Windows,
    Android,
}
#[derive(Debug, Clone)]
pub struct SummaryRequest {
    pub device_id: String,
    pub source: ActivitySource,
    pub dates: Vec<NaiveDate>,
    pub observed_at: Option<String>,
    pub observation_status: ObservationStatus,
    pub events: Vec<ForegroundEvent>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateMetadata {
    pub device_id: String,
    pub source: ActivitySource,
    pub observed_at: Option<String>,
    pub observation_status: ObservationStatus,
}
#[derive(Debug, Clone, PartialEq)]
pub struct AppDuration {
    pub app: String,
    pub seconds: f64,
}
#[derive(Debug, Clone, PartialEq)]
pub struct ActivitySummary {
    pub foreground_seconds: f64,
    pub apps: Vec<AppDuration>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct DailyActivity {
    pub date: NaiveDate,
    pub identity: String,
    pub metadata: DateMetadata,
    pub summary: Option<ActivitySummary>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct SummaryResult {
    pub device_id: String,
    pub source: ActivitySource,
    pub dates: Vec<DailyActivity>,
}
#[derive(Debug, Clone, PartialEq)]
pub enum SummaryError {
    InvalidDeviceId,
    InvalidObservationTimestamp,
    InvalidEvent {
        index: usize,
        reason: &'static str,
    },
    InvalidDate,
    EmptyDateSet,
    InvalidTimeZone(NaiveDate),
    AmbiguousAndroidOverlap {
        first_app: String,
        second_app: String,
    },
}
impl std::fmt::Display for SummaryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for SummaryError {}
#[derive(Debug, Clone)]
struct Interval {
    app: String,
    start: DateTime<Utc>,
    duration_seconds: f64,
}
#[derive(Debug, Clone, Copy)]
struct Bounds {
    start: DateTime<Utc>,

    seconds: f64,
}
fn local_midnight<T: TimeZone>(date: NaiveDate, zone: &T) -> Result<DateTime<Utc>, SummaryError> {
    let local = date.and_hms_opt(0, 0, 0).ok_or(SummaryError::InvalidDate)?;
    let instant = match zone.from_local_datetime(&local) {
        LocalResult::Single(v) => v,
        LocalResult::Ambiguous(a, b) => a.min(b),
        LocalResult::None => return Err(SummaryError::InvalidTimeZone(date)),
    };
    Ok(instant.with_timezone(&Utc))
}
fn day_bounds<T: TimeZone>(date: NaiveDate, zone: &T) -> Result<Bounds, SummaryError> {
    let start = local_midnight(date, zone)?;
    let end = local_midnight(date.succ_opt().ok_or(SummaryError::InvalidDate)?, zone)?;
    let nanos = (end - start)
        .num_nanoseconds()
        .ok_or(SummaryError::InvalidDate)?;
    if nanos <= 0 {
        return Err(SummaryError::InvalidTimeZone(date));
    }
    Ok(Bounds {
        start,
        seconds: nanos as f64 / 1_000_000_000.0,
    })
}
fn supported(date: NaiveDate) -> bool {
    date >= NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()
        && date <= NaiveDate::from_ymd_opt(9999, 12, 30).unwrap()
}
fn relative(start: DateTime<Utc>, origin: DateTime<Utc>) -> f64 {
    (start.timestamp() - origin.timestamp()) as f64
        + (start.timestamp_subsec_nanos() as f64 - origin.timestamp_subsec_nanos() as f64)
            / 1_000_000_000.0
}
fn parse_event(index: usize, event: &ForegroundEvent) -> Result<Interval, SummaryError> {
    let app = event.app.trim();
    if app.is_empty() || app.as_bytes().len() > 200 || app.chars().any(char::is_control) {
        return Err(SummaryError::InvalidEvent {
            index,
            reason: "app",
        });
    }
    if !event.duration_seconds.is_finite()
        || event.duration_seconds < 0.0
        || event.duration_seconds > MAX_EVENT_SECONDS
    {
        return Err(SummaryError::InvalidEvent {
            index,
            reason: "duration",
        });
    }
    let start = DateTime::parse_from_rfc3339(&event.timestamp)
        .map_err(|_| SummaryError::InvalidEvent {
            index,
            reason: "timestamp",
        })?
        .with_timezone(&Utc);
    Ok(Interval {
        app: app.into(),
        start,
        duration_seconds: event.duration_seconds,
    })
}
fn validate_request(
    request: &SummaryRequest,
) -> Result<(Vec<NaiveDate>, Vec<Interval>), SummaryError> {
    let uuid = Uuid::parse_str(&request.device_id).map_err(|_| SummaryError::InvalidDeviceId)?;
    if uuid.to_string() != request.device_id {
        return Err(SummaryError::InvalidDeviceId);
    }
    if request
        .observed_at
        .as_deref()
        .is_some_and(|value| DateTime::parse_from_rfc3339(value).is_err())
    {
        return Err(SummaryError::InvalidObservationTimestamp);
    }
    if request.dates.is_empty() {
        return Err(SummaryError::EmptyDateSet);
    }
    let mut dates = BTreeSet::new();
    for &date in &request.dates {
        if !supported(date) {
            return Err(SummaryError::InvalidDate);
        }
        dates.insert(date);
    }
    let mut intervals = request
        .events
        .iter()
        .enumerate()
        .map(|(i, e)| parse_event(i, e))
        .collect::<Result<Vec<_>, _>>()?;
    intervals.sort_by(|a, b| {
        (&a.start, &a.app, &a.duration_seconds)
            .partial_cmp(&(&b.start, &b.app, &b.duration_seconds))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    intervals.dedup_by(|a, b| {
        a.start == b.start && a.app == b.app && a.duration_seconds == b.duration_seconds
    });
    Ok((dates.into_iter().collect(), intervals))
}
fn clipped_changes(intervals: &[Interval], bounds: Bounds) -> (Vec<f64>, Vec<(f64, usize, bool)>) {
    let mut points = vec![0.0, bounds.seconds];
    let mut changes = Vec::new();
    for (i, item) in intervals.iter().enumerate() {
        let start = relative(item.start, bounds.start);
        let end = start + item.duration_seconds;
        if end > 0.0 && start < bounds.seconds {
            let from = start.max(0.0);
            let to = end.min(bounds.seconds);
            if to <= from {
                continue;
            }
            points.push(from);
            points.push(to);
            changes.push((from, i, true));
            changes.push((to, i, false));
        }
    }
    points.sort_by(f64::total_cmp);
    points.dedup_by(|a, b| a == b);
    changes.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.2.cmp(&b.2)));
    (points, changes)
}
fn check_android_day(intervals: &[Interval], bounds: Bounds) -> Result<(), SummaryError> {
    let (points, changes) = clipped_changes(intervals, bounds);
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut cursor = 0;
    for pair in points.windows(2) {
        while cursor < changes.len() && changes[cursor].0 <= pair[0] {
            let (_, index, adding) = changes[cursor];
            let app = intervals[index].app.clone();
            if adding {
                *counts.entry(app).or_insert(0) += 1;
            } else {
                if let Some(n) = counts.get_mut(&app) {
                    *n -= 1;
                    if *n == 0 {
                        counts.remove(&app);
                    }
                }
            }
            cursor += 1;
        }
        if counts.len() > 1 {
            let mut names = counts.keys();
            return Err(SummaryError::AmbiguousAndroidOverlap {
                first_app: names.next().unwrap().clone(),
                second_app: names.next().unwrap().clone(),
            });
        }
    }
    Ok(())
}
fn add_winners(apps: &mut BTreeMap<String, f64>, intervals: &[Interval], bounds: Bounds) {
    let (points, changes) = clipped_changes(intervals, bounds);
    let mut active: BTreeSet<(DateTime<Utc>, String, usize)> = BTreeSet::new();
    let mut cursor = 0;
    for pair in points.windows(2) {
        while cursor < changes.len() && changes[cursor].0 <= pair[0] {
            let (_, index, adding) = changes[cursor];
            let key = (intervals[index].start, intervals[index].app.clone(), index);
            if adding {
                active.insert(key);
            } else {
                active.remove(&key);
            }
            cursor += 1;
        }
        if let Some((_, app, _)) = active.iter().next_back() {
            *apps.entry(app.clone()).or_insert(0.0) += pair[1] - pair[0];
        }
    }
}
/// `summary: None` is explicit unknown/no-day-data and must not be projected as an empty zero record.
pub fn summarize<T: TimeZone>(
    request: &SummaryRequest,
    zone: &T,
) -> Result<SummaryResult, SummaryError> {
    let (dates, intervals) = validate_request(request)?;
    let metadata = DateMetadata {
        device_id: request.device_id.clone(),
        source: request.source,
        observed_at: request.observed_at.clone(),
        observation_status: request.observation_status,
    };
    let mut result = Vec::with_capacity(dates.len());
    for date in dates {
        let bounds = day_bounds(date, zone)?;
        if request.source == ActivitySource::Android
            && request.observation_status == ObservationStatus::Available
        {
            check_android_day(&intervals, bounds)?;
        }
        let mut apps = BTreeMap::new();
        if request.observation_status == ObservationStatus::Available {
            add_winners(&mut apps, &intervals, bounds);
        }
        let summary =
            if request.observation_status == ObservationStatus::Available && !apps.is_empty() {
                Some(ActivitySummary {
                    foreground_seconds: apps.values().sum(),
                    apps: apps
                        .into_iter()
                        .map(|(app, seconds)| AppDuration { app, seconds })
                        .collect(),
                })
            } else {
                None
            };
        result.push(DailyActivity {
            date,
            identity: format!("digital-activity:{}:{}", request.device_id, date),
            metadata: metadata.clone(),
            summary,
        });
    }
    Ok(SummaryResult {
        device_id: request.device_id.clone(),
        source: request.source,
        dates: result,
    })
}
