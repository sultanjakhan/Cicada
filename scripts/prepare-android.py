#!/usr/bin/env python3
"""Apply MVP branding and private-profile backup exclusions after Android init."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

ANDROID = '{http://schemas.android.com/apk/res/android}'
ATTRIBUTES = {
    'allowBackup': 'false',
    'fullBackupContent': '@xml/mvp_backup_rules',
    'dataExtractionRules': '@xml/mvp_data_extraction_rules',
}
DOMAINS = ('root', 'file', 'database', 'sharedpref', 'external',
           'device_root', 'device_file', 'device_database', 'device_sharedpref')


def parse(source):
    return ET.fromstring(source, parser=ET.XMLParser(
        target=ET.TreeBuilder(insert_comments=True)))


def structure(node):
    return (node.tag, node.attrib, (node.text or '').strip(),
            (node.tail or '').strip(), [structure(child) for child in node])


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def prepare_launcher_icon(root):
    source_icon = root / 'src/app-icon.svg'
    require(source_icon.is_file(), f'Missing approved launcher icon: {source_icon}')
    output = root / '.local/android-icon'
    subprocess.run([sys.executable, str(root / 'scripts/generate-icons.py'),
                    '--output', str(output), '--no-desktop'],
                   cwd=root, check=True)
    generated = output / 'android'
    require((generated / 'mipmap-hdpi/ic_launcher.png').is_file()
            and (generated / 'mipmap-anydpi-v26/ic_launcher.xml').is_file(),
            'Tauri did not generate both standard and adaptive launcher icons.')
    resources = root / 'src-tauri/gen/android/app/src/main/res'
    for source in generated.rglob('*'):
        if source.is_file():
            destination = resources / source.relative_to(generated)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)


def prepare(root):
    config = json.loads((root / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
    require(config.get('identifier') == 'app.hanni.mvp',
            'Expected the independent app.hanni.mvp project')
    main = root / 'src-tauri/gen/android/app/src/main'
    manifest = main / 'AndroidManifest.xml'
    require(manifest.is_file(), 'Run npm run tauri -- android init first')
    source = manifest.read_text(encoding='utf-8')
    tree = parse(source)
    applications = tree.findall('application')
    require(tree.tag == 'manifest' and len(applications) == 1,
            'Expected exactly one Android manifest application')
    require(any(node.get(ANDROID + 'name') == 'android.permission.INTERNET'
                for node in tree.findall('uses-permission')),
            'Expected the generated INTERNET permission')
    application = applications[0]
    gradle = root / 'src-tauri/gen/android/app/build.gradle.kts'
    gradle_source = gradle.read_text(encoding='utf-8')
    # Health Connect and the updater bring distinct OSGi descriptors. Android
    # does not use OSGi; this is not a license or a runtime service descriptor.
    osgi_rule = '    packaging.resources.excludes.add("META-INF/versions/9/OSGI-INF/MANIFEST.MF")'
    if osgi_rule not in gradle_source:
        require(gradle_source.count('android {') == 1, 'Ambiguous Android Gradle block.')
        gradle_source = gradle_source.replace('android {', 'android {\n' + osgi_rule, 1)
    missing = {}
    for key, value in ATTRIBUTES.items():
        current = application.get(ANDROID + key)
        require(current is None or current == value,
                f'Existing {key} differs; review the generated manifest')
        if current is None:
            missing[key] = value
        application.set(ANDROID + key, value)
    if missing:
        # Preserve unrelated attributes, comments, namespace prefixes and formatting.
        openings = list(re.finditer(r'<application\b(?:[^\"\'>]|\"[^\"]*\"|\'[^\']*\')*>', source))
        require(len(openings) == 1, 'Ambiguous application tag; review the generated manifest')
        opening = openings[0]
        insertion = opening.start() + len('<application')
        additions = ''.join(f'\n        android:{key}="{value}"' for key, value in missing.items())
        source = source[:insertion] + additions + source[insertion:]
    require(structure(parse(source)) == structure(tree),
            'Backup attributes would change unrelated manifest settings')

    rules = ''.join(f'    <exclude domain="{domain}" path="." />\n' for domain in DOMAINS)
    resources = {
        'mvp_backup_rules.xml': '<full-backup-content>\n' + rules + '</full-backup-content>\n',
        'mvp_data_extraction_rules.xml': '<data-extraction-rules>\n' + ''.join(
            f'  <{section}>\n{rules}  </{section}>\n'
            for section in ('cloud-backup', 'device-transfer')) + '</data-extraction-rules>\n',
    }
    directory = main / 'res/xml'
    for name, expected in resources.items():
        path = directory / name
        require(not path.exists() or structure(parse(path.read_text(encoding='utf-8'))) == structure(parse(expected)),
                f'Existing {name} differs; review it before applying backup exclusions')

    # Validate every existing file before writing any changes.
    directory.mkdir(parents=True, exist_ok=True)
    for name, expected in resources.items():
        path = directory / name
        if not path.exists():
            path.write_text('<?xml version="1.0" encoding="utf-8"?>\n' + expected, encoding='utf-8')
    if missing:
        manifest.write_text(source, encoding='utf-8')
    if gradle.read_text(encoding='utf-8') != gradle_source:
        gradle.write_text(gradle_source, encoding='utf-8')
    require(structure(parse(manifest.read_text(encoding='utf-8'))) == structure(tree),
            'Android manifest verification failed')
    for name, expected in resources.items():
        require(structure(parse((directory / name).read_text(encoding='utf-8'))) == structure(parse(expected)),
                f'Backup resource verification failed: {name}')
    # Local DEV follows this same preparation path as signed CI packages.
    prepare_launcher_icon(root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', nargs='?', type=Path, default=Path(__file__).resolve().parents[1],
                        help='MVP repository root; defaults to this script\'s repository')
    prepare(parser.parse_args().root.resolve())
    print('MVP Android scaffold: launcher branding, backup exclusions and INTERNET verified.')


if __name__ == '__main__':
    main()
