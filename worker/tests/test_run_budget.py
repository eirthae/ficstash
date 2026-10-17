"""Nothing may consume the whole run and starve what comes after it.

Oct 14-16 2026: three consecutive nightlies logged "Refresh ongoing: 0 updated,
0 unchanged, 0 failed" — the new-chapter check never started. The AO3 series
pass, the one heavy pass with no budget check, spent the entire 165-minute
budget re-enumerating 108 follows, and discovery + refresh got the scraps.
Discovery also only ever reached the same ~19 of 46 groups, because the groups
came back in a stable order and truncation always cut at the same place.
"""

import os
import unittest
from unittest import mock

import main


class SeriesSweepModeTests(unittest.TestCase):
    """Nightly skips series; the weekly run does series only."""

    def _mode(self, value):
        env = {"SERIES_SWEEP": value} if value is not None else {}
        with mock.patch.dict(os.environ, env, clear=False):
            if value is None:
                os.environ.pop("SERIES_SWEEP", None)
            return main._series_sweep()

    def test_defaults_to_full(self):
        # A manual run with nothing set behaves exactly as it always did.
        self.assertEqual(self._mode(None), "full")

    def test_reads_the_three_modes(self):
        for v in ("full", "skip", "only"):
            self.assertEqual(self._mode(v), v)

    def test_is_case_insensitive_and_trims(self):
        self.assertEqual(self._mode("  ONLY "), "only")

    def test_unknown_value_falls_back_to_full(self):
        # A typo must not silently disable the series sweep forever.
        self.assertEqual(self._mode("weekly"), "full")
        self.assertEqual(self._mode(""), "full")


class BudgetReserveTests(unittest.TestCase):
    """Earlier passes stop early so the refresh at the END still gets a turn."""

    def tearDown(self):
        main._run_deadline = None

    def test_no_deadline_means_always_within_budget(self):
        main._run_deadline = None
        self.assertTrue(main._within_budget())
        self.assertTrue(main._within_budget(9999))

    def test_reserve_closes_the_door_earlier(self):
        import time as _t
        # 10 minutes left on the clock.
        main._run_deadline = _t.monotonic() + 600
        self.assertTrue(main._within_budget())            # refresh itself: fine
        self.assertTrue(main._within_budget(300))         # 5-min reserve: still fine
        self.assertFalse(main._within_budget(900))        # 15-min reserve: stop now

    def test_an_exhausted_budget_is_closed_to_everyone(self):
        import time as _t
        main._run_deadline = _t.monotonic() - 1
        self.assertFalse(main._within_budget())
        self.assertFalse(main._within_budget(60))

    def test_reserve_default_and_override(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("REFRESH_RESERVE_MINUTES", None)
            self.assertEqual(main._refresh_reserve_seconds(), 45 * 60)
        with mock.patch.dict(os.environ, {"REFRESH_RESERVE_MINUTES": "10"}):
            self.assertEqual(main._refresh_reserve_seconds(), 600)

    def test_a_junk_reserve_falls_back_rather_than_crashing(self):
        with mock.patch.dict(os.environ, {"REFRESH_RESERVE_MINUTES": "soon"}):
            self.assertEqual(main._refresh_reserve_seconds(), 45 * 60)

    def test_reserve_can_be_disabled(self):
        with mock.patch.dict(os.environ, {"REFRESH_RESERVE_MINUTES": "0"}):
            self.assertEqual(main._refresh_reserve_seconds(), 0)

    def test_negative_reserve_is_clamped_to_zero(self):
        with mock.patch.dict(os.environ, {"REFRESH_RESERVE_MINUTES": "-30"}):
            self.assertEqual(main._refresh_reserve_seconds(), 0)


if __name__ == "__main__":
    unittest.main()
