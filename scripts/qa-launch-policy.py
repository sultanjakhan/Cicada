"""Pure fail-closed launch policy: no process, desktop or production data access."""
import hashlib
import json
from pathlib import Path

MARKER = {'schemaVersion': 1, 'application': 'app.hanni.mvp', 'purpose': 'isolated-release-test'}

def verify_binary(binary, expected_sha256, explicit_isolation):
    if not explicit_isolation:
        raise ValueError('QA requires explicit --release-isolation; environment-only isolation is forbidden')
    if hashlib.sha256(binary).hexdigest() != expected_sha256.lower():
        raise ValueError('Candidate hash changed')
    if b'isolated_test_integration_disabled' not in binary:
        raise ValueError('Explicit native isolation support is absent')

def launch_args(exe, data, mode):
    data = Path(data)
    if not data.is_absolute() or mode not in ('foreground', 'background'):
        raise ValueError('Invalid isolated QA launch')
    for path in (data, *data.parents):
        if path.is_symlink() or getattr(path.stat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('Linked QA root is forbidden')
    marker = data / 'cicada-isolated-test.json'
    if not data.is_dir() or not marker.is_file() or marker.is_symlink() or getattr(marker.stat(), 'st_file_attributes', 0) & 0x400 or marker.stat().st_nlink != 1 or marker.stat().st_size > 512:
        raise ValueError('Missing or unsafe native isolation marker')
    if json.loads(marker.read_text(encoding='utf-8')) != MARKER:
        raise ValueError('Invalid native isolation marker')
    return [str(exe), '--isolated-test-root', str(data)] + (['--background'] if mode == 'background' else [])
