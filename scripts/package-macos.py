#!/usr/bin/env python3
"""Build the independent MVP macOS app from a clean commit without installing it."""
import hashlib
import argparse
import json
import os
from pathlib import Path
import platform
import plistlib
import re
from pathlib import PurePosixPath
import subprocess
import sys
import tarfile
import tempfile
import importlib.util

vault_spec = importlib.util.spec_from_file_location('macos_vault_package', Path(__file__).with_name('macos_vault_package.py'))
vault = importlib.util.module_from_spec(vault_spec)
vault_spec.loader.exec_module(vault)

ROOT = Path(__file__).resolve().parents[1]


def output(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def signing_configuration(environment):
    identity = environment.get('APPLE_SIGNING_IDENTITY', '')
    team = environment.get('MVP_MACOS_TEAM_ID', '')
    require(re.fullmatch(r'[A-Fa-f0-9]{40}', identity),
            'APPLE_SIGNING_IDENTITY must be the SHA-1 fingerprint of a persistent Apple signing certificate; ad-hoc packages lose Keychain access.')
    require(re.fullmatch(r'[A-Z0-9]{10}', team),
            'MVP_MACOS_TEAM_ID must identify the same Apple team across updates.')
    return identity.upper(), team


def verify_signature(bundle, team, identity):
    requirement = (f'anchor apple generic and identifier "app.hanni.mvp" '
                   f'and certificate leaf[subject.OU] = "{team}"')
    result = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict',
                             '-R=' + requirement, str(bundle)], capture_output=True)
    require(result.returncode == 0,
            'The bundle must have a valid Apple signature from the configured team; self-signed and ad-hoc signatures are not update-compatible.')
    result = subprocess.run(['/usr/bin/codesign', '-d', '-r-', '--verbose=4', str(bundle)],
                            capture_output=True, text=True)
    require(result.returncode == 0, 'Cannot read the application signing identity.')
    lines = (result.stdout + '\n' + result.stderr).splitlines()
    fields = dict(line.split('=', 1) for line in lines if '=' in line)
    dr = next((line.removeprefix('designated => ') for line in lines
               if line.startswith('designated => ')), '')
    require(fields.get('TeamIdentifier') == team and dr and 'cdhash ' not in dr,
            'The signed bundle has no stable designated requirement and Apple team.')
    with tempfile.TemporaryDirectory(prefix='cicada-signature-') as temporary:
        prefix = Path(temporary) / 'certificate'
        result = subprocess.run(['/usr/bin/codesign', '-d', '--extract-certificates',
                                 str(prefix), str(bundle)], capture_output=True)
        leaf = Path(str(prefix) + '0')
        require(result.returncode == 0 and leaf.is_file(), 'Cannot verify the signing certificate.')
        fingerprint = hashlib.sha1(leaf.read_bytes()).hexdigest().upper()
    require(fingerprint == identity, 'The bundle was signed with an unexpected certificate.')
    return {'type': 'apple', 'team_id': team, 'certificate_sha1': fingerprint,
            'designated_requirement': dr}


def bundle_hashes(bundle):
    return {path.relative_to(bundle).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(bundle.rglob('*')) if path.is_file() and not path.is_symlink()}


