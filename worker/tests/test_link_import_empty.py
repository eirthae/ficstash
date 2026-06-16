"""Regression tests for how the requested-links pass handles an AO3 work that
fetches with NO chapters.

AO3's adult / age gate routinely parses as zero chapters (see test_saves), so an
empty result for a real AO3 work must never be silently deleted — that left a
pasted link showing "Downloading…" forever with no work and no error. It should
instead be flagged members-only (terminal) or re-queued to retry.

`main` imports the worker's runtime deps (supabase, ao3-api, …); skip cleanly if
they aren't installed so a lightweight test run still passes.
"""

import unittest

try:
    import main  # noqa: F401
    _HAVE_MAIN = True
except Exception:  # noqa: BLE001 — missing runtime deps in a minimal env
    _HAVE_MAIN = False


class FakeAO3:
    def __init__(self, restricted):
        self._restricted = restricted
        self.checked = []

    def is_restricted(self, wid):
        self.checked.append(wid)
        return self._restricted


@unittest.skipUnless(_HAVE_MAIN, "worker runtime deps not installed")
class HandleEmptyAo3LinkTests(unittest.TestCase):
    def setUp(self):
        # Record mark_request calls instead of hitting Supabase.
        self._orig = main.mark_request
        self.calls = []
        main.mark_request = lambda db, rid, **f: self.calls.append((rid, f))

    def tearDown(self):
        main.mark_request = self._orig

    def test_restricted_work_is_a_terminal_error(self):
        ao3 = FakeAO3(restricted=True)
        terminal = main._handle_empty_ao3_link(db=object(), rid="r1", ao3=ao3, wid="123")
        self.assertTrue(terminal)
        self.assertEqual(len(self.calls), 1)
        rid, fields = self.calls[0]
        self.assertEqual(rid, "r1")
        self.assertEqual(fields.get("status"), "error")
        self.assertIn("AO3", fields.get("error", ""))

    def test_transient_empty_is_requeued_not_deleted(self):
        ao3 = FakeAO3(restricted=False)
        terminal = main._handle_empty_ao3_link(db=object(), rid="r2", ao3=ao3, wid="456")
        self.assertFalse(terminal)  # re-queued, not a terminal failure
        self.assertEqual(len(self.calls), 1)
        rid, fields = self.calls[0]
        self.assertEqual(rid, "r2")
        # Put back to 'queued' so the next sync retries — never deleted.
        self.assertEqual(fields.get("status"), "queued")


if __name__ == "__main__":
    unittest.main()
