"""A dismissal must not cross sources.

`source_work_id` is only unique WITHIN a source: AO3 work 12345 and Royal Road
fiction 12345 are different stories. propagate_dismissals used to match on the
bare id, so dismissing one marked the other dismissed too — and because the Later
stash reads `dismissed = false`, that silently removed a work the user had
deliberately set aside and never touched.

No network, no real DB: a fake client applies eq / in_ so the real query logic runs.
"""

import unittest
from types import SimpleNamespace

from ficstash_worker.supabase_io import (
    fetch_dismissed_work_ids,
    propagate_dismissals,
)


class FakeQuery:
    def __init__(self, rows, client=None, patch=None):
        self._rows = rows           # live references, so updates stick
        self._client = client
        self._patch = patch

    def eq(self, col, val):
        self._rows = [r for r in self._rows if r.get(col) == val]
        return self

    def in_(self, col, vals):
        s = set(vals)
        self._rows = [r for r in self._rows if r.get(col) in s]
        return self

    def execute(self):
        if self._patch is not None:
            for r in self._rows:
                r.update(self._patch)
        return SimpleNamespace(data=list(self._rows))


class FakeClient:
    def __init__(self, rows):
        self.rows = rows

    def table(self, _name):
        return self

    def select(self, *_a, **_k):
        return FakeQuery(self.rows)

    def update(self, patch):
        return FakeQuery(self.rows, client=self, patch=patch)


def rows():
    return [
        # Dismissed on AO3 — the trigger.
        {"id": "1", "source": "ao3", "source_work_id": "12345", "dismissed": True, "later": False},
        # Same work under another AO3 tag → SHOULD be dismissed too.
        {"id": "2", "source": "ao3", "source_work_id": "12345", "dismissed": False, "later": False},
        # A DIFFERENT story that happens to share the id → must be untouched.
        {"id": "3", "source": "royalroad", "source_work_id": "12345", "dismissed": False, "later": True},
        # Unrelated work, untouched.
        {"id": "4", "source": "ao3", "source_work_id": "99999", "dismissed": False, "later": False},
    ]


class DismissalScopeTests(unittest.TestCase):
    def test_tombstone_keys_carry_the_source(self):
        keys = fetch_dismissed_work_ids(FakeClient(rows()))
        self.assertEqual(keys, {("ao3", "12345")})

    def test_dismissal_spreads_within_its_own_source(self):
        c = FakeClient(rows())
        propagate_dismissals(c)
        self.assertTrue(next(r for r in c.rows if r["id"] == "2")["dismissed"])

    def test_dismissal_does_not_cross_sources(self):
        c = FakeClient(rows())
        propagate_dismissals(c)
        other = next(r for r in c.rows if r["id"] == "3")
        self.assertFalse(other["dismissed"], "a Royal Road work was dismissed by an AO3 dismissal")

    def test_a_later_row_of_another_source_survives(self):
        # The user-visible symptom: it vanished from the Later stash.
        c = FakeClient(rows())
        propagate_dismissals(c)
        stashed = next(r for r in c.rows if r["id"] == "3")
        self.assertTrue(stashed["later"] and not stashed["dismissed"])

    def test_unrelated_ids_are_untouched(self):
        c = FakeClient(rows())
        propagate_dismissals(c)
        self.assertFalse(next(r for r in c.rows if r["id"] == "4")["dismissed"])

    def test_counts_only_rows_newly_hidden(self):
        self.assertEqual(propagate_dismissals(FakeClient(rows())), 1)

    def test_nothing_dismissed_is_a_no_op(self):
        c = FakeClient([{"id": "1", "source": "ao3", "source_work_id": "1", "dismissed": False}])
        self.assertEqual(propagate_dismissals(c), 0)


if __name__ == "__main__":
    unittest.main()
