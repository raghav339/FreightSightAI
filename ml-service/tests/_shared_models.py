"""Shared, process-wide cached ModelBundle/RouteModel for tests.

Constructing either class decompresses several hundred MB of route-freight
joblib models. Each test file used to build its own fresh instance in
setUpClass; with 6+ files doing that in the same pytest process (e.g.
`pytest tests/`), memory use stacked up enough to get OOM-killed on a
small (~4GB) machine even though every file passes individually. These
two cached accessors mean a full test run loads at most one ModelBundle
and one RouteModel, no matter how many files ask for one.

IMPORTANT — shared mutable state: some tests temporarily replace
`bundle.route_freight` / `model.route_freight` with a fake to exercise the
baseline guardrail. Because the instance is now shared across files, any
such test MUST restore the real route_freight in tearDown (see
test_baseline_guardrail.py and test_route_model.py for the pattern) —
leaving a fake in place would silently corrupt every test that runs after
it in the same process, in any file.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_bundle = None
_route_model = None


def get_bundle():
    global _bundle
    if _bundle is None:
        from app.utils import ModelBundle
        _bundle = ModelBundle()
    return _bundle


def get_route_model():
    global _route_model
    if _route_model is None:
        from app.route_model import RouteModel
        _route_model = RouteModel(ROOT / "models")
    return _route_model


def fresh_route_freight():
    """A newly-loaded RouteFreightModel, for tests to restore
    bundle.route_freight/model.route_freight to after swapping in a fake."""
    from route_freight_model import RouteFreightModel
    return RouteFreightModel(ROOT / "models", ROOT / "data" / "production")
