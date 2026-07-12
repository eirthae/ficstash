"""Unit tests for the romance.io books source (pure URL + JSON parsing, no network)."""

import unittest

from ficstash_worker.sources.romanceio import DEFAULT_EXCLUDE, books_url, parse_books

# A trimmed shape of the real /json/topics/books response.
FIXTURE = {
    "success": True,
    "books": [
        {
            "_id": "6264fcee2298a0f37fe037ef",
            "url": "/books/6264fcee2298a0f37fe037ef/the-long-game-rachel-reid",
            "authors": [{"name": "Rachel Reid"}],
            "series": {"title": "Game Changers"},
            "info": {
                "title": "The Long Game",
                "description": "Shane and Ilya are back.",
                "avgRating": 4.561,
                "steam_rating_description": "Explicit and plentiful",
            },
        },
        {"_id": "", "info": {"title": "no id — skipped"}},  # dropped
    ],
}


class TestRomanceIoUrl(unittest.TestCase):
    def test_encodes_spaced_slugs_and_always_appends_default_exclude(self):
        url = books_url(["grumpy sunshine"], ["mafia"], page=1)
        self.assertIn("/json/topics/books/grumpy%20sunshine/best/0/20/", url)
        self.assertIn("mafia,", url)              # group exclude first
        self.assertTrue(url.endswith(DEFAULT_EXCLUDE[-1]))  # default-exclude appended
        self.assertIn("afab", url)                # a default-exclude slug is present

    def test_no_include_falls_back_to_all_and_paginates(self):
        self.assertIn("/books/all/best/0/20", books_url([], []))
        self.assertIn("/best/20/20", books_url(["contemporary"], [], page=2))

    def test_dedupes_include_slugs(self):
        url = books_url(["hockey", "hockey"], [])
        self.assertEqual(url.count("hockey"), 1)


class TestRomanceIoParse(unittest.TestCase):
    def test_parses_a_book_into_workmeta_metadata_only(self):
        metas = parse_books(FIXTURE)
        self.assertEqual(len(metas), 1)  # the id-less one is dropped
        m = metas[0]
        self.assertEqual(m.source, "romanceio")
        self.assertEqual(m.source_work_id, "6264fcee2298a0f37fe037ef")
        self.assertEqual(m.title, "The Long Game")
        self.assertEqual(m.author, "Rachel Reid")
        self.assertEqual(m.fandom, "Game Changers")   # series in the fandom slot
        self.assertEqual(m.status, "complete")
        self.assertEqual(m.url, "https://www.romance.io/books/6264fcee2298a0f37fe037ef")
        # steam + rounded rating surfaced as tags
        self.assertIn({"t": "★ 4.6", "k": "freeform"}, m.tags)
        self.assertIn({"t": "Explicit and plentiful", "k": "rating"}, m.tags)

    def test_empty_or_junk_is_safe(self):
        self.assertEqual(parse_books({}), [])
        self.assertEqual(parse_books({"books": None}), [])
        self.assertEqual(parse_books(None), [])


if __name__ == "__main__":
    unittest.main()
