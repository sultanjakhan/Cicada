"""Routine-count signed installed QA. Inert until exact signed22 admission and review."""
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
OPERATION = 'a085-routine-count-installed-qa-20261020-v1'
TASK = 'a085ee71-ba39-4771-b75c-2d073ca285c6'
BRANCH = 'work/routine-count-installed-qa-v1'
ROUTE_COMMIT = 'd22b18e3fa95cc7bd9dbad2214c5ca381705fd26'
ROUTE_SHA256 = '0e3a1a38161ec3f1d845f646a7d1b35fe4e7915c6d6bbcb74c6521a79250a032'
CORE_VERSION = '1.63.0-alpha-2026-08-31'
# Canonical signed package pins are bound for metadata review only. The installed
# EXE hash remains unknown; no environment/CLI provenance or runtime is admitted.
PRODUCT_SOURCE = 'd06cd424fe0e10a17167dc72b87b0838042fa993'
PRODUCT_CI_RUN = 39385405935
PRODUCT_SIGNING_RUN = 39386361388
PACKAGE_OPERATION = 'a085-routine-count-package-inspection-20261020-v1'
PACKAGE_PINS = {
    'SOURCE': 'd06cd424fe0e10a17167dc72b87b0838042fa993',
    'TREE': '577278912e0e325f6260e682758eacca1892ea64',
    'SIGNING_RUN': 39386361388, 'CI_RUN': 39385405935,
    'ARTIFACT_ID': 12247194527, 'ARCHIVE_SIZE': 5518825,
    'ARCHIVE_SHA': '19a245771499df9874415b50fb73931322f1ae71eff9c95d56c41412ac34359f',
    'INSTALLER_SIZE': 5533239,
    'INSTALLER_SHA': 'dbb39bde177d4505d66699736b15cc13f48fbe555b0320e123156b55105fa7e2',
    'DESCRIPTOR_SHA': 'c4157654e517395f1503c46d479b1126673187a3ea114efbac96abb8e175503b',
    'PREPARED_ID': '77a4c21fb20ff493c5086e1b98505c65cb42d4ccf1d81da79ea69afbf15ce2b1',
}
PRODUCT_IDENTITY = '82703143d90640cc27a317c2507b5bd6bdd6098e'
PRODUCT_TREE = '577278912e0e325f6260e682758eacca1892ea64'
# Installed PE data observed by metadata run39387912132/artifact12247948124;
# ZIP8670 bytes SHA256 eff0fe1b2dc663823bd423f1598ee7cd925dc0aebcfae4d213d495511904e0f3.
ADMITTED = {**PACKAGE_PINS,
            'INSTALLED_EXE_SHA': '0835a7d05d58a4ccbdc9aa560382940ecded689607f59346261c7b786001d09a'}
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
            'Exact signed 0.5.22 provenance is not admitted; preparation only')
    validate_provenance(pins, PIN_FIELDS)


def validate_provenance(pins, fields):
    for key in fields:
        value = pins[key]
        if key in {'SIGNING_RUN', 'CI_RUN', 'ARTIFACT_ID', 'ARCHIVE_SIZE', 'INSTALLER_SIZE'}:
            require(type(value) is int and value > 0, 'Invalid admitted integer: ' + key)
        else:
            require(isinstance(value, str) and re.fullmatch('[0-9a-f]{' + ('40' if key in {'SOURCE', 'TREE'} else '64') + '}', value),
                    'Invalid admitted hash: ' + key)
    require((pins['SOURCE'], pins['TREE'], pins['CI_RUN'], pins['SIGNING_RUN']) ==
            (PRODUCT_SOURCE, PRODUCT_TREE, PRODUCT_CI_RUN, PRODUCT_SIGNING_RUN),
            'Need exact canonical signed22 source/tree/CI')


def validate_host(platform, env, station=None, desktop=None):
    require(platform == 'win32' and env.get('GITHUB_ACTIONS') == 'true'
            and env.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'Only disposable hosted Windows')
    require(env.get('GITHUB_REPOSITORY') == 'sultanjakhan/Cicada'
            and env.get('GITHUB_REF') == 'refs/heads/' + BRANCH
            and env.get('GITHUB_EVENT_NAME') == 'push' and env.get('GITHUB_RUN_ATTEMPT') == '1',
            'Wrong routine QA trigger or repeated attempt')
    if station is not None or desktop is not None:
        require((station, desktop) == ('WinSta0', 'Default'), 'Wrong owned runner desktop')


