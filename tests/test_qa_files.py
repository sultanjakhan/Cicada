import importlib.util
from pathlib import Path
import os
import sys
import tempfile
import subprocess
import unittest
import json
from concurrent.futures import ThreadPoolExecutor
import win32con
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import qa_files

def module(name, filename):
    spec=importlib.util.spec_from_file_location(name,SCRIPTS/filename)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

class QaFilesTests(unittest.TestCase):
    def test_existing_lock_hardlink_is_rejected_without_outside_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); outside=root/'outside.txt';outside.write_bytes(b'preserve')
            os.link(outside,root/'active.lock')
            with self.assertRaises(RuntimeError): qa_files.write_bytes(root/'active.lock',b'overwrite')
            self.assertEqual(outside.read_bytes(),b'preserve')

    def test_create_new_staging_and_directory_identity_refuse_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); stage=root/'stage.exe';outside=root/'outside.txt';outside.write_bytes(b'preserve')
            os.link(outside,stage)
            with self.assertRaises(Exception): qa_files.write_bytes(stage,b'overwrite',new=True)
            self.assertEqual(outside.read_bytes(),b'preserve')
            stage.unlink()
            with qa_files.pinned_tree(root):
                renamed=root.with_name(root.name+'-renamed');blocked=False
                try:os.rename(root,renamed)
                except OSError:blocked=True
                finally:
                    if renamed.exists():os.rename(renamed,root)
                self.assertTrue(blocked,'directory identity was not pinned')
                qa_files.write_bytes(stage,b'new',new=True)
            self.assertEqual(stage.read_bytes(),b'new')

    def test_parent_junction_is_rejected_before_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); target=root/'target';target.mkdir();link=root/'junction'
            subprocess.run(['cmd','/c','mklink','/J',str(link),str(target)],check=True,capture_output=True)
            try:
                with self.assertRaises(RuntimeError):
                    with qa_files.pinned_tree(link/'new',create=True): self.fail('unsafe root accepted')
                self.assertFalse((target/'new').exists())
            finally: os.rmdir(link)

    def test_real_launcher_rejects_reused_hardlink_before_desktop_or_process(self):
        launcher=module('qa_background_test','qa-background.py')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);run=root/'.local/background-qa/fixture';run.mkdir(parents=True)
            exe=root/'hanni-mvp.exe';binary=b'isolated_test_integration_disabled';exe.write_bytes(binary)
            import hashlib
            digest=hashlib.sha256(binary).hexdigest()
            (run/'profile.json').write_text(json.dumps({'application':'app.hanni.mvp','purpose':'isolated-background-qa','exe_sha256':digest}))
            outside=root/'outside.txt';outside.write_bytes(b'preserve');os.link(outside,run/'active.lock')
            callbacks=[]
            args=['qa','--exe',str(exe),'--expected-sha256',digest,'--mcp-cli',str(exe),'--node',sys.executable,'--session','fixture','--release-isolation']
            try:
                with mock.patch.object(launcher,'__file__',str(root/'scripts/qa-background.py')),mock.patch.object(sys,'argv',args),mock.patch.object(launcher.atexit,'register',lambda f:callbacks.append(f)),mock.patch.object(launcher,'input_desktop',side_effect=AssertionError('desktop reached')):
                    with self.assertRaises(RuntimeError):launcher.main()
                self.assertEqual(outside.read_bytes(),b'preserve')
            finally:
                for close in reversed(callbacks):close()

    def test_rollback_staging_alias_rejected_before_exe_or_database_write(self):
        fixture=module('portable_test','portable-update-fixture.py')
        with tempfile.TemporaryDirectory() as directory:
            workspace=Path(directory);root=workspace/'.local/fixture';(root/'installed').mkdir(parents=True);(root/'data').mkdir()
            (root/'fixture.json').write_text(json.dumps({'purpose':'synthetic-portable-update'}))
            target=root/'installed/hanni-mvp.exe';target.write_bytes(b'current')
            (root/'hanni-mvp.previous.exe').write_bytes(b'old')
            outside=workspace/'outside.txt';outside.write_bytes(b'preserve');os.link(outside,root/'installed/hanni-mvp.rollback.exe')
            with mock.patch.object(fixture,'ROOT',workspace):
                with self.assertRaises(RuntimeError):fixture.rollback(root)
            self.assertEqual(outside.read_bytes(),b'preserve');self.assertEqual(target.read_bytes(),b'current')

    def test_sqlite_alias_is_rejected_before_rollback(self):
        fixture=module('portable_db_test','portable-update-fixture.py')
        with tempfile.TemporaryDirectory() as directory:
            workspace=Path(directory);root=workspace/'.local/fixture';(root/'installed').mkdir(parents=True);(root/'data').mkdir()
            outside=workspace/'outside.txt';outside.write_bytes(b'preserve');os.link(outside,root/'data/calendar.db')
            target=root/'installed/hanni-mvp.exe';target.write_bytes(b'current')
            with mock.patch.object(fixture,'ROOT',workspace):
                with self.assertRaises(RuntimeError):fixture.rollback(root)
            self.assertEqual(outside.read_bytes(),b'preserve');self.assertEqual(target.read_bytes(),b'current')

    def test_opened_file_identity_blocks_concurrent_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);target=root/'owned';other=root/'replacement';target.write_bytes(b'owned');other.write_bytes(b'other')
            handle=qa_files.checked_handle(target,win32con.GENERIC_READ,win32con.OPEN_EXISTING,share=3)
            try:
                with ThreadPoolExecutor(max_workers=1) as executor:
                    with self.assertRaises(OSError):executor.submit(os.replace,other,target).result()
                self.assertEqual(target.read_bytes(),b'owned')
            finally:handle.Close()

if __name__=='__main__':unittest.main()
