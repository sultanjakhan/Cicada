---
name: cicada-task-workflow
description: Use Cicada for authorized multi-step work, including finding or reusing the exact task UUID, stages, observed run reports, immutable results, and human review. Do not activate for generic task advice or an unconfigured connection.
---

Use Cicada as the task authority. This workflow applies only after the user
authorizes the work and an exact task UUID is known or the user authorizes task
creation. Creating a task within the user's assignment is part of that
authorization. Agent execution telemetry is evidence about work; it does not create
a second task database.

1. Read the task list and reuse the exact UUID of the task matching the user's
   authorized work. If no task matches, create one within that assignment. Ask
   only when multiple tasks plausibly match or creation would change the scope.
   Never use a title as identity or create another task on each retry or tool call.
2. Read the task before changing it and retain its current `version`. Use the
   exact UUID, expected revision and a stable `operationId` for mutations.
3. Process stages belong to the task's selected process template. Read its
   configured stage vocabulary and keep the same process/stage IDs. Execution
   status and review state are separate fields. Do not write execution or
   review states such as `running` or `awaiting_review` into the process stage.
4. Report only observed execution with the same task UUID and operation/run ID.
   A report means work was observed; it does not start a model, invent
   telemetry, or complete the human task.
5. Submit an immutable result tied to the completed run. Keep each result and
   review decision in history. A result remains `awaiting_review` until the
   user accepts it or requests changes.
6. On requested changes, send the native review decision `rework`, preserving
   the previous result and feedback. The API creates an `awaiting_dispatch`
   review intent. A new authorized executor run must acknowledge that exact
   intent before reporting new work. Do not replace the process stage or
   silently overwrite or accept the result.
7. Use expected version/revision on every mutation. On a conflict, re-read the
   task and preserve the retained draft. Reconcile reversible changes within the
   existing authorization; ask only when the conflict changes the intended
   result. On an unknown outcome, retry the identical operation ID and payload.
   Never overwrite a newer revision blindly.

The plugin contains no hooks. Configuration is machine-specific and must be
passed through `CICADA_LOCAL_CONFIG` or `--config`; do not commit real paths,
credentials, or profile data.
