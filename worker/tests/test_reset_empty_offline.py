"""The offline self-heal must ignore removed (hidden) works.

Regression: reclaiming storage purges a hidden work's chapter rows, so it reads as
"flagged offline, no text" — reset_empty_offline un-flagged it every single sync
while fetch_non_offline_works (hidden=false) immediately dropped it again. Run
31167830992 logged "Re-queued 19 work(s)" followed by "0 work(s) need offline
copies" for exactly this reason: a wasted write each run, and a re-queue count
that would have masked a work the user actually wanted.

No network, no real DB: a fake client applies the filters and records updates.

Run from worker/:  python -m unittest discover -s tests
"""

import unittest
from types import SimpleNamespace

from ficstash_worker.supabase_io import reset_empty_offline


class FakeQuery:
    """Applies eq / in_ / range, and records update() payloads on the client."""

    def __init__(self, rows, client=None, patch=None):
        self._rows = [dict(r) for r in rows]
        self._client = client
        self._patch = patch
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
        if self._patch is not None:
            self._client.updated.extend(r["id"] for r in rows)
        return SimpleNamespace(data=list(rows))


class FakeClient:
    def __init__(self, works, chapters):
        self._data = {"works": works, "chapters": chapters}
        self._name = None
        self.updated: list[str] = []

    def table(self, name):
        self._name = name
        return self

    def select(self, *_a, **_k):
        return FakeQuery(self._data.get(self._name, []))

    def update(self, patch):
        return FakeQuery(self._data.get(self._name, []), client=self, patch=patch)


WORKS = [
    # visible, flagged offline, no chapter text → the genuine self-heal case
    {"id": "w1", "source": "ao3", "offline": True, "hidden": False},
    # visible, flagged offline, has text → already fine, leave alone
    {"id": "w2", "source": "ao3", "offline": True, "hidden": False},
    # REMOVED by the user; storage reclaim purged its chapters → must be skipped
    {"id": "w3", "source": "ao3", "offline": True, "hidden": True},
    # not flagged offline → outside this pass
    {"id": "w4", "source": "ao3", "offline": False, "hidden": False},
    # another source → outside this pass
    {"id": "w5", "source": "royalroad", "offline": True, "hidden": False},
]
CHAPTERS = [{"work_id": "w2", "fetched": True}]


class ResetEmptyOfflineTests(unittest.TestCase):
    def test_skips_hidden_works(self):
        client = FakeClient(WORKS, CHAPTERS)
        reset_empty_offline(client)
        self.assertNotIn("w3", client.updated)

    def test_still_reclaims_a_visible_empty_work(self):
        client = FakeClient(WORKS, CHAPTERS)
        reset_empty_offline(client)
        self.assertEqual(client.updated, ["w1"])

    def test_count_excludes_hidden(self):
        # The pre-fix code returned 2 here (w1 + w3) — the misleading "Re-queued N".
        self.assertEqual(reset_empty_offline(FakeClient(WORKS, CHAPTERS)), 1)

    def test_leaves_works_that_have_text(self):
        client = FakeClient(WORKS, CHAPTERS)
        reset_empty_offline(client)
        self.assertNotIn("w2", client.updated)

    def test_a_library_of_only_hidden_empties_is_a_no_op(self):
        # The steady state this bug produced: nothing to do, and nothing written.
        works = [{"id": f"h{i}", "source": "ao3", "offline": True, "hidden": True} for i in range(19)]
        client = FakeClient(works, [])
        self.assertEqual(reset_empty_offline(client), 0)
        self.assertEqual(client.updated, [])

    def test_respects_the_source_filter(self):
        client = FakeClient(WORKS, CHAPTERS)
        reset_empty_offline(client, source="royalroad")
        self.assertEqual(client.updated, ["w5"])

    def test_empty_library(self):
        client = FakeClient([], [])
        self.assertEqual(reset_empty_offline(client), 0)
        self.assertEqual(client.updated, [])


if __name__ == "__main__":
    unittest.main()
