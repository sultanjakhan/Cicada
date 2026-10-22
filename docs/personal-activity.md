# Personal activity

The optional activity section keeps observed time separate from task completion.
It adds no daily quota, score, reminder, automatic task start, or automatic task
completion. Missing observations remain unknown.

## Sources

- Windows game activity is collected only after an explicit opt-in and selection
  of executable basenames. Cicada must remain running. The collector stores
  selected executable names and observed UTC intervals, without window titles,
  executable paths, screenshots, or unrelated application history.
- The first collector uses keyboard and mouse activity. Controller-only sessions
  are not reliably covered. Lock, idle, suspension, sampling gaps and application
  restarts break continuity; they are not backfilled as play time.
- Game history is local to this profile in this version. There is no iPad
  collector or device-to-device game-history synchronization. The duration model
  unions intervals instead of adding overlapping time, but that capability does
  not establish a second connected source.
- Walks come from existing Health Connect walking-session events. Steps do not
  become walks. A saved walk interval describes that source record, not verified
  coverage of the entire day or the current permission state of a remote phone.
  New imports preserve validated UTC boundaries in existing encrypted records.
  Older records without these boundaries keep unknown precise timing; a mixture
  of exact and older records is explicitly shown as incomplete.
- Task time comes from existing time records for an explicitly selected task.
  It describes recorded time, not proof of learning or a completed result.

Settings are off by default. Turning collection off stops new observations and
preserves previously recorded history. Settings are local to the device and use
revision checks so a stale editor cannot replace newer choices.

## Verification boundary

Reducer, storage and mounted-interface checks use synthetic data. Native Windows
compilation, real foreground transitions, idle/lock/suspend behavior, the installed
interface and watch-to-phone-to-Cicada delivery need their own evidence. A source
build or successful unit test does not confirm those device scenarios. Native
acceptance stays incomplete until those checks have been performed on the
candidate version.

This implementation continues the observed-state portion of the existing day
summary. It does not decide a mandatory daily minimum or the policy for an empty
Today.
