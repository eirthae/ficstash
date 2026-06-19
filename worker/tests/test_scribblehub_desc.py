"""Unit test for the Scribble Hub series-description parser (pure, no network)."""

import unittest

from ficstash_worker.sources.scribblehub import parse_description


class SHDescriptionTests(unittest.TestCase):
    def test_prefers_full_wi_fic_desc_over_og(self):
        html = (
            '<meta property="og:description" content="short clipped blurb…">'
            '<div class="wi_fic_desc" property="description">'
            '<p>The <em>full</em> synopsis, several sentences long.</p></div>'
        )
        self.assertEqual(
            parse_description(html),
            "The full synopsis, several sentences long.",
        )

    def test_falls_back_to_og_when_no_desc_block(self):
        html = '<meta property="og:description" content="A cultivator reborn in a magic school.">'
        self.assertEqual(parse_description(html), "A cultivator reborn in a magic school.")

    def test_falls_back_to_og_when_desc_block_empty(self):
        html = (
            '<div class="wi_fic_desc"></div>'
            '<meta property="og:description" content="Fallback blurb.">'
        )
        self.assertEqual(parse_description(html), "Fallback blurb.")

    def test_unescapes_entities_in_full_desc(self):
        html = '<div class="wi_fic_desc"><p>Tom &amp; Jerry &quot;reborn&quot;</p></div>'
        self.assertEqual(parse_description(html), 'Tom & Jerry "reborn"')

    def test_empty_when_absent(self):
        self.assertEqual(parse_description("<html>nope</html>"), "")
