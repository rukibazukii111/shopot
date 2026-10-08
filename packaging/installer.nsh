; Uninstaller hook for electron-builder (nsis.include in package.json).
; Asks whether to remove the data folder (models, history, settings) too.
; The default answer is "No". Updates and silent uninstalls never ask and keep
; the data; `--delete-app-data` still removes it through electron-builder.
; The folder name matches main.cjs: path.join(app.getPath('appData'), 'Shopot').

!macro customUnInstall
  ${ifNot} ${isUpdated}
  ${andIfNot} ${Silent}
    ; Electron keeps data per user, also for an all-users install.
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    ${if} ${FileExists} "$APPDATA\${APP_FILENAME}\*.*"
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Удалить также модели, историю и настройки?$\r$\n$\r$\nПапка: $APPDATA\${APP_FILENAME}" /SD IDNO IDNO shopotKeepData
        RMDir /r "$APPDATA\${APP_FILENAME}"
        ${if} ${FileExists} "$APPDATA\${APP_FILENAME}\*.*"
          MessageBox MB_OK|MB_ICONEXCLAMATION "Не удалось удалить папку целиком. Удалите её вручную:$\r$\n$APPDATA\${APP_FILENAME}" /SD IDOK
        ${endif}
      shopotKeepData:
    ${endif}
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endif}
!macroend
