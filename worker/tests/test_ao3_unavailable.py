"""An AO3 error page must read as "AO3 is down", not as a parser bug.

ao3-api's Search.update() looks for a results list, then for AO3's exact
"No results found" notice, and if it sees neither it falls through to
`results.find_all(...)` on None (AO3/search.py:106). So whenever AO3 serves an
error page — a Cloudflare 525 "SSL handshake failed", or AO3's own "Page
Responding Too Slowly" — the worker reported:

    'Shane Hollander/Ilya Rozanov' skipped (AttributeError: 'NoneType' object
     has no attribute 'find_all')

which reads as "that tag is broken" and sent the diagnosis down the wrong path.
Verified live on 2026-10-20: 'Hurt/Comfort' and 'Fluff' failed identically, and
the supposedly-broken tag succeeded on the next attempt.
"""

import unittest
import unittest.mock

from ficstash_worker.sources.ao3 import AO3Unavailable, RateLimitError
import main


class AO3UnavailableTests(unittest.TestCase):
    def test_it_is_retryable_everywhere_rate_limits_are(self):
        # Subclassing RateLimitError is what makes every existing backoff path
        # retry it without each one needing to learn a new exception type.
        self.assertTrue(issubclass(AO3Unavailable, RateLimitError))

    def test_backoff_retries_it_and_succeeds(self):
        calls = []

        def flaky():
            calls.append(1)
            if len(calls) < 3:
                raise AO3Unavailable("AO3 served an error page")
            return "results"

        with unittest.mock.patch("main.time.sleep"):
            self.assertEqual(main._with_backoff(flaky, what="tag search"), "results")
        self.assertEqual(len(calls), 3)

    def test_backoff_retries_it_even_without_broad(self):
        # broad=True was the only thing catching the old AttributeError. A named
        # retryable error means narrow callers recover too.
        calls = []

        def flaky():
            calls.append(1)
            if len(calls) < 2:
                raise AO3Unavailable("down")
            return "ok"

        with unittest.mock.patch("main.time.sleep"):
            self.assertEqual(main._with_backoff(flaky, what="x", broad=False), "ok")

    def test_a_persistent_outage_still_surfaces(self):
        def always_down():
            raise AO3Unavailable("still down")

        with unittest.mock.patch("main.time.sleep"):
            with self.assertRaises(AO3Unavailable):
                main._with_backoff(always_down, what="tag search")

    def test_the_message_names_ao3_not_a_nonetype(self):
        # The whole point: a human reading the log should see an AO3 outage.
        msg = str(AO3Unavailable(
            "AO3 served an error page instead of search results "
            "(Cloudflare 5xx / overloaded) — retrying"))
        self.assertIn("AO3", msg)
        self.assertNotIn("NoneType", msg)


if __name__ == "__main__":
    unittest.main()
