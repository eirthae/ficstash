"""A work must only be materialised once a fetch returns real chapter TEXT.

Regression: the saves/link passes called upsert_work before checking the result,
so a gated/throttled/empty fetch created a titleless row with offline unset — the
app rendered it as a blank "ready to read" ghost. _has_chapter_text gates that.
"""

import unittest
from types import SimpleNamespace

try:
    import main
    _HAVE_MAIN = True
except Exception:  # noqa: BLE001 — missing runtime deps in a minimal env
    _HAVE_MAIN = False


@unittest.skipUnless(_HAVE_MAIN, "worker runtime deps not installed")
class HasChapterTextTests(unittest.TestCase):
    def test_real_body_is_text(self):
        self.assertTrue(main._has_chapter_text([SimpleNamespace(html="<p>hi</p>")]))

    def test_one_real_among_empties_is_text(self):
        chs = [SimpleNamespace(html=""), SimpleNamespace(html="<p>x</p>")]
        self.assertTrue(main._has_chapter_text(chs))

    def test_all_empty_bodies_is_not_text(self):
        self.assertFalse(main._has_chapter_text([SimpleNamespace(html=""), SimpleNamespace(html="   ")]))

    def test_no_chapters_is_not_text(self):
        self.assertFalse(main._has_chapter_text([]))
        self.assertFalse(main._has_chapter_text(None))

    def test_missing_html_attr_is_not_text(self):
        self.assertFalse(main._has_chapter_text([SimpleNamespace(n=1)]))


if __name__ == "__main__":
    unittest.main()
