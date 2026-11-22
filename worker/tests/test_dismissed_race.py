"""A work dismissed while a nightly is running must not come back.

dismissed_keys is a snapshot taken when discovery starts; a nightly runs for
hours. On 2026-10-08 a work was dismissed at 00:07 and the running nightly
re-added it at 00:27 from its older snapshot, so it reappeared in another group.
upsert_tag_matches now re-checks the batch against the table itself.
"""

import unittest
from unittest import mock

from ficstash_worker.sources.base import WorkMeta
from ficstash_worker.supabase_io import _drop_dismissed_now, upsert_tag_matches


def _meta(wid):
    return WorkMeta(source="ao3", source_work_id=wid, title=f"T{wid}", author="a")


def _client(dismissed_now):
    """A fake client whose dismissed_matches holds `dismissed_now`, and which
    records what gets upserted into tag_matches."""
    upserted = []

    class Q:
        def __init__(self, table):
            self.table = table
            self.ids = None

        def select(self, *_a):
            return self

        def in_(self, _col, ids):
            self.ids = list(ids)
            return self

        def upsert(self, rows, **_k):
            upserted.extend(rows)
            return self

        def execute(self):
            if self.table == "dismissed_matches":
                data = [{"source": "ao3", "source_work_id": w} for w in dismissed_now if w in (self.ids or [])]
                return type("R", (), {"data": data})()
            return type("R", (), {"data": []})()

    client = mock.Mock()
    client.table.side_effect = Q
    return client, upserted


class DismissedRaceTests(unittest.TestCase):
    def test_a_work_dismissed_after_the_snapshot_is_not_written(self):
        client, upserted = _client(dismissed_now={"2"})
        n = upsert_tag_matches(client, "g", [_meta("1"), _meta("2"), _meta("3")], dismissed_keys=set())
        self.assertEqual(n, 2)
        self.assertEqual(sorted(r["source_work_id"] for r in upserted), ["1", "3"])

    def test_the_snapshot_still_applies(self):
        client, upserted = _client(dismissed_now=set())
        upsert_tag_matches(client, "g", [_meta("1"), _meta("2")], dismissed_keys={("ao3", "1")})
        self.assertEqual([r["source_work_id"] for r in upserted], ["2"])

    def test_a_failed_lookup_never_blocks_the_save(self):
        client = mock.Mock()
        client.table.return_value.select.side_effect = RuntimeError("network")
        self.assertEqual(len(_drop_dismissed_now(client, [_meta("1")])), 1)


if __name__ == "__main__":
    unittest.main()
