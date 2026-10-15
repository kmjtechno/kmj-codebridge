@echo off
setlocal EnableExtensions
rem One-click: store the FreeLLMAPI key as a USER environment variable for CodeBridge.
rem The key is typed hidden, validated, never echoed, never written to a file or log.
rem Also set the approved chains (owner-reviewed) so cloud use stays an explicit allowlist.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
 "$s=Read-Host 'Paste FreeLLMAPI key (hidden)' -AsSecureString;" ^
 "$k=[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s));" ^
 "if($k -notmatch '^[A-Za-z0-9._-]{8,200}$'){Write-Host 'KEY_FORMAT_INVALID - nothing saved';exit 2};" ^
 "[Environment]::SetEnvironmentVariable('CODEBRIDGE_FREELLMAPI_KEY',$k,'User');" ^
 "$c=Read-Host 'Approved chains, comma separated, no spaces (example auto:default)';" ^
 "if($c -notmatch '^auto:[A-Za-z0-9_-]{1,20}(,auto:[A-Za-z0-9_-]{1,20}){0,19}$'){Write-Host 'CHAINS_FORMAT_INVALID - key saved, chains not set';exit 3};" ^
 "[Environment]::SetEnvironmentVariable('CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS',$c,'User');" ^
 "Write-Host 'SAVED. Restart the CodeBridge agent so it reads the new variables.'"
echo EXIT=%ERRORLEVEL%
pause