def validate_package_pins(pins):
    require(isinstance(pins, dict) and set(pins) == PIN_FIELDS - {'INSTALLED_EXE_SHA'}
            and pins == PACKAGE_PINS, 'Exact signed22 metadata pins are not admitted; preparation only')
    validate_provenance(pins, PIN_FIELDS - {'INSTALLED_EXE_SHA'})


def load_route(package_only=False):
    if package_only:
        validate_package_pins(PACKAGE_PINS)
    else:
        validate_admission(ADMITTED)
    folder = ROOT / '.local/routine-qa-route'
    script = folder / 'scripts/d4ae-installed-qa.py'
    require(not folder.is_symlink() and not script.is_symlink(), 'Linked frozen route refused')
    head = subprocess.check_output(['git', '-C', str(folder), 'rev-parse', 'HEAD'], text=True).strip()
    require(head == ROUTE_COMMIT and hashlib.sha256(script.read_bytes()).hexdigest() == ROUTE_SHA256,
            'Frozen safety route identity differs')
    spec = importlib.util.spec_from_file_location('routine_frozen_route', script)
    route = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(route)
    route.__file__ = str(ENTRY)
    route.ROOT, route.OPERATION = ROOT, PACKAGE_OPERATION if package_only else OPERATION
    route.BASE = ROOT / ('.local/routine-package-inspection' if package_only else '.local/routine-count-installed-qa')
    route.EVIDENCE = route.BASE / 'evidence'
    route.VERSION, route.BUILD = '0.5.22', '20261020-routine-count-0522.1'
    route.ASSET = 'Cicada-0.5.22-windows-x86_64.exe'
    for key, value in (PACKAGE_PINS if package_only else ADMITTED).items():
        setattr(route, key, value)
    route.ARTIFACT = 'cicada-update-windows-' + route.SOURCE
    route.validate_host_context = validate_host
    route.RUNTIME_CODE = RUNTIME_CODE
    if package_only:
        # No inherited signed20 hash and no fixture, policy, browser or runtime
        # entry point exists in the package-only adapter.
        for name in ('INSTALLED_EXE_SHA', 'RUNTIME_CODE', 'main', 'serve_default_desktop',
                     'check_default_desktop', 'preflight', 'preflight_mcp_tools', 'static_runtime_call',
                     'seed_protected_fixture', 'OwnedWebviewPolicy', 'WindowsPolicyStore',
                     'cleanup_owned_policy', 'diagnostic_only_preflight', 'inspect_windows_manifest_and_token'):
            delattr(route, name)
    # Launch, policy/KTM, endpoint ownership, schema and finally cleanup execute
    # verbatim from the reviewed hash-pinned route, never a new launcher.
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
for(const name of ['Cicada-0.5.22-windows-x86_64.exe','Cicada-0.5.22-windows-x86_64.exe.identity.json'])
 verifyTauriSignature(await readFile(path.join(directory,name)),await readFile(path.join(directory,name+'.sig'),'utf8'),key);
