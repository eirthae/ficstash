"""Recognising AO3's "not now" so a run stands down after one request.

AO3 returned from its 2026 outage behind a robot check. A resume attempt made
~15 refused requests in one small test run (3 logins, 4 saves, 4 searches with
retries); a full nightly would have made a few hundred. A deliberate refusal is
not an overload: the run must ask once, recognise it, and stop.
"""

import unittest

import main


class Ao3DenialTests(unittest.TestCase):
    def test_the_418_the_worker_actually_received(self):
        body = "<title>Request temporarily denied. | Archive of Our Own</title> The archive is down for maintenance."
        self.assertTrue(main._ao3_denial(418, body))

    def test_the_browser_challenge_page(self):
        self.assertTrue(main._ao3_denial(403, "<title>Just a moment...</title> Shields are up! prove that you are not a robot"))
        self.assertTrue(main._ao3_denial(200, "<h1>Shields are up!</h1>"))

    def test_a_plain_403_is_a_denial(self):
        self.assertTrue(main._ao3_denial(403, ""))

    def test_a_normal_page_is_not(self):
        self.assertEqual(main._ao3_denial(200, "<title>Home | Archive of Our Own</title> Find your favorites"), "")

    def test_overload_is_not_a_denial(self):
        # 5xx under load is the existing backoff's job, not a reason to stand down.
        for status in (500, 502, 503, 525):
            self.assertEqual(main._ao3_denial(status, "<h1>Error</h1> SSL handshake failed"), "", status)

    def test_empty_inputs_are_safe(self):
        self.assertEqual(main._ao3_denial(200, ""), "")
        self.assertEqual(main._ao3_denial(200, None), "")


if __name__ == "__main__":
    unittest.main()
