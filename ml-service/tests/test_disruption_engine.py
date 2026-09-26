"""Tests for app/disruption_engine.py.

These are pure-logic tests (no model loading, no pydantic) plus a small
end-to-end section against the project's real port master data, in the same
style as test_port_substitution.py.
"""
import unittest

from app import disruption_engine as de


# A synthetic "generous" port (many berths, fast handling, low congestion)
# and a synthetic "constrained" port (opposite), used to test sensitivity
# without depending on which real ports happen to be in the dataset today.
GENEROUS_PORT = {"berths": 12, "cargo_handling_rate_tpd": 25000, "typical_congestion": "low"}
CONSTRAINED_PORT = {"berths": 1, "cargo_handling_rate_tpd": 5000, "typical_congestion": "high"}


class TestNoHardcoding(unittest.TestCase):
    """The core design requirement: nothing here is a per-scenario lookup."""

    def test_no_scenario_name_constants_exist(self):
        # EVENT_PROFILES must be keyed by event TYPE ("cyclone"), never by a
        # specific named scenario ("Mozambique Cyclone", "Cyclone Freddy") —
        # that would mean the impact numbers are looked up per-incident
        # instead of computed from severity + port data.
        for key in de.EVENT_PROFILES:
            self.assertNotIn(" ", key)  # type keys are single tokens like "cyclone"
            self.assertNotRegex(key, r"[A-Z]")  # no proper-noun-style scenario names
        self.assertNotIn("mozambique", " ".join(de.EVENT_PROFILES).lower())

    def test_two_severities_of_same_event_give_different_numbers(self):
        low = de.compute_impact("cyclone", 0.2, GENEROUS_PORT)
        high = de.compute_impact("cyclone", 0.9, GENEROUS_PORT)
        self.assertNotEqual(low["loading_delay_days"], high["loading_delay_days"])
        self.assertNotEqual(low["freight_pressure_pct"], high["freight_pressure_pct"])

    def test_severity_is_continuous_not_bucketed(self):
        # Small severity steps should produce small (not identical, not huge)
        # jumps -- i.e. this is a formula, not a lookup table with a few rungs.
        deltas = []
        prev = None
        for sev in (0.10, 0.11, 0.12, 0.13, 0.14):
            impact = de.compute_impact("cyclone", sev, GENEROUS_PORT)
            if prev is not None:
                deltas.append(impact["loading_delay_days"] - prev)
            prev = impact["loading_delay_days"]
        self.assertTrue(all(d > 0 for d in deltas), deltas)
        self.assertTrue(all(d < 1.0 for d in deltas), deltas)  # no giant bucket jump

    def test_same_event_different_ports_give_different_numbers(self):
        a = de.compute_impact("cyclone", 0.7, GENEROUS_PORT)
        b = de.compute_impact("cyclone", 0.7, CONSTRAINED_PORT)
        self.assertNotEqual(a["loading_delay_days"], b["loading_delay_days"])
        self.assertGreater(b["loading_delay_days"], a["loading_delay_days"])


class TestMonotonicity(unittest.TestCase):
    def test_higher_severity_never_decreases_any_channel(self):
        prev = None
        for sev in (0.0, 0.2, 0.4, 0.6, 0.8, 1.0):
            impact = de.compute_impact("port_closure", sev, CONSTRAINED_PORT)
            if prev is not None:
                self.assertGreaterEqual(impact["loading_delay_days"], prev["loading_delay_days"])
                self.assertGreaterEqual(impact["vessel_waiting_days"], prev["vessel_waiting_days"])
                self.assertGreaterEqual(impact["freight_pressure_pct"], prev["freight_pressure_pct"])
                self.assertGreaterEqual(impact["productivity_loss_pct"], prev["productivity_loss_pct"])
            prev = impact

    def test_zero_severity_is_zero_impact(self):
        impact = de.compute_impact("cyclone", 0.0, GENEROUS_PORT)
        self.assertEqual(impact["loading_delay_days"], 0.0)
        self.assertEqual(impact["vessel_waiting_days"], 0.0)
        self.assertEqual(impact["freight_pressure_pct"], 0.0)
        self.assertEqual(impact["productivity_loss_pct"], 0.0)

    def test_more_resilient_port_never_worse_off_than_less_resilient(self):
        for event in de.EVENT_PROFILES:
            a = de.compute_impact(event, 0.6, GENEROUS_PORT)
            b = de.compute_impact(event, 0.6, CONSTRAINED_PORT)
            self.assertLessEqual(a["loading_delay_days"], b["loading_delay_days"], event)
            self.assertLessEqual(a["vessel_waiting_days"], b["vessel_waiting_days"], event)

    def test_severity_and_values_are_clamped_to_valid_range(self):
        impact = de.compute_impact("cyclone", 5.0, GENEROUS_PORT)  # way over 1.0
        self.assertEqual(impact["severity"], 1.0)
        impact = de.compute_impact("cyclone", -3.0, GENEROUS_PORT)
        self.assertEqual(impact["severity"], 0.0)


