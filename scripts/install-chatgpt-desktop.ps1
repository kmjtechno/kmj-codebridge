$ErrorActionPreference = 'Stop'

Write-Host 'KMJ CodeBridge - ChatGPT Desktop setup' -ForegroundColor Cyan

$codex = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codex) {
    throw 'Codex CLI was not found. Install or update the ChatGPT Desktop app, then run this installer again.'
}

$marketplace = 'kmj-techno'
$repo = 'kmjtechno/kmj-codebridge'

$existing = & codex plugin marketplace list 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to read ChatGPT plugin marketplaces.'
}

if ($existing -match [regex]::Escape($marketplace)) {
    Write-Host 'Refreshing existing KMJ TECHNO marketplace...'
    & codex plugin marketplace upgrade $marketplace
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to refresh the KMJ TECHNO marketplace.'
    }
} else {
    Write-Host 'Adding KMJ TECHNO marketplace...'
    & codex plugin marketplace add $repo --ref main
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to add the KMJ TECHNO marketplace.'
    }
}

Write-Host ''
Write-Host 'KMJ CodeBridge is ready for ChatGPT Desktop.' -ForegroundColor Green
Write-Host 'Fully quit and reopen ChatGPT Desktop once. The plugin is installed by default from the KMJ TECHNO marketplace.'
Write-Host 'On first CodeBridge use, your browser will open KMJ OAuth automatically.'
