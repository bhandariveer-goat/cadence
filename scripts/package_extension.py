#!/usr/bin/env python3
"""Build the Chrome extension package for the Chrome Web Store.

    python3 scripts/package_extension.py

Writes dist/cadence-extension-<version>.zip with only what the extension runs:
manifest.json, the four toolbar icons and src/. The website's pages, the
Netlify functions, the database schema and the scripts stay out of it.

Before writing, it checks that the package is complete: every file the
manifest names exists, and every relative import in the JavaScript (static
`from '...'` and dynamic `import('...')`) points at a file inside the package.
It refuses to build if src/config.js has no site address, because the
extension sends people to the website for the privacy policy, the terms and
sign-in links, and without an address those would lead nowhere.

Uses only the standard library.
"""
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
ICONS = ['icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png']
SKIP = {'.DS_Store'}


def files():
    out = [ROOT / 'manifest.json'] + [ROOT / p for p in ICONS]
    for p in sorted((ROOT / 'src').rglob('*')):
        if p.is_file() and p.name not in SKIP and '__pycache__' not in p.parts:
            out.append(p)
    return out


def problems(paths):
    found = []
    have = {p.resolve() for p in paths}
    manifest = json.loads((ROOT / 'manifest.json').read_text())

    named = [manifest['background']['service_worker']]
    for cs in manifest.get('content_scripts', []):
        named += cs.get('js', []) + cs.get('css', [])
    named += list(manifest.get('icons', {}).values()) + list(manifest.get('action', {}).get('default_icon', {}).values())
    for rel in named:
        if (ROOT / rel).resolve() not in have:
            found.append(f'manifest.json names {rel}, which is not in the package')

    imports = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}/[^'"]+)['"]""")
    for p in paths:
        if p.suffix != '.js':
            continue
        for rel in imports.findall(p.read_text(encoding='utf-8')):
            target = (p.parent / rel.split('?')[0]).resolve()
            if target not in have:
                found.append(f'{p.relative_to(ROOT)} imports {rel}, which is not in the package')

    config = (ROOT / 'src' / 'config.js').read_text(encoding='utf-8')
    domain = re.search(r"domain:\s*'([^']*)'", config)
    if not domain or not domain.group(1).strip():
        found.append("src/config.js has no site.domain: the extension's privacy, terms and sign-in links would lead nowhere")
    if re.search(r"supabaseUrl:\s*'http://", config):
        found.append('src/config.js points Supabase at a test server, not a real project')
    return found, manifest


def main():
    paths = files()
    found, manifest = problems(paths)
    if found:
        print('Not packaged:')
        for f in found:
            print(f'  - {f}')
        sys.exit(1)
    DIST.mkdir(exist_ok=True)
    out = DIST / f"cadence-extension-{manifest['version']}.zip"
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for p in paths:
            z.write(p, p.relative_to(ROOT).as_posix())
    size = out.stat().st_size / 1024
    print(f'Wrote {out.relative_to(ROOT)} ({len(paths)} files, {size:.0f} KB)')


if __name__ == '__main__':
    main()
