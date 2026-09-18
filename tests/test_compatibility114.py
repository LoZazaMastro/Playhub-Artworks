import asyncio
import importlib.util
import ssl
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request
from unittest.mock import patch
from test_resource_safety import BACKEND, ROOT, FakeResponse, png_header

spec = importlib.util.spec_from_file_location('artworks_provider_test', ROOT / 'provider_search.py')
PROVIDER = importlib.util.module_from_spec(spec)
spec.loader.exec_module(PROVIDER)


class Compatibility114Tests(unittest.TestCase):
    def test_large_source_can_be_composed_without_relaxing_output_limit(self):
        image = png_header(7680, 4320)
        self.assertEqual(BACKEND._validate_artwork_content(image, allow_source=True)[1], (7680, 4320))
        with self.assertRaisesRegex(ValueError, 'PA_ERROR_ARTWORK_TOO_LARGE'):
            BACKEND._validate_artwork_content(image)
        with self.assertRaisesRegex(ValueError, 'PA_ERROR_ARTWORK_TOO_LARGE'):
            BACKEND._validate_artwork_content(png_header(16000, 16000), allow_source=True)

    def test_source_byte_limit_remains_16_mib(self):
        self.assertEqual(BACKEND.ARTWORK_DOWNLOAD_MAX_BYTES, 16 * 1024 * 1024)
        with patch.object(BACKEND, 'ARTWORK_DOWNLOAD_MAX_BYTES', 24):
            with self.assertRaisesRegex(ValueError, 'PA_ERROR_ARTWORK_TOO_LARGE'):
                BACKEND._validate_artwork_content(png_header(7680, 4320, b'overflow'), allow_source=True)

    def test_remote_large_source_reaches_normalizer_with_dimensions(self):
        plugin = BACKEND.Plugin()
        plugin._download_executor = BACKEND.ThreadPoolExecutor(max_workers=1)
        plugin._shutdown_event = threading.Event()
        plugin._download_semaphore = asyncio.Semaphore(2)
        try:
            with patch.object(BACKEND, 'urlopen', return_value=FakeResponse(png_header(7680, 4320))):
                result = asyncio.run(plugin.download_artwork_payload('https://example.invalid/test.png'))
                self.assertEqual(result['dimensions'], (7680, 4320))
                self.assertEqual(result['format'], 'png')
        finally:
            plugin._download_executor.shutdown(wait=True)

    def test_iidb_title_queries_are_typed_encoded_and_deduplicated(self):
        calls = []
        def request(url, **_kwargs):
            query = parse_qs(urlparse(url).query)
            calls.append(query)
            self.assertEqual(query['q'], ['Café & Game'])
            self.assertIn(query['asset_type'][0], ('hero', 'banner', 'logo', 'icon'))
            return {'groups': [{'parent': {'id': 12, 'name': 'Café & Game'}}]}
        with patch.object(PROVIDER, '_json_request', side_effect=request):
            games = PROVIDER.search_iidb_games('Café & Game')
        self.assertEqual(games, [{'id': '12', 'name': 'Café & Game'}])
        self.assertEqual(len(calls), 4)

    def test_iidb_blank_query_never_requests_network(self):
        with patch.object(PROVIDER, '_json_request') as request:
            self.assertEqual(PROVIDER.search_iidb_games('   '), [])
            request.assert_not_called()

    def test_iidb_selected_parent_is_not_replaced_by_title_autocomplete(self):
        calls = []
        def request(url, **_kwargs):
            calls.append(url)
            self.assertIn('/assets/browse/enriched?', url)
            self.assertEqual(parse_qs(urlparse(url).query)['parent_id'], ['picked-parent'])
            return {'items': [{'raw_url': 'https://assets.iisu.network/test.png', 'resolution_width': 1920,
                              'resolution_height': 620, 'mime_type': 'image/png'}]}
        with patch.object(PROVIDER, '_json_request', side_effect=request):
            result = PROVIDER.search_provider_assets('iidb', 'Any title', 'hero', query='picked-parent')
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(result), 1)

    def test_iidb_failure_is_not_successful_empty_search(self):
        error = HTTPError('https://example.invalid', 400, 'Bad Request', {}, None)
        with patch.object(PROVIDER, '_json_request', side_effect=error):
            with self.assertRaises(HTTPError):
                PROVIDER.search_iidb_games('Game')

    def test_transient_tls_eof_get_is_retried_once(self):
        with patch.object(PROVIDER, 'urlopen', side_effect=[URLError(ssl.SSLEOFError('EOF')), FakeResponse(b'{}')]) as request, patch.object(PROVIDER.time, 'sleep'):
            self.assertEqual(PROVIDER._json_request('https://example.invalid'), {})
            self.assertEqual(request.call_count, 2)

    def test_400_is_not_retried(self):
        error = HTTPError('https://example.invalid', 400, 'Bad Request', {}, None)
        with patch.object(PROVIDER, 'urlopen', side_effect=error) as request:
            with self.assertRaises(HTTPError):
                PROVIDER._json_request('https://example.invalid')
            self.assertEqual(request.call_count, 1)

    def test_post_is_not_retried(self):
        with patch.object(PROVIDER, 'urlopen', side_effect=ssl.SSLEOFError('EOF')) as request:
            with self.assertRaises(ssl.SSLEOFError):
                PROVIDER._json_request('https://example.invalid', {'query': 'game'})
            self.assertEqual(request.call_count, 1)

    def test_provider_response_is_bounded(self):
        with patch.object(PROVIDER, 'urlopen', return_value=FakeResponse(b'12345')):
            with self.assertRaisesRegex(ValueError, 'size limit'):
                PROVIDER._read_request(Request('https://example.invalid'), 4, 1)

    def test_backend_provider_exception_survives_rpc(self):
        plugin = BACKEND.Plugin()
        plugin._provider_executor = BACKEND.ThreadPoolExecutor(max_workers=1)
        error = HTTPError('https://example.invalid', 400, 'Bad Request', {}, None)
        try:
            with patch.object(BACKEND, 'search_provider_assets_sync', side_effect=error):
                with self.assertRaises(HTTPError):
                    asyncio.run(plugin.search_provider_assets('iidb', 'Game', 'hero'))
        finally:
            plugin._provider_executor.shutdown(wait=True)


if __name__ == '__main__':
    unittest.main()
