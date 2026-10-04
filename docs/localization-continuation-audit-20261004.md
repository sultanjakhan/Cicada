# RU/EN localization continuation and failure audit

Exact base: `80fc325aba10c54f357a4111003238ea3f964ee0`.
Parent packet: `6669125d2656ddc8e2a39f5aaa73be906b8d2be9`.
Branch: `work/localization-20261004`; isolated clone, shared source/runtime untouched.

The continuation closes the previously reported Russian-only Steps and result
panel, result-review/history captions and existing settings/connections: tabs,
preferences, confirmations, process controls/validation, sync/conflict captions,
Health Connect states, folder sources, registry import and personal-import controls.
The Settings entry and dirty-footer caption also follow the document language.

Only author-owned UI literals enter the copy helper. User task/step/process/stage
names, descriptions, results, comments, paths, service preview fields and release
notes remain verbatim. Stored definitions are not renamed. Calendar default-view
enum values stay Russian while their labels translate. Native error messages not
recognized as known model messages remain verbatim. Request commands/arguments,
keys, credentials, sync behavior, receipt formats, recovery-export payload and
adapter contracts are unchanged. No language picker or new preference is added.

## Earlier full-suite failures

1. `Windows QA preparation rejects hardlinks/junctions and pins identity before
   writing` (`tests/qa-files.test.mjs`): reproduced in the normal full suite on exact
   base (608 pass, 1 fail, 5 skip). Python fails in `qa_files.checked_handle` at
   `win32file.CreateFile` with error 5, access denied. Changed candidate has the same
   failure. Classification: environment-blocked file-handle verification, not a
   localization regression. No permission bypass, escalation or GUI attempted.
2. `imported task copy translates every recorded status without implying live
   execution or writing` (`tests/imported-copy-onboarding.test.mjs`): stock base
   full run and initial candidate standalone rerun passed. Failing runs asserted
   while the view still showed Loading steps. The test used a fixed 20 ms sleep.
   A diagnostic on exact base, delaying only mock get_ui_state responses by 40 ms,
   reproduced the same premature assertion (0 pass, 1 fail). Its source dependencies
   and test were unchanged from base to the first packet when the failure appeared.
   Classification: inherited timing assumption in the test, demonstrated under
   controlled read latency. Ordinary baseline nondeterministic reproduction is not
   claimed. The test now waits for aria-busy=false with a 2-second bound. A delayed
   English/read-only regression checks actual completion and imported labels.

## Verification and limits

- Focused continuation regressions: 26/26 passed, including RU defaults, EN labels,
  user strings, enum values and read-only command contracts.
- Full suite before the final hint correction: 621 passed, 1 failed, 5 skipped; Windows QA remains blocked.
  NOT full PASS. Native GUI/layout and installed-language acceptance: NOT RUN.
- Vite build, privacy guard and git diff whitespace checks passed. No Rust tests:
  no Rust changes. Existing >500 kB chunk warning remains informational.
- Independent review found a mixed-language process hint. The full sentence now
  uses its existing English translation; an exact DOM assertion covers it. The
  focused 26-test suite passed again after the correction. Independent reviewer
  accepted the final source/headless delta: exact RU/EN hint, read-only command
  arguments and 7/7 extension tests passed; no remaining defects found within
  reviewed scope. Native visual remains NOT RUN. No install, push or GUI.

Primary logs in the parent workspace: localization-base-full-tests.log,
localization-base-delay-probe.log, localization-extension-regressions.log and
localization-extension-final-full.log. The controlled probe lives only in the
isolated baseline clone; baseline product source is unchanged.


## Final review correction: QA-LOC-001

The frozen final review superseded the earlier source/headless acceptance with
REQUEST CHANGES: unknown English error strings such as constructor, toString
and __proto__ looked up inherited Object.prototype values. This corrupted their
rendered text, without changing stored data or commands.

copyForLanguage now translates only Object.hasOwn dictionary keys and returns
unknown values unchanged. Two regressions failed before the fix (helper fallback
and real process-panel errors); after it, all 31 focused tests passed across
localization-extension, localization-regression, settings-tabs and imported-copy.
The panel regression confirms get_ui_state({key: calendar_processes_v1}) only.

Final build and privacy guard passed; whitespace check passed. Full suite was not
repeated for this small fallback correction: the known Windows CreateFile blocker
is unchanged, and the previous frozen full result remains 621 passed, 1 failed,
5 skipped. No full PASS or final independent acceptance is claimed. Independent
closure of QA-LOC-001 remains pending. Native visual: NOT RUN; no GUI/install/push.

Correction logs in the parent workspace: localization-inherited-fallback-before.log,
localization-inherited-fallback-focused.log, localization-inherited-fallback-build.log
and localization-inherited-fallback-privacy.log.
