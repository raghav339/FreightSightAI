# FreightSight SIH26006 — Synthetic Training Data

These CSVs are SYNTHETIC and are intended only for local development/testing.
The BDRY/AIS market-proxy pipeline that originally consumed most of these
files (`train.py`) has been removed; the live app only reads
`route_freight_observations.csv` from this directory for forecasting.
`world_port_index_clean.csv` and `global_cargo_ships.csv` remain as fallback
reference data for `app/port_utils.py` and `app/ais_stream.py`.

Files:
1. world_port_index_clean.csv
2. global_cargo_ships.csv
3. route_freight_observations.csv

Important:
- Do NOT present these values as real public datasets in the final SIH demo/PPT.
- Replace them with the real source files before making real-data claims.


## Synthetic route freight rates (MVP)

`route_freight_observations.csv` contains synthetic monthly USD/tonne route
rates covering every origin x destination x commodity lane the app can
route a request to (see `scripts/generate_synthetic_route_grid.py`). It is
deliberately stored under `data/synthetic/`, never under verified
production data, and is labelled `synthetic_mvp` in model metadata and API
responses. It must not be presented as broker quotes or observed market
rates.

`route_freight_model.py` trains H+1/H+2/H+3 Random Forest models per lane
from this file (see `scripts/train_route_freight_grid.py` for how the full
grid is trained in batches). When a verified production route-rate dataset
is later added to `data/production/`, the verified production source takes
precedence automatically.
