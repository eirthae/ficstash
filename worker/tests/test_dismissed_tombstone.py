"""upsert_tag_matches skips dismissed works (the keys-only tombstone)."""

import unittest

from ficstash_worker.sources.base import WorkMeta
from ficstash_worker.supabase_io import upsert_tag_matches


class _FakeTable:
    def __init__(self):
        self.rows = None

    def upsert(self, rows, on_conflict=None):
        self.rows = rows
        return self

    def execute(self):
        return None


class _FakeClient:
    def __init__(self):
        self.t = _FakeTable()

    def table(self, name):
        return self.t


def _meta(wid, source="ao3"):
    return WorkMeta(source=source, source_work_id=wid, title=f"W{wid}", author="a")


class TestDismissedTombstone(unittest.TestCase):
    def test_dismissed_keys_are_skipped_on_upsert(self):
        client = _FakeClient()
        metas = [_meta("1"), _meta("2"), _meta("9", source="romanceio")]
        n = upsert_tag_matches(client, "grp", metas, dismissed_keys={("ao3", "2"), ("romanceio", "9")})
        self.assertEqual(n, 1)  # only work 1 survives
        stored_ids = {r["source_work_id"] for r in client.t.rows}
        self.assertEqual(stored_ids, {"1"})

    def test_no_tombstone_upserts_everything(self):
        client = _FakeClient()
        n = upsert_tag_matches(client, "grp", [_meta("1"), _meta("2")])
        self.assertEqual(n, 2)

    def test_empty_metas_writes_nothing(self):
        client = _FakeClient()
        self.assertEqual(upsert_tag_matches(client, "grp", [], dismissed_keys={("ao3", "1")}), 0)
        self.assertIsNone(client.t.rows)


if __name__ == "__main__":
    unittest.main()
