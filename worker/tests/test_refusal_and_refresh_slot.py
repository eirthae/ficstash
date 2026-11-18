"""A refused request is not retried; a covered slot refreshes chapters.

Royal Road and Scribble Hub answer the worker with a Cloudflare challenge (403).
_with_backoff used to retry that 10/25/60s on every search page — ~95s a group,
every night, for a refusal that will not change. And slots that found discovery
already covered exited, while the new-chapter refresh only reached ~60 of ~500
ongoing works per night.
"""

import time
import unittest
from unittest import mock

import requests

import main


def _http_error(code):
    resp = requests.Response()
    resp.status_code = code
    return requests.HTTPError(f"{code} Client Error: Forbidden for url: https://example", response=resp)


class RefusalTests(unittest.TestCase):
    def test_403_and_418_are_refusals(self):
        self.assertTrue(main._is_refusal(_http_error(403)))
        self.assertTrue(main._is_refusal(_http_error(418)))
        self.assertTrue(main._is_refusal(Exception("403 Client Error: Forbidden for url: x")))

    def test_other_failures_are_not(self):
        for exc in (_http_error(500), _http_error(429), ConnectionError("reset"), AttributeError("x")):
            self.assertFalse(main._is_refusal(exc), exc)

    def test_backoff_raises_a_refusal_at_once_even_when_broad(self):
        calls = []

        def fn():
            calls.append(1)
            raise _http_error(403)

        with mock.patch.object(main.time, "sleep") as slept:
            with self.assertRaises(requests.HTTPError):
                main._with_backoff(fn, what="test", broad=True)
        self.assertEqual(len(calls), 1)
        slept.assert_not_called()

    def test_backoff_still_retries_an_ordinary_failure_when_broad(self):
        calls = []

        def fn():
            calls.append(1)
            if len(calls) < 2:
                raise AttributeError("malformed page")
            return "ok"

        with mock.patch.object(main.time, "sleep"):
            self.assertEqual(main._with_backoff(fn, what="test", broad=True), "ok")
        self.assertEqual(len(calls), 2)


class RefreshSlotTests(unittest.TestCase):
    def tearDown(self):
        main._run_deadline = None

    def test_shorten_only_ever_pulls_the_deadline_in(self):
        main._run_deadline = time.monotonic() + 300 * 60
        main._shorten_run_clock(120)
        self.assertLessEqual(main._run_deadline, time.monotonic() + 120 * 60 + 1)
        tight = time.monotonic() + 5 * 60
        main._run_deadline = tight
        main._shorten_run_clock(120)
        self.assertEqual(main._run_deadline, tight)

    def test_slot_budget_default_and_override(self):
        with mock.patch.dict(main.os.environ, {"REFRESH_SLOT_MINUTES": ""}):
            self.assertEqual(main._refresh_slot_minutes(), 120)
        with mock.patch.dict(main.os.environ, {"REFRESH_SLOT_MINUTES": "90"}):
            self.assertEqual(main._refresh_slot_minutes(), 90)
        with mock.patch.dict(main.os.environ, {"REFRESH_SLOT_MINUTES": "junk"}):
            self.assertEqual(main._refresh_slot_minutes(), 120)


if __name__ == "__main__":
    unittest.main()
