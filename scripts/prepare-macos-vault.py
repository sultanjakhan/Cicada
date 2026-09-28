#!/usr/bin/env python3
"""Install the pinned broker and a verified client proof; never replace Cicada."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile

import macos_vault_package as vault


def atomic_file(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        os.chmod(temporary, mode)
        file.write(content)
        file.flush()
        os.fsync(file.fileno())
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def prepare(bundle, proof_path):
    source, pin = vault.helper()
    proof = json.loads(proof_path.read_text())
    # Use the same release verifier as distribution. The path arguments contain
    # public artifacts only; no token or signing secret is passed to Node.
    javascript = '''import {readFileSync} from 'node:fs';
import {verifyTauriSignature} from './scripts/stage-updates.mjs';
const proof=JSON.parse(readFileSync(process.argv[1],'utf8'));
verifyTauriSignature(Buffer.from(proof.manifest),proof.signature,readFileSync('src-tauri/update-public-key.txt','utf8'));
'''
    result = subprocess.run(['node', '--input-type=module', '-e', javascript, str(proof_path)],
                            cwd=vault.ROOT, capture_output=True)
    vault.require(result.returncode == 0, 'The release signer has not authorized this vault client.')
    identity = json.loads(proof['manifest'])
    vault.require(identity.get('purpose') == 'cicada-vault-client' and identity.get('protocol') == 1
                  and identity.get('application') == 'app.hanni.mvp' and identity.get('architecture') == 'aarch64'
                  and identity.get('helper_cdhash') == pin['cdhash']
                  and identity.get('cdhash') == vault.admit(bundle, source), 'The proof does not match this application and helper.')
    info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
    vault.require(info.get('CFBundleIdentifier') == 'app.hanni.mvp'
                  and info.get('CFBundleExecutable') == 'hanni-mvp'
                  and info.get('CFBundleShortVersionString') == identity.get('version'), 'Unexpected application metadata.')
    profile = Path.home() / 'Library/Application Support/app.hanni.mvp'
    destination = profile / 'vault/v1/cicada-vault'
    if destination.exists():
        vault.require(not destination.is_symlink()
                      and hashlib.sha256(destination.read_bytes()).hexdigest() == pin['sha256'],
                      'An existing credential helper differs. Migration is required; it was not overwritten.')
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        atomic_file(destination, source.read_bytes(), 0o700)
    vault.require(vault.signature(destination) == pin['cdhash'], 'Installed helper identity is invalid.')
    agent = Path.home() / 'Library/LaunchAgents/app.hanni.mvp.vault.v1.plist'
    definition = dict(Label='app.hanni.mvp.vault.v1', ProgramArguments=[str(destination)],
                      MachServices={'app.hanni.mvp.vault.v1': True}, ProcessType='Background')
    if agent.exists():
        vault.require(not agent.is_symlink() and plistlib.loads(agent.read_bytes()) == definition,
                      'An existing vault LaunchAgent differs; it was not overwritten.')
    else:
        atomic_file(agent, plistlib.dumps(definition))
    domain = f'gui/{os.getuid()}'
    loaded = subprocess.run(['launchctl', 'print', domain + '/app.hanni.mvp.vault.v1'], capture_output=True)
    if loaded.returncode:
        subprocess.run(['launchctl', 'bootstrap', domain, str(agent)], check=True)
    atomic_file(profile / 'vault/proofs' / f"{identity['cdhash']}.json", json.dumps(proof).encode())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--proof', required=True, type=Path)
    args = parser.parse_args()
    prepare(args.bundle.resolve(), args.proof.resolve())
