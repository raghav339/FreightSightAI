# FreightSight data directory (data governance)

This directory is split by provenance so no dataset can be mistaken for
something it isn't:

- **`synthetic/`** — the CSVs currently used to train and demo the models.
  They are **synthetic development/test data, not real maritime
  observations** — see `synthetic/README.md`. `synthetic/DATASET_MANIFEST.json`
  records real, computed stats (row counts, coverage period, missingness,
  file hash) for every file in this folder — regenerate it after any change
  with `python scripts/generate_data_manifest.py synthetic`.

- **`production/`** — empty by default. This is where verified real-world
  datasets go, matching the filenames/schemas documented in
  `production/README.md`. `route_freight_model.py` automatically prefers
  verified production observations the moment there are enough of them for
  every trained lane, and records which mode it actually used (it never
  silently mixes the two). Run
  `python scripts/generate_data_manifest.py production` after populating it.

`route_freight_model.py` decides, per lane, whether to use verified production observations or fall back to the synthetic MVP dataset — it needs enough production rows for *every* lane the model was trained on before treating production as usable at all (a handful of production rows can't be reliably mixed with a model that was otherwise trained on synthetic data). That choice is recorded in the model's own `data_mode` field (`verified_production` or `synthetic_mvp`) and returned on every `/predict` response as `training_data_mode`, so the UI/PDF/judge never has to guess whether a given forecast came from a model trained on real or synthetic data.
