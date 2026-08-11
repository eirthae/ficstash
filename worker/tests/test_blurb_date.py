"""The date on a search blurb — what the discovery feed sorts and displays.

AO3 listings carry exactly one date, `p.datetime` ("14 Aug 2025"): the work's
last-updated date. Neither discovery path used to read it, so tag_matches rows
had no date and the app fell back to ordering by insertion time — which, on a
tag's first seed, is one big tie and reads as a shuffled feed.

Mirrors app/src/lib/sources/ao3-util.test.js so both paths stay in step.
"""

import unittest

from ficstash_worker.sources.ao3 import _blurb_date, _parse_search_blurbs

BLURB = """
<li class="work blurb group" id="work_123" role="article">
  <div class="header module">
    <h4 class="heading"><a href="/works/123">A Work</a> by <a rel="author">Auth</a></h4>
    <p class="datetime">14 Aug 2025</p>
  </div>
  <dl class="stats"><dd class="words">1,234</dd><dd class="chapters">2/2</dd></dl>
</li>
"""

UNDATED = BLURB.replace('<p class="datetime">14 Aug 2025</p>', "")


class BlurbDateTests(unittest.TestCase):
    def test_parses_ao3_blurb_dates(self):
        self.assertEqual(_blurb_date("14 Aug 2025"), "2025-08-14")
        self.assertEqual(_blurb_date("1 Jan 2026"), "2026-01-01")  # single-digit day
        self.assertEqual(_blurb_date("  09 Dec 2024  "), "2024-12-09")

    def test_accepts_full_month_names(self):
        self.assertEqual(_blurb_date("3 September 2025"), "2025-09-03")

    def test_returns_none_for_anything_unrecognised(self):
        # None, not a guess: a wrong date would silently reorder the whole feed.
        for junk in ("", None, "yesterday", "14 Foo 2025", "2025-08-14"):
            self.assertIsNone(_blurb_date(junk), junk)

    def test_blurb_parser_fills_updated(self):
        works = _parse_search_blurbs(BLURB, "ao3")
        self.assertEqual(len(works), 1)
        self.assertEqual(works[0].updated, "2025-08-14")

    def test_blurb_without_a_date_yields_none_not_a_crash(self):
        works = _parse_search_blurbs(UNDATED, "ao3")
        self.assertEqual(len(works), 1)
        self.assertIsNone(works[0].updated)


if __name__ == "__main__":
    unittest.main()
