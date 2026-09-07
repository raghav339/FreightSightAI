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
if __name__=="__main__":
    unittest.main()
