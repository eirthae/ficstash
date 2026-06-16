"""is_restricted() must survive AO3's flakiness.

AO3 frequently times out. A single swallowed timeout used to make is_restricted()
return False, mislabeling a genuinely members-only work as fetchable — which then
looped as an empty re-queue instead of the honest "read on AO3" label. It must
retry a transient error before giving up.
"""

import unittest

import ficstash_worker.sources.ao3 as ao3mod
from ficstash_worker.sources.ao3 import AO3Source


class FakeResp:
    def __init__(self, status_code, location=""):
        self.status_code = status_code
        self.headers = {"Location": location} if location else {}


class FakeRequests:
    """Stands in for requests.Session: returns a scripted sequence; an entry that
    is an Exception instance is raised to simulate a network hiccup."""

    def __init__(self, script):
        self._script = list(script)
        self.calls = 0

    def get(self, url, allow_redirects=True, timeout=None):
        self.calls += 1
        item = self._script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class FakeSession:
    def __init__(self, script):
        self.session = FakeRequests(script)


_RESTRICTED_LOC = "https://archiveofourown.org/users/login?restricted=true&return_to=%2Fworks%2F1"


class IsRestrictedRetryTests(unittest.TestCase):
    def setUp(self):
        self._sleep = ao3mod.time.sleep
        ao3mod.time.sleep = lambda *_a, **_k: None  # no real waiting in tests

    def tearDown(self):
        ao3mod.time.sleep = self._sleep

    def _src(self, script):
        src = AO3Source()
        src._session = FakeSession(script)  # bypass real GuestSession
        return src

    def test_retries_past_a_timeout_then_detects_restricted(self):
        src = self._src([TimeoutError("read timed out"), FakeResp(302, _RESTRICTED_LOC)])
        self.assertTrue(src.is_restricted("1"))
        self.assertEqual(src._session.session.calls, 2)  # retried after the timeout

    def test_public_work_is_not_restricted(self):
        src = self._src([FakeResp(200)])
        self.assertFalse(src.is_restricted("1"))

    def test_gives_up_after_persistent_errors_without_crashing(self):
        src = self._src([TimeoutError("t"), TimeoutError("t"), TimeoutError("t")])
        self.assertFalse(src.is_restricted("1"))  # can't confirm → caller retries later
        self.assertEqual(src._session.session.calls, 3)


if __name__ == "__main__":
    unittest.main()