def verify_updater_archive(archive, signature=None, expected_files=None):
    # Tauri 2.11 strips the top-level member and writes Contents to the
    # currently installed bundle, including 0.3.22's Hanni MVP.app path.
    with tarfile.open(archive, 'r:gz') as members:
        entries = members.getmembers()
        names = [member.name for member in entries]
    require(names and all((name == 'Cicada.app' or name.startswith('Cicada.app/'))
                          and '..' not in PurePosixPath(name).parts for name in names),
            'The macOS updater archive must contain exactly one Cicada.app root.')
    require('Cicada.app/Contents/MacOS/hanni-mvp' in names,
            'The macOS updater archive is missing the compatible executable.')
    require(len(names) == len(set(names)) and all(entry.isfile() or entry.isdir() for entry in entries),
            'The macOS updater archive must not contain links, special files or duplicate entries.')
    if signature is not None:
        with tempfile.TemporaryDirectory(prefix='cicada-archive-') as temporary:
            with tarfile.open(archive, 'r:gz') as members:
                members.extractall(temporary, filter='data')
            bundle = Path(temporary) / 'Cicada.app'
            actual = ({'type': 'vault', 'cdhash': vault.signature(bundle),
                       'helper_cdhash': signature['helper_cdhash']} if signature.get('type') == 'vault'
                      else verify_signature(bundle, signature['team_id'], signature['certificate_sha1']))
            require(actual == signature, 'The updater archive has a different application signature.')
            require(expected_files is None or bundle_hashes(Path(temporary) / 'Cicada.app') == expected_files,
                    'The updater archive differs from the verified application bundle.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--updater', action='store_true')
    args = parser.parse_args()
    require(sys.platform == 'darwin', 'Build this package on macOS.')
    use_vault = vault.PIN.is_file()
    if use_vault:
        helper, helper_pin = vault.helper()
        identity, team = '-', None
    else:
        identity, team = signing_configuration(os.environ)
        identities = output('/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning')
        require(identity in identities, 'The configured Apple signing identity is unavailable; no package was built.')
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
    environment = dict(os.environ, APPLE_SIGNING_IDENTITY=identity)
    environment.pop('CICADA_VAULT_CDHASH', None)
    if use_vault:
        require(environment.get('TAURI_SIGNING_PRIVATE_KEY'), 'The release signer is required to authorize the vault client.')
        environment['CICADA_VAULT_CDHASH'] = helper_pin['cdhash']
    for name in ('APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_ISSUER',
                 'APPLE_API_KEY', 'APPLE_API_KEY_PATH', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD'):
        environment.pop(name, None)
    command = ['npm', 'run', 'tauri', '--', 'build', '--bundles', 'app', '--ci',
               '--config', 'src-tauri/tauri.macos.conf.json']
    if use_vault:
        command.extend(['--config', json.dumps({'bundle': {'macOS': {'minimumSystemVersion': '12.0'}}})])
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
    if use_vault:
        subprocess.run(['codesign', '--force', '--sign', '-', '--options', 'runtime',
                        '--timestamp=none', str(bundle)], check=True)
        signature = {'type': 'vault', 'cdhash': vault.signature(bundle), 'helper_cdhash': helper_pin['cdhash']}
    else:
        signature = verify_signature(bundle, team, identity)
    directory = ROOT / '.local/mac-package' / commit[:12]
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / 'Cicada.app'
    require(not destination.exists(), 'This commit already has a package; inspect the existing artifact.')
    subprocess.run(['ditto', str(bundle), str(destination)], check=True)
    if use_vault:
        import shutil
        vault.attest(destination, config['version'], helper_pin, directory, environment, helper)
        shutil.copy2(helper, directory / 'cicada-vault')
    hashes = bundle_hashes(destination)
    archive = directory / 'Cicada-macos.zip'
    subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent',
                    str(destination), str(archive)], check=True)
    if args.updater:
        import shutil
        updater = bundle.with_name(bundle.name + '.tar.gz')
        if use_vault:
            # The final hardened signature differs from Tauri's intermediate
            # app. Repack exactly the verified bytes before signing delivery.
            with tarfile.open(updater, 'w:gz') as archive_file:
                archive_file.add(destination, arcname='Cicada.app')
        require(updater.is_file(), 'Tauri did not create the macOS updater archive.')
        verify_updater_archive(updater, signature, hashes)
        shutil.copyfile(updater, directory / updater.name)
    manifest = {
        'schema_version': 1, 'application': config['productName'], 'identifier': config['identifier'],
        'version': config['version'], 'channel': 'local-mvp', 'platform': 'macos-' + platform.machine(),
        'profile': 'release-with-embedded-web-assets', 'source_repository': origin, 'source_commit': commit,
        'application_bundle': destination.name, 'files_sha256': hashes,
        'archive': archive.name, 'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
        'signing': signature, 'notarized': False,
    }
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    sys.stdout.write(f'macOS MVP package: {directory}\n')


if __name__ == '__main__':
    main()
