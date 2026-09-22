#!/usr/bin/env python3
"""Build the independent MVP macOS app from a clean commit without installing it."""
import hashlib
import argparse
import json
import os
from pathlib import Path
import platform
import plistlib
from pathlib import PurePosixPath
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def output(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def verify_updater_archive(archive):
    # Tauri 2.11 strips the top-level member and writes Contents to the
    # currently installed bundle, including 0.3.22's Hanni MVP.app path.
    with tarfile.open(archive, 'r:gz') as members:
        names = [member.name for member in members.getmembers()]
    require(names and all((name == 'Cicada.app' or name.startswith('Cicada.app/'))
                          and '..' not in PurePosixPath(name).parts for name in names),
            'The macOS updater archive must contain exactly one Cicada.app root.')
    require('Cicada.app/Contents/MacOS/hanni-mvp' in names,
            'The macOS updater archive is missing the compatible executable.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--updater', action='store_true')
    args = parser.parse_args()
    require(sys.platform == 'darwin', 'Build this package on macOS.')
    commit = output('git', 'rev-parse', 'HEAD')
    require(not output('git', 'status', '--porcelain'), 'Commit source changes before packaging.')
    origin = output('git', 'remote', 'get-url', 'origin')
    require(origin.removesuffix('.git').endswith('/Cicada'), 'Expected the independent Cicada repository.')
    config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())
    require(config['identifier'] == 'app.hanni.mvp' and config['productName'] == 'Cicada'
            and config['mainBinaryName'] == 'hanni-mvp',
            'Unexpected application identity.')
    metadata = json.loads(output('cargo', 'metadata', '--manifest-path', 'src-tauri/Cargo.toml',
                                 '--no-deps', '--format-version', '1', '--locked'))
    environment = dict(os.environ, APPLE_SIGNING_IDENTITY='-')
    for name in ('APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_ISSUER',
                 'APPLE_API_KEY', 'APPLE_API_KEY_PATH', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD'):
        environment.pop(name, None)
    command = ['npm', 'run', 'tauri', '--', 'build', '--bundles', 'app', '--ci',
               '--config', 'src-tauri/tauri.macos.conf.json']
    if args.updater:
        require(environment.get('TAURI_SIGNING_PRIVATE_KEY'), 'The updater signing key is required.')
        command.extend(['--config', json.dumps({'bundle': {'createUpdaterArtifacts': True}})])
    subprocess.run(command, cwd=ROOT, env=environment, check=True)
    require(not output('git', 'status', '--porcelain'), 'Build changed tracked source; inspect it before packaging again.')
    require(output('git', 'rev-parse', 'HEAD') == commit, 'Source commit changed during the build.')
    bundle = Path(metadata['target_directory']) / 'release/bundle/macos/Cicada.app'
    with (bundle / 'Contents/Info.plist').open('rb') as file:
        info = plistlib.load(file)
    require(info['CFBundleIdentifier'] == config['identifier'] and
            info['CFBundleShortVersionString'] == config['version'] and
            info['CFBundleExecutable'] == config['mainBinaryName'] and
            info.get('CFBundleName') == 'Cicada', 'Bundle identity, name or version differs.')
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(bundle)], check=True)
    directory = ROOT / '.local/mac-package' / commit[:12]
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / 'Cicada.app'
    require(not destination.exists(), 'This commit already has a package; inspect the existing artifact.')
    subprocess.run(['ditto', str(bundle), str(destination)], check=True)
    hashes = {}
    for path in sorted(destination.rglob('*')):
        if path.is_file() and not path.is_symlink():
            hashes[path.relative_to(destination).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    archive = directory / 'Cicada-macos.zip'
    subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent',
                    str(destination), str(archive)], check=True)
    if args.updater:
        import shutil
        updater = bundle.with_name(bundle.name + '.tar.gz')
        require(updater.is_file(), 'Tauri did not create the macOS updater archive.')
        verify_updater_archive(updater)
        shutil.copyfile(updater, directory / updater.name)
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
