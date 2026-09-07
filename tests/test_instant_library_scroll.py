import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class InstantLibraryScrollTests(unittest.TestCase):
    def test_every_locale_has_natural_setting_copy(self):
        required = {'PA_INSTANT_LIBRARY_SCROLL', 'PA_INSTANT_LIBRARY_SCROLL_DESC'}
        for locale in (ROOT / 'src' / 'i18n').glob('*.json'):
            strings = json.loads(locale.read_text(encoding='utf-8'))
            self.assertTrue(required.issubset(strings), locale.name)
            for key in required:
                self.assertTrue(strings[key].strip(), f'{locale.name}: {key}')

    def test_patch_is_scoped_and_reversible(self):
        source = (ROOT / 'src' / 'patches' / 'instantLibraryScroll.ts').read_text(encoding='utf-8')
        self.assertIn("isSquareLibraryRoute()", source)
        self.assertIn("LibraryItemBox", source)
        self.assertIn("rowThreshold", source)
        self.assertIn("left: scroller.scrollLeft", source)
        self.assertIn("elementsFromPoint", source)
        self.assertIn("visibleBottomEdge", source)
        self.assertIn("VIEWPORT_MARGIN_PX", source)
        self.assertIn("removeEventListener('focusin'", source)
        self.assertIn("stopInstantLibraryScroll", source)
        self.assertNotIn('scroll-behavior', source)
        self.assertNotIn('prototype.scrollTo =', source)
        self.assertNotIn('prototype.scrollIntoView =', source)


if __name__ == '__main__':
    unittest.main()
