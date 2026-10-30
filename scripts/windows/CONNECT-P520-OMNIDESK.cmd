@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem KMJ TECHNO | P520 OmniDesk: fixed local project, owner-approved pairing only.
rem Requires a trusted clean CodeBridge checkout. Does not download code or reuse other credentials.
if /I not "%COMPUTERNAME%"=="DESKTOP-5FVJMET" (
  echo KMJ_OMNIDESK_PAIR=BLOCKED_WRONG_WINDOWS_HOST
  exit /b 2
)
set "PROJECT=E:\KMJ\KMJ OmniDesk"
set "SCRIPT=%~dp0ONE-CLICK-ANY-DEVICE.ps1"
if not exist "%PROJECT%\Cargo.toml" (
  echo KMJ_OMNIDESK_PAIR=BLOCKED_PROJECT_NOT_FOUND
  exit /b 2
)
if not exist "%SCRIPT%" (
  echo KMJ_OMNIDESK_PAIR=BLOCKED_CODEBRIDGE_RUNTIME_NOT_FOUND
  exit /b 2
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%SCRIPT%" -ProjectRoot "%PROJECT%"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo KMJ_OMNIDESK_PAIR=BLOCKED_CHECK_CONSOLE
  exit /b %RESULT%
)
echo KMJ_OMNIDESK_PAIR=LOCAL_CONNECTOR_COMPLETED
echo KMJ_OMNIDESK_PAIR=VERIFY_ACCOUNT_PROJECT_READY_SEPARATELY
exit /b 0
