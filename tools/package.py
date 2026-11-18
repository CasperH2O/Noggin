#!/usr/bin/env python3
"""Build the skill's BEacon ZIP (dist/<Name>.zip) for Store -> Upload ZIP or a GitHub release.

    python3 tools/package.py [--output dist/<Name>.zip]

Layout (original-assets/BEam/docs/custom-skills.md): manifest.json, icon.png, an optional
banner.png and README.md at the root, where README.md is the store text from store/README.md
(BEacon's simple Markdown: headings, paragraphs, flat lists, bold; no tables), and one package
folder holding the @be/<skill> asset-pack with its JavaScript main. Nothing is built on the robot,
so the ZIP carries everything. The ZIP is deterministic (sorted entries, fixed timestamps, no exec
bits) and checked against BEacon's limits: 32 MB compressed, 64 MB expanded, 1,024 entries.
"""
import argparse
import hashlib
import json
import struct
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
SKILL = 'noggin'                       # the package folder, and @be/<SKILL>
MAX_ZIP, MAX_EXPANDED, MAX_ENTRIES = 32 * 1024 * 1024, 64 * 1024 * 1024, 1024
STAMP = (2026, 1, 1, 0, 0, 0)
ICON_SIZE = (330, 300)                   # BEacon centres the icon unscaled in a 330x300 menu button
STORE_FILES = {'manifest.json': 'manifest.json', 'icon.png': 'icon.png', 'README.md': 'store/README.md'}
OPTIONAL_FILES = {'banner.png': 'banner.png'}


def png_size(path):
    head = path.read_bytes()[:24]
    if head[:8] != b'\x89PNG\r\n\x1a\n':
        sys.exit(f'{path.name} is not a PNG')
    return struct.unpack('>II', head[16:24])


def check_package():
    manifest = json.loads((HERE / 'manifest.json').read_text())
    package = json.loads((HERE / SKILL / 'package.json').read_text())
    if manifest.get('type') != 'skill' or not manifest.get('supported'):
        sys.exit('manifest.json needs type "skill" and a "supported" jibo-tbd version')
    if manifest['version'] != package['version']:
        sys.exit('manifest.json and package.json versions differ')
    if package['name'] != '@be/' + SKILL or package['jibo']['type'] != 'asset-pack':
        sys.exit(f'{SKILL}/package.json must be the @be/{SKILL} asset-pack')
    main = package.get('main', 'index.js')
    if not main.endswith('.js') or not (HERE / SKILL / main).is_file():
        sys.exit(f'package main {main} is missing')
    if png_size(HERE / 'icon.png') != ICON_SIZE:
        sys.exit(f'icon.png must be {ICON_SIZE[0]}x{ICON_SIZE[1]}')
    return manifest


def collect():
    entries = {name: (HERE / source).read_bytes() for name, source in STORE_FILES.items()}
    entries.update({name: (HERE / source).read_bytes() for name, source in OPTIONAL_FILES.items() if (HERE / source).is_file()})
    entries[f'{SKILL}/LICENSE'] = (HERE / 'LICENSE').read_bytes()     # the licence travels with the code
    entries[f'{SKILL}/THIRD_PARTY.md'] = (HERE / 'THIRD_PARTY.md').read_bytes()
    for file in sorted((HERE / SKILL).rglob('*')):
        if file.is_file() and '__pycache__' not in file.parts and not file.name.startswith('.'):
            entries[f'{SKILL}/{file.relative_to(HERE / SKILL).as_posix()}'] = file.read_bytes()
    return entries


def main():
    manifest = check_package()
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    default = HERE / 'dist' / (''.join(manifest['name'].split()) + '.zip')
    parser.add_argument('--output', type=Path, default=default)
    args = parser.parse_args()
    entries = collect()
    if len(entries) > MAX_ENTRIES:
        sys.exit(f'{len(entries)} entries; BEacon accepts {MAX_ENTRIES}')
    expanded = sum(len(data) for data in entries.values())
    if expanded > MAX_EXPANDED:
        sys.exit(f'{expanded} bytes expanded; BEacon accepts {MAX_EXPANDED}')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix('.tmp')
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(entries):
            info = zipfile.ZipInfo(name, STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, entries[name])
    size = temporary.stat().st_size
    if size > MAX_ZIP:
        temporary.unlink()
        sys.exit(f'{size} bytes compressed; BEacon accepts {MAX_ZIP}')
    temporary.replace(args.output)
    print(json.dumps({'zip': str(args.output), 'version': manifest['version'], 'entries': len(entries),
                      'expanded': expanded, 'compressed': size,
                      'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest()}, indent=2))


if __name__ == '__main__':
    main()