"""


RUNTIME_CODE = r"""async (page) => {
  const assertions=[],receipts=[],transitions=[];
  const check=(ok,label)=>{if(!ok)throw Error(label);assertions.push(label);};
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
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
    const dates=await page.evaluate(()=>{const key=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;const today=new Date(),prior=new Date(today.getFullYear(),today.getMonth(),today.getDate()-1,12);return {today:key(today),prior:key(prior)};});
    const key='calendar_recurring_v1';
    const raw=()=>rpc('get_ui_state',{key});
    const read=async()=>JSON.parse((await raw())||'{"version":1,"plans":[],"days":{}}');
    const write=async state=>{const before=await raw();await rpc('set_ui_state',{key,value:JSON.stringify(state),expectedValue:before??''});};
    check((await read()).plans.length===0,'empty owned routines');
    check((await rpc('get_calendar_tasks',{includeCompleted:true})).length===0,'empty owned tasks');
    check((await rpc('get_timeline_blocks',{date:dates.today})).length===0,'empty owned timeblocks');
    const library=()=>page.locator('#uni-pane-calendar .calendar-recurring--library[aria-busy="false"]');
    const editor=()=>page.locator('dialog[open]:has([data-routine-title])');
    const row=id=>library().locator(`[data-library-id="${id}"]`);
    const submit=async()=>{await editor().locator('button[type="submit"]').click();await editor().waitFor({state:'detached'});};
    const close=async dialog=>{await dialog.locator('header [data-dialog-close]').click();await dialog.waitFor({state:'detached'});};
    const catalog=async()=>{await page.locator('.uni-tab[data-pane="routines"]').click();await library().waitFor({state:'visible'});};
    const reload=async()=>{await page.reload();await page.locator('[data-calendar-create]').waitFor({state:'visible'});await catalog();};
    const create=async(title,target,optional=false)=>{
      await page.locator('[data-calendar-create]').click();
      await page.locator('button[data-create-kind="routine"]').click();
      await editor().locator('[data-routine-title]').fill(title);
      if(target!==null)await editor().locator('[data-routine-target]').fill(String(target));
      if(optional){await editor().locator('[data-routine-options] > summary').click();await editor().locator('[data-routine-required]').uncheck();}
      await submit();
      const matches=(await read()).plans.filter(p=>p.title===title);check(matches.length===1,'one created identity '+title);return matches[0].id;
    };
    const label=(n,t)=>`${n} ${t} ${Math.max(0,t-n)}`;
    const visible=async(id,n,t)=>{
      const ru=`Выполнено ${n} из ${t} · осталось ${Math.max(0,t-n)}`,en=`Completed ${n} of ${t} · remaining ${Math.max(0,t-n)}`;
      await row(id).getByText(new RegExp('^'+ru+'$|^'+en+'$')).waitFor({state:'visible'});
      check((await row(id).innerText()).includes(ru)||(await row(id).innerText()).includes(en),'visible counts '+label(n,t));
    };
    await catalog();
    const id=await create('A085 Count Привычка',3),legacy=await create('A085 Legacy optional',null,true);
    let state=await read();const plan=state.plans.find(p=>p.id===id),legacyPlan=state.plans.find(p=>p.id===legacy);
    check(plan.mode==='count'&&plan.dailyTarget===3&&plan.required===true,'target3 required persisted');
    check(legacyPlan.mode==='check'&&!Object.hasOwn(legacyPlan,'dailyTarget')&&legacyPlan.required===false,'default target1 check optional persisted');
    await visible(id,0,3);
    // Lawful fixture data: historical snapshots through native CAS, not a clock
    // override. Prior-day native snapshots and current-day UI do not advance time.
    const historical={snapshot:{...plan,createdOn:dates.prior},completedCount:3,status:'done'};
    const legacyHistory={snapshot:{...legacyPlan,createdOn:dates.prior},status:'done'};
    state.days[dates.prior]={[id]:historical,[legacy]:legacyHistory};await write(state);
    const historyBefore=JSON.stringify((await read()).days[dates.prior]);
    await reload();await visible(id,0,3);
    check((await read()).days[dates.today]===undefined,'new local day has no copied historical counts');
    for(let n=1;n<=4;n++){
      await row(id).locator('[data-library-mark][data-library-status="done"]').click();await visible(id,n,3);
      const saved=await read(),record=saved.days[dates.today][id];
      check(record.completedCount===n&&record.snapshot.id===id&&record.snapshot.dailyTarget===3&&record.status===(n>=3?'done':'pending'),'saved mark '+n);
      transitions.push({completed:n,target:3,remaining:Math.max(0,3-n)});
    }
    await page.screenshot({path:SHOTS+'/01-over-target.png'});
    for(const n of [3,2]){await row(id).locator('[data-library-mark][data-library-status="pending"]').click();await visible(id,n,3);check((await read()).days[dates.today][id].completedCount===n,'saved correction '+n);}
    await reload();await visible(id,2,3);check((await read()).days[dates.today][id].completedCount===2,'reload retains correction');
    // Native fixture writes do not refresh this mounted library. Verify the
    // displayed old counts, then exercise the same visible quick-mark control.
    const libraryError=()=>library().locator('[data-recurring-error]:not([hidden])');
    state=await read();state.days[dates.today][id].completedCount=1;await write(state);let saved=await raw();
    await visible(id,2,3);
    await row(id).locator('[data-library-mark][data-library-status="done"]').click();await libraryError().waitFor({state:'visible'});
    check(await raw()===saved,'stale partial count refuses overwrite');
    check(await libraryError().isVisible(),'failed count write leaves visible library review error');await page.screenshot({path:SHOTS+'/02-stale-count.png'});
    await reload();await visible(id,1,3);
    state=await read();state.days[dates.today][id].snapshot.dailyTarget=5;await write(state);saved=await raw();
    await visible(id,1,3);
    await row(id).locator('[data-library-mark][data-library-status="done"]').click();await libraryError().waitFor({state:'visible'});
    check(await raw()===saved,'stale reviewed target refuses overwrite');
    const refused=await call('set_ui_state',{key,value:saved,expectedValue:'stale synthetic expected value'});
    check(!refused.ok&&refused.error.includes('mvp_sync_stale_ui_state'),'native stale CAS write fails');
    check(await raw()===saved,'failed native write preserves exact saved state');
    await reload();await visible(id,1,5);
    // Actual editor stale-save failure retains a human draft and saved plan.
    await row(id).locator('[data-recurring-edit]').click();await editor().locator('[data-routine-title]').fill('A085 retained draft');
    state=await read();state.plans.find(p=>p.id===id).dailyTarget=4;await write(state);saved=await raw();
    await editor().locator('button[type="submit"]').click();await editor().locator('[data-dialog-error]:not([hidden])').waitFor({state:'visible'});
    check(await editor().locator('[data-routine-title]').inputValue()==='A085 retained draft','stale plan retains editor draft');
    check(await raw()===saved,'stale editor preserves native saved target');await page.screenshot({path:SHOTS+'/03-retained-draft.png'});await close(editor());
    await reload();await row(id).locator('[data-recurring-edit]').click();await editor().locator('[data-routine-target]').fill('1');await submit();
    state=await read();check(state.plans.find(p=>p.id===id).mode==='count'&&state.plans.find(p=>p.id===id).dailyTarget===1,'existing count plan target1 retained');
    check(state.days[dates.today][id].snapshot.dailyTarget===5,'editing target preserves reviewed day snapshot');
    await row(legacy).locator('[data-recurring-edit]').click();await editor().locator('[data-routine-title]').fill('A085 Legacy optional edited');await submit();
    state=await read();check(state.plans.find(p=>p.id===legacy).mode==='check'&&!Object.hasOwn(state.plans.find(p=>p.id===legacy),'dailyTarget'),'legacy target1 save remains check');
    await row(legacy).locator('[data-library-mark][data-library-status="done"]').click();
    await row(legacy).locator('[data-library-mark][data-library-status="pending"]').waitFor({state:'visible'});
    state=await read();check(state.days[dates.today][legacy].completedCount===1&&state.days[dates.today][legacy].status==='done','legacy done is one completion');
    // The installed workspace has no History/Today routine controls. Preserve
    // prior-day records through actual current-day UI writes and reload instead
    // of mounting the unused nonlibrary component or editing historical data.
    const prior=(await read()).days[dates.prior];
    check(prior[id].completedCount===3&&prior[id].snapshot.dailyTarget===3&&prior[id].status==='done','prior day counted snapshot preserved');
    check(same(prior[legacy],legacyHistory)&&!Object.hasOwn(prior[legacy],'completedCount'),'legacy binary history preserved exactly without migration');
    const beforeReload=await raw();await reload();state=await read();
    check(await raw()===beforeReload,'library reload performs no recurring migration write');
    await visible(id,1,5);
    check(same(state.days[dates.prior],JSON.parse(historyBefore)),'current-day changes preserve all prior-day snapshots');
    check(state.plans.length===2&&new Set(state.plans.map(p=>p.id)).size===2&&state.plans.some(p=>p.id===id)&&state.plans.some(p=>p.id===legacy),'stable identities no duplicate routines');
    check(state.plans.find(p=>p.id===id).required===true&&state.plans.find(p=>p.id===legacy).required===false,'required optional metadata preserved');
    check((await rpc('get_calendar_tasks',{includeCompleted:true})).length===0,'marks create no tasks');
    check((await rpc('get_timeline_blocks',{date:dates.today})).length===0&&(await rpc('get_timeline_blocks',{date:dates.prior})).length===0,'marks create no timeblocks');
    check((await rpc('get_active_block'))===null,'no implicit timer or start');
    const finalDates=await page.evaluate(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;});
    check(finalDates===dates.today,'runner local date unchanged during scenario');
    await page.screenshot({path:SHOTS+'/04-final-state.png'});
    return {routineOutcome:'passed',assertionCount:assertions.length,assertions,receipts,transitions,dates,dayBoundaryMethod:'native isolated prior-day snapshots plus current-day library UI/reload; no clock advance'};
  }catch(error){try{await page.screenshot({path:SHOTS+'/failure.png'});}catch(e){receipts.push({screenshotError:String(e)});}return {routineOutcome:'failed',error:String(error),assertions,receipts,transitions};}
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
    require(isinstance(result, dict) and result.get('routineOutcome') == 'passed'
            and type(result.get('assertionCount')) is int and result['assertionCount'] == 53
            and result['assertionCount'] == len(result.get('assertions', [])), 'Incomplete routine runtime result')
    require(result.get('transitions') == [
        {'completed': n, 'target': 3, 'remaining': max(0, 3-n)} for n in range(1, 5)],
        'Missing observed count transitions')
    require(result.get('dayBoundaryMethod') == 'native isolated prior-day snapshots plus current-day library UI/reload; no clock advance',
            'Unknown day fixture method')
    require([r.get('name') for r in result.get('receipts', [])[:2]] == ['isolated_test_status', 'mvp_sync_now']
            and result.get('assertions', [])[:3] == ['native isolation', 'exact root', 'sync denied'],
            'Native isolation must precede all fixture operations')
    return result



