"""AO3 sits behind Cloudflare, which 525s datacenter IPs (the worker's runner).
A single try parses that error page as zero chapters, so a saved/queued work comes
back empty and re-queues forever. _install_retry must mount a requests adapter that
retries Cloudflare 5xx so an intermittent good response gets caught.
"""

import unittest

import requests

from ficstash_worker.sources.ao3 import _CLOUDFLARE_5XX, _install_retry


class FakeSession:
    """Stands in for an AO3.Session/GuestSession: holds a real requests.Session on
    .session (the attribute _install_retry / _enable_adult_view look up)."""

    def __init__(self):
        self.session = requests.Session()


class InstallRetryTests(unittest.TestCase):
    def _mounted_retry(self, sess):
        adapter = sess.session.get_adapter("https://archiveofourown.org/works/1")
        return adapter.max_retries

    def test_525_is_in_the_retry_forcelist(self):
        self.assertIn(525, _CLOUDFLARE_5XX)

    def test_mounts_an_adapter_that_retries_cloudflare_5xx(self):
        sess = FakeSession()
        _install_retry(sess)
        retry = self._mounted_retry(sess)
        # The mounted adapter retries (not the requests default of 0) and targets
        # the Cloudflare statuses, including 525.
        self.assertGreaterEqual(retry.total, 1)
        self.assertIn(525, set(retry.status_forcelist or ()))
        # A genuine miss is handed back, not raised, so existing empty/restricted
        # handling still decides the outcome.
        self.assertFalse(retry.raise_on_status)

    def test_applies_to_both_http_and_https(self):
        sess = FakeSession()
        _install_retry(sess)
        for url in ("https://archiveofourown.org/x", "http://archiveofourown.org/x"):
            retry = sess.session.get_adapter(url).max_retries
            self.assertIn(525, set(retry.status_forcelist or ()))

    def test_no_session_attribute_is_a_safe_noop(self):
        class Empty:
            pass

        _install_retry(Empty())  # must not raise


if __name__ == "__main__":
    unittest.main()
