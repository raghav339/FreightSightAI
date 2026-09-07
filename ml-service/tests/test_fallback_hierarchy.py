# ml-service/tests/test_fallback_hierarchy.py
#
# Real, executable unit tests for the Phase 7 deterministic fallback
# hierarchy (app/utils.py:ModelBundle._resolve_lookup). Requires trained
# model artifacts in ml-service/models/ (run `python train.py` first if
# they're missing). Run with:
#
#   cd ml-service && python -m unittest tests.test_fallback_hierarchy -v
#
# These tests do NOT assert on constant numeric values (that would be
# brittle against any future retrain) — they assert on the *level* label
# and on internal consistency (e.g. the commodity-level average actually
# equals the mean of the matching destination_commodity rows), which is
# what actually matters for Phase 7 ("never falls back to an arbitrary/
# unrelated entry").
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "models")


@unittest.skipUnless(
    os.path.exists(os.path.join(MODELS_DIR, "metadata.json")),
    "No trained model artifacts found — run `python train.py` first.",
)
class TestFallbackHierarchy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from app.utils import ModelBundle

        cls.bundle = ModelBundle()
        cls.table = cls.bundle.meta["latest_lookup"]

    def test_exact_destination_commodity_match_uses_top_level(self):
        # Pick a real key straight out of the trained lookup table, so this
        # test is valid regardless of which ports/commodities a given
        # training run happened to include.
        key = next(iter(self.table))
        destination, commodity = key.split("|", 1)
        _, level = self.bundle._resolve_lookup(destination, commodity)
        self.assertEqual(level, "destination_commodity")

    def test_unknown_destination_known_commodity_falls_back_to_commodity_level(self):
        commodity = next(iter(self.table)).split("|", 1)[1]
        lookup, level = self.bundle._resolve_lookup("Nonexistent Port XYZ", commodity)
        self.assertEqual(level, "commodity")
        # Sanity: the returned values are genuinely an average of the
        # matching rows, not an arbitrary single entry re-labelled.
        matches = [v for k, v in self.table.items() if k.endswith(f"|{commodity}")]
        self.assertGreaterEqual(len(matches), 1)
        for feat in self.bundle.meta["numeric_features"]:
            expected = sum(m[feat] for m in matches) / len(matches)
            self.assertAlmostEqual(lookup[feat], expected, places=6)

    def test_unknown_destination_and_commodity_falls_back_to_global_proxy(self):
        lookup, level = self.bundle._resolve_lookup(
            "Nonexistent Port XYZ", "Nonexistent Commodity XYZ"
        )
        self.assertEqual(level, "global_proxy")
        all_values = list(self.table.values())
        for feat in self.bundle.meta["numeric_features"]:
            expected = sum(v[feat] for v in all_values) / len(all_values)
            self.assertAlmostEqual(lookup[feat], expected, places=6)

    def test_fallback_never_returns_an_arbitrary_single_unrelated_entry(self):
        """Regression guard for the exact bug Phase 7 removed: the old
        `next(iter(...))` fallback would silently return the FIRST entry
        in the table regardless of relevance. Confirm the global-proxy
        result is the mean of every entry, not equal to any one arbitrary
        entry (unless the table only has one row, which real training
        data won't)."""
        _, level = self.bundle._resolve_lookup("Nonexistent Port XYZ", "Nonexistent Commodity XYZ")
        self.assertEqual(level, "global_proxy")
        first_entry = next(iter(self.table.values()))
        lookup, _ = self.bundle._resolve_lookup("Nonexistent Port XYZ", "Nonexistent Commodity XYZ")
        if len(self.table) > 1:
            differs = any(
                abs(lookup[feat] - first_entry[feat]) > 1e-9
                for feat in self.bundle.meta["numeric_features"]
                if feat in first_entry
            )
            self.assertTrue(differs, "global proxy result matches the first table entry exactly — looks like an arbitrary fallback, not an average")


if __name__ == "__main__":
    unittest.main()
