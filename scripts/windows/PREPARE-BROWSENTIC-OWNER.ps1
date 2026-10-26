# KMJ TECHNO | Browser QA | optional local Browsentic v0.9.0 preparation
# Current Windows user only. Never changes owner device enrollment or CodeBridge config.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$originalPath = $env:PATH
$stage = $null

function Ordinary([string]$Path, [bool]$Directory) {
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ([bool]$item.PSIsContainer -ne $Directory) { throw 'BROWSENTIC_INVALID_PATH_TYPE' }
    $cursor = if ($Directory) { $item } else { $item.Directory }
    while ($null -ne $cursor) {
        if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'BROWSENTIC_REPARSE_DENIED'
        }
        $cursor = $cursor.Parent
    }
}
function TrustedNode {
    $candidates = New-Object 'System.Collections.Generic.List[string]'
    $found = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($found) { $candidates.Add([string]$found.Source) }
    if (![string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $tools = Join-Path $env:LOCALAPPDATA 'KMJ-CaliPro\toolchains'
        if (Test-Path -LiteralPath $tools -PathType Container) {
            Ordinary $tools $true
            $candidates.Add((Join-Path $tools 'node.exe'))
            foreach ($d in @(Get-ChildItem -LiteralPath $tools -Directory -ErrorAction Stop |
                Where-Object { $_.Name -match '^node(?:[-._].+)?$' } |
                Select-Object -First 12)) {
                Ordinary $d.FullName $true
                $candidates.Add((Join-Path $d.FullName 'node.exe'))
                $candidates.Add((Join-Path $d.FullName 'bin\node.exe'))
            }
        }
    }
    foreach ($file in @($candidates | Select-Object -Unique)) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        $folder = Split-Path -Parent $file
        $npm = Join-Path $folder 'npm.cmd'
        if (!(Test-Path -LiteralPath $npm -PathType Leaf)) { continue }
        try {
            Ordinary $file $false
            Ordinary $npm $false
            $version = [string](& $file --version 2>$null)
            if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v([0-9]+)\.' -or
                [int]$Matches[1] -lt 24) { continue }
            # PATH change is confined to this child PowerShell process.
            $env:PATH = $folder + [IO.Path]::PathSeparator + $env:PATH
            return $npm
        } catch { continue }
    }
    throw 'BROWSENTIC_NODE24_NPM_REQUIRED'
}

try {
    if ($env:OS -cne 'Windows_NT') { throw 'BROWSENTIC_WINDOWS_REQUIRED' }
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or
        ![IO.Path]::IsPathRooted($env:LOCALAPPDATA)) {
        throw 'BROWSENTIC_LOCALAPPDATA_REQUIRED'
    }
    Ordinary $env:LOCALAPPDATA $true
    $npm = TrustedNode
    $base = Join-Path $env:LOCALAPPDATA 'KMJ\CodeBridge\browsentic'
    $dest = Join-Path $base 'v0.9.0'
    if (!(Test-Path -LiteralPath $base)) {
        New-Item -ItemType Directory -Path $base -Force -ErrorAction Stop | Out-Null
    }
    Ordinary $base $true
    if (!(Test-Path -LiteralPath $dest)) {
        $stage = Join-Path $base ('stage-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
        Ordinary $stage $true
        $manifest = '{"private":true,"name":"kmj-browsentic-local","version":"0.0.0","dependencies":{"browsentic":"0.9.0"}}'
        [IO.File]::WriteAllText((Join-Path $stage 'package.json'), $manifest, [Text.UTF8Encoding]::new($false))
        Write-Host 'BROWSENTIC_PREPARE=PINNED_NPM_INSTALL'
        & $npm install --prefix $stage --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
        if ($LASTEXITCODE -ne 0) { throw 'BROWSENTIC_NPM_INSTALL_FAILED' }
        $entry = Join-Path $stage 'node_modules\browsentic\dist\cli.js'
        $metadata = Join-Path $stage 'node_modules\browsentic\package.json'
        Ordinary $entry $false
        Ordinary $metadata $false
        $package = Get-Content -LiteralPath $metadata -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($package.name -cne 'browsentic' -or $package.version -cne '0.9.0') {
            throw 'BROWSENTIC_VERSION_MISMATCH'
        }
        if (Test-Path -LiteralPath $dest) { throw 'BROWSENTIC_EXISTING_INSTALL_REVIEW_REQUIRED' }
        Move-Item -LiteralPath $stage -Destination $dest -ErrorAction Stop
        $stage = $null
    }
    Ordinary $dest $true
    $entry = Join-Path $dest 'node_modules\browsentic\dist\cli.js'
    $metadata = Join-Path $dest 'node_modules\browsentic\package.json'
    Ordinary $entry $false
    Ordinary $metadata $false
    $package = Get-Content -LiteralPath $metadata -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($package.name -cne 'browsentic' -or $package.version -cne '0.9.0') {
        throw 'BROWSENTIC_VERSION_MISMATCH'
    }
    $hash = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host 'BROWSENTIC_PREPARE=LOCAL_ENTRY_VERIFIED'
    Write-Host 'BROWSENTIC_VERSION=0.9.0'
    Write-Host ('BROWSENTIC_ENTRY_SHA256=' + $hash)
    Write-Host 'BROWSENTIC_OWNER_BROWSER_PAIRING=PENDING_EXPLICIT_OWNER_ACTION'
    Write-Host 'BROWSENTIC_AGENT_CONFIG_CHANGED=NO'
    Write-Host 'BROWSENTIC_PRODUCTION_ACTIVATED=NO'
} catch {
    $code = [string]$_.Exception.Message
    if ($code -notmatch '^BROWSENTIC_[A-Z0-9_]{4,100}$') { $code = 'BROWSENTIC_PREPARE_PREFLIGHT_FAILED' }
    Write-Host ('BROWSENTIC_PREPARE=BLOCKED:' + $code)
    Write-Host 'BROWSENTIC_OWNER_FILES_PRESERVED=YES'
    exit 2
} finally {
    $env:PATH = $originalPath
    if ($null -ne $stage -and (Test-Path -LiteralPath $stage)) {
        Ordinary $stage $true
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop
    }
}
