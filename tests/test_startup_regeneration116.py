"""Startup without difflib and the destructive Hero reset. No live Steam/account."""
import asyncio
import builtins
import difflib
import importlib.util
import json
import random
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from test_resource_safety import BACKEND, ROOT


def load_provider(without_difflib=False):
    original_import = builtins.__import__

    def restricted(name, *args, **kwargs):
        if name == 'difflib' or name.startswith('difflib.'):
            raise ModuleNotFoundError("No module named 'difflib'", name='difflib')
        return original_import(name, *args, **kwargs)

    spec = importlib.util.spec_from_file_location('provider_search_real_116', ROOT / 'provider_search.py')
    module = importlib.util.module_from_spec(spec)
    with patch('builtins.__import__', restricted if without_difflib else original_import):
        spec.loader.exec_module(module)
    return module


class ProviderStartup116Tests(unittest.TestCase):
    def test_real_provider_imports_without_difflib(self):
        provider = load_provider(True)
        self.assertIsNone(provider._SequenceMatcher)
        self.assertTrue(callable(provider.search_provider_assets))
        self.assertEqual(provider._title_score('Sonic Frontiers', 'Sonic Frontiers'), 1000)
        self.assertGreater(provider._title_score('Sonic Frontier', 'Sonic Fronties'), 0)

    def test_stdlib_is_used_when_available(self):
        self.assertIs(load_provider()._SequenceMatcher, difflib.SequenceMatcher)

    def test_fallback_matches_stdlib_on_edge_cases(self):
        provider = load_provider(True)
        for a, b in [('', ''), ('a', ''), ('', 'b'), ('ab', 'ba'), ('tide', 'diet'),
                     ('ab' * 200, 'ba' * 200), ('a' * 300, 'b' + 'a' * 300),
                     ('abc' * 90, 'ab' * 130), ('x' + 'a' * 200, 'x' + 'a' * 199 + 'b'),
                     ('Sonic Frontiers', 'Sonic Frontier'), ('Pokemon Gold', 'Pokémon Gold')]:
            with self.subTest(a=a[:30], b=b[:30]):
                self.assertEqual(provider._fallback_sequence_ratio(a, b), difflib.SequenceMatcher(None, a, b).ratio())

    def test_fallback_matches_stdlib_on_2000_reproducible_pairs(self):
        provider = load_provider(True)
        rng = random.Random(116)
        for index in range(2000):
            alphabet = 'abcdefghijklmnopqrstuvwxyz 0123456789' if index % 2 else 'abcde '
            length = rng.randrange(0, 85) if index < 1800 else rng.randrange(195, 380)
            a = ''.join(rng.choice(alphabet) for _ in range(length))
            b = list(a) if index % 3 else list(reversed(a))
            for _ in range(rng.randrange(0, 16)):
                if b:
                    b[rng.randrange(len(b))] = rng.choice(alphabet)
            b = ''.join(b)
            self.assertEqual(provider._fallback_sequence_ratio(a, b), difflib.SequenceMatcher(None, a, b).ratio(), index)

    def test_title_ranking_and_sequel_guard_match_with_or_without_stdlib(self):
        standard, fallback = load_provider(), load_provider(True)
        for query, candidate in [('Sonic Frontiers', 'Sonic Fronters'), ('Bioshock 2', 'Bioshock 3'),
                                 ('Doom Eternal', 'Doom'), ('Pokémon Gold', 'Pokemon Gold'),
                                 ('Half-Life', 'Half Life'), ('', ''), ('Completely different', 'Unrelated game')]:
            self.assertEqual(standard._title_score(query, candidate), fallback._title_score(query, candidate))
        self.assertEqual(fallback._title_score('Bioshock 2', 'Bioshock 3'), 0)

    def test_real_backend_and_provider_start_and_unload_without_difflib(self):
        original_import = builtins.__import__
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            decky = types.ModuleType('decky')
            for key, value in {
                'DECKY_PLUGIN_DIR': ROOT, 'DECKY_PLUGIN_LOG_DIR': directory / 'logs',
                'DECKY_PLUGIN_SETTINGS_DIR': directory / 'settings', 'DECKY_PLUGIN_RUNTIME_DIR': directory / 'runtime',
                'DECKY_USER_HOME': directory, 'DECKY_HOME': directory,
            }.items():
                setattr(decky, key, str(value))
            decky.logger = types.SimpleNamespace(debug=lambda *a, **k: None, warning=lambda *a, **k: None)
            decky.migrate_settings = lambda *a, **k: None
            settings = types.ModuleType('settings')
            settings.SettingsManager = lambda **kwargs: types.SimpleNamespace(**kwargs)
            helpers = types.ModuleType('helpers')
            helpers.get_ssl_context = lambda: None
            provider = load_provider(True)

            def restricted(name, *args, **kwargs):
                if name == 'difflib' or name.startswith('difflib.'):
                    raise ModuleNotFoundError("No module named 'difflib'", name='difflib')
                return original_import(name, *args, **kwargs)

            stubs = {'decky': decky, 'settings': settings, 'helpers': helpers, 'provider_search': provider}
            with patch.dict(sys.modules, stubs), patch('builtins.__import__', restricted):
                spec = importlib.util.spec_from_file_location('playhub_real_boot116', ROOT / 'main.py')
                backend = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(backend)

                async def check():
                    instance = backend.Plugin()
                    await instance._main()
                    try:
                        self.assertEqual(await instance.get_setting('missing', 'ok'), 'ok')
                        self.assertTrue(callable(backend.search_provider_assets_sync))
                        self.assertIs(backend.search_provider_assets_sync, provider.search_provider_assets)
                    finally:
                        await instance._unload()
                asyncio.run(check())


