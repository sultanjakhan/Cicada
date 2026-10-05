# Cicada 0.5.0

This release combines the available completed Cicada changes from the owner's
personal development chats on the published 0.4.8 source. macOS Apple Silicon,
Windows x64 and Android ARM64 retain the same application and signing identities.

- The workspace adopts the saved Agent City reference's neutral surfaces,
  compact spacing and flat lists. Cicada keeps its Calendar, Tasks, Routines,
  Notes and Goals, both themes, stage controls and parallel timers. Narrow
  layouts retain larger touch targets.
- AI run history and operation receipts live in indexed SQLite tables beyond
  the old 500-entry lifetime limit. The bounded legacy views remain compatible.
  Rework results belong to the run that acknowledged the current intent;
  retries retain immutable receipts. Wire envelopes allow 64 KiB while result
  text retains its 8000 UTF-8-byte limit.
- Desktop settings can prepare a move to an empty local data folder for the
  next launch. A consistent SQLite backup, checked file copies and reprotected
  sync credentials preserve the profile. The original data remains available;
  failed moves retain the original profile and report recovery status. The
  Windows agent endpoint keeps its original namespace. DEV and isolated
  profiles cannot prepare production moves; Android does not expose this action.
- The Mac updater recognizes the owned installation in
  `~/Projects/Cicada/application/Cicada.app` through its standard
  `~/Applications/Cicada.app` alias. Arbitrary copies remain excluded. Generated
  LaunchAgent paths may be updated; custom configuration is preserved.
- Settings, updates, task details, process controls, sync and health panels
  include the completed English strings when hosted with an English document
  language. Russian remains the application's default; stored user text is
  unchanged. This is not a claim that every workspace string is translated.
- Task lists index goal links and goal records instead of searching them for
  every row. Service CI adds tests and dependency audits for both services.
- The portable local task plugin is packaged as 0.5.0 with the larger envelope
  limit, a guarded upgrade from 0.4.8 and preservation of the previous cache.

The selected-task focus and compact Windows window from 0.4.8 remain available.
Background updates check and prepare signed packages automatically. Installation,
restart and system confirmation still require the user's action; unsaved drafts
and pending mutations block installation.

An Android home-screen widget, general Undo and Windows patches whose exact
source was unavailable are not included. Audit reports and unfinished Agent City
work are not shipped as Cicada features.

CI builds, signature checks, browser fixtures and installed-device acceptance
are separate evidence levels. Physical Windows/Android acceptance and a real
Mac upgrade must be reported from their actual observations, not inferred from
this source document or from a successful build.
