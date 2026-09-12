"""A transient PostgREST error must not kill the sweep.

The 2026-09-12 nightly died 19 minutes in, before discovery, on a Supabase 504
"Gateway Timeout" answering a one-row UPDATE (mark_series_checked). Nothing was
wrong with the request; a moment later it would have succeeded. retry_transient
gives such errors a few tries — and ONLY such errors, so a genuinely bad request
still fails fast instead of being retried into the same wall four times.
"""

import unittest

from ficstash_worker.supabase_io import is_transient_error, retry_transient


class FakeAPIError(Exception):
    """Shape of postgrest.exceptions.APIError: a dict-ish with .code / .message."""

    def __init__(self, payload):
        super().__init__(str(payload))
        self.code = payload.get("code")
        self.message = payload.get("message")


# The exact error from the failed run's log.
GATEWAY_504 = FakeAPIError({
    "message": "JSON could not be generated", "code": 504,
    "hint": "Refer to full message for details",
    "details": "b'{\"message\":\"Gateway Timeout\"}'",
})


class IsTransientTests(unittest.TestCase):
    def test_the_real_504_is_transient(self):
        self.assertTrue(is_transient_error(GATEWAY_504))

    def test_502_and_503_are_transient(self):
        self.assertTrue(is_transient_error(FakeAPIError({"code": 502, "message": "Bad Gateway"})))
        self.assertTrue(is_transient_error(FakeAPIError({"code": "503", "message": "x"})))

    def test_dropped_connections_are_transient(self):
        class ConnectError(Exception): ...
        class ReadTimeout(Exception): ...
        self.assertTrue(is_transient_error(ConnectError("boom")))
        self.assertTrue(is_transient_error(ReadTimeout("boom")))

    def test_client_errors_are_not(self):
        # A bad request is wrong every time; retrying it only repeats the mistake.
        for code in (400, 401, 403, 404, 409, 422):
            self.assertFalse(is_transient_error(FakeAPIError({"code": code, "message": "nope"})), code)

    def test_constraint_and_programming_errors_are_not(self):
        self.assertFalse(is_transient_error(FakeAPIError({"code": "23505", "message": "duplicate key"})))
        self.assertFalse(is_transient_error(KeyError("source_work_id")))
        self.assertFalse(is_transient_error(ValueError("bad payload")))


class RetryTests(unittest.TestCase):
    def _run(self, outcomes, attempts=4):
        """outcomes: list of exceptions to raise in order, or a value to return."""
        calls = []
        waits = []

        def fn():
            calls.append(1)
            o = outcomes[min(len(calls) - 1, len(outcomes) - 1)]
            if isinstance(o, BaseException):
                raise o
            return o

        result = retry_transient(fn, what="test", attempts=attempts, sleep=waits.append)
        return result, len(calls), waits

    def test_returns_first_success(self):
        result, calls, waits = self._run(["ok"])
        self.assertEqual((result, calls, waits), ("ok", 1, []))

    def test_recovers_from_the_real_failure(self):
        # 504 once, then fine — the run should have survived this.
        result, calls, waits = self._run([GATEWAY_504, "ok"])
        self.assertEqual(result, "ok")
        self.assertEqual(calls, 2)
        self.assertEqual(waits, [2.0])

    def test_backs_off_between_tries(self):
        result, calls, waits = self._run([GATEWAY_504, GATEWAY_504, GATEWAY_504, "ok"])
        self.assertEqual(result, "ok")
        self.assertEqual(waits, [2.0, 4.0, 8.0])

    def test_gives_up_after_attempts_and_re_raises(self):
        # A real outage must still surface, not be swallowed.
        with self.assertRaises(FakeAPIError):
            self._run([GATEWAY_504], attempts=3)

    def test_gives_up_exactly_at_the_attempt_cap(self):
        calls = []
        def fn():
            calls.append(1); raise GATEWAY_504
        with self.assertRaises(FakeAPIError):
            retry_transient(fn, attempts=3, sleep=lambda _s: None)
        self.assertEqual(len(calls), 3)

    def test_does_not_retry_a_bad_request(self):
        bad = FakeAPIError({"code": 400, "message": "bad"})
        calls = []
        def fn():
            calls.append(1); raise bad
        with self.assertRaises(FakeAPIError):
            retry_transient(fn, attempts=4, sleep=lambda _s: None)
        self.assertEqual(len(calls), 1, "a 400 was retried")

    def test_never_sleeps_for_real_in_tests(self):
        # The injectable sleep is what keeps this suite fast.
        _, _, waits = self._run([GATEWAY_504, "ok"])
        self.assertTrue(all(isinstance(w, float) for w in waits))


if __name__ == "__main__":
    unittest.main()
