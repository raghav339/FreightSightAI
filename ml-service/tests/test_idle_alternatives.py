# ml-service/tests/test_idle_alternatives.py
#
# Real, executable tests of ModelBundle.idle_alternatives() — the logic
# behind POST /idle-alternatives — run directly against the project's
# checked-in production model artifacts (ml-service/models/), the same
# way test_predict_integration.py does. A duck-typed stand-in for
# schemas.IdleAlternativesRequest is used so these tests don't require
# pydantic to be installed; idle_alternatives() only ever reads
# attributes off the request object.
#
# This also carries forward the regression test intent for
# `idle_alternatives_exclude_current_port` already noted in
# test_predict_integration.py, which previously errored only because
# pydantic wasn't installed (see Task 1) — asserted here in full, not
# just "stops erroring".
#
# Run with:
#   cd ml-service && python -m unittest tests.test_idle_alternatives -v
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tests._shared_models import get_bundle  # noqa: E402


def make_request(**overrides):
    """A plain stand-in for schemas.IdleAlternativesRequest."""
    defaults = dict(
        current_port="Paradip",
        vessel_type="Panamax",
        commodity="Coal",
        cargo_weight_tons=1000.0,
    )
    defaults.update(overrides)
    return type("Req", (), defaults)()


class TestIdleAlternatives(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = get_bundle()

    def test_returns_ranked_alternative_loading_ports(self):
        """Given a vessel idle at a known port, idle_alternatives should
        return a non-empty, ranked list of alternative loading ports."""
        result = self.bundle.idle_alternatives(make_request())
        self.assertTrue(result["alternatives"], "expected at least one alternative")
        ranks = [a["rank"] for a in result["alternatives"]]
        self.assertEqual(ranks, list(range(1, len(ranks) + 1)))
        # ranked by descending score (earnings potential discounted by
        # ballast/idle time) — rank 1 should have the highest score.
        scores = [a["score"] for a in result["alternatives"]]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_current_port_excluded_from_its_own_alternatives(self):
        """A vessel idle at a port should never see that same port listed
        as a 'repositioning' alternative to itself."""
        result = self.bundle.idle_alternatives(make_request(current_port="Paradip"))
        self.assertTrue(result["alternatives"])
        self.assertTrue(
            all(a["origin_port"] != "Paradip" for a in result["alternatives"])
        )

    def test_current_port_excluded_case_insensitively(self):
        """The exclusion check is case/whitespace-tolerant on the current
        port name, matching the comparison used in idle_alternatives()."""
        result = self.bundle.idle_alternatives(make_request(current_port=" paradip "))
        self.assertTrue(result["alternatives"])
        self.assertTrue(
            all(a["origin_port"].lower() != "paradip" for a in result["alternatives"])
        )

    def test_unspecified_vessel_type_still_returns_alternatives(self):
        """No vessel_type should not block the recommendation — a default
        cargo weight and every candidate commodity are used instead."""
        result = self.bundle.idle_alternatives(
            make_request(vessel_type=None, commodity=None, cargo_weight_tons=None)
        )
        self.assertTrue(result["alternatives"])

    def test_alternatives_limited_to_top_five(self):
        result = self.bundle.idle_alternatives(make_request(commodity=None))
        self.assertLessEqual(len(result["alternatives"]), 5)


    def test_idle_alternatives_does_not_use_full_predict_pipeline(self):
        """Idle alternatives must use the lightweight batched path.

        This prevents a future refactor from reintroducing the old N-
        candidates x full-predict behavior that caused Render timeouts.
        """
        original = self.bundle.predict

        def fail_if_called(_req):
            raise AssertionError("idle_alternatives must not call ModelBundle.predict()")

        self.bundle.predict = fail_if_called
        try:
            result = self.bundle.idle_alternatives(make_request(commodity=None))
            self.assertTrue(result["alternatives"])
        finally:
            self.bundle.predict = original

    def test_response_echoes_current_port_and_vessel_type(self):
        result = self.bundle.idle_alternatives(make_request(current_port="Paradip", vessel_type="Panamax"))
        self.assertEqual(result["current_port"], "Paradip")
        self.assertEqual(result["vessel_type"], "Panamax")


if __name__ == "__main__":
    unittest.main()
