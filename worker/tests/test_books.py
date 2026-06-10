"""Unit tests for the Goodreads-backed books source parser (pure, no network)."""

import unittest

from ficstash_worker.sources.books import parse_shelf, _slug

# Mirrors the real Goodreads shelf markup (two book entries + a duplicate).
FIXTURE = """
<div>
  <a class="bookTitle" href="/book/show/59754566-him">Him (Him, #1)</a>
  <span class='by'>by</span>
  <a class="authorName" href="/author/show/7737308"><span itemprop="name">Sarina Bowen</span></a>
  4.21 avg rating — 50,000 ratings
</div>
<div>
  <a class="bookTitle" href="/book/show/9305362-captive-prince">Captive Prince (Captive Prince, #1)</a>
  <a class="authorName" href="/author/show/4349837"><span itemprop="name">C.S. Pacat</span></a>
  4.05 avg rating
</div>
<div>
  <a class="bookTitle" href="/book/show/59754566-him">Him (Him, #1)</a>  <!-- dup -->
</div>
"""


class ParseShelfTests(unittest.TestCase):
    def test_extracts_id_title_author_rating(self):
        books = parse_shelf(FIXTURE)
        self.assertEqual(len(books), 2)  # duplicate dropped
        self.assertEqual(books[0], {"id": "59754566", "title": "Him (Him, #1)", "author": "Sarina Bowen", "rating": "4.21"})
        self.assertEqual(books[1]["id"], "9305362")
        self.assertEqual(books[1]["author"], "C.S. Pacat")

    def test_limit_caps_results(self):
        self.assertEqual(len(parse_shelf(FIXTURE, limit=1)), 1)

    def test_empty_or_junk_html_yields_nothing(self):
        self.assertEqual(parse_shelf(""), [])
        self.assertEqual(parse_shelf("<html><body>no books</body></html>"), [])

    def test_slug(self):
        self.assertEqual(_slug("M/M Romance"), "m-m-romance")
        self.assertEqual(_slug("  Enemies to Lovers  "), "enemies-to-lovers")
        self.assertEqual(_slug("hockey"), "hockey")
        self.assertEqual(_slug(""), "")


if __name__ == "__main__":
    unittest.main()


# --- Description enrichment (parse_description, pure) -----------------------
from ficstash_worker.sources.books import parse_description as _book_desc  # noqa: E402


class ParseDescriptionTests(unittest.TestCase):
    def test_prefers_og_description(self):
        html = (
            '<meta name="description" content="generic seo text">'
            '<meta property="og:description" content="A hockey enemies-to-lovers romance.">'
        )
        self.assertEqual(_book_desc(html), "A hockey enemies-to-lovers romance.")

    def test_falls_back_to_name_description(self):
        html = '<meta name="description" content="Just the blurb &amp; more.">'
        self.assertEqual(_book_desc(html), "Just the blurb & more.")

    def test_empty_when_absent(self):
        self.assertEqual(_book_desc("<html><body>no meta</body></html>"), "")
