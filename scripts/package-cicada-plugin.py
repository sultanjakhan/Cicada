#!/usr/bin/env python3
"""Package tracked, credential-free MCP source with its guarded installer/upgrade."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode().strip()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--client-version', choices=['0.5.0','0.5.1','0.5.2'], default='0.5.0')
    args = parser.parse_args()
    package = Path('plugins/cicada-tasks') / ('cicada-local-tasks-' + args.client_version)
    if git('status', '--porcelain'):
        raise SystemExit('Commit source before packaging.')
    source = git('rev-parse', 'HEAD')
    manifest = json.loads((ROOT / package / 'plugin.json').read_text())
    native = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())['version']
    if manifest['version'] != args.client_version or manifest['name'] != 'cicada-local-tasks':
        raise SystemExit('Unexpected MCP package identity.')
    members = git('ls-files', str(package), 'plugins/cicada-tasks/install.py',
                  'plugins/cicada-tasks/upgrade_050.py').splitlines()
    if args.client_version in ('0.5.1', '0.5.2'):
        members += git('ls-files', 'plugins/cicada-tasks/README.md',
                       'plugins/cicada-tasks/test_flat_upgrade.py',
                       'plugins/cicada-tasks/fixtures/seven-tool-baseline.b64').splitlines()
    destination = ROOT / '.local/plugin-package' / source[:12]
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / ('cicada-local-tasks-' + args.client_version + '.zip')
    hashes = {}
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
        for name in sorted(members):
            path = ROOT / name
            if path.is_symlink() or not path.is_file():
                raise SystemExit('Package members must be ordinary tracked files.')
            relative = Path(name).relative_to('plugins/cicada-tasks').as_posix()
            data = path.read_bytes()
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            output.writestr(info, data)
            hashes[relative] = hashlib.sha256(data).hexdigest()
    with zipfile.ZipFile(archive) as readback:
        assert readback.testzip() is None
        assert set(readback.namelist()) == set(hashes)
        assert all(hashlib.sha256(readback.read(name)).hexdigest() == value for name, value in hashes.items())
    spec = importlib.util.spec_from_file_location('upgrade', ROOT/'plugins/cicada-tasks/upgrade_050.py')
    upgrade = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(upgrade)
    with tempfile.TemporaryDirectory(prefix='cicada-plugin-package-') as temporary:
        with zipfile.ZipFile(archive) as readback:
            readback.extractall(temporary)
        candidate_tree = upgrade.tree_sha(Path(temporary) / package.name)
    receipt = {'source': source, 'clientVersion': manifest['version'],
               'nativeMinimumVersion': '0.5.5' if args.client_version in ('0.5.1', '0.5.2') else native, 'nativeEnvelopeVersion': 1,
               'nativeMacTransportRequiresCandidate': args.client_version == '0.5.2',
               'candidateTreeSha256': candidate_tree,
               'archive': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
               'members': hashes}
    (destination / 'manifest.json').write_text(json.dumps(receipt, indent=2)+'\n')
    print(destination)

if __name__ == '__main__':
    main()
