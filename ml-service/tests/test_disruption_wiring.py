"""Tests for ModelBundle.simulate_disruption (app/utils.py) — the wiring
between the Disruption Engine (app/disruption_engine.py) and the route
forecast / Port Substitution Engine. Run against the project's real port
master and lane models, in the style of test_port_substitution.py.
"""
import unittest
from datetime import date
from types import SimpleNamespace

from tests._shared_models import get_bundle


def make(**kw):
    base = dict(event_type=None, port=None, severity=50.0, duration_days=None,
                origin_port=None, destination_port=None, commodity=None, shipment_date=None,
                cargo_weight_tons=50000.0, stockpile_buffer_days=None, include_alternatives=True)
    base.update(kw)
    return SimpleNamespace(**base)


class TestPortRoleDetection(unittest.TestCase):
    """Regression: a loading port with infrastructure data on file (e.g.
    Newcastle) must not be misread as a discharge port just because it has a
    PORT_INFRA record."""

    @classmethod
    def setUpClass(cls):
        cls.bundle = get_bundle()

    def test_loading_port_is_origin_not_destination(self):
        port, role = self.bundle._port_role("Newcastle")
        self.assertEqual(role, "origin")

    def test_discharge_port_is_destination(self):
        port, role = self.bundle._port_role("Paradip")
        self.assertEqual(role, "destination")

    def test_alias_resolves_to_destination(self):
        port, role = self.bundle._port_role("Vizag")
        self.assertEqual((port, role), ("Visakhapatnam", "destination"))

    def test_unknown_port_has_no_role(self):
        port, role = self.bundle._port_role("Nowhereville")
        self.assertEqual(role, "unknown")


class TestSimulateDisruption(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = get_bundle()

    def test_destination_disruption_offers_wait_vs_alternative(self):
        r = self.bundle.simulate_disruption(make(event_type="cyclone", port="Paradip", severity=85))
        self.assertEqual(r["port_role"], "destination")
        self.assertIsNotNone(r["decision"])
        self.assertEqual(r["decision"]["wait"]["port"], "Paradip")
        self.assertIsNotNone(r["decision"]["alternative"])
        self.assertNotEqual(r["decision"]["alternative"]["port"], "Paradip")

    def test_origin_disruption_gets_no_bogus_alternatives(self):
        r = self.bundle.simulate_disruption(make(event_type="port_closure", port="Newcastle", severity=70))
        self.assertEqual(r["port_role"], "origin")
        self.assertIsNone(r["alternatives"])
        self.assertIsNone(r["decision"])
        self.assertTrue(any("loading port" in n for n in r["notes"]))

    def test_lane_defaults_missing_end_to_the_disrupted_port(self):
        # Only origin_port given; destination should default to the
        # disrupted (destination-role) port itself.
        r = self.bundle.simulate_disruption(make(
            event_type="cyclone", port="Paradip", severity=60,
            origin_port="Newcastle", commodity="Coal", shipment_date=date(2026, 10, 1)))
        self.assertIsNotNone(r["lane"])
        self.assertEqual(r["lane"]["destination_port"], "Paradip")
        self.assertEqual(r["lane"]["origin_port"], "Newcastle")

    def test_lane_rate_moves_with_freight_pressure(self):
        low = self.bundle.simulate_disruption(make(
            event_type="cyclone", port="Paradip", severity=10,
            origin_port="Newcastle", commodity="Coal", shipment_date=date(2026, 10, 1)))
        high = self.bundle.simulate_disruption(make(
            event_type="cyclone", port="Paradip", severity=95,
            origin_port="Newcastle", commodity="Coal", shipment_date=date(2026, 10, 1)))
        self.assertEqual(low["lane"]["baseline_rate_usd_per_ton"], high["lane"]["baseline_rate_usd_per_ton"])
        self.assertGreater(high["lane"]["adjusted_rate_usd_per_ton"], low["lane"]["adjusted_rate_usd_per_ton"])
        self.assertGreater(high["lane"]["freight_pressure_pct"], low["lane"]["freight_pressure_pct"])

    def test_no_lane_given_reports_a_clear_note(self):
        r = self.bundle.simulate_disruption(make(event_type="cyclone", port="Paradip", severity=50))
        self.assertIsNone(r["lane"])
        self.assertTrue(r["notes"])

    def test_stockpile_buffer_flows_through_to_propagation(self):
        r = self.bundle.simulate_disruption(make(
            event_type="port_closure", port="Paradip", severity=90, stockpile_buffer_days=1))
        keys = [s["key"] for s in r["disruption"]["propagation"]]
        self.assertIn("stockpile", keys)
        stockpile = next(s for s in r["disruption"]["propagation"] if s["key"] == "stockpile")
        self.assertTrue(stockpile["breached"])

    def test_include_alternatives_false_skips_substitution_call(self):
        r = self.bundle.simulate_disruption(make(
            event_type="cyclone", port="Paradip", severity=85, include_alternatives=False))
        self.assertIsNone(r["alternatives"])
        self.assertIsNone(r["decision"])

    def test_unknown_event_type_raises(self):
        with self.assertRaises(ValueError):
            self.bundle.simulate_disruption(make(event_type="typhoon", port="Paradip", severity=50))

    def test_unknown_port_raises(self):
        with self.assertRaises(ValueError):
            self.bundle.simulate_disruption(make(event_type="cyclone", port="Atlantis", severity=50))

    def test_source_is_always_simulated(self):
        r = self.bundle.simulate_disruption(make(event_type="cyclone", port="Paradip", severity=50))
        self.assertEqual(r["disruption"]["source"], "simulated")

    def test_severity_input_is_0_to_100_scale(self):
        # The request's `severity` is 0-100; the engine underneath uses 0-1.
        r = self.bundle.simulate_disruption(make(event_type="cyclone", port="Paradip", severity=50))
        self.assertEqual(r["disruption"]["severity"], 0.5)


if __name__ == "__main__":
    unittest.main()
