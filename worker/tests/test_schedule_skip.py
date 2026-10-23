"""The multi-slot schedule's "another slot already did this" check.

GitHub does not guarantee scheduled runs — nothing fired on 2026-10-20, 10-21 or
10-22 against crons that were in place — so the schedule now has three slots a
day and the runs decide between themselves which one does the work.

The first version of that check shipped broken and said nothing about it: it ran
max() over every group's last_checked, two groups had never been checked (None),
and comparing datetime to None raised TypeError. A defensive except swallowed it
and ran anyway, so nothing visibly failed — the check simply never fired, and
every slot did a full sweep. These tests pin the decision itself.
"""

import unittest
from datetime import datetime, timedelta, timezone


def _decide(stamps, skip_hours, now=None):
    """Mirror of main()'s freshness decision. True = skip this run.

    Kept as a pure function here because the real one lives inside main(),
    wrapped around a live Supabase client — which is exactly why its failure was
    invisible until a production log admitted it.
    """
    now = now or datetime.now(timezone.utc)
    if not skip_hours:
        return False
    # Nones are dropped, not counted: a tag AO3 refuses run after run stays null
    # forever, so treating "never checked" as work-to-do would make every slot a
    # full sweep and the skip pointless.
    newest = max((t for t in stamps if t is not None), default=None)
    if newest is None:
        return False
    return (now - newest).total_seconds() / 3600 < skip_hours


class ScheduleSkipTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 23, 12, 0, tzinfo=timezone.utc)

    def test_a_mix_of_stamps_and_nones_does_not_explode(self):
        # The exact shape that broke it: max() over datetimes AND Nones raised
        # TypeError, which a defensive except swallowed, so the check never
        # fired. A permanently-unreachable tag must not force a full sweep at
        # every slot either — the recent stamp wins and this one skips.
        stamps = [self.now - timedelta(hours=1), None, self.now - timedelta(hours=2)]
        self.assertTrue(_decide(stamps, 10, self.now))

    def test_a_stale_run_still_runs_even_with_nones_present(self):
        stamps = [self.now - timedelta(hours=20), None]
        self.assertFalse(_decide(stamps, 10, self.now))

    def test_all_none_does_not_skip(self):
        # Nothing has ever been checked: there is genuinely nothing to go on.
        self.assertFalse(_decide([None, None], 10, self.now))

    def test_skips_when_another_slot_just_covered_it(self):
        self.assertTrue(_decide([self.now - timedelta(hours=4)], 10, self.now))

    def test_runs_when_the_last_pass_is_stale(self):
        self.assertFalse(_decide([self.now - timedelta(hours=11)], 10, self.now))

    def test_boundary_is_not_a_skip(self):
        self.assertFalse(_decide([self.now - timedelta(hours=10)], 10, self.now))

    def test_disabled_when_no_window_is_set(self):
        # Manual runs pass no window and must always do the work.
        self.assertFalse(_decide([self.now], 0, self.now))

    def test_no_groups_at_all_does_not_skip(self):
        self.assertFalse(_decide([], 10, self.now))


if __name__ == "__main__":
    unittest.main()
