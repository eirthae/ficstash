"""upsert_tag_matches must build rows with IDENTICAL keys.

Regression: stamping `dismissed` on only the rows that overlapped a previously-
dismissed work produced a bulk upsert whose objects didn't all match — PostgREST
rejects that ("All object keys must match"), so the whole batch was dropped and
any tag overlapping a dismissed work wrote 0 matches. Cross-tag dismissal is now
handled by propagate_dismissals (a separate uniform UPDATE), not stamped here.
"""

import unittest
from types import SimpleNamespace

import ficstash_worker.supabase_io as io


class _Resp:
    def __init__(self, data=None):
        self.data = data or []


class _Q:
    def __init__(self, sink):
        self.sink = sink

    def upsert(self, rows, **k):
        self.sink["rows"] = rows
        return self

    def execute(self):
        return _Resp([])


class _Client:
    def __init__(self):
        self.sink = {}

    def table(self, _name):
        return _Q(self.sink)


def _meta(wid, fandom):
    return SimpleNamespace(
        source="ao3", source_work_id=wid, title=f"T{wid}", author="a", fandom=fandom,
        summary="", tags=[], words=1, chapters=1, status="complete", updated=None,
    )


class UpsertTagMatchesUniformTests(unittest.TestCase):
    def test_rows_have_identical_keys_and_no_inline_dismissed(self):
        client = _Client()
        n = io.upsert_tag_matches(client, "grp", [_meta("1", "F"), _meta("2", "G")])
        self.assertEqual(n, 2)
        rows = client.sink["rows"]
        keysets = {frozenset(r.keys()) for r in rows}
        self.assertEqual(len(keysets), 1, f"non-uniform upsert keys: {keysets}")
        self.assertNotIn("dismissed", rows[0])

    def test_empty_metas_writes_nothing(self):
        client = _Client()
        self.assertEqual(io.upsert_tag_matches(client, "grp", []), 0)


if __name__ == "__main__":
    unittest.main()
