"""Test the existing upgrader's active-flat-helper route with fictional stores."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import upgrade_050 as upgrade

ROOT=Path(__file__).resolve().parent
CANDIDATE=ROOT/'cicada-local-tasks-0.5.1'
BASELINE_BYTES=base64.b64decode((ROOT/'fixtures/seven-tool-baseline.b64').read_text())
NEW_SHA=hashlib.sha256((CANDIDATE/'vendor/agent_mcp.py').read_bytes()).hexdigest()

class FlatUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.helper=self.root/'tools/agent_mcp.py';self.helper.parent.mkdir()
        self.baseline=self.root/'baseline.py';self.baseline.write_bytes(BASELINE_BYTES)
        self.helper.write_bytes(BASELINE_BYTES)
        self.backup=self.root/'backup'
        self.args=argparse.Namespace(flat_helper=self.helper,expected_helper_sha256=upgrade.FLAT_BASE_SHA256,
            candidate=CANDIDATE,expected_candidate_sha256=NEW_SHA,rollback_backup=None)
    def tearDown(self):self.tmp.cleanup()
    def test_reference_and_cli_plan_apply_rollback(self):
        self.assertEqual(upgrade.file_sha(self.baseline),upgrade.FLAT_BASE_SHA256)
        unrelated=self.root/'tools/client.exe';unrelated.write_bytes(b'fictional-client')
        config=self.root/'tools/config.json';config.write_text('{"synthetic":true}')
        before={p:p.read_bytes() for p in [unrelated,config]}
        cmd=[sys.executable,'-B',str(ROOT/'upgrade_050.py'),'--flat-helper',str(self.helper),
             '--expected-helper-sha256',upgrade.FLAT_BASE_SHA256,'--candidate',str(CANDIDATE),
             '--expected-candidate-sha256',NEW_SHA,'--backup-root',str(self.backup)]
        dry=subprocess.run(cmd,capture_output=True,text=True,timeout=10)
        self.assertEqual(dry.returncode,0,dry.stderr);self.assertFalse(json.loads(dry.stdout)['apply'])
        self.assertFalse(self.backup.exists());self.assertEqual(upgrade.file_sha(self.helper),upgrade.FLAT_BASE_SHA256)
        applied=subprocess.run(cmd+['--apply'],capture_output=True,text=True,timeout=10)
        self.assertEqual(applied.returncode,0,applied.stderr)
        self.assertEqual(upgrade.file_sha(self.helper),NEW_SHA)
        self.assertEqual((self.backup/'agent_mcp.py.before').read_bytes(),BASELINE_BYTES)
        retry=subprocess.run(cmd+['--apply'],capture_output=True,text=True,timeout=10)
        self.assertNotEqual(retry.returncode,0);self.assertEqual(upgrade.file_sha(self.helper),NEW_SHA)
        rollback=[sys.executable,'-B',str(ROOT/'upgrade_050.py'),'--flat-helper',str(self.helper),
                  '--expected-helper-sha256',NEW_SHA,'--rollback-backup',str(self.backup),
                  '--backup-root',str(self.root/'rollback-backup'),'--apply']
        undone=subprocess.run(rollback,capture_output=True,text=True,timeout=10)
        self.assertEqual(undone.returncode,0,undone.stderr)
        self.assertEqual(upgrade.file_sha(self.helper),upgrade.FLAT_BASE_SHA256)
        self.assertEqual({p:p.read_bytes() for p in before},before)
        self.assertEqual({p.name for p in self.helper.parent.iterdir()},{'agent_mcp.py','client.exe','config.json'})
    def test_stale_or_wrong_candidate_and_symlink_rejected(self):
        for field,value in [('expected_helper_sha256','0'*64),('expected_candidate_sha256','0'*64)]:
            args=argparse.Namespace(**vars(self.args));setattr(args,field,value)
            with self.assertRaises(ValueError):upgrade.flat_plan(args)
        self.helper.write_bytes(b'four-tool-or-foreign-helper')
        with self.assertRaises(ValueError):upgrade.flat_plan(self.args)
        self.helper.unlink();self.helper.symlink_to(self.baseline)
        with self.assertRaises(ValueError):upgrade.flat_plan(self.args)
        self.assertFalse(self.backup.exists())
    def test_late_edit_preserved_and_replace_failure_keeps_original(self):
        data=upgrade.flat_plan(self.args)
        self.helper.write_bytes(b'concurrent-edit')
        with self.assertRaises(RuntimeError):upgrade.flat_apply(data,self.backup)
        self.assertEqual(self.helper.read_bytes(),b'concurrent-edit');self.assertFalse(self.backup.exists())
        self.helper.write_bytes(BASELINE_BYTES)
        with patch.object(upgrade.os,'replace',side_effect=PermissionError('synthetic locked helper')):
            with self.assertRaises(PermissionError):upgrade.flat_apply(data,self.backup)
        self.assertEqual(self.helper.read_bytes(),BASELINE_BYTES)
        self.assertEqual(list(self.helper.parent.glob('.cicada-helper-*')),[])
    def test_rollback_rejects_newer_installed_bytes(self):
        data=upgrade.flat_plan(self.args);upgrade.flat_apply(data,self.backup)
        self.helper.write_bytes(b'newer-foreign-version')
        self.args.rollback_backup=self.backup;self.args.expected_helper_sha256=NEW_SHA
        with self.assertRaises(ValueError):upgrade.flat_plan(self.args)
        self.assertEqual(self.helper.read_bytes(),b'newer-foreign-version')

if __name__=='__main__':unittest.main()
