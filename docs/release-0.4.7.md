# Cicada 0.4.7

Windows local agent access is now part of the public source, rather than a
temporary overlay on an older application. A Windows distribution build must
answer the native API in an isolated profile before packaging succeeds.

An explicitly connected personal task keeps its native ID, description and
history in Cicada. Agent City exchanges a projection and queued operations;
Codex reports observed execution and submits a result. Finishing an agent run
does not start the human timer or complete the task. The owner accepts the
result or returns it for rework, with feedback and previous results retained.

The existing task card shows its process, current stage and next stage.
Templates remain in Settings → Task stages. Stages are optional and advance
independently of manual steps, execution status and task completion. There is
no additional dashboard or automatic process assignment.

Acceptance uses fictional tasks and separate profiles: native pipe requests,
duplicate replay, stage exchange, result/rework/acceptance, offline reconnect
and revision conflicts. This is separate from installed production and physical
Android/macOS acceptance. Windows is the supported private named-pipe transport;
this release does not claim a local agent transport on Android or macOS.

The accompanying local Codex plugin supplies task commands and the execution
instructions. Installing the application, enabling the plugin and configuring
Agent City's explicit task exchange are separate steps.
