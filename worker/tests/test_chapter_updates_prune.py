"""The What's New "new chapters" feed should keep only the newest chapter notice
per still-updating work — no backlog floods, no completed works.

A corrected chapter count (e.g. an adult work briefly mis-read as 0 chapters, then
re-fetched correctly) once made the refresh pass record a work's whole backlog as
"new". prune keeps the newest per ongoing work and drops completed-work notices.
"""

import unittest

from ficstash_worker.supabase_io import chapter_updates_to_prune


class ChapterUpdatesPruneTests(unittest.TestCase):
    def test_collapses_multi_chapter_flood_to_newest(self):
        rows = [
            {"id": "a", "work_id": "w1", "chapter_n": 1},
            {"id": "b", "work_id": "w1", "chapter_n": 2},
            {"id": "c", "work_id": "w1", "chapter_n": 3},
        ]
        prune = chapter_updates_to_prune(rows, complete_ids=set())
        self.assertEqual(set(prune), {"a", "b"})  # keep newest (chapter 3)

    def test_drops_every_notice_for_a_completed_work(self):
        rows = [
            {"id": "a", "work_id": "w1", "chapter_n": 5},
            {"id": "b", "work_id": "w2", "chapter_n": 2},
        ]
        prune = chapter_updates_to_prune(rows, complete_ids={"w1"})
        self.assertEqual(set(prune), {"a"})  # w1 complete → drop; w2 ongoing newest → keep

    def test_keeps_a_single_newest_notice_per_ongoing_work(self):
        rows = [
            {"id": "a", "work_id": "w1", "chapter_n": 12},
            {"id": "b", "work_id": "w2", "chapter_n": 3},
        ]
        self.assertEqual(chapter_updates_to_prune(rows, complete_ids=set()), [])

    def test_empty(self):
        self.assertEqual(chapter_updates_to_prune([], set()), [])


if __name__ == "__main__":
    unittest.main()
