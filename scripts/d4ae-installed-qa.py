"""One exact signed Windows release in a disposable hosted fixture; no product writes."""
import argparse
import datetime
import hashlib
import importlib.util
import importlib.metadata
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
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


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


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


def command(args, name, timeout=180, credentials=False):
    env = dict(os.environ)
    if not credentials:
        for key in list(env):
            if any(part in key.upper() for part in ('TOKEN', 'SECRET', 'PASSWORD', 'PRIVATE_KEY')):
                env.pop(key)
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    write_json(EVIDENCE / (name + '.json'), {'argv':[str(a) for a in args], 'started':started, 'state':'started', 'exit':None})
    result = subprocess.run([str(arg) for arg in args], cwd=ROOT, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
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
  const assertions=[], receipts=[];
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
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('hanni:calendar-refresh')));
    await page.locator('.uni-tab[data-pane="table"]').click();
    await page.locator('[data-period="day"]').click();
    await page.locator('[data-today]').first().click();
    const row=page.locator(`[data-record-source="event:${id}"]`).first();
    await row.locator('[data-record-menu]').click();
    await page.locator('[data-menu-action="edit"]').click();
    await page.locator('#evm-title').waitFor();
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
  return {d4aeOutcome:'passed',assertionCount:assertions.length,assertions,receipts,status};
  } catch(error) {
    await page.screenshot({path:SHOTS+'/failure.png'}).catch(()=>{});
    return {d4aeOutcome:'failed',error:String(error),assertions,receipts};
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mcp-cli', type=Path, required=True)
    args = parser.parse_args()
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
        command(['git','diff','--exit-code', SOURCE, '--', 'src', 'src-tauri', 'scripts/qa-launch-policy.py', 'scripts/qa-background.py', 'scripts/qa_files.py', 'scripts/task-workflow-native-qa.py', 'scripts/stage-updates.mjs'], 'unchanged-product-and-helpers')
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
        spec = importlib.util.spec_from_file_location('existing_qa_launch_policy', ROOT / 'scripts/qa-launch-policy.py')
        policy = importlib.util.module_from_spec(spec); spec.loader.exec_module(policy)
        policy.verify_binary(exe.read_bytes(), exe_hash, True)
        write_json(EVIDENCE / 'installed-binary.json', {'path':str(exe.resolve()),'sha256':exe_hash,'installer_sha256':manifest['sha256'],'source':SOURCE,'build':BUILD})
        run, data = seed_protected_fixture(exe_hash)
        code = RUNTIME_CODE.replace('SHOTS', json.dumps(str(EVIDENCE.resolve()))).replace('DATA', json.dumps(str(data.resolve())))
        calls = EVIDENCE / 'runtime-calls.json'; write_json(calls,[{'name':'browser_run_code','arguments':{'code':code}}])
        command([sys.executable,'-B',ROOT / 'scripts/task-workflow-native-qa.py','--exe',exe.resolve(),'--expected-sha256',exe_hash,
                 '--mcp-cli',args.mcp_cli.resolve(),'--session',OPERATION,'--calls',calls.resolve(),'--release-isolation'], 'actual-installed-runtime', timeout=180)
        result = parse_runtime_result(json.loads((run / 'runtime-calls-0.json').read_text(encoding='utf-8')))
        write_json(EVIDENCE / 'runtime-assertions.json', result)
        runtime = json.loads((run / 'runtime.json').read_text(encoding='utf-8')); write_json(EVIDENCE / 'launcher-after.json', runtime)
        require(runtime.get('state') == 'stopped' and runtime.get('exe_sha256') == exe_hash, 'Launcher cleanup or binary identity failed')
        observation = runtime.get('background_observation', {})
        require(observation.get('samples',0) > 0 and observation.get('qa_desktop_ever_active') is False and observation.get('read_errors') == 0, 'Inactive-desktop observation failed')
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
    main()
