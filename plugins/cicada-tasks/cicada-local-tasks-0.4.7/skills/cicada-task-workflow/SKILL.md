---
name: cicada-task-workflow
description: Work against an exact Cicada task UUID with explicit stages, reports, results, and human review.
---

Use Cicada as the task authority. Agent execution telemetry is evidence about
work; it does not create a second task database.

1. Read the task list and reuse the exact UUID of the task matching the user's
   authorized work. When no matching task exists, create one with a meaningful
   title through the Cicada API within that authorized scope. Never use a title
   as identity or create another task on each retry or tool call.
2. Read the task before changing it and retain its current `version`.
3. Process stages belong to the task's selected process template. Read its
   configured stage vocabulary and keep the same process/stage IDs. Execution
   status and review state are separate fields. Do not write execution or
   review states such as `running` or `awaiting_review` into the process stage.
4. Report observed execution with the same task UUID and operation/run ID.
   A report means work was observed; it does not start a model and does not
   complete the human task.
5. Submit an immutable result tied to the completed run. Keep each result and
   review decision in history. A result remains `awaiting_review` until the
   user accepts it or requests changes.
6. On requested changes, send the native review decision `rework`, preserving
   the previous result and feedback. The API creates an `awaiting_dispatch`
   review intent. A new authorized executor run must acknowledge that exact
   intent before reporting new work. Do not replace the process stage or
   silently overwrite or accept the result.
7. Use expected version/revision on every mutation. On a conflict, re-read the
   task and preserve the retained draft. Reconcile reversible changes within
   the user's existing instructions; ask only if the conflict changes their
   intended result. Never overwrite a newer revision blindly.

The plugin contains no hooks. Configuration is machine-specific and must be
passed through `CICADA_LOCAL_CONFIG` or `--config`; do not commit real paths,
credentials, or profile data.
