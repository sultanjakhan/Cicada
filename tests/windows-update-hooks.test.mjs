import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = readFileSync(new URL('../src-tauri/windows/update-hooks.nsh', import.meta.url), 'utf8');
const template = readFileSync(new URL('../src-tauri/windows/installer.nsi', import.meta.url), 'utf8');
const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));

test('Cicada NSIS retains the installed executable, registry identity and directory', () => {
  assert.equal(config.productName, 'Cicada');
  assert.equal(config.identifier, 'app.hanni.mvp');
  assert.equal(config.mainBinaryName, 'hanni-mvp');
  assert.equal(config.bundle.publisher, 'Hanni MVP');
  assert.equal(config.bundle.windows.nsis.startMenuFolder, 'Cicada');
  assert.match(template, /!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hanni MVP"/);
  assert.match(template, /!define MANUPRODUCTKEY "\$\{MANUKEY\}\\Hanni MVP"/);
  assert.match(template, /StrCpy \$INSTDIR "\$LOCALAPPDATA\\Programs\\Hanni MVP"/);
  assert.match(template, /WriteRegStr SHCTX "\$\{UNINSTKEY\}" "DisplayName" "\$\{PRODUCTNAME\}"/);
  assert.match(hook, /IsShortcutTarget "\$SMPROGRAMS\\Hanni MVP\\Hanni MVP\.lnk" "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"/);
  assert.match(hook, /IsShortcutTarget "\$DESKTOP\\Hanni MVP\.lnk" "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"/);
  assert.match(hook, /\$\{If\} \$\{FileExists\} "\$SMPROGRAMS\\Cicada\\Cicada\.lnk"/);
  assert.match(hook, /\$\{If\} \$\{FileExists\} "\$DESKTOP\\Cicada\.lnk"/);
  assert.match(template, /\$\{If\} \$\{FileExists\} "\$DESKTOP\\\$\{PRODUCTNAME\}\.lnk"/);
});

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
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'makensis.exe'),
  ].filter(Boolean);
  const makensis = candidates.find(existsSync);
  if (!makensis) return t.skip('makensis is unavailable on this host');

  const dir = mkdtempSync(join(tmpdir(), 'hanni-nsis-hook-'));
  try {
    const script = join(dir, 'fixture.nsi');
    const escapedHook = fileURLToPath(new URL('../src-tauri/windows/update-hooks.nsh', import.meta.url));
    writeFileSync(script, [
      'Unicode true',
      '!include LogicLib.nsh',
      '!define VERSION "0.3.5"',
      '!define MAINBINARYNAME "hanni-mvp"',
      '!macro IsShortcutTarget shortcut target',
      '  Push 0',
      '!macroend',
      '!macro SetLnkAppUserModelId shortcut',
      '!macroend',
      '!macro CheckIfAppIsRunning executableName productName',
      '  DetailPrint "unsafe ${executableName}"',
      '!macroend',
      `!include "${escapedHook}"`,
      'OutFile "fixture.exe"',
      'Section "Install"',
      '  StrCpy $INSTDIR "$TEMP\\Hanni MVP"',
      '  !insertmacro CheckIfAppIsRunning "hanni-mvp.exe" "Hanni MVP"',
      '  !insertmacro NSIS_HOOK_POSTINSTALL',
      'SectionEnd',
      'Section "un.Uninstall"',
      '  StrCpy $INSTDIR "$TEMP\\Hanni MVP"',
      '  !insertmacro CheckIfAppIsRunning "hanni-mvp.exe" "Hanni MVP"',
      'SectionEnd',
    ].join('\r\n'), 'utf8');
    const run = spawnSync(makensis, ['/V2', script], { encoding: 'utf8', cwd:dir });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  } finally {
    rmSync(dir, { recursive:true, force:true });
  }
});
