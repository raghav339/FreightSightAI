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
        # A fixed 90,000t lift against a 100,000t program implies 2 voyages
        # regardless of vessel class, and only classes that can actually
        # carry 90,000t in one lift should appear as candidates.
        req=SimpleNamespace(origin_port="Newcastle",destination_port="Paradip",
            shipment_date=__import__("datetime").date(2026,9,4),current_spot_rate_usd_per_ton=10,
            cargo_weight_tons=90000,total_program_tons=100000,contract_duration_months=6)
        out=optimize(req,self.rm,port_utils)
        self.assertEqual(out["requested_cargo_weight_tons"], 90000)
        for alt in out["alternatives"]:
            self.assertEqual(alt["voyages"], 2)
            self.assertGreaterEqual(alt["effective_cargo_tons_per_voyage"], 90000)

    def test_cargo_weight_tons_exceeding_every_class_raises(self):
        req=SimpleNamespace(origin_port="Newcastle",destination_port="Paradip",
            shipment_date=__import__("datetime").date(2026,9,4),current_spot_rate_usd_per_ton=10,
            cargo_weight_tons=500000,total_program_tons=500000,contract_duration_months=6)
        with self.assertRaises(ValueError):
            optimize(req,self.rm,port_utils)

if __name__=="__main__":
    unittest.main()