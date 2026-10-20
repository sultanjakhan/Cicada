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
SPEC = importlib.util.spec_from_file_location('goal_qa', ROOT / 'scripts/goal-development-installed-qa.py')
qa = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(qa)


class GoalInstalledPreparation(unittest.TestCase):
    def pins(self):
        return {key: (1 if key in {'SIGNING_RUN', 'CI_RUN', 'ARTIFACT_ID', 'ARCHIVE_SIZE', 'INSTALLER_SIZE'} else
                      'a' * (40 if key in {'SOURCE', 'TREE'} else 64)) for key in qa.PIN_FIELDS}

    def route(self):
        with mock.patch.object(qa, 'ADMITTED', self.pins()):
            return qa.load_route()

    def test_pending_or_old_provenance_cannot_admit_signed20(self):
        for value in (None, {}, {**self.pins(), 'SOURCE': 'ba433551496cdba26fb27f34c2ca503bab8bf28a'},
                      {**self.pins(), 'TREE': ''}, {**self.pins(), 'ARTIFACT_ID': True},
                      {**self.pins(), 'code': 'external'}):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                qa.validate_admission(value)
        qa.validate_admission(self.pins())

    def test_default_cli_fails_closed_before_route_or_process(self):
        with mock.patch.object(sys, 'argv', ['qa', '--owned-app-policy', '--mcp-cli', 'unused']), \
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

    def test_exact_frozen_route_and_goal_entry_are_bound_without_launcher_copy(self):
        route = self.route()
        self.assertEqual(route.__file__, str(qa.ENTRY))
        self.assertEqual(route.OPERATION, qa.OPERATION)
        self.assertEqual(route.validate_host_context, qa.validate_host)
        self.assertEqual(route.RUNTIME_CODE, qa.RUNTIME_CODE)
        self.assertEqual(route.serve_default_desktop.__code__.co_filename,
                         str(ROOT / '.local/goal-qa-route/scripts/d4ae-installed-qa.py'))
        self.assertEqual(route.VERSION, '0.5.21')
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

    def test_result_refuses_failures_truncation_and_ambiguous_success(self):
        result = {'goalOutcome': 'passed', 'assertionCount': 35, 'assertions': ['observed'] * 35,
                  'ratios': [{'done': 1, 'total': 3, 'unknown': 1, 'observedCountPercent': None},
                             {'done': 1, 'total': 2, 'unknown': 0, 'observedCountPercent': 50},
                             {'done': 2, 'total': 2, 'unknown': 0, 'observedCountPercent': 100}]}
        block = {'type': 'text', 'text': '### Result\n' + json.dumps(result)}
        self.assertEqual(qa.parse_result({'content': [block]}), result)
        for stored in ({'isError': True, 'content': [block]}, {'content': [block, block]},
                       {'content': [{'type': 'text', 'text': '### Result\n{"goalOutcome":"failed"}'}]},
                       {'content': [{'type': 'text', 'text': '### Result\n' + json.dumps({**result, 'assertionCount': 34})}]},
                       {'content': [{'type': 'text', 'text': '### Result\n' + json.dumps({**result, 'ratios': []})}]},
                       {'content': []}):
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
qa.ADMITTED={key:(1 if key in {'SIGNING_RUN','CI_RUN','ARTIFACT_ID','ARCHIVE_SIZE','INSTALLER_SIZE'} else 'a'*(40 if key in {'SOURCE','TREE'} else 64)) for key in qa.PIN_FIELDS}
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

    def test_package_adapter_has_no_exe_hash_or_runtime_policy_entries(self):
        route = qa.load_route(package_only=True)
        self.assertEqual(route.SOURCE, '1bbc37aa8d278df21ff2b4aaeb725d36f50470dd')
        self.assertEqual(route.OPERATION, qa.PACKAGE_OPERATION)
        for name in ('INSTALLED_EXE_SHA', 'serve_default_desktop', 'check_default_desktop', 'main',
                     'OwnedWebviewPolicy', 'WindowsPolicyStore', 'cleanup_owned_policy', 'static_runtime_call',
                     'preflight_mcp_tools', 'seed_protected_fixture', 'RUNTIME_CODE'):
            self.assertFalse(hasattr(route, name), name)
        self.assertIsNone(qa.ADMITTED)
        with self.assertRaises(RuntimeError):
            qa.validate_admission(qa.PACKAGE_PINS)
        for change in ({'INSTALLED_EXE_SHA': '0' * 64}, {'SOURCE': 'b' * 40}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                qa.validate_package_pins({**qa.PACKAGE_PINS, **change})

    def test_metadata_cli_cannot_supply_app_flags_or_fall_through_to_runtime(self):
        for role in ('--package-inspection-only', '--package-inspection-audit'):
            for extra in (['--mcp-cli', 'external'], ['--owned-app-policy'], ['--exe', 'app.exe'], ['--calls', 'external.json']):
                with self.subTest(role=role, extra=extra), mock.patch.object(qa, 'configure_utf8'), \
                     mock.patch.object(sys, 'argv', ['qa', role, *extra]), self.assertRaisesRegex(RuntimeError, 'Metadata phase'):
                    qa.main()
        with mock.patch.object(qa, 'configure_utf8'), mock.patch.object(qa, 'validate_host'), \
             mock.patch.object(sys, 'argv', ['qa', '--package-inspection-only']), \
             mock.patch.object(qa, 'inspect_package') as inspect, mock.patch.object(qa, 'run_installed') as runtime:
            qa.main()
            inspect.assert_called_once()
            runtime.assert_not_called()

    def test_installed_metadata_hashes_read_bytes_and_rejects_wrong_version(self):
        data = b'MZ-synthetic-read-only-PE-data'
        handle = mock.Mock()
        info = {'FileVersionMS': 5, 'FileVersionLS': 21 << 16}
        modules = {'qa_files': types.SimpleNamespace(pinned_tree=lambda *a, **k: contextlib.nullcontext(),
                                                     checked_handle=lambda *a, **k: handle),
                   'win32con': types.SimpleNamespace(GENERIC_READ=1, OPEN_EXISTING=3),
                   'win32file': types.SimpleNamespace(GetFileSize=lambda h: len(data), ReadFile=lambda h, n: (0, data)),
                   'win32api': types.SimpleNamespace(GetFileVersionInfo=lambda *a: info)}
        with mock.patch.dict(sys.modules, modules):
            value = qa.installed_metadata(Path('owned/hanni-mvp.exe'))
            self.assertEqual(value['sha256'], hashlib.sha256(data).hexdigest())
            self.assertEqual(value['file_version'], [0, 5, 21, 0])
            info['FileVersionLS'] = 20 << 16
            with self.assertRaisesRegex(RuntimeError, 'version differs'):
                qa.installed_metadata(Path('owned/hanni-mvp.exe'))
            modules['win32file'].ReadFile = lambda h, n: (0, data[:2])
            with self.assertRaisesRegex(RuntimeError, 'Incomplete'):
                qa.installed_metadata(Path('owned/hanni-mvp.exe'))
        self.assertEqual(handle.Close.call_count, 3)

    def test_bad_signature_cannot_reach_silent_installer(self):
        route = qa.load_route(package_only=True)
        registry = types.SimpleNamespace(HKEY_LOCAL_MACHINE=1, HKEY_CURRENT_USER=2, KEY_READ=1, KEY_WOW64_32KEY=2,
                                         OpenKey=lambda *a: contextlib.nullcontext('key'), QueryValueEx=lambda *a: ('123.0', 1))
        calls = []
        def command(args, name, **kwargs):
            calls.append(name)
            if name == 'verify-production-signatures':
                raise RuntimeError('Synthetic bad signature')
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(qa, 'ROOT', Path(temp)), \
             mock.patch.object(route, 'BASE', Path(temp) / '.local/goal-package-inspection'), \
             mock.patch.object(route, 'EVIDENCE', Path(temp) / '.local/goal-package-inspection/evidence'), \
             mock.patch.object(qa, 'no_package_app'), mock.patch.object(qa, 'installer_source_proof', return_value={}), \
             mock.patch.object(qa, 'artifact_ready'), mock.patch.object(qa, 'package_audit'), \
             mock.patch.object(route, 'download_artifact'), mock.patch.object(route, 'validate_candidate', return_value=({}, {})), \
             mock.patch.object(route, 'command', side_effect=command), mock.patch.dict(sys.modules, {'winreg': registry}):
            with self.assertRaisesRegex(RuntimeError, 'bad signature'):
                qa.inspect_package(route)
            self.assertNotIn('inspect-package-install', calls)
            self.assertEqual(json.loads((route.EVIDENCE / 'operation.json').read_text())['state'], 'failed')

    def test_exact_nsis_no_autolaunch_source_and_metadata_only_workflow(self):
        proof = qa.installer_source_proof()
        self.assertIn('/R required', proof['restart_flag'])
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(qa, 'ROOT', Path(temp)), \
             self.assertRaises((FileNotFoundError, RuntimeError)):
            qa.installer_source_proof()
        workflow = (ROOT / '.github/workflows/goal-development-installed-qa.yml').read_text()
        self.assertIn('--package-inspection-only', workflow)
        self.assertIn('--package-inspection-audit', workflow)
        for forbidden in ('--owned-app-policy', '--mcp-cli', '@playwright/mcp', '--cleanup-owned-policy'):
            self.assertNotIn(forbidden, workflow)


if __name__ == '__main__':
    unittest.main()
