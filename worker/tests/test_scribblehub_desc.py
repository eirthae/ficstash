"""Unit test for the Scribble Hub series-description parser (pure, no network)."""

import unittest

from ficstash_worker.sources.scribblehub import parse_description


class SHDescriptionTests(unittest.TestCase):
    def test_extracts_og_description(self):
        html = '<meta property="og:description" content="A cultivator reborn in a magic school.">'
        self.assertEqual(parse_description(html), "A cultivator reborn in a magic school.")

    def test_empty_when_absent(self):
        self.assertEqual(parse_description("<html>nope</html>"), "")
