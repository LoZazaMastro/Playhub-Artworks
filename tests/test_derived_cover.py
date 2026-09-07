import base64
import hashlib
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from test_resource_safety import BACKEND, png_header


class DerivedCoverTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.cover = root / 'userdata' / '123' / 'config' / 'grid' / '42p.png'
        self.cover.parent.mkdir(parents=True)
        self.original = png_header(600, 900, b'original')
        self.derived = png_header(600, 900, b'derived')
        self.digest = hashlib.sha256(self.derived).hexdigest()
        self.cover.write_bytes(self.original)
        for target, value in (
            ('DERIVED_COVER_BACKUP_DIR', root / 'backups'),
            ('get_steam_userdata', lambda: root / 'userdata'),
            ('_diagnostic', lambda *args, **kwargs: None),
        ):
            mock = patch.object(BACKEND, target, value)
            mock.start()
            self.addCleanup(mock.stop)
        self.plugin = BACKEND.Plugin()
        self.plugin._download_executor = None
        self.plugin._derived_cover_lock = threading.Lock()

    async def apply(self):
        result = await self.plugin.preserve_derived_cover_backup('123', 42)
        self.assertTrue(result['saved'])
        self.assertTrue(await self.plugin.begin_derived_cover_apply('123', 42, self.digest))
        self.cover.write_bytes(self.derived)
        self.assertTrue(await self.plugin.finalize_derived_cover_apply('123', 42, self.digest))

    async def test_round_trip_keeps_original_until_verified_restore(self):
        await self.apply()
        self.assertTrue(await self.plugin.begin_derived_cover_restore('123', 42))
        restored = base64.b64decode(await self.plugin.read_derived_cover_backup_chunk('123', 42, 0))
        self.assertEqual(restored, self.original)
        original_digest = hashlib.sha256(restored).hexdigest()
        self.assertTrue(await self.plugin.prepare_derived_cover_restore('123', 42, original_digest))
        self.assertFalse(await self.plugin.complete_derived_cover_restore('123', 42))
        self.cover.write_bytes(restored)
        self.assertTrue(await self.plugin.complete_derived_cover_restore('123', 42))

    async def test_manually_replaced_cover_becomes_the_new_backup(self):
        await self.apply()
        replacement = png_header(600, 900, b'new-manual-cover')
        self.cover.write_bytes(replacement)
        result = await self.plugin.preserve_derived_cover_backup('123', 42)
        self.assertTrue(result['saved'])
        self.assertTrue(result['replaced'])
        info = await self.plugin.get_derived_cover_backup_info('123', 42)
        self.assertEqual(info['sha256'], hashlib.sha256(replacement).hexdigest())
        self.assertFalse(info['recoverable'])

    async def test_interrupted_apply_remains_recoverable_after_reload(self):
        await self.plugin.preserve_derived_cover_backup('123', 42)
        await self.plugin.begin_derived_cover_apply('123', 42, self.digest)
        self.cover.unlink()
        info = await self.plugin.get_derived_cover_backup_info('123', 42)
        self.assertTrue(info['recoverable'])
        self.assertEqual(info['state'], 'pending')
        result = await self.plugin.preserve_derived_cover_backup('123', 42)
        self.assertFalse(result['saved'])
        self.assertTrue(await self.plugin.begin_derived_cover_restore('123', 42, True))
        self.assertEqual(base64.b64decode(await self.plugin.read_derived_cover_backup_chunk('123', 42, 0)), self.original)

    async def test_user_replacement_is_not_overwritten_by_old_restore(self):
        await self.apply()
        replacement = png_header(600, 900, b'manual-after-apply')
        self.cover.write_bytes(replacement)
        self.assertFalse(await self.plugin.begin_derived_cover_restore('123', 42))
        self.assertEqual(self.cover.read_bytes(), replacement)


if __name__ == '__main__':
    unittest.main()
