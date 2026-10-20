"""Fail-closed artifact/identity/result checks only; these are not runtime acceptance."""
import subprocess
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('d4ae_qa', ROOT / 'scripts/d4ae-installed-qa.py')
qa = importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)


class QaGuards(unittest.TestCase):
    def run_fixture(self):
        repo = {'id':qa.REPO_ID,'full_name':qa.REPO,'fork':False}
        return {'id':qa.SIGNING_RUN,'head_sha':qa.SOURCE,'head_branch':'main','head_commit':{'tree_id':qa.TREE},
                'repository':repo,'head_repository':dict(repo),'event':'workflow_run',
                'path':'.github/workflows/signed-update-candidate.yml','status':'completed','conclusion':'success'}

    def test_wrong_source_fork_pr_event_and_failed_run_refused(self):
        qa.validate_run(self.run_fixture())
        for change in ({'id':qa.SIGNING_RUN+1},{'head_sha':'a'*40},{'event':'pull_request'},
                       {'head_commit':{'tree_id':'b'*40}},{'conclusion':'failure'},
                       {'head_repository':{'id':qa.REPO_ID,'full_name':qa.REPO,'fork':True}}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                qa.validate_run({**self.run_fixture(),**change})

    def candidate(self, directory):
        (directory / qa.ASSET).write_bytes(b'synthetic metadata fixture, never an installer')
        (directory / (qa.ASSET+'.sig')).write_text('synthetic-signature')
        (directory / (qa.ASSET+'.identity.json.sig')).write_text('synthetic-signature')
        descriptor = {'schema_version':1,'identifier':'app.hanni.mvp','platform':'windows-x86_64','version':qa.VERSION,
                      'source_commit':qa.SOURCE,'build_id':qa.BUILD,'installer_sha256':qa.digest(directory/qa.ASSET),
                      'installer_size':(directory/qa.ASSET).stat().st_size,'prepared_id':qa.PREPARED_ID}
        qa.write_json(directory / (qa.ASSET+'.identity.json'),descriptor)
        manifest = {'source':qa.SOURCE,'version':qa.VERSION,'build_id':qa.BUILD,'identifier':'app.hanni.mvp','platform':'windows-x86_64',
                    'asset':qa.ASSET,'signature_file':qa.ASSET+'.sig','sha256':qa.digest(directory/qa.ASSET),
                    'size':(directory/qa.ASSET).stat().st_size,'signature':'synthetic-signature',
                    'control_descriptor_file':qa.ASSET+'.identity.json','control_descriptor_signature_file':qa.ASSET+'.identity.json.sig',
                    'control_descriptor_sha256':qa.digest(directory/(qa.ASSET+'.identity.json'))}
        qa.write_json(directory/'manifest.json',manifest)
        patch=mock.patch.multiple(qa,INSTALLER_SIZE=manifest['size'],INSTALLER_SHA=manifest['sha256'],DESCRIPTOR_SHA=manifest['control_descriptor_sha256'])
        patch.start();self.addCleanup(patch.stop)
        return manifest,descriptor

    def test_wrong_version_build_hash_and_asset_names_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            directory=Path(temp);manifest,_=self.candidate(directory)
            qa.validate_candidate(directory)  # Metadata only; cryptography is a separate mandatory gate.
            for change in ({'version':'0.5.19'},{'build_id':'wrong'},{'source':'b'*40},{'sha256':'0'*64},{'asset':'../escape.exe'}):
                qa.write_json(directory/'manifest.json',{**manifest,**change})
                with self.subTest(change=change),self.assertRaises(RuntimeError):qa.validate_candidate(directory)

    def test_changed_descriptor_and_extra_files_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            directory=Path(temp);manifest,descriptor=self.candidate(directory)
            qa.write_json(directory/(qa.ASSET+'.identity.json'),{**descriptor,'source_commit':'b'*40})
            manifest['control_descriptor_sha256']=qa.digest(directory/(qa.ASSET+'.identity.json'))
            qa.write_json(directory/'manifest.json',manifest)
            with self.assertRaisesRegex(RuntimeError,'Descriptor differs'):qa.validate_candidate(directory)
            self.candidate(directory);(directory/'unexpected.exe').write_bytes(b'extra')
            with self.assertRaisesRegex(RuntimeError,'Unexpected signed artifact'):qa.validate_candidate(directory)

    def test_existing_production_verifier_rejects_unsigned_candidate(self):
        with tempfile.TemporaryDirectory() as temp:
            self.candidate(Path(temp))
            result=subprocess.run(['node','--input-type=module','-e',qa.SIGNATURE_CHECK,temp,str(ROOT)],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('Invalid Minisign signature envelope',result.stderr)

    def test_zip_paths_and_links_are_refused_before_extraction(self):
        with tempfile.TemporaryDirectory() as temp:
            directory=Path(temp);out=directory/'out';out.mkdir();archive=directory/'archive.zip'
            for name in ('../escape.exe',qa.ASSET):
                with zipfile.ZipFile(archive,'w') as bundle:bundle.writestr(name,b'not an admitted artifact')
                with self.assertRaises(RuntimeError):qa.extract_artifact(archive,out)
            self.assertEqual(list(out.iterdir()),[])

    def test_observation_never_adopts_a_foreign_webview_profile(self):
        with tempfile.TemporaryDirectory() as temp:
            expected=Path(temp)/'owned';expected.mkdir()
            self.assertTrue(qa.profile_is_owned(str(expected),expected))
            self.assertTrue(qa.profile_is_owned(str(expected/'child'),expected))
            self.assertFalse(qa.profile_is_owned(str(Path(temp)/'foreign'),expected))
            self.assertFalse(qa.profile_is_owned(None,expected))
        self.assertEqual(qa.profile_argument(['browser','--user-data-dir=owned']),'owned')
        self.assertEqual(qa.profile_argument(['browser','--user-data-dir','owned']),'owned')
        self.assertIsNone(qa.profile_argument(['browser','--user-data-dir']))

    def test_runtime_output_requires_actual_result_not_code_or_partial_progress(self):
        passing={'d4aeOutcome':'passed','assertionCount':30,'assertions':['synthetic parser fixture']}
        result=lambda text:{'content':[{'type':'text','text':text}]}
        self.assertEqual(qa.parse_runtime_result(result('### Result\n'+json.dumps(passing))),passing)
        for text in ('### Ran code\n'+json.dumps(passing),'### Result\n'+json.dumps({**passing,'d4aeOutcome':'failed'}),
                     '### Result\n'+json.dumps({**passing,'assertionCount':2}), 'pending'):
            with self.subTest(text=text),self.assertRaises(RuntimeError):qa.parse_runtime_result(result(text))

    def test_isolation_gate_stays_mandatory_and_product_helpers_are_not_replaced(self):
        workflow=(ROOT/'.github/workflows/d4ae-installed-qa.yml').read_text()
        self.assertIn('branches: [work/d4ae-installed-qa-v1]',workflow)
        self.assertNotIn('workflow_dispatch',workflow)
        self.assertNotIn('contents: write',workflow)
        self.assertNotIn('secrets.',workflow)
        source=(ROOT/'scripts/d4ae-installed-qa.py').read_text()
        self.assertIn("'--release-isolation'",source)
        self.assertIn('scripts/task-workflow-native-qa.py',source)
        self.assertIn("policy.verify_binary(exe.read_bytes(), exe_hash, True)",source)
        self.assertIn('verifyTauriSignature',qa.SIGNATURE_CHECK)


if __name__=='__main__':unittest.main()
