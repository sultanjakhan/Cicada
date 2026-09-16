import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/check-public-history.py'


class PublicHistoryTests(unittest.TestCase):
    def test_deleted_private_file_and_old_metadata_are_still_detected(self):
        with tempfile.TemporaryDirectory() as folder:
            env = dict(os.environ, GIT_AUTHOR_NAME='Test', GIT_COMMITTER_NAME='Test',
                       GIT_AUTHOR_EMAIL='test@example.test', GIT_COMMITTER_EMAIL='test@example.test')
            def git(*args, **overrides):
                return subprocess.run(['git', *args], cwd=folder, env={**env, **overrides},
                                      capture_output=True, check=True)
            git('init', '-b', 'main')
            Path(folder, 'fixture.txt').write_text('example fixture', encoding='utf-8')
            git('add', 'fixture.txt')
            personal_email = 'fictional' + '@' + 'gmail.com'
            git('commit', '-m', 'initial', GIT_AUTHOR_EMAIL=personal_email)
            clean_parent = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=folder).decode().strip()
            private_name = 'credentials.json'
            Path(folder, private_name).write_text('{}', encoding='utf-8')
            git('add', private_name)
            git('commit', '-m', 'fixture')
            git('rm', private_name)
            git('commit', '-m', 'remove fixture')
            result = subprocess.run(['python', '-B', str(SCRIPT)], cwd=folder, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn('private-file', result.stdout)
            self.assertIn('personal-email', result.stdout)
            self.assertNotIn(personal_email, result.stdout)
            # A scoped ref must inspect its complete ancestry, not just the tip diff.
            result = subprocess.run(['python', '-B', str(SCRIPT), '--ref', clean_parent],
                                    cwd=folder, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('personal-email', result.stdout)
            self.assertNotIn('private-file', result.stdout)
            # A shared hook must resolve the scanner beside the hook, even when
            # the pushing checkout does not contain this project's scripts.
            remote = str(Path(folder, 'remote.git'))
            git('init', '--bare', remote)
            git('config', 'core.hooksPath', str(SCRIPT.parents[1] / '.githooks'))
            result = subprocess.run(['git', 'push', remote, 'main'], cwd=folder,
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('personal-email', result.stdout + result.stderr)
            self.assertNotIn(personal_email, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
