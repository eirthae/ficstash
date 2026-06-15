"""Unit tests for ficstash_worker.util — pure, no Supabase/network needed.

Run from the worker/ directory:  python -m unittest discover -s tests
"""

import unittest

from ficstash_worker.util import is_following, status_matches


class IsFollowingTests(unittest.TestCase):
    def test_ongoing_is_followed(self):
        self.assertTrue(is_following("ongoing"))

    def test_complete_is_not_followed(self):
        self.assertFalse(is_following("complete"))

    def test_complete_is_case_and_whitespace_insensitive(self):
        self.assertFalse(is_following("Complete"))
        self.assertFalse(is_following("COMPLETE"))
        self.assertFalse(is_following("  complete  "))

    def test_none_and_empty_default_to_followed(self):
        # Safer to re-check a work we don't need than to silently stop updating one.
        self.assertTrue(is_following(None))
        self.assertTrue(is_following(""))
        self.assertTrue(is_following("   "))

    def test_other_statuses_are_followed(self):
        for status in ("hiatus", "updating", "in-progress", "wip"):
            with self.subTest(status=status):
                self.assertTrue(is_following(status))


class StatusMatchesTests(unittest.TestCase):
    def test_all_matches_everything(self):
        self.assertTrue(status_matches("complete", "all"))
        self.assertTrue(status_matches("ongoing", "all"))
        self.assertTrue(status_matches("anything", "all"))

    def test_complete_filter(self):
        self.assertTrue(status_matches("complete", "complete"))
        self.assertFalse(status_matches("ongoing", "complete"))

    def test_ongoing_filter(self):
        self.assertTrue(status_matches("ongoing", "ongoing"))
        self.assertFalse(status_matches("complete", "ongoing"))

    def test_case_and_whitespace_insensitive(self):
        self.assertTrue(status_matches(" Complete ", "complete"))
        self.assertFalse(status_matches("COMPLETE", "ongoing"))

    def test_unknown_group_status_matches_everything(self):
        self.assertTrue(status_matches("complete", None))
        self.assertTrue(status_matches("ongoing", ""))
        self.assertTrue(status_matches("ongoing", "garbage"))


if __name__ == "__main__":
    unittest.main()
