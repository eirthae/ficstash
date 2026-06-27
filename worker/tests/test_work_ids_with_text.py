"""_work_ids_with_fetched_text must page past PostgREST's 1000-row cap.

Each fetched chapter is its own row repeating its work_id, so a batch of works can
have thousands of rows. A single un-paged query truncates at ~1000, drops the rest
of the work_ids, and makes fully-downloaded works look "empty" — which is what was
bloating runs with needless re-downloads.
"""

import unittest
from types import SimpleNamespace

from ficstash_worker.supabase_io import _work_ids_with_fetched_text


class _Table:
    def __init__(self, rows):
        self._rows = rows
        self._lo = 0
        self._hi = None

    def select(self, *a, **k):
        return self

    def in_(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def range(self, lo, hi):
        self._lo, self._hi = lo, hi
        return self

    def execute(self):
        return SimpleNamespace(data=self._rows[self._lo : self._hi + 1])


class _Client:
    def __init__(self, rows):
        self._rows = rows

    def table(self, _name):
        return _Table(self._rows)


class WorkIdsWithTextTests(unittest.TestCase):
    def test_pages_past_1000_rows(self):
        # 1500 chapter rows (work_ids w0..w1499) — more than one page.
        rows = [{"work_id": f"w{i}"} for i in range(1500)]
        client = _Client(rows)
        have = _work_ids_with_fetched_text(client, ["w0"])  # one batch
        self.assertEqual(len(have), 1500)
        self.assertIn("w1499", have)  # would be missing if truncated at 1000

    def test_empty(self):
        self.assertEqual(_work_ids_with_fetched_text(_Client([]), ["w0"]), set())


if __name__ == "__main__":
    unittest.main()
