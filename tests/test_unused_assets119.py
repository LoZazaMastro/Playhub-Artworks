"""Real VDF parsing and on-demand cleanup; fixtures never touch the user's assets."""
import asyncio
import io
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_resource_safety import BACKEND
from unused_assets import inventory, clean_sources


class UnusedAssets119Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.steam = self.root / 'Steam'
        self.library = self.steam / 'steamapps'
        self.library.mkdir(parents=True)
        self.account = self.steam / 'userdata' / '123' / 'config'
        self.account.mkdir(parents=True)
        self.sources = self.root / 'perfect_sources'
        self.sources.mkdir()
        self.folders = self.library / 'libraryfolders.vdf'
        self.folders.write_text('"libraryfolders"\n{\n"0"\n{\n"path" "' + self.steam.as_posix() + '"\n}\n}\n')
        self.binary(self.account, {})

    def tearDown(self):
        self.temporary.cleanup()

    def binary(self, account, entries):
        account.mkdir(parents=True, exist_ok=True)
        output = io.BytesIO()
        BACKEND.binary_dump({'shortcuts': entries}, output)
        (account / 'shortcuts.vdf').write_bytes(output.getvalue())

    def snapshot(self):
        return inventory(self.steam, BACKEND.parse, BACKEND.binary_load)

    def asset(self, name):
        path = self.sources / name
        path.write_bytes(b'fixture-image')
        return path

    def native(self, app=42):
        (self.library / f'appmanifest_{app}.acf').write_text(f'"AppState"\n{{\n"appid" "{app}"\n}}\n')

    def test_installed_native_and_removed_sources(self):
        self.native()
        active = self.asset('42_hero.png')
        removed = self.asset('43_banner.jpg')
        result = clean_sources(self.sources, self.snapshot())
        self.assertEqual(result, dict(removed=1, bytes=13, errors=0, inventoryComplete=True))
        self.assertTrue(active.exists()); self.assertFalse(removed.exists())

    def test_all_users_and_signed_shortcut_ids(self):
        self.binary(self.account, {'0': {'appid': -2147483638}})
        other = self.steam / 'userdata' / '456' / 'config'
        self.binary(other, {'0': {'appid': -2147483628}})
        active = [self.asset('2147483658_hero.jpg'), self.asset('2147483668_banner.webp')]
        removed = self.asset('2147483678_hero.png')
        self.assertEqual(clean_sources(self.sources, self.snapshot())['removed'], 1)
        self.assertTrue(all(p.exists() for p in active)); self.assertFalse(removed.exists())

    def test_dry_run_does_not_write(self):
        asset = self.asset('42_banner.jpg')
        self.assertEqual(clean_sources(self.sources, self.snapshot(), True)['removed'], 1)
        self.assertTrue(asset.exists())

    def test_disconnected_library_preserves_native_sources(self):
        self.folders.write_text('"libraryfolders"\n{\n"1"\n{\n"path" "' + (self.root/'offline').as_posix() + '"\n}\n}\n')
        native = self.asset('42_hero.png')
        shortcut = self.asset('2147483658_banner.png')
        result = clean_sources(self.sources, self.snapshot())
        self.assertFalse(result['inventoryComplete']); self.assertTrue(native.exists()); self.assertFalse(shortcut.exists())

    def test_missing_library_inventory_preserves(self):
        self.folders.unlink()
        asset = self.asset('42_hero.png')
        self.assertFalse(clean_sources(self.sources, self.snapshot())['inventoryComplete']); self.assertTrue(asset.exists())

    def test_malformed_text_inventory_preserves(self):
        for payload in ('"libraryfolders"\n{', '"libraryfolders"\n{\n"path" "unfinished\n}', '"other"\n{\n}\n'):
            with self.subTest(payload=payload):
                self.folders.write_text(payload)
                asset = self.asset('42_banner.png')
                self.assertFalse(clean_sources(self.sources, self.snapshot())['inventoryComplete']); self.assertTrue(asset.exists())

    def test_malformed_manifest_preserves(self):
        (self.library/'appmanifest_42.acf').write_text('"AppState"\n{\n"appid" "oops"\n}\n')
        asset = self.asset('43_banner.webp')
        self.assertFalse(clean_sources(self.sources, self.snapshot())['inventoryComplete']); self.assertTrue(asset.exists())

    def test_invalid_native_identity_preserves(self):
        self.native(0x80000001)
        asset = self.asset('43_banner.webp')
        self.assertFalse(clean_sources(self.sources, self.snapshot())['inventoryComplete']); self.assertTrue(asset.exists())

    def test_truncated_and_trailing_binary_preserves_shortcuts(self):
        original = (self.account/'shortcuts.vdf').read_bytes()
        for data in (original[:-1], b'\x00shortcuts\x00\x00broken\x00\x08\x08', original+b'extra\x08\x08', b'\x08\x08'):
            with self.subTest(data=data):
                (self.account/'shortcuts.vdf').write_bytes(data)
                asset = self.asset('2147483658_hero.png')
                self.assertFalse(clean_sources(self.sources, self.snapshot())['inventoryComplete']); self.assertTrue(asset.exists())

    def test_missing_account_config_preserves_shortcuts(self):
        (self.steam/'userdata'/'456').mkdir()
        asset = self.asset('2147483658_hero.png')
        self.assertFalse(clean_sources(self.sources, self.snapshot())['inventoryComplete']); self.assertTrue(asset.exists())

    def test_missing_shortcut_file_is_valid_empty_inventory(self):
        (self.account/'shortcuts.vdf').unlink()
        self.assertTrue(self.snapshot()[3])

    def test_invalid_shortcut_identity_preserves(self):
        self.binary(self.account, {'0': {'appid': 12}})
        asset = self.asset('2147483658_hero.png')
        self.assertFalse(clean_sources(self.sources, self.snapshot())['inventoryComplete']); self.assertTrue(asset.exists())

    def test_unknown_files_subdirectories_backups_and_steam_assets_untouched(self):
        untouched = [self.asset(name) for name in ('custom.png','0_hero.png','4294967296_hero.png','42_hero.png.tmp','42_logo.png')]
        backup = self.root/'derived_cover_backups'/'original.png'; backup.parent.mkdir(); backup.write_bytes(b'original')
        grid = self.account/'grid'/'43_hero.png'; grid.parent.mkdir(); grid.write_bytes(b'Steam')
        nested = self.sources/'nested'/'43_hero.png'; nested.parent.mkdir(); nested.write_bytes(b'nested')
        self.assertEqual(clean_sources(self.sources, self.snapshot())['removed'], 0)
        self.assertTrue(all(p.exists() for p in [*untouched, backup, grid, nested]))

    def test_actual_backend_method_dry_run_then_remove(self):
        instance = BACKEND.Plugin()
        asset = self.asset('42_hero.png')
        with patch.object(BACKEND, 'get_steam_path', return_value=self.steam), patch.object(BACKEND, 'PERFECT_SOURCE_DIR', self.sources):
            self.assertEqual(asyncio.run(instance.clean_unused_artwork(True))['removed'], 1)
            self.assertTrue(asset.exists())
            self.assertEqual(asyncio.run(instance.clean_unused_artwork())['removed'], 1)
            self.assertFalse(asset.exists())

    def test_actual_perfect_banner_and_hero_paths_are_cleaned(self):
        from test_artwork_transfer116 import png
        instance = BACKEND.Plugin()
        with patch.object(BACKEND, 'PERFECT_SOURCE_DIR', self.sources):
            hero = instance._write_perfect_source(42, 'hero', png(), 'png')
            banner = instance._write_perfect_source(42, 'grid_l', png(), 'png')
            self.assertEqual(banner.name, '42_grid_l.png')
            self.assertEqual(clean_sources(self.sources, self.snapshot())['removed'], 2)
            self.assertFalse(hero.exists()); self.assertFalse(banner.exists())

    def test_transfer_source_write_waits_for_cleanup_lock(self):
        from test_artwork_transfer116 import plugin, png
        instance = plugin()
        executor = ThreadPoolExecutor(max_workers=1)
        instance._download_executor = executor
        input_path = self.root/'input.png'; input_path.write_bytes(png())
        async def run():
            with patch.object(BACKEND, 'PERFECT_SOURCE_DIR', self.sources), patch.object(BACKEND, 'ARTWORK_TRANSFER_DIR', self.root/'transfers'):
                info = await instance.prepare_artwork_transfer(path=str(input_path))
                instance._derived_cover_lock.acquire()
                try:
                    pending = asyncio.create_task(instance.preserve_perfect_source_from_transfer(42, 'grid_l', info['token'], True))
                    await asyncio.sleep(.04)
                    self.assertFalse(pending.done())
                    self.assertFalse((self.sources/'42_grid_l.png').exists())
                finally:
                    instance._derived_cover_lock.release()
                self.assertTrue((await asyncio.wait_for(pending, 2))['saved'])
                self.assertTrue((self.sources/'42_grid_l.png').exists())
        try: asyncio.run(run())
        finally: executor.shutdown(wait=True)

    @unittest.skipUnless(os.name == 'nt', 'Windows junctions')
    def test_actual_windows_root_and_child_junctions_preserve_external_files(self):
        outside = self.root/'outside'; outside.mkdir()
        asset = outside/'42_grid_l.png'; asset.write_bytes(b'external')
        link = self.root/'linked-sources'
        child = self.sources/'43_hero.png'
        def junction(path):
            command = "New-Item -ItemType Junction -Path '" + str(path).replace("'", "''") + "' -Target '" + str(outside).replace("'", "''") + "' | Out-Null"
            subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',command], check=True, capture_output=True)
        junction(link); junction(child)
        try:
            self.assertEqual(clean_sources(link, self.snapshot())['removed'], 0)
            self.assertEqual(clean_sources(self.sources, self.snapshot())['removed'], 0)
            self.assertTrue(asset.exists())
        finally:
            link.rmdir(); child.rmdir()

    def test_every_localization_has_cleanup_copy_and_tokens(self):
        paths = list((Path(__file__).resolve().parents[1]/'src/i18n').glob('*.json'))
        self.assertEqual(len(paths), 31)
        for path in paths:
            data = json.loads(path.read_text(encoding='utf-8'))
            for key in ('PA_CLEAN_UNUSED','PA_CLEAN_UNUSED_DESC','PA_CLEAN_UNUSED_PARTIAL'):
                self.assertTrue(data[key], path.name)
            self.assertIn('{count}', data['PA_CLEAN_UNUSED_RESULT']); self.assertIn('{size}', data['PA_CLEAN_UNUSED_RESULT'])


if __name__ == '__main__': unittest.main()
