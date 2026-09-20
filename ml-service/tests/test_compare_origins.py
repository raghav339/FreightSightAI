# ml-service/tests/test_compare_origins.py
#
# Real, executable tests of ModelBundle.compare_origins() — the logic
# behind POST /compare-origins — run directly against the project's
# checked-in production model artifacts (ml-service/models/), the same
# way test_predict_integration.py does. A duck-typed stand-in for
# schemas.CompareOriginsRequest is used so these tests don't require
# pydantic to be installed; compare_origins() only ever reads attributes
# off the request object.
#
# Run with:
#   cd ml-service && python -m unittest tests.test_compare_origins -v
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tests._shared_models import get_bundle  # noqa: E402


def make_request(**overrides):
    """A plain stand-in for schemas.CompareOriginsRequest."""
    defaults = dict(
        commodity="Coal",
        destination_port="Paradip",
        shipment_date=date(2026, 10, 1),
        cargo_weight_tons=75000.0,
        vessel_type=None,
        contract_duration_months=None,
        total_program_tons=None,
    )
    defaults.update(overrides)
    return type("Req", (), defaults)()


class TestCompareOrigins(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = get_bundle()

    def test_returns_all_known_origins(self):
        """Every origin in metadata.json['origins'] should show up in the
        comparison, either as a result or an explicit error — none should
        vanish without a trace."""
        result = self.bundle.compare_origins(make_request())
        known_origins = set(self.bundle.meta.get("origins", []))
        seen_origins = {r["origin_port"] for r in result["results"]} | {
            e["origin_port"] for e in result["errors"]
        }
        self.assertEqual(known_origins, seen_origins)

    def test_rows_expose_both_port_vessel_status(self):
        """`feasible` reflects full both-port vessel feasibility (see
        ModelBundle.compare_origins). Each row must also carry the
        underlying vessel_status/feasible_vessel_types from predict(), so
        callers can see *why* a row is feasible or not, not just the
        boolean — e.g. a destination that no vessel class can serve (such
        as Chennai) is not reported as feasible."""
        valid = {
            "RECOMMENDED_VESSEL", "REQUESTED_VESSEL_FEASIBLE",
            "REQUESTED_VESSEL_NOT_FEASIBLE_USING_RECOMMENDED", "NO_FEASIBLE_VESSEL",
        }
        result = self.bundle.compare_origins(make_request(commodity="Iron Ore", destination_port="Chennai"))
        self.assertTrue(result["results"])
        for r in result["results"]:
            self.assertIn(r["vessel_status"], valid)
            self.assertIsInstance(r["feasible_vessel_types"], list)
            if r["vessel_status"] == "NO_FEASIBLE_VESSEL":
                self.assertEqual(r["feasible_vessel_types"], [])

    def test_vessel_status_matches_predict_for_the_same_origin(self):
        from datetime import date
        req = make_request(commodity="Iron Ore", destination_port="Visakhapatnam")
        result = self.bundle.compare_origins(req)
        row = next(r for r in result["results"] if r["origin_port"] == "Hay Point")
        single = type("Req", (), dict(
            commodity="Iron Ore", origin_port="Hay Point", destination_port="Visakhapatnam",
            shipment_date=date(2026, 10, 1), cargo_weight_tons=75000.0, cargo_volume_cbm=None,
            shipment_mode="Bulk Carrier", vessel_type=None, distance_km=None, delay_days=0,
            contract_duration_months=None, total_program_tons=None))()
        pred = self.bundle.predict(single)
        self.assertEqual(row["vessel_status"], pred["vessel_status"])
        self.assertEqual(row["feasible_vessel_types"], pred["feasible_vessel_types"])

    def test_results_sorted_feasible_first_then_by_voyage_days(self):
        """results must be sorted feasible-first, then by ascending
        total_voyage_days within each feasibility group."""
        result = self.bundle.compare_origins(make_request())
        results = result["results"]
        self.assertTrue(results, "compare_origins returned no results at all")

        # feasible-first: once we see an infeasible (or unknown/None)
        # entry, every entry after it must also be non-feasible.
        seen_infeasible = False
        for r in results:
            if not r["feasible"]:
                seen_infeasible = True
            else:
                self.assertFalse(
                    seen_infeasible,
                    "a feasible=True result appeared after a non-feasible one",
                )

        # ascending total_voyage_days within each feasibility group
        def group_key(r):
            return 0 if r["feasible"] else 1

        for _, group in _consecutive_groups(results, group_key):
            days = [
                r["total_voyage_days"] if r["total_voyage_days"] is not None else float("inf")
                for r in group
            ]
            self.assertEqual(days, sorted(days))

    def test_origin_with_no_port_data_lands_in_errors_not_dropped(self):
        """An origin with no entry in port_infra.json must be surfaced in
        `errors`, not silently included as a degraded-but-normal-looking
        result, and not silently dropped from the response entirely."""
        fake_origin = "Nonexistent Loading Port XYZ"
        original_origins = list(self.bundle.meta.get("origins", []))
        self.bundle.meta["origins"] = original_origins + [fake_origin]
        try:
            result = self.bundle.compare_origins(make_request())
            result_origins = {r["origin_port"] for r in result["results"]}
            error_origins = {e["origin_port"] for e in result["errors"]}
            self.assertNotIn(fake_origin, result_origins)
            self.assertIn(fake_origin, error_origins)
        finally:
            self.bundle.meta["origins"] = original_origins

    def test_rates_vary_by_origin_now_that_the_model_has_an_origin_dimension(self):
        """Rates now genuinely differ by origin: compare_origins() calls
        route_freight per origin (see app/utils.py:ModelBundle.compare_origins
        docstring), and each origin's lane has its own trained model and its
        own forecast — unlike the old destination+commodity-only BDRY
        market-proxy signal this replaced, which had no origin dimension at
        all. This deliberately replaces the old
        test_rate_is_identical_across_origins_known_limitation, whose own
        docstring called for exactly this update once that happened."""
        result = self.bundle.compare_origins(make_request())
        self.assertTrue(result["results"], "expected at least one origin with route-freight coverage")
        rates = {r["origin_port"]: r["predicted_freight_rate_usd_per_ton"] for r in result["results"]}
        # Not every result needs a distinct rate (routes can coincidentally
        # match), but with several origins now individually modelled they
        # must not all collapse to one shared number the way the old
        # BDRY-only signal forced them to.
        if len(rates) > 1:
            self.assertGreater(len(set(rates.values())), 1, f"rates identical across all origins: {rates}")

    def test_every_result_carries_a_rank(self):
        result = self.bundle.compare_origins(make_request())
        ranks = [r["rank"] for r in result["results"]]
        self.assertEqual(ranks, list(range(1, len(ranks) + 1)))

    def test_ais_congestion_field_present_and_labeled(self):
        """TASK 7: every result carries a clearly-labeled `ais_congestion`
        field alongside the static `origin_port_congestion` rating, and the
        static rating is untouched regardless of whether AIS is live."""
        result = self.bundle.compare_origins(make_request())
        for r in result["results"]:
            self.assertIn("ais_congestion", r)
            self.assertIn("available", r["ais_congestion"])
            self.assertIn("origin_port_congestion_source", r)
            # Static rating must still be present/unchanged shape-wise.
            self.assertIn("origin_port_congestion", r)

    def test_ais_congestion_falls_back_gracefully_when_disabled(self):
        """When no live AIS collector is connected (the default in this
        test environment — no AISSTREAM_API_KEY), compare_origins must
        never error out; it should just report ais_congestion.available
        as False for every origin."""
        from app import utils as utils_module

        original_collector = utils_module.ais_collector
        utils_module.ais_collector = None
        try:
            result = self.bundle.compare_origins(make_request())
            self.assertTrue(result["results"], "compare_origins returned no results at all")
            for r in result["results"]:
                self.assertFalse(r["ais_congestion"]["available"])
                self.assertIsNone(r["ais_congestion"]["congestion_index"])
        finally:
            utils_module.ais_collector = original_collector

    def test_ais_congestion_survives_route_features_exception(self):
        """If the AIS collector is enabled but route_features() throws
        (feed error, unknown port, etc.), compare_origins must still
        return a full, unbroken result set — never a hard failure."""
        from app import utils as utils_module

        class ExplodingCollector:
            enabled = True

            def route_features(self, *args, **kwargs):
                raise RuntimeError("simulated AIS feed failure")

        original_collector = utils_module.ais_collector
        utils_module.ais_collector = ExplodingCollector()
        try:
            result = self.bundle.compare_origins(make_request())
            self.assertTrue(result["results"], "compare_origins returned no results at all")
            for r in result["results"]:
                self.assertFalse(r["ais_congestion"]["available"])
        finally:
            utils_module.ais_collector = original_collector


def _consecutive_groups(items, key):
    """Group consecutive items by key, like itertools.groupby, without the
    import — small helper local to this test module."""
    groups = []
    current_key = object()
    current_group = []
    for item in items:
        k = key(item)
        if k != current_key:
            if current_group:
                groups.append((current_key, current_group))
            current_key = k
            current_group = [item]
        else:
            current_group.append(item)
    if current_group:
        groups.append((current_key, current_group))
    return groups


if __name__ == "__main__":
    unittest.main()
