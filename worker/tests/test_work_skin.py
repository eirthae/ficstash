"""Unit tests for AO3 work-skin capture (pure soup scan, no network)."""

import unittest

from bs4 import BeautifulSoup

from ficstash_worker.sources.ao3 import _work_skin, _inline_chapter_images, MAX_IMG_BYTES


class _FakeWork:
    def __init__(self, html):
        self._soup = BeautifulSoup(html, "html.parser")


class WorkSkinTests(unittest.TestCase):
    def test_extracts_the_workskin_style_block(self):
        html = '<style type="text/css">#workskin .text-message { color: blue; }</style><div class="userstuff">body</div>'
        css = _work_skin(_FakeWork(html))
        self.assertIn("#workskin", css)
        self.assertIn(".text-message", css)

    def test_ignores_styles_that_are_not_the_workskin(self):
        html = "<style>.site-nav { color: red; }</style>"
        self.assertEqual(_work_skin(_FakeWork(html)), "")

    def test_empty_when_no_style_present(self):
        self.assertEqual(_work_skin(_FakeWork("<div>just prose</div>")), "")

    def test_safe_when_no_soup(self):
        class _NoSoup:
            pass
        self.assertEqual(_work_skin(_NoSoup()), "")


class InlineImagesTests(unittest.TestCase):
    def _ok(self, url):
        return ("image/png", b"\x89PNG\r\n\x1a\n" + b"x" * 100)

    def test_remote_image_is_inlined_as_data_uri(self):
        out = _inline_chapter_images('<p>hi</p><img src="https://i.imgur.com/a.png">', download=self._ok)
        self.assertIn("data:image/png;base64,", out)
        self.assertNotIn("imgur", out)

    def test_failed_download_falls_back_to_placeholder(self):
        out = _inline_chapter_images('<img src="https://x/y.png">', download=lambda u: None)
        self.assertIn("fs-img-missing", out)
        self.assertNotIn("<img", out)

    def test_oversized_image_is_placeholdered(self):
        big = lambda u: ("image/jpeg", b"y" * (MAX_IMG_BYTES + 1))
        out = _inline_chapter_images('<img src="https://x/big.jpg" alt="huge">', download=big)
        self.assertIn("fs-img-missing", out)
        self.assertIn("huge", out)

    def test_existing_data_uri_is_left_alone(self):
        out = _inline_chapter_images('<img src="data:image/png;base64,AAAA">', download=self._ok)
        self.assertIn("data:image/png;base64,AAAA", out)
        self.assertNotIn("fs-img-missing", out)

    def test_no_images_passthrough(self):
        self.assertEqual(_inline_chapter_images("<p>just prose</p>"), "<p>just prose</p>")
