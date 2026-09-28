import importlib.util
from io import BytesIO
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import subprocess


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_macos', ROOT / 'scripts/package-macos.py')
package_macos = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package_macos)


def archive_with(root, destination):
    with tarfile.open(destination, 'w:gz') as archive:
        content = b'signed Cicada bridge fixture'
        member = tarfile.TarInfo(f'{root}/Contents/MacOS/hanni-mvp')
        member.size = len(content)
        archive.addfile(member, BytesIO(content))


class MacUpdaterArchiveTest(unittest.TestCase):
    def test_vault_archive_rejects_a_different_client_build(self):
        signature = {'type': 'vault', 'cdhash': 'a' * 40, 'helper_cdhash': 'b' * 40}
        with tempfile.TemporaryDirectory() as temp:
            archive_path = Path(temp) / 'candidate.tar.gz'
            archive_with('Cicada.app', archive_path)
            with patch.object(package_macos.vault, 'signature', return_value='a' * 40):
                package_macos.verify_updater_archive(archive_path, signature)
            with patch.object(package_macos.vault, 'signature', return_value='c' * 40):
                with self.assertRaises(SystemExit):
                    package_macos.verify_updater_archive(archive_path, signature)

    def test_packaging_requires_a_persistent_identity_and_team(self):
        for environment in ({}, {'APPLE_SIGNING_IDENTITY': '-'},
                            {'APPLE_SIGNING_IDENTITY': 'A' * 40},
                            {'APPLE_SIGNING_IDENTITY': 'A' * 40, 'MVP_MACOS_TEAM_ID': 'wrong'}):
            with self.subTest(environment=environment), self.assertRaises(SystemExit):
                package_macos.signing_configuration(environment)
        self.assertEqual(package_macos.signing_configuration({
            'APPLE_SIGNING_IDENTITY': 'a' * 40, 'MVP_MACOS_TEAM_ID': 'TESTTEAM01'}),
            ('A' * 40, 'TESTTEAM01'))

    def test_invalid_signature_is_rejected_before_reading_metadata(self):
        with patch.object(package_macos.subprocess, 'run', return_value=
                          subprocess.CompletedProcess([], 1)) as run:
            with self.assertRaises(SystemExit):
                package_macos.verify_signature(Path('candidate.app'), 'TESTTEAM01', 'A' * 40)
            self.assertEqual(run.call_count, 1)
            self.assertIn('-R=anchor apple generic and identifier "app.hanni.mvp" '
                          'and certificate leaf[subject.OU] = "TESTTEAM01"', run.call_args.args[0])

    def test_wrong_team_and_code_hash_identity_are_rejected(self):
        for metadata in ('TeamIdentifier=OTHERTEAM0\ndesignated => identifier "app.hanni.mvp"',
                         'TeamIdentifier=TESTTEAM01\ndesignated => cdhash H"abc"',
                         'TeamIdentifier=not set\ndesignated => identifier "app.hanni.mvp"'):
            with self.subTest(metadata=metadata), patch.object(package_macos.subprocess, 'run',
                    side_effect=[subprocess.CompletedProcess([], 0),
                                 subprocess.CompletedProcess([], 0, metadata, '')]):
                with self.assertRaises(SystemExit):
                    package_macos.verify_signature(Path('candidate.app'), 'TESTTEAM01', 'A' * 40)

    def test_new_archive_replaces_old_bundle_contents(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive_path = root / 'Cicada.app.tar.gz'
            archive_with('Cicada.app', archive_path)
            package_macos.verify_updater_archive(archive_path)

            # Tauri updater 2.11.0 discards the archive's first path component
            # and installs the remaining Contents in the current .app path.
            old_bundle = root / 'Applications/Hanni MVP.app'
            with tarfile.open(archive_path, 'r:gz') as archive:
                for member in archive.getmembers():
                    relative = Path(*Path(member.name).parts[1:])
                    target = old_bundle / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.extractfile(member).read())
            self.assertEqual((old_bundle / 'Contents/MacOS/hanni-mvp').read_bytes(),
                             b'signed Cicada bridge fixture')

    def test_rejects_wrong_root(self):
        with tempfile.TemporaryDirectory() as temp:
            archive_path = Path(temp) / 'bad.app.tar.gz'
            archive_with('Hanni MVP.app', archive_path)
            with self.assertRaises(SystemExit):
                package_macos.verify_updater_archive(archive_path)

    def test_rejects_links_and_duplicate_archive_members(self):
        for kind in ('symlink', 'hardlink', 'duplicate', 'traversal'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp:
                archive_path = Path(temp) / 'bad.tar.gz'
                with tarfile.open(archive_path, 'w:gz') as archive:
                    entry = tarfile.TarInfo('Cicada.app/Contents/MacOS/hanni-mvp')
                    archive.addfile(entry, BytesIO())
                    extra = tarfile.TarInfo('Cicada.app/Contents/link')
                    if kind in ('symlink', 'hardlink'):
                        extra.type = tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE
                        extra.linkname = '/tmp/outside'
                    elif kind == 'duplicate':
                        extra.name = entry.name
                    else:
                        extra.name = 'Cicada.app/../../outside'
                    archive.addfile(extra, BytesIO())
                with self.assertRaises(SystemExit):
                    package_macos.verify_updater_archive(archive_path)

    def test_archive_signature_must_equal_packaged_bundle_signature(self):
        signature = {'type': 'apple', 'team_id': 'TESTTEAM01', 'certificate_sha1': 'A' * 40,
                     'designated_requirement': 'original requirement'}
        with tempfile.TemporaryDirectory() as temp:
            archive_path = Path(temp) / 'candidate.tar.gz'
            archive_with('Cicada.app', archive_path)
            with patch.object(package_macos, 'verify_signature', return_value=signature) as verify:
                package_macos.verify_updater_archive(archive_path, signature)
                self.assertEqual(verify.call_args.args[1:], ('TESTTEAM01', 'A' * 40))
                with self.assertRaises(SystemExit):
                    package_macos.verify_updater_archive(archive_path, signature,
                                                        {'Contents/MacOS/hanni-mvp': 'different build'})
            with patch.object(package_macos, 'verify_signature', return_value={**signature,
                              'designated_requirement': 'weaker requirement'}):
                with self.assertRaises(SystemExit):
                    package_macos.verify_updater_archive(archive_path, signature)


if __name__ == '__main__':
    unittest.main()
