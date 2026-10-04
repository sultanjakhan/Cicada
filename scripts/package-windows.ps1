$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ($env:OS -ne 'Windows_NT') { throw 'This package targets Windows x64.' }
$repository = Split-Path -Parent $PSScriptRoot
Push-Location $repository
try {
    $sourceCommit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the source commit.' }
    if (& git status --porcelain) { throw 'Commit source changes before packaging.' }
    $origin = (& git remote get-url origin).Trim()
    if ($origin -cnotmatch '/Cicada(?:\.git)?$') { throw 'Build this package from the independent Cicada repository.' }
    $config = Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.identifier -ne 'app.hanni.mvp' -or $config.productName -ne 'Cicada' -or $config.mainBinaryName -ne 'hanni-mvp') { throw 'Unexpected application identity.' }
    & python -B scripts/check-update-configuration.py
    if ($LASTEXITCODE -ne 0) { throw 'Windows distribution has no valid update channel.' }
    $metadata = & cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1 --locked | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the Cargo output directory.' }
    & .\node_modules\.bin\tauri.cmd build --bundles nsis --ci --no-sign -- --offline --locked
    if ($LASTEXITCODE -ne 0) { throw 'Windows package build failed.' }
    if (& git status --porcelain) { throw 'Build changed tracked source; inspect and commit before packaging again.' }

    $releaseDirectory = Join-Path $metadata.target_directory 'release'
    $binary = Join-Path $releaseDirectory 'hanni-mvp.exe'
    & python -B scripts/check-update-configuration.py --executable $binary
    if ($LASTEXITCODE -ne 0) { throw 'Built executable has no matching update configuration.' }
    New-Item -ItemType Directory -Path (Join-Path $repository '.local') -Force | Out-Null
    $apiCheckRoot = Join-Path $repository ('.local/agent-api-check-' + [Guid]::NewGuid().ToString('N'))
    $apiReceipt = Join-Path $repository ('.local/agent-api-receipt-' + $sourceCommit.Substring(0, 12) + '.json')
    & python -B scripts/verify-agent-api.py --exe $binary --root $apiCheckRoot --receipt $apiReceipt
    if ($LASTEXITCODE -ne 0) { throw 'Built executable failed native API acceptance; refuse distribution.' }
    $installers = @(Get-ChildItem -LiteralPath (Join-Path $releaseDirectory 'bundle/nsis') -Filter "*_$($config.version)_x64-setup.exe" -File)
    if ($installers.Count -ne 1) { throw 'Expected exactly one Windows x64 installer for this version.' }
    $packageDirectory = Join-Path $repository ('.local/windows-package/' + $sourceCommit.Substring(0, 12))
    New-Item -ItemType Directory -Path $packageDirectory -Force | Out-Null
    $installerName = "Cicada-$($config.version)-windows-x64-setup.exe"
    $installerPath = Join-Path $packageDirectory $installerName
    Copy-Item -LiteralPath $installers[0].FullName -Destination $installerPath
    $manifest = [ordered]@{
        schema_version = 1
        application = $config.productName
        identifier = $config.identifier
        version = $config.version
        channel = 'local-mvp'
        platform = 'windows-x64'
        profile = 'release-with-embedded-web-assets'
        build_id = (Get-Content -LiteralPath 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json).cicadaBuildId
        updates_configured = $true
        local_agent_api_verified = $true
        source_repository = $origin
        source_commit = $sourceCommit
        installer = $installerName
        installer_sha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
        executable = 'hanni-mvp.exe'
        unbundled_executable_sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
        executable_hash_note = 'Tauri patches the bundle marker inside the NSIS payload. This hash identifies the unbundled build output, not the installed executable.'
        authenticode_status = [string](Get-AuthenticodeSignature -LiteralPath $installerPath).Status
    }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageDirectory 'manifest.json') -Encoding UTF8
    Write-Output "Windows MVP package: $packageDirectory"
} finally {
    Pop-Location
}
