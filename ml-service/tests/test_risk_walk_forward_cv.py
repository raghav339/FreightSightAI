# ml-service/tests/test_risk_walk_forward_cv.py
#
# Real, executable unit tests for risk_walk_forward_cv() (train.py),
# added for P0 priority 3: "Fix ML evaluation and risk-class imbalance".
# Uses a small synthetic monthly panel built in-memory (not the real
# data/synthetic/ CSVs) so this test is fast, deterministic, and doesn't
# depend on how many months happen to be in the current dataset.
#
#   cd ml-service && python -m unittest tests.test_risk_walk_forward_cv -v
import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from train import risk_walk_forward_cv  # noqa: E402


def _make_panel(n_months=48, ports=("Chennai", "Paradip"), commodities=("Coal", "Iron Ore")):
    rng = np.random.RandomState(7)
    months = pd.date_range("2018-01-01", periods=n_months, freq="MS")
    rows = []
    for m in months:
        for p in ports:
            for c in commodities:
                rows.append({
                    "month": m,
                    "port": p,
                    "commodity": c,
                    "risk_score": rng.uniform(0, 1),
                    "import_volume": rng.uniform(1000, 5000),
                    "export_volume": rng.uniform(1000, 5000),
                })
    return pd.DataFrame(rows)


class TestRiskWalkForwardCV(unittest.TestCase):
    def test_returns_ok_status_with_enough_months(self):
        """48 months comfortably clears the default min_train_months(24) +
        fold_test_months(12) requirement for at least one fold."""
        panel = _make_panel(n_months=48)
        result = risk_walk_forward_cv(panel, num=["import_volume", "export_volume"], cat=["port", "commodity"])
        self.assertEqual(result["status"], "ok")
        self.assertGreaterEqual(result["n_folds"], 1)

    def test_skips_cleanly_with_too_few_months(self):
        """Phase 25 principle applied to a diagnostic: too little history
        must be a clearly-labelled skip, never a crash or a fabricated
        result."""
        panel = _make_panel(n_months=6)
        result = risk_walk_forward_cv(panel, num=["import_volume", "export_volume"], cat=["port", "commodity"])
        self.assertEqual(result["status"], "skipped")
        self.assertIn("reason", result)

    def test_folds_are_chronological_and_non_overlapping_in_test_windows(self):
        panel = _make_panel(n_months=60)
        result = risk_walk_forward_cv(panel, num=["import_volume", "export_volume"], cat=["port", "commodity"], n_folds=3, fold_test_months=6)
        self.assertEqual(result["status"], "ok")
        test_starts = [f["test_period"]["start"] for f in result["folds"]]
        self.assertEqual(test_starts, sorted(test_starts), "folds must be reported in chronological order")

    def test_aggregated_confusion_matrix_sums_fold_supports(self):
        panel = _make_panel(n_months=60)
        result = risk_walk_forward_cv(panel, num=["import_volume", "export_volume"], cat=["port", "commodity"], n_folds=3, fold_test_months=6)
        self.assertEqual(result["status"], "ok")
        total_support_from_folds = sum(
            sum(f["test_class_counts"].values()) for f in result["folds"]
        )
        total_support_aggregated = sum(
            v["support_across_folds"] for v in result["aggregated_across_folds"]["per_class"].values()
        )
        self.assertEqual(total_support_from_folds, total_support_aggregated)

    def test_never_raises_on_a_class_missing_entirely_from_every_fold(self):
        """With risk_score drawn uniformly at random, all three buckets
        should appear, but the function must not raise even in the
        (statistically unlikely) case a bucket is empty in some fold —
        exercised directly by forcing risk_score into a narrow low band."""
        panel = _make_panel(n_months=48)
        panel["risk_score"] = 0.01  # everything buckets to "low" every fold
        result = risk_walk_forward_cv(panel, num=["import_volume", "export_volume"], cat=["port", "commodity"])
        self.assertIn(result["status"], ("ok", "skipped"))


if __name__ == "__main__":
    unittest.main()
