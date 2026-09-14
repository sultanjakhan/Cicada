#!/usr/bin/env python3
"""Build the independent MVP macOS app from a clean commit without installing it."""
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def output(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def main():
    require(sys.platform == 'darwin', 'Build this package on macOS.')
    commit = output('git', 'rev-parse', 'HEAD')
    require(not output('git', 'status', '--porcelain'), 'Commit source changes before packaging.')
    origin = output('git', 'remote', 'get-url', 'origin')
    require(origin.removesuffix('.git').endswith('/hanni-mvp'), 'Expected the independent MVP repository.')
    config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())
    require(config['identifier'] == 'app.hanni.mvp' and config['productName'] == 'Hanni MVP',
            'Unexpected application identity.')
    metadata = json.loads(output('cargo', 'metadata', '--manifest-path', 'src-tauri/Cargo.toml',
                                 '--no-deps', '--format-version', '1', '--locked'))
    environment = dict(os.environ, APPLE_SIGNING_IDENTITY='-')
    for name in ('APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_ISSUER',
                 'APPLE_API_KEY', 'APPLE_API_KEY_PATH', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD'):
        environment.pop(name, None)
    subprocess.run(['npm', 'run', 'tauri', '--', 'build', '--bundles', 'app', '--ci',
                    '--config', 'src-tauri/tauri.macos.conf.json'], cwd=ROOT, env=environment, check=True)
    require(not output('git', 'status', '--porcelain'), 'Build changed tracked source; inspect it before packaging again.')
    require(output('git', 'rev-parse', 'HEAD') == commit, 'Source commit changed during the build.')
    bundle = Path(metadata['target_directory']) / 'release/bundle/macos/Hanni MVP.app'
    with (bundle / 'Contents/Info.plist').open('rb') as file:
        info = plistlib.load(file)
    require(info['CFBundleIdentifier'] == config['identifier'] and
            info['CFBundleShortVersionString'] == config['version'], 'Bundle identity or version differs.')
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(bundle)], check=True)
    directory = ROOT / '.local/mac-package' / commit[:12]
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / 'Hanni MVP.app'
    require(not destination.exists(), 'This commit already has a package; inspect the existing artifact.')
    subprocess.run(['ditto', str(bundle), str(destination)], check=True)
    hashes = {}
    for path in sorted(destination.rglob('*')):
        if path.is_file() and not path.is_symlink():
            hashes[path.relative_to(destination).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    archive = directory / 'Hanni MVP-macos.zip'
    subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent',
                    str(destination), str(archive)], check=True)
    manifest = {
        'schema_version': 1, 'application': config['productName'], 'identifier': config['identifier'],
        'version': config['version'], 'channel': 'local-mvp', 'platform': 'macos-' + platform.machine(),
        'profile': 'release-with-embedded-web-assets', 'source_repository': origin, 'source_commit': commit,
        'application_bundle': destination.name, 'files_sha256': hashes,
        'archive': archive.name, 'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
        'signing': 'ad-hoc', 'notarized': False,
    }
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    sys.stdout.write(f'macOS MVP package: {directory}\n')


if __name__ == '__main__':
    main()
