"""A real-time Save must not re-enumerate every followed series.

Regression: the saves-only lane walked all 94 rows in followed_series at
RATE_LIMIT_SECONDS apart (~50 minutes), so each Save monopolised the workflow
lane and the nightly sweep queued behind it — sometimes to the point of being
cancelled before it reached tracked-tag discovery, which is what actually
surfaces new works. _series_due_in_fast_lane keeps only what the user is
waiting on; established follows are left to the sweep.
"""

import unittest

try:
    import main
    _HAVE_MAIN = True
except Exception:  # noqa: BLE001 — missing runtime deps in a minimal env
    _HAVE_MAIN = False

CHECKED = "2026-08-07T02:19:03+00:00"


@unittest.skipUnless(_HAVE_MAIN, "worker runtime deps not installed")
class SeriesFastLaneTests(unittest.TestCase):
    def test_one_shot_download_all_is_due(self):
        rows = [{"series_id": "1", "follow": False, "last_checked": None}]
        self.assertEqual(main._series_due_in_fast_lane(rows), rows)

    def test_one_shot_is_due_even_after_a_previous_check(self):
        # A capped "download all" leaves works behind, so it must keep going.
        rows = [{"series_id": "1", "follow": False, "last_checked": CHECKED}]
        self.assertEqual(main._series_due_in_fast_lane(rows), rows)

    def test_never_checked_follow_is_due(self):
        rows = [{"series_id": "2", "follow": True, "last_checked": None}]
        self.assertEqual(main._series_due_in_fast_lane(rows), rows)

    def test_established_follow_is_left_to_the_sweep(self):
        rows = [{"series_id": "3", "follow": True, "last_checked": CHECKED}]
        self.assertEqual(main._series_due_in_fast_lane(rows), [])

    def test_picks_only_the_due_rows_and_keeps_order(self):
        rows = [
            {"series_id": "a", "follow": True, "last_checked": CHECKED},
            {"series_id": "b", "follow": False, "last_checked": None},
            {"series_id": "c", "follow": True, "last_checked": CHECKED},
            {"series_id": "d", "follow": True, "last_checked": None},
        ]
        self.assertEqual(
            [r["series_id"] for r in main._series_due_in_fast_lane(rows)], ["b", "d"]
        )

    def test_missing_keys_are_treated_as_due(self):
        # A row written before follow/last_checked existed must not be dropped.
        rows = [{"series_id": "4"}]
        self.assertEqual(main._series_due_in_fast_lane(rows), rows)

    def test_empty_input(self):
        self.assertEqual(main._series_due_in_fast_lane([]), [])


if __name__ == "__main__":
    unittest.main()