def installer_source_proof():
    # Exact canonical NSIS source: /S skips the GUI finish/run page, while
    # .onInstSuccess invokes the app only when /R is present. We never pass /R.
    hashes = {'src-tauri/windows/installer.nsi': '7e927ef20ddeea18fe47252d0b5139fda12046b39282f701b3ddb647009810f3',
              'src-tauri/windows/update-hooks.nsh': '5b6907143ca16e493cb75e206a94a4d9b16937a031c06314d63b93a32ab4801a'}
    for path, expected in hashes.items():
        require(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected, 'Unreviewed installer launch behavior')
    return {'source_sha256': hashes, 'silent': '/S; finish page skipped', 'restart_flag': 'ABSENT; /R required by .onInstSuccess'}


def no_package_app():
    import psutil
    for process in psutil.process_iter(['name']):
        name = process.info['name']
        require(name is not None, 'Cannot inspect hosted process name')
        require(name.casefold() not in {'hanni-mvp.exe', 'cicada.exe'}, 'Unexpected app process; metadata cannot proceed')


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
    require(version[:3] == [0, 5, 22], 'Unpacked executable version differs from signed22')
    return {'sha256': digest, 'size': size, 'file_version': version, 'access': 'read-only PE data; not executed'}


def package_audit(route):
    # Read-only cleanup proof: this phase has no policy/browser/fixture entry.
    no_package_app()
    require(not (ROOT / '.local/background-qa' / OPERATION).exists(), 'Unexpected app fixture exists')
    require(not (route.EVIDENCE / route.POLICY_RECEIPT).exists(), 'Unexpected policy ownership receipt')
    require(not (ROOT / '.local/routine-count-installed-qa/evidence/owned-webview-policy.json').exists(), 'Unexpected runtime policy receipt')
    proof = {'operation': PACKAGE_OPERATION, 'run': os.environ.get('GITHUB_RUN_ID'), 'head': os.environ.get('GITHUB_SHA'),
             'matching_app_processes': 0, 'app_profile_created': False, 'policy_entry_available': False,
             'app_launched_by_phase': False, 'runtime_acceptance': 'NOT_RUN'}
    route.write_json(route.EVIDENCE / 'cleanup-proof.json', proof)
    return proof


def inspect_package(route):
    require(route.BASE == ROOT / '.local/routine-package-inspection', 'Wrong fixed package inspection root')
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
        route.command(['git', 'merge-base', '--is-ancestor', PRODUCT_IDENTITY, route.SOURCE], 'canonical-identity-ancestry')
        route.command(['git', 'diff', '--exit-code', route.SOURCE, '--', 'src', 'src-tauri', 'package.json', 'package-lock.json',
                       'scripts/qa-launch-policy.py', 'scripts/qa-background.py', 'scripts/qa_files.py',
                       'scripts/task-workflow-native-qa.py', 'scripts/stage-updates.mjs'], 'unchanged-product-and-helpers')
        route.command([sys.executable, '-X', 'utf8', '-B', ENTRY, '--mcp-contract-only', '--mcp-cli', args.mcp_cli], 'mcp080-contract-preflight', timeout=30)
        route.preflight()
        state['no_autolaunch_source_proof'] = installer_source_proof()
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
        require(not (ROOT / '.local/routine-count-installed-qa/evidence/owned-webview-policy.json').exists(),
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
