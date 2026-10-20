"""Goal-only signed installed QA. Preparation is inert until exact signed21 admission."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ENTRY = Path(__file__).resolve()
OPERATION = 'd432-goal-installed-qa-20261020-v1'
TASK = 'd4324bc2-e6f2-45e6-bf83-987b8162431a'
BRANCH = 'work/goal-development-installed-qa-v1'
ROUTE_COMMIT = 'd22b18e3fa95cc7bd9dbad2214c5ca381705fd26'
ROUTE_SHA256 = '0e3a1a38161ec3f1d845f646a7d1b35fe4e7915c6d6bbcb74c6521a79250a032'
CORE_VERSION = '1.63.0-alpha-2026-08-31'
# Bind only after canonical signed21 artifacts exist and independent review admits
# their exact identities. No CLI/environment inputs can supply provenance or code.
ADMITTED = None
PACKAGE_OPERATION = 'd432-goal-package-inspection-20261020-v1'
PACKAGE_PINS = {
    'SOURCE': '1bbc37aa8d278df21ff2b4aaeb725d36f50470dd',
    'TREE': '6e622b87b5d410b6f190cb92700209636153d622',
    'SIGNING_RUN': 39376661024, 'CI_RUN': 39375988520,
    'ARTIFACT_ID': 12243986381, 'ARCHIVE_SIZE': 5512699,
    'ARCHIVE_SHA': 'c30bfc41ad57d9170f0c7b4896079cd9b07741056a075f7324ab13a5a167ca8b',
    'INSTALLER_SIZE': 5527124,
    'INSTALLER_SHA': '043a3aca22af01c6d91c2c715cf331ba89254be0f24aa93adac5e798f6e4431e',
    'DESCRIPTOR_SHA': '096bb98ae3d6d4f700e363597a23a42f297dab34ee5f0c6be625d1a57e51bdb3',
    'PREPARED_ID': '16588cfce68c61ed9cb039cc95e2c69f3aa7a6ebb27d86f7e02be012119c9182',
}
PIN_FIELDS = {'SOURCE', 'TREE', 'INSTALLED_EXE_SHA', 'SIGNING_RUN', 'CI_RUN',
              'ARTIFACT_ID', 'ARCHIVE_SIZE', 'ARCHIVE_SHA', 'INSTALLER_SIZE',
              'INSTALLER_SHA', 'DESCRIPTOR_SHA', 'PREPARED_ID'}


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def configure_utf8():
    # Also inherited by the frozen command/stdio launcher children. Reconfigure
    # existing streams: changing the environment alone cannot fix cp1252 stdout.
    os.environ.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='strict')


def validate_admission(pins):
    require(isinstance(pins, dict) and set(pins) == PIN_FIELDS,
            'Exact signed 0.5.21 provenance is not admitted; preparation only')
    for key in PIN_FIELDS:
        value = pins[key]
        if key in {'SIGNING_RUN', 'CI_RUN', 'ARTIFACT_ID', 'ARCHIVE_SIZE', 'INSTALLER_SIZE'}:
            require(type(value) is int and value > 0, 'Invalid admitted integer: ' + key)
        else:
            require(isinstance(value, str) and re.fullmatch('[0-9a-f]{' + ('40' if key in {'SOURCE', 'TREE'} else '64') + '}', value),
                    'Invalid admitted hash: ' + key)
    require(pins['SOURCE'] not in {'ba433551496cdba26fb27f34c2ca503bab8bf28a',
                                  'ad2f0fc24dfec9ec56d33673876ce4df0fc51657'},
            'Need canonical signed21 source, never signed20 or unversioned product PR')


def validate_host(platform, env, station=None, desktop=None):
    require(platform == 'win32' and env.get('GITHUB_ACTIONS') == 'true'
            and env.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'Only disposable hosted Windows')
    require(env.get('GITHUB_REPOSITORY') == 'sultanjakhan/Cicada'
            and env.get('GITHUB_REF') == 'refs/heads/' + BRANCH
            and env.get('GITHUB_EVENT_NAME') == 'push' and env.get('GITHUB_RUN_ATTEMPT') == '1',
            'Wrong goal QA trigger or repeated attempt')
    if station is not None or desktop is not None:
        require((station, desktop) == ('WinSta0', 'Default'), 'Wrong owned runner desktop')


def validate_package_pins(pins):
    require(isinstance(pins, dict) and set(pins) == PIN_FIELDS - {'INSTALLED_EXE_SHA'}
            and pins == PACKAGE_PINS, 'Only the exact signed21 package pins are admitted for metadata')


def load_route(package_only=False):
    if package_only:
        validate_package_pins(PACKAGE_PINS)
    folder = ROOT / '.local/goal-qa-route'
    script = folder / 'scripts/d4ae-installed-qa.py'
    require(not folder.is_symlink() and not script.is_symlink(), 'Linked frozen route refused')
    head = subprocess.check_output(['git', '-C', str(folder), 'rev-parse', 'HEAD'], text=True).strip()
    require(head == ROUTE_COMMIT and hashlib.sha256(script.read_bytes()).hexdigest() == ROUTE_SHA256,
            'Frozen safety route identity differs')
    spec = importlib.util.spec_from_file_location('goal_frozen_route', script)
    route = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(route)
    # This is an explicit entry adapter, not a product change or a copy of the
    # launcher. Its children must re-enter this goal script, not d4ae main().
    route.__file__ = str(ENTRY)
    route.ROOT, route.OPERATION = ROOT, PACKAGE_OPERATION if package_only else OPERATION
    route.BASE = ROOT / ('.local/goal-package-inspection' if package_only else '.local/goal-development-installed-qa')
    route.EVIDENCE = route.BASE / 'evidence'
    route.VERSION, route.BUILD = '0.5.21', '20261020-goal-progress-0521.1'
    route.ASSET = 'Cicada-0.5.21-windows-x86_64.exe'
    for key, value in (PACKAGE_PINS if package_only else ADMITTED).items():
        setattr(route, key, value)
    route.ARTIFACT = 'cicada-update-windows-' + route.SOURCE
    route.validate_host_context = validate_host
    route.RUNTIME_CODE = RUNTIME_CODE
    if package_only:
        # No dummy/inherited signed20 EXE hash and no app, fixture, MCP or policy
        # entry point in the metadata adapter. Full runtime still needs 13 pins.
        for name in ('INSTALLED_EXE_SHA', 'RUNTIME_CODE', 'main', 'serve_default_desktop',
                     'check_default_desktop', 'preflight', 'preflight_mcp_tools', 'static_runtime_call',
                     'seed_protected_fixture', 'OwnedWebviewPolicy', 'WindowsPolicyStore',
                     'cleanup_owned_policy', 'diagnostic_only_preflight', 'inspect_windows_manifest_and_token'):
            delattr(route, name)
    # qa_files is an unchanged helper in the reviewed source checkout. Other
    # policy, job, process, listener, origin, schema and finally cleanup code is
    # executed verbatim from the hash-pinned route.
    sys.path.insert(0, str(ROOT / 'scripts'))
    return route


def check_tooling(cli):
    expected = ROOT / '.local/d4ae-tools/node_modules/@playwright/mcp/cli.js'
    require(cli.resolve(strict=True) == expected.resolve(strict=True), 'Unexpected MCP CLI')
    modules = expected.parents[2]
    for path, name, version in ((expected.parent / 'package.json', '@playwright/mcp', '0.0.80'),
                                (modules / 'playwright-core/package.json', 'playwright-core', CORE_VERSION),
                                (modules / 'playwright/package.json', 'playwright', CORE_VERSION)):
        value = json.loads(path.read_text(encoding='utf-8'))
        require((value.get('name'), value.get('version')) == (name, version), 'Pinned tooling differs: ' + name)


def seed_empty_profile(route, exe_hash):
    run = ROOT / '.local/background-qa' / OPERATION
    require(not run.exists(), 'Same operation already has a profile; read receipt before recovery')
    data = run / 'data'
    data.mkdir(parents=True)
    route.write_json(run / 'profile.json', {'application': 'app.hanni.mvp', 'purpose': 'isolated-background-qa', 'exe_sha256': exe_hash})
    route.write_json(data / 'cicada-isolated-test.json', {'schemaVersion': 1, 'application': 'app.hanni.mvp', 'purpose': 'isolated-release-test'})
    require(not (data / 'calendar.db').exists(), 'Native app alone initializes fixture database')
    return run, data


def artifact_ready(route):
    # One observation, never wait/retry an unknown signing operation.
    for identifier, signing in ((route.CI_RUN, False), (route.SIGNING_RUN, True)):
        run = route.api('/actions/runs/' + str(identifier))
        route.validate_run(run, signing=signing)
        require((run.get('status'), run.get('conclusion')) == ('completed', 'success'), 'Pinned build not complete')
        route.write_json(route.EVIDENCE / ('signing-run.json' if signing else 'main-ci.json'), run)
    artifacts = route.api('/actions/runs/' + str(route.SIGNING_RUN) + '/artifacts?per_page=100')
    matches = [a for a in artifacts['artifacts'] if a.get('name') == route.ARTIFACT and not a.get('expired')]
    require(len(matches) == 1, 'No unique pinned artifact')
    artifact = matches[0]
    require((artifact.get('id'), artifact.get('size_in_bytes'), artifact.get('digest'),
             artifact.get('workflow_run', {}).get('id'), artifact.get('workflow_run', {}).get('head_sha')) ==
            (route.ARTIFACT_ID, route.ARCHIVE_SIZE, 'sha256:' + route.ARCHIVE_SHA, route.SIGNING_RUN, route.SOURCE),
            'Artifact provenance differs')
    route.write_json(route.EVIDENCE / 'artifact-provenance.json', artifact)


SIGNATURE_CHECK = r"""
import {readFile} from 'node:fs/promises'; import path from 'node:path'; import {pathToFileURL} from 'node:url';
const [directory,root]=process.argv.slice(1);
const {verifyTauriSignature}=await import(pathToFileURL(path.join(root,'scripts/stage-updates.mjs')));
const key=await readFile(path.join(root,'src-tauri/update-public-key.txt'),'utf8');
for(const name of ['Cicada-0.5.21-windows-x86_64.exe','Cicada-0.5.21-windows-x86_64.exe.identity.json'])
 verifyTauriSignature(await readFile(path.join(directory,name)),await readFile(path.join(directory,name+'.sig'),'utf8'),key);
