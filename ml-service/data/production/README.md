# FreightSight real-data inputs

Place these public datasets here before running `python train.py`:

- `world_port_index_clean.csv` — cleaned World Port Index, including cargo/channel depth.
- `ores_minerals_trade.csv` — India ores/minerals trade with commodity, quantity and year/date.
- `india_trade_2010_2021.csv` — India trade 2010–2021, used only to extend missing trade coverage.
- `portwatch_daily.csv` — IMF PortWatch daily port activity/trade estimates.
- `global_cargo_ships.csv` — global cargo ship specifications including DWT/draft.
- `brent_oil.csv` — Brent daily price.
- `bdry.csv` — BDRY daily close price.

The trainer fails loudly if any required file is absent. It does **not** use the old
`freight_data.csv` synthetic/demo file as a hidden fallback.

Recommended source references are documented in the SIH execution plan. The Kaggle
copies of the India trade, PortWatch and Global Cargo Ships datasets are also useful
for obtaining the named files; verify their columns against `train.py` before training.
