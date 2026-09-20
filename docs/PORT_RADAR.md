# Port Disruption Radar

Turns the live AIS history FreightSight already stores into an early-warning
signal: **is this port abnormally congested right now, compared with its own
normal?** — and connects the answer to the freight decision (forecast page,
Decision Brief).

## What the user sees

| Where | What |
| --- | --- |
| **Port Radar** page (`/port-radar`) | Every tracked port, most severe first. Pick one for the full card: status scale, *Normal vs Now* table, *why is it flagged*, operational impact, data coverage. |
| **Forecast results** (`/predict`) | A slim strip with the loading and discharge port status. If either is Elevated/Critical it expands into a route warning with **Run what-if** and **Open port radar**. |
| **Decision Brief PDF** | Page 1 warns when the discharge port or the loading port actually used is Elevated/Critical (costs exclude port delays). Page 2 lists live port conditions for the ports involved. |

## How the status is computed

Code: `ml-service/app/port_radar.py` (pure logic, unit-tested) and
`AISStreamCollector.port_radar_all` in `ml-service/app/ais_stream.py` (SQL).

1. **Now** = the last 6 h of position reports within 20 nm of the port.
2. **Normal** = the same 6-hour clock window on each of the previous 7 days
   (median). Comparing like with like removes time-of-day effects.
3. **A baseline day only counts if the AIS feed was alive** (≥ 30 reports
   table-wide in that window). The collector runs inside ml-service, so any
   downtime leaves empty windows; counting them as "no ships" would drag
   *normal* down and make ordinary traffic look like congestion.
4. Each vessel is classified per window:
   - **waiting** — declared at anchor, or stationary (< 0.5 kn) more than 2 nm
     from the port centre;
   - **moored** — declared moored, or stationary within 2 nm (working cargo,
     *not* congestion);
   - **underway** — moving; fishing/sailing vessels are ignored.
5. Three signals score 0–3 points each: **waiting vessels** (×2 weight),
   **vessels nearby**, **drop in average speed** of vessels under way.

   | Signal | 1 pt | 2 pts | 3 pts | Also required |
   | --- | --- | --- | --- | --- |
   | Waiting vessels, now ÷ normal | ≥ 1.5× | ≥ 2× | ≥ 3× | at least 3 more vessels |
   | Vessels nearby, now ÷ normal | ≥ 1.3× | ≥ 1.6× | ≥ 2× | at least 3 more vessels |
   | Speed drop | ≥ 20 % | ≥ 35 % | ≥ 50 % | ≥ 3 moving vessels in both windows |

6. Score → status: **0–1 Normal · 2–3 Watch · 4–6 Elevated · 7+ Critical**.

## What it does *not* claim

- **No predicted delay in days.** There is no ground-truth turnaround data to
  calibrate one. `impact.planning_assumption_days` (Watch +0.5, Elevated +1,
  Critical +2) is a fixed, labelled planning assumption to start a what-if
  from — never presented as a measurement.
- **"Confidence" is data coverage** (usable baseline days, message volume now,
  vessels typically seen), not the probability the assessment is right.
- **`INSUFFICIENT_DATA` instead of guessing** when fewer than 3 baseline days
  are usable, the feed is down, or fewer than 3 vessels are seen (5 → 8
  vessels is "+60 %" and also noise). It is never shown as "normal".
- The forecast **rate is not adjusted** by the radar, and the Decision Brief
  still ranks options on cost only; the radar adds warnings.

## Known limitations

- **AIS coverage is the ceiling.** Terrestrial AIS at some ports is sparse; the
  radar will say so rather than infer.
- **Shared waters.** Vessels are assigned to the nearest tracked port, so
  Visakhapatnam and Gangavaram (~3.5 nm apart) split one anchorage between
  them. Read them together.
- **Keep ml-service running.** AIS is ingested inside ml-service. If the host
  sleeps (e.g. a free Render instance) ingestion stops; the radar copes by
  excluding those windows, but with few usable days it reports insufficient data.
- Cost: one refresh scans 8 six-hour windows in a single query each; results
  are cached for 2 minutes in ml-service.

## API

| Endpoint | |
| --- | --- |
| `GET /api/ais/port-radar` | All tracked ports, most severe first. Optional `window_hours` (1–24, default 6) and `baseline_days` (3–14, default 7). |
| `GET /api/ais/port-radar/:port` | One port (name URL-encoded, e.g. `Hay%20Point`). 400 for an unknown port. |

ml-service serves the same paths under `/ais/port-radar`.

## Local development and demos

A fresh checkout has no AIS history, so the radar will (correctly) report
insufficient data. To try it locally, seed **simulated** history into the local
SQLite AIS database:

```bash
cd ml-service
python -m app.ais_demo_seed --ports Paradip Visakhapatnam Newcastle --congested Visakhapatnam
```

The seeder refuses to run against MySQL. The radar payload carries `db_client`
and the UI labels a SQLite database as "Local development database. Figures may
be simulated", so seeded data cannot be mistaken for live data.

## Tests

- `ml-service/tests/test_port_radar.py` — classification and scoring rules, plus
  the real SQL against a seeded temporary SQLite database (detects a congested
  port, leaves a normal one alone, excludes feed outages from the baseline,
  reports insufficient data).
- `backend/test/aisPortRadar.test.js` — proxy routes.
- `backend/test/decisionBriefLogic.test.js` / `decisionBriefRoute.test.js` —
  Decision Brief warnings and tolerance of a radar outage.