class TestBoundsAndCaps(unittest.TestCase):
    def test_outputs_never_exceed_documented_caps(self):
        for event in de.EVENT_PROFILES:
            impact = de.compute_impact(event, 1.0, CONSTRAINED_PORT, duration_days=60)
            self.assertLessEqual(impact["productivity_loss_pct"], de.MAX_PRODUCTIVITY_LOSS)
            self.assertLessEqual(impact["loading_delay_days"], de.MAX_DELAY_DAYS)
            self.assertLessEqual(impact["vessel_waiting_days"], de.MAX_WAITING_DAYS)
            self.assertLessEqual(impact["freight_pressure_pct"], de.MAX_FREIGHT_PRESSURE_PCT)

    def test_unknown_event_type_raises(self):
        with self.assertRaises(ValueError):
            de.compute_impact("meteor_strike", 0.5, GENEROUS_PORT)

    def test_missing_port_data_falls_back_to_neutral_not_crash(self):
        impact = de.compute_impact("cyclone", 0.5, None)
        self.assertFalse(impact["exposure"]["has_port_data"])
        self.assertEqual(impact["exposure"]["coverage"], 0.0)
        self.assertGreater(impact["loading_delay_days"], 0.0)

    def test_partial_port_data_reports_partial_coverage(self):
        impact = de.compute_impact("cyclone", 0.5, {"berths": 4})
        self.assertAlmostEqual(impact["exposure"]["coverage"], round(1 / 3, 2))


class TestEventProfiles(unittest.TestCase):
    def test_freight_spike_barely_touches_productivity(self):
        impact = de.compute_impact("freight_spike", 0.9, CONSTRAINED_PORT)
        self.assertEqual(impact["productivity_loss_pct"], 0.0)
        self.assertGreater(impact["freight_pressure_pct"], 0.0)

    def test_vessel_shortage_hits_freight_and_waiting_not_productivity(self):
        impact = de.compute_impact("vessel_shortage", 0.9, CONSTRAINED_PORT)
        self.assertLess(impact["productivity_loss_pct"], 0.1)
        self.assertGreater(impact["freight_pressure_pct"], 0.0)
        self.assertGreater(impact["vessel_waiting_days"], 0.0)

    def test_list_event_types_covers_all_profiles(self):
        types = {e["event_type"] for e in de.list_event_types()}
        self.assertEqual(types, set(de.EVENT_PROFILES))


class TestDuration(unittest.TestCase):
    def test_longer_duration_increases_freight_and_waiting_only(self):
        short = de.compute_impact("cyclone", 0.6, GENEROUS_PORT, duration_days=1)
        long = de.compute_impact("cyclone", 0.6, GENEROUS_PORT, duration_days=10)
        self.assertGreater(long["freight_pressure_pct"], short["freight_pressure_pct"])
        self.assertGreater(long["vessel_waiting_days"], short["vessel_waiting_days"])
        self.assertEqual(long["loading_delay_days"], short["loading_delay_days"])
        self.assertEqual(long["productivity_loss_pct"], short["productivity_loss_pct"])

    def test_duration_compounding_is_capped(self):
        a = de.compute_impact("cyclone", 0.6, GENEROUS_PORT, duration_days=100)
        b = de.compute_impact("cyclone", 0.6, GENEROUS_PORT, duration_days=1000)
        self.assertEqual(a["freight_pressure_pct"], b["freight_pressure_pct"])


class TestPropagationAndAssess(unittest.TestCase):
    def test_propagation_has_ordered_steps_ending_in_procurement(self):
        impact = de.compute_impact("cyclone", 0.5, GENEROUS_PORT)
        steps = de.build_propagation(impact, "TestPort")
        keys = [s["key"] for s in steps]
        self.assertEqual(keys[0], "event")
        self.assertEqual(keys[-1], "procurement")
        self.assertIn("delay", keys)
        self.assertIn("freight", keys)

    def test_stockpile_buffer_breach_detection(self):
        impact = de.compute_impact("port_closure", 0.9, CONSTRAINED_PORT)
        steps = de.build_propagation(impact, "TestPort", stockpile_buffer_days=0.5)
        stockpile = next(s for s in steps if s["key"] == "stockpile")
        self.assertTrue(stockpile["breached"])

        steps2 = de.build_propagation(impact, "TestPort", stockpile_buffer_days=1000)
        stockpile2 = next(s for s in steps2 if s["key"] == "stockpile")
        self.assertFalse(stockpile2["breached"])

    def test_no_buffer_given_procurement_step_is_advisory(self):
        impact = de.compute_impact("cyclone", 0.5, GENEROUS_PORT)
        steps = de.build_propagation(impact, "TestPort")
        self.assertNotIn("stockpile", [s["key"] for s in steps])

    def test_assess_disruption_echoes_source_and_includes_assumptions(self):
        r = de.assess_disruption("cyclone", "Paradip", 0.5, GENEROUS_PORT, source="live")
        self.assertEqual(r["source"], "live")
        self.assertEqual(r["port"], "Paradip")
        self.assertTrue(r["assumptions"])
        self.assertTrue(r["propagation"])

    def test_assess_disruption_rejects_bad_source(self):
        with self.assertRaises(ValueError):
            de.assess_disruption("cyclone", "Paradip", 0.5, GENEROUS_PORT, source="fake")


class TestEndToEndOnRealPortData(unittest.TestCase):
    """Sanity check against the project's actual port master (port_utils)."""

    @classmethod
    def setUpClass(cls):
        from app import port_utils as pu
        cls.pu = pu

    def test_real_ports_produce_sane_bounded_output(self):
        for name in ("Paradip", "Newcastle", "Dhamra", "Gangavaram"):
            info = self.pu.get_port(name)
            self.assertIsNotNone(info, name)
            for event in de.EVENT_PROFILES:
                impact = de.compute_impact(event, 0.7, info)
                self.assertGreaterEqual(impact["loading_delay_days"], 0.0)
                self.assertLessEqual(impact["loading_delay_days"], de.MAX_DELAY_DAYS)

    def test_full_assess_disruption_on_real_port(self):
        info = self.pu.get_port("Paradip")
        r = de.assess_disruption("cyclone", "Paradip", 0.85, info, duration_days=5, stockpile_buffer_days=6)
        self.assertEqual(r["port"], "Paradip")
        self.assertTrue(any(s["key"] == "stockpile" for s in r["propagation"]))


if __name__ == "__main__":
    unittest.main()
