#!/usr/bin/env python3
"""Bounded privacy regression guard; it never prints matched values."""
import argparse
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

PRIVATE_NAMES = {'.env', '.mcp.json', 'credentials.json', 'token.pickle'}
PRIVATE_SUFFIXES = {'.db', '.sqlite', '.sqlite3', '.bak', '.backup', '.pem', '.key', '.p12', '.pfx'}
RULES = {
    'personal-email': re.compile(r'\b[A-Z0-9._%+-]+@(?:gmail|outlook|hotmail|icloud|yahoo|yandex|mail)\.(?:com|ru|kz)\b', re.I),
    'phone-number': re.compile(r'(?<!\w)\+7[ (.-]+\d{3}[ ).-]+\d{3}[ .-]+\d{2}[ .-]+\d{2}(?!\d)'),
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'access-token': re.compile(r'\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{20,})\b'),
}
HOME_PREFIX = r'(?:[A-Za-z]:[\\/]+U' + r'sers[\\/]+|/' + 'U' + 'sers/|/' + 'home/)'
HOME = re.compile(HOME_PREFIX + r'([^\\/\s"\'<>]+)', re.I)
SYNTHETIC_USERS = {'alice', 'bob', 'runner', 'user', 'test', 'example', 'developer'}

def path_rules(path):
    p = PurePosixPath(path)
    name = p.name.lower()
    if (name in PRIVATE_NAMES or name.startswith('.env.') or p.suffix.lower() in PRIVATE_SUFFIXES
            or name.endswith(('.db-wal', '.db-shm')) or p.suffix.lower() == '.jsonl'
            or any(part.lower() in {'backups', 'exports'} for part in p.parts)):
        return ['private-file']
    return []

def text_rules(content, denylist):
    findings = []
    for line_number, line in enumerate(content.splitlines(), 1):
        for code, rule in RULES.items():
            if rule.search(line): findings.append((line_number, code))
        for match in HOME.finditer(line):
            user = match.group(1).lower()
            if user not in SYNTHETIC_USERS and not any(c in user for c in '$*{['):
                findings.append((line_number, 'personal-home-path')); break
        if any(value.casefold() in line.casefold() for value in denylist):
            findings.append((line_number, 'local-private-marker'))
    return findings

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--denylist', type=Path, help='Local JSON array of markers; never commit it')
    args = parser.parse_args()
    denylist = []
    if args.denylist:
        denylist = json.loads(args.denylist.read_text(encoding='utf-8'))
        if not isinstance(denylist, list) or any(not isinstance(v, str) or not v for v in denylist):
            parser.error('denylist must be a JSON array of nonempty strings')
    root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
    raw = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root)
    checked = skipped = 0; findings = []
    for value in raw.split(b'\0'):
        if not value: continue
        relative = value.decode('utf-8'); path = root / relative
        findings.extend((relative, 0, code) for code in path_rules(relative))
        if '/vendor/' in relative or '/icons/' in relative or relative.endswith(('.min.js', '.min.css')):
            skipped += 1; continue
        data = path.read_bytes()
        if b'\0' in data:
            skipped += 1; continue
        try: content = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            skipped += 1; continue
        checked += 1
        findings.extend((relative, line, code) for line, code in text_rules(content, denylist))
    for path, line, code in findings: print(f'{path}:{line}: {code}')
    print(f'Privacy guard: {checked} first-party text files checked, {skipped} binary/vendor generated files skipped, {len(findings)} findings.')
    return 1 if findings else 0

if __name__ == '__main__': sys.exit(main())
