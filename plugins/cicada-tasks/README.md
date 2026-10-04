# Cicada local tasks plugin 0.4.7

Portable publication bundle for the local Cicada task MCP package.

- `cicada-local-tasks-0.4.7/` — self-contained plugin source;
- `install.py` — plan/apply installer for a user-selected marketplace and
  Codex home;
- no hooks, credentials, profile data, generated receipts, or machine-specific
  paths are included.

Run the installer with explicit paths, for example:

```powershell
python .\install.py --package .\cicada-local-tasks-0.4.7 `
  --user-home $env:USERPROFILE --codex-home "$env:USERPROFILE\.codex" `
  --marketplace-root $env:USERPROFILE --manual-cicada
```

Use `--apply` only after reviewing the plan. Applying requires explicit
`--cicada-profile` and `--pipe-client` paths; the installer refuses conflicting
package, helper, or marketplace entries and is safe to repeat after success.
