"""Unit tests for AO3 restricted-work (members-only) detection."""

import unittest

from ficstash_worker.sources.ao3 import _is_restricted_redirect


class RestrictedRedirectTests(unittest.TestCase):
    def test_members_only_redirect_is_restricted(self):
        loc = "https://archiveofourown.org/users/login?restricted=true&return_to=%2Fworks%2F123"
        self.assertTrue(_is_restricted_redirect(302, loc))
        self.assertTrue(_is_restricted_redirect(303, "/users/login?restricted=true"))

    def test_case_insensitive(self):
        self.assertTrue(_is_restricted_redirect(302, "/USERS/LOGIN?RESTRICTED=TRUE"))

    def test_plain_login_or_other_redirect_not_restricted(self):
        self.assertFalse(_is_restricted_redirect(302, "https://archiveofourown.org/users/login"))
        self.assertFalse(_is_restricted_redirect(302, "/works/123?view_adult=true"))

    def test_non_redirect_status_not_restricted(self):
        self.assertFalse(_is_restricted_redirect(200, "anything"))
        self.assertFalse(_is_restricted_redirect(404, ""))

    def test_missing_location_not_restricted(self):
        self.assertFalse(_is_restricted_redirect(302, None))
        self.assertFalse(_is_restricted_redirect(302, ""))


if __name__ == "__main__":
    unittest.main()
