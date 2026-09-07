"""Generate DATASET_MANIFEST.json for a FreightSight data directory (Phase 10).

Computes real, on-disk statistics for every CSV in the target directory —
row count, column count, a best-effort coverage period (from any date/year
column found), and missingness — rather than hand-typed numbers. Run this
after adding/replacing files in data/synthetic/ or data/production/.

Usage:
    python scripts/generate_data_manifest.py synthetic
    python scripts/generate_data_manifest.py production
"""
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_VERSION = "1.0.0"

# Per-directory source labeling. This is the one place a human states where
# each dataset actually came from — never inferred or guessed by the script.
SOURCE_LABELS = {
    "synthetic": {
        "source": "Synthetic — generated for FreightSight SIH26006 local development/testing.",
        "source_url": None,
        "approval_status": "not_applicable_synthetic",
    },
    "production": {
        "source": "UNSET — real dataset not yet placed in this directory.",
        "source_url": None,
        "approval_status": "pending",
    },
}

DATE_COL_CANDIDATES = ["date", "month", "year"]


def find_date_col(df: pd.DataFrame):
    lower = {c.lower(): c for c in df.columns}
    for cand in DATE_COL_CANDIDATES:
        if cand in lower:
            return lower[cand]
    return None


def coverage_period(df: pd.DataFrame):
    col = find_date_col(df)
    if col is None:
        return None
    try:
        parsed = pd.to_datetime(df[col], errors="coerce")
        parsed = parsed.dropna()
        if parsed.empty:
            return None
        return {"start": str(parsed.min().date()), "end": str(parsed.max().date()), "date_column": col}
    except Exception:
        return None


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def build_manifest(data_dir: Path, dir_key: str):
    labels = SOURCE_LABELS.get(dir_key, SOURCE_LABELS["production"])
    entries = []
    for csv_path in sorted(data_dir.glob("*.csv")):
        df = pd.read_csv(csv_path)
        n_cells = df.shape[0] * df.shape[1] if df.shape[1] else 0
        missing_pct = round(float(df.isna().sum().sum()) / n_cells * 100, 3) if n_cells else 0.0
        entries.append(
            {
                "filename": csv_path.name,
                "source": labels["source"],
                "source_url": labels["source_url"],
                "retrieval_date": None if dir_key == "production" else "n/a (synthetic — not retrieved)",
                "coverage_period": coverage_period(df),
                "schema_version": SCHEMA_VERSION,
                "row_count": int(df.shape[0]),
                "column_count": int(df.shape[1]),
                "missingness_pct": missing_pct,
                "file_sha256_short": file_hash(csv_path),
                "validation_status": "not_yet_validated",
                "approval_status": labels["approval_status"],
                "approved_by": None,
                "approved_at": None,
            }
        )
    manifest = {
        "directory": dir_key,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generator": "ml-service/scripts/generate_data_manifest.py",
        "note": (
            "Synthetic development/test data — not real maritime observations."
            if dir_key == "synthetic"
            else "Production data directory. Populate with verified real datasets matching "
            "the schemas documented in data/README.md, then re-run this script."
        ),
        "files": entries,
    }
    return manifest


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("synthetic", "production"):
        print("Usage: python scripts/generate_data_manifest.py [synthetic|production]")
        sys.exit(1)
    dir_key = sys.argv[1]
    data_dir = ROOT / "data" / dir_key
    manifest = build_manifest(data_dir, dir_key)
    out_path = data_dir / "DATASET_MANIFEST.json"
    out_path.write_text(json.dumps(manifest, indent=2))
    print(f"Wrote {out_path} ({len(manifest['files'])} files)")


if __name__ == "__main__":
    main()
