"""Unit tests for the save-from-tags download flow (ficstash_worker.saves).

Verifies that fetching a queued ("wanted") work pulls every chapter, and that a
gated work (AO3 adult / login-restricted page parses as 0 chapters) fetches
nothing — the exact case that caused "no chapters fetched, will retry".

No network, no database: a fake source stands in for AO3.
Run from worker/:  python -m unittest discover -s tests
"""

import unittest
from types import SimpleNamespace

from ficstash_worker.saves import fetch_work_chapters


class FakeSource:
    """Stands in for the AO3 source: records calls, returns canned data."""

    def __init__(self, n_chapters):
        self._n = n_chapters
        self.meta_calls = 0
        self.chapter_args = []

    def fetch_work_metadata(self, wid):
        self.meta_calls += 1
        return SimpleNamespace(chapters=self._n, title="A Work", status="complete")

    def fetch_chapter(self, wid, n):
        self.chapter_args.append((wid, n))
        return SimpleNamespace(n=n, title=f"Chapter {n}", words=100, html=f"<p>body {n}</p>")


class FetchWorkChaptersTests(unittest.TestCase):
    def test_downloads_every_chapter_for_a_normal_work(self):
        src = FakeSource(3)
        meta, chapters = fetch_work_chapters(src, "12345")
        self.assertEqual(meta.chapters, 3)
        self.assertEqual([c.n for c in chapters], [1, 2, 3])
        self.assertEqual(src.chapter_args, [("12345", 1), ("12345", 2), ("12345", 3)])
        self.assertTrue(all(c.html for c in chapters))  # real bodies fetched

    def test_gated_work_zero_chapters_fetches_nothing(self):
        # AO3 adult / restricted gate → metadata reports 0 chapters.
        src = FakeSource(0)
        meta, chapters = fetch_work_chapters(src, "12345")
        self.assertEqual(chapters, [])
        self.assertEqual(src.chapter_args, [])  # never tries to fetch a body
        self.assertEqual(src.meta_calls, 1)

    def test_single_chapter_work(self):
        src = FakeSource(1)
        _, chapters = fetch_work_chapters(src, "1")
        self.assertEqual(len(chapters), 1)
        self.assertEqual(chapters[0].n, 1)

    def test_space_pause_runs_before_metadata_and_each_chapter(self):
        src = FakeSource(2)
        pauses = []
        fetch_work_chapters(src, "1", space=lambda: pauses.append(1))
        # one pause before metadata + one before each of the 2 chapters
        self.assertEqual(len(pauses), 3)

    def test_backoff_wraps_every_source_call(self):
        src = FakeSource(2)
        wrapped = []
        def backoff(fn, what=""):
            wrapped.append(what)
            return fn()
        fetch_work_chapters(src, "1", backoff=backoff)
        self.assertEqual(len(wrapped), 3)  # metadata + 2 chapters
        self.assertTrue(any("metadata" in w for w in wrapped))
        self.assertTrue(any("chapter 1" in w for w in wrapped))

    def test_full_work_source_does_not_space_per_chapter(self):
        # AO3 returns every chapter in the one metadata request, so a source that
        # advertises fetches_full_work must NOT sleep between chapter reads — only
        # the single metadata pause. (Was 1 + N; this is what made saves crawl.)
        src = FakeSource(20)
        src.fetches_full_work = True
        pauses = []
        fetch_work_chapters(src, "1", space=lambda: pauses.append(1))
        self.assertEqual(len(pauses), 1)
        self.assertEqual(len(src.chapter_args), 20)  # still reads all chapters

    def test_meta_missing_chapter_count_is_treated_as_zero(self):
        src = FakeSource(None)  # chapters=None (defensive)
        _, chapters = fetch_work_chapters(src, "1")
        self.assertEqual(chapters, [])


if __name__ == "__main__":
    unittest.main()
