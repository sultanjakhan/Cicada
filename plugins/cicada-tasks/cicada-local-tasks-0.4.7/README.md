# Cicada local tasks plugin 0.4.7

This is a portable local marketplace package. It connects to an existing Cicada
profile through the existing Windows named-pipe client. Cicada remains the
single task authority; the plugin does not create a second task store.

## Configure one machine

1. Copy `config.example.json` to a private machine location and replace both
   absolute paths with the existing Cicada profile and `LocalPipeClient.exe`.
2. Set `CICADA_LOCAL_CONFIG` to that file, or pass `--config` when registering
   the stdio server. The package never guesses these paths.
3. Register or install the local marketplace. The package contains no hooks and
   does not change `~/.codex`, application data, or production settings.

Example direct check:

```powershell
$env:CICADA_LOCAL_CONFIG = 'C:\private\cicada-local.json'
python .\scripts\cicada_mcp.py
```

Send MCP `initialize`, then `tools/list`. Use `cicada_list_tasks` for a read
check. Mutating tools require the exact task UUID, current version, and an
explicit operation ID.

## Marketplace

`marketplace.json` in the companion marketplace directory exposes this package
as `cicada-local-tasks`. Refresh the Codex desktop app after adding that local
marketplace. Installation is separate from configuring the machine-specific
MCP connection.

The bundled MCP server is intentionally local-only. Public plugin submission
would require a public HTTPS MCP endpoint; this package is not published.
