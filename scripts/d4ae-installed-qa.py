"""One exact signed Windows release in a disposable hosted fixture; no product writes."""
import argparse
import asyncio
import contextlib
import datetime
import hashlib
import importlib.util
import importlib.metadata
import json
import os
import socket
import shutil
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import threading
import urllib.request
import urllib.error
import urllib.parse
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OPERATION = 'd4ae-installed-qa-20261020-v1'
SOURCE = 'ba433551496cdba26fb27f34c2ca503bab8bf28a'
TREE = '08dbbf66ff10d9231bab0dfe9caf83c3c4f5d9d9'
BUILD = '20261020-event-delete-0520.1'
VERSION = '0.5.20'
INSTALLED_EXE_SHA = '5824491ffc9b7f8386cffe696e9c664196d260813ad531ca843babf3544303a0'
REPO = 'sultanjakhan/Cicada'
REPO_ID = 1373356816
SIGNING_RUN = 39363910526
CI_RUN = 39363355504
ARTIFACT_ID = 12238822535
ARCHIVE_SIZE = 5514745
ARCHIVE_SHA = 'f5608c94198b552d51faf6a51846d5f0230875bfdb993c7f38eadf119d980d8d'
INSTALLER_SIZE = 5529168
INSTALLER_SHA = '2a9248bc45ce12dfccd540cf361fffd2239910f50ec1bb28c876d54399d6c832'
DESCRIPTOR_SHA = '2ad0834d55e6d996ae55e42411d650b9bf26bdb25d70741ba6488838ca9fd255'
PREPARED_ID = '1818c76fd472de5803e79529820038983891360ef22176fd85b192df8a6c3177'
ASSET = 'Cicada-0.5.20-windows-x86_64.exe'
ARTIFACT = 'cicada-update-windows-' + SOURCE
BASE = ROOT / '.local/d4ae-installed-qa'
EVIDENCE = BASE / 'evidence'
POLICY_NAME = 'hanni-mvp.exe'
POLICY_ROOT = r'Software\Policies\Microsoft\Edge\WebView2'
POLICY_KEY = POLICY_ROOT + r'\AdditionalBrowserArguments'
POLICY_OPTIONS = ('BrowserExecutableFolder','ChannelSearchKind','ReleaseChannels','AdditionalBrowserArguments','UserDataFolder','ReleaseChannelPreference')
POLICY_RECEIPT = 'owned-webview-policy.json'
MCP_RUN_TOOL = 'browser_run_code_unsafe'  # Actual default core registration in pinned @playwright/mcp 0.0.80.
# Primary basis: WebView2 Globals/CreateCoreWebView2EnvironmentWithOptions (AppId -> exe -> *),
# concepts/security (elevated hosts honor HKLM), winprog64/shared-registry-keys
# (SOFTWARE\Policies shared). Audit both logical views; mutate only HKLM/64/exact exe value.
# https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl
# https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security
# https://learn.microsoft.com/en-us/windows/win32/winprog64/shared-registry-keys
# Runtime compiled filename is verified before resume and at readiness; no bundle/shortcut AUMID is assumed.


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def policy_arguments(port):
    require(type(port) is int and 1024 <= port <= 65535, 'Invalid owned CDP port')
    return '--remote-debugging-port=' + str(port) + ' --remote-debugging-address=127.0.0.1'


def validate_policy_snapshot(rows, owned=None):
    for row in rows:
        require(not row['unknown_subkeys'], 'Ambiguous WebView policy subkeys')
        for name,value,kind in row['values']:
            allowed = (owned is not None and row['hive']=='HKLM' and row['option']=='AdditionalBrowserArguments'
                       and name==POLICY_NAME and kind==1 and value==owned)
            require(allowed, 'Preexisting, foreign or changed WebView policy; refusing mutation/launch')


class WindowsPolicyStore:
    def snapshot(self):
        import winreg as reg
        rows=[]
        for hive_name,hive in (('HKLM',reg.HKEY_LOCAL_MACHINE),('HKCU',reg.HKEY_CURRENT_USER)):
            for view in (reg.KEY_WOW64_64KEY,reg.KEY_WOW64_32KEY):
                for option in ('',*POLICY_OPTIONS,'legacy'):
                    path = (r'Software\Policies\Microsoft\EmbeddedBrowserWebView\LoaderOverride' if option=='legacy'
                            else POLICY_ROOT + ('\\'+option if option else ''))
                    try:
                        with reg.OpenKey(hive,path,0,reg.KEY_READ|view) as key:
                            subkeys,values,_=reg.QueryInfoKey(key)
                            children=[reg.EnumKey(key,i) for i in range(subkeys)]
                            rows.append({'hive':hive_name,'view':view,'option':option,
                                'values':[reg.EnumValue(key,i) for i in range(values)],
                                'unknown_subkeys':[name for name in children if option or name not in POLICY_OPTIONS]})
                    except FileNotFoundError:
                        pass
        return rows

    def exchange(self, expected, replacement):
        """Transacted absence/expected-value compare and single-value change; no overwrite race."""
        import ctypes
        from ctypes import wintypes as w
        ktm=ctypes.WinDLL('KtmW32',use_last_error=True);adv=ctypes.WinDLL('advapi32',use_last_error=True)
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        def api(dll,name,result,*args):
            fn=getattr(dll,name);fn.restype=result;fn.argtypes=args;return fn
        create=api(ktm,'CreateTransaction',w.HANDLE,ctypes.c_void_p,ctypes.c_void_p,w.DWORD,w.DWORD,w.DWORD,w.DWORD,w.LPWSTR)
        commit=api(ktm,'CommitTransaction',w.BOOL,w.HANDLE)
        rollback=api(ktm,'RollbackTransaction',w.BOOL,w.HANDLE)
        close=api(kernel,'CloseHandle',w.BOOL,w.HANDLE)
        create_key=api(adv,'RegCreateKeyTransactedW',w.LONG,w.HKEY,w.LPCWSTR,w.DWORD,w.LPWSTR,w.DWORD,w.DWORD,
                       ctypes.c_void_p,ctypes.POINTER(w.HKEY),ctypes.POINTER(w.DWORD),w.HANDLE,ctypes.c_void_p)
        query=api(adv,'RegQueryValueExW',w.LONG,w.HKEY,w.LPCWSTR,ctypes.c_void_p,ctypes.POINTER(w.DWORD),ctypes.c_void_p,ctypes.POINTER(w.DWORD))
        set_value=api(adv,'RegSetValueExW',w.LONG,w.HKEY,w.LPCWSTR,w.DWORD,w.DWORD,ctypes.c_void_p,w.DWORD)
        delete=api(adv,'RegDeleteValueW',w.LONG,w.HKEY,w.LPCWSTR)
        close_key=api(adv,'RegCloseKey',w.LONG,w.HKEY)
        def checked(code):
            if code:raise ctypes.WinError(code)
        transaction=create(None,None,0,0,0,10000,'D4AE owned WebView single value')
        require(transaction not in (None,0,ctypes.c_void_p(-1).value),'Registry transactions unavailable; no non-atomic fallback')
        key=w.HKEY();committed=False
        try:
            disposition=w.DWORD()
            # HKLM predefined handle must be sign-extended on 64-bit Windows.
            checked(create_key(w.HKEY(-2147483646),POLICY_KEY,0,None,0,0x20019|0x2|0x100,None,
                               ctypes.byref(key),ctypes.byref(disposition),transaction,None))
            kind=w.DWORD();size=w.DWORD();code=query(key,POLICY_NAME,None,ctypes.byref(kind),None,ctypes.byref(size))
            current=None
            if code!=2:
                checked(code);require(size.value<=65536,'Oversized policy value')
                buffer=ctypes.create_string_buffer(size.value)
                checked(query(key,POLICY_NAME,None,ctypes.byref(kind),buffer,ctypes.byref(size)))
                current=(kind.value,buffer.raw[:size.value])
            wanted=None if expected is None else (1,(expected+'\0').encode('utf-16-le'))
            require(current==wanted,'Policy compare failed; preserving preexisting/foreign change')
            if replacement is None:
                checked(delete(key,POLICY_NAME))
            else:
                raw=(replacement+'\0').encode('utf-16-le');buffer=ctypes.create_string_buffer(raw)
                checked(set_value(key,POLICY_NAME,0,1,buffer,len(raw)))
            checked(close_key(key));key=w.HKEY()
            if not commit(transaction):raise ctypes.WinError(ctypes.get_last_error())
            committed=True
        finally:
            if key.value:close_key(key)
            if not committed:rollback(transaction)
            close(transaction)


class OwnedWebviewPolicy:
    def __init__(self,store,value,receipt):
        self.store=store;self.value=value;self.receipt=receipt;self.owned=False
        self.record={'operation':OPERATION,'run':os.environ.get('GITHUB_RUN_ID'),'head':os.environ.get('GITHUB_SHA'),
                     'source':SOURCE,'exe_sha256':INSTALLED_EXE_SHA,'hive':'HKLM','view':64,'key':POLICY_KEY,
                     'name':POLICY_NAME,'type':1,'value':value,'state':'prepared','cleanup_verified':False,
                     'lookup_audit':{'hives':['HKLM','HKCU'],'views':[64,32],'options':list(POLICY_OPTIONS),
                                     'wildcard_and_all_appids':'must be absent','policies_key_is_shared':True}}

    def check(self):
        rows=self.store.snapshot();validate_policy_snapshot(rows,self.value)
        require({row['view'] for row in rows if row['hive']=='HKLM' and row['option']=='AdditionalBrowserArguments'
                 and (POLICY_NAME,self.value,1) in row['values']}=={0x100,0x200}, 'Owned policy missing or registry views disagree')

    def activate(self):
        require(not self.receipt.exists(),'Policy receipt already exists; refusing duplicate mutation')
        rows=self.store.snapshot()
        # Preserve presence/type/name/hash evidence without publishing unrelated configuration contents.
        self.record['before']=[{**row,'values':[(n,k,hashlib.sha256(str(v).encode()).hexdigest()) for n,v,k in row['values']]} for row in rows]
        write_json(self.receipt,self.record)
        validate_policy_snapshot(rows)
        self.record['state']='validated_absent';write_json(self.receipt,self.record)
        self.store.exchange(None,self.value);self.owned=True
        self.record['state']='owned';write_json(self.receipt,self.record)
        self.check()
        self.record['readback_verified']=True;write_json(self.receipt,self.record)

    def cleanup(self):
        if self.owned:
            try:
                self.store.exchange(self.value,None)
                validate_policy_snapshot(self.store.snapshot())
                self.record.update(state='removed',cleanup_verified=True)
                self.owned=False
            except BaseException as error:
                self.record.update(state='cleanup_refused_or_failed',error=str(error),cleanup_verified=False)
                raise
            finally:
                write_json(self.receipt,self.record)


