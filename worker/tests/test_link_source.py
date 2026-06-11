"""AO3/RR/SH link classification must be robust to FanFicFare's site string."""

import unittest

from ficstash_worker.sources.link import _resolve_source


class ResolveSourceTests(unittest.TestCase):
    def test_ao3_from_site(self):
        self.assertEqual(_resolve_source("archiveofourown.org", "https://archiveofourown.org/works/1"), "ao3")

    def test_ao3_from_url_when_site_blank(self):
        self.assertEqual(_resolve_source("", "https://archiveofourown.org/works/1"), "ao3")

    def test_ao3_from_full_url_site(self):
        self.assertEqual(_resolve_source("https://archiveofourown.org/works/1", "https://archiveofourown.org/works/1"), "ao3")

    def test_royalroad_and_scribblehub(self):
        self.assertEqual(_resolve_source("www.royalroad.com", "https://www.royalroad.com/fiction/9"), "royalroad")
        self.assertEqual(_resolve_source("", "https://www.scribblehub.com/series/9/"), "scribblehub")

    def test_unknown_host_falls_back_to_link(self):
        self.assertEqual(_resolve_source("", "https://example.com/story"), "link")
