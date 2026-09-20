# FreightSight real-data inputs

These public datasets support the live app's port/vessel/AIS reference data
(`app/port_utils.py`, `app/ais_stream.py`) and the route-freight model
(`route_freight_model.py`). The old BDRY/AIS forecast+risk pipeline
(`train.py`, which used to require `bdry.csv` here) was removed entirely —
nothing in this project reads `bdry.csv` any more.

- `world_port_index_clean.csv` — cleaned World Port Index, including cargo/channel depth.
- `global_cargo_ships.csv` — global cargo ship specifications including DWT/draft.
- `brent_oil.csv` — Brent daily spot price (USD/bbl). **Self-refreshing cache** written by `app/brent.py` (startup + daily, from FRED series `DCOILBRENTEU`, lags a few days). The checked-in copy is only a seed; if the file is missing or older than 14 days the Brent risk factor is skipped.
- `route_freight_observations.csv` — verified route freight-rate observations (see `route_freight_sources.json` for provenance). Train against this with `python scripts/train_route_freight_grid.py` (or `route_freight_model.py:train()` directly) once it has ≥24 observations for a lane; until then, `RouteFreightModel` falls back to `data/synthetic/route_freight_observations.csv`, clearly labelled `synthetic_mvp`.

Recommended source references are documented in the SIH execution plan. The Kaggle
copy of the Global Cargo Ships dataset is also useful for obtaining the named file;
verify its columns against `app/port_utils.py` / `app/ais_stream.py` before use.
