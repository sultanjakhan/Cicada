# Audit fixes: DEV acceptance, 2026-09-27

This candidate starts at public `main` commit `875a355` and contains only the
timer, task indexing, notes loading, service dependency and CI fixes. It does
not include the parallel task-control UI work or Agent City changes. The issue
tracker remains the operational source of truth.

## Result

- Task and schedule totals expose exact closed seconds. The in-progress widget
  uses them and still adds active elapsed time separately. Legacy minute fields
  remain available.
- Task-to-goal and goal-ID maps replace repeated linear lookups. The first
  match, string-normalized IDs, cyclic ancestry and refresh behavior are covered.
- Notes load through one IPC call and one full-row SELECT. Filters, archive,
  order and rich metadata remain available. The unsupported 200-note warning is
  removed; no artificial limit was introduced. Empty searches now avoid an
  extra SQL bind parameter.
- Both service packages have pinned dependency locks, tests and dependency
  audits in Windows/macOS CI. The dependency update removes the vulnerable
  `sharp` chain. Miniflare remains the exact alpha version required by the
  current Wrangler package, rather than an unverified older downgrade.
- Rust CI caching uses a pinned action revision and the actual Cargo target
  directory. Windows tests decode file URLs correctly and compile NSIS test
  input as UTF-8.
- The checkpoint expiry test explicitly expires its old lease in a test-only
  Durable Object fixture. A 100 ms real lease made the succeeding upload expire
  on busy Windows CI hosts. Production lease rules and service code are unchanged.
  The manual GC test also disables scheduling only in its fixture so a real
  alarm cannot remove a page during restart before the asserted manual calls.
  Automatic alarm recovery remains covered by its separate unchanged test.
- Invalid routes still have GET and empty-POST HTTP checks. POST-body rejection
  runs against the same Worker through Miniflare's service proxy because its
  loopback HTTP bridge intermittently resets early responses to unread bodies
  ([upstream report](https://github.com/cloudflare/workers-sdk/issues/15819)).
  This was reproduced on the pinned runtime; no retry, skipped assertion or
  production body-draining workaround was introduced. The proxy check does not
  prove that the upstream HTTP transport defect is fixed.

## Local checks

- 361 JavaScript tests passed on a Windows path containing Cyrillic characters.
- 173 Rust tests passed; five diagnostic/integration tests remain explicitly
  ignored by the default suite. The notes diagnostic benchmark was run
  separately by the worker.
- Frontend and native debug builds passed. Vendor integrity, root npm audit,
  privacy and public-history checks passed. Service test evidence and full
  hosted checks are recorded separately in the review.
- Independent read-only reviews of the timer/index and notes changes found no
  confirmed defects. This is bounded review, not a security guarantee.

## Native Windows checks

The installed baseline executable and embedded DEV executable ran on an
isolated inactive Windows desktop through the official Playwright MCP and
real WebView2/Rust/SQLite. Neither the owner's running windows nor their data
were operated on. Both variants used the same synthetic database, WebView2
version and 760-by-720 viewport.

The fixture contains 5,000 tasks, 100 linked goals, 1,000 active notes and one
archived note. One task starts with a closed 100-second block.

| Check | Baseline | Candidate |
| --- | --- | --- |
| Search tasks, warm median | about 1,546 ms | 16.5 ms |
| Filter tasks by goal, warm median | about 781 ms | 7.0 ms |
| Notes read, 1,001 rows, warm median | 77.1 ms | 51.8 ms |
| Notes pane opening, one observation | 431 ms | 338 ms |
| Timer initially | `01:00` | `01:40` |

Search returns the same 1,000 matches; the goal filter returns the same 50
matches. Task timing covers event handling and forced layout, not compositor
paint or overall application speed. IPC readings include serialization and
transport. The first of six repeated observations is warm-up; these are local
synthetic measurements, not a device-wide latency promise.

Additional native samples with the same 100-goal relationship pattern:

| Tasks | Search median before / after | Goal filter before / after |
| --- | --- | --- |
| 100 | 10.4 / 13.8 ms | 1.6 / 1.1 ms |
| 1,000 | 76.9 / 14.1 ms | 34.4 / 1.9 ms |
| 5,000, reverse-order confirmation | 1,619.6 / 16.9 ms | 763.2 / 8.9 ms |

The 100-task sample shows no search benefit; its timings overlap at roughly
one frame. This optimization pays off on larger lists. Task IPC itself is not
optimized here. Exact IDs/order on two pages and the goal-filtered result were
verified; changing a relation through real IPC changed the filter from 10 to 11
records, and restoring it returned the original 10 IDs.

The candidate shows all 1,000 active notes, the archived note and the earliest
note found through search, without the false warning. Both native note payloads
are 706,379 bytes. The separate Rust diagnostic compared complete merged JSON
payloads byte-for-byte: 372 to 1 SQL statements at 100 notes and 3,716 to 1 at
1,000 notes, with identical data.

At 100 native notes (99 active, one archived), the read median changed from
9.7 to 7.2 ms and opening from 45.5 to 36 ms; both payloads were 65,270 bytes.
Separate native profiles with 199, 200 and 201 total notes each retained one
archived record, found the oldest record, preserved rich blocks and version,
and showed no false warning. SQLite, IPC and visible/filter counts agreed.

Native Continue and Pause changed the fixture from 100 to 103 seconds. Closing
and restarting the process preserved `01:43`, an unfinished task and no running
timer. Screenshots confirmed the paused display; console checks reported zero
errors. QA desktop monitoring reported no activation.

Machine-local raw evidence and the candidate executable are in the ignored
`.local/fixes-6f2a/` directory; isolated profiles and screenshots are under
`.local/background-qa/fixes-6f2a-before/` and `fixes-6f2a-after/`. The DEV executable
SHA-256 is `e07805c370b53e39c5943a3b3d0936865c19861a393f1ea112fff8ae48455fb9`.

Main integration, installation over stable, macOS live UI and production relay
or update deployment are outside this DEV acceptance. Hosted CI and cache
restore evidence must be read from the linked run, not inferred from local
checks. No paid provider, deployment or repository spending limit was enabled.
