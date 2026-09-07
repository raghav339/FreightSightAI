# ml-service/tests/test_port_utils.py
#
# Real, executable unit tests for the Phase 6 both-port vessel feasibility
# engine (app/port_utils.py). Uses Python's built-in `unittest` rather than
# pytest, since this environment has pandas/numpy/scikit-learn/joblib
# available but not pytest — these tests do not require any package
# install and can be run with:
#
#   cd ml-service && python -m unittest tests.test_port_utils -v
#
# These exercise check_vessel_port_compatibility() and
# feasible_vessels_both_ports() directly against synthetic port/vessel
# specs (not the real World Port Index data), so the test is deterministic
# and does not depend on what happens to be in port_infra.json today.
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import port_utils  # noqa: E402


class TestCheckVesselPortCompatibility(unittest.TestCase):
    def test_no_infra_data_is_a_controlled_failure_not_a_pass(self):
        """A port with no infrastructure record on file must never be
        silently treated as 'anything fits' — Phase 6/7 require an
        explicit, honest reason rather than a bare pass."""
        ok, reason = port_utils.check_vessel_port_compatibility(
            "Handysize", None, label="origin port"
        )
        self.assertFalse(ok)
        self.assertIn("No infrastructure data", reason)

    def test_unrecognized_vessel_class_fails_explicitly(self):
        ok, reason = port_utils.check_vessel_port_compatibility(
            "Ultramax", {"max_loa_m": 300}, label="origin port"
        )
        self.assertFalse(ok)
        self.assertIn("Unrecognized vessel class", reason)

    def test_draft_limitation_is_correctly_labelled_by_side(self):
        """A shallow port should reject a deep-draft vessel class, and the
        rejection reason must name the side (origin vs destination) that
        actually failed — this is what Phase 6's rejection_reason field
        depends on being accurate."""
        shallow_port = {"max_loa_m": 400, "max_beam_m": 60, "cargo_depth_m": 5.0}
        ok, reason = port_utils.check_vessel_port_compatibility(
            "Capesize", shallow_port, label="destination port"
        )
        self.assertFalse(ok)
        self.assertIn("Destination port draft limitation", reason)

    def test_loa_limitation_is_checked_before_a_deeper_but_narrow_channel(self):
        short_berth_port = {"max_loa_m": 150, "max_beam_m": 60, "cargo_depth_m": 20.0}
        ok, reason = port_utils.check_vessel_port_compatibility(
            "Capesize", short_berth_port, label="origin port"
        )
        self.assertFalse(ok)
        self.assertIn("Origin port LOA limitation", reason)

    def test_vessel_that_fits_every_dimension_passes(self):
        generous_port = {"max_loa_m": 350, "max_beam_m": 55, "cargo_depth_m": 20.0}
        ok, reason = port_utils.check_vessel_port_compatibility(
            "Handysize", generous_port, label="origin port"
        )
        self.assertTrue(ok)
        self.assertIsNone(reason)

    def test_missing_individual_dimension_is_not_treated_as_a_failure(self):
        """A port record that has LOA/beam data but no depth data on file
        should not fail the draft check outright — Phase 6 says unknown
        constraints are simply not checked on that dimension, not treated
        as an automatic rejection."""
        no_depth_port = {"max_loa_m": 350, "max_beam_m": 55}
        ok, reason = port_utils.check_vessel_port_compatibility(
            "Handysize", no_depth_port, label="origin port"
        )
        self.assertTrue(ok)


class TestFeasibleVesselsBothPorts(unittest.TestCase):
    """A vessel must be feasible at BOTH origin and destination, and cargo
    capacity is checked independently of port constraints — this is the
    core Phase 6 requirement (cargo_compatible AND origin_ok AND dest_ok)."""

    def setUp(self):
        self.generous_port = {"max_loa_m": 350, "max_beam_m": 55, "cargo_depth_m": 20.0}
        self.shallow_port = {"max_loa_m": 350, "max_beam_m": 55, "cargo_depth_m": 10.0}

    def test_both_ports_generous_all_capable_classes_feasible(self):
        feasible, rejected = port_utils.feasible_vessels_both_ports(
            5000, self.generous_port, self.generous_port
        )
        feasible_classes = {v["vessel_class"] for v in feasible}
        self.assertIn("Handysize", feasible_classes)
        self.assertIn("Capesize", feasible_classes)
        self.assertEqual(len(rejected), 0)

    def test_origin_shallow_rejects_deep_draft_classes_with_origin_reason(self):
        # 12.0 m sits between Handysize's fixed draft limit (11.0 m) and
        # Supramax/Panamax/Capesize's (12.5/14.5/18.0 m), so this isolates
        # exactly the classes that should fail on draft.
        shallow_port = {"max_loa_m": 350, "max_beam_m": 55, "cargo_depth_m": 12.0}
        feasible, rejected = port_utils.feasible_vessels_both_ports(
            5000, shallow_port, self.generous_port
        )
        rejected_by_class = {r["vessel_class"]: r["rejection_reason"] for r in rejected}
        self.assertIn("Capesize", rejected_by_class)
        self.assertIn("Origin port draft limitation", rejected_by_class["Capesize"])
        # Handysize (shallower draft) should still be feasible at both ends.
        feasible_classes = {v["vessel_class"] for v in feasible}
        self.assertIn("Handysize", feasible_classes)

    def test_destination_shallow_rejects_with_destination_reason_not_origin(self):
        """Regression guard for exactly the Phase 6 bug class: destination-
        only constraints must never be reported as an origin failure."""
        feasible, rejected = port_utils.feasible_vessels_both_ports(
            5000, self.generous_port, self.shallow_port
        )
        rejected_by_class = {r["vessel_class"]: r["rejection_reason"] for r in rejected}
        self.assertIn("Destination port draft limitation", rejected_by_class["Capesize"])
        self.assertNotIn("Origin port", rejected_by_class["Capesize"])

    def test_cargo_exceeding_every_class_rejects_all_on_capacity(self):
        feasible, rejected = port_utils.feasible_vessels_both_ports(
            10_000_000, self.generous_port, self.generous_port
        )
        self.assertEqual(len(feasible), 0)
        self.assertTrue(all("Cargo exceeds recommended capacity" in r["rejection_reason"] for r in rejected))


    def test_turnaround_does_not_round_small_positive_to_zero(self):
        days = port_utils.port_turnaround_days("Paradip", 1000)
        self.assertGreater(days, 0.0)

    def test_1000_tonne_cargo_never_raises_and_returns_a_useful_result(self):
        """Phase 24's specific edge case: a small cargo size must not
        break the feasibility engine — it should simply return whichever
        vessel classes are (over-)capable, not throw or return nothing
        useful."""
        feasible, rejected = port_utils.feasible_vessels_both_ports(
            1000, self.generous_port, self.generous_port
        )
        self.assertGreater(len(feasible) + len(rejected), 0)
        self.assertGreaterEqual(len(feasible), 1)


if __name__ == "__main__":
    unittest.main()
