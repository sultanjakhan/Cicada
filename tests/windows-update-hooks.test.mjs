import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const hook = readFileSync(new URL('../src-tauri/windows/update-hooks.nsh', import.meta.url), 'utf8');

test('NSIS hook replaces the basename killer with a target-path rename', () => {
  const executableLines = hook.split(/\r?\n/).filter(line => !line.trimStart().startsWith(';')).join('\n');
  assert.match(hook, /!ifmacrondef CheckIfAppIsRunning/);
  assert.match(hook, /!macroundef CheckIfAppIsRunning/);
  assert.match(hook, /Rename "\$INSTDIR\\\$\{executableName\}" "\$INSTDIR\\\$\{executableName\}\.previous-\$\{VERSION\}"/);
  assert.match(hook, /IfErrors hanni_update_rename_failed/);
  assert.match(hook, /IfFileExists "\$INSTDIR\\\$\{executableName\}\.previous-\$\{VERSION\}" hanni_update_backup_exists/);
  assert.doesNotMatch(executableLines, /(?:FindProcess|KillProcess)/);
});

test('NSIS hook compiles after a stock CheckIfAppIsRunning definition when makensis is available', t => {
  const candidates = [
    process.env.NSIS_MAKENSIS,
    'C:\\Users\\user\\AppData\\Local\\tauri\\NSIS\\makensis.exe',
  ].filter(Boolean);
  const makensis = candidates.find(existsSync);
  if (!makensis) return t.skip('makensis is unavailable on this host');

  const dir = mkdtempSync(join(tmpdir(), 'hanni-nsis-hook-'));
  try {
    const script = join(dir, 'fixture.nsi');
    const escapedHook = new URL('../src-tauri/windows/update-hooks.nsh', import.meta.url)
      .pathname.replace(/^\//, '').replaceAll('/', '\\\\');
    writeFileSync(script, [
      'Unicode true',
      '!define VERSION "0.3.5"',
      '!macro CheckIfAppIsRunning executableName productName',
      '  DetailPrint "unsafe ${executableName}"',
      '!macroend',
      `!include "${escapedHook}"`,
      'OutFile "fixture.exe"',
      'Section "Install"',
      '  StrCpy $INSTDIR "$TEMP\\Hanni MVP"',
      '  !insertmacro CheckIfAppIsRunning "hanni-mvp.exe" "Hanni MVP"',
      'SectionEnd',
      'Section "un.Uninstall"',
      '  StrCpy $INSTDIR "$TEMP\\Hanni MVP"',
      '  !insertmacro CheckIfAppIsRunning "hanni-mvp.exe" "Hanni MVP"',
      'SectionEnd',
    ].join('\r\n'), 'utf8');
    const run = spawnSync(makensis, ['/V2', script], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  } finally {
    rmSync(dir, { recursive:true, force:true });
  }
});
