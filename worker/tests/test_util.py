"""Unit tests for ficstash_worker.util — pure, no Supabase/network needed.

Run from the worker/ directory:  python -m unittest discover -s tests
"""

import unittest

from ficstash_worker.util import is_following


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


if __name__ == "__main__":
    unittest.main()