def owned_process_identity(handle,exe):
    import ctypes
    from ctypes import wintypes as w
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    query=kernel.QueryFullProcessImageNameW;query.argtypes=[w.HANDLE,w.DWORD,w.LPWSTR,ctypes.POINTER(w.DWORD)];query.restype=w.BOOL
    size=w.DWORD(32768);path=ctypes.create_unicode_buffer(size.value)
    require(query(int(handle),0,path,ctypes.byref(size)),'Cannot establish owned process executable')
    require(Path(path.value).resolve()==exe.resolve() and Path(path.value).name==POLICY_NAME,'Compiled process code name differs')
    return {'image':path.value,'compiled_code_name':POLICY_NAME,'application_user_model_id':'UNKNOWN; not queried or assumed',
            'policy_value_name':POLICY_NAME,
            'lookup_basis':'All AppId and wildcard values absent in both hives/views; exact executable fallback only'}


def reject_foreign_matching_apps(allowed_pid=None):
    import psutil
    for process in psutil.process_iter(['pid','name']):
        name=process.info['name']
        require(name is not None,'Cannot inspect process name for policy ownership')
        if name.casefold() in (POLICY_NAME,'cicada.exe'):
            require(process.pid==allowed_pid,'Foreign matching app exists; refusing shared executable-name policy')
        if name.casefold()=='msedgewebview2.exe':
            arguments=process.cmdline()
            if any(arg.casefold()=='--webview-exe-name='+POLICY_NAME for arg in arguments):
                require(allowed_pid is not None and allowed_pid in [parent.pid for parent in process.parents()],
                        'Foreign matching WebView exists')


def cleanup_owned_policy():
    validate_host_context(sys.platform,os.environ)
    receipt=EVIDENCE/POLICY_RECEIPT
    if not receipt.exists():return 0
    record=json.loads(receipt.read_text(encoding='utf-8'))
    require((record.get('operation'),record.get('run'),record.get('head'),record.get('source'),record.get('exe_sha256'),record.get('key'),record.get('name'),record.get('hive'),record.get('view'),record.get('type'))==
            (OPERATION,os.environ.get('GITHUB_RUN_ID'),os.environ.get('GITHUB_SHA'),SOURCE,INSTALLED_EXE_SHA,POLICY_KEY,POLICY_NAME,'HKLM',64,1),'Foreign policy receipt')
    value=record['value'];prefix='--remote-debugging-port='
    port=int(value.split(' ',1)[0].removeprefix(prefix));require(value==policy_arguments(port),'Unapproved policy arguments')
    if record['state']=='removed':
        validate_policy_snapshot(WindowsPolicyStore().snapshot());return 0
    policy=OwnedWebviewPolicy(WindowsPolicyStore(),value,receipt);policy.record=record
    rows=policy.store.snapshot()
    if not any(name==POLICY_NAME for row in rows for name,_,_ in row['values']):
        validate_policy_snapshot(rows);record.update(state='removed',cleanup_verified=True);write_json(receipt,record);return 0
    require(record['state'] in ('owned','cleanup_refused_or_failed'),
            'Policy ownership not durably confirmed; preserving value and reporting UNKNOWN cleanup')
    policy.owned=True;policy.cleanup();return 0


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def validate_run(run, signing=True):
    require(run.get('id') == (SIGNING_RUN if signing else CI_RUN), 'Wrong workflow run')
    require(run.get('head_sha') == SOURCE and run.get('head_branch') == 'main', 'Wrong source/branch')
    require(run.get('head_commit', {}).get('tree_id') == TREE, 'Wrong source tree')
    for key in ('repository', 'head_repository'):
        repo = run.get(key, {})
        require(repo.get('id') == REPO_ID and repo.get('full_name') == REPO and repo.get('fork') is False, 'Untrusted repository')
    require(run.get('event') == ('workflow_run' if signing else 'push'), 'Wrong workflow event')
    require(run.get('path') == ('.github/workflows/signed-update-candidate.yml' if signing else '.github/workflows/ci.yml'), 'Wrong workflow path')
    if run.get('status') == 'completed':
        require(run.get('conclusion') == 'success', 'Pinned workflow did not succeed')


def validate_candidate(directory):
    directory = Path(directory)
    expected = {ASSET, ASSET + '.sig', ASSET + '.identity.json', ASSET + '.identity.json.sig', 'manifest.json'}
    require({p.name for p in directory.iterdir()} == expected, 'Unexpected signed artifact files')
    for path in directory.iterdir():
        require(path.is_file() and not path.is_symlink() and path.stat().st_nlink == 1, 'Unsafe artifact file')
    require((directory / 'manifest.json').stat().st_size < 16384, 'Oversized manifest')
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8-sig'))
    require((manifest.get('source'), manifest.get('version'), manifest.get('build_id'), manifest.get('identifier'), manifest.get('platform')) ==
            (SOURCE, VERSION, BUILD, 'app.hanni.mvp', 'windows-x86_64'), 'Wrong signed candidate identity')
    require(manifest.get('asset') == ASSET and manifest.get('signature_file') == ASSET + '.sig', 'Wrong asset names')
    payload = directory / ASSET
    require(0 < payload.stat().st_size <= 25 * 1024 * 1024, 'Invalid installer size')
    require(payload.stat().st_size == INSTALLER_SIZE and digest(payload) == INSTALLER_SHA, 'Installer differs from the exact admitted signed bytes')
    require(manifest.get('sha256') == digest(payload) and manifest.get('size') == payload.stat().st_size, 'Installer hash/size mismatch')
    require(manifest.get('control_descriptor_file') == ASSET + '.identity.json' and
            manifest.get('control_descriptor_signature_file') == ASSET + '.identity.json.sig', 'Wrong descriptor names')
    descriptor_path = directory / (ASSET + '.identity.json')
    require(0 < descriptor_path.stat().st_size <= 16384, 'Invalid descriptor size')
    for name in (ASSET + '.sig', ASSET + '.identity.json.sig'):
        require(0 < (directory / name).stat().st_size <= 4096, 'Invalid signature size')
    require(manifest.get('signature') == (directory / (ASSET + '.sig')).read_text(encoding='utf-8').strip(), 'Signature differs from manifest')
    require(manifest.get('control_descriptor_sha256') == digest(descriptor_path), 'Descriptor hash mismatch')
    require(digest(descriptor_path) == DESCRIPTOR_SHA, 'Descriptor differs from the exact admitted signed bytes')
    descriptor = json.loads(descriptor_path.read_text(encoding='utf-8'))
    require(descriptor.get('prepared_id') == PREPARED_ID, 'Wrong prepared identity')
    require((descriptor.get('identifier'), descriptor.get('platform'), descriptor.get('source_commit'), descriptor.get('version'), descriptor.get('build_id'), descriptor.get('installer_sha256'), descriptor.get('installer_size')) ==
            ('app.hanni.mvp', 'windows-x86_64', SOURCE, VERSION, BUILD, manifest['sha256'], manifest['size']), 'Descriptor identity mismatch')
    return manifest, descriptor


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # Callers reject redirects or explicitly follow without credentials.


