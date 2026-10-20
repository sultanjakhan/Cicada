"""Fail-closed artifact/identity/result checks only; these are not runtime acceptance."""
import subprocess
import importlib.util
import json
import hashlib
import contextlib
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile
import ast
import asyncio

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('d4ae_qa', ROOT / 'scripts/d4ae-installed-qa.py')
qa = importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)

DIALOG_TOOL={'name':'browser_handle_dialog','inputSchema':{
    '$schema':'https://json-schema.org/draft/2020-12/schema','type':'object',
    'properties':{'accept':{'type':'boolean'},'promptText':{'type':'string'}},
    'required':['accept'],'additionalProperties':False}}


class QaGuards(unittest.TestCase):
    def test_mcp080_static_tool_contract_refuses_missing_wrong_or_expanded_schema(self):
        schema={'$schema':'https://json-schema.org/draft/2020-12/schema','type':'object',
                'properties':{'code':{'type':'string'},'filename':{'type':'string'}},'additionalProperties':False}
        tool={'name':'browser_run_code_unsafe','inputSchema':schema}
        qa.validate_mcp_tools([tool,DIALOG_TOOL])
        for tools in ([],[{**tool,'name':'browser_run_code'}],[tool,tool],
                      [{**tool,'inputSchema':{**schema,'additionalProperties':True}}],
                      [{**tool,'inputSchema':{**schema,'required':['filename']}}],
                      [{**tool,'inputSchema':{**schema,'properties':{'code':{'type':'number'},'filename':{'type':'string'}}}}],
                      [{**tool,'inputSchema':{**schema,'properties':{**schema['properties'],'external':{'type':'string'}}}}],
                      [{**tool,'inputSchema':{**schema,'anyOf':[{}]}}]):
            with self.subTest(tools=tools),self.assertRaises(RuntimeError):qa.validate_mcp_tools(tools+[DIALOG_TOOL])
        call=qa.static_runtime_call(ROOT/'.local/background-qa'/qa.OPERATION/'data')
        self.assertEqual(call['name'],'browser_run_code_unsafe')
        self.assertEqual(set(call['arguments']),{'code'})
        code=call['arguments']['code']
        self.assertLess(code.index("rpc('isolated_test_status')"),code.index("reject('mvp_sync_now'"))
        self.assertLess(code.index('status.integrationsEnabled===false'),code.index("rpc('create_event'"))
        with self.assertRaises(RuntimeError):qa.static_runtime_call(ROOT/'foreign-data')

    def test_mcp_contract_role_cannot_admit_launch_policy_or_external_calls(self):
        for extra in ('--owned-app-policy','--serve-default-desktop','--check-default-desktop','--cleanup-owned-policy','--diagnostic-only'):
            with self.subTest(extra=extra),mock.patch.object(qa.sys,'argv',['qa','--mcp-contract-only',extra,'--mcp-cli','unused']),self.assertRaisesRegex(RuntimeError,'cannot admit'):
                qa.main()

    class PolicyStore:
        def __init__(self):self.value=None;self.rows=[];self.exchanges=[];self.fail_create=False
        def snapshot(self):
            return self.rows+[{'hive':'HKLM','view':view,'option':'AdditionalBrowserArguments',
                'values':[] if self.value is None else [(qa.POLICY_NAME,self.value,1)],'unknown_subkeys':[]} for view in (0x100,0x200)]
        def exchange(self,expected,replacement):
            self.exchanges.append((expected,replacement))
            if self.fail_create and expected is None:raise OSError('synthetic transaction unavailable')
            if self.value!=expected:raise RuntimeError('Policy compare failed')
            self.value=replacement

    def test_policy_refuses_any_preexisting_target_wildcard_appid_or_configuration(self):
        for hive in ('HKLM','HKCU'):
            for view in (0x100,0x200):
                for option in qa.POLICY_OPTIONS:
                    for name in (qa.POLICY_NAME,'*','app.hanni.mvp','foreign.exe'):
                        rows=[{'hive':hive,'view':view,'option':option,'values':[(name,'foreign',1)],'unknown_subkeys':[]}]
                        with self.subTest(hive=hive,view=view,option=option,name=name),self.assertRaises(RuntimeError):
                            qa.validate_policy_snapshot(rows)
        with self.assertRaises(RuntimeError):qa.validate_policy_snapshot([{'values':[],'unknown_subkeys':['unknown']}])

    def test_policy_success_and_failure_cleanup_only_own_exact_value(self):
        for fail_body in (None,OSError,KeyboardInterrupt):
            with self.subTest(failure=fail_body),tempfile.TemporaryDirectory() as temp:
                store=self.PolicyStore();value=qa.policy_arguments(12345)
                policy=qa.OwnedWebviewPolicy(store,value,Path(temp)/'receipt.json')
                try:
                    policy.activate();policy.check()
                    self.assertEqual(store.value,value)
                    if fail_body:raise fail_body('synthetic scenario failure or cancellation')
                except (OSError,KeyboardInterrupt):pass
                finally:policy.cleanup()
                self.assertIsNone(store.value)
                self.assertEqual(store.exchanges,[(None,value),(value,None)])
                self.assertTrue(json.loads(policy.receipt.read_text())['cleanup_verified'])

    def test_preexisting_identical_value_is_foreign_and_never_adopted(self):
        with tempfile.TemporaryDirectory() as temp:
            store=self.PolicyStore();store.value=qa.policy_arguments(12345)
            policy=qa.OwnedWebviewPolicy(store,store.value,Path(temp)/'receipt.json')
            with self.assertRaises(RuntimeError):policy.activate()
            policy.cleanup()
            self.assertEqual(store.value,qa.policy_arguments(12345));self.assertEqual(store.exchanges,[])

    def test_policy_cleanup_preserves_foreign_changed_value_and_does_not_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            store=self.PolicyStore();policy=qa.OwnedWebviewPolicy(store,qa.policy_arguments(12345),Path(temp)/'receipt.json')
            policy.activate();store.value='foreign replacement'
            with self.assertRaises(RuntimeError):policy.cleanup()
            self.assertEqual(store.value,'foreign replacement')
            self.assertFalse(json.loads(policy.receipt.read_text())['cleanup_verified'])
            self.assertEqual(len(store.exchanges),2)

    def test_policy_missing_readback_and_view_disagreement_fail_closed(self):
        store=self.PolicyStore();value=qa.policy_arguments(12345)
        policy=qa.OwnedWebviewPolicy(store,value,Path('unused'))
        with self.assertRaisesRegex(RuntimeError,'missing'):policy.check()
        store.value=value
        with mock.patch.object(store,'snapshot',return_value=store.snapshot()[:1]),self.assertRaisesRegex(RuntimeError,'views disagree'):
            policy.check()

    def test_policy_transaction_failure_leaves_no_owned_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            store=self.PolicyStore();store.fail_create=True
            policy=qa.OwnedWebviewPolicy(store,qa.policy_arguments(12345),Path(temp)/'receipt.json')
            with self.assertRaises(OSError):policy.activate()
            policy.cleanup()
            self.assertIsNone(store.value);self.assertFalse(policy.owned)
            self.assertEqual(len(store.exchanges),1)

    def test_policy_preexisting_receipt_refuses_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            receipt=Path(temp)/'receipt.json';receipt.write_text('foreign')
            store=self.PolicyStore();policy=qa.OwnedWebviewPolicy(store,qa.policy_arguments(12345),receipt)
            with self.assertRaises(RuntimeError):policy.activate()
            self.assertEqual(receipt.read_text(),'foreign');self.assertEqual(store.exchanges,[])

    def test_policy_invalid_ports_and_environment_only_launch_are_refused(self):
        for port in (0,80,65536,True,'9222'):
            with self.subTest(port=port),self.assertRaises(RuntimeError):qa.policy_arguments(port)
        with mock.patch.object(qa.sys,'argv',['qa','--serve-default-desktop','--mcp-cli','unused']),self.assertRaisesRegex(RuntimeError,'Environment-only'):
            qa.main()

    def test_foreign_matching_apps_and_webviews_refused(self):
        import types
        app=types.SimpleNamespace(pid=7,info={'name':qa.POLICY_NAME})
        webview=types.SimpleNamespace(pid=8,info={'name':'msedgewebview2.exe'},
            cmdline=lambda:['--webview-exe-name='+qa.POLICY_NAME],parents=lambda:[])
        for process in (app,webview):
            fake=types.SimpleNamespace(process_iter=lambda fields:[process])
            with mock.patch.dict('sys.modules',{'psutil':fake}),self.assertRaises(RuntimeError):qa.reject_foreign_matching_apps()
        with mock.patch.dict('sys.modules',{'psutil':types.SimpleNamespace(process_iter=lambda fields:[app])}):
            qa.reject_foreign_matching_apps(7)

    def test_recovery_refuses_unknown_ownership_even_when_value_matches(self):
        with tempfile.TemporaryDirectory() as temp,contextlib.ExitStack() as stack:
            base=Path(temp);store=self.PolicyStore();value=qa.policy_arguments(12345)
            policy=qa.OwnedWebviewPolicy(store,value,base/qa.POLICY_RECEIPT)
            policy.record['state']='validated_absent';qa.write_json(policy.receipt,policy.record);store.value=value
            stack.enter_context(mock.patch.object(qa,'EVIDENCE',base))
            stack.enter_context(mock.patch.object(qa,'validate_host_context'))
            stack.enter_context(mock.patch.object(qa,'WindowsPolicyStore',return_value=store))
            with self.assertRaisesRegex(RuntimeError,'not durably confirmed'):qa.cleanup_owned_policy()
            self.assertEqual(store.value,value);self.assertEqual(store.exchanges,[])

    def test_recovery_removes_durably_owned_value_after_interrupted_body(self):
        with tempfile.TemporaryDirectory() as temp,contextlib.ExitStack() as stack:
            base=Path(temp);store=self.PolicyStore();value=qa.policy_arguments(12345)
            policy=qa.OwnedWebviewPolicy(store,value,base/qa.POLICY_RECEIPT);policy.activate()
            stack.enter_context(mock.patch.object(qa,'EVIDENCE',base))
            stack.enter_context(mock.patch.object(qa,'validate_host_context'))
            stack.enter_context(mock.patch.object(qa,'WindowsPolicyStore',return_value=store))
            self.assertEqual(qa.cleanup_owned_policy(),0);self.assertIsNone(store.value)
            self.assertEqual(qa.cleanup_owned_policy(),0);self.assertEqual(len(store.exchanges),2)

    def test_diagnostic_report_has_only_prospective_webview_values_and_no_runtime_acceptance(self):
        raw=b'<assembly xmlns="urn:schemas-microsoft-com:asm.v1"><trustInfo><requestedExecutionLevel level="asInvoker" uiAccess="false"/></trustInfo></assembly>'
        token={'TokenIntegrityLevel':12288,'TokenElevation':1,'TokenElevationType':1}
        with tempfile.TemporaryDirectory() as temp, contextlib.ExitStack() as stack:
            base=Path(temp);exe=base/'installed/hanni-mvp.exe';exe.parent.mkdir();exe.write_bytes(b'fixture')
            stack.enter_context(mock.patch.multiple(qa,BASE=base,EVIDENCE=base))
            stack.enter_context(mock.patch.object(qa,'validate_host_context'))
            stack.enter_context(mock.patch.object(qa,'digest',return_value=qa.INSTALLED_EXE_SHA))
            inspect=stack.enter_context(mock.patch.object(qa,'inspect_windows_manifest_and_token',return_value=(raw,token)))
            stack.enter_context(mock.patch.dict(qa.os.environ,{'SECRET_SENTINEL':'must-not-be-reported','WEBVIEW2_UNRELATED':'must-not-be-reported'}))
            qa.diagnostic_only_preflight(exe)
            report=json.loads((base/'startup-diagnostic-only.json').read_text())
            self.assertEqual(report['manifest']['requestedExecutionLevel'],[{'level':'asInvoker','uiAccess':'false'}])
            self.assertEqual((base/'installed-RT_MANIFEST-1.xml').read_bytes(),raw)
            self.assertEqual(report['launcher_token'],token)
            self.assertEqual(set(report['intended_webview_values']),{'WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'})
            self.assertNotIn('must-not-be-reported',json.dumps(report))
            self.assertFalse(report['application_launched']);self.assertFalse(report['profile_created'])
            self.assertEqual(report['runtime_acceptance'],'UNKNOWN')
            self.assertEqual(report['runtime_assertions_executed'],0)
            inspect.assert_called_once_with(exe)
            with mock.patch.object(qa,'digest',return_value='wrong'),self.assertRaises(RuntimeError):
                qa.diagnostic_only_preflight(exe)
            self.assertEqual(inspect.call_count,1)

    def test_diagnostic_main_returns_before_fixture_scenarios_or_application_launch(self):
        with tempfile.TemporaryDirectory() as temp, contextlib.ExitStack() as stack:
            base=Path(temp);cli=base/'cli.js';cli.write_text('fixture')
            binary=b'isolated_test_integration_disabled synthetic unit fixture'
            binary_hash=hashlib.sha256(binary).hexdigest()
            stack.enter_context(mock.patch.multiple(qa,BASE=base,EVIDENCE=base/'evidence',INSTALLED_EXE_SHA=binary_hash))
            stack.enter_context(mock.patch.object(qa.sys,'platform','win32'))
            stack.enter_context(mock.patch.object(qa.sys,'argv',['qa','--diagnostic-only','--mcp-cli',str(cli)]))
            stack.enter_context(mock.patch.dict(qa.os.environ,{'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted',
                'GITHUB_REPOSITORY':qa.REPO,'GITHUB_REF':'refs/heads/work/d4ae-installed-qa-v1',
                'GITHUB_EVENT_NAME':'push','GITHUB_RUN_ATTEMPT':'1'}))
            for name in ('wait_for_artifact','download_artifact'):
                stack.enter_context(mock.patch.object(qa,name))
            stack.enter_context(mock.patch.object(qa,'validate_candidate',return_value=({'sha256':qa.INSTALLER_SHA},{})))
            def command(argv,name,**kwargs):
                if name=='install-signed-runtime':
                    (base/'installed').mkdir();(base/'installed/hanni-mvp.exe').write_bytes(binary)
            commands=stack.enter_context(mock.patch.object(qa,'command',side_effect=command))
            diagnostic=stack.enter_context(mock.patch.object(qa,'diagnostic_only_preflight'))
            forbidden=[stack.enter_context(mock.patch.object(qa,name,side_effect=AssertionError('No runtime in diagnostic mode')))
                       for name in ('seed_protected_fixture','preflight','serve_default_desktop','check_default_desktop','parse_runtime_result')]
            self.assertEqual(qa.main(),0)
            diagnostic.assert_called_once_with(base/'installed/hanni-mvp.exe')
            self.assertEqual([call.args[1] for call in commands.call_args_list],
                             ['unchanged-product-and-helpers','verify-production-signatures','install-signed-runtime'])
            for function in forbidden:function.assert_not_called()
            report=json.loads((base/'evidence/operation.json').read_text())
            self.assertEqual(report['state'],'diagnostic_only_completed')
            self.assertEqual(report['runtime_acceptance'],'UNKNOWN')
            self.assertFalse((base/'evidence/runtime-calls.json').exists())

    def test_diagnostic_mode_cannot_be_combined_with_launch_roles(self):
        for role in ('--serve-default-desktop','--check-default-desktop'):
            with self.subTest(role=role),mock.patch.object(qa.sys,'argv',['qa','--diagnostic-only',role,'--mcp-cli','unused']),self.assertRaisesRegex(RuntimeError,'cannot launch'):
                qa.main()

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

    def test_default_desktop_host_gate_rejects_local_fork_other_branch_and_retries(self):
        env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_REPOSITORY':qa.REPO,
             'GITHUB_REF':'refs/heads/work/d4ae-installed-qa-v1','GITHUB_EVENT_NAME':'push','GITHUB_RUN_ATTEMPT':'1'}
        qa.validate_host_context('win32',env,'WinSta0','Default')
        for key,value in [('RUNNER_ENVIRONMENT','self-hosted'),('GITHUB_REPOSITORY','other/repo'),
                          ('GITHUB_REF','refs/heads/main'),('GITHUB_RUN_ATTEMPT','2'),('GITHUB_EVENT_NAME','workflow_dispatch')]:
            with self.subTest(key=key),self.assertRaises(RuntimeError):qa.validate_host_context('win32',{**env,key:value},'WinSta0','Default')
        for platform,station,desktop in [('linux','WinSta0','Default'),('win32','Service-0x0','Default'),('win32','WinSta0','HanniMvpQA-other')]:
            with self.subTest(platform=platform,station=station,desktop=desktop),self.assertRaises(RuntimeError):qa.validate_host_context(platform,env,station,desktop)

    def test_default_desktop_rejects_both_directions_of_production_overlap(self):
        with tempfile.TemporaryDirectory() as temp:
            parent=Path(temp);production=parent/'production';production.mkdir();safe=parent/'owned';safe.mkdir()
            qa.reject_overlap(safe,[production])
            for bad in (parent,production,production/'child'):
                with self.subTest(path=bad),self.assertRaises(RuntimeError):qa.reject_overlap(bad,[production])

    def test_default_desktop_cdp_requires_exclusive_owned_loopback_and_unique_origin(self):
        qa.validate_listener([{'pid':7,'ip':'127.0.0.1','port':9000}],{7:'owned-profile'},9000)
        for rows in ([],[{'pid':8,'ip':'127.0.0.1','port':9000}],[{'pid':7,'ip':'0.0.0.0','port':9000}],
                     [{'pid':7,'ip':'127.0.0.1','port':9000},{'pid':8,'ip':'127.0.0.1','port':9000}]):
            with self.subTest(rows=rows),self.assertRaises(RuntimeError):qa.validate_listener(rows,{7:'owned-profile'},9000)
        page={'type':'page','url':'http://tauri.localhost/index.html'}
        self.assertEqual(qa.unique_tauri_page([page]),page)
        for pages in ([],[page,page],[{'type':'page','url':'http://tauri.localhost.evil/'}],[{'type':'page','url':'http://127.0.0.1:1420/'}]):
            with self.subTest(pages=pages),self.assertRaises(RuntimeError):qa.unique_tauri_page(pages)

    def test_default_desktop_still_uses_the_unchanged_explicit_marker_policy(self):
        spec=importlib.util.spec_from_file_location('existing_launch_policy',ROOT/'scripts/qa-launch-policy.py')
        policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy)
        with tempfile.TemporaryDirectory() as temp:
            data=Path(temp)
            with self.assertRaises(ValueError):policy.launch_args('hanni-mvp.exe',data,'foreground')
            (data/'cicada-isolated-test.json').write_text(json.dumps(policy.MARKER))
            self.assertIn('--isolated-test-root',policy.launch_args('hanni-mvp.exe',data,'foreground'))
            (data/'cicada-isolated-test.json').write_text('{}')
            with self.assertRaises(ValueError):policy.launch_args('hanni-mvp.exe',data,'foreground')

    def test_runtime_output_requires_actual_result_not_code_or_partial_progress(self):
        passing={'d4aeOutcome':'passed','assertionCount':31,'assertions':['synthetic parser fixture']*31}
        result=lambda text:{'content':[{'type':'text','text':text}]}
        self.assertEqual(qa.parse_runtime_result(result('### Result\n'+json.dumps(passing))),passing)
        for text in ('### Ran code\n'+json.dumps(passing),'### Result\n'+json.dumps({**passing,'d4aeOutcome':'failed'}),
                     '### Result\n'+json.dumps({**passing,'assertionCount':30}),
                     '### Result\n'+json.dumps({**passing,'assertions':[]}), 'pending'):
            with self.subTest(text=text),self.assertRaises(RuntimeError):qa.parse_runtime_result(result(text))

    def test_isolation_gate_stays_mandatory_and_product_helpers_are_not_replaced(self):
        workflow=(ROOT/'.github/workflows/d4ae-installed-qa.yml').read_text()
        self.assertIn('branches: [work/d4ae-installed-qa-v1]',workflow)
        self.assertNotIn('workflow_dispatch',workflow)
        self.assertNotIn('contents: write',workflow)
        self.assertNotIn('secrets.',workflow)
        source=(ROOT/'scripts/d4ae-installed-qa.py').read_text()
        self.assertIn("'--release-isolation'",source)
        self.assertIn('scripts/task-workflow-native-qa.py',source)  # Remains in the exact-byte diff guard.
        self.assertIn("'--check-default-desktop'",source)
        self.assertNotIn('CreateDesktop(',source)
        self.assertNotIn('SwitchDesktop(',source)
        self.assertIn("policy.verify_binary(exe.read_bytes(), exe_hash, True)",source)
        self.assertIn('verifyTauriSignature',qa.SIGNATURE_CHECK)


