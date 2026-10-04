# Scoped RU/EN source audit

Base: `80fc325aba10c54f357a4111003238ea3f964ee0`.
Branch: `work/localization-20261004`; isolated clone, shared source unchanged.

Confirmed defects: setting the existing document language to English left task
details, stage-time history and updater settings in Russian. The About build
label was also Russian beside an already bilingual theme selector.

Corrections:
- Task details: action/status/accessibility labels, completion metadata, date
  formatting, time units, process-unavailable notice and fallback error copy.
- Stage-time history: loading/empty/error/current-stage labels, duration units
  and singular/plural deleted-stage labels.
- Shared dialog: Close, Retry, Cancel and Saving labels.
- Settings: About build label and updater phases/actions/channel availability.

Russian remains the default. Language selection follows the existing document
`lang` convention; this change adds no language picker or persistence setting.
Stored task/process/stage names, descriptions, release notes and native error
messages remain verbatim. No native, sync, API or credential changes.

Validation: 74 targeted tests passed; the separate About regression run passed
15 tests. Full npm suite: 612 passed, 5 skipped, 2 failed. Imported-copy timing
failure passed on isolated rerun (3/3). Windows QA file-handle checks failed with
CreateFile access denied in this sandbox. Privacy guard: 0 findings. Vite build
and git diff whitespace checks passed. Rust tests were not run: no Rust changes.

Limits: this is a scoped correction, not whole-application localization. The
workflow Steps and result panel, other settings tabs and connection panels still
contain Russian-only copy. Native GUI/layout acceptance and installed-language
verification were NOT RUN. No installation, GUI use, push or publication.
