"""Which one-group runs may proceed without AO3.

A Royal Road or Scribble Hub group can be synced while AO3 is paused, because
that run never logs in to AO3 and skips every pass that would fetch from it.
The gate is _non_ao3_source: it must say "not AO3" only when that is certain,
and resolve every doubt to "" (treat as AO3, honour the pause).
"""

import unittest

import main


class NonAo3SourceTests(unittest.TestCase):
    def test_a_named_other_source_is_allowed(self):
        self.assertEqual(main._non_ao3_source({"source": "scribblehub"}), "scribblehub")
        self.assertEqual(main._non_ao3_source({"source": " RoyalRoad "}), "royalroad")

    def test_ao3_is_never_offline(self):
        self.assertEqual(main._non_ao3_source({"source": "ao3"}), "")
        self.assertEqual(main._non_ao3_source({"source": "AO3"}), "")

    def test_every_doubt_resolves_to_ao3(self):
        for row in ({}, None, {"source": None}, {"source": ""}, {"source": "  "}, {"source": 7}):
            self.assertEqual(main._non_ao3_source(row), "", row)


if __name__ == "__main__":
    unittest.main()
