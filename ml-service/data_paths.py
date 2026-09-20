"""Single source of truth for resolving ml-service/data/{production,synthetic}
(Phase 10 data governance / Phase 15 "avoid duplicated logic").

Both train.py (offline training) and app/port_utils.py (the live FastAPI
service's vessel/port reference data) import `resolve_data_dir` from here
instead of each hardcoding their own copy of the production-over-synthetic
fallback rule.
"""
import os
from pathlib import Path

REQUIRED_FILES = (
    "world_port_index_clean.csv",
    "global_cargo_ships.csv",
)


def resolve_data_dir(ml_service_root: Path, required_files=REQUIRED_FILES, env_override="FREIGHTSIGHT_DATA_DIR", quiet=False):
    """Return (data_dir: Path, mode: str) where mode is one of
    "override" | "production" | "synthetic".

    Never a silent fallback: prints exactly which directory and why,
    unless quiet=True (used by tests that don't want the noise).
    """
    forced = os.environ.get(env_override)
    if forced:
        d = Path(forced)
        if not quiet:
            print(f"[data] {env_override} override in use: {d}")
        return d, "override"

    prod_dir = ml_service_root / "data" / "production"
    synth_dir = ml_service_root / "data" / "synthetic"
    prod_complete = prod_dir.exists() and all((prod_dir / f).exists() for f in required_files)
    if prod_complete:
        if not quiet:
            print(f"[data] Using PRODUCTION dataset directory: {prod_dir}")
        return prod_dir, "production"

    if not quiet:
        print(
            "[data] WARNING: production dataset directory is missing or incomplete "
            f"({prod_dir}). Falling back to SYNTHETIC development data at {synth_dir}. "
            "This is not real-world data — see data/synthetic/README.md."
        )
    return synth_dir, "synthetic"