class StaticDialogStages(unittest.TestCase):
    @staticmethod
    def stored(value):return {'content':[{'type':'text','text':'### Result\n'+json.dumps(value)}]}

    def test_business_source_parity_and_static_allowlist(self):
        baseline=subprocess.check_output(['git','show','b4c2fb384265a9f604e1ff4fb3cd6657e13a0a1b:scripts/d4ae-installed-qa.py'],cwd=ROOT,text=True)
        old=next(ast.literal_eval(n.value) for n in ast.parse(baseline).body if isinstance(n,ast.Assign)
                 and any(isinstance(t,ast.Name) and t.id=='RUNTIME_CODE' for t in n.targets))
        restored=qa.RUNTIME_CODE.replace('async function* (page)','async (page) =>',1)
        start=restored.index('  const confirmDelete=');end=restored.index('\n',restored.index('menuTrace:Object.freeze',start))
        old_helper=old.split('  const confirmDelete=',1)[1].split('\n',1)[0]
        restored=restored[:start]+'  const confirmDelete='+old_helper+restored[end:]
        for phase in range(1,5):restored=restored.replace(f'yield confirmDelete({phase})','await confirmDelete()',1)
        self.assertEqual(restored,old)
        self.assertEqual(qa.RUNTIME_CODE.count('check(')-1+5,31)  # One reject helper; two rejects plus three protected records.
        data=ROOT/'.local/background-qa'/qa.OPERATION/'data'
        for stage in ['start']+[f'{action}-{phase}' for phase in range(1,5) for action in ('trigger','continue')]:
            call=qa.static_runtime_call(data,stage)
            self.assertEqual(set(call['arguments']),{'code'})
            subprocess.run(['node','--check'],input='('+call['arguments']['code']+');',text=True,check=True,capture_output=True)
        for stage in ('continue-0','trigger-5','foreign',None):
            with self.assertRaises(RuntimeError):qa.static_runtime_call(data,stage)

    def test_checkpoint_dialog_and_final_result_fail_closed(self):
        checkpoint={**qa.expected_dialog(1),'assertions':[],'receipts':[],'menuTrace':[]}
        qa.validate_checkpoint(self.stored(checkpoint),1)
        for change in ({'operation':'foreign'},{'phase':2},{'accept':False},{'phase':True},{'type':'alert'},{'message':'foreign'}):
            with self.subTest(change=change),self.assertRaises(RuntimeError):qa.validate_checkpoint(self.stored({**checkpoint,**change}),1)
        modal='### Modal state\n- ["confirm" dialog with message "'+checkpoint['message']+'"]: can be handled by browser_handle_dialog'
        raw=lambda text:{'content':[{'type':'text','text':text}]}
        qa.validate_modal(raw(modal),1)
        for text in ('',modal.replace('confirm','alert'),modal.replace(checkpoint['message'],'foreign'),modal+'\n- extra',modal+'\n'+modal,'### Result\n{}\n'+modal):
            with self.subTest(text=text),self.assertRaises(RuntimeError):qa.validate_modal(raw(text),1)
        for text in ('### Result\n{}\n### Result\n{}','### Result\n{}\n'+modal):
            with self.assertRaises(RuntimeError):qa.tool_result(raw(text))
        tool={'name':qa.MCP_RUN_TOOL,'inputSchema':{'$schema':'https://json-schema.org/draft/2020-12/schema',
              'type':'object','properties':{'code':{'type':'string'},'filename':{'type':'string'}},'additionalProperties':False}}
        for dialog in (None,{**DIALOG_TOOL,'inputSchema':{**DIALOG_TOOL['inputSchema'],'required':[]}}):
            with self.assertRaises(RuntimeError):qa.validate_mcp_tools([tool]+([dialog] if dialog else []))

    def test_pinned_backend_modal_lifecycle_without_browser(self):
        bundle=ROOT/'.local/d4ae-tools/node_modules/playwright-core/lib/coreBundle.js'
        self.assertEqual(hashlib.sha256(bundle.read_bytes()).hexdigest(),'7aa0bf8b6b69d32065912e3d8f7e3c18c62de4d668f770a8e039811d3cf9c6a0')
        # Only the scenario is inert here; Tab, run-code handler and official dialog handler are real pinned code.
        synthetic="""async function* (page){for(let phase=1;phase<=4;phase++){
          yield Object.freeze({operation:'d4ae-installed-qa-20261020-v1',phase,type:'confirm',message:'Удалить показанную версию события безвозвратно?',accept:true,assertions:[],receipts:[],menuTrace:[]});
          page.completed++;
        }return {d4aeOutcome:'passed',assertionCount:31,assertions:Array(31).fill('INERT CONTRACT ONLY')};}"""
        data=ROOT/'.local/background-qa'/qa.OPERATION/'data'
        with mock.patch.object(qa,'RUNTIME_CODE',synthetic):
            calls={stage:qa.static_runtime_call(data,stage)['arguments'] for stage in
                   ['start']+[f'{action}-{phase}' for phase in range(1,5) for action in ('trigger','continue')]}
        js=r"""const assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {tools}=require(BUNDLE),calls=CALLS;
const page=new EventEmitter();page.completed=0;page.evaluate=async()=>{};
const tab=new EventEmitter();Object.setPrototypeOf(tab,tools.Tab.prototype);
tab.page=page;tab._modalStates=[];tab._initializedPromise=Promise.resolve();
const context={config:{timeouts:{settle:0}},ensureTab:async()=>tab,onUnhandledRejection:()=>()=>{}};tab.context=context;
page.on('dialog',d=>tab._dialogShown(d));page.on('dialogclosed',d=>tab._dialogClosed(d));
let clicks=0,accepts=0;
page.locator=selector=>{assert.equal(selector,'#evm-del');return {click:()=>new Promise(resolve=>{
 clicks++;const dialog={type:()=> 'confirm',message:()=> 'Удалить показанную версию события безвозвратно?',
 accept:async()=>{accepts++;page.emit('dialogclosed',dialog);resolve();},dismiss:async()=>{throw Error('Unexpected cancel')}};
 page.emit('dialog',dialog);
})}};
const run=tools.browserTools.find(t=>t.schema.name==='browser_run_code_unsafe');
const handle=tools.browserTools.find(t=>t.schema.name==='browser_handle_dialog');
async function invoke(tool,args){const results=[],errors=[];await tool.handle(context,args,{addCode(){},addTextResult:v=>results.push(JSON.parse(v)),addError:e=>errors.push(e)});return {results,errors};}
(async()=>{
 assert.equal((await invoke(run,calls.start)).results[0].phase,1);
 await assert.rejects(invoke(run,calls.start),/Duplicate scenario/);
 await assert.rejects(invoke(run,calls['trigger-2']),/wrong trigger/);
 for(let phase=1;phase<=4;phase++){
  const triggered=await invoke(run,calls['trigger-'+phase]);assert.equal(triggered.results.length,0);assert.equal(tab.modalStates().length,1);
  assert.equal(page.completed,phase-1);assert.equal(page.__d4aeDialogStages.state,'clicked');
  const blocked=await invoke(run,calls['continue-'+phase]);assert.equal(blocked.errors.length,1);
  await invoke(handle,{accept:true});assert.equal(tab.modalStates().length,0);
  await assert.rejects(invoke(run,calls['trigger-'+phase]),/Duplicate/);
  const continued=await invoke(run,calls['continue-'+phase]);assert.equal(page.completed,phase);
  if(phase<4)assert.equal(continued.results[0].phase,phase+1);else assert.equal(continued.results[0].assertionCount,31);
  await assert.rejects(invoke(run,calls['continue-'+phase]),/Duplicate/);
 }
 assert.equal(clicks,4);assert.equal(accepts,4);assert.equal(page.__d4aeDialogStages.state,'complete');
 console.log('PASS real pinned Tab/runUnsafe/handleDialog: four modal races, same retained click promises, generator continuation, duplicate refusal; inert plumbing, zero browser/app');
})().catch(e=>{console.error(e);process.exitCode=1});
""".replace('BUNDLE',json.dumps(str(bundle))).replace('CALLS',json.dumps(calls))
        result=subprocess.run(['node'],input=js,text=True,capture_output=True,timeout=20)
        self.assertEqual(result.returncode,0,result.stderr);self.assertIn('PASS real pinned',result.stdout)
        print(result.stdout.strip())

    def test_client_order_durable_intent_duplicate_and_unfinished_refusal(self):
        import types
        def response(value):return types.SimpleNamespace(model_dump=lambda **kwargs:value)
        modal='### Modal state\n- ["confirm" dialog with message "'+qa.expected_dialog(1)['message']+'"]: can be handled by browser_handle_dialog'
        checkpoint=lambda phase:self.stored({**qa.expected_dialog(phase),'assertions':[],'receipts':[],'menuTrace':[]})
        final=self.stored({'d4aeOutcome':'passed','assertionCount':31,'assertions':['INERT']*31})
        good=[checkpoint(1)]
        for phase in range(1,5):good.extend([{'content':[{'type':'text','text':modal}]},{'content':[]},checkpoint(phase+1) if phase<4 else final])
        class Client:
            def __init__(self,rows,fail_at=None):self.rows=rows;self.calls=[];self.fail_at=fail_at
            async def call_tool(self,name,args):
                index=len(self.calls);self.calls.append((name,args))
                if index==self.fail_at:raise TimeoutError('inert unfinished continuation')
                return response(self.rows[index])
        data=ROOT/'.local/background-qa'/qa.OPERATION/'data'
        with tempfile.TemporaryDirectory() as temp:
            run=Path(temp);client=Client(good);stored=asyncio.run(qa.run_static_stages(client,data,run))
            self.assertEqual(stored,final);self.assertEqual(len(client.calls),13)
            self.assertEqual([name for name,args in client.calls].count('browser_handle_dialog'),4)
            self.assertTrue(all(args=={'accept':True} for name,args in client.calls if name=='browser_handle_dialog'))
            self.assertEqual(len(list(run.glob('dialog-checkpoint-*.json'))),4)
            with self.assertRaisesRegex(RuntimeError,'Duplicate'):asyncio.run(qa.run_static_stages(client,data,run))
            self.assertEqual(len(client.calls),13)
        for fail_at,rows,error in ((3,good,TimeoutError),(None,[good[0],{'content':[{'type':'text','text':modal.replace('confirm','alert')}]}],RuntimeError)):
            with tempfile.TemporaryDirectory() as temp:
                client=Client(rows,fail_at);run=Path(temp)
                with self.assertRaises(error):asyncio.run(qa.run_static_stages(client,data,run))
                self.assertFalse((run/'runtime-result.json').exists())
                if fail_at==3:self.assertEqual(json.loads((run/'dialog-call-3.json').read_text())['state'],'pending')
                else:self.assertFalse(any(name=='browser_handle_dialog' for name,args in client.calls))


if __name__=='__main__':unittest.main()