def api(path):
    require(path.startswith('/actions/runs/'), 'Unsupported API operation')
    request = urllib.request.Request('https://api.github.com/repos/' + REPO + path,
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        return json.load(response)


def profile_argument(arguments):
    for index, value in enumerate(arguments):
        if value.startswith('--user-data-dir='):
            return value.split('=', 1)[1]
        if value == '--user-data-dir' and index + 1 < len(arguments):
            return arguments[index + 1]
    return None


def profile_is_owned(folder, expected):
    if not folder:
        return False
    try:
        return Path(folder).resolve().is_relative_to(Path(expected).resolve())
    except (OSError, ValueError):
        return False


class ReadinessObservation:
    """Observe only this launcher's descendants; never alter launcher policy."""
    def __init__(self, client_pid):
        self.client_pid = client_pid
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.observe, daemon=True)
        self.thread.start()

    def observe(self):
        import psutil
        import win32api
        import win32process
        expected_exe = (BASE / 'installed/hanni-mvp.exe').resolve()
        expected_profile = (ROOT / '.local/background-qa' / OPERATION / 'data/webview2').resolve()
        output = {'client_pid':self.client_pid, 'purpose':'read-only diagnosis of the existing guarded launcher', 'samples':[], 'errors':[]}
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        last = None
        seen = {}
        for _ in range(720):
            if self.stop.is_set():
                break
            sample = {'processes':[], 'listeners':[], 'targets':[]}
            try:
                client = psutil.Process(self.client_pid)
                descendants = client.children(recursive=True)
                apps = [process for process in descendants if process.name().casefold() == 'hanni-mvp.exe' and Path(process.exe()).resolve() == expected_exe]
                for app in apps:
                    arguments = app.cmdline()
                    require('--isolated-test-root' in arguments, 'Observed app has no explicit isolation argument')
                    position = arguments.index('--isolated-test-root')
                    require(position + 1 < len(arguments) and Path(arguments[position+1]).resolve() == expected_profile.parent, 'Observed app isolation root differs')
                    owned = [app, *app.children(recursive=True)]
                    webviews = {}
                    for process in owned:
                        row = {'pid':process.pid,'parent':process.ppid(),'name':process.name(),'status':process.status(),'arguments':process.cmdline()}
                        if process.pid == app.pid:
                            handle = win32api.OpenProcess(0x1000, False, process.pid)
                            try:
                                row['exit_code'] = win32process.GetExitCodeProcess(handle)
                            finally:
                                handle.Close()
                        sample['processes'].append(row)
                        folder = profile_argument(row['arguments'])
                        if row['name'].casefold() == 'msedgewebview2.exe' and profile_is_owned(folder, expected_profile):
                            webviews[process.pid] = folder
                    for connection in psutil.net_connections(kind='tcp'):
                        if connection.status != psutil.CONN_LISTEN or connection.pid not in webviews:
                            continue
                        listener = {'pid':connection.pid,'ip':connection.laddr.ip,'port':connection.laddr.port,'profile':webviews[connection.pid]}
                        sample['listeners'].append(listener)
                        # Observe only the current app's owned loopback WebView.
                        # Never query a wildcard or foreign process listener.
                        if connection.laddr.ip != '127.0.0.1':
                            continue
                        for route in ('/json/version','/json/list'):
                            address = 'http://127.0.0.1:' + str(connection.laddr.port) + route
                            result = {'pid':connection.pid,'endpoint':address}
                            try:
                                with opener.open(address, timeout=0.3) as response:
                                    raw = response.read(32769)
                                    require(len(raw) <= 32768, 'Oversized CDP observation')
                                    result.update(http_status=response.status, payload=json.loads(raw))
                            except Exception as error:
                                result['error'] = type(error).__name__ + ': ' + str(error)
                            sample['targets'].append(result)
                    seen[app.pid] = app.create_time()
            except Exception as error:
                message = type(error).__name__ + ': ' + str(error)
                if message not in output['errors']:
                    output['errors'].append(message)
            encoded = json.dumps(sample, sort_keys=True)
            if encoded != last:
                output['samples'].append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(), **sample})
                last = encoded
                write_json(EVIDENCE / 'cdp-readiness-observation.json', output)
            self.stop.wait(0.25)
        output['owned_app_pids_seen'] = sorted(seen)
        write_json(EVIDENCE / 'cdp-readiness-observation.json', output)

    def finish(self):
        self.stop.set()
        self.thread.join(timeout=5)


def record_fixture_after_launch():
    database = ROOT / '.local/background-qa' / OPERATION / 'data/calendar.db'
    if not database.is_file():
        write_json(EVIDENCE / 'fixture-startup-diagnosis.json', {'database_exists':False})
        return
    try:
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as conn:
            value = {'database_exists':True,'user_version':conn.execute('PRAGMA user_version').fetchone()[0],
                'integrity':conn.execute('PRAGMA integrity_check').fetchone()[0],
                'tables':conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall(),
                'synthetic_rows':conn.execute('SELECT id,title,version FROM items ORDER BY id').fetchall()}
    except Exception as error:
        value = {'database_exists':True,'error':str(error)}
    write_json(EVIDENCE / 'fixture-startup-diagnosis.json', value)


