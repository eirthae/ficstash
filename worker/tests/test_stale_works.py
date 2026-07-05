"""Stale-works detection: a work flagged offline=true but with NO fetched chapter
text is "downloaded but empty" — it shows as "ready to read" yet holds nothing, so
the fast lane must re-fetch it. This is the exact class of "things I added are
missing / half-there". No network, no real DB: a fake client applies the filters.

Run from worker/:  python -m unittest discover -s tests
"""

import unittest
from types import SimpleNamespace

from ficstash_worker.supabase_io import (
    fetch_stale_offline_works,
    _work_ids_with_fetched_text,
)


class FakeQuery:
    """Applies eq / in_ / range so the real filtering logic is exercised."""

    def __init__(self, rows):
        self._rows = [dict(r) for r in rows]
        self._lo = 0
        self._hi = None

    def eq(self, col, val):
        self._rows = [r for r in self._rows if r.get(col) == val]
        return self

    def in_(self, col, vals):
        s = set(vals)
        self._rows = [r for r in self._rows if r.get(col) in s]
        return self

    def range(self, lo, hi):
        self._lo, self._hi = lo, hi
        return self

    def execute(self):
        rows = self._rows
        if self._hi is not None:
            rows = rows[self._lo:self._hi + 1]
        return SimpleNamespace(data=list(rows))


class FakeClient:
    def __init__(self, works, chapters):
        self._data = {"works": works, "chapters": chapters}
        self._name = None

    def table(self, name):
        self._name = name
        return self

    def select(self, *_a, **_k):
        return FakeQuery(self._data.get(self._name, []))


class StaleWorksTests(unittest.TestCase):
    def _client(self):
        works = [
            {"id": "w1", "source": "ao3", "source_work_id": "1", "source_url": "", "offline": True, "hidden": False},
            {"id": "w2", "source": "ao3", "source_work_id": "2", "source_url": "", "offline": True, "hidden": False},
            {"id": "w3", "source": "ao3", "source_work_id": "3", "source_url": "", "offline": True, "hidden": True},   # hidden → skip
            {"id": "w4", "source": "ao3", "source_work_id": "4", "source_url": "", "offline": False, "hidden": False}, # not offline → skip
        ]
        chapters = [
            {"work_id": "w1", "fetched": True},   # w1 has real text → NOT stale
            {"work_id": "w2", "fetched": False},  # w2's only chapter is empty → stale
        ]
        return FakeClient(works, chapters)

    def test_flags_only_offline_visible_works_with_no_text(self):
        stale = fetch_stale_offline_works(self._client())
        ids = sorted(w["source_work_id"] for w in stale)
        self.assertEqual(ids, ["2"])  # w1 has text, w3 hidden, w4 not offline

    def test_work_ids_with_fetched_text_ignores_empty_chapters(self):
        client = self._client()
        have = _work_ids_with_fetched_text(client, ["w1", "w2"])
        self.assertEqual(have, {"w1"})  # w2's chapter is fetched=False

    def test_no_offline_works_is_empty(self):
        stale = fetch_stale_offline_works(FakeClient([], []))
        self.assertEqual(stale, [])

    def test_respects_a_limit(self):
        works = [
            {"id": f"w{i}", "source": "ao3", "source_work_id": str(i), "source_url": "", "offline": True, "hidden": False}
            for i in range(5)
        ]
        stale = fetch_stale_offline_works(FakeClient(works, []), limit=2)  # none have text → all stale
        self.assertEqual(len(stale), 2)


if __name__ == "__main__":
    unittest.main()
