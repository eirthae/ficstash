"""A logged-in AO3 session must still get the view_adult cookie.

Regression: when the worker logs in (AO3_USERNAME/PASSWORD set), authenticate()
installed the session but _require_session() never ran its cookie step (that only
fires for the guest session it creates). So Explicit/Mature works hit AO3's adult
interstitial, parsed as zero chapters, and saved works stuck "downloading" forever.
"""

import unittest

import ficstash_worker.sources.ao3 as ao3mod
from ficstash_worker.sources.ao3 import AO3Source


class FakeCookies:
    def __init__(self):
        self.jar = {}

    def set(self, name, value, domain=None):
        self.jar[(name, domain)] = value


class FakeRequests:
    def __init__(self):
        self.cookies = FakeCookies()


class FakeLoggedInSession:
    """Stands in for AO3.Session(user, pw) — wraps a requests session like ao3-api."""

    def __init__(self, username, password):
        self.session = FakeRequests()
        self.username = username


class AuthAdultCookieTests(unittest.TestCase):
    def setUp(self):
        self._orig = ao3mod.AO3.Session
        ao3mod.AO3.Session = FakeLoggedInSession  # no network login

    def tearDown(self):
        ao3mod.AO3.Session = self._orig

    def test_login_sets_view_adult_cookie(self):
        src = AO3Source()
        name = src.authenticate("reader", "secret")
        self.assertEqual(name, "reader")
        jar = src._session.session.cookies.jar
        self.assertEqual(jar.get(("view_adult", "archiveofourown.org")), "true")


if __name__ == "__main__":
    unittest.main()
