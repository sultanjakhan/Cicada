"""Packaging helpers for the immutable macOS credential broker."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PIN = ROOT / 'native/macos-vault/release.json'


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def signature(binary):
    verified = subprocess.run(['codesign', '--verify', '--deep', '--strict', str(binary)], capture_output=True)
    require(verified.returncode == 0, 'Invalid native signature.')
    result = subprocess.run(['codesign', '-d', '--verbose=4', str(binary)], capture_output=True, text=True)
    require(result.returncode == 0, 'Cannot inspect native identity.')
    fields = dict(line.split('=', 1) for line in result.stderr.splitlines() if '=' in line)
    require(re.fullmatch(r'[a-f0-9]{40}', fields.get('CDHash', '')), 'Missing native CDHash.')
    flags = re.search(r'flags=0x([0-9a-fA-F]+)', result.stderr)
    require(flags and int(flags[1], 16) & 0x10000, 'The credential client requires hardened runtime.')
    return fields['CDHash']


def helper():
    require(PIN.is_file(), 'Freeze and pin the credential helper before packaging free macOS updates.')
    pin = json.loads(PIN.read_text())
    require(pin.get('protocol') == 1 and re.fullmatch(r'[a-f0-9]{64}', pin.get('sha256', ''))
            and re.fullmatch(r'[a-f0-9]{40}', pin.get('cdhash', '')), 'Invalid credential-helper pin.')
    override = os.environ.get('MVP_MACOS_VAULT_BINARY')
    binary = Path(override) if override else ROOT / '.local/macos-vault' / pin['sha256'] / 'cicada-vault'
    if not binary.is_file() and not override:
        url = pin.get('url', '')
        require(url.startswith('https://github.com/sultanjakhan/Cicada/releases/download/'),
                'The pinned credential helper has no published artifact yet.')
        binary.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read(16 * 1024 * 1024 + 1)
        require(len(data) <= 16 * 1024 * 1024 and hashlib.sha256(data).hexdigest() == pin['sha256'],
                'Downloaded credential helper differs from the immutable pin.')
        binary.write_bytes(data)
        binary.chmod(0o700)
    require(binary.is_file() and not binary.is_symlink(), 'Credential helper is unavailable.')
    require(hashlib.sha256(binary.read_bytes()).hexdigest() == pin['sha256'],
            'Never silently replace the credential helper during an app update.')
    require(signature(binary) == pin['cdhash'], 'Credential-helper identity differs from its pin.')
    return binary, pin


def admit(bundle, binary):
    cdhash = signature(bundle)
    result = subprocess.run([str(binary), '--check-client', str(bundle), cdhash], capture_output=True)
    require(result.returncode == 0, 'The vault rejects this client runtime or entitlements; do not release it.')
    return cdhash


def attest(bundle, version, pin, destination, environment, binary):
    require(environment.get('TAURI_SIGNING_PRIVATE_KEY'),
            'The existing release signer must authorize the new vault client.')
    cdhash = admit(bundle, binary)
    manifest = dict(purpose='cicada-vault-client', protocol=1, application='app.hanni.mvp',
                    architecture='aarch64', version=version, cdhash=cdhash, helper_cdhash=pin['cdhash'])
    payload = destination / 'vault-client.json'
    payload.write_text(json.dumps(manifest, separators=(',', ':')))
    result = subprocess.run(['node', 'node_modules/@tauri-apps/cli/tauri.js', 'signer', 'sign', str(payload)],
                            cwd=ROOT, env=environment, capture_output=True)
    require(result.returncode == 0, 'Could not sign the vault-client attestation.')
    proof = dict(manifest=payload.read_text(), signature=payload.with_suffix('.json.sig').read_text().strip())
    (destination / 'vault-proof.json').write_text(json.dumps(proof, indent=2) + '\n')
    return proof


def freeze(destination):
    require(not destination.exists(), 'Use a new artifact directory; do not overwrite a frozen helper.')
    subprocess.run(['cargo', 'build', '--release', '--locked', '--manifest-path',
                    'native/macos-vault/Cargo.toml', '--bin', 'cicada-macos-vault'], cwd=ROOT, check=True)
    destination.mkdir(parents=True)
    binary = destination / 'cicada-vault'
    shutil.copy2(ROOT / 'native/macos-vault/target/release/cicada-macos-vault', binary)
    subprocess.run(['codesign', '--force', '--sign', '-', '--options', 'runtime',
                    '--identifier', 'app.hanni.mvp.vault.v1', '--timestamp=none', str(binary)], check=True)
    pin = dict(protocol=1, sha256=hashlib.sha256(binary.read_bytes()).hexdigest(), cdhash=signature(binary), url='')
    (destination / 'release.json').write_text(json.dumps(pin, indent=2) + '\n')
    return pin


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze', type=Path, required=True)
    options = parser.parse_args()
    freeze(options.freeze.resolve())
