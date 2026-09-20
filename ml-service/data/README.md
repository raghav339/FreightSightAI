# FreightSight data directory (Phase 10 — data governance)

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
  `production/README.md`. `train.py` automatically prefers this directory
  the moment all required files are present here, and prints which
  directory it actually used (it never silently mixes the two). Run
  `python scripts/generate_data_manifest.py production` after populating it.

`train.py`'s data-directory choice (`production` or `synthetic`) is recorded
in every trained model's `metadata.json` as `data_source_mode`, and returned
on every `/predict` response as `training_data_mode`, so the UI/PDF/judge
never has to guess whether a given forecast came from a model trained on
real or synthetic data.
