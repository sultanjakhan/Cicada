#!/usr/bin/env python3
"""Check reachable Git history without printing matched private values."""
import argparse
import importlib.util
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location('privacy_guard', Path(__file__).with_name('check-private-data.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def git(*args):
    return subprocess.check_output(['git', *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ref', default='HEAD', help='Commit whose reachable history will be checked')
    args = parser.parse_args()
    commit = git('rev-parse', '--verify', '--end-of-options', args.ref + '^{commit}').decode().strip()
    objects = {}
    for line in git('rev-list', '--objects', commit).decode('utf-8').splitlines():
        oid, _, path = line.partition(' ')
        objects[oid] = path
    # Inspect names independently: identical blobs can occur at several paths.
    paths = set(git('log', commit, '--format=', '--name-only', '--no-renames', '-z').decode('utf-8').split('\0'))
    findings = []
    for path in paths:
        path = path.strip('\n')
        if path:
            findings.extend((path, code) for code in guard.path_rules(path))
    batch = subprocess.run(['git', 'cat-file', '--batch'], input=('\n'.join(objects) + '\n').encode(),
                           stdout=subprocess.PIPE, check=True).stdout
    position = checked = skipped = commits = 0
    for oid, path in objects.items():
        end = batch.index(b'\n', position)
        header = batch[position:end].split()
        size = int(header[2])
        data = batch[end + 1:end + 1 + size]
        position = end + size + 2
        kind = header[1]
        if kind == b'commit':
            commits += 1
            findings.extend((oid[:12] + ':metadata', code) for _, code in guard.text_rules(data.decode('utf-8', errors='replace'), []))
        if kind != b'blob':
            continue
        if '/vendor/' in path or '/icons/' in path or path.endswith(('.min.js', '.min.css')):
            skipped += 1
            continue
        try:
            if b'\0' in data:
                raise UnicodeError()
            content = data.decode('utf-8-sig')
        except UnicodeError:
            skipped += 1
            continue
        checked += 1
        findings.extend((oid[:12] + ':' + path + ':' + str(line), code)
                        for line, code in guard.text_rules(content, []))
    for location, code in findings:
        print(f'{location}: {code}')
    print(f'Public history: {commits} commits, {checked} first-party text revisions, '
          f'{skipped} binary/vendor revisions skipped, {len(findings)} findings.')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
