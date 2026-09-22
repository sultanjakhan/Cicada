import importlib.util
from io import BytesIO
from pathlib import Path
import tarfile
import tempfile
import unittest


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


if __name__ == '__main__':
    unittest.main()
