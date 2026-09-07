# FreightSight route freight observation collector

This package adds a **provenance-first route freight observation layer** to FreightSight SIH26006.

## What it creates

`ml-service/data/production/route_freight_observations.csv` is the canonical target table. It is intentionally empty until source-backed observations are verified.

`ml-service/data/production/route_freight_sources.json` contains the route registry and source manifest.

`ml-service/scripts/collect_route_freight.py` supports:

- candidate extraction from downloaded PDF/HTML/text reports;
- normalization into the canonical schema;
- human-review status (`candidate`, `verified`, `rejected`);
- duplicate-safe merging;
- provenance validation.

## Important data rule

The collector **does not convert BDI/BDRY/BCI or AIS signals into fake freight rates**. It also does not silently convert TCE ($/day) to $/t. TCE rows may be retained as `rate_type=tce_usd_per_day`, but `freight_usd_per_t` stays blank unless an independently verified $/t observation exists.

This preserves the SIH requirement that synthetic/proxy information is never presented as observed route freight.

## Recommended directory layout

```text
ml-service/
  data/production/
    route_freight_observations.csv
    route_freight_sources.json
  scripts/
    collect_route_freight.py
  sources/
    raw/
    review_candidates.csv
```

## Workflow

### 1. Initialize

```bash
cd ml-service
python scripts/collect_route_freight.py init
```

### 2. Put public reports in `ml-service/sources/raw/`

Only use documents/pages that you are allowed to access and reuse. The manifest includes source URLs discovered during research, but it intentionally does not bypass paywalls or anti-bot controls.

### 3. Extract candidate rows

Install the optional PDF dependency if needed:

```bash
pip install pypdf
```

Then:

```bash
python scripts/collect_route_freight.py extract \
  --input sources/raw/dry_freight_wire_2026_03_06.pdf \
  --source-id dry_freight_wire_2026_03_06 \
  --source-name "Dry Freight Wire 06-Mar-2026" \
  --source-url "https://www.scribd.com/document/1009938919/Dry-Freight-Wire-06-Mar-2026"
```

The extractor produces **candidates only**. It searches for a known route, a nearby `$.../mt` or `$.../t` value, cargo size, and a nearby date.

### 4. Human verification

Open `ml-service/sources/review_candidates.csv` and verify every candidate against the original report. Correct any split table fields manually. Set:

```text
verification_status=verified
```

and set an honest `confidence` value.

Use:

- `high`: first-party/publisher-controlled observation or directly verified official index value;
- `medium`: independently published public report/fixture verified against the document;
- `low`: ambiguous extraction, OCR, or incomplete source context.

### 5. Merge only verified rows

```bash
python scripts/collect_route_freight.py merge \
  --input sources/review_candidates.csv \
  --approved-only
```

### 6. Validate

```bash
python scripts/collect_route_freight.py validate
```

## Canonical schema

| Column | Meaning |
|---|---|
| `observation_date` | Date the freight observation applies to |
| `origin` / `destination` | Canonical port/region labels |
| `route_id` | FreightSight route key |
| `commodity` | Normalized commodity |
| `vessel_class` | Vessel class represented by the observation |
| `cargo_size_t` | Contract/assessment cargo size |
| `freight_usd_per_t` | Observed $/t only; blank for TCE |
| `rate_type` | `freight_usd_per_t` or `tce_usd_per_day` |
| `observation_type` | `assessment`, `fixture`, etc. |
| `source_name` / `source_url` | Provenance |
| `source_reference` | Page/line/table/report identifier |
| `verification_status` | `candidate`, `verified`, `rejected` |
| `confidence` | `high`, `medium`, `low` |

## Priority routes

The first routes to collect are:

1. South Kalimantan → Paradip
2. South Kalimantan → Krishnapatnam
3. Richards Bay → Paradip
4. Richards Bay → Krishnapatnam
5. Gladstone → Dhamra

The source manifest also keeps Hampton Roads → Paradip, Taman → Paradip and Vostochny → Paradip route definitions ready for future observations.

## Integration with the current FreightSight model

The existing route model in this project currently uses an AIS-enhanced **market proxy** because the supplied real dataset does not contain a historical route-freight target. This collector supplies the missing target layer; it does not silently switch the model to route-level supervised forecasting.

Once enough verified observations exist for a route/vessel/commodity slice, integrate them into training as the supervised target and keep the fallback hierarchy for routes without sufficient coverage.

## Source notes

The source manifest deliberately distinguishes **official route definitions** from **public observation candidates**. A public methodology page can prove that a route/index exists without providing the whole historical time series for free.

## Production integration

Once `data/production/route_freight_observations.csv` contains enough `verification_status=verified` rows for a lane, train the optional direct route models:

```bash
cd ml-service
python scripts/train_route_freight.py
```

The API automatically prefers a matching direct route model for an exact lane. Every other lane continues to use the AIS-enhanced market-proxy model. No route is matched by fuzzy destination/commodity fallback inside the direct model.

The status endpoint is:

```text
GET /route-freight/status
```

It reports verified-row count, active route models, and skipped lanes. If the verified target dataset becomes empty, previously generated route-specific model artifacts are removed so stale models cannot be served.


### R8 — Newcastle → Chennai → Iron Ore

MVP synthetic monthly route freight series is included in `ml-service/data/synthetic/route_freight_rates.csv` and mirrored into `route_freight_observations.csv`. It is explicitly marked `verification_status=synthetic`, `data_source=synthetic_generated`, and must never be presented as a broker quote or observed market rate.
