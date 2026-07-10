"""Canonical tag-page discovery helpers (pure, no network).

Covers the fix for gen/platonic '&' tags, which AO3's works-search other_tag_names
field can't match — we look them up on /tags/<escaped>/works instead.
"""

import unittest

from ficstash_worker.sources.ao3 import (
    _tag_to_path,
    _needs_tag_page,
    _parse_search_blurbs,
)

_BLURB = """
<ol class="work index group">
  <li class="work blurb group" id="work_12345" role="article">
    <div class="header module">
      <h4 class="heading">
        <a href="/works/12345">Read Receipts</a> by
        <a rel="author" href="/users/after_hours">after_hours</a>
      </h4>
      <h5 class="fandoms heading"><a class="tag" href="/t/x">Hockey RPF</a></h5>
    </div>
    <ul class="tags commas">
      <li class="relationships"><a class="tag" href="/t/r">Shane Hollander &amp; Carter Vaughn</a></li>
      <li class="freeforms"><a class="tag" href="/t/f">Texting</a></li>
    </ul>
    <blockquote class="userstuff summary"><p>They text a lot.</p></blockquote>
    <dl class="stats">
      <dd class="language" lang="en">English</dd>
      <dd class="words">9,800</dd>
      <dd class="chapters">3/?</dd>
    </dl>
  </li>
</ol>
"""


class TagPageHelpersTests(unittest.TestCase):
    def test_tag_to_path_escapes_ampersand_and_encodes_spaces(self):
        self.assertEqual(
            _tag_to_path("Shane Hollander & Carter Vaughn"),
            "Shane%20Hollander%20*a*%20Carter%20Vaughn",
        )

    def test_tag_to_path_escapes_slash(self):
        # '/' romantic pairings still escape correctly if ever routed here.
        self.assertEqual(_tag_to_path("A/B"), "A*s*B")

    def test_needs_tag_page_only_for_ampersand(self):
        self.assertTrue(_needs_tag_page("Shane Hollander & Carter Vaughn"))
        self.assertFalse(_needs_tag_page("Shane Hollander/Ilya Rozanov"))
        self.assertFalse(_needs_tag_page("Slow Burn"))

    def test_parse_blurbs_full_metadata(self):
        metas = _parse_search_blurbs(_BLURB, "ao3")
        self.assertEqual(len(metas), 1)
        m = metas[0]
        self.assertEqual(m.source_work_id, "12345")
        self.assertEqual(m.title, "Read Receipts")
        self.assertEqual(m.author, "after_hours")
        self.assertEqual(m.fandom, "Hockey RPF")
        self.assertEqual(m.words, 9800)
        self.assertEqual(m.chapters, 3)
        self.assertIsNone(m.chapters_total)      # "3/?" → unknown end, still ongoing
        self.assertEqual(m.status, "ongoing")
        self.assertIn("They text", m.summary)
        # the '&' entity is decoded back to a literal ampersand in the tag text
        rel = [t["t"] for t in m.tags if t["k"] == "relationship"]
        self.assertEqual(rel, ["Shane Hollander & Carter Vaughn"])
        self.assertIn({"t": "Texting", "k": "freeform"}, m.tags)

    def test_parse_blurbs_empty(self):
        self.assertEqual(_parse_search_blurbs("<html>nope</html>", "ao3"), [])
