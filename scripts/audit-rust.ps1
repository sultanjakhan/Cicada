$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $repo '.local/security-tools'
$archiveName = 'cargo-audit-x86_64-pc-windows-msvc-v0.22.2.zip'
$archivePath = Join-Path $toolRoot $archiveName
$toolPath = Join-Path $toolRoot 'cargo-audit-x86_64-pc-windows-msvc-v0.22.2/cargo-audit.exe'
# Digests of the official rustsec/rustsec cargo-audit/v0.22.2 release.
$archiveHash = '0a7316540862c13d954f648917ceacca593747baed6eec180fafa590be2710ab'
$toolHash = '0157f5ce1ce9fd4fb0a1f7c79af1229771d1f80b6c2613ddb0d9200a8ba73946'
New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $toolPath)) {
    if (-not (Test-Path -LiteralPath $archivePath)) {
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/rustsec/rustsec/releases/download/cargo-audit/v0.22.2/$archiveName" -OutFile $archivePath
    }
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveHash) {
        throw 'cargo-audit release archive checksum mismatch'
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $toolRoot
}
if ((Get-FileHash -LiteralPath $toolPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $toolHash) {
    throw 'cargo-audit executable checksum mismatch'
}
# Fetch the current RustSec database; no advisory ignores or stale/offline fallback.
# Informational warnings remain visible. Known vulnerabilities and yanked crates fail.
& $toolPath audit --file (Join-Path $repo 'src-tauri/Cargo.lock') --db (Join-Path $toolRoot 'advisory-db') --deny yanked
exit $LASTEXITCODE
