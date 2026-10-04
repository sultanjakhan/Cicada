"""Prove file-only upgrade/rollback on a synthetic fixture. Never deploy production."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import os
import qa_files
import win32con
from contextlib import ExitStack, closing

ROOT = Path(__file__).resolve().parents[1]

def sha(path):
    return hashlib.sha256(qa_files.read_bytes(path)).hexdigest()

def ordinary(path):
    if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
        raise RuntimeError('links are forbidden')
    if path.is_file() and path.stat().st_nlink != 1:
        raise RuntimeError('hardlinks are forbidden')

def fixture_root(root):
    root = Path(root).absolute()
    if root.parent != ROOT / '.local' or '..' in root.parts:
        raise RuntimeError('Require a direct workspace .local fixture')
    return root

def apply(root, expected):
    root = fixture_root(root)
    with qa_files.pinned_tree(root):
        return _apply(root, expected)

def _apply(root, expected):
    # All operands have fixed relative names inside a caller-owned synthetic fixture.
    if json.loads(qa_files.read_text(root/'fixture.json')) != {'purpose':'synthetic-portable-update'}:
        raise RuntimeError('fixture marker required')
    for path in [root,root/'installed',root/'data',root/'installed/hanni-mvp.exe',root/'candidate.exe',root/'data/calendar.db']:
        ordinary(path)
    target=root/'installed/hanni-mvp.exe'; candidate=root/'candidate.exe'
    if sha(candidate)!=expected: raise RuntimeError('candidate hash mismatch')
    old=root/'hanni-mvp.previous.exe'; database=root/'data/calendar.db'; backup=root/'calendar.previous.db'
    if old.exists() or backup.exists(): raise RuntimeError('backup already exists')
    qa_files.write_bytes(old, qa_files.read_bytes(target), new=True)
    with ExitStack() as handles:
        handles.callback(qa_files.checked_handle(database,win32con.GENERIC_READ,win32con.OPEN_EXISTING,share=3).Close)
        handles.callback(qa_files.checked_handle(backup,win32con.GENERIC_READ,win32con.CREATE_NEW,share=3).Close)
        with closing(sqlite3.connect(database.as_uri()+'?mode=ro',uri=True)) as source:
            with closing(sqlite3.connect(backup)) as destination:
                source.backup(destination)
                assert destination.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    staged=root/'installed/hanni-mvp.staged.exe'
    qa_files.write_bytes(staged, qa_files.read_bytes(candidate), new=True)
    assert sha(staged)==expected
    os.replace(staged,target)
    assert sha(target)==expected

def rollback(root):
    root = fixture_root(root)
    with qa_files.pinned_tree(root):
        if json.loads(qa_files.read_text(root/'fixture.json')) != {'purpose':'synthetic-portable-update'}:
            raise RuntimeError('fixture marker required')
        return _rollback(root)

def _rollback(root):
    target=root/'installed/hanni-mvp.exe'; staged=root/'installed/hanni-mvp.rollback.exe'
    qa_files.write_bytes(staged, qa_files.read_bytes(root/'hanni-mvp.previous.exe'), new=True)
    os.replace(staged,target)
    # Fixture SQLite connections are closed; no production processes or paths are touched.
    with ExitStack() as handles:
        for path in [root/'calendar.previous.db',root/'data/calendar.db']:
            handles.callback(qa_files.checked_handle(path,win32con.GENERIC_READ,win32con.OPEN_EXISTING,share=3).Close)
        with closing(sqlite3.connect((root/'calendar.previous.db').as_uri()+'?mode=ro',uri=True)) as source:
            with closing(sqlite3.connect(root/'data/calendar.db')) as destination: source.backup(destination)

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',required=True,type=Path);args=parser.parse_args()
    root=fixture_root(args.root)
    if root.exists(): raise RuntimeError('Require a new fixture')
    with qa_files.pinned_tree(root, create=True):
        return run_fixture(root)

def run_fixture(root):
    (root/'installed').mkdir();(root/'data').mkdir()
    qa_files.write_text(root/'fixture.json', json.dumps({'purpose':'synthetic-portable-update'}), new=True)
    target=root/'installed/hanni-mvp.exe';qa_files.write_bytes(target,b'synthetic-old-executable',new=True)
    qa_files.write_bytes(root/'candidate.exe',b'synthetic-new-executable',new=True)
    database=root/'data/calendar.db'
    with closing(sqlite3.connect(database)) as connection, connection:
        connection.execute('CREATE TABLE synthetic(value TEXT)');connection.execute("INSERT INTO synthetic VALUES ('preserved fixture')")
    old_hash=sha(target);new_hash=sha(root/'candidate.exe')
    try: apply(root,'0'*64)
    except RuntimeError: pass
    else: raise AssertionError('bad hash accepted')
    assert sha(target)==old_hash and not (root/'calendar.previous.db').exists()
    apply(root,new_hash)
    with closing(sqlite3.connect(database)) as connection, connection: connection.execute("UPDATE synthetic SET value='simulated post-upgrade write'")
    rollback(root);assert sha(target)==old_hash
    with closing(sqlite3.connect(database)) as connection, connection:
        assert connection.execute('SELECT value FROM synthetic').fetchone()[0]=='preserved fixture'
        assert connection.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    result={'productionDeploymentEnabled':False,'badHashRejectedBeforeChanges':True,'newExeVerified':True,'oldExeRestored':True,'sqliteBackupRestored':True,'registryOrShortcutsChanged':False}
    qa_files.write_text(root/'proof.json',json.dumps(result,indent=2),new=True);print(json.dumps(result))

if __name__=='__main__':main()
