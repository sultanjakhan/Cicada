#!/usr/bin/env python3
"""Generate desktop and Android icons from the approved SVG master."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


def generate(output, copy_desktop=True):
    output.mkdir(parents=True, exist_ok=True)
    source = ROOT / 'src/app-icon.svg'
    tree = ET.parse(source)
    svg = tree.getroot()
    # Adaptive/themed icons need the mark's alpha, not the white desktop tile.
    background = next(node for node in svg if node.get('id') == 'icon-background')
    svg.remove(background)
    # Tauri preserves an explicit foreground's size; keep the mark in Android's safe zone.
    inset = ET.Element('{http://www.w3.org/2000/svg}g', {
        'transform': 'translate(76.8 76.8) scale(0.7)',
    })
    for node in list(svg):
        svg.remove(node)
        inset.append(node)
    svg.append(inset)
    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    foreground = output / 'foreground.svg'
    tree.write(foreground, encoding='utf-8', xml_declaration=True)
    manifest = output / 'icon-manifest.json'
    manifest.write_text(json.dumps({
        'default': str(source),
        'bg_color': '#ffffff',
        'android_fg': str(foreground),
        'android_monochrome': str(foreground),
    }, indent=2) + '\n')
    subprocess.run(['npm', 'run', 'tauri', '--', 'icon', str(manifest),
                    '--output', str(output)], cwd=ROOT, check=True)
    if copy_desktop:
        for name in ('icon.png', 'icon.ico', 'icon.icns'):
            shutil.copyfile(output / name, ROOT / 'src-tauri/icons' / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / '.local/generated-icons')
    parser.add_argument('--no-desktop', action='store_true')
    args = parser.parse_args()
    generate(args.output.resolve(), copy_desktop=not args.no_desktop)


if __name__ == '__main__':
    main()
