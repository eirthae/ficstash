"""AO3 search going down must cost minutes, not the whole night.

After the 2026 outage AO3's front page, login and work pages worked while its
search pages hung. With no request timeout, each hung search waited for
Cloudflare (~100s), was retried 5x by the adapter and 4x by the backoff, and a
nightly spent ~4 hours getting 4 of 33 groups through while the chapter refresh
starved. Now every AO3 request has a timeout, a hang isn't retried at the
transport layer, and several groups failing in a row stops searching for the run.
"""

import unittest
from unittest import mock

import requests

import main
from ficstash_worker.sources import ao3 as ao3mod


class TimeoutAdapterTests(unittest.TestCase):
    def test_a_default_timeout_is_applied_when_none_was_given(self):
        adapter = ao3mod._TimeoutAdapter()
        seen = {}

        def fake_send(self, request, **kwargs):
            seen.update(kwargs)
            return "ok"

        with mock.patch.object(requests.adapters.HTTPAdapter, "send", fake_send):
            adapter.send(requests.Request("GET", "https://example.org").prepare())
        self.assertEqual(seen.get("timeout"), ao3mod.AO3_TIMEOUT)

    def test_an_explicit_timeout_is_left_alone(self):
        adapter = ao3mod._TimeoutAdapter()
        seen = {}

        def fake_send(self, request, **kwargs):
            seen.update(kwargs)
            return "ok"

        with mock.patch.object(requests.adapters.HTTPAdapter, "send", fake_send):
            adapter.send(requests.Request("GET", "https://example.org").prepare(), timeout=5)
        self.assertEqual(seen.get("timeout"), 5)

    def test_install_retry_mounts_the_timeout_adapter_without_read_retries(self):
        holder = type("H", (), {})()
        holder.session = requests.Session()
        ao3mod._install_retry(holder)
        mounted = holder.session.get_adapter("https://archiveofourown.org/")
        self.assertIsInstance(mounted, ao3mod._TimeoutAdapter)
        self.assertEqual(mounted.max_retries.read, 0)


class BreakerSettingTests(unittest.TestCase):
    def test_default_and_overrides(self):
        with mock.patch.dict(main.os.environ, {"SEARCH_BREAKER_AFTER": ""}):
            self.assertEqual(main._search_breaker_after(), 4)
        with mock.patch.dict(main.os.environ, {"SEARCH_BREAKER_AFTER": "6"}):
            self.assertEqual(main._search_breaker_after(), 6)
        with mock.patch.dict(main.os.environ, {"SEARCH_BREAKER_AFTER": "0"}):
            self.assertGreater(main._search_breaker_after(), 10**6)  # disabled
        with mock.patch.dict(main.os.environ, {"SEARCH_BREAKER_AFTER": "x"}):
            self.assertEqual(main._search_breaker_after(), 4)


if __name__ == "__main__":
    unittest.main()
