Unicode true
!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "1.0.0"
!endif
Name "WiFi Attendance"
OutFile "${OUTFILE}"
; Per-user install: no administrator rights needed (PostgreSQL refuses to run as administrator anyway).
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\WiFiAttendance"
InstallDirRegKey HKCU "Software\WiFiAttendance" "InstallDir"
SetCompressor /SOLID lzma
BrandingText "WiFi Attendance ${VERSION}"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_RUN_TEXT "Start WiFi Attendance now"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function LaunchApp
  SetOutPath "$INSTDIR\app"
  Exec '"$INSTDIR\node\node.exe" "$INSTDIR\app\src\launcher.ts"'
FunctionEnd

Section "Install"
  ; Stop a running copy first (upgrade case).
  IfFileExists "$INSTDIR\node\node.exe" 0 +2
    ExecWait '"$INSTDIR\node\node.exe" "$INSTDIR\app\src\launcher.ts" --stop'
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\WiFiAttendance" "InstallDir" "$INSTDIR"

  SetOutPath "$INSTDIR\app"
  CreateDirectory "$SMPROGRAMS\WiFi Attendance"
  CreateShortcut "$SMPROGRAMS\WiFi Attendance\WiFi Attendance.lnk" "$INSTDIR\node\node.exe" '"$INSTDIR\app\src\launcher.ts"' "$INSTDIR\node\node.exe" 0 SW_SHOWNORMAL
  CreateShortcut "$DESKTOP\WiFi Attendance.lnk" "$INSTDIR\node\node.exe" '"$INSTDIR\app\src\launcher.ts"' "$INSTDIR\node\node.exe" 0 SW_SHOWNORMAL
  CreateShortcut "$SMPROGRAMS\WiFi Attendance\Stop WiFi Attendance.lnk" "$INSTDIR\node\node.exe" '"$INSTDIR\app\src\launcher.ts" --stop' "$INSTDIR\node\node.exe" 0 SW_SHOWNORMAL
  CreateShortcut "$SMPROGRAMS\WiFi Attendance\Uninstall.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WiFiAttendance" "DisplayName" "WiFi Attendance"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WiFiAttendance" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WiFiAttendance" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WiFiAttendance" "NoModify" 1
SectionEnd

Section "Uninstall"
  ExecWait '"$INSTDIR\node\node.exe" "$INSTDIR\app\src\launcher.ts" --stop'
  Delete "$DESKTOP\WiFi Attendance.lnk"
  RMDir /r "$SMPROGRAMS\WiFi Attendance"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WiFiAttendance"
  DeleteRegKey HKCU "Software\WiFiAttendance"
  ; Attendance data lives in %LOCALAPPDATA%\WiFiAttendance and is deliberately kept.
  MessageBox MB_OK "WiFi Attendance was removed.$\r$\nYour attendance data was kept in:$\r$\n$LOCALAPPDATA\WiFiAttendance$\r$\n(delete that folder if you want to erase it)."
SectionEnd
