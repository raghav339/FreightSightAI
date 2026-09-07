# FreightSight SIH26006 — Synthetic Training Data

These CSVs are SYNTHETIC and are intended only for local development/testing.
They are structured to match the current `ml-service/train.py` pipeline and the
SIH26006 execution plan's required feature sources.

Files:
1. world_port_index_clean.csv
2. ores_minerals_trade.csv
3. india_trade_2010_2021.csv
4. portwatch_daily.csv
5. global_cargo_ships.csv
6. brent_oil.csv
7. bdry.csv

Important:
- Do NOT present these values as real public datasets in the final SIH demo/PPT.
- Replace them with the real source files before making real-data claims.
- The synthetic data includes enough historical coverage for monthly lags,
  rolling volatility, a chronological train/test split, and model evaluation.


## Synthetic route freight rates (MVP)

`route_freight_rates.csv` / `route_freight_observations.csv` contain synthetic monthly USD/tonne route rates supplied for the FreightSight MVP. They are deliberately stored under `data/synthetic/`, never under verified production data, and are labelled `synthetic_mvp` in model metadata and API responses. They must not be presented as broker quotes or observed market rates.

The MVP route model uses the seven supplied lanes and trains H+1/H+2/H+3 Random Forest models. When a verified production route-rate dataset is later added, the verified production source takes precedence automatically.

- **R8:** Newcastle → Chennai → Iron Ore — synthetic route freight rate series (USD/t), 2015-01 through 2026-08.
