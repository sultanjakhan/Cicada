import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import os
import contextlib
import io

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'check-private-data.py'
spec = importlib.util.spec_from_file_location('privacy_guard', SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class PrivacyGuardTests(unittest.TestCase):
    def test_patterns_and_private_files(self):
        fixtures = {
            'personal-email': 'fictional' + '@' + 'gmail.com',
            'access-token': 'ghp_' + 'a' * 36,
            'private-key': '-----BEGIN ' + 'PRIVATE KEY-----',
            'personal-home-path': 'C:/' + 'Users/' + 'fictional-person/data',
        }
        for code, value in fixtures.items():
            self.assertIn((1, code), guard.text_rules(value, []))
        for path in ['calendar.db', '.env.local', 'exports/items.csv', 'backup.bak', 'records.jsonl']:
            self.assertEqual(guard.path_rules(path), ['private-file'])
        self.assertEqual(guard.text_rules('demo@example.com', []), [])
        self.assertEqual(guard.text_rules('Only synthetic marker', ['synthetic marker']), [(1, 'local-private-marker')])

    def test_scans_untracked_files_without_echoing_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run(['git', 'init', '--quiet', directory], check=True)
            secret = 'ghp_' + 'a' * 36
            (Path(directory) / 'example.txt').write_text(secret, encoding='utf-8')
            result = subprocess.run([sys.executable, '-B', str(SCRIPT)], cwd=directory, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn('example.txt:1: access-token', result.stdout)
            self.assertNotIn(secret, result.stdout + result.stderr)

    def test_private_metadata_is_reported_without_reading_contents(self):
        private_paths = ['storage.local.json', 'connection.local.json', 'credentials.bin', 'secrets.txt',
                         'secret.dpapi', 'keys/fixture.txt', 'profiles/fixture.txt', 'sessions/fixture.txt',
                         'private/fixture.txt', 'backups/fixture.txt', 'exports/fixture.txt']
        for path in private_paths:
            self.assertEqual(guard.path_rules(path), ['private-file'])
        self.assertEqual(guard.path_rules('.env.example'), [])
        self.assertEqual(guard.path_rules('src/public.txt'), [])
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run(['git', 'init', '--quiet', directory], check=True)
            root = Path(directory)
            for relative in private_paths:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('Synthetic private bytes must never be read', encoding='utf-8')
            previous = Path.cwd()
            try:
                os.chdir(root)
                with mock.patch.object(Path, 'read_bytes', side_effect=AssertionError('private content read')), mock.patch.object(sys, 'argv', [str(SCRIPT)]), contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(guard.main(), 1)
                self.assertEqual(output.getvalue().count(':0: private-file'), len(private_paths))
            finally:
                os.chdir(previous)

    def test_linked_ancestor_blocks_scan_before_child_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parent = root / 'redirect'
            parent.mkdir()
            with mock.patch.object(Path, 'is_symlink', lambda path: path == parent):
                self.assertTrue(guard.unreviewed_reparse(root, 'redirect/public.txt'))


if __name__ == '__main__':
    unittest.main()
