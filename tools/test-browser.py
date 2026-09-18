#!/usr/bin/env python3
"""Real Chromium/Steam ReactDOM regression test; no Steam files are redistributed.

Requires Python Playwright and an installed Chromium. Example:
  python tools/test-browser.py --steam-dir /path/to/steam/files \
    --previous-zip /path/to/Playhub-Artworks-1.1.4_Hotfix1_Installer.zip \
    --report tests/reports/browser-render-results.json
All external network requests are blocked. Decky and selected Steam dependencies
are test adapters; this is not a full Windows/Steam/Decky client session.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import zipfile
from pathlib import Path


def run() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--steam-dir', required=True, type=Path)
    parser.add_argument('--previous-zip', type=Path)
    parser.add_argument('--chromium', default=shutil.which('chromium') or shutil.which('chromium-browser'))
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    if not args.chromium:
        parser.error('Install Chromium or provide --chromium /path/to/browser.')
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise SystemExit('Python Playwright is required for this optional browser test.') from exc
    root = Path(__file__).resolve().parent.parent
    def locate(name: str) -> Path:
        matches = sorted(args.steam_dir.rglob(name))
        if not matches:
            raise FileNotFoundError(f'Missing external Steam fixture: {name}')
        return matches[0]
    react_file = locate('libraries~00299a408.js')
    main_file = locate('chunk~2dcc5aaf7.js')
    glyph_fixture = subprocess.check_output(['node', str(root/'tools/prepare-browser-fixture.cjs'), str(main_file)], text=True)
    new_bundle = (root / 'dist/index.js').read_text(encoding='utf-8')
    old_bundle = None
    if args.previous_zip:
        with zipfile.ZipFile(args.previous_zip) as archive:
            names = [name for name in archive.namelist() if name.endswith('/dist/index.js')]
            if len(names) != 1:
                raise ValueError('Previous ZIP must contain exactly one plugin dist/index.js.')
            old_bundle = archive.read(names[0]).decode('utf-8')
    def expose(bundle: str) -> str:
        result, count = re.subn(r"export default __require\('src/index\.tsx'\)\.default;",
                               'window.__artworksRequire = __require;', bundle)
        if count != 1:
            raise ValueError('Unsupported test bundle format (expected the documented offline builder).')
        return result
    results = []
    browser_errors = []
    with sync_playwright() as driver:
        browser = driver.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
        browser_version = browser.version
        context = browser.new_context(locale='it-IT', viewport={'width': 1280, 'height': 900})
        context.route('**/*', lambda route: route.abort())
        def start(bundle: str, mode: str = 'native'):
            page = context.new_page()
            page.set_default_timeout(2500)
            page.on('pageerror', lambda error: browser_errors.append(str(error)))
            page.set_content('<html><body><div id="root"></div></body></html>')
            page.add_script_tag(content='window.__steamFactories={}; self.webpackChunksteamui={push:chunk=>Object.assign(window.__steamFactories,chunk[1])};')
            page.add_script_tag(path=str(react_file))
            page.add_script_tag(content=glyph_fixture)
            page.add_script_tag(path=str(root/'tests/steam-renderer-bootstrap.js'))
            if page.evaluate('typeof __renderCards') != 'function':
                raise RuntimeError('Browser harness failed: ' + str(browser_errors[-3:]))
            page.evaluate('(mode) => { window.__lookupMode = mode; }', mode)
            page.add_script_tag(content=expose(bundle))
            return page
        def check(name: str, action) -> None:
            try:
                detail = action()
                results.append({'name': name, 'passed': True, **(detail or {})})
                print('PASS:', name)
            except Exception as exc:
                results.append({'name': name, 'passed': False, 'error': str(exc)})
                print('FAIL:', name, str(exc))
        def old_failure():
            page = start(old_bundle)
            page.evaluate('__renderCards([{notes:"Synthetic artwork notes"}])')
            errors = page.evaluate('__caught')
            assert len(errors) == 1 and 'Minified React error #130' in errors[0]['message'], errors
            assert 'Chip' in errors[0]['stack'] and 'Asset' in errors[0]['stack'], errors
            assert page.locator('[role="alert"]').count() == 1
            detail = {'error': errors[0]['message'], 'componentStackContains': ['Chip', 'Asset'], 'reactVersion': page.evaluate('SP_REACT.version')}
            page.close()
            return detail
        def successful(bundle: str, mode: str, cards: list[dict], fallback_count: int | None = None):
            page = start(bundle, mode)
            page.evaluate('__renderCards', cards)
            assert page.evaluate('__caught') == [], page.evaluate('__caught')
            assert page.locator('[role="alert"]').count() == 0
            assert page.locator('.asset-box-wrap').count() == len(cards)
            if fallback_count is not None:
                assert page.locator('[data-playhub-glyph="menu-fallback"]').count() == fallback_count
            return page
        if old_bundle:
            check('Hotfix1: actual ReactDOM reproduces React #130 inside Chip/Asset when notes are present', old_failure)
            def old_without_notes():
                page = successful(old_bundle, 'native', [{'notes': None}])
                page.close()
            check('Hotfix1 control: the same artwork without notes does not crash', old_without_notes)
        for mode in ['native', 'missing', 'throw', 'invalid', 'memo', 'forwardRef']:
            def mode_case(mode=mode):
                fallback = 1 if mode in ['missing', 'throw', 'invalid'] else 0
                page = successful(new_bundle, mode, [{'notes': 'Synthetic notes'}], fallback)
                assert page.locator('.chip svg').count() == 1
                assert 'Note' in page.locator('.chip').inner_text()
                page.locator('.image-wrap').dispatch_event('click')
                assert page.evaluate('__activated') == 1
                detail = {'reactVersion': page.evaluate('SP_REACT.version'), 'nativeGlyph': not fallback}
                page.close()
                return detail
            check(f'Hotfix2: artwork with notes renders and activates ({mode} glyph lookup)', mode_case)
        def optional_notes():
            page = successful(new_bundle, 'missing', [{'notes': None}, {'notes': ''}])
            assert page.evaluate('__lookupCalls') == 0
            page.close()
        check('Hotfix2: absent notes do not trigger any glyph lookup', optional_notes)
        def mixed_grid():
            cards = [{'notes': 'Synthetic notes', 'isAnimated': False, 'nsfw': True, 'humor': True, 'epilepsy': True,
                      'isDownloading': True, 'downloadProgress': 45},
                     {'notes': None, 'isAnimated': True, 'assetType': 'hero', 'width': 1920, 'height': 620},
                     {'notes': 'More notes', 'assetType': 'logo', 'width': 640, 'height': 240}]
            page = successful(new_bundle, 'missing', cards, 2)
            assert page.locator('.chip').count() == 6
            assert page.locator('.asset-download-progress').count() == 1
            assert page.evaluate('__lookupCalls') == 1
            page.close()
        check('Hotfix2: mixed asset types, content badges and progress preserve the grid', mixed_grid)
        def late_recovery():
            cards = [{'notes': 'Notes'} for _ in range(17)]
            page = successful(new_bundle, 'missing', cards, 17)
            assert page.evaluate('__lookupCalls') == 1
            page.evaluate('__lookupMode="native"; __clockOffset=3000;')
            page.evaluate('__renderCards', cards)
            assert page.evaluate('__caught') == []
            assert page.evaluate('__lookupCalls') == 2
            assert page.locator('[data-playhub-glyph="menu-fallback"]').count() == 0
            assert page.locator('.chip svg').count() == 17
            page.evaluate('__renderCards', cards)
            assert page.evaluate('__lookupCalls') == 2
            page.close()
        check('Hotfix2: one lookup per grid; a late Steam glyph recovers and is cached', late_recovery)
        def repeated():
            page = successful(new_bundle, 'native', [{'notes': 'First pass'}], 0)
            for _ in range(4):
                page.evaluate('SP_REACTDOM.flushSync(()=>__testRoot.render(null));')
                assert page.locator('.asset-box-wrap').count() == 0
                page.evaluate('__renderCards([{notes:"Reopened"}])')
                assert page.evaluate('__caught') == []
                assert page.locator('.asset-box-wrap').count() == 1
            page.evaluate('__testRoot.unmount();')
            page.close()
        check('Hotfix2: repeated close/reopen and unmount use the actual ReactDOM lifecycle', repeated)
        context.close()
        browser.close()
    report = {'build': '1.1.4-hotfix.2', 'renderer': 'Steam React/ReactDOM 19.1.1 in Chromium',
              'chromiumVersion': browser_version, 'passed': sum(r['passed'] for r in results),
              'failed': sum(not r['passed'] for r in results), 'results': results,
              'uncaughtBrowserErrors': browser_errors,
              'inputSha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [react_file, main_file]},
              'scope': 'Actual compiled Asset, Chips, FooterGlyph and plugin error boundary, actual Steam ReactDOM and native footer factory. Decky Focusable/API, button enums and localization are test adapters. No network and no live Steam client.'}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')
    print(json.dumps({k: report[k] for k in ['passed', 'failed', 'chromiumVersion', 'uncaughtBrowserErrors']}, indent=2))
    if report['failed'] or browser_errors:
        raise SystemExit(1)

if __name__ == '__main__':
    run()
