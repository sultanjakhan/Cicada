#!/usr/bin/env python3
"""Exercise credential continuity with two clients and an isolated, fake Keychain.

No production app, database, token, login-keychain ACL or signing identity is used.
The temporary launchd service is removed in finally; signing output is not logged.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import secrets
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
CRATE = ROOT / 'native/macos-vault'
REPORT = ROOT / '.local/vault-proof'
SWIFT = r'''
import Foundation
import Security
let args = CommandLine.arguments
let path = args[2]
precondition(path.contains("/cicada-keychain-upgrade-") && path.hasSuffix("/fixture.keychain-db"))
SecKeychainSetUserInteractionAllowed(false)
var keychain: SecKeychain?
if args[1] == "create" {
    let password = FileHandle.standardInput.readDataToEndOfFile()
    var previous: CFArray?
    precondition(SecKeychainCopySearchList(&previous) == 0)
    let status = password.withUnsafeBytes { SecKeychainCreate(path, UInt32(password.count), $0.baseAddress, false, nil, &keychain) }
    if let previous = previous { precondition(SecKeychainSetSearchList(previous) == 0) }
    precondition(status == 0)
} else {
    precondition(SecKeychainOpen(path, &keychain) == 0)
    if args[1] == "delete" {
        precondition(SecKeychainDelete(keychain!) == 0)
    } else {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "app.hanni.mvp.vault.v1.jira", kSecAttrAccount as String: "device-v1-" + String(repeating: "a", count: 64),
            kSecMatchSearchList as String: [keychain!], kSecReturnData as String: true]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        precondition(status != 0 && status != errSecItemNotFound)
    }
}
'''


def run(args, *, env=None, input=None, check=True, timeout=120):
    result = subprocess.run(args, cwd=ROOT, env=env, input=input,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and result.returncode:
        # Signer output may contain a synthetic private key. Never echo it.
        raise RuntimeError(f'{Path(str(args[0])).name} failed ({result.returncode})')
    return result


def main():
    REPORT.mkdir(parents=True, exist_ok=True)
    before = run(['security', 'list-keychains', '-d', 'user']).stdout
    checks = {}
    service = 'app.cicada.vault.synthetic.' + uuid.uuid4().hex
    domain = f'gui/{os.getuid()}'
    with tempfile.TemporaryDirectory(prefix='cicada-keychain-upgrade-') as directory:
        folder = Path(directory)
        keychain = folder / 'fixture.keychain-db'
        fixture = folder / 'keychain-fixture'
        (folder / 'fixture.swift').write_text(SWIFT)
        run(['xcrun', 'swiftc', str(folder / 'fixture.swift'), '-o', str(fixture)])
        run([str(fixture), 'create', str(keychain)], input=secrets.token_bytes(32))
        plist = folder / 'agent.plist'
        try:
            signer = ['node', 'node_modules/@tauri-apps/cli/tauri.js', 'signer']
            env = dict(os.environ, RUSTUP_TOOLCHAIN='1.98.1', CARGO_BUILD_JOBS='2')
            env.update(CICADA_SYNTHETIC_VAULT_VERSION='first')
            run([*signer, 'generate', '--ci', '-p', 'synthetic-only', '-w', str(folder / 'release.key')])
            env['CICADA_SYNTHETIC_PUBLIC_KEY'] = (folder / 'release.key.pub').read_text().strip()
            signing_env = dict(env, TAURI_SIGNING_PRIVATE_KEY=(folder / 'release.key').read_text(),
                               TAURI_SIGNING_PRIVATE_KEY_PASSWORD='synthetic-only')

            def build(example, target):
                result = run(['cargo', 'build', '--locked', '--manifest-path', str(CRATE / 'Cargo.toml'),
                              '--features', 'synthetic-probe', '--example', example], env=env, check=False)
                (REPORT / 'build.log').write_bytes(result.stderr)
                if result.returncode: raise RuntimeError('Synthetic native build failed; inspect build.log')
                shutil.copy2(CRATE / 'target/debug/examples' / example, target)
                run(['codesign', '--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', str(target)])
                result = run(['codesign', '-d', '--verbose=4', str(target)])
                return next(line.split('=', 1)[1] for line in result.stderr.decode().splitlines() if line.startswith('CDHash='))

            helper = folder / 'vault-v1'
            helper_hash = build('synthetic-vault', helper)
            helper_bytes = hashlib.sha256(helper.read_bytes()).hexdigest()
            env['CICADA_SYNTHETIC_HELPER_CDHASH'] = helper_hash

            def client(version, attest=True):
                env['CICADA_SYNTHETIC_CLIENT_VERSION'] = version
                binary = folder / f'client-{version}'
                cdhash = build('synthetic-client', binary)
                proof = folder / f'client-{version}.proof'
                if attest:
                    payload = folder / f'client-{version}.json'
                    payload.write_text(json.dumps(dict(purpose='cicada-vault-client', protocol=1, cdhash=cdhash, application='app.hanni.mvp', architecture='aarch64', version='0.1.0', helper_cdhash=helper_hash)))
                    run([*signer, 'sign', str(payload)], env=signing_env)
                    proof.write_text(json.dumps(dict(manifest=payload.read_text(),
                        signature=payload.with_suffix('.json.sig').read_text().strip())))
                return binary, proof, cdhash

            first, first_proof, first_hash = client('first')
            second, second_proof, second_hash = client('second')
            outsider, _, _ = client('outsider', False)
            checks['distinct_client_builds'] = first_hash != second_hash

            def launch(binary):
                run(['launchctl', 'bootout', domain + '/' + service], check=False)
                plist.write_bytes(plistlib.dumps(dict(Label=service,
                    ProgramArguments=[str(binary), service, str(keychain)],
                    MachServices={service: True}, ProcessType='Background')))
                run(['launchctl', 'bootstrap', domain, str(plist)])

            def check(name, binary, proof, mode='read', allowed=True):
                result = run([str(binary), service, str(proof), mode], check=False, timeout=20)
                checks[name] = (result.returncode == 0) == allowed
                if not checks[name]:
                    (REPORT / 'failure.log').write_bytes(result.stderr)
                    raise RuntimeError('Scenario failed: ' + name)

            launch(helper)
            check('missing_legacy_import_succeeds', first, first_proof, 'import')
            check('first_build_writes', first, first_proof, 'write')
            launch(helper)
            check('second_build_reads_after_helper_restart', second, second_proof)
            check('first_build_still_reads', first, first_proof)
            check('late_import_preserves_newer_token', first, first_proof, 'stale-import')
            check('late_write_times_out_without_crashing_client', second, second_proof, 'slow-write', allowed=False)
            time.sleep(2)
            check('late_write_remains_readable', second, second_proof)
            check('explicit_disconnect_saves_tombstones', second, second_proof, 'disconnect')
            launch(helper)
            check('disconnect_survives_restart', first, first_proof, 'disconnected')
            check('late_import_preserves_disconnect', first, first_proof, 'stale-import-disconnected')
            check('explicit_reconnect_succeeds', second, second_proof, 'write')
            check('outsider_with_copied_proof_denied', outsider, first_proof, allowed=False)
            altered = json.loads(second_proof.read_text())
            altered['manifest'] += ' '
            altered_path = folder / 'altered.proof'
            altered_path.write_text(json.dumps(altered))
            check('altered_attestation_denied', second, altered_path, allowed=False)
            wrong = folder / 'wrong-helper.json'
            wrong_identity = json.loads(json.loads(second_proof.read_text())['manifest'])
            wrong_identity['helper_cdhash'] = 'a' * 40
            wrong.write_text(json.dumps(wrong_identity))
            run([*signer, 'sign', str(wrong)], env=signing_env)
            wrong_proof = folder / 'wrong-helper.proof'
            wrong_proof.write_text(json.dumps(dict(manifest=wrong.read_text(), signature=wrong.with_suffix('.json.sig').read_text().strip())))
            check('proof_for_different_helper_denied', second, wrong_proof, allowed=False)
            run([str(helper), '--check-client', str(second), second_hash])
            checks['static_admission_accepts_client'] = True
            unsafe_client = folder / 'unsafe-client'
            shutil.copy2(second, unsafe_client)
            entitlements = folder / 'entitlements.plist'
            entitlements.write_bytes(plistlib.dumps({'com.apple.security.cs.disable-library-validation': True}))
            run(['codesign', '--force', '--sign', '-', '--options', 'runtime', '--entitlements', str(entitlements), str(unsafe_client)])
            details = run(['codesign', '-d', '--verbose=4', str(unsafe_client)]).stderr.decode()
            unsafe_hash = next(line.split('=', 1)[1] for line in details.splitlines() if line.startswith('CDHash='))
            denied = run([str(helper), '--check-client', str(unsafe_client), unsafe_hash], check=False)
            checks['static_admission_rejects_injection_entitlement'] = denied.returncode != 0
            if not checks['static_admission_rejects_injection_entitlement']:
                raise RuntimeError('Unsafe candidate admission')

            env['CICADA_SYNTHETIC_VAULT_VERSION'] = 'unapproved'
            fake = folder / 'unapproved-vault'
            build('synthetic-vault', fake)
            launch(fake)
            check('unapproved_helper_denied', second, second_proof, 'write', allowed=False)
            launch(helper)
            check('saved_item_survives_denied_requests', second, second_proof)
            run([str(fixture), 'read-denied', str(keychain)])
            checks['direct_keychain_read_denied'] = True
            checks['helper_unchanged'] = hashlib.sha256(helper.read_bytes()).hexdigest() == helper_bytes
        finally:
            run(['launchctl', 'bootout', domain + '/' + service], check=False)
            run([str(fixture), 'delete', str(keychain)])
            checks['keychain_search_list_unchanged'] = before == run(['security', 'list-keychains', '-d', 'user']).stdout
            checks['production_touched'] = False
            (REPORT / 'result.json').write_text(json.dumps(checks, indent=2) + '\n')
    if not all(value for key, value in checks.items() if key != 'production_touched'):
        raise RuntimeError('Fixture checks failed')
    print(REPORT / 'result.json')


if __name__ == '__main__':
    main()
