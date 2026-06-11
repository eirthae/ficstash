"""Unit tests for AO3 series helpers (pure parser, no network)."""

import unittest

from ficstash_worker.sources.ao3 import _parse_series_work_ids

# Trimmed AO3 /series/<id> work-index markup (two works + a non-work link).
FIXTURE = """
<div class="navigation"><a href="/works/search">Search</a></div>
<ul class="series work index group">
  <li class="work blurb group" role="article">
    <div class="header module">
      <h4 class="heading"><a href="/works/111">First Work</a> by <a rel="author">Auth</a></h4>
    </div>
  </li>
  <li class="work blurb group" role="article">
    <div class="header module">
      <h4 class="heading"><a href="/works/222">Second &amp; Last</a> by <a rel="author">Auth</a></h4>
    </div>
  </li>
</ul>
"""


class SeriesParseTests(unittest.TestCase):
    def test_extracts_ids_in_order(self):
        rows = _parse_series_work_ids(FIXTURE)
        self.assertEqual([wid for wid, _ in rows], ["111", "222"])

    def test_extracts_titles_decoded(self):
        rows = _parse_series_work_ids(FIXTURE)
        self.assertEqual(rows[0][1], "First Work")
        self.assertEqual(rows[1][1], "Second & Last")

    def test_ignores_links_outside_the_index(self):
        rows = _parse_series_work_ids(FIXTURE)
        self.assertNotIn("search", [wid for wid, _ in rows])

    def test_empty_on_junk(self):
        self.assertEqual(_parse_series_work_ids("<html>no series</html>"), [])
