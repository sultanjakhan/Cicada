$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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
    $metadata = & cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1 --locked | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the Cargo output directory.' }
    & .\node_modules\.bin\tauri.cmd build --debug --bundles nsis --ci
    if ($LASTEXITCODE -ne 0) { throw 'Windows package build failed.' }
    if (& git status --porcelain) { throw 'Build changed tracked source; inspect and commit before packaging again.' }

    $debugDirectory = Join-Path $metadata.target_directory 'debug'
    $binary = Join-Path $debugDirectory 'hanni-mvp.exe'
    $installers = @(Get-ChildItem -LiteralPath (Join-Path $debugDirectory 'bundle/nsis') -Filter "*_$($config.version)_x64-setup.exe" -File)
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
        profile = 'debug-with-embedded-web-assets'
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
