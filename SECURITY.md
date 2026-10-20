# Security policy

## Supported versions

Only the [latest release](https://github.com/sultanjakhan/Cicada/releases/latest) receives security fixes.

## Reporting a vulnerability

Please do not open a public issue. Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**.

Include what is affected, steps to reproduce and the impact you see. Cicada has one maintainer, so reports are handled on a best-effort basis.

## Scope

Especially relevant areas:

- the end-to-end encrypted sync and the sync relay (`sync-relay/`);
- update signing and delivery (`update-service/`, the in-app updater);
- local data storage and backups;
- how sync credentials are stored on each platform.
