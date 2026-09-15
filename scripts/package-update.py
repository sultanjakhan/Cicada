#!/usr/bin/env python3
"""Build one signed, size-bounded Hanni MVP update candidate in CI.

The caller supplies the updater signing key through environment variables. This
script never publishes a release or contacts the update service: it only emits
the payload, a detached Tauri signature and a manifest below `.local/`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
MAX_ASSET_BYTES = 25 * 1024 * 1024
PLATFORMS = {
    'windows': {'name': 'windows-x86_64', 'suffix': '.exe'},
    'android': {'name': 'android-aarch64', 'suffix': '.apk'},
}


def output(*args: str) -> str:
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def source_metadata() -> tuple[str, str, dict, str]:
    require(not output('git', 'status', '--porcelain'), 'Commit source changes before packaging.')
    commit = output('git', 'rev-parse', 'HEAD')
    origin = output('git', 'remote', 'get-url', 'origin')
    require(origin.removesuffix('.git').endswith('/hanni-mvp'),
            'Expected the independent hanni-mvp repository.')
    config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
    require(config.get('identifier') == 'app.hanni.mvp' and config.get('productName') == 'Hanni MVP',
            'Unexpected Hanni MVP application identity.')
    version = config.get('version')
    require(isinstance(version, str) and version.count('.') == 2, 'Expected a three-part version.')
    return commit, origin, config, version


def updater_environment() -> dict[str, str]:
    key = os.environ.get('MVP_UPDATER_PRIVATE_KEY', '')
    password = os.environ.get('MVP_UPDATER_PRIVATE_KEY_PASSWORD', '')
    require(key, 'MVP_UPDATER_PRIVATE_KEY is required to sign an update candidate.')
    require(password, 'MVP_UPDATER_PRIVATE_KEY_PASSWORD is required to sign an update candidate.')
    environment = dict(os.environ)
    # Tauri reads these variables internally; key material never appears on argv.
    environment['TAURI_SIGNING_PRIVATE_KEY'] = key
    environment['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] = password
    return environment


def sign(payload: Path, environment: dict[str, str]) -> Path:
    subprocess.run(['node', 'node_modules/@tauri-apps/cli/tauri.js', 'signer', 'sign', str(payload)],
                   cwd=ROOT, env=environment, check=True)
    signature = payload.with_name(payload.name + '.sig')
    require(signature.is_file() and signature.stat().st_size > 0,
            'Tauri signer did not produce the detached signature.')
    return signature


def ensure_asset_limit(*assets: Path) -> None:
    for asset in assets:
        require(asset.is_file(), f'Missing update asset: {asset}')
        require(asset.stat().st_size <= MAX_ASSET_BYTES,
                f'Update asset exceeds 25 MiB limit: {asset.name}')


def build_windows(commit: str, version: str) -> Path:
    require(sys.platform == 'win32', 'Windows update candidates must be built on Windows.')
    subprocess.run(['powershell', '-NoProfile', '-File', 'scripts/package-windows.ps1'],
                   cwd=ROOT, check=True)
    source = ROOT / '.local/windows-package' / commit[:12] / f'Hanni-MVP-{version}-windows-x64-setup.exe'
    require(source.is_file(), 'The Windows packager did not produce its expected NSIS installer.')
    return source


def build_android(commit: str, version: str) -> tuple[Path, int]:
    require(sys.platform.startswith('linux'), 'Android update candidates must be built on Linux CI.')
    environment = dict(os.environ)
    environment.update({
        'CARGO_INCREMENTAL': '0',
        'CARGO_PROFILE_DEV_DEBUG': '0',
        'CARGO_PROFILE_DEV_OPT_LEVEL': 's',
    })
    subprocess.run([sys.executable, 'scripts/package-android-debug.py'], cwd=ROOT,
                   env=environment, check=True)
    manifest_path = ROOT / '.local/android-package' / commit[:12] / 'manifest.json'
    require(manifest_path.is_file(), 'Android packager did not produce a manifest.')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    require(manifest.get('version') == version and manifest.get('source_commit') == commit,
            'Android candidate manifest does not match the checked-out source.')
    require(manifest.get('signing', {}).get('certificate_sha256') ==
            'e18482039bc199a158847aaae9298b9aeb9e8e0e9f0ec2f1e4dcd4ae14e0bd9d',
            'Android candidate does not use the persistent Hanni MVP signing certificate.')
    apk = manifest_path.parent / manifest.get('apk', '')
    require(apk.is_file(), 'Android candidate manifest names no APK.')
    code = manifest.get('version_code')
    require(isinstance(code, int) and code > 0, 'Android candidate is missing version_code.')
    return apk, code


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('platform', choices=sorted(PLATFORMS))
    args = parser.parse_args()

    commit, origin, config, version = source_metadata()
    environment = updater_environment()
    platform = PLATFORMS[args.platform]
    version_code = None
    if args.platform == 'windows':
        built = build_windows(commit, version)
    else:
        built, version_code = build_android(commit, version)

    destination_dir = ROOT / '.local/update-candidate' / args.platform
    destination_dir.mkdir(parents=True, exist_ok=True)
    payload = destination_dir / f'Hanni-MVP-{version}-{platform["name"]}{platform["suffix"]}'
    require(not payload.exists(), 'A candidate for this platform/version already exists; inspect it first.')
    shutil.copyfile(built, payload)
    signature = sign(payload, environment)
    ensure_asset_limit(payload, signature)

    manifest = {
        'schema_version': 1,
        'application': config['productName'],
        'identifier': config['identifier'],
        'version': version,
        'source': commit,
        'source_repository': origin,
        'platform': platform['name'],
        'asset': payload.name,
        'size': payload.stat().st_size,
        'sha256': sha256(payload),
        'signature_file': signature.name,
        'signature': signature.read_text(encoding='utf-8').strip(),
    }
    if version_code is not None:
        manifest['version_code'] = version_code
    manifest_path = destination_dir / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    ensure_asset_limit(manifest_path)
    require(not output('git', 'status', '--porcelain'),
            'Packaging changed tracked source; do not distribute this candidate.')
    print(destination_dir)


if __name__ == '__main__':
    main()
