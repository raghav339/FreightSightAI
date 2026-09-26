"""Port Substitution Engine: pure-logic rules plus an end-to-end run on the real port master."""
import unittest
from datetime import date
from types import SimpleNamespace

from app import port_substitution as ps


def opt(port, feasible=True, delta=None, transit=None, handling=0.0, cong=0.0, dist=100.0, disch=2.0, margin=0.2, reason=None):
    return {
        "port": port, "feasible": feasible, "lat": None, "lon": None,
        "vessel": {"class": "Supramax" if feasible else None, "margin_ratio": margin, "rejection_reason": reason,
                   "planned_vessel": "Supramax", "keeps_planned_vessel": feasible},
        "freight": {"delta_usd_per_ton": delta},
        "congestion": {"delay_days": cong},
        "delay": {"extra_transit_days": transit, "extra_handling_days": handling},
        "handling": {"discharge_days": disch},
        "distance": {"from_failed_nm": dist},
    }


class TestScoring(unittest.TestCase):
    def test_hard_vessel_gate_never_ranks_infeasible_port(self):
        out = ps.rank_options([
            opt("A", feasible=False, dist=1.0, reason="draft"),
            opt("B", dist=500.0),
        ])
        self.assertEqual(out[0]["port"], "B")
        self.assertEqual(out[0]["verdict"], "PRIMARY")
        bad = next(o for o in out if o["port"] == "A")
        self.assertEqual(bad["verdict"], "NOT_VIABLE")
        self.assertIsNone(bad["rank"])
        self.assertIn("draft", bad["why"][0])

    def test_cheaper_closer_faster_port_wins(self):
        good = opt("Good", delta=-2.0, transit=-0.5, dist=30.0, disch=1.0, cong=0.0)
        bad = opt("Bad", delta=3.0, transit=2.0, dist=400.0, disch=4.0, cong=1.5)
        out = ps.rank_options([bad, good])
        self.assertEqual([o["port"] for o in out], ["Good", "Bad"])
        self.assertGreater(out[0]["score"], out[1]["score"])

    def test_missing_data_is_neutral_and_reported(self):
        a = opt("A", delta=None, transit=None, handling=None)
        b = opt("B", delta=None, transit=None, handling=None)
        out = ps.rank_options([a, b])
        for o in out:
            self.assertIn("freight", o["data_gap_keys"])
            self.assertLess(o["coverage"], 1.0)
            self.assertEqual(o["score_breakdown"]["freight"], ps.NEUTRAL)

    def test_verdicts_primary_backup_viable(self):
        opts = [opt(f"P{i}", dist=100.0 * (i + 1)) for i in range(5)]
        out = ps.rank_options(opts)
        self.assertEqual([o["verdict"] for o in out], ["PRIMARY", "BACKUP", "BACKUP", "VIABLE", "VIABLE"])

    def test_no_viable_option_recommendation_says_so(self):
        out = ps.rank_options([opt("A", feasible=False, reason="x")])
        self.assertIn("none of the other ports", ps.build_recommendation("Paradip", out))

    def test_map_has_edge_per_candidate(self):
        out = ps.rank_options([opt("A"), opt("B", feasible=False, reason="x")])
        m = ps.build_map({"port": "Paradip", "lat": 1, "lon": 2}, out)
        self.assertEqual(m["nodes"][0]["role"], "failed")
        self.assertEqual(len(m["edges"]), 2)
        self.assertEqual({e["role"] for e in m["edges"]}, {"primary", "not_viable"})


class TestHelpers(unittest.TestCase):
    def test_haversine_paradip_dhamra_is_short(self):
        d = ps.haversine_nm((20.266667, 86.683333), (20.782, 86.914))
        self.assertTrue(30 < d < 40)

    def test_congestion_prefers_live_radar(self):
        c = ps.congestion_assumption({"status": "ELEVATED", "impact": {"planning_assumption_days": 1.0}}, "low")
        self.assertEqual((c["source"], c["delay_days"]), ("live_ais_radar", 1.0))
        c = ps.congestion_assumption({"status": "INSUFFICIENT_DATA"}, "high")
        self.assertEqual((c["source"], c["delay_days"]), ("static_rating", 1.5))
        self.assertEqual(ps.congestion_assumption(None, None)["source"], "assumed")

    def test_vessel_margin(self):
        ratio, dm, lm = ps.vessel_margin_ratio(
            {"typical_draft": 10.0, "typical_length": 190.0}, {"max_draft_m": 15.0, "max_loa_m": 230.0})
        self.assertEqual((dm, lm), (5.0, 40.0))
        self.assertAlmostEqual(ratio, round(min(5 / 15, 40 / 230), 3))


class TestEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from tests._shared_models import get_bundle
        cls.bundle = get_bundle()

        def make(**kw):
            # Plain stand-in for schemas.PortSubstitutionRequest (no pydantic needed).
            base = dict(failed_port=None, cargo_weight_tons=50000.0, commodity=None, origin_port=None,
                        shipment_date=None, vessel_type=None, max_distance_nm=800.0, use_live_ais=True)
            base.update(kw)
            return SimpleNamespace(**base)
        cls.Req = staticmethod(make)

    def test_paradip_failure_returns_ranked_alternatives(self):
        r = self.bundle.port_substitution(self.Req(failed_port="Paradip", use_live_ais=False))
        ports = [o["port"] for o in r["options"]]
        self.assertNotIn("Paradip", ports)
        self.assertEqual(r["options"][0]["verdict"], "PRIMARY")
        self.assertTrue(r["map"]["edges"])

    def test_alias_and_hyphen_names_resolve(self):
        r = self.bundle.port_substitution(self.Req(failed_port="Vizag", use_live_ais=False))
        self.assertEqual(r["failed_port"], "Visakhapatnam")
        r = self.bundle.port_substitution(self.Req(failed_port="Sagar-Sandheads", use_live_ais=False))
        self.assertEqual(r["failed_port"], "Sagar Sandheads")

    def test_haldia_rejected_for_large_parcel_with_reason(self):
        r = self.bundle.port_substitution(self.Req(failed_port="Paradip", cargo_weight_tons=100000, use_live_ais=False))
        haldia = next((o for o in r["options"] if o["port"] == "Haldia"), None)
        self.assertIsNotNone(haldia)
        self.assertFalse(haldia["feasible"])
        self.assertTrue(haldia["vessel"]["rejection_reason"])

    def test_loading_port_block_is_not_blamed_on_candidates(self):
        r = self.bundle.port_substitution(self.Req(
            failed_port="Visakhapatnam", origin_port="Beira", commodity="Iron Ore",
            cargo_weight_tons=16000, shipment_date=date(2026, 10, 1), use_live_ais=False))
        self.assertTrue(all(not o["feasible"] for o in r["options"]))
        self.assertIn("loading port", r["recommendation"])

    def test_unknown_port_raises(self):
        with self.assertRaises(ValueError):
            self.bundle.port_substitution(self.Req(failed_port="Atlantis"))


if __name__ == "__main__":
    unittest.main()
