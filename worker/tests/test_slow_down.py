"""AO3 saying "slow down" ends searching for the run.

Since its 2026 outage AO3 rations searches. A nightly retried each "We are
being rate-limited" 10/25/60s later and then moved on to the next group to do
it again; and because groups went stalest-first, the same heavy groups failed
first every night and tripped the breaker before the rest got a turn.
"""

import unittest
from unittest import mock

import main
from ficstash_worker.sources.ao3 import AO3Unavailable, RateLimitError


class AO3StyleHTTPError(Exception):
    """Stands in for ao3-api's own HTTPError, which is how the slow-down arrives."""


class SlowDownTests(unittest.TestCase):
    def test_what_counts_as_a_slow_down(self):
        self.assertTrue(main._is_slow_down(AO3StyleHTTPError(
            "We are being rate-limited. Try again in a while or reduce the number of requests")))
        self.assertTrue(main._is_slow_down(RateLimitError("429")))
        # An error page under load is not a slow-down: a wait can fix it.
        self.assertFalse(main._is_slow_down(AO3Unavailable("AO3 served an error page")))
        self.assertFalse(main._is_slow_down(ConnectionError("reset")))

    def test_discovery_does_not_retry_a_slow_down(self):
        calls = []

        def fn():
            calls.append(1)
            raise AO3StyleHTTPError("We are being rate-limited. Try again in a while")

        with mock.patch.object(main.time, "sleep") as slept:
            with self.assertRaises(AO3StyleHTTPError):
                main._with_backoff(fn, what="t", broad=True, retry_slow_down=False)
        self.assertEqual(len(calls), 1)
        slept.assert_not_called()

    def test_other_callers_keep_their_backoff(self):
        calls = []

        def fn():
            calls.append(1)
            if len(calls) < 2:
                raise RateLimitError("429")
            return "ok"

        with mock.patch.object(main.time, "sleep"):
            self.assertEqual(main._with_backoff(fn, what="t"), "ok")
        self.assertEqual(len(calls), 2)

    def test_an_error_page_is_still_retried_during_discovery(self):
        calls = []

        def fn():
            calls.append(1)
            if len(calls) < 2:
                raise AO3Unavailable("AO3 served an error page")
            return "ok"

        with mock.patch.object(main.time, "sleep"):
            self.assertEqual(main._with_backoff(fn, what="t", broad=True, retry_slow_down=False), "ok")


if __name__ == "__main__":
    unittest.main()
