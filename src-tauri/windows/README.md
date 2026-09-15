# Scoped NSIS update hook

Tauri's standard NSIS `CheckIfAppIsRunning` searches and terminates processes
by executable basename. `update-hooks.nsh` replaces that macro after Tauri has
included `utils.nsh`.

For an install/update it acts only on `$INSTDIR\hanni-mvp.exe`: it renames the
previous binary to `hanni-mvp.exe.previous-${VERSION}` and lets Tauri copy the
new binary. It never calls `FindProcess*` or `KillProcess*`. A name collision
or rename failure aborts before the template overwrites files. The previous
binary remains as a rollback artifact and is never overwritten by this hook.

The same override also makes uninstall decline basename-wide termination. The
stock template's later file removal can be deferred by Windows if the target
binary is still open; this is preferable to terminating another Hanni MVP
instance. A future uninstaller-specific path must remain scoped to `$INSTDIR`.

The integrator must opt in through the existing Tauri NSIS configuration:

```json
{
  "bundle": {
    "windows": {
      "nsis": {
        "installerHooks": "windows/update-hooks.nsh"
      }
    }
  }
}
```

This hook depends on Tauri including the hook after `utils.nsh`; its compile
time `!ifmacrondef` intentionally fails the package if that contract changes.
`tests/windows-update-hooks.test.mjs` checks this source contract and compiles
a small NSIS fixture when `makensis.exe` is available.
