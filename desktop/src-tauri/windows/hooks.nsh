; NSIS installer hooks (bundle.windows.nsis.installerHooks in tauri.conf.json).
; The installer runs elevated (installMode perMachine), so it can register the
; collector service; the app itself never needs administrator rights.

!macro NSIS_HOOK_PREINSTALL
  ; an upgrade must not try to overwrite the running service executable
  nsExec::Exec 'sc.exe stop DiskGuardian'
  ; the app's former name (Disk Health): remove its service and its installation
  nsExec::Exec 'sc.exe stop DiskHealth'
  Sleep 2000
  nsExec::Exec 'sc.exe delete DiskHealth'
  IfFileExists "$PROGRAMFILES64\Disk Health\uninstall.exe" 0 +3
    ExecWait '"$PROGRAMFILES64\Disk Health\uninstall.exe" /S _?=$PROGRAMFILES64\Disk Health'
    RMDir /r "$PROGRAMFILES64\Disk Health"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog '"$INSTDIR\disk-guardian.exe" --install-service'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; drive labels / health badges in File Explorer (per user, HKCU)
  nsExec::Exec '"$INSTDIR\disk-guardian.exe" --clear-explorer'
  nsExec::ExecToLog '"$INSTDIR\disk-guardian.exe" --uninstall-service'
!macroend
