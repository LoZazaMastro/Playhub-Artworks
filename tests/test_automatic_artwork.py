"""Strict local-state proof and staging; temporary fixtures, no live Steam files."""
import importlib.util
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('auto_artwork_test', Path(__file__).resolve().parents[1] / 'automatic_artwork.py')
AUTO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUTO)

class AutomaticArtworkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.userdata = self.root / 'userdata'
        self.config = self.userdata / '42' / 'config'
        self.config.mkdir(parents=True)
        (self.config/'shortcuts.vdf').write_bytes(b'read-only fixture')
        self.library = self.root / 'librarycache'
        self.library.mkdir()
        self.rows = {'shortcuts': {'0': {'appid': -1294967295, 'icon': ''}}}
    def tearDown(self):
        self.temp.cleanup()
    def status(self, shortcut=True, active=lambda:'42'):
        return AUTO.status(self.userdata, self.library, 3000000001, '42', active, shortcut, lambda _path:self.rows)
    def test_missing_assets_are_separate_and_existing_custom_is_preserved_even_if_unreadable_image(self):
        self.assertTrue(all(not item['exists'] for item in self.status()['assets'].values()))
        grid=self.config/'grid'
        grid.mkdir()
        (grid/'3000000001P.PNG').write_bytes(b'not decoded: user choice still exists')
        result=self.status()
        self.assertTrue(result['assets']['grid_p']['exists'])
        self.assertFalse(result['assets']['hero']['exists'])
        self.rows['shortcuts']['0']['icon']='C:\\Manual\\Icon.ico'
        self.assertTrue(self.status()['assets']['icon']['exists'])
    def test_wrong_user_missing_shortcut_and_missing_directory_are_unknown(self):
        with self.assertRaises(ValueError):self.status(active=lambda:'43')
        self.rows={'shortcuts':{}}
        with self.assertRaises(ValueError):self.status()
        (self.config/'shortcuts.vdf').unlink()
        self.config.rmdir()
        with self.assertRaises(ValueError):self.status(shortcut=False)
    def test_existing_official_art_is_preserved(self):
        app=self.library/'3000000001'
        app.mkdir()
        (app/'library_hero.jpg').write_bytes(b'official')
        self.assertTrue(self.status(shortcut=False)['assets']['hero']['exists'])
    def test_icon_staging_writes_only_private_hash_path_never_grid_or_vdf(self):
        private=self.root/'private'
        content=b'synthetic already-validated PNG'
        inspect=lambda _data:{'format':'png','dimensions':(128,128),'animated':False}
        result=AUTO.stage_icon(private,content,3000000001,'42',lambda:'42',inspect)
        self.assertEqual(Path(result['path']).read_bytes(),content)
        self.assertEqual(Path(result['path']).parent,private)
        self.assertFalse((self.config/'grid').exists())
        self.assertEqual(AUTO.stage_icon(private,content,3000000001,'42',lambda:'42',inspect),result)
        with self.assertRaises(ValueError):AUTO.stage_icon(private,content,3000000001,'42',lambda:'43',inspect)
        with self.assertRaises(ValueError):AUTO.stage_icon(private,content,3000000001,'42',lambda:'42',lambda _data:{'format':'webp','dimensions':(128,128),'animated':False})
    def test_unknown_read_and_malformed_shortcut_are_not_missing_art(self):
        with patch.object(AUTO.os,'scandir',side_effect=PermissionError('read denied')):
            (self.config/'grid').mkdir()
            with self.assertRaises(PermissionError):self.status()
        self.rows={'shortcuts':{'0':{'appid':'invalid','icon':''}}}
        with self.assertRaises(ValueError):self.status()
    def test_account_change_after_read_and_invalid_private_stage_identifiers_refuse(self):
        users=iter(['42','43'])
        with self.assertRaises(ValueError):self.status(active=lambda:next(users))
        inspect=lambda _data:{'format':'png','dimensions':(128,128),'animated':False}
        for appid,user in [('../escape','42'),(3000000001,'../user'),(0,'42')]:
            with self.assertRaises(ValueError):AUTO.stage_icon(self.root/'private',b'pixels',appid,user,lambda:user,inspect)
        self.assertFalse((self.root/'private').exists())
