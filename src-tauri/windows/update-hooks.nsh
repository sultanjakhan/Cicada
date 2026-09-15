; Scoped Windows update hook for the Tauri NSIS template.
;
; Tauri's stock CheckIfAppIsRunning macro finds and terminates every process
; with the main executable's basename. That is unsafe when another Hanni MVP
; copy is being used for QA. This override never searches for or terminates a
; process. On install it stages only the executable at this installer's
; resolved $INSTDIR, then lets the stock template copy the new executable.
;
; The hook is intentionally included after utils.nsh. Keep the !ifmacrodef
; guard: a Tauri template change must fail packaging rather than silently
; restoring basename-based process termination.
!ifmacrondef CheckIfAppIsRunning
  !error "Tauri NSIS template no longer defines CheckIfAppIsRunning; review update-hooks.nsh"
!endif

!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executableName productName
  ; Uninstall must not stage another update or collide with a retained backup.
  ; Its normal file removal remains in the stock template, without process kills.
  !ifndef __UNINSTALL__
  !define HANNI_UPDATE_HOOK_ID ${__LINE__}

  ; Do not use FindProcess* or KillProcess*. The file is scoped to the exact
  ; destination chosen by this installer, so unrelated hanni-mvp.exe copies
  ; and their data remain untouched.
  IfFileExists "$INSTDIR\${executableName}" 0 hanni_update_done_${HANNI_UPDATE_HOOK_ID}

  ; A prior attempt with this target version is evidence we cannot safely
  ; preserve rollback. Never overwrite it.
  IfFileExists "$INSTDIR\${executableName}.previous-${VERSION}" hanni_update_backup_exists_${HANNI_UPDATE_HOOK_ID} 0
  ClearErrors
  Rename "$INSTDIR\${executableName}" "$INSTDIR\${executableName}.previous-${VERSION}"
  IfErrors hanni_update_rename_failed_${HANNI_UPDATE_HOOK_ID} hanni_update_done_${HANNI_UPDATE_HOOK_ID}

  hanni_update_backup_exists_${HANNI_UPDATE_HOOK_ID}:
    IfSilent hanni_update_abort_${HANNI_UPDATE_HOOK_ID} 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Hanni MVP cannot safely update because its rollback file for version ${VERSION} already exists. Remove it only after checking the previous update, then retry."
    Goto hanni_update_abort_${HANNI_UPDATE_HOOK_ID}

  hanni_update_rename_failed_${HANNI_UPDATE_HOOK_ID}:
    IfSilent hanni_update_abort_${HANNI_UPDATE_HOOK_ID} 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Hanni MVP cannot safely replace its installed executable. Close only the Hanni MVP window being updated and retry. Other Hanni MVP copies were not closed."

  hanni_update_abort_${HANNI_UPDATE_HOOK_ID}:
    Abort

  hanni_update_done_${HANNI_UPDATE_HOOK_ID}:
  !undef HANNI_UPDATE_HOOK_ID
  !endif
!macroend
