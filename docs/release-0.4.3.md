# Cicada 0.4.3 - 20261002-night.2

Local Windows night candidate; not installed or published.

- Task step controls return to the last confirmed status after a failed save.
  Pending step/result drafts remain available for retry.
- Compact task filters, explicit task states, keyboard tab focus and neutral
  light/dark task presentation are inherited from reviewed candidate 7fa8b51.
- Regression coverage includes day rollover, a 5,000-task catalogue, read
  recovery, UTC timer arithmetic and process-only timezone simulation.
- QA helpers refuse the reviewed pre-existing hardlink/junction cases. They do
  not provide full protection against a competing process creating new aliases.

The source delta after 7fa8b51 consists of one workflow UI fix, regression tests,
helper limitation documentation and this version metadata. Timer scheduling,
credentials and database schema are unchanged. No Jira synchronization, model
execution or Agent City implementation is introduced.

Native acceptance belongs to the exact executable hash recorded in the local
manifest. New delta acceptance requires independent review. The previous 7fa8b51
and b3998fb portable executables and rollback evidence are retained separately.
Launch this candidate through the explicit isolated QA launcher until production
installation and the outstanding draft-save confirmation are authorized.
