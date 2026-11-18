"""A fetch that parsed a non-work page must never overwrite a stored work.

The nightly refresh re-reads metadata for every work and writes the result
straight over the row. When AO3 served an error page, the loader's tolerance for
a real ao3-api quirk let it through, the "metadata" came out blank, and the
upsert blanked a good title/author/fandom/summary and zeroed the counts while
the chapter text stayed: 504 works readable but nameless, 10-20 more a week.
"""

import unittest
from unittest import mock

from ficstash_worker.sources.ao3 import AO3NotAWorkPage, AO3Source, RateLimitError
from ficstash_worker.sources.base import WorkMeta
from ficstash_worker.supabase_io import upsert_work


def _meta(title, source="ao3"):
    return WorkMeta(source=source, source_work_id="123", title=title, author="someone")


class BlankTitleGuardTests(unittest.TestCase):
    def test_source_raises_a_retryable_error_for_a_titleless_page(self):
        src = AO3Source()
        src._work_cache["123"] = object()
        with mock.patch.object(src, "_load_work", return_value=object()), \
             mock.patch("ficstash_worker.sources.ao3._work_to_meta", return_value=_meta("")):
            with self.assertRaises(AO3NotAWorkPage) as ctx:
                src.fetch_work_metadata("123")
        # Not retryable: a work served this way every time must not cost ~95s of
        # backoff on every run.
        self.assertNotIsInstance(ctx.exception, RateLimitError)
        # The bad page is forgotten, so a retry fetches a fresh one.
        self.assertNotIn("123", src._work_cache)

    def test_source_returns_real_metadata_untouched(self):
        src = AO3Source()
        with mock.patch.object(src, "_load_work", return_value=object()), \
             mock.patch("ficstash_worker.sources.ao3._work_to_meta", return_value=_meta("A Real Title")):
            self.assertEqual(src.fetch_work_metadata("123").title, "A Real Title")

    def test_upsert_refuses_a_blank_ao3_title_before_touching_the_database(self):
        client = mock.Mock()
        for blank in ("", "   ", None):
            with self.assertRaises(ValueError):
                upsert_work(client, _meta(blank))
        client.table.assert_not_called()


if __name__ == "__main__":
    unittest.main()
