# Cicada 0.4.8

This release continues the accepted design work and corrects confirmed refresh
and routine-editor defects. The Russian interface and stored record identities
remain compatible with 0.4.7.

- Task creation puts the name and working/personal choice first. Scheduling,
  process, goal and other optional fields remain in a separate disclosure.
- An empty Routines pane explains the next action through the shared Create menu.
  The routine editor separates one action from a list of steps, exposes check/time
  tracking and groups schedule, skip and dependency controls separately.
- Routine step tracking survives rerendering and reordering. Invalid fields
  reveal their containing section before receiving focus.
- Compact focus uses the selected task or routine, preserves parallel timers and
  restores the previous native window frame when closed.
- Quiet task refresh retains unchanged choice buttons and focus. Real changes
  still update the list. Task details distinguish recorded time from the estimate.
- Notes refresh reads the complete active/archive set in one database query.
  It no longer treats 200 records as truncation or performs one query per note.
- The agent-durable build keeps operation receipts and run history in indexed
  local SQLite tables beyond the former 500-entry lifetime limit. Legacy state
  migrates atomically; repeated operations retain their original receipts.
- Rework results must come from the run that acknowledged the current intent.
  Existing acknowledgements recover only from unambiguous immutable receipts;
  missing evidence blocks submission rather than completing another run's work.
- Agent wire envelopes admit up to 64KiB of escaped JSON, while task result text
  still has its existing 8000 UTF-8-byte limit. Timer start and human acceptance
  remain separate actions.

Windows native DEV acceptance and signed CI delivery are separate gates.
Publication does not establish installation or physical macOS/Android acceptance.
The broader product queue, including the empty-Today policy, remains separate.
