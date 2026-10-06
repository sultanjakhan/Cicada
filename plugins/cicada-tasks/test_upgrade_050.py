from pathlib import Path
import json, shutil, subprocess, sys, tempfile
from upgrade_050 import tree_sha

ROOT=Path(__file__).resolve().parent
SCRIPT=ROOT/'upgrade_050.py'
SOURCE_048=ROOT/'cicada-local-tasks-0.4.8'
PUBLIC_CANDIDATE=ROOT/'cicada-local-tasks-0.5.0'

with tempfile.TemporaryDirectory() as raw:
    CANDIDATE=Path(raw)/'candidate-0.5.0'
    shutil.copytree(PUBLIC_CANDIDATE,CANDIDATE,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    root=Path(raw); home=root/'home'; codex=root/'codex'; source=home/'plugins/cicada-local-tasks'; marketplace=home/'.agents/plugins/marketplace.json'; cache048=codex/'plugins/cache/cicada-local-marketplace/cicada-local-tasks/0.4.8'; backup=root/'backup'
    source.parent.mkdir(parents=True); marketplace.parent.mkdir(parents=True); codex.mkdir()
    shutil.copytree(SOURCE_048, source); shutil.copytree(SOURCE_048, cache048)
    marketplace.write_text(json.dumps({'name':'cicada-local-marketplace','plugins':[{'name':'cicada-local-tasks','source':{'source':'local','path':'./plugins/cicada-local-tasks'}}]}),encoding='utf-8')
    old=tree_sha(source)
    conflict=source/'before-first-apply.txt'; conflict.write_text('changed-before-plan',encoding='utf-8')
    changed=tree_sha(source); cache_before=tree_sha(cache048)
    rejected=subprocess.run([sys.executable,str(SCRIPT),'--marketplace-file',str(marketplace),'--candidate',str(CANDIDATE),'--codex-home',str(codex),'--expected-source-sha256',old,'--backup-root',str(backup),'--apply'],capture_output=True,text=True,encoding='utf-8',errors='replace')
    assert rejected.returncode!=0 and tree_sha(source)==changed and tree_sha(cache048)==cache_before and not backup.exists()
    conflict.unlink(); shutil.rmtree(source); shutil.copytree(SOURCE_048, source)
    old=tree_sha(source); args=[sys.executable,str(SCRIPT),'--marketplace-file',str(marketplace),'--candidate',str(CANDIDATE),'--codex-home',str(codex),'--expected-source-sha256',old,'--backup-root',str(backup),'--apply']
    result=subprocess.run(args,capture_output=True,text=True,encoding='utf-8',errors='replace'); assert result.returncode==0,result.stderr
    assert json.loads((source/'plugin.json').read_text())['version']=='0.5.0'
    assert tree_sha(cache048)==tree_sha(SOURCE_048), 'published cache was changed'
    assert (codex/'plugins/cache/cicada-local-marketplace/cicada-local-tasks/0.5.0').is_dir()
    assert {p.name for p in cache048.parent.iterdir()} == {'0.4.8', '0.5.0'}, 'staging directories must not become plugin versions'
print('upgrade 0.5.0 synthetic checks: PASS')
