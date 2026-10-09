@echo off
setlocal EnableExtensions DisableDelayedExpansion
title KMJ CodeBridge - One-Click VS Code Copilot Setup
set "KMJ_COPILOT_INSTALLER=%~f0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $s=[IO.File]::ReadAllText($env:KMJ_COPILOT_INSTALLER); $m='# KMJ_CODEBRIDGE_COPILOT_POWERSHELL_V1'; $n=$s.LastIndexOf($m,[StringComparison]::Ordinal); if($n -lt 0) { throw 'Missing setup payload' }; & ([scriptblock]::Create($s.Substring($n+$m.Length)))"
set "KMJ_SETUP_EXIT=%ERRORLEVEL%"
if not "%KMJ_SETUP_EXIT%"=="0" (
  echo.
  echo ERROR: Setup failed. Existing configuration was not intentionally removed.
  if not "%KMJ_COPILOT_SETUP_TEST_MODE%"=="1" pause
  exit /b %KMJ_SETUP_EXIT%
)
if not "%KMJ_COPILOT_SETUP_TEST_MODE%"=="1" pause
exit /b 0
# KMJ_CODEBRIDGE_COPILOT_POWERSHELL_V1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$serverName = 'kmj-codebridge'
$endpoint = 'https://kmjtechno.com/mcp'
$testMode = $env:KMJ_COPILOT_SETUP_TEST_MODE -eq '1'

function Read-JsonObject([string]$path) {
    if (-not [IO.File]::Exists($path)) { return [pscustomobject]@{} }
    $text = [IO.File]::ReadAllText($path)
    try {
        $value = ConvertFrom-Json -InputObject $text -ErrorAction Stop
    } catch {
        throw "Existing VS Code mcp.json is not valid JSON. Nothing was overwritten: $path"
    }
    if ($null -eq $value -or $value -isnot [pscustomobject]) {
        throw "Existing VS Code mcp.json must contain a JSON object. Nothing was overwritten: $path"
    }
    return $value
}

function Assert-SafeFile([string]$path) {
    if (Test-Path -LiteralPath $path) {
        $item = Get-Item -LiteralPath $path -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing to modify a directory or symlink: $path"
        }
    }
}

function Set-Server([pscustomobject]$configuration) {
    $serversProperty = $configuration.PSObject.Properties['servers']
    if ($null -eq $serversProperty) {
        $configuration | Add-Member -NotePropertyName servers -NotePropertyValue ([pscustomobject]@{})
    } elseif ($null -eq $serversProperty.Value -or $serversProperty.Value -isnot [pscustomobject]) {
        throw 'Existing mcp.json servers must be a JSON object. Nothing was overwritten.'
    }
    $server = [pscustomobject]@{ type = 'http'; url = $endpoint }
    $existing = $configuration.servers.PSObject.Properties[$serverName]
    if ($null -eq $existing) {
        $configuration.servers | Add-Member -NotePropertyName $serverName -NotePropertyValue $server
    } else { $existing.Value = $server }
}

function Write-ConfigSafely([string]$path, [pscustomobject]$configuration) {
    $newContent = (ConvertTo-Json -InputObject $configuration -Depth 64) + [Environment]::NewLine
    if ([IO.File]::Exists($path)) {
        if ([IO.File]::ReadAllText($path) -eq $newContent) { return $false }
    }
    $folder = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $folder)) {
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
    }
    $tmp = Join-Path $folder ('mcp.json.kmj-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    try {
        [IO.File]::WriteAllText($tmp, $newContent, $utf8)
        if ([IO.File]::Exists($path)) {
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fffffff'
            $backup = "$path.kmj-backup-$stamp"
            [IO.File]::Replace($tmp, $path, $backup, $true)
            Write-Host "PASS: Previous MCP config backed up: $backup" -ForegroundColor Green
        } else { [IO.File]::Move($tmp, $path) }
    } finally {
        if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }
    }
    return $true
}

if ($env:OS -ne 'Windows_NT') { throw 'This setup supports Windows VS Code only.' }
if ([string]::IsNullOrWhiteSpace($env:APPDATA)) { throw 'Windows APPDATA is missing.' }
$path = Join-Path $env:APPDATA 'Code\User\mcp.json'
$directory = Split-Path -Parent $path
if (Test-Path -LiteralPath $directory) {
    if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Refusing to write MCP configuration through a reparse point.'
    }
}
Assert-SafeFile $path
$config = Read-JsonObject $path
Set-Server $config
$changed = Write-ConfigSafely $path $config

Write-Host ''
Write-Host 'KMJ CodeBridge - One-Click Copilot Setup' -ForegroundColor Cyan
Write-Host 'PASS: User-level native HTTP MCP configuration is ready.' -ForegroundColor Green
Write-Host "Endpoint: $endpoint"
Write-Host "File: $path"
if (-not $changed) { Write-Host 'PASS: Already configured; no file changes required.' -ForegroundColor Green }
Write-Host 'No API token, npm bridge, device enrollment, or other servers were changed.'
Write-Host ''
if (-not $testMode) {
    $code = Get-Command code.cmd -ErrorAction SilentlyContinue
    if (-not $code) { $code = Get-Command code.exe -ErrorAction SilentlyContinue }
    if ($code) {
        try {
            & $code.Source --reuse-window $path | Out-Null
            Write-Host 'PASS: Opened the MCP configuration in VS Code.' -ForegroundColor Green
        } catch { Write-Warning 'VS Code could not be opened automatically. Open it manually.' }
    } else {
        $candidates = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'),
            (Join-Path $env:ProgramFiles 'Microsoft VS Code\Code.exe')
        )
        $exe = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
        if ($exe) { Start-Process -FilePath $exe -ArgumentList @('--reuse-window', ('"' + $path + '"')) }
        else { Write-Warning 'VS Code not found. Install VS Code, then open the MCP configuration.' }
    }
}
Write-Host 'NEXT: In VS Code, click Start (or MCP: List Servers > kmj-codebridge > Start).'
Write-Host 'NEXT: Complete KMJ OAuth in the browser when requested. User approval is mandatory.'
Write-Host 'NEXT: In Copilot Agent Mode, enable CodeBridge tools and call list_devices directly.'
Write-Host 'Do not use terminal/curl to test authenticated tools: those requests have no OAuth session.'