def command(args, name, timeout=180, credentials=False):
    env = dict(os.environ)
    if not credentials:
        for key in list(env):
            if any(part in key.upper() for part in ('TOKEN', 'SECRET', 'PASSWORD', 'PRIVATE_KEY')):
                env.pop(key)
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    write_json(EVIDENCE / (name + '.json'), {'argv':[str(a) for a in args], 'started':started, 'state':'started', 'exit':None})
    process = subprocess.Popen([str(arg) for arg in args], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding='utf-8', errors='replace')
    observation = ReadinessObservation(process.pid) if name == 'actual-installed-runtime' else None
    try:
        stdout, stderr = process.communicate(timeout=timeout)
        result = subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
    finally:
        if observation:
            observation.finish()
            record_fixture_after_launch()
    write_json(EVIDENCE / (name + '.json'), {'argv': [str(a) for a in args], 'started': started, 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
    require(result.returncode == 0, name + ' failed, exit ' + str(result.returncode))
    return result.stdout


def wait_for_artifact():
    ci = api('/actions/runs/' + str(CI_RUN)); validate_run(ci, signing=False)
    require(ci.get('status') == 'completed' and ci.get('conclusion') == 'success', 'Main CI is not successful')
    write_json(EVIDENCE / 'main-ci.json', ci)
    deadline = time.monotonic() + 1800
    while True:
        run = api('/actions/runs/' + str(SIGNING_RUN)); validate_run(run)
        write_json(EVIDENCE / 'pinned-signing-run.json', run)
        if run.get('status') == 'completed':
            artifacts = api('/actions/runs/' + str(SIGNING_RUN) + '/artifacts?per_page=100')
            matches = [a for a in artifacts['artifacts'] if a['name'] == ARTIFACT and not a['expired']]
            require(len(matches) == 1, 'Pinned signing run has no unique signed Windows artifact')
            artifact = matches[0]
            require(artifact.get('id') == ARTIFACT_ID and artifact.get('size_in_bytes') == ARCHIVE_SIZE and artifact.get('digest') == 'sha256:' + ARCHIVE_SHA, 'Artifact differs from the admitted archive')
            require(artifact.get('workflow_run', {}).get('id') == SIGNING_RUN and artifact['workflow_run'].get('head_sha') == SOURCE, 'Artifact run/source mismatch')
            write_json(EVIDENCE / 'artifact-provenance.json', artifact)
            return
        require(time.monotonic() < deadline, 'Timed out waiting for the one pinned signing run')
        time.sleep(20)


def extract_artifact(archive, directory):
    expected = {ASSET, ASSET + '.sig', ASSET + '.identity.json', ASSET + '.identity.json.sig', 'manifest.json'}
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        require(len(entries) == 5 and {e.filename for e in entries} == expected, 'Unsafe or unexpected ZIP paths')
        require(sum(e.file_size for e in entries) <= 30 * 1024 * 1024, 'Oversized ZIP contents')
        for entry in entries:
            require(not entry.is_dir() and not entry.flag_bits & 1 and (entry.external_attr >> 16) & 0o170000 != 0o120000, 'Unsafe ZIP member')
        for entry in entries:
            (directory / entry.filename).write_bytes(bundle.read(entry))


def download_artifact(directory):
    url = 'https://api.github.com/repos/' + REPO + '/actions/artifacts/' + str(ARTIFACT_ID) + '/zip'
    request = urllib.request.Request(url, headers={'Authorization':'Bearer ' + os.environ['GH_TOKEN'], 'Accept':'application/vnd.github+json'})
    opener = urllib.request.build_opener(NoRedirect())
    try:
        response = opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        require(error.code == 302, 'Artifact endpoint did not return its expected download redirect')
        location = urllib.parse.urlsplit(error.headers.get('Location', ''))
        require(location.scheme == 'https' and location.hostname and location.hostname.endswith('.blob.core.windows.net')
                and not location.username and not location.password and not location.fragment, 'Untrusted artifact download destination')
        # The temporary blob URL is never recorded, and the GitHub bearer token
        # is never sent to it. Further redirects are refused.
        response = opener.open(urllib.request.Request(location.geturl()), timeout=60)
    with response:
        raw = response.read(ARCHIVE_SIZE + 1)
    require(len(raw) == ARCHIVE_SIZE and hashlib.sha256(raw).hexdigest() == ARCHIVE_SHA, 'Signed artifact ZIP hash/size mismatch')
    archive = BASE / 'signed-windows.zip'; archive.write_bytes(raw)
    write_json(EVIDENCE / 'download-pinned-artifact.json', {'api_path':url,'artifact_id':ARTIFACT_ID,'sha256':ARCHIVE_SHA,'size':len(raw),'verification':'passed'})
    extract_artifact(archive, directory)


def seed_protected_fixture(exe_hash):
    # Offline synthetic v1 fixture, before the only application launch. Native
    # release migrations initialize the remaining tables; no live DB mutation.
    run = ROOT / '.local/background-qa' / OPERATION
    require(not run.exists(), 'Operation QA profile already exists; refusing duplicate launch')
    data = run / 'data'; data.mkdir(parents=True)
    write_json(run / 'profile.json', {'application': 'app.hanni.mvp', 'purpose': 'isolated-background-qa', 'exe_sha256': exe_hash})
    write_json(data / 'cicada-isolated-test.json', {'schemaVersion': 1, 'application': 'app.hanni.mvp', 'purpose': 'isolated-release-test'})
    today = datetime.date.today().isoformat()
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with sqlite3.connect(data / 'calendar.db') as conn:
        conn.executescript("""CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT '',date TEXT,time TEXT,duration_minutes INTEGER NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,tags TEXT NOT NULL DEFAULT '');
            PRAGMA user_version=1;""")
        for identifier, title, tags in [
            ('hc-sleep:d4ae-fixture', 'D4AE protected sleep', ['health:sleep:v1', 'health:asleep:30', 'health:origin:com.example.qa']),
            ('hc-walk:d4ae-fixture', 'D4AE protected walking', ['health:walking:v1', 'health:origin:com.example.qa']),
            ('hc-steps:all:' + today, 'D4AE protected steps', ['health:steps:v1', 'health:steps-count:100'])]:
            conn.execute("INSERT INTO items(id,kind,title,date,time,duration_minutes,version,created_at,updated_at,tags) VALUES(?,'event',?,?,'05:00',30,1,?,?,?)", (identifier,title,today,timestamp,timestamp,json.dumps(tags)))
    write_json(EVIDENCE / 'fixture-before-launch.json', {'root': str(data), 'database_sha256': digest(data / 'calendar.db'), 'purpose': 'synthetic protected records only; all ordinary mutations use real IPC'})
    return run, data


SIGNATURE_CHECK = r"""
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [directory,root]=process.argv.slice(1);
const {verifyTauriSignature}=await import(pathToFileURL(path.join(root,'scripts/stage-updates.mjs')));
const key=await readFile(path.join(root,'src-tauri/update-public-key.txt'),'utf8');
for(const name of ['Cicada-0.5.20-windows-x86_64.exe','Cicada-0.5.20-windows-x86_64.exe.identity.json']) {
  verifyTauriSignature(await readFile(path.join(directory,name)),await readFile(path.join(directory,name+'.sig'),'utf8'),key);
}
console.log('Both signatures verified with the existing pinned production public key.');
"""

# Executed by the official MCP server in the real installed app's WebView.
RUNTIME_CODE = r"""async (page) => {
  const assertions=[], receipts=[], menuTrace=[];
  try {
  const check=(ok,label)=>{if(!ok)throw Error(label);assertions.push(label);};
  const call=async(name,args={})=>{
    const result=await page.evaluate(async({name,args})=>{try{return {ok:true,value:await window.__TAURI__.core.invoke(name,args)}}catch(e){return {ok:false,error:String(e)}}},{name,args});
    receipts.push({name,args,result});return result;
  };
  const rpc=async(name,args={})=>{const r=await call(name,args);if(!r.ok)throw Error(name+': '+r.error);return r.value;};
  const reject=async(name,args,error)=>{const r=await call(name,args);check(!r.ok&&r.error.includes(error),'reject '+name+': '+error);};
  const snap=async label=>{await page.screenshot({path:SHOTS+'/'+label+'.png'});};
  await page.waitForFunction(()=>!!window.__TAURI__?.core?.invoke);
  const status=await rpc('isolated_test_status');
  check(status.isolated===true&&status.integrationsEnabled===false,'native isolation and disabled integrations');
  check(status.root.replace(/\\/g,'/').toLowerCase()===DATA.replace(/\\/g,'/').toLowerCase(),'exact isolated data root');
  await reject('mvp_sync_now',{},'isolated_test_integration_disabled');
  const today=await page.evaluate(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;});
  const event=async title=>rpc('create_event',{title,description:'Synthetic installed QA',date:today,time:'10:00',durationMinutes:30,category:'general',color:'#123456',priority:1,linkedTab:''});
  const goal=async title=>rpc('save_calendar_goal',{id:null,title,targetValue:1,unit:'',deadline:null,goalKind:'goal',description:'',criteria:'',parentGoalId:null,clearParent:false,currentValue:null,numericProgress:false,expectedGoal:null});
  const g1=await goal('D4AE original goal'),g2=await goal('D4AE newer goal');
  const link=async(id,g)=>rpc('set_calendar_task_goal',{sourceType:'event',sourceId:id,goalId:g});
  const records=()=>rpc('get_all_events');
  const get=async id=>(await records()).find(e=>e.id===id);
  const links=()=>rpc('get_calendar_task_goals');
  const open=async id=>{
    await page.evaluate(id=>{
      const key='__d4aeMenuPassiveTrace';
      if(window[key])throw Error('passive trace ownership collision');
      const entries=[], listeners=[], limit=160;
      let phase='open-start', previousHost, previousRow, previousMenu;
      const classify=node=>{
        if(!(node instanceof Element))return {tag:'none',role:'none',kind:'other'};
        const role=node.getAttribute('role');
        const kind=[['[data-menu-action="edit"]','edit'],['[data-record-menu]','record-menu'],['button[data-period="day"]','day'],['[data-today]','today'],['.uni-tab[data-pane="table"]','table'],['.calendar-record-menu','menu'],['[data-calendar-records]','records']].find(([selector])=>node.closest(selector));
        return {tag:['BUTTON','DIV','INPUT','TEXTAREA','BODY','HTML'].includes(node.tagName)?node.tagName:'other',role:['menu','menuitem','button','dialog'].includes(role)?role:'other',kind:kind?kind[1]:'other'};
      };
      const sample=(event,target,mutations=[])=>{
        const host=document.querySelector('#uni-pane-calendar [data-calendar-records]');
        const row=host&&Array.from(host.querySelectorAll('[data-record-source]')).find(node=>node.getAttribute('data-record-source')==='event:'+id);
        const menus=document.querySelectorAll('.calendar-record-menu'), menu=menus[0], rect=menu?.getBoundingClientRect();
        const busy=host?.getAttribute('aria-busy');
        entries.push({ms:Math.round(performance.now()*10)/10,phase,event,target:classify(target),focus:classify(document.activeElement),
          host:!!host,busy:busy===null?'absent':busy==='true'?'true':'other',rowConnected:!!row?.isConnected,
          previousHostDetached:!!previousHost&&!previousHost.isConnected,previousRowDetached:!!previousRow&&!previousRow.isConnected,
          previousMenuDetached:!!previousMenu&&!previousMenu.isConnected,menuCount:menus.length,
          menuRect:rect?[rect.x,rect.y,rect.width,rect.height].map(Math.round):null,
          scroll:target instanceof Element?[Math.round(target.scrollLeft),Math.round(target.scrollTop)]:null,
          childList:mutations.some(m=>m.type==='childList'),removed:mutations.some(m=>m.removedNodes?.length>0),
          busyAttribute:mutations.some(m=>m.attributeName==='aria-busy'),expandedAttribute:mutations.some(m=>m.attributeName==='aria-expanded')});
        if(entries.length>limit)entries.shift();
        previousHost=host;previousRow=row;previousMenu=menu;
      };
      const listen=(target,type)=>{
        const fn=e=>{const kind=classify(e.target).kind;if(type==='pointerdown'&&kind!=='other')phase=kind;sample(type,e.target);};
        target.addEventListener(type,fn,{capture:true,passive:true});listeners.push([target,type,fn]);
      };
      for(const type of ['pointerdown','focusin','focusout','scroll'])listen(document,type);
      listen(window,'resize');listen(window,'hanni:calendar-refresh');
      const observer=new MutationObserver(mutations=>sample('mutation',null,mutations));
      observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-busy','aria-expanded']});
      window[key]=()=>{
        observer.disconnect();for(const [target,type,fn] of listeners)target.removeEventListener(type,fn,true);
        phase='open-end';sample('cleanup',null);delete window[key];return entries;
      };
      sample('start',null);
    },id);
    try {
    const host='#uni-pane-calendar [data-calendar-records]';
    const ready=page.locator(host+':not([aria-busy])');
    const dayReady=page.locator(host+'[data-period="day"]:not([aria-busy])');
    await page.evaluate(async()=>{window.dispatchEvent(new CustomEvent('hanni:calendar-refresh'));await Promise.resolve();});
    if(await page.locator(host).count())await ready.waitFor({state:'visible'});
    await page.locator('.uni-tab[data-pane="table"]').click();
    await ready.waitFor({state:'visible'});
    await page.locator('button[data-period="day"]').click();
    await dayReady.waitFor({state:'visible'});
    await page.locator('[data-today]').first().click();
    await dayReady.waitFor({state:'visible'});
    const row=page.locator(`[data-record-source="event:${id}"]`).first();
    await row.locator('[data-record-menu]').click();
    await page.locator('[data-menu-action="edit"]').click();
    await page.locator('#evm-title').waitFor();
    } finally {
      const trace=await page.evaluate(()=>{
        const stop=window.__d4aeMenuPassiveTrace;
        return typeof stop==='function'?stop():[{event:'trace-unavailable'}];
      });
      menuTrace.push(...trace);if(menuTrace.length>160)menuTrace.splice(0,menuTrace.length-160);
    }
  };
  const confirmDelete=async()=>{page.once('dialog',d=>d.accept());await page.locator('#evm-del').click();};
  const review=async()=>{await page.locator('#evm-delete-review').click();await page.locator('dialog[open] [type="submit"]').waitFor();};
  const closeReview=()=>page.locator('dialog[open] [data-dialog-close]').first().click();
  const commitReview=()=>page.locator('dialog[open] [type="submit"]').click();
  const update=async(id,version,title)=>rpc('update_event',{id,expectedVersion:version,title});
  await snap('00-isolated-start');
  const id=await event('D4AE revision N');await link(id,g1);
  const block=await rpc('start_task_block',{sourceType:'event',sourceId:id});await rpc('pause_task_block',{blockId:block});
  await open(id);await page.locator('#evm-title').fill('D4AE unsaved draft');await page.locator('#evm-desc').fill('Retain this description');
  await update(id,1,'D4AE revision N2');await link(id,g2);
  await confirmDelete();await page.locator('#evm-delete-review').waitFor({state:'visible'});
  check((await get(id)).version===2,'stale delete preserves revision N2');
  check((await links()).some(l=>l.source_id===id&&l.goal_id===g2),'stale delete preserves newer goal link');
  check(await page.locator('#evm-title').inputValue()==='D4AE unsaved draft','stale delete retains title draft');
  check(await page.locator('#evm-desc').inputValue()==='Retain this description','stale delete retains description draft');
  await snap('01-stale-draft');await review();
  check((await page.locator('dialog[open]').innerText()).includes('D4AE revision N2'),'review displays current saved revision');
  check((await page.locator('dialog[open]').innerText()).includes('D4AE newer goal'),'review displays current goal');
  await snap('02-current-review');await closeReview();
  check(await page.locator('#evm-title').inputValue()==='D4AE unsaved draft','cancelled review preserves draft');
  await review();await update(id,2,'D4AE revision N3');await commitReview();
  await page.locator('dialog[open] [data-dialog-error]').waitFor({state:'visible'});
  check((await get(id)).version===3,'intervening change refuses reviewed deletion');
  check(await page.locator('dialog[open] [type="submit"]').isDisabled(),'failed review requires fresh review');
  await snap('03-review-conflict');await closeReview();await review();
  check((await page.locator('dialog[open]').innerText()).includes('D4AE revision N3'),'fresh review displays revision N3');
  await commitReview();await page.locator('#evm-title').waitFor({state:'detached'});
  check(!(await get(id)),'confirmed revision deleted');check(!(await links()).some(l=>l.source_id===id),'confirmed deletion cleans event link');
  check((await rpc('get_timeline_blocks',{date:today})).some(b=>b.id===block&&!b.is_active),'closed timer history preserved');
  await reject('delete_event',{id,expectedVersion:3},'event changed elsewhere or was deleted');
  const missing=await event('D4AE disappearance');await open(missing);await page.locator('#evm-title').fill('D4AE missing draft');
  await rpc('delete_event',{id:missing,expectedVersion:1});await confirmDelete();await page.locator('#evm-delete-review').waitFor({state:'visible'});
  await page.locator('#evm-delete-review').click();await page.waitForFunction(()=>document.querySelector('#evm-error')?.textContent.includes('больше не существует'));
  check(await page.locator('#evm-title').inputValue()==='D4AE missing draft','disappearance keeps draft');check(!(await get(missing)),'review never recreates missing event');
  await snap('04-missing-draft');await page.locator('#evm-close').click();
  const ordinary=await event('D4AE ordinary current');await link(ordinary,g1);await open(ordinary);await confirmDelete();await page.locator('#evm-title').waitFor({state:'detached'});
  check(!(await get(ordinary))&&!(await links()).some(l=>l.source_id===ordinary),'ordinary current delete and link cleanup');
  const active=await event('D4AE active timer');await link(active,g1);const activeBlock=await rpc('start_task_block',{sourceType:'event',sourceId:active});await open(active);
  await confirmDelete();await page.locator('#evm-delete-review').waitFor({state:'visible'});
  check((await get(active)).version===1,'active timer prevents event deletion');check((await links()).some(l=>l.source_id===active),'active timer refusal preserves link');
  check((await page.locator('#evm-error').innerText()).includes('паузу'),'active timer error explains pause');await snap('05-active-refusal');
  await rpc('pause_task_block',{blockId:activeBlock});await review();await commitReview();await page.locator('#evm-title').waitFor({state:'detached'});
  check(!(await get(active)),'paused event deletes after explicit review');
  check((await rpc('get_timeline_blocks',{date:today})).some(b=>b.id===activeBlock&&!b.is_active),'paused history retained after deletion');
  const protectedBefore=(await records()).filter(e=>e.id.startsWith('hc-'));
  check(protectedBefore.length===3&&protectedBefore.every(e=>e.readonly),'three real protected fixture projections');
  for(const e of protectedBefore)await reject('delete_event',{id:e.id,expectedVersion:e.version},e.id.startsWith('hc-sleep:')?'health_sleep_readonly':'health_activity_readonly');
  check(JSON.stringify((await records()).filter(e=>e.id.startsWith('hc-')))===JSON.stringify(protectedBefore),'protected records unchanged');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('hanni:calendar-refresh')));
  await page.locator('[data-record-source="event:hc-sleep:d4ae-fixture"] .calv-record').first().click();
  await page.locator('dialog[open]').waitFor();check(await page.locator('#evm-del').count()===0,'protected record exposes no delete action');await snap('06-protected-record');
  await page.locator('dialog[open] [data-close]').first().click();await snap('07-runtime-finished');
  return {d4aeOutcome:'passed',assertionCount:assertions.length,assertions,receipts,status,menuTrace};
  } catch(error) {
    await page.screenshot({path:SHOTS+'/failure.png'}).catch(()=>{});
    return {d4aeOutcome:'failed',error:String(error),assertions,receipts,menuTrace};
  }
}"""


def parse_runtime_result(stored):
    for part in stored.get('content', []):
        if part.get('type') != 'text':
            continue
        text = part.get('text', '')
        for heading in ('### Result\n', '# Result\n'):
            if heading in text:
                raw = text.split(heading, 1)[1].lstrip()
                try:
                    value, _ = json.JSONDecoder().raw_decode(raw)
                    if isinstance(value, str):
                        value = json.loads(value)
                    if isinstance(value, dict) and value.get('d4aeOutcome') == 'passed' and value.get('assertionCount', 0) >= 25:
                        return value
                except (ValueError, TypeError):
                    pass
    raise RuntimeError('No unambiguous successful runtime assertion result')


def preflight():
    import win32service
    import win32con
    import winreg
    station = win32service.GetUserObjectInformation(win32service.GetProcessWindowStation(), win32con.UOI_NAME)
    require(station.casefold() == 'winsta0', 'Hosted runner has no interactive WinSta0; no desktop/ACL fallback')
    desktop = win32service.OpenInputDesktop(0, False, win32con.DESKTOP_READOBJECTS)
    try:
        desktop_name = win32service.GetUserObjectInformation(desktop, win32con.UOI_NAME)
    finally:
        desktop.CloseDesktop()
    runtime_versions = []
    key_path = r'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
            try:
                with winreg.OpenKey(hive, key_path, 0, winreg.KEY_READ | view) as key:
                    version = winreg.QueryValueEx(key, 'pv')[0]
                    if version and version != '0.0.0.0':
                        runtime_versions.append(version)
            except FileNotFoundError:
                pass
    require(runtime_versions, 'Hosted runner WebView2 runtime is absent; no browser download fallback')
    write_json(EVIDENCE / 'runner-prerequisites.json', {'platform':sys.platform,'station':station,'input_desktop':desktop_name,
        'webview2_versions':sorted(set(runtime_versions)), 'python':sys.version,
        'python_packages':{name:importlib.metadata.version(name) for name in ('mcp','psutil','pywin32')}})


def validate_host_context(platform, env, station=None, desktop=None):
    require(platform == 'win32' and env.get('GITHUB_ACTIONS') == 'true' and env.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'Only disposable GitHub-hosted Windows is admitted')
    require(env.get('GITHUB_REPOSITORY') == REPO and env.get('GITHUB_REF') == 'refs/heads/work/d4ae-installed-qa-v1'
            and env.get('GITHUB_EVENT_NAME') == 'push' and env.get('GITHUB_RUN_ATTEMPT') == '1', 'Wrong operation trigger or duplicate attempt')
    if station is not None or desktop is not None:
        require(station == 'WinSta0' and desktop == 'Default', 'Only the disposable runner WinSta0 Default desktop is admitted')


def reject_overlap(candidate, protected):
    candidate = Path(candidate).resolve()
    for item in protected:
        item = Path(item).resolve(strict=True)
        require(not candidate.is_relative_to(item) and not item.is_relative_to(candidate), 'QA root overlaps a production data parent')


def validate_listener(listeners, owned_webviews, port):
    require(bool(listeners), 'No owned CDP listener')
    require(all(row['ip'] == '127.0.0.1' and row['port'] == port and row['pid'] in owned_webviews for row in listeners), 'CDP is not exclusively loopback and owned by the pinned WebView profile')


def unique_tauri_page(targets):
    pages = [target for target in targets if target.get('type') == 'page']
    require(len(pages) == 1, 'No unique installed Tauri page')
    url = urllib.parse.urlsplit(pages[0].get('url', ''))
    require(url.scheme == 'http' and url.hostname == 'tauri.localhost' and not url.username and not url.password and url.port is None, 'Unexpected installed Tauri page origin')
    return pages[0]


def current_thread_desktop():
    import ctypes
    from ctypes import wintypes
    user = ctypes.WinDLL('user32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentThreadId.restype = wintypes.DWORD
    user.GetThreadDesktop.argtypes = [wintypes.DWORD]; user.GetThreadDesktop.restype = wintypes.HANDLE
    user.GetUserObjectInformationW.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    user.GetUserObjectInformationW.restype = wintypes.BOOL
    handle = user.GetThreadDesktop(kernel.GetCurrentThreadId())
    require(bool(handle), 'Runner thread desktop is unavailable')
    name = ctypes.create_unicode_buffer(512); needed = wintypes.DWORD()
    require(bool(user.GetUserObjectInformationW(handle, 2, name, ctypes.sizeof(name), ctypes.byref(needed))), 'Cannot verify runner thread desktop')
    return name.value  # Borrowed GetThreadDesktop handle must not be closed.


def input_desktop_name():
    import win32service
    import win32con
    handle = win32service.OpenInputDesktop(0, False, win32con.DESKTOP_READOBJECTS)
    try:
        return win32service.GetUserObjectInformation(handle, win32con.UOI_NAME)
    finally:
        handle.CloseDesktop()


def serve_default_desktop(args):
    """Exact signed app on this disposable runner's normal desktop, then MCP stdio."""
    validate_host_context(sys.platform, os.environ)
    require(args.release_isolation, 'Explicit --release-isolation is mandatory')
    import msvcrt
    import psutil
    import qa_files
    import win32api
    import win32con
    import win32event
    import win32file
    import win32gui
    import win32job
    import win32process
    import win32service
    from win32com.shell import shell, shellcon
    station = win32service.GetUserObjectInformation(win32service.GetProcessWindowStation(), win32con.UOI_NAME)
    desktop = current_thread_desktop()
    validate_host_context(sys.platform, os.environ, station, desktop)
    input_handle = win32service.OpenInputDesktop(0, False, win32con.DESKTOP_READOBJECTS)
    try:
        input_before = win32service.GetUserObjectInformation(input_handle, win32con.UOI_NAME)
    finally:
        input_handle.CloseDesktop()
    require(input_before == 'Default', 'Runner input desktop is not Default')
    run = ROOT / '.local/background-qa' / OPERATION
    data = run / 'data'; profile = data / 'webview2'
    require(args.data_root.absolute() == data.absolute() and args.exe.absolute() == (BASE / 'installed/hanni-mvp.exe').absolute(), 'Unexpected isolated fixture or installed binary path')
    require(args.expected_sha256 == INSTALLED_EXE_SHA, 'Unexpected installed executable pin')
    protected = [Path(shell.SHGetFolderPath(0, item, None, 0)) for item in (shellcon.CSIDL_APPDATA, shellcon.CSIDL_LOCAL_APPDATA)]
    reject_overlap(data, protected)
    spec = importlib.util.spec_from_file_location('existing_qa_launch_policy', ROOT / 'scripts/qa-launch-policy.py')
    policy = importlib.util.module_from_spec(spec); spec.loader.exec_module(policy)
    manifest = {'state':'starting','desktop_mode':'hosted-default','station':station,'thread_desktop':desktop,'input_desktop_before':input_before,
                'source':SOURCE,'build':BUILD,'exe_sha256':args.expected_sha256,'data':str(data),'profile':str(profile),'cleanup_verified':False}
    handles = contextlib.ExitStack(); job = process = thread = mcp = None; lock_fd = None; policy_owner = None
    try:
        for directory in (ROOT / '.local', BASE, BASE / 'installed', run.parent, run, data):
            handles.enter_context(qa_files.pinned_tree(directory, scan=False))
        handles.enter_context(qa_files.pinned_tree(data))
        handles.enter_context(qa_files.pinned_tree(profile, create=not profile.exists()))
        binary_handle = qa_files.checked_handle(args.exe, win32con.GENERIC_READ, win32con.OPEN_EXISTING, share=1)
        handles.callback(binary_handle.Close)
        size = win32file.GetFileSize(binary_handle); require(0 < size <= 32*1024*1024, 'Invalid installed executable size')
        binary = win32file.ReadFile(binary_handle, size)[1]
        policy.verify_binary(binary, args.expected_sha256, args.release_isolation)
        require(json.loads(qa_files.read_text(run / 'profile.json')) == {'application':'app.hanni.mvp','purpose':'isolated-background-qa','exe_sha256':args.expected_sha256}, 'Wrong QA fixture identity')
        command_line = subprocess.list2cmdline(policy.launch_args(args.exe.resolve(), data.resolve(), 'foreground'))
        lock_fd = qa_files.writable_fd(run / 'active.lock')
        msvcrt.locking(lock_fd, msvcrt.LK_NBLCK, 1)
        cli = args.mcp_cli.resolve(strict=True)
        require(cli == (ROOT / '.local/d4ae-tools/node_modules/@playwright/mcp/cli.js').resolve(strict=True), 'Unexpected MCP CLI path')
        package = json.loads(qa_files.read_text(cli.parent / 'package.json', 32768))
        require(package.get('name') == '@playwright/mcp' and package.get('version') == '0.0.80', 'Official MCP package pin differs')
        node = shutil.which('node'); require(node, 'Node executable unavailable')
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1',0)); port = reservation.getsockname()[1]
        endpoint = 'http://127.0.0.1:' + str(port)
        require(not any(key.upper().startswith(('WEBVIEW2_','COREWEBVIEW2_')) for key in os.environ), 'Preexisting WebView environment overrides')
        env = dict(os.environ); env.pop('HANNI_MVP_DATA_DIR',None)
        env['WEBVIEW2_USER_DATA_FOLDER'] = str(profile.resolve())
        reject_foreign_matching_apps()
        job = win32job.CreateJobObject(None, 'D4AE-default-' + os.environ['GITHUB_RUN_ID'])
        limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
        limits['BasicLimitInformation']['LimitFlags'] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
        startup = win32process.STARTUPINFO(); startup.lpDesktop = station + '\\' + desktop
        process, thread, pid, tid = win32process.CreateProcess(str(args.exe.resolve()), command_line, None, None, False,
            win32con.CREATE_SUSPENDED | win32con.CREATE_UNICODE_ENVIRONMENT | win32con.CREATE_NO_WINDOW, env, str(args.exe.parent.resolve()), startup)
        try:
            win32job.AssignProcessToJobObject(job, process)
        except BaseException:
            win32api.TerminateProcess(process,1)
            raise
        manifest.update(pid=pid,thread_id=tid,endpoint=endpoint,argv=policy.launch_args(args.exe.resolve(),data.resolve(),'foreground'))
        manifest['identity_before_resume']=owned_process_identity(process,args.exe)
        reject_foreign_matching_apps(pid)
        policy_owner=OwnedWebviewPolicy(WindowsPolicyStore(),policy_arguments(port),EVIDENCE/POLICY_RECEIPT)
        handles.callback(policy_owner.cleanup)
        policy_owner.activate()
        write_json(run / 'runtime.json', manifest)
        win32process.ResumeThread(thread)
        app = psutil.Process(pid)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic() + 40; last_error = None
        while time.monotonic() < deadline:
            policy_owner.check();reject_foreign_matching_apps(pid)
            require(win32process.GetExitCodeProcess(process) == 259, 'Owned app exited before WebView readiness')
            descendants = app.children(recursive=True)
            webviews = {}
            for child in descendants:
                if child.name().casefold() != 'msedgewebview2.exe':
                    continue
                folder = profile_argument(child.cmdline())
                if folder:
                    require(profile_is_owned(folder, profile), 'Owned WebView uses an unapproved data folder')
                    webviews[child.pid] = str(Path(folder).resolve())
            listeners = [{'pid':c.pid,'ip':c.laddr.ip,'port':c.laddr.port} for c in psutil.net_connections(kind='tcp')
                         if c.status == psutil.CONN_LISTEN and c.laddr.port == port]
            if listeners:
                try:
                    validate_listener(listeners, webviews, port)
                except RuntimeError as error:
                    last_error = str(error)
                    time.sleep(0.15)
                    continue  # No HTTP request until listener/profile ownership is established.
                try:
                    with opener.open(endpoint + '/json/list',timeout=0.5) as response:
                        raw=response.read(32769); require(len(raw)<=32768,'Oversized target response'); targets=json.loads(raw)
                    page = unique_tauri_page(targets)
                    browser_arguments={row['pid']:psutil.Process(row['pid']).cmdline() for row in listeners}
                    require(all('--remote-debugging-port='+str(port) in arguments and '--remote-debugging-address=127.0.0.1' in arguments
                                for arguments in browser_arguments.values()), 'Owned listener process lacks the exact admitted CDP flags')
                    break
                except (OSError,ValueError,RuntimeError) as error:
                    last_error = str(error)
            time.sleep(0.15)
        else:
            raise RuntimeError('Default desktop WebView readiness failed: ' + (last_error or 'no owned WebView/CDP listener'))
        windows = []
        def owned_window(hwnd, _):
            if win32process.GetWindowThreadProcessId(hwnd)[1] == pid and win32gui.GetWindowText(hwnd) == 'Cicada [isolated test]':
                windows.append(hwnd)
            return True
        win32gui.EnumWindows(owned_window,None)
        require(len(windows)==1 and win32gui.IsWindowVisible(windows[0]), 'No unique visible owned isolated app window')
        manifest['identity_at_ready']=owned_process_identity(process,args.exe)
        policy_owner.check();reject_foreign_matching_apps(pid)
        manifest.update(state='ready',url=page['url'],targets=targets,app_windows=windows,owned_webview_profile_paths=sorted(set(webviews.values())),
                        webview_pids=sorted(webviews),listeners=listeners,browser_cdp_arguments=browser_arguments,mcp_package={'name':package['name'],'version':package['version']})
        write_json(run / 'runtime.json',manifest)
        output = EVIDENCE / 'official-mcp'; output.mkdir(exist_ok=True)
        mcp = subprocess.Popen([node,str(cli),'--cdp-endpoint',endpoint,'--output-dir',str(output),'--console-level','warning'],
            cwd=output,stdin=sys.stdin,stdout=sys.stdout,stderr=sys.stderr,creationflags=subprocess.CREATE_NO_WINDOW)
        win32job.AssignProcessToJobObject(job,int(mcp._handle))
        while mcp.poll() is None:
            policy_owner.check();reject_foreign_matching_apps(pid)
            time.sleep(0.15)
        policy_owner.check();reject_foreign_matching_apps(pid)
        code=mcp.wait()
        require(code==0,'Official MCP exited with failure')
        return code
    except BaseException as error:
        manifest['error']=str(error)
        raise
    finally:
        try:
            if job is not None:
                win32job.TerminateJobObject(job,0)
            if mcp is not None:
                if mcp.poll() is None:
                    mcp.terminate()
                mcp.wait(timeout=10)
            if process is not None:
                require(win32event.WaitForSingleObject(process,10000)==win32event.WAIT_OBJECT_0,'Owned app did not terminate')
                manifest['app_exit_code_after_cleanup']=win32process.GetExitCodeProcess(process)
            manifest['cleanup_verified']=True
        finally:
            for handle in (thread,process,job):
                if handle is not None:
                    handle.Close()
            manifest.update(state='stopped',input_desktop_after=input_desktop_name(),thread_desktop_after=current_thread_desktop())
            write_json(run / 'runtime.json',manifest)
            if lock_fd is not None:
                with contextlib.suppress(OSError):
                    os.lseek(lock_fd,0,os.SEEK_SET);msvcrt.locking(lock_fd,msvcrt.LK_UNLCK,1)
                os.close(lock_fd)
            handles.close()


def validate_mcp_tools(tools):
    matches=[tool for tool in tools if tool.get('name')==MCP_RUN_TOOL]
    require(len(matches)==1,'Pinned static-code MCP tool missing or duplicated')
    schema=matches[0].get('inputSchema',{})
    require(set(schema)<={'$schema','type','properties','additionalProperties','required'}
            and schema.get('$schema')=='https://json-schema.org/draft/2020-12/schema'
            and schema.get('type')=='object' and schema.get('additionalProperties') is False
            and schema.get('required',[])==[] and set(schema.get('properties',{}))=={'code','filename'},
            'Pinned MCP input schema differs')
    for field in ('code','filename'):
        value=schema['properties'][field]
        require(value.get('type')=='string' and set(value)<={'type','description'},'Pinned MCP string field differs')


async def check_mcp_tools(client,receipt):
    listed=(await client.list_tools()).model_dump(mode='json',by_alias=True)
    write_json(receipt,listed)  # Preserve actual registration/schema even when validation refuses it.
    require(not listed.get('nextCursor'),'Unexpected paginated MCP inventory')
    validate_mcp_tools(listed['tools'])


async def preflight_mcp_tools(cli):
    """Initialize/list only. Pinned coreBundle createServer lists schemas without factory.create/CDP."""
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    import select
    cli=cli.resolve(strict=True)
    require(cli==(ROOT/'.local/d4ae-tools/node_modules/@playwright/mcp/cli.js').resolve(strict=True),'Unexpected MCP CLI path')
    package=json.loads((cli.parent/'package.json').read_text(encoding='utf-8'))
    require((package.get('name'),package.get('version'))==('@playwright/mcp','0.0.80'),'Official MCP package pin differs')
    node=shutil.which('node');require(node,'Node executable unavailable')
    with socket.socket() as sentinel:
        sentinel.bind(('127.0.0.1',0));sentinel.listen(1)
        endpoint='http://127.0.0.1:'+str(sentinel.getsockname()[1])
        params=StdioServerParameters(command=node,args=[str(cli),'--cdp-endpoint',endpoint])
        async with stdio_client(params) as (read,write):
            async with ClientSession(read,write,read_timeout_seconds=datetime.timedelta(seconds=20)) as client:
                await client.initialize()
                await check_mcp_tools(client,EVIDENCE/'mcp080-prelaunch-tools.json')
        require(not select.select([sentinel],[],[],0)[0],'List-only preflight attempted a CDP connection')
    write_json(EVIDENCE/'mcp080-prelaunch-contract.json',{'package':'@playwright/mcp','version':'0.0.80',
        'methods':['initialize','tools/list'],'tool':MCP_RUN_TOOL,'cdp_connections':0,'application_launched':False,
        'policy_admitted':False,'runtime_acceptance':'UNKNOWN'})
    return 0


def static_runtime_call(data):
    require(data.resolve()==(ROOT/'.local/background-qa'/OPERATION/'data').resolve(),'Unexpected static scenario root')
    code=RUNTIME_CODE.replace('SHOTS',json.dumps(str((EVIDENCE/'official-mcp').resolve()))).replace('DATA',json.dumps(str(data.resolve())))
    return {'name':MCP_RUN_TOOL,'arguments':{'code':code}}  # Never pass filename or externally supplied JavaScript.


async def check_default_desktop(args):
    validate_host_context(sys.platform,os.environ)
    require(args.release_isolation,'Explicit --release-isolation is mandatory')
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    launcher = [sys.executable,'-B',str(Path(__file__).resolve()),'--serve-default-desktop','--exe',str(args.exe),
                '--expected-sha256',args.expected_sha256,'--mcp-cli',str(args.mcp_cli),'--data-root',str(args.data_root),'--release-isolation','--owned-app-policy']
    params = StdioServerParameters(command=launcher[0],args=launcher[1:],env={**os.environ,'PYTHONIOENCODING':'utf-8'})
    calls = [static_runtime_call(args.data_root)]
    require(args.calls.resolve()==(EVIDENCE/'runtime-calls.json').resolve()
            and json.loads(args.calls.read_text(encoding='utf-8'))==calls,'Only the exact trusted static scenario is admitted')
    async with stdio_client(params) as (read,write):
        async with ClientSession(read,write,read_timeout_seconds=datetime.timedelta(seconds=60)) as client:
            await client.initialize()
            await check_mcp_tools(client,EVIDENCE/'mcp080-runtime-tools.json')
            for index,call in enumerate(calls):
                result=await client.call_tool(call['name'],call.get('arguments',{}))
                stored=result.model_dump(mode='json')
                write_json(ROOT / '.local/background-qa' / OPERATION / ('runtime-calls-' + str(index) + '.json'),stored)
                require(not result.isError,'Actual installed MCP scenario failed')
                print(json.dumps(stored,ensure_ascii=False),flush=True)


def inspect_windows_manifest_and_token(exe):
    """Read RT_MANIFEST #1 as data, and query this process's token; no execution."""
    import ctypes
    from ctypes import wintypes as w
    import qa_files
    import win32con
    import win32file
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    def api(dll, name, result, *arguments):
        function = getattr(dll, name); function.restype = result; function.argtypes = arguments
        return function
    def checked(value):
        if not value:
            raise ctypes.WinError(ctypes.get_last_error())
        return value
    load = api(kernel, 'LoadLibraryExW', w.HMODULE, w.LPCWSTR, w.HANDLE, w.DWORD)
    free = api(kernel, 'FreeLibrary', w.BOOL, w.HMODULE)
    find = api(kernel, 'FindResourceW', w.HANDLE, w.HMODULE, ctypes.c_void_p, ctypes.c_void_p)
    size_of = api(kernel, 'SizeofResource', w.DWORD, w.HMODULE, w.HANDLE)
    load_resource = api(kernel, 'LoadResource', w.HANDLE, w.HMODULE, w.HANDLE)
    lock = api(kernel, 'LockResource', ctypes.c_void_p, w.HANDLE)
    with qa_files.pinned_tree(exe.parent, scan=False):
        binary_handle = qa_files.checked_handle(exe, win32con.GENERIC_READ, win32con.OPEN_EXISTING, share=1)
        try:
            binary_size = win32file.GetFileSize(binary_handle)
            require(0 < binary_size <= 32*1024*1024, 'Invalid installed executable size')
            require(hashlib.sha256(win32file.ReadFile(binary_handle,binary_size)[1]).hexdigest() == INSTALLED_EXE_SHA,
                    'Pinned resource executable differs')
            module = checked(load(str(exe), None, 0x2 | 0x20))  # DATAFILE | IMAGE_RESOURCE: no DLL entry points.
            try:
                resource = checked(find(module, 1, 24))  # Executable activation manifest.
                size = checked(size_of(module, resource)); require(size <= 65536, 'Oversized executable manifest')
                raw = ctypes.string_at(checked(lock(checked(load_resource(module, resource)))), size)
            finally:
                checked(free(module))
        finally:
            binary_handle.Close()
    get_process = api(kernel, 'GetCurrentProcess', w.HANDLE)
    open_token = api(advapi, 'OpenProcessToken', w.BOOL, w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE))
    info = api(advapi, 'GetTokenInformation', w.BOOL, w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD))
    close = api(kernel, 'CloseHandle', w.BOOL, w.HANDLE)
    token = w.HANDLE(); checked(open_token(get_process(), 0x8, ctypes.byref(token)))  # TOKEN_QUERY only.
    def query(kind):
        size = w.DWORD()
        info(token, kind, None, 0, ctypes.byref(size))
        require(0 < size.value <= 65536, 'Invalid token information size')
        buffer = ctypes.create_string_buffer(size.value)
        checked(info(token, kind, buffer, size, ctypes.byref(size)))
        return buffer
    try:
        label = query(25)  # TOKEN_MANDATORY_LABEL starts with SID_AND_ATTRIBUTES.
        sid = ctypes.cast(label, ctypes.POINTER(ctypes.c_void_p))[0]
        count = api(advapi, 'GetSidSubAuthorityCount', ctypes.POINTER(ctypes.c_ubyte), ctypes.c_void_p)(sid)
        checked(count); require(count[0] > 0, 'Empty integrity SID')
        rid_pointer = api(advapi, 'GetSidSubAuthority', ctypes.POINTER(w.DWORD), ctypes.c_void_p, w.DWORD)(sid, count[0]-1)
        checked(rid_pointer); rid = rid_pointer[0]
        elevation = ctypes.cast(query(20), ctypes.POINTER(w.DWORD))[0]
        elevation_type = ctypes.cast(query(18), ctypes.POINTER(w.DWORD))[0]
    finally:
        checked(close(token))
    return raw, {'pid':os.getpid(), 'TokenIntegrityLevel':rid, 'TokenElevation':elevation,
                 'TokenElevationType':elevation_type, 'scope':'current QA process only; no child token measured'}


def diagnostic_only_preflight(exe):
    validate_host_context(sys.platform, os.environ)
    require(exe.resolve() == (BASE / 'installed/hanni-mvp.exe').resolve() and digest(exe) == INSTALLED_EXE_SHA,
            'Diagnostic executable identity differs')
    raw, token = inspect_windows_manifest_and_token(exe)
    import xml.etree.ElementTree as ET
    document = ET.fromstring(raw)
    levels = [dict(node.attrib) for node in document.iter() if node.tag.rsplit('}',1)[-1] == 'requestedExecutionLevel']
    (EVIDENCE / 'installed-RT_MANIFEST-1.xml').write_bytes(raw)
    # These are prospective values only. No profile, marker, database, socket or process is created.
    profile = ROOT / '.local/background-qa' / OPERATION / 'data/webview2'
    write_json(EVIDENCE / 'startup-diagnostic-only.json', {
        'operation':OPERATION, 'source':SOURCE, 'build':BUILD, 'installed_exe_sha256':INSTALLED_EXE_SHA,
        'manifest':{'resource_type':24,'resource_id':1,'sha256':hashlib.sha256(raw).hexdigest(),'requestedExecutionLevel':levels},
        'launcher_token':token, 'intended_webview_values':{
            'WEBVIEW2_USER_DATA_FOLDER':str(profile.resolve()),
            'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':'--remote-debugging-port=<allocated-at-launch> --remote-debugging-address=127.0.0.1'},
        'environment_propagation':'NOT_MEASURED; prospective values only, no child launched',
        'application_launched':False, 'profile_created':False, 'runtime_assertions_executed':0,
        'runtime_acceptance':'UNKNOWN', 'cleanup':'resource module and TOKEN_QUERY handles closed; no application job created'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mcp-cli', type=Path, required=True)
    parser.add_argument('--serve-default-desktop',action='store_true')
    parser.add_argument('--check-default-desktop',action='store_true')
    parser.add_argument('--diagnostic-only',action='store_true',help='Inspect installed resources and current token; never launch the app')
    parser.add_argument('--mcp-contract-only',action='store_true',help='Initialize/list pinned tools only; no app, policy or tool call')
    parser.add_argument('--owned-app-policy',action='store_true',help='Use only owned exact HKLM executable-name CDP policy')
    parser.add_argument('--cleanup-owned-policy',action='store_true',help='Recover only a durably owned exact policy value; no app launch')
    parser.add_argument('--release-isolation',action='store_true')
    parser.add_argument('--exe',type=Path)
    parser.add_argument('--expected-sha256')
    parser.add_argument('--data-root',type=Path)
    parser.add_argument('--calls',type=Path)
    args = parser.parse_args()
    if args.mcp_contract_only:
        require(not any((args.diagnostic_only,args.owned_app_policy,args.cleanup_owned_policy,args.serve_default_desktop,args.check_default_desktop,
                         args.exe,args.calls,args.data_root)), 'MCP inventory cannot admit app/policy/scenarios')
        validate_host_context(sys.platform,os.environ)
        return asyncio.run(preflight_mcp_tools(args.mcp_cli))
    require(not (args.diagnostic_only and (args.owned_app_policy or args.cleanup_owned_policy)), 'Diagnostic mode cannot mutate policy')
    if args.cleanup_owned_policy:
        require(not (args.owned_app_policy or args.serve_default_desktop or args.check_default_desktop), 'Cleanup cannot launch')
        return cleanup_owned_policy()
    require(not (args.diagnostic_only and (args.serve_default_desktop or args.check_default_desktop)), 'Diagnostic mode cannot launch an application')
    if args.serve_default_desktop or args.check_default_desktop:
        require(args.owned_app_policy,'Environment-only launches are not admitted')
        require(not (args.serve_default_desktop and args.check_default_desktop),'Conflicting launcher roles')
        require(args.exe and args.expected_sha256 and args.data_root,'Incomplete explicit launcher identity')
        if args.serve_default_desktop:
            return serve_default_desktop(args)
        require(args.calls,'Missing actual runtime calls')
        return asyncio.run(check_default_desktop(args))
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    receipt = EVIDENCE / 'operation.json'
    require(not receipt.exists(), 'Operation already has a receipt; refusing duplicate execution')
    state = {'operation': OPERATION, 'task': 'd4ae9efb-deb7-4740-ba9a-b3ae2bbce05d', 'source': SOURCE, 'tree': TREE, 'build': BUILD,
             'qa_head': os.environ.get('GITHUB_SHA'), 'qa_run': os.environ.get('GITHUB_RUN_ID'), 'signing_run': SIGNING_RUN,
             'state': 'started', 'runtime_acceptance': 'UNKNOWN'}
    write_json(receipt, state)
    try:
        require(sys.platform == 'win32' and os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'Only disposable GitHub-hosted Windows is admitted')
        require(os.environ.get('GITHUB_REPOSITORY') == REPO and os.environ.get('GITHUB_REF') == 'refs/heads/work/d4ae-installed-qa-v1' and os.environ.get('GITHUB_EVENT_NAME') == 'push' and os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'Wrong operation trigger or duplicate attempt')
        require(args.mcp_cli.is_file(), 'Pinned official MCP CLI unavailable')
        require(args.diagnostic_only or args.owned_app_policy,'Explicit owned policy route required; no environment-only retry')
        command(['git','diff','--exit-code', SOURCE, '--', 'src', 'src-tauri', 'scripts/qa-launch-policy.py', 'scripts/qa-background.py', 'scripts/qa_files.py', 'scripts/task-workflow-native-qa.py', 'scripts/stage-updates.mjs'], 'unchanged-product-and-helpers')
        if not args.diagnostic_only:
            command([sys.executable,'-B',Path(__file__).resolve(),'--mcp-contract-only','--mcp-cli',args.mcp_cli.resolve()],
                    'mcp080-contract-preflight',timeout=30)
            preflight()
        wait_for_artifact()
        candidate = BASE / 'signed-candidate'; candidate.mkdir()
        download_artifact(candidate)
        manifest, descriptor = validate_candidate(candidate)
        command(['node','--input-type=module','-e',SIGNATURE_CHECK,candidate,ROOT], 'verify-production-signatures')
        write_json(EVIDENCE / 'verified-candidate.json', {'manifest':manifest,'signed_descriptor':descriptor})
        install = BASE / 'installed'; require(not install.exists(), 'Install prefix already exists')
        command([candidate / ASSET, '/S', '/D=' + str(install.resolve())], 'install-signed-runtime', timeout=180)
        exe = install / 'hanni-mvp.exe'; require(exe.is_file(), 'Signed installer did not install the expected executable')
        exe_hash = digest(exe)
        require(exe_hash == INSTALLED_EXE_SHA,'Installed executable differs from the admitted signed20 bytes')
        spec = importlib.util.spec_from_file_location('existing_qa_launch_policy', ROOT / 'scripts/qa-launch-policy.py')
        policy = importlib.util.module_from_spec(spec); spec.loader.exec_module(policy)
        policy.verify_binary(exe.read_bytes(), exe_hash, True)
        write_json(EVIDENCE / 'installed-binary.json', {'path':str(exe.resolve()),'sha256':exe_hash,'installer_sha256':manifest['sha256'],'source':SOURCE,'build':BUILD})
        if args.diagnostic_only:
            diagnostic_only_preflight(exe)
            state.update(state='diagnostic_only_completed', runtime_acceptance='UNKNOWN', installed_exe_sha256=exe_hash,
                         application_launched=False, runtime_assertions_executed=0)
            return 0
        run, data = seed_protected_fixture(exe_hash)
        calls = EVIDENCE / 'runtime-calls.json'; write_json(calls,[static_runtime_call(data)])
        command([sys.executable,'-B',Path(__file__).resolve(),'--check-default-desktop','--data-root',data.resolve(),'--exe',exe.resolve(),'--expected-sha256',exe_hash,
                 '--mcp-cli',args.mcp_cli.resolve(),'--calls',calls.resolve(),'--release-isolation','--owned-app-policy'], 'actual-installed-runtime', timeout=180)
        policy_receipt=json.loads((EVIDENCE/POLICY_RECEIPT).read_text(encoding='utf-8'))
        require(policy_receipt.get('state')=='removed' and policy_receipt.get('cleanup_verified') is True,'Policy cleanup unverified; no runtime acceptance')
        result = parse_runtime_result(json.loads((run / 'runtime-calls-0.json').read_text(encoding='utf-8')))
        write_json(EVIDENCE / 'runtime-assertions.json', result)
        runtime = json.loads((run / 'runtime.json').read_text(encoding='utf-8')); write_json(EVIDENCE / 'launcher-after.json', runtime)
        require(runtime.get('state') == 'stopped' and runtime.get('exe_sha256') == exe_hash, 'Launcher cleanup or binary identity failed')
        require(runtime.get('desktop_mode') == 'hosted-default' and runtime.get('station') == 'WinSta0' and runtime.get('thread_desktop') == 'Default'
                and runtime.get('input_desktop_before') == 'Default' and runtime.get('input_desktop_after') == 'Default'
                and runtime.get('cleanup_verified') is True,'Hosted Default desktop or owned cleanup verification failed')
        import psutil
        require(not psutil.pid_exists(runtime['pid']), 'Owned application process remains after QA')
        with sqlite3.connect((data / 'calendar.db').as_uri() + '?mode=ro', uri=True) as conn:
            require(conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Fixture integrity failed')
            write_json(EVIDENCE / 'fixture-after.json', {'items':conn.execute('SELECT id,title,version FROM items ORDER BY id').fetchall(),
                'links':conn.execute('SELECT source_type,source_id,goal_id FROM calendar_task_goals ORDER BY source_id').fetchall(),
                'blocks':conn.execute('SELECT source_type,source_id,is_active FROM timeline_blocks ORDER BY id').fetchall()})
        state.update(state='completed', runtime_acceptance='passed', installed_exe_sha256=exe_hash, assertions=result['assertionCount'])
    except BaseException as error:
        state.update(state='failed', error=str(error))
        raise
    finally:
        write_json(receipt, state)
        print(json.dumps(state), flush=True)


if __name__ == '__main__':
    sys.exit(main())