class PerfectHeroReset116Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.sources = self.root / 'sources'
        self.sources.mkdir()
        self.instance = BACKEND.Plugin()
        self.instance._download_executor = BACKEND.ThreadPoolExecutor(max_workers=2)
        self.instance._settings_lock = asyncio.Lock()
        self.instance._settings_data = {
            'perfect_hero_42': True, 'perfect_hero_info_42': {'origin': 'manual'},
            'zazamastro_hero_42': {'sha256': 'old'}, 'logo_hidden_42': True, 'logo_visible_42': False,
            'logo_position_backup_42': {'nWidthPct': 75},
            'perfect_grid_l_42': True, 'perfect_hero_43': True,
            'steamgriddb_api_key': 'synthetic-test-key', 'nonsteam_42': {'id': 17},
        }
        self.patches = [patch.object(BACKEND, 'PERFECT_SOURCE_DIR', self.sources),
                        patch.object(BACKEND, 'SETTINGS_FILE', self.root / 'settings.json'),
                        patch.object(BACKEND, 'SETTINGS_BACKUP_FILE', self.root / 'settings.json.bak'),
                        patch.object(BACKEND, '_diagnostic', lambda *a, **k: None)]
        for item in self.patches:
            item.start()

    async def asyncTearDown(self):
        self.instance._download_executor.shutdown(wait=True)
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    async def test_all_source_formats_and_partial_files_are_removed(self):
        for ext in ('png', 'jpg', 'jpeg', 'webp'):
            for suffix in ('', '.tmp'):
                (self.sources / f'42_hero.{ext}{suffix}').write_bytes(b'synthetic')
        for name in ('42_grid_l.png', '43_hero.jpg', '42_heroine.png'):
            (self.sources / name).write_bytes(b'untouched')
        self.assertTrue(await self.instance.clear_perfect_source(42, 'hero'))
        self.assertEqual(sorted(p.name for p in self.sources.iterdir()), ['42_grid_l.png', '42_heroine.png', '43_hero.jpg'])

    async def test_reset_clears_only_target_hero_state_and_restores_visibility(self):
        original = dict(self.instance._settings_data)
        (self.sources / '42_hero.png').write_bytes(b'old')
        self.assertTrue(await self.instance.clear_perfect_hero_state(42, True))
        actual = self.instance._settings_data
        for key in ('perfect_hero_42', 'perfect_hero_info_42', 'zazamastro_hero_42', 'logo_position_backup_42'):
            self.assertNotIn(key, actual)
        self.assertFalse(actual['logo_hidden_42'])
        self.assertTrue(actual['logo_visible_42'])
        for key in ('perfect_grid_l_42', 'perfect_hero_43', 'steamgriddb_api_key', 'nonsteam_42'):
            self.assertEqual(actual[key], original[key])
        self.assertFalse((self.sources / '42_hero.png').exists())
        self.assertEqual(json.loads((self.root / 'settings.json').read_text()), actual)

    async def test_orphan_state_cleanup_does_not_reset_unrelated_logo_visibility(self):
        self.assertTrue(await self.instance.clear_perfect_hero_state(42, False))
        self.assertTrue(self.instance._settings_data['logo_hidden_42'])
        self.assertFalse(self.instance._settings_data['logo_visible_42'])
        self.assertIn('logo_position_backup_42', self.instance._settings_data)

    async def test_invalid_identifiers_and_targets_do_not_delete_files(self):
        target = self.sources / '42_hero.png'
        target.write_bytes(b'old')
        for appid in (0, -42, 0x100000000, '../../42'):
            with self.assertRaises((ValueError, TypeError)):
                await self.instance.clear_perfect_hero_state(appid)
        self.assertFalse(await self.instance.clear_perfect_source(42, '../hero'))
        self.assertTrue(target.exists())

    async def test_failed_source_deletion_preserves_retry_markers(self):
        before = dict(self.instance._settings_data)
        with patch.object(self.instance, 'clear_perfect_source', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'PA_ERROR_PERFECT_HERO_RESET'):
                await self.instance.clear_perfect_hero_state(42)
        self.assertEqual(self.instance._settings_data, before)

    async def test_failed_settings_write_preserves_in_memory_retry_markers(self):
        before = dict(self.instance._settings_data)
        with patch.object(BACKEND, '_write_settings_file', side_effect=OSError('disk full')):
            with self.assertRaisesRegex(OSError, 'disk full'):
                await self.instance.clear_perfect_hero_state(42)
        self.assertEqual(self.instance._settings_data, before)

    async def test_reset_is_idempotent(self):
        await self.instance.clear_perfect_hero_state(42)
        expected = dict(self.instance._settings_data)
        self.assertTrue(await self.instance.clear_perfect_hero_state(42))
        self.assertEqual(self.instance._settings_data, expected)


if __name__ == '__main__':
    unittest.main()
