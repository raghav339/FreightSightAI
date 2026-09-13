import sys, unittest
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from app.route_model import RouteModel
from app.coa_optimizer import optimize
from app import port_utils

class COAOptimizerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rm=RouteModel(ROOT/"models")
    def test_optimizer_returns_feasible_strategy(self):
        req=SimpleNamespace(origin_port="Newcastle",destination_port="Paradip",
            shipment_date=__import__("datetime").date(2026,9,4),current_spot_rate_usd_per_ton=10,
            cargo_weight_tons=50000,total_program_tons=300000,contract_duration_months=6)
        out=optimize(req,self.rm,port_utils)
        self.assertTrue(out["alternatives"])
        self.assertIn(out["best_strategy"]["vessel_type"],["Handysize","Supramax","Panamax","Capesize"])
        self.assertIsNotNone(out["best_strategy"]["expected_freight_cost_usd"])

    def test_cargo_weight_tons_optional_auto_sizes_parcel(self):
        # No cargo_weight_tons supplied — the optimizer should pick its own
        # voyage count/parcel per vessel class from total_program_tons alone,
        # exactly like before this field became optional.
        req=SimpleNamespace(origin_port="Newcastle",destination_port="Paradip",
            shipment_date=__import__("datetime").date(2026,9,4),current_spot_rate_usd_per_ton=10,
            cargo_weight_tons=None,total_program_tons=300000,contract_duration_months=6)
        out=optimize(req,self.rm,port_utils)
        self.assertIsNone(out["requested_cargo_weight_tons"])
        self.assertTrue(out["alternatives"])
        for alt in out["alternatives"]:
            # Auto-sized parcel must not exceed the class's own capacity.
            self.assertLessEqual(alt["average_parcel_tons"], alt["effective_cargo_tons_per_voyage"] + 1e-6)

    def test_cargo_weight_tons_supplied_drives_voyage_count(self):
        # A fixed 70,000t lift against a 140,000t program implies 2 voyages
        # regardless of vessel class, and only classes that can actually
        # carry 70,000t in one lift AND physically fit both ports should
        # appear as candidates. (70,000t/Panamax, not 90,000t/Capesize —
        # see test_single_lift_exceeding_every_physically_fitting_class_raises
        # for why a 90,000t fixed lift on this lane is genuinely infeasible,
        # not an optimizer bug.)
        req=SimpleNamespace(origin_port="Newcastle",destination_port="Paradip",
            shipment_date=__import__("datetime").date(2026,9,4),current_spot_rate_usd_per_ton=10,
            cargo_weight_tons=70000,total_program_tons=140000,contract_duration_months=6)
        out=optimize(req,self.rm,port_utils)
        self.assertEqual(out["requested_cargo_weight_tons"], 70000)
        for alt in out["alternatives"]:
            self.assertEqual(alt["voyages"], 2)
            self.assertGreaterEqual(alt["effective_cargo_tons_per_voyage"], 70000)

    def test_single_lift_exceeding_every_physically_fitting_class_raises(self):
        # Business rule: vessel draft/LOA/beam are physical constraints on
        # a single voyage, not a function of how many voyages the program
        # is split into — a vessel that cannot fit through the channel
        # cannot make even one voyage, no matter how many lifts the COA
        # allows. On this lane, Newcastle's usable depth (16.2m) is less
        # than a Capesize's draft (18.0m), and every smaller class's
        # per-voyage capacity is below 90,000t (Panamax tops out at
        # 73,800t effective). So a fixed 90,000t single lift has no
        # feasible vessel class here — this must raise, exactly like the
        # over-capacity case below, rather than silently offering a
        # Capesize that could never actually berth.
        req=SimpleNamespace(origin_port="Newcastle",destination_port="Paradip",
            shipment_date=__import__("datetime").date(2026,9,4),current_spot_rate_usd_per_ton=10,
            cargo_weight_tons=90000,total_program_tons=100000,contract_duration_months=6)
        with self.assertRaises(ValueError):
            optimize(req,self.rm,port_utils)

    def test_cargo_weight_tons_exceeding_every_class_raises(self):
        req=SimpleNamespace(origin_port="Newcastle",destination_port="Paradip",
            shipment_date=__import__("datetime").date(2026,9,4),current_spot_rate_usd_per_ton=10,
            cargo_weight_tons=500000,total_program_tons=500000,contract_duration_months=6)
        with self.assertRaises(ValueError):
            optimize(req,self.rm,port_utils)

    def test_total_cost_reflects_voyages_not_just_flat_rate(self):
        """Regression test: total COA cost used to be `rate * total_program_tons`
        for every vessel class — identical across all of them regardless of
        voyage count, since neither `rate` nor `total` varied by vessel. Now
        port/operating/delay costs scale with voyages, so vessel choice
        actually matters economically."""
        req=SimpleNamespace(origin_port="Newcastle",destination_port="Paradip",
            shipment_date=__import__("datetime").date(2026,9,4),current_spot_rate_usd_per_ton=10,
            cargo_weight_tons=None,total_program_tons=300000,contract_duration_months=6)
        out=optimize(req,self.rm,port_utils)
        self.assertGreaterEqual(len(out["alternatives"]), 2)

        costs = {a["vessel_type"]: a["expected_freight_cost_usd"] for a in out["alternatives"]}
        # Pre-fix, every value in `costs` was identical.
        self.assertGreater(len(set(costs.values())), 1)

        for alt in out["alternatives"]:
            bd = alt["cost_breakdown_usd"]
            self.assertIsNotNone(bd)
            # The breakdown must actually sum to the reported total.
            self.assertAlmostEqual(
                bd["freight_cost"] + bd["port_cost"] + bd["voyage_operating_cost"]
                + bd["delay_congestion_cost"] + bd["risk_premium"],
                bd["total"],
                places=2,
            )
            self.assertEqual(alt["expected_freight_cost_usd"], bd["total"])
            # Freight cost alone (market rate x total tons) IS the same
            # across classes by design — it's everything else that should
            # differ with voyage count.
            self.assertEqual(bd["freight_cost"], next(iter(out["alternatives"]))["cost_breakdown_usd"]["freight_cost"])

        # More voyages should mean more port calls -> higher port cost.
        by_voyages = sorted(out["alternatives"], key=lambda a: a["voyages"])
        self.assertLessEqual(
            by_voyages[0]["cost_breakdown_usd"]["port_cost"],
            by_voyages[-1]["cost_breakdown_usd"]["port_cost"],
        )

if __name__=="__main__":
    unittest.main()