"""Cloud-only checks. No installed scenario, Windows process or policy is run."""
import importlib.util
import contextlib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import types
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('routine_qa', ROOT / 'scripts/routine-count-installed-qa.py')
qa = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(qa)


class RoutineInstalledPreparation(unittest.TestCase):
    def pins(self):
        return {key: (qa.PRODUCT_SOURCE if key == 'SOURCE' else qa.PRODUCT_TREE if key == 'TREE' else qa.PRODUCT_CI_RUN if key == 'CI_RUN' else qa.PRODUCT_SIGNING_RUN if key == 'SIGNING_RUN' else 1 if key in {'SIGNING_RUN', 'CI_RUN', 'ARTIFACT_ID', 'ARCHIVE_SIZE', 'INSTALLER_SIZE'} else
                      'a' * (40 if key in {'SOURCE', 'TREE'} else 64)) for key in qa.PIN_FIELDS}

    def route(self):
        with mock.patch.object(qa, 'ADMITTED', self.pins()):
            return qa.load_route()

    def test_pending_or_wrong_tree_provenance_fails_closed(self):
        for value in (None, {}, {**self.pins(), 'TREE': '6e622b87b5d410b6f190cb92700209636153d622'},
                      {**self.pins(), 'TREE': ''}, {**self.pins(), 'ARTIFACT_ID': True},
                      {**self.pins(), 'code': 'external'}):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                qa.validate_admission(value)
        qa.validate_admission(self.pins())

    def test_default_cli_fails_closed_before_route_or_process(self):
        with mock.patch.object(sys, 'argv', ['qa', '--owned-app-policy', '--mcp-cli', 'unused']), \
             mock.patch.object(qa, 'ADMITTED', None), \
             mock.patch.object(qa, 'configure_utf8'), mock.patch.object(qa, 'load_route') as route:
            with self.assertRaisesRegex(RuntimeError, 'preparation only'):
                qa.main()
            route.assert_not_called()

    def test_only_exact_host_branch_first_attempt_and_default_desktop(self):
        env = dict(GITHUB_ACTIONS='true', RUNNER_ENVIRONMENT='github-hosted', GITHUB_REPOSITORY='sultanjakhan/Cicada',
                   GITHUB_REF='refs/heads/' + qa.BRANCH, GITHUB_EVENT_NAME='push', GITHUB_RUN_ATTEMPT='1')
        qa.validate_host('win32', env, 'WinSta0', 'Default')
        for change in ({'GITHUB_REF': 'refs/heads/work/d4ae-installed-qa-v1'}, {'GITHUB_RUN_ATTEMPT': '2'},
                       {'RUNNER_ENVIRONMENT': 'self-hosted'}, {'GITHUB_EVENT_NAME': 'workflow_dispatch'}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                qa.validate_host('win32', {**env, **change})
        with self.assertRaises(RuntimeError):
            qa.validate_host('linux', env)
        with self.assertRaises(RuntimeError):
            qa.validate_host('win32', env, 'WinSta0', 'Personal')

    def test_exact_frozen_route_and_routine_entry_are_bound_without_launcher_copy(self):
        route = self.route()
        self.assertEqual(route.__file__, str(qa.ENTRY))
        self.assertEqual(route.OPERATION, qa.OPERATION)
        self.assertEqual(route.validate_host_context, qa.validate_host)
        self.assertEqual(route.RUNTIME_CODE, qa.RUNTIME_CODE)
        self.assertEqual(route.serve_default_desktop.__code__.co_filename,
                         str(ROOT / '.local/routine-qa-route/scripts/d4ae-installed-qa.py'))
        self.assertEqual(route.VERSION, '0.5.22')
        with mock.patch.object(qa, 'ROUTE_SHA256', '0' * 64), self.assertRaisesRegex(RuntimeError, 'identity differs'):
            self.route()

    def test_static_call_refuses_foreign_root_and_never_accepts_filename(self):
        route = self.route()
        root = ROOT / '.local/background-qa' / qa.OPERATION / 'data'
        call = route.static_runtime_call(root)
        self.assertEqual(call['name'], 'browser_run_code_unsafe')
        self.assertEqual(set(call['arguments']), {'code'})
        self.assertNotIn('SHOTS', call['arguments']['code'])
        with self.assertRaises(RuntimeError):
            route.static_runtime_call(root.parent / 'foreign')
        checked = subprocess.run(['node', '--check', '--input-type=module'], input='(' + call['arguments']['code'] + ');',
                                 text=True, capture_output=True)
        self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_marker_only_seed_never_injects_database_and_refuses_reuse(self):
        route = self.route()
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(qa, 'ROOT', Path(temp)):
            run, data = qa.seed_empty_profile(route, 'a' * 64)
            self.assertEqual({p.name for p in data.iterdir()}, {'cicada-isolated-test.json'})
            self.assertFalse((data / 'calendar.db').exists())
            self.assertEqual(json.loads((run / 'profile.json').read_text())['exe_sha256'], 'a' * 64)
            with self.assertRaisesRegex(RuntimeError, 'already has a profile'):
                qa.seed_empty_profile(route, 'a' * 64)

    def test_actual_tool_package_layout_pins_mcp_and_both_core_versions(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(qa, 'ROOT', Path(temp)):
            modules = Path(temp) / '.local/d4ae-tools/node_modules'
            cli = modules / '@playwright/mcp/cli.js'
            for name, version in (('@playwright/mcp', '0.0.80'), ('playwright-core', qa.CORE_VERSION), ('playwright', qa.CORE_VERSION)):
                package = modules / name / 'package.json'
                package.parent.mkdir(parents=True, exist_ok=True)
                package.write_text(json.dumps({'name': name, 'version': version}))
            cli.write_text('// tooling fixture; never executed')
            qa.check_tooling(cli)
            (modules / 'playwright-core/package.json').write_text(json.dumps({'name': 'playwright-core', 'version': '1.63.0'}))
            with self.assertRaisesRegex(RuntimeError, 'Pinned tooling differs'):
                qa.check_tooling(cli)

    def test_cleanup_and_inventory_cannot_smuggle_launch_or_external_calls(self):
        for role in ('--cleanup-owned-policy', '--mcp-contract-only'):
            for extra in (['--owned-app-policy'], ['--calls', 'foreign.json'], ['--exe', 'foreign.exe']):
                with self.subTest(role=role, extra=extra), mock.patch.object(qa, 'configure_utf8'), \
                     mock.patch.object(sys, 'argv', ['qa', role, '--mcp-cli', 'unused', *extra]), \
                     self.assertRaisesRegex(RuntimeError, 'cannot launch'):
                    qa.main()

    def test_result_refuses_failures_truncation_wrong_transitions_or_isolation_order(self):
        result = {'routineOutcome': 'passed', 'assertionCount': 53,
                  'assertions': ['native isolation', 'exact root', 'sync denied'] + ['observed'] * 50,
                  'receipts': [{'name': 'isolated_test_status'}, {'name': 'mvp_sync_now'}],
                  'transitions': [{'completed': n, 'target': 3, 'remaining': max(0, 3-n)} for n in range(1, 5)],
                  'dayBoundaryMethod': 'native isolated prior-day snapshots plus current-day library UI/reload; no clock advance'}
        block = lambda value: {'type': 'text', 'text': '### Result\n' + json.dumps(value)}
        good = block(result)
        self.assertEqual(qa.parse_result({'content': [good]}), result)
        for stored in ({'isError': True, 'content': [good]}, {'content': [good, good]}, {'content': []},
                       *({'content': [block({**result, **change})]} for change in (
                           {'routineOutcome': 'failed'}, {'assertionCount': 52}, {'assertionCount': True},
                           {'transitions': []}, {'dayBoundaryMethod': 'global OS clock'}, {'receipts': []},
                           {'assertions': ['observed'] * 53}))):
            with self.subTest(stored=stored), self.assertRaises(RuntimeError):
                qa.parse_result(stored)

    def test_artifact_gate_is_one_observation_and_rejects_wrong_signed_bytes(self):
        route = self.route()
        ci = {'id': route.CI_RUN}
        signed = {'id': route.SIGNING_RUN}
        bad = {'artifacts': [{'name': route.ARTIFACT, 'expired': False, 'id': route.ARTIFACT_ID,
                             'size_in_bytes': route.ARCHIVE_SIZE, 'digest': 'sha256:' + '0' * 64,
                             'workflow_run': {'id': route.SIGNING_RUN, 'head_sha': route.SOURCE}}]}
        responses = [{**ci, 'status': 'completed', 'conclusion': 'success'},
                     {**signed, 'status': 'completed', 'conclusion': 'success'}, bad]
        with mock.patch.object(route, 'api', side_effect=responses) as api, \
             mock.patch.object(route, 'validate_run') as validate, mock.patch.object(route, 'write_json'):
            with self.assertRaisesRegex(RuntimeError, 'provenance differs'):
                qa.artifact_ready(route)
            self.assertEqual(api.call_count, 3)
            self.assertEqual(validate.call_count, 2)
        with mock.patch.object(route, 'api', return_value={'status': 'in_progress'}) as api, \
             mock.patch.object(route, 'validate_run'), mock.patch.object(route, 'write_json'):
            with self.assertRaisesRegex(RuntimeError, 'not complete'):
                qa.artifact_ready(route)
            self.assertEqual(api.call_count, 1)

    def test_utf8_reconfigures_cp1252_and_child_output_after_durable_evidence(self):
        # Reproduce the observed Windows stdout default using a real subprocess.
        # Frozen command() reads UTF-8 and saves child output before printing.
        with tempfile.TemporaryDirectory() as temp:
            code = """
import importlib.util, json, pathlib, sys
spec=importlib.util.spec_from_file_location('qa',sys.argv[1]);qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
qa.configure_utf8()
qa.ADMITTED={key:(qa.PRODUCT_SOURCE if key=='SOURCE' else qa.PRODUCT_TREE if key=='TREE' else qa.PRODUCT_CI_RUN if key=='CI_RUN' else qa.PRODUCT_SIGNING_RUN if key=='SIGNING_RUN' else 1 if key in {'SIGNING_RUN','CI_RUN','ARTIFACT_ID','ARCHIVE_SIZE','INSTALLER_SIZE'} else 'a'*(40 if key in {'SOURCE','TREE'} else 64)) for key in qa.PIN_FIELDS}
route=qa.load_route();route.EVIDENCE=pathlib.Path(sys.argv[2]);route.EVIDENCE.mkdir(exist_ok=True)
value={'label':'Цели · Прогресс','error':'Не удалось'}
route.write_json(route.EVIDENCE/'before-stdout.json',value)
child=route.command([sys.executable,'-c',"import json;print(json.dumps({'label':'Цели · Прогресс'},ensure_ascii=False))"],'unicode-child')
print(json.dumps(value,ensure_ascii=False));print(child,end='')
"""
            env = {**os.environ, 'PYTHONUTF8': '0', 'PYTHONIOENCODING': 'cp1252'}
            result = subprocess.run([sys.executable, '-c', code, str(qa.ENTRY), temp], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
            self.assertIn('Цели · Прогресс', result.stdout.decode('utf-8'))
            evidence = json.loads((Path(temp) / 'before-stdout.json').read_text(encoding='utf-8'))
            self.assertEqual(evidence['error'], 'Не удалось')
            child = json.loads((Path(temp) / 'unicode-child.json').read_text(encoding='utf-8'))
            self.assertEqual(child['exit'], 0)
            self.assertIn('Цели · Прогресс', child['stdout'])


    def test_static_scenario_preserves_isolation_first_and_only_normal_ui_mutations(self):
        code = qa.RUNTIME_CODE
        first = code.index("rpc('isolated_test_status')")
        self.assertLess(first, code.index("call('mvp_sync_now')"))
        self.assertLess(code.index("'sync denied'"), code.index('await write(state)'))
        for contract in ('for(let n=1;n<=4;n++)', 'for(const n of [3,2])',
                         'stale partial count refuses overwrite', 'stale reviewed target refuses overwrite',
                         'failed native write preserves exact saved state', 'stale plan retains editor draft',
                         'existing count plan target1 retained', 'legacy target1 save remains check',
                         'legacy binary history preserved exactly without migration',
                         'current-day changes preserve all prior-day snapshots', 'marks create no tasks',
                         'marks create no timeblocks', 'no implicit timer or start'):
            self.assertIn(contract, code)
        for forbidden in ('force:true', 'force: true', 'waitForTimeout', 'setTimeout', 'Date.now =',
                          'window.confirm', 'localStorage.setItem', 'createRecurringStore', 'setCount(',
                          '.dispatchEvent(', '.innerHTML =', 'page.keyboard', 'page.mouse', 'calendar-recurring--today',
                          'data-recurring-history', 'data-history-date', 'data-detail-count', 'mountCalendarRecurring', 'setDate('):
            self.assertNotIn(forbidden, code)
        # Native CAS fixture writes use only the same fixed UI-state key, after
        # real native isolation; UI creation/marks use product controls.
        self.assertIn("const key='calendar_recurring_v1'", code)
        self.assertIn("button[data-create-kind=\"routine\"]", code)
        source = (ROOT / 'src/hanni/js/calendar-recurring.js').read_text()
        for attr in ('data-library-mark', 'data-library-status', 'data-recurring-edit', 'data-recurring-error'):
            self.assertIn(attr, source)
        checked = subprocess.run(['node', '--check', '--input-type=module'], input='(' + code.replace('DATA', '"synthetic-owned-root"').replace('SHOTS', '"synthetic-owned-shots"') + ');', text=True, capture_output=True)
        self.assertEqual(checked.returncode, 0, checked.stderr)

    class PolicyStore:
        def __init__(self, route):
            self.route = route
            self.value = None
            self.exchanges = []
            self.fail_create = False
        def snapshot(self):
            return [{'hive': 'HKLM', 'view': view, 'option': 'AdditionalBrowserArguments',
                     'values': [] if self.value is None else [(self.route.POLICY_NAME, self.value, 1)],
                     'unknown_subkeys': []} for view in (0x100, 0x200)]
        def exchange(self, expected, replacement):
            self.exchanges.append((expected, replacement))
            if self.fail_create and expected is None:
                raise OSError('synthetic KTM unavailable')
            if self.value != expected:
                raise RuntimeError('Policy compare failed')
            self.value = replacement

    def test_reused_policy_refuses_foreign_and_same_value_before_any_mutation(self):
        route = self.route()
        for name in (route.POLICY_NAME, '*', 'app.hanni.mvp', 'foreign.exe'):
            for hive in ('HKLM', 'HKCU'):
                for view in (0x100, 0x200):
                    with self.subTest(name=name, hive=hive, view=view), self.assertRaises(RuntimeError):
                        route.validate_policy_snapshot([{'hive': hive, 'view': view, 'option': 'AdditionalBrowserArguments',
                                                         'values': [(name, route.policy_arguments(12345), 1)], 'unknown_subkeys': []}])
        with tempfile.TemporaryDirectory() as temp:
            store = self.PolicyStore(route);store.value = route.policy_arguments(12345)
            policy = route.OwnedWebviewPolicy(store, store.value, Path(temp) / 'receipt.json')
            with self.assertRaises(RuntimeError):
                policy.activate()
            policy.cleanup()
            self.assertEqual(store.value, route.policy_arguments(12345))
            self.assertEqual(store.exchanges, [])

    def test_reused_owned_policy_cleanup_on_success_failure_and_cancellation(self):
        route = self.route()
        for failure in (None, OSError, KeyboardInterrupt):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                store = self.PolicyStore(route);value = route.policy_arguments(12345)
                policy = route.OwnedWebviewPolicy(store, value, Path(temp) / 'receipt.json')
                try:
                    policy.activate();policy.check()
                    if failure:
                        raise failure('synthetic body interrupted')
                except (OSError, KeyboardInterrupt):
                    pass
                finally:
                    policy.cleanup()
                self.assertIsNone(store.value)
                self.assertEqual(store.exchanges, [(None, value), (value, None)])
                self.assertTrue(json.loads(policy.receipt.read_text())['cleanup_verified'])

    def test_reused_cleanup_preserves_changed_policy_and_unavailable_transactions(self):
        route = self.route()
        with tempfile.TemporaryDirectory() as temp:
            store = self.PolicyStore(route)
            policy = route.OwnedWebviewPolicy(store, route.policy_arguments(12345), Path(temp) / 'owned.json')
            policy.activate();store.value = 'foreign replacement'
            with self.assertRaises(RuntimeError):
                policy.cleanup()
            self.assertEqual(store.value, 'foreign replacement')
            self.assertFalse(json.loads(policy.receipt.read_text())['cleanup_verified'])
            store = self.PolicyStore(route);store.fail_create = True
            policy = route.OwnedWebviewPolicy(store, route.policy_arguments(12345), Path(temp) / 'unavailable.json')
            with self.assertRaises(OSError):
                policy.activate()
            policy.cleanup()
            self.assertIsNone(store.value)
            self.assertFalse(policy.owned)

    def test_unknown_crash_gap_policy_is_not_adopted_or_deleted(self):
        route = self.route()
        with tempfile.TemporaryDirectory() as temp:
            store = self.PolicyStore(route);value = route.policy_arguments(12345)
            policy = route.OwnedWebviewPolicy(store, value, Path(temp) / route.POLICY_RECEIPT)
            policy.record['state'] = 'validated_absent'
            route.write_json(policy.receipt, policy.record);store.value = value
            with mock.patch.object(route, 'EVIDENCE', Path(temp)), mock.patch.object(route, 'validate_host_context'), \
                 mock.patch.object(route, 'WindowsPolicyStore', return_value=store), \
                 self.assertRaisesRegex(RuntimeError, 'not durably confirmed'):
                route.cleanup_owned_policy()
            self.assertEqual(store.value, value)
            self.assertEqual(store.exchanges, [])

    def test_artifact_failure_saves_failure_before_any_install_profile_or_policy(self):
        route = self.route()
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(route, 'EVIDENCE', Path(temp)), \
             mock.patch.object(route, 'command') as command, mock.patch.object(route, 'preflight'), \
             mock.patch.object(qa, 'installer_source_proof', return_value={}), \
             mock.patch.object(qa, 'artifact_ready', side_effect=RuntimeError('synthetic artifact mismatch')), \
             mock.patch.object(qa, 'seed_empty_profile') as seed, contextlib.redirect_stdout(__import__('io').StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'artifact mismatch'):
                qa.run_installed(route, types.SimpleNamespace(mcp_cli=Path('not-executed')))
            seed.assert_not_called()
            names = [call.args[1] for call in command.call_args_list]
            self.assertNotIn('install-signed-runtime', names)
            self.assertNotIn('actual-installed-runtime', names)
            record = json.loads((Path(temp) / 'operation.json').read_text())
            self.assertEqual(record['state'], 'failed')
            self.assertEqual(record['runtime_acceptance'], 'UNKNOWN')

    def test_workflow_is_only_owned_push_read_permissions_and_always_cleanup(self):
        workflow = (ROOT / '.github/workflows/routine-count-installed-qa.yml').read_text()
        self.assertIn('branches: [' + qa.BRANCH + ']', workflow)
        self.assertIn('ref: ' + qa.ROUTE_COMMIT, workflow)
        self.assertIn('contents: read\n  actions: read', workflow)
        self.assertIn('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD', workflow)
        self.assertIn('--cleanup-owned-policy', workflow)
        self.assertEqual(workflow.count('if: always()'), 3)
        for forbidden in ('workflow_dispatch', 'secrets.', 'contents: write', 'actions: write', 'signing', 'push: [main]'):
            self.assertNotIn(forbidden, workflow)
        qa.validate_admission(qa.ADMITTED)
        self.assertEqual(qa.ADMITTED['INSTALLED_EXE_SHA'],
                         '0835a7d05d58a4ccbdc9aa560382940ecded689607f59346261c7b786001d09a')

    def package_pins(self):
        return {key: value for key, value in self.pins().items() if key != 'INSTALLED_EXE_SHA'}

    def package_route(self):
        with mock.patch.object(qa, 'PACKAGE_PINS', self.package_pins()):
            return qa.load_route(package_only=True)

    def test_metadata_pending_pins_and_missing_exe_cannot_admit_runtime(self):
        for role in ('--package-inspection-only', '--package-inspection-audit'):
            with mock.patch.object(sys, 'argv', ['qa', role]), mock.patch.object(qa, 'configure_utf8'), \
                 mock.patch.object(qa, 'validate_host'), mock.patch.object(qa, 'PACKAGE_PINS', None), \
                 mock.patch.object(qa, 'inspect_package') as inspect, self.assertRaisesRegex(RuntimeError, 'preparation only'):
                qa.main()
            inspect.assert_not_called()
        with mock.patch.object(qa, 'PACKAGE_PINS', self.package_pins()):
            qa.validate_package_pins(self.package_pins())
            for value in (None, {}, {**self.package_pins(), 'INSTALLED_EXE_SHA': 'a' * 64},
                          {**self.package_pins(), 'SIGNING_RUN': 1}, {**self.package_pins(), 'SOURCE': 'a' * 40}):
                with self.subTest(value=value), self.assertRaises(RuntimeError):
                    qa.validate_package_pins(value)
            with self.assertRaises(RuntimeError):
                qa.validate_admission(self.package_pins())
        qa.validate_admission(qa.ADMITTED)

    def test_metadata_adapter_has_no_inherited_binary_or_launch_policy_browser_entries(self):
        route = self.package_route()
        self.assertEqual(route.SOURCE, qa.PRODUCT_SOURCE)
        self.assertEqual(route.OPERATION, qa.PACKAGE_OPERATION)
        self.assertEqual(route.BASE, ROOT / '.local/routine-package-inspection')
        for name in ('INSTALLED_EXE_SHA', 'serve_default_desktop', 'check_default_desktop', 'main',
                     'OwnedWebviewPolicy', 'WindowsPolicyStore', 'cleanup_owned_policy', 'static_runtime_call',
                     'preflight_mcp_tools', 'seed_protected_fixture', 'RUNTIME_CODE'):
            self.assertFalse(hasattr(route, name), name)

    def test_metadata_cli_never_accepts_app_calls_or_falls_through_to_runtime(self):
        for role in ('--package-inspection-only', '--package-inspection-audit'):
            for extra in (['--mcp-cli', 'external'], ['--owned-app-policy'], ['--release-isolation'],
                          ['--exe', 'app.exe'], ['--calls', 'external.json'], ['--data-root', 'external']):
                with self.subTest(role=role, extra=extra), mock.patch.object(qa, 'configure_utf8'), \
                     mock.patch.object(sys, 'argv', ['qa', role, *extra]), self.assertRaisesRegex(RuntimeError, 'Metadata phase'):
                    qa.main()
        with mock.patch.object(qa, 'configure_utf8'), mock.patch.object(qa, 'validate_host'), \
             mock.patch.object(qa, 'PACKAGE_PINS', self.package_pins()), \
             mock.patch.object(sys, 'argv', ['qa', '--package-inspection-only']), \
             mock.patch.object(qa, 'inspect_package') as inspect, mock.patch.object(qa, 'run_installed') as runtime:
            qa.main();inspect.assert_called_once();runtime.assert_not_called()

    def test_metadata_reads_pe_bytes_and_closes_handle_on_invalid_version_or_read(self):
        data = b'MZ-synthetic-read-only-PE-data'
        handle = mock.Mock()
        info = {'FileVersionMS': 5, 'FileVersionLS': 22 << 16}
        modules = {'qa_files': types.SimpleNamespace(pinned_tree=lambda *a, **k: contextlib.nullcontext(),
                                                     checked_handle=lambda *a, **k: handle),
                   'win32con': types.SimpleNamespace(GENERIC_READ=1, OPEN_EXISTING=3),
                   'win32file': types.SimpleNamespace(GetFileSize=lambda h: len(data), ReadFile=lambda h, n: (0, data)),
                   'win32api': types.SimpleNamespace(GetFileVersionInfo=lambda *a: info)}
        with mock.patch.dict(sys.modules, modules):
            value = qa.installed_metadata(Path('owned/hanni-mvp.exe'))
            self.assertEqual(value['sha256'], hashlib.sha256(data).hexdigest())
            self.assertEqual(value['size'], len(data))
            self.assertEqual(value['file_version'], [0, 5, 22, 0])
            info['FileVersionLS'] = 21 << 16
            with self.assertRaisesRegex(RuntimeError, 'version differs'):
                qa.installed_metadata(Path('owned/hanni-mvp.exe'))
            modules['win32file'].ReadFile = lambda h, n: (0, data[:2])
            with self.assertRaisesRegex(RuntimeError, 'Incomplete'):
                qa.installed_metadata(Path('owned/hanni-mvp.exe'))
        self.assertEqual(handle.Close.call_count, 3)

    def test_metadata_bad_signature_never_reaches_silent_installer(self):
        route = self.package_route()
        registry = types.SimpleNamespace(HKEY_LOCAL_MACHINE=1, HKEY_CURRENT_USER=2, KEY_READ=1, KEY_WOW64_32KEY=2,
                                         OpenKey=lambda *a: contextlib.nullcontext('key'), QueryValueEx=lambda *a: ('123.0', 1))
        calls = []
        def command(args, name, **kwargs):
            calls.append(name)
            if name == 'verify-production-signatures':
                raise RuntimeError('Synthetic bad signature')
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(qa, 'ROOT', Path(temp)), \
             mock.patch.object(route, 'BASE', Path(temp) / '.local/routine-package-inspection'), \
             mock.patch.object(route, 'EVIDENCE', Path(temp) / '.local/routine-package-inspection/evidence'), \
             mock.patch.object(qa, 'no_package_app'), mock.patch.object(qa, 'installer_source_proof', return_value={}), \
             mock.patch.object(qa, 'artifact_ready'), mock.patch.object(qa, 'package_audit'), \
             mock.patch.object(route, 'download_artifact'), mock.patch.object(route, 'validate_candidate', return_value=({}, {})), \
             mock.patch.object(route, 'command', side_effect=command), mock.patch.dict(sys.modules, {'winreg': registry}), \
             contextlib.redirect_stdout(__import__('io').StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'bad signature'):
                qa.inspect_package(route)
            self.assertNotIn('inspect-package-install', calls)
            self.assertEqual(json.loads((route.EVIDENCE / 'operation.json').read_text())['state'], 'failed')

    def test_metadata_audit_proves_no_app_fixture_policy_and_rejects_foreign_process(self):
        route = self.package_route()
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(qa, 'ROOT', Path(temp)), \
             mock.patch.object(route, 'EVIDENCE', Path(temp) / 'evidence'), \
             mock.patch.dict(sys.modules, {'psutil': types.SimpleNamespace(process_iter=lambda fields: [])}):
            route.EVIDENCE.mkdir()
            proof = qa.package_audit(route)
            self.assertEqual(proof['runtime_acceptance'], 'NOT_RUN')
            self.assertFalse(proof['app_launched_by_phase'])
            self.assertFalse(proof['app_profile_created'])
            (Path(temp) / '.local/background-qa' / qa.OPERATION).mkdir(parents=True)
            with self.assertRaisesRegex(RuntimeError, 'fixture'):
                qa.package_audit(route)
        for name in ('hanni-mvp.exe', 'Cicada.exe', None):
            with mock.patch.dict(sys.modules, {'psutil': types.SimpleNamespace(process_iter=lambda fields: [types.SimpleNamespace(info={'name': name})])}), self.assertRaises(RuntimeError):
                qa.no_package_app()

    def test_metadata_source_proof_and_runtime_code_remain_reviewed(self):
        self.assertIn('/R required', qa.installer_source_proof()['restart_flag'])
        # Exact static candidate after the source-supported visible-library mapping;
        # old run39389130754/digest00013aaf remains in its immutable receipt.
        self.assertEqual(hashlib.sha256(qa.RUNTIME_CODE.encode()).hexdigest(),
                         '57bb253a9776b1910f88adf3d51831a7442b884165346dacae85f5fcea3a5520')
        workflow = (ROOT / '.github/workflows/routine-count-installed-qa.yml').read_text()
        self.assertIn('QA_PHASE: runtime', workflow)
        self.assertIn("if: env.QA_PHASE == 'runtime'", workflow)
        self.assertIn('--package-inspection-only', workflow)
        self.assertIn('--package-inspection-audit', workflow)
        qa.validate_package_pins(qa.PACKAGE_PINS)
        self.assertNotIn('INSTALLED_EXE_SHA', qa.PACKAGE_PINS)
        with self.assertRaises(RuntimeError):
            qa.validate_admission(qa.PACKAGE_PINS)


if __name__ == '__main__':
    unittest.main()
