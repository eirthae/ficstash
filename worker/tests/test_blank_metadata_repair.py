"""Finding works whose metadata never populated.

These are rows with a blank title/author but real chapter text — readable in the
app, but you cannot tell what you are reading. 504 of them had accumulated while
the repair pass reported "0 work(s) with blank metadata to repair" on every run.

The selector was one hand-written PostgREST filter:

    .or_("title.is.null,title.eq.")

Nothing in the table was actually NULL, and the empty value after `eq.` did not
match the empty strings — so the only thing that could repair those rows could
not see them. The fix uses the client's typed filters, where an empty string is
just a value; these tests pin that it looks for empty strings at all.
"""

import unittest

from ficstash_worker.supabase_io import fetch_untitled_works


class FakeQuery:
    """Minimal stand-in for the supabase-py query builder.

    Records the filters applied so a test can assert on them, and returns only
    the rows that genuinely satisfy those filters — the point being that a
    filter which matches nothing (as the old one did) yields nothing here too.
    """

    def __init__(self, rows, table):
        self.rows, self.table = rows, table
        self.filters = []

    def select(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, n):
        self.rows = self.rows[:n]
        return self

    def eq(self, col, val):
        self.filters.append(("eq", col, val))
        self.rows = [r for r in self.rows if r.get(col) == val]
        return self

    def is_(self, col, _val):
        self.filters.append(("is", col, "null"))
        self.rows = [r for r in self.rows if r.get(col) is None]
        return self

    def or_(self, expr):
        # Faithful to the bug: the old expression matched nothing at all.
        self.filters.append(("or", expr, None))
        self.rows = []
        return self

    def execute(self):
        return type("R", (), {"data": list(self.rows)})()


class FakeClient:
    def __init__(self, rows):
        self.rows = rows

    def table(self, name):
        return FakeQuery([dict(r) for r in self.rows], name)


ROWS = [
    # The real shape: empty-string title, never NULL.
    {"source_work_id": "111", "title": "", "author": "", "source": "ao3", "hidden": False},
    {"source_work_id": "222", "title": "", "author": "someone", "source": "ao3", "hidden": False},
    # Titled but no author — half-written in the same way.
    {"source_work_id": "333", "title": "A Work", "author": "", "source": "ao3", "hidden": False},
    # Healthy; must never be re-fetched.
    {"source_work_id": "444", "title": "Fine", "author": "me", "source": "ao3", "hidden": False},
    # Hidden and wrong-source rows are not ours to repair.
    {"source_work_id": "555", "title": "", "author": "", "source": "ao3", "hidden": True},
    {"source_work_id": "666", "title": "", "author": "", "source": "scribblehub", "hidden": False},
]


class FetchUntitledWorksTests(unittest.TestCase):
    def test_finds_empty_string_titles_the_old_filter_missed(self):
        got = fetch_untitled_works(FakeClient(ROWS))
        self.assertIn("111", got)
        self.assertIn("222", got)

    def test_also_finds_a_titled_work_with_no_author(self):
        self.assertIn("333", fetch_untitled_works(FakeClient(ROWS)))

    def test_leaves_healthy_hidden_and_other_source_rows_alone(self):
        got = fetch_untitled_works(FakeClient(ROWS))
        for wid in ("444", "555", "666"):
            self.assertNotIn(wid, got)

    def test_no_duplicates_when_a_row_matches_several_filters(self):
        # "111" is blank in both title AND author.
        got = fetch_untitled_works(FakeClient(ROWS))
        self.assertEqual(len(got), len(set(got)))

    def test_limit_is_honoured(self):
        self.assertEqual(len(fetch_untitled_works(FakeClient(ROWS), limit=2)), 2)

    def test_nothing_to_do_on_a_healthy_table(self):
        healthy = [r for r in ROWS if r["title"] and r["author"]]
        self.assertEqual(fetch_untitled_works(FakeClient(healthy)), [])


if __name__ == "__main__":
    unittest.main()
