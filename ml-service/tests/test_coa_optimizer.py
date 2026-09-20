import sys, unittest
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from tests._shared_models import get_route_model
from app.coa_optimizer import optimize
from app import port_utils

class COAOptimizerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rm=get_route_model()
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
        # A fixed 70,000t lift against a 100,000t program implies 2 voyages
        # regardless of vessel class, and only classes that can actually
        # carry 70,000t in one lift should appear as candidates. (70,000t,
        # not 90,000t: at Newcastle's documented usable depth (16.2m),
        # Capesize's 18.0m typical draft is correctly rejected, and no
        # smaller class reaches 90,000t capacity in a single lift — that's
        # the vessel-feasibility guardrail doing its job, not a bug. Panamax
        # (73,800t effective capacity) does reach 70,000t.)
        req=SimpleNamespace(origin_port="Newcastle",destination_port="Paradip",
            shipment_date=__import__("datetime").date(2026,9,4),current_spot_rate_usd_per_ton=10,
            cargo_weight_tons=70000,total_program_tons=100000,contract_duration_months=6)
        out=optimize(req,self.rm,port_utils)
        self.assertEqual(out["requested_cargo_weight_tons"], 70000)
        self.assertTrue(out["alternatives"])
        for alt in out["alternatives"]:
            self.assertEqual(alt["voyages"], 2)
            self.assertGreaterEqual(alt["effective_cargo_tons_per_voyage"], 70000)

    def test_draft_infeasible_and_capacity_infeasible_combination_raises(self):
        # 90,000t in one lift exceeds every vessel class's capacity
        # (Handysize/Supramax/Panamax) or is draft-infeasible at the origin
        # port (Capesize at Newcastle) — optimize() must refuse outright
        # rather than silently returning an infeasible/empty plan.
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

    def test_commodity_selects_the_matching_commodity_model(self):
        # Most lanes carry Coal, Iron Ore and Bulk Minerals & Ores. The optimizer
        # used to call route_model.predict() without a commodity, so every
        # request was priced as whichever commodity's model happened to come
        # first (Coal). Each commodity must now be priced from its own model.
        def coa_for(commodity):
            req=SimpleNamespace(commodity=commodity,origin_port="Newcastle",destination_port="Visakhapatnam",
                shipment_date=__import__("datetime").date(2026,10,1),current_spot_rate_usd_per_ton=None,
                cargo_weight_tons=60000,total_program_tons=240000,contract_duration_months=6)
            return optimize(req,self.rm,port_utils)
        norm=lambda c: c.strip().lower().replace(" ","_").replace("&","and")
        rates={}
        for commodity in ("Coal","Iron Ore","Bulk Minerals & Ores"):
            out=coa_for(commodity)
            self.assertEqual(norm(out["market_forecast"]["commodity"]), norm(commodity))
            rates[commodity]=out["best_strategy"]["contract_rate_usd_per_ton"]
        self.assertGreater(len(set(rates.values())), 1, f"all commodities priced identically: {rates}")

if __name__=="__main__":
    unittest.main()