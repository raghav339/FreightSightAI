#!/usr/bin/env python3
"""Train optional route-specific freight models from verified USD/tonne rows."""
from __future__ import annotations
import argparse
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from route_freight_model import export_lane_files, train

ap = argparse.ArgumentParser()
ap.add_argument('--data-dir', default=str(ROOT / 'data' / 'production'))
ap.add_argument('--output-dir', default=str(ROOT / 'models'))
ap.add_argument('--allow-synthetic', action='store_true', help='Train from explicitly labelled synthetic route-freight data.')
args = ap.parse_args()
meta = train(args.output_dir, args.data_dir, allow_synthetic=args.allow_synthetic)
print(json.dumps(meta, indent=2))
if meta.get('status') == 'active':
    print(f"exported {export_lane_files(args.output_dir, remove_monolithic=True)} lane files (lazy loading)")
if meta.get('status') == 'inactive':
    raise SystemExit(0)
