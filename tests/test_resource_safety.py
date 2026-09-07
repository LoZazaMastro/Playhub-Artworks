import importlib.util
import json
import sys
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load_backend():
    decky = types.ModuleType('decky')
    decky.DECKY_PLUGIN_DIR = str(ROOT)
    decky.DECKY_PLUGIN_LOG_DIR = str(ROOT / 'tests' / 'decky.log')
    decky.DECKY_PLUGIN_SETTINGS_DIR = str(ROOT / 'tests' / 'settings')
    decky.DECKY_PLUGIN_RUNTIME_DIR = str(ROOT / 'tests' / 'runtime')
    decky.DECKY_USER_HOME = str(ROOT / 'tests')
    decky.DECKY_HOME = str(ROOT / 'tests')
    decky.logger = types.SimpleNamespace(debug=lambda *_args, **_kwargs: None, warning=lambda *_args, **_kwargs: None)
    decky.migrate_settings = lambda *_args, **_kwargs: None

    settings = types.ModuleType('settings')
    settings.SettingsManager = object
    helpers = types.ModuleType('helpers')
    helpers.get_ssl_context = lambda: None
    providers = types.ModuleType('provider_search')
    for name in (
        'inspect_remote_artwork', 'search_provider_assets', 'search_playstation_games',
        'search_nintendo_games', 'search_igdb_games', 'search_xbox_games',
        'search_iidb_games', 'search_ign_games',
    ):
        setattr(providers, name, lambda *_args, **_kwargs: [])

    stubs = {'decky': decky, 'settings': settings, 'helpers': helpers, 'provider_search': providers}
    with patch.dict(sys.modules, stubs):
        spec = importlib.util.spec_from_file_location('playhub_artworks_backend_test', ROOT / 'main.py')
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
    return module


BACKEND = load_backend()


def png_header(width, height, suffix=b''):
    return b'\x89PNG\r\n\x1a\n' + (13).to_bytes(4, 'big') + b'IHDR' + width.to_bytes(4, 'big') + height.to_bytes(4, 'big') + suffix


class FakeResponse:
    def __init__(self, payload, content_length=None):
        self.payload = payload
        self.offset = 0
        self.headers = {
            'Content-Type': 'image/png',
            'Content-Length': str(len(payload) if content_length is None else content_length),
        }

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, amount):
        chunk = self.payload[self.offset:self.offset + amount]
        self.offset += len(chunk)
        return chunk


class ResourceSafetyTests(unittest.TestCase):
    def test_4k_artwork_is_accepted(self):
        asset_format, dimensions = BACKEND._validate_artwork_content(png_header(3840, 2160), source='test.png')
        self.assertEqual(asset_format, 'png')
        self.assertEqual(dimensions, (3840, 2160))

    def test_excessive_decoded_dimensions_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'PA_ERROR_ARTWORK_TOO_LARGE'):
            BACKEND._validate_artwork_content(png_header(5000, 4000), source='too-large.png')

    def test_content_length_is_rejected_before_reading(self):
        response = FakeResponse(png_header(1, 1), BACKEND.ARTWORK_DOWNLOAD_MAX_BYTES + 1)
        with patch.object(BACKEND, 'urlopen', return_value=response):
            with self.assertRaisesRegex(ValueError, 'PA_ERROR_ARTWORK_TOO_LARGE'):
                BACKEND._download_limited('https://example.invalid/large.png')
        self.assertEqual(response.offset, 0)

    def test_stream_without_length_is_still_bounded(self):
        response = FakeResponse(png_header(1, 1, b'x' * 64), content_length=0)
        with patch.object(BACKEND, 'ARTWORK_DOWNLOAD_MAX_BYTES', 32), patch.object(BACKEND, 'urlopen', return_value=response):
            with self.assertRaisesRegex(ValueError, 'PA_ERROR_ARTWORK_TOO_LARGE'):
                BACKEND._download_limited('https://example.invalid/chunked.png')

    def test_shutdown_cancels_active_download(self):
        response = FakeResponse(png_header(1, 1))
        stopped = threading.Event()
        stopped.set()
        with patch.object(BACKEND, 'urlopen', return_value=response):
            with self.assertRaisesRegex(RuntimeError, 'PA_OPERATION_CANCELLED'):
                BACKEND._download_limited('https://example.invalid/cancel.png', shutdown_event=stopped)

    def test_frontend_bulk_limits_and_cleanup_are_present(self):
        source = (ROOT / 'src' / 'utils' / 'zazamastroBatch.ts').read_text(encoding='utf-8')
        self.assertIn('const ZAZA_PREPARE_CONCURRENCY = 1;', source)
        self.assertIn('const STANDARD_PREPARE_CONCURRENCY = 2;', source)
        self.assertIn('preparedForRelease.data = undefined', source)
        self.assertIn('releaseCanvas(canvas)', source)
        self.assertIn('throwIfCancelled(signal)', source)

    def test_release_metadata_is_1_1_1(self):
        package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
        release = json.loads((ROOT / '.playhub-release.json').read_text(encoding='utf-8'))
        self.assertEqual(package['version'], '1.1.1')
        self.assertEqual(release['version'], '1.1.1')


if __name__ == '__main__':
    unittest.main()