"""


RUNTIME_CODE = r"""async (page) => {
  const assertions=[],receipts=[],ratios=[];
  const check=(ok,label)=>{if(!ok)throw Error(label);assertions.push(label);};
  try {
    const call=async(name,args={})=>{
      const result=await page.evaluate(async({name,args})=>{try{return {ok:true,value:await window.__TAURI__.core.invoke(name,args)}}catch(e){return {ok:false,error:String(e)}}},{name,args});
      receipts.push({name,args,result});return result;
    };
    const rpc=async(name,args={})=>{const r=await call(name,args);if(!r.ok)throw Error(name+': '+r.error);return r.value;};
    await page.waitForFunction(()=>!!window.__TAURI__?.core?.invoke);
    const isolation=await rpc('isolated_test_status');
    check(isolation.isolated===true&&isolation.integrationsEnabled===false,'native isolation');
    check(isolation.root.replace(/\\/g,'/').toLowerCase()===DATA.replace(/\\/g,'/').toLowerCase(),'exact root');
    const sync=await call('mvp_sync_now');check(!sync.ok&&sync.error.includes('isolated_test_integration_disabled'),'sync denied');
    check((await rpc('get_goals',{tabName:null})).length===0,'empty owned goals');
    check((await rpc('get_calendar_tasks',{includeCompleted:true})).length===0,'empty owned tasks');
    const initialNow=JSON.parse((await rpc('get_ui_state',{key:'calendar_now_v1'}))||'null');
    check(initialNow?.goalId==null,'initial goal unselected');
    const goal=async(title,numeric)=>rpc('save_calendar_goal',{id:null,title,targetValue:numeric?10:1,unit:numeric?'pages':'',deadline:null,goalKind:'goal',description:'Synthetic goal-only QA',criteria:'Explicit human decision',parentGoalId:null,clearParent:false,currentValue:numeric?3:null,numericProgress:numeric,expectedGoal:null});
    const g=await goal('D432 Goal Прогресс',true),empty=await goal('D432 Empty',false);
    const task=async title=>rpc('save_calendar_task',{id:null,title,dueDate:null,estimateMinutes:15,goalId:g,expectedVersion:null,important:false,time:null,taskKind:'normal',sphere:null,stage:null,waiting:false,process:null});
    const done=await task('D432 completed action'),open=await task('D432 next action');
    check(done!==open&&typeof done==='string'&&typeof open==='string','distinct native task IDs');
    await rpc('complete_calendar_task',{id:done});
    const key='calendar_development_v1',prior=await rpc('get_ui_state',{key});
    const dev=prior?JSON.parse(prior):{version:1,goals:{}};
    const missing='00000000-0000-4000-8000-00000000d432';
    dev.goals[g]={...dev.goals[g],skills:[{id:'current',title:'Current skill',topic:'QA',group:'hard',level:1,evidence:'',taskIds:[done,open,missing,done]},
      {id:'outside',title:'Off-stage confirmed skill',topic:'QA',group:'soft',level:1,evidence:'Synthetic confirmed evidence',taskIds:['00000000-0000-4000-8000-00000000d433']}],
      stages:[{id:'current-stage',title:'D432 Current stage',skillIds:['current'],focusId:'current',status:'active',outcome:'Synthetic outcome',deadline:''}],activeStageId:'current-stage',focusId:'current'};
    await rpc('set_ui_state',{key,value:JSON.stringify(dev),expectedValue:prior??''});
    const mapping=await rpc('get_ui_state',{key});
    check(JSON.parse(mapping).goals[g].skills[0].taskIds.length===4,'saved duplicate mapping retained');
    const catalog=async()=>{
      await page.reload();
      await page.locator('.uni-tab[data-pane="goals"]').click();
      await page.locator('.calendar-goals [data-list]:not([aria-busy])').waitFor({state:'visible'});
    };
    const row=()=>page.locator(`[data-goal-id="${g}"]`);
    const projection=async(doneCount,total,unknown)=>{
      const meta=await row().locator('.cp-goal-row__meta').innerText();
      check(meta.includes('Этап: D432 Current stage')&&meta.includes('3 из 10 pages'),'stage and numeric preserved');
      const label=`Действия этапа: выполнено ${doneCount} из ${total}`+(unknown?` · Статус неизвестен: ${unknown}`:'');
      check(meta.includes(label),'visible action ratio '+doneCount+'/'+total+' unknown '+unknown);
      check(!unknown||!meta.includes('%'),'unknown action percentage not invented');
      check(await row().locator('[role="progressbar"]').count()===0,'catalog has no fabricated action bar');
      // Observable count ratio, not access to a hidden product helper/property.
      const match=meta.match(/Действия этапа: выполнено (\d+) из (\d+)(?: · Статус неизвестен: (\d+))?/);
      ratios.push({done:Number(match[1]),total:Number(match[2]),unknown:Number(match[3]||0),
        observedCountPercent:match[3]?null:Math.round(Number(match[1])/Number(match[2])*100)});
    };
    await catalog();await projection(1,3,1);
    check((await rpc('get_ui_state',{key}))===mapping,'mapping survives reload');
    check((await page.locator(`[data-goal-id="${empty}"]`).innerText()).includes('Связанных действий пока нет'),'honest no-links empty');
    await row().locator('[data-goal-open]').click();
    const popup=page.locator('dialog.calendar-goal-popup[open]');
    await popup.locator('[data-goal-overview][aria-busy="false"]').waitFor({state:'visible'});
    check(await popup.locator('[role="progressbar"]').getAttribute('aria-valuenow')==='30','numeric progress is 30 percent');
    await popup.locator('[data-dev-task-link="'+open+'"]').waitFor({state:'visible'});
    check((await popup.locator('.dev-stage').innerText()).includes('Навыки: 0 из 1 подтверждено'),'action done does not confirm current skill');
    check((await popup.locator('.dev-total-progress').innerText()).includes('50%'),'separate whole-goal skill evidence preserved');
    const next=await rpc('get_calendar_task',{id:open});
    check(next.id===open&&next.goal_id===g&&!next.completed,'next source is actual open linked task');
    await popup.locator('[data-dev-task-link="'+open+'"]').click();
    await page.locator('dialog.calendar-task-details[open]').getByRole('heading',{name:next.title,exact:true}).waitFor({state:'visible'});
    check(await page.locator('dialog.calendar-task-details[open] h2').innerText()===next.title,'existing next-step opens same native source');
    check((await rpc('get_calendar_task',{id:open})).completed===false,'opening does not complete task');
    await page.screenshot({path:SHOTS+'/01-linked-next-step.png'});
    await page.locator('dialog.calendar-task-details[open] [data-dialog-close]').first().click();
    await page.locator('dialog.calendar-task-details[open]').waitFor({state:'detached'});
    const raw=await rpc('get_ui_state',{key}),resolved=JSON.parse(raw);
    resolved.goals[g].skills[0].taskIds=[done,open,done];
    await rpc('set_ui_state',{key,value:JSON.stringify(resolved),expectedValue:raw});
    await catalog();await projection(1,2,0);
    check(ratios.at(-1).observedCountPercent===50,'resolved visible count ratio is 50 percent');
    await page.screenshot({path:SHOTS+'/02-resolved-progress.png'});
    await rpc('complete_calendar_task',{id:open});
    await catalog();await projection(2,2,0);
    const finalDev=JSON.parse(await rpc('get_ui_state',{key})).goals[g];
    const finalGoal=(await rpc('get_goals',{tabName:null})).find(row=>row.id===g);
    check(finalGoal.status==='active'&&finalGoal.current_value===3&&finalGoal.target_value===10,'no goal achievement or numeric mutation');
    check(finalDev.activeStageId==='current-stage'&&finalDev.stages[0].status==='active','no automatic stage choice or completion');
    check(finalDev.skills[0].evidence===''&&finalDev.skills[1].evidence==='Synthetic confirmed evidence','no skill autoacceptance');
    check((await rpc('get_calendar_tasks',{includeCompleted:true})).length===2,'no duplicate tasks');
    check(JSON.parse((await rpc('get_ui_state',{key:'calendar_now_v1'}))||'null')?.goalId==null,'no implicit main-goal selection');
    check((await rpc('get_active_block'))===null,'no human timer started');
    await page.screenshot({path:SHOTS+'/03-completed-actions.png'});
    return {goalOutcome:'passed',assertionCount:assertions.length,assertions,receipts,ratios};
  } catch(error) {
    try {await page.screenshot({path:SHOTS+'/failure.png'});} catch(shotError) {receipts.push({screenshotError:String(shotError)});}
    return {goalOutcome:'failed',error:String(error),assertions,receipts,ratios};
  }
}"""


def parse_result(stored):
    results = []
    for part in stored.get('content', []):
        if part.get('type') != 'text':
            continue
        for heading in re.finditer(r'(?m)^#{1,3} Result\n', part.get('text', '')):
            try:
                result, _ = json.JSONDecoder().raw_decode(part['text'][heading.end():].lstrip())
                if isinstance(result, str):
                    result = json.loads(result)
                results.append(result)
            except (ValueError, TypeError):
                pass
    require(not stored.get('isError') and len(results) == 1, 'Ambiguous or failed MCP result')
    result = results[0]
    require(isinstance(result, dict) and result.get('goalOutcome') == 'passed'
            and type(result.get('assertionCount')) is int and result['assertionCount'] >= 35
            and result['assertionCount'] == len(result.get('assertions', [])), 'Incomplete goal runtime result')
    require(result.get('ratios') == [
        {'done': 1, 'total': 3, 'unknown': 1, 'observedCountPercent': None},
        {'done': 1, 'total': 2, 'unknown': 0, 'observedCountPercent': 50},
        {'done': 2, 'total': 2, 'unknown': 0, 'observedCountPercent': 100}], 'Missing observed goal ratio transitions')
    return result


def no_package_app():
    import psutil
    for process in psutil.process_iter(['name']):
        name = process.info['name']
        require(name is not None, 'Cannot inspect hosted process name')
        require(name.casefold() not in {'hanni-mvp.exe', 'cicada.exe'}, 'Unexpected app process; metadata cannot proceed')


def installer_source_proof():
    # Exact canonical NSIS source: /S skips the GUI finish/run page, while
    # .onInstSuccess invokes the app only when /R is present. We never pass /R.
    hashes = {'src-tauri/windows/installer.nsi': '7e927ef20ddeea18fe47252d0b5139fda12046b39282f701b3ddb647009810f3',
              'src-tauri/windows/update-hooks.nsh': '5b6907143ca16e493cb75e206a94a4d9b16937a031c06314d63b93a32ab4801a'}
    for path, expected in hashes.items():
        require(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected, 'Unreviewed installer launch behavior')
    return {'source_sha256': hashes, 'silent': '/S; finish page skipped', 'restart_flag': 'ABSENT; /R required by .onInstSuccess'}


def installed_metadata(exe):
    # Win32 version-resource API reads PE data, never CreateProcess/LoadLibrary.
    import qa_files
    import win32api
    import win32con
    import win32file
    with qa_files.pinned_tree(exe.parent):
        handle = qa_files.checked_handle(exe, win32con.GENERIC_READ, win32con.OPEN_EXISTING, share=1)
        try:
            size = win32file.GetFileSize(handle)
            require(0 < size <= 32 * 1024 * 1024, 'Invalid unpacked executable size')
            raw = win32file.ReadFile(handle, size)[1]
            require(len(raw) == size and raw[:2] == b'MZ', 'Incomplete or invalid PE data read')
            digest = hashlib.sha256(raw).hexdigest()
            info = win32api.GetFileVersionInfo(str(exe), '\\')
        finally:
            handle.Close()
    version = [info['FileVersionMS'] >> 16, info['FileVersionMS'] & 65535,
               info['FileVersionLS'] >> 16, info['FileVersionLS'] & 65535]
    require(version[:3] == [0, 5, 21], 'Unpacked executable version differs from signed21')
    return {'sha256': digest, 'size': size, 'file_version': version, 'access': 'read-only PE data; not executed'}


def package_audit(route):
    # Read-only cleanup proof: this phase has no policy/browser/fixture entry.
    no_package_app()
    require(not (ROOT / '.local/background-qa' / OPERATION).exists(), 'Unexpected app fixture exists')
    require(not (route.EVIDENCE / route.POLICY_RECEIPT).exists(), 'Unexpected policy ownership receipt')
    require(not (ROOT / '.local/goal-development-installed-qa/evidence/owned-webview-policy.json').exists(), 'Unexpected runtime policy receipt')
    proof = {'operation': PACKAGE_OPERATION, 'run': os.environ.get('GITHUB_RUN_ID'), 'head': os.environ.get('GITHUB_SHA'),
             'matching_app_processes': 0, 'app_profile_created': False, 'policy_entry_available': False,
             'app_launched_by_phase': False, 'runtime_acceptance': 'NOT_RUN'}
    route.write_json(route.EVIDENCE / 'cleanup-proof.json', proof)
    return proof


def inspect_package(route):
    require(route.BASE == ROOT / '.local/goal-package-inspection', 'Wrong fixed package inspection root')
    route.EVIDENCE.mkdir(parents=True, exist_ok=True)
    receipt = route.EVIDENCE / 'operation.json'
    require(not receipt.exists(), 'Package operation has a receipt; no duplicate attempt')
    state = {'operation': PACKAGE_OPERATION, 'task': TASK, 'source': route.SOURCE, 'tree': route.TREE,
             'run': os.environ.get('GITHUB_RUN_ID'), 'head': os.environ.get('GITHUB_SHA'),
             'state': 'started', 'runtime_acceptance': 'NOT_RUN'}
    route.write_json(receipt, state)
    try:
        route.command(['git', 'diff', '--exit-code', route.SOURCE, '--', 'src', 'src-tauri', 'scripts/qa_files.py',
                       'scripts/stage-updates.mjs'], 'canonical-package-source')
        state['no_autolaunch_source_proof'] = installer_source_proof()
        no_package_app()
        # Match the installer's actual WebView2 lookup: require it is already
        # installed so normal NSIS does not download/install a browser runtime.
        import winreg
        versions = []
        key = r'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, key, 0, winreg.KEY_READ | winreg.KEY_WOW64_32KEY) as opened:
                    value = winreg.QueryValueEx(opened, 'pv')[0]
                    if value:
                        versions.append(value)
            except FileNotFoundError:
                pass
        require(versions, 'Existing WebView2 absent; no browser installation fallback')
        state['preexisting_webview_versions'] = versions
        artifact_ready(route)
        candidate = route.BASE / 'signed-candidate'; candidate.mkdir()
        route.download_artifact(candidate)
        manifest, descriptor = route.validate_candidate(candidate)
        route.command(['node', '--input-type=module', '-e', SIGNATURE_CHECK, candidate, ROOT], 'verify-production-signatures')
        route.write_json(route.EVIDENCE / 'verified-candidate.json', {'manifest': manifest, 'descriptor': descriptor})
        install = route.BASE / 'installed'
        require(not install.exists(), 'Package inspection prefix already exists')
        no_package_app()
        import qa_files
        with qa_files.pinned_tree(install, create=True):
            route.command([candidate / route.ASSET, '/S', '/D=' + str(install.resolve())], 'inspect-package-install')
            no_package_app()
            metadata = installed_metadata(install / 'hanni-mvp.exe')
        state.update(state='metadata_observed', installed_exe=metadata)
    except BaseException as error:
        state.update(state='failed', error=str(error))
        raise
    finally:
        route.write_json(receipt, state)
        package_audit(route)  # Also repeated by workflow always(), never a launch.
        print(json.dumps(state, ensure_ascii=False), flush=True)


def run_installed(route, args):
    route.EVIDENCE.mkdir(parents=True, exist_ok=True)
    receipt = route.EVIDENCE / 'operation.json'
    require(not receipt.exists(), 'Same operation has a receipt; read it before recovery')
    state = {'operation': OPERATION, 'task': TASK, 'state': 'started', 'runtime_acceptance': 'UNKNOWN',
             'source': route.SOURCE, 'tree': route.TREE, 'build': route.BUILD}
    route.write_json(receipt, state)
    try:
        route.command(['git', 'diff', '--exit-code', route.SOURCE, '--', 'src', 'src-tauri',
                       'scripts/qa-launch-policy.py', 'scripts/qa-background.py', 'scripts/qa_files.py',
                       'scripts/task-workflow-native-qa.py', 'scripts/stage-updates.mjs'], 'unchanged-product-and-helpers')
        route.command([sys.executable, '-X', 'utf8', '-B', ENTRY, '--mcp-contract-only', '--mcp-cli', args.mcp_cli], 'mcp080-contract-preflight', timeout=30)
        route.preflight()
        artifact_ready(route)
        candidate = route.BASE / 'signed-candidate'; candidate.mkdir()
        route.download_artifact(candidate)
        manifest, descriptor = route.validate_candidate(candidate)
        route.command(['node', '--input-type=module', '-e', SIGNATURE_CHECK, candidate, ROOT], 'verify-production-signatures')
        route.write_json(route.EVIDENCE / 'verified-candidate.json', {'manifest': manifest, 'descriptor': descriptor})
        install = route.BASE / 'installed'; require(not install.exists(), 'Install prefix exists')
        route.command([candidate / route.ASSET, '/S', '/D=' + str(install.resolve())], 'install-signed-runtime')
        exe = install / 'hanni-mvp.exe'
        require(route.digest(exe) == route.INSTALLED_EXE_SHA, 'Installed binary differs')
        run, data = seed_empty_profile(route, route.INSTALLED_EXE_SHA)
        calls = route.EVIDENCE / 'runtime-calls.json'
        route.write_json(calls, [route.static_runtime_call(data)])
        route.command([sys.executable, '-X', 'utf8', '-B', ENTRY, '--check-default-desktop', '--data-root', data.resolve(),
                       '--exe', exe.resolve(), '--expected-sha256', route.INSTALLED_EXE_SHA, '--mcp-cli', args.mcp_cli,
                       '--calls', calls, '--release-isolation', '--owned-app-policy'], 'actual-installed-runtime', timeout=180)
        result = parse_result(json.loads((run / 'runtime-calls-0.json').read_text(encoding='utf-8')))
        route.write_json(route.EVIDENCE / 'runtime-assertions.json', result)
        policy = json.loads((route.EVIDENCE / route.POLICY_RECEIPT).read_text(encoding='utf-8'))
        require(policy.get('state') == 'removed' and policy.get('cleanup_verified') is True, 'Policy cleanup unverified')
        runtime = json.loads((run / 'runtime.json').read_text(encoding='utf-8'))
        require(runtime.get('state') == 'stopped' and runtime.get('exe_sha256') == route.INSTALLED_EXE_SHA
                and runtime.get('cleanup_verified') is True and runtime.get('desktop_mode') == 'hosted-default'
                and runtime.get('station') == 'WinSta0' and runtime.get('thread_desktop') == 'Default'
                and runtime.get('input_desktop_before') == 'Default' and runtime.get('input_desktop_after') == 'Default',
                'Owned launcher cleanup unverified')
        import psutil
        require(not psutil.pid_exists(runtime['pid']), 'Owned app remains')
        state.update(state='scenario_verified', runtime_acceptance='pending_independent_review', assertions=result['assertionCount'])
    except BaseException as error:
        state.update(state='failed', error=str(error))
        raise
    finally:
        route.write_json(receipt, state)  # Durable evidence precedes all stdout.
        print(json.dumps(state, ensure_ascii=False), flush=True)


def main():
    configure_utf8()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mcp-cli', type=Path)
    roles = parser.add_mutually_exclusive_group()
    for role in ('mcp-contract-only', 'serve-default-desktop', 'check-default-desktop', 'cleanup-owned-policy',
                 'package-inspection-only', 'package-inspection-audit'):
        roles.add_argument('--' + role, action='store_true')
    parser.add_argument('--owned-app-policy', action='store_true')
    parser.add_argument('--release-isolation', action='store_true')
    parser.add_argument('--exe', type=Path)
    parser.add_argument('--expected-sha256')
    parser.add_argument('--data-root', type=Path)
    parser.add_argument('--calls', type=Path)
    args = parser.parse_args()
    if args.package_inspection_only or args.package_inspection_audit:
        require(not any((args.mcp_cli, args.owned_app_policy, args.release_isolation, args.exe,
                         args.expected_sha256, args.data_root, args.calls)), 'Metadata phase cannot admit app/runtime arguments')
        validate_host(sys.platform, os.environ)
        route = load_route(package_only=True)
        if args.package_inspection_audit:
            route.EVIDENCE.mkdir(parents=True, exist_ok=True)
            package_audit(route)
            return 0
        inspect_package(route)
        return 0
    if args.cleanup_owned_policy or args.mcp_contract_only:
        require(not any((args.owned_app_policy, args.release_isolation, args.exe, args.expected_sha256, args.data_root, args.calls)),
                'Cleanup/inventory cannot launch or supply calls')
    if args.cleanup_owned_policy and ADMITTED is None:
        require(not (ROOT / '.local/goal-development-installed-qa/evidence/owned-webview-policy.json').exists(),
                'Unbound policy receipt requires supported reconciliation')
        return 0  # Preparation has never created policy or application process.
    validate_admission(ADMITTED)
    validate_host(sys.platform, os.environ)
    route = load_route()
    if args.cleanup_owned_policy:
        return route.cleanup_owned_policy()
    require(args.mcp_cli, 'Runtime requires the exact MCP CLI')
    check_tooling(args.mcp_cli)
    if args.mcp_contract_only:
        return route.asyncio.run(route.preflight_mcp_tools(args.mcp_cli))
    if args.serve_default_desktop or args.check_default_desktop:
        require(args.owned_app_policy and args.release_isolation and args.exe and args.expected_sha256 and args.data_root, 'Incomplete owned launch')
        if args.serve_default_desktop:
            require(args.calls is None, 'Server cannot supply scenario')
            return route.serve_default_desktop(args)
        require(args.calls, 'Missing static calls')
        return route.asyncio.run(route.check_default_desktop(args))
    require(args.owned_app_policy and not any((args.exe, args.expected_sha256, args.data_root, args.calls)), 'Only fixed owned scenario allowed')
    run_installed(route, args)
    return 0


if __name__ == '__main__':
    sys.exit(main())
