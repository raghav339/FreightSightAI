# Optional commodity benchmark data

FreightSight now supports an opt-in external commodity benchmark sync.

**Coal:** IMF Primary Commodity Prices series `PCOALAUUSDM` (Global price of Coal, Australia), exposed through FRED as a monthly USD/metric-ton series.

Run `python ml-service/scripts/fetch_commodity_data.py` from a network-enabled environment to create `ml-service/data/production/coal_price_australia_fred.csv`.

The application does **not** silently download data during training or inference. This keeps model runs reproducible and auditable. Once synced, the file is a clearly-labelled commodity benchmark input; it is not a freight rate. Because the IMF source is represented through a FRED series, keep the source attribution and licensing note with any redistribution of the downloaded data.
