import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PATCH = ROOT / 'src' / 'patches' / 'disableLibraryLetterHold.ts'


class DisableLibraryLetterHoldTests(unittest.TestCase):
    def test_every_locale_has_setting_copy(self):
        required = {
            'PA_DISABLE_LIBRARY_LETTER_HOLD',
            'PA_DISABLE_LIBRARY_LETTER_HOLD_DESC',
        }
        locales = list((ROOT / 'src' / 'i18n').glob('*.json'))
        self.assertGreaterEqual(len(locales), 30)
        for locale in locales:
            strings = json.loads(locale.read_text(encoding='utf-8'))
            self.assertTrue(required.issubset(strings), locale.name)
            for key in required:
                self.assertTrue(strings[key].strip(), f'{locale.name}: {key}')

    def test_patch_targets_only_steam_library_fast_scroll_hold(self):
        source = PATCH.read_text(encoding='utf-8')
        self.assertIn('AppGridFastScroll', source)
        self.assertIn("isSquareLibraryRoute()", source)
        self.assertIn("GamepadLibrary", source)
        self.assertIn("LibraryItemBox", source)
        self.assertIn("event.detail?.is_repeat === true", source)
        self.assertIn("GamepadButton.DIR_UP", source)
        self.assertIn("GamepadButton.DIR_DOWN", source)
        self.assertIn("'vgp_onbuttondown'", source)
        self.assertIn("'vgp_onbuttonup'", source)
        self.assertNotIn('preventDefault', source)
        self.assertNotIn('stopPropagation', source)
        self.assertNotIn('instantLibraryScroll', source)

    def test_patch_is_disabled_by_default_and_reversible(self):
        source = PATCH.read_text(encoding='utf-8')
        self.assertIn("const SETTING_KEY = 'disable_library_letter_hold'", source)
        self.assertIn("('get_setting', SETTING_KEY, false)", source)
        self.assertIn("removeEventListener('vgp_onbuttondown'", source)
        self.assertIn('stopDisableLibraryLetterHold', source)
        self.assertIn('window.clearInterval(rebindTimer)', source)
        self.assertNotIn('EventTarget.prototype', source)

    def test_runtime_and_qam_integrations_are_present(self):
        index = (ROOT / 'src' / 'index.tsx').read_text(encoding='utf-8')
        qam = (ROOT / 'src' / 'components' / 'qam-contents' / 'QuickAccessSettings.tsx').read_text(encoding='utf-8')
        self.assertIn('applyCachedDisableLibraryLetterHold()', index)
        self.assertIn('await refreshDisableLibraryLetterHold()', index)
        self.assertIn('stopDisableLibraryLetterHold()', index)
        self.assertIn("get('disable_library_letter_hold', false)", qam)
        self.assertIn("set('disable_library_letter_hold', value, true)", qam)
        self.assertIn("PA_DISABLE_LIBRARY_LETTER_HOLD", qam)


if __name__ == '__main__':
    unittest.main()
