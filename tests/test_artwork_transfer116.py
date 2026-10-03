"""1.1.6 transfer tests. Synthetic public artwork only; no live Steam/SGDB account."""
import asyncio
import base64
import hashlib
import io
import struct
import tempfile
import threading
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from test_resource_safety import BACKEND, FakeResponse


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)


def png(width=2, height=2, padding=0, animated=False):
    header = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    if padding:
        header += chunk(b'tEXt', b'Comment\0' + b'x' * padding)
    if animated:
        header += chunk(b'acTL', struct.pack('>II', 2, 0))
    return header + chunk(b'IDAT', zlib.compress(b'\x00' + bytes(8))) + chunk(b'IEND', b'')


def plugin():
    instance = BACKEND.Plugin()
    instance._download_executor = BACKEND.ThreadPoolExecutor(max_workers=2)
    instance._download_semaphore = asyncio.Semaphore(2)
    instance._shutdown_event = threading.Event()
    instance._transfer_lock = threading.RLock()
    instance._transfer_jobs = {}
    instance._transfers = {}
    return instance


class Transfer116Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.plugin = plugin()
        self.patches = [patch.object(BACKEND, 'ARTWORK_TRANSFER_DIR', self.root/'transfers'),
                        patch.object(BACKEND, 'PERFECT_SOURCE_DIR', self.root/'originals'),
                        patch.object(BACKEND, '_diagnostic', lambda *_a, **_k: None)]
        for p in self.patches:
            p.start()

    async def asyncTearDown(self):
        self.plugin._shutdown_event.set()
        self.plugin._download_executor.shutdown(wait=True)
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    async def test_over_16_mib_download_roundtrips_in_small_messages_and_preserves_original(self):
        source = png(3840, 1240, 17*1024*1024)
        with patch.object(BACKEND, 'urlopen', return_value=FakeResponse(source)):
            info = await self.plugin.prepare_artwork_transfer('https://cdn2.steamgriddb.com/hero/test.png')
        self.assertNotIn('data', info)
        self.assertEqual(info['dimensions'], (3840, 1240))
        output = bytearray()
        for offset in range(0, info['size'], info['chunk_size']):
            data = await self.plugin.read_artwork_transfer_chunk(info['token'], offset)
            self.assertLessEqual(len(data), 336*1024)
            output.extend(base64.b64decode(data))
        self.assertEqual(output, source)
        self.assertEqual(hashlib.sha256(output).hexdigest(), info['sha256'])
        result = await self.plugin.preserve_perfect_source_from_transfer(42, 'hero', info['token'], True)
        self.assertTrue(result['saved'])
        self.assertEqual((self.root/'originals/42_hero.png').read_bytes(), source)
        await self.plugin.release_artwork_transfer(info['token'])
        self.assertEqual(list((self.root/'transfers').iterdir()), [])

    async def test_local_snapshot_survives_original_replacement(self):
        path = self.root/'logo.png'; data = png(); path.write_bytes(data)
        info = await self.plugin.prepare_artwork_transfer(path=str(path))
        path.write_bytes(png(3, 3))
        read = await self.plugin.read_artwork_transfer_chunk(info['token'], 0)
        self.assertEqual(base64.b64decode(read), data)

    async def test_invalid_content_is_rejected_and_temporary_file_removed(self):
        with patch.object(BACKEND, 'urlopen', return_value=FakeResponse(b'<html>CDN error</html>')):
            with self.assertRaisesRegex(ValueError, 'PA_ERROR_ARTWORK_FORMAT_UNKNOWN'):
                await self.plugin.prepare_artwork_transfer('https://cdn2.steamgriddb.com/hero/error.png')
        self.assertEqual(list((self.root/'transfers').iterdir()), [])
        self.assertEqual(self.plugin._transfer_jobs, {})

    async def test_source_pixel_bomb_rejected(self):
        path=self.root/'bomb.png'; path.write_bytes(png(32768,32768))
        with self.assertRaisesRegex(ValueError, 'PA_ERROR_ARTWORK_TOO_LARGE'):
            await self.plugin.prepare_artwork_transfer(path=str(path))

    async def test_animation_detected_after_large_ancillary_metadata(self):
        path=self.root/'animated.png'; path.write_bytes(png(20,20, 3*1024*1024, True))
        info=await self.plugin.prepare_artwork_transfer(path=str(path))
        self.assertTrue(info['animated'])

    async def test_chunk_offsets_and_unknown_tokens_rejected(self):
        path=self.root/'logo.png';path.write_bytes(png())
        info=await self.plugin.prepare_artwork_transfer(path=str(path))
        for offset in (-1, 1, info['size']):
            with self.assertRaises(ValueError):
                await self.plugin.read_artwork_transfer_chunk(info['token'], offset)
        with self.assertRaises(ValueError):
            await self.plugin.read_artwork_transfer_chunk('../some-file', 0)
        with self.assertRaisesRegex(ValueError, 'PA_ERROR_TRANSFER_EXPIRED'):
            await self.plugin.read_artwork_transfer_chunk('0'*32, 0)

    async def test_expired_tokens_remove_payload(self):
        path=self.root/'logo.png';path.write_bytes(png())
        info=await self.plugin.prepare_artwork_transfer(path=str(path))
        self.plugin._transfers[info['token']]['touched'] -= BACKEND.ARTWORK_TRANSFER_TTL+1
        with self.assertRaisesRegex(ValueError,'PA_ERROR_TRANSFER_EXPIRED'):
            await self.plugin.read_artwork_transfer_chunk(info['token'],0)
        self.assertEqual(list((self.root/'transfers').iterdir()), [])

    async def test_cancel_during_download_cleans_partial_file(self):
        instance=self.plugin
        class CancellingResponse(FakeResponse):
            def read(self, n):
                result=super().read(n)
                instance._transfer_jobs['cancel-test'].set()
                return result
        with patch.object(BACKEND,'urlopen',return_value=CancellingResponse(png(padding=300000))):
            with self.assertRaisesRegex(RuntimeError,'PA_OPERATION_CANCELLED'):
                await instance.prepare_artwork_transfer('https://example.invalid/test.png',job_id='cancel-test')
        self.assertEqual(list((self.root/'transfers').iterdir()), [])
        self.assertFalse(instance._transfers)

    async def test_404_is_not_retried(self):
        with patch.object(BACKEND,'urlopen',side_effect=HTTPError('https://example.invalid',404,'missing',{},io.BytesIO())) as request:
            with self.assertRaises(HTTPError):
                await self.plugin.prepare_artwork_transfer('https://example.invalid/test.png')
            self.assertEqual(request.call_count,1)

    async def test_retry_transient_503_without_forwarding_api_key(self):
        with patch.object(BACKEND,'urlopen',side_effect=[HTTPError('https://example.invalid',503,'unavailable',{},io.BytesIO()),FakeResponse(png())]) as request:
            info=await self.plugin.prepare_artwork_transfer('https://cdn2.steamgriddb.com/hero/test.png')
            self.assertEqual(request.call_count,2)
            headers=request.call_args.args[0].headers
            self.assertNotIn('Authorization',headers)
            self.assertEqual(headers['Referer'],'https://www.steamgriddb.com/')
            self.assertTrue(info['token'])

    async def test_legacy_rpc_size_cap_is_not_relaxed(self):
        path=self.root/'large.png'
        with path.open('wb') as handle:
            handle.write(png());handle.truncate(17*1024*1024)
        for method in [self.plugin.read_file_as_base64,self.plugin.read_artwork_payload]:
            with self.assertRaisesRegex(ValueError,'PA_ERROR_ARTWORK_TOO_LARGE'):
                await method(str(path))

    async def test_failed_preparation_does_not_overwrite_existing_pristine_background(self):
        original=self.root/'originals/42_hero.png'; original.parent.mkdir();original.write_bytes(png())
        with self.assertRaisesRegex(ValueError,'PA_ERROR_TRANSFER_EXPIRED'):
            await self.plugin.preserve_perfect_source_from_transfer(42,'hero','0'*32,True)
        self.assertEqual(original.read_bytes(),png())


if __name__ == '__main__':
    unittest.main()
