$ErrorActionPreference = 'Stop'

Write-Host 'KMJ CodeBridge - ChatGPT Desktop setup' -ForegroundColor Cyan

$marketplace = 'kmj-techno'
$repo = 'kmjtechno/kmj-codebridge'
$pluginName = 'kmj-codebridge'
$codex = Get-Command codex -ErrorAction SilentlyContinue

if ($codex) {
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
} else {
    Write-Host 'Codex CLI was not found; using the ChatGPT Desktop personal-marketplace fallback.'

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js is required by the KMJ CodeBridge Desktop bridge and was not found in PATH.'
    }

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('kmj-codebridge-' + [guid]::NewGuid().ToString('N'))
    $zipPath = Join-Path $tempRoot 'kmj-codebridge.zip'
    $extractPath = Join-Path $tempRoot 'src'
    $pluginDir = Join-Path $HOME '.codex\plugins\kmj-codebridge'
    $marketplacePath = Join-Path $HOME '.agents\plugins\marketplace.json'

    try {
        New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
        New-Item -ItemType Directory -Force -Path $extractPath | Out-Null

        Write-Host 'Downloading the public KMJ CodeBridge repository...'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/kmjtechno/kmj-codebridge/archive/refs/heads/main.zip' -OutFile $zipPath
        Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

        $repoRoot = Get-ChildItem -Path $extractPath -Directory | Select-Object -First 1
        if (-not $repoRoot) {
            throw 'Downloaded CodeBridge archive did not contain a repository root.'
        }

        $sourcePlugin = Join-Path $repoRoot.FullName 'plugin'
        if (-not (Test-Path (Join-Path $sourcePlugin 'plugin.json'))) {
            throw 'Downloaded CodeBridge archive did not contain plugin/plugin.json.'
        }

        New-Item -ItemType Directory -Force -Path (Split-Path $pluginDir -Parent) | Out-Null
        if (Test-Path $pluginDir) {
            Remove-Item -Recurse -Force $pluginDir
        }
        Copy-Item -Recurse -Force $sourcePlugin $pluginDir

        New-Item -ItemType Directory -Force -Path (Split-Path $marketplacePath -Parent) | Out-Null

        if (Test-Path $marketplacePath) {
            Copy-Item $marketplacePath ($marketplacePath + '.before-kmj-codebridge') -Force
            try {
                $catalog = Get-Content -Raw $marketplacePath | ConvertFrom-Json
            } catch {
                throw 'Existing personal plugin marketplace JSON is invalid. A backup was preserved next to it.'
            }
        } else {
            $catalog = [pscustomobject]@{
                name = 'personal'
                interface = [pscustomobject]@{ displayName = 'Personal' }
                plugins = @()
            }
        }

        if (-not $catalog.PSObject.Properties['name']) {
            $catalog | Add-Member -NotePropertyName name -NotePropertyValue 'personal'
        }
        if (-not $catalog.PSObject.Properties['interface']) {
            $catalog | Add-Member -NotePropertyName interface -NotePropertyValue ([pscustomobject]@{ displayName = 'Personal' })
        }
        if (-not $catalog.PSObject.Properties['plugins']) {
            $catalog | Add-Member -NotePropertyName plugins -NotePropertyValue @()
        }

        $keptPlugins = @($catalog.plugins | Where-Object { $_.name -ne $pluginName })
        $kmjPlugin = [pscustomobject]@{
            name = $pluginName
            source = [pscustomobject]@{
                source = 'local'
                path = './../../.codex/plugins/kmj-codebridge'
            }
            policy = [pscustomobject]@{
                installation = 'INSTALLED_BY_DEFAULT'
                authentication = 'ON_INSTALL'
            }
            category = 'Developer Tools'
        }
        $catalog.plugins = @($keptPlugins) + @($kmjPlugin)
        $catalog | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 $marketplacePath
    } finally {
        if (Test-Path $tempRoot) {
            Remove-Item -Recurse -Force $tempRoot
        }
    }
}

Write-Host ''
Write-Host 'KMJ CodeBridge is ready for ChatGPT Desktop.' -ForegroundColor Green
Write-Host 'Fully quit and reopen ChatGPT Desktop once.'
Write-Host 'The KMJ marketplace installs CodeBridge by default.'
Write-Host 'On first CodeBridge use, your browser will open KMJ OAuth automatically.'
