"""Synthetic AIS history for LOCAL development, tests and offline demos of the
Port Disruption Radar.

    python -m app.ais_demo_seed --ports Paradip Chennai --congested Paradip

This writes SIMULATED position reports into the local SQLite AIS database so
the radar has a baseline and (optionally) a congestion episode to detect. It
exists because the radar needs several days of history, which a fresh
checkout does not have.

Safety: it refuses to run against MySQL (the production store), and the radar
response reports ``db_client`` so the UI can label a local database as such.
Never point it at real data you want to keep; ``--clear`` wipes the table.
"""
from __future__ import annotations

import argparse
import random
from datetime import datetime, timedelta, timezone

from app.ais_stream import PORT_COORDS, AISStreamCollector

STEP_MIN = 10  # each simulated vessel reports every 10 minutes

# Typical traffic per port: (underway, waiting at anchor, moored at berth)
BASE_TRAFFIC = (6, 3, 4)


_ROLE_DIGIT = {"U": 1, "W": 2, "M": 3}


def _vessels_for(port_idx: int, underway: int, waiting: int, moored: int):
    """Stable 9-digit MMSIs so the same simulated ships reappear every step."""
    out = []
    for role, count in (("U", underway), ("W", waiting), ("M", moored)):
        for i in range(count):
            out.append((role, f"9{port_idx:02d}{_ROLE_DIGIT[role]}{i:03d}00"))
    return out


def _row(rng, t, port, port_idx, role, mmsi):
    lat, lon = PORT_COORDS[port]
    if role == "U":
        sog, dist, nav = rng.uniform(8.0, 12.0), rng.uniform(3.0, 15.0), 0
    elif role == "W":
        sog, dist, nav = rng.uniform(0.05, 0.3), rng.uniform(4.0, 9.0), 1
    else:
        sog, dist, nav = 0.0, rng.uniform(0.4, 1.5), 5
    return (t.isoformat(), None, mmsi, f"SIM {role}{mmsi[-5:]}", lat, lon, sog, 0.0, 0.0, nav, port, dist, None)


def seed(collector: AISStreamCollector, *, now: datetime, ports: list[str], days: int = 8,
         congested: tuple[str, ...] = (), congestion_hours: float = 6.0, rng_seed: int = 7,
         clear: bool = False) -> int:
    """Insert simulated history ending at ``now``. Returns rows inserted."""
    if collector.db_client != "sqlite":
        raise RuntimeError("ais_demo_seed only writes to the local SQLite AIS database, never MySQL.")
    unknown = [p for p in ports if p not in PORT_COORDS]
    if unknown:
        raise ValueError(f"Unknown AIS ports: {unknown}")

    rng = random.Random(rng_seed)
    rows = []
    start = now - timedelta(days=days)
    congestion_from = now - timedelta(hours=congestion_hours)
    steps = int((now - start).total_seconds() // (STEP_MIN * 60))

    for port in ports:
        port_idx = list(PORT_COORDS).index(port)
        # Normal day-to-day variation in queue length: one offset per day.
        wobble = {d: rng.choice((-1, 0, 0, 1)) for d in range(days + 1)}
        for s in range(steps):
            t = start + timedelta(minutes=STEP_MIN * s)
            in_episode = port in congested and t >= congestion_from
            under, wait, moor = BASE_TRAFFIC
            wait = max(1, wait + wobble[(t - start).days])
            if in_episode:
                wait, under = BASE_TRAFFIC[1] * 3, under + 3  # queue triples, extra arrivals pile in
            for role, mmsi in _vessels_for(port_idx, under, wait, moor):
                jitter = t + timedelta(seconds=rng.randint(0, 59))
                row = _row(rng, jitter, port, port_idx, role, mmsi)
                if in_episode and role == "U":  # arrivals crawl towards a full anchorage
                    row = row[:6] + (rng.uniform(2.5, 4.5),) + row[7:]
                rows.append(row)

    with collector._connect_db() as conn:
        if clear:
            conn.execute("DELETE FROM ais_positions")
        conn.executemany(
            """INSERT INTO ais_positions
               (received_at,ais_timestamp,mmsi,ship_name,lat,lon,sog,cog,heading,nav_status,port_near,port_distance_nm,ship_type)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            rows,
        )
        conn.commit()
    return len(rows)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ports", nargs="+", default=["Paradip", "Visakhapatnam", "Chennai"])
    ap.add_argument("--congested", nargs="*", default=[], help="ports to simulate a congestion episode at")
    ap.add_argument("--days", type=int, default=8)
    ap.add_argument("--clear", action="store_true", help="delete ALL existing ais_positions first")
    args = ap.parse_args()
    collector = AISStreamCollector()
    n = seed(collector, now=datetime.now(timezone.utc), ports=args.ports, days=args.days,
             congested=tuple(args.congested), clear=args.clear)
    print(f"Inserted {n} SIMULATED position reports into {collector.status().get('db_path')}")


if __name__ == "__main__":
    main()
