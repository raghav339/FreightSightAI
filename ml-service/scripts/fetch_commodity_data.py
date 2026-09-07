"""Fetch optional external commodity benchmark data into data/production.

Current series:
- PCOALAUUSDM: IMF Global price of Coal, Australia, via FRED.

Usage:
  python fetch_commodity_data.py --output-dir ../data/production

The script is intentionally opt-in: training never silently reaches the
internet. When the file exists, downstream training/data-prep code can use it.
"""
from __future__ import annotations
import argparse
from pathlib import Path
from urllib.request import Request, urlopen

FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=PCOALAUUSDM"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir", default=str(Path(__file__).resolve().parents[1] / "data" / "production"))
    args = ap.parse_args()
    out_dir = Path(args.output_dir); out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "coal_price_australia_fred.csv"
    req = Request(FRED_URL, headers={"User-Agent": "FreightSight/1.0 data-sync"})
    with urlopen(req, timeout=30) as r:
        data = r.read()
    out_file.write_bytes(data)
    print(f"Wrote {out_file} ({len(data):,} bytes)")
    print("Source: IMF Primary Commodity Prices / FRED series PCOALAUUSDM")

if __name__ == "__main__":
    main()
