import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from route_freight_model import (  # noqa: E402
    LANES_DIRNAME, RouteFreightModel, export_lane_files, train,
)
import test_route_freight_model as _rfm  # noqa: E402


class LazyModelTests(unittest.TestCase):
    def _trained(self, td):
        d = Path(td)
        _rfm.RouteFreightModelTests()._write_rows(d)
        out = d / "models"
        train(out, d)
        return d, out

    def test_export_matches_monolithic_predictions(self):
        with tempfile.TemporaryDirectory() as td:
            d, out = self._trained(td)
            eager = RouteFreightModel(out, d)
            self.assertIsInstance(eager.models[1], dict)  # monolithic mode
            want = eager.predict("Test Origin", "Test Destination", "2022-01-01")

            self.assertEqual(export_lane_files(out, remove_monolithic=True), 1)
            self.assertFalse(list(out.glob("route_freight_model_h*.joblib")))
            lazy = RouteFreightModel(out, d)
            self.assertNotIsInstance(lazy.models[1], dict)  # lazy mode
            got = lazy.predict("Test Origin", "Test Destination", "2022-01-01")
            self.assertEqual(want, got)
            self.assertTrue(lazy.has_route("Test Origin", "Test Destination"))

    def test_membership_does_not_load_models(self):
        with tempfile.TemporaryDirectory() as td:
            d, out = self._trained(td)
            export_lane_files(out, remove_monolithic=True)
            m = RouteFreightModel(out, d)
            store = m.models[1]._store
            keys = list(m.models[1])
            self.assertEqual(len(keys), 1)
            self.assertIn(keys[0], m.models[1])
            self.assertEqual(len(store._cache), 0)  # nothing loaded yet
            m.models[1][keys[0]]
            self.assertEqual(len(store._cache), 1)

    def test_lru_evicts_oldest_lane(self):
        with tempfile.TemporaryDirectory() as td:
            d, out = self._trained(td)
            export_lane_files(out, remove_monolithic=True)
            m = RouteFreightModel(out, d)
            store = m.models[1]._store
            store.max_cached = 1
            # fabricate a second index entry pointing at the same file
            key = next(iter(store.index))
            store.index["Other|Lane|X"] = dict(store.index[key])
            store.get_lane(key)
            store.get_lane("Other|Lane|X")
            self.assertEqual(list(store._cache), ["Other|Lane|X"])

    def test_retraining_removes_stale_lane_files(self):
        with tempfile.TemporaryDirectory() as td:
            d, out = self._trained(td)
            export_lane_files(out)
            self.assertTrue((out / LANES_DIRNAME).exists())
            train(out, d)  # retrain -> new monolithic files
            self.assertFalse((out / LANES_DIRNAME).exists())
            self.assertIsInstance(RouteFreightModel(out, d).models[1], dict)


if __name__ == "__main__":
    unittest.main()
