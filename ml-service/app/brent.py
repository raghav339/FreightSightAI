"""Brent crude reference price: self-refreshing cache + "fuel cost shock" signal.

Used by ModelBundle._derive_risk as one extra, low-weight risk factor.

Design goals
------------
* Never block or break a forecast. Request-time code only reads a local cache
  file; all network I/O happens in a background thread.
* Never go stale silently. The signal reports the as-of date of the latest
  observation and drops out (risk score reverts to its original five-factor
  form) if the data is missing, unreadable or older than MAX_AGE_DAYS.
* No API key. The series is EIA's Europe Brent spot price (dollars/barrel),
  republished by FRED as DCOILBRENTEU. It lags by a few days, which is fine
  for a monthly-horizon freight signal but is NOT live pricing.

Environment variables (all optional)
------------------------------------
BRENT_ENABLED       "false" disables the fetcher and the risk factor.
BRENT_CACHE_FILE    Cache path (default data/production/brent_oil.csv).
BRENT_SOURCE_URL    Override the download URL (must return FRED-style CSV).
"""
from __future__ import annotations

import csv
import io
import os
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]  # ml-service
DEFAULT_CACHE_FILE = ROOT / "data" / "production" / "brent_oil.csv"
DEFAULT_SOURCE_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU"

CACHE_COLUMNS = ("date", "brent_usd_per_bbl")
LEGACY_PRICE_COLUMN = "brent_price_daily"  # older brent_oil.csv layout

REFRESH_INTERVAL_S = 24 * 3600   # normal refresh cadence
RETRY_INTERVAL_S = 3600          # retry cadence after a failed refresh
MAX_AGE_DAYS = 14                # older than this -> factor drops out
LOOKBACK_DAYS = 30               # window for the percentage move
MIN_ROWS_TO_ACCEPT = 30          # sanity check on a downloaded series
SHOCK_CAP = 0.20                 # a >=20% 30-day move saturates the factor

_lock = threading.Lock()
_mem: dict = {"key": None, "series": []}
_state: dict = {"last_attempt": None, "last_success": None, "last_error": None}
_thread: threading.Thread | None = None


def enabled() -> bool:
    return os.environ.get("BRENT_ENABLED", "true").strip().lower() not in ("0", "false", "no", "off")


def cache_path() -> Path:
    return Path(os.environ.get("BRENT_CACHE_FILE", str(DEFAULT_CACHE_FILE)))


def source_url() -> str:
    return os.environ.get("BRENT_SOURCE_URL", DEFAULT_SOURCE_URL)


# --------------------------------------------------------------------------
# Parsing / cache I/O
# --------------------------------------------------------------------------
def parse_series(text: str) -> list[tuple[date, float]]:
    """Parse FRED-style or cache-style CSV into sorted (date, price) pairs.

    Accepts a header row; uses the "brent_usd_per_bbl" or legacy
    "brent_price_daily" column if present, otherwise the second column.
    Rows with a missing value (FRED writes ".") or a bad date are skipped.
    """
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        return []
    header = [c.strip().lower() for c in rows[0]]
    price_idx = 1
    for name in (CACHE_COLUMNS[1], LEGACY_PRICE_COLUMN):
        if name in header:
            price_idx = header.index(name)
            break
    out: dict[date, float] = {}
    for r in rows[1:]:
        if len(r) <= price_idx:
            continue
        try:
            d = datetime.strptime(r[0].strip(), "%Y-%m-%d").date()
            v = float(r[price_idx])
        except ValueError:
            continue
        if v > 0:
            out[d] = v
    return sorted(out.items())


def load_series(path: Path | None = None) -> list[tuple[date, float]]:
    """Read the cache file, re-reading only when it changes on disk."""
    p = Path(path) if path else cache_path()
    try:
        st = p.stat()
    except OSError:
        return []
    key = (str(p), st.st_mtime_ns, st.st_size)
    with _lock:
        if _mem["key"] == key:
            return _mem["series"]
    try:
        series = parse_series(p.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return []
    with _lock:
        _mem["key"], _mem["series"] = key, series
    return series


def write_cache(series: list[tuple[date, float]], path: Path | None = None) -> None:
    p = Path(path) if path else cache_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(CACHE_COLUMNS)
        for d, v in series:
            w.writerow((d.isoformat(), f"{v:.2f}"))
    os.replace(tmp, p)  # atomic: readers never see a half-written file


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------
def fetch_and_cache(url: str | None = None, path: Path | None = None, timeout: float = 20.0) -> int:
    """Download the full series and replace the cache. Returns the row count.

    Raises on network/parse problems or if the download looks too small, so a
    bad response can never overwrite a good cache.
    """
    req = Request(url or source_url(), headers={"User-Agent": "FreightSight/1.0 brent-sync"})
    with urlopen(req, timeout=timeout) as r:
        text = r.read().decode("utf-8", errors="replace")
    series = parse_series(text)
    if len(series) < MIN_ROWS_TO_ACCEPT:
        raise ValueError(f"Brent download too small to trust ({len(series)} rows)")
    write_cache(series, path)
    return len(series)


def refresh_once() -> bool:
    """One refresh attempt; records status and never raises."""
    _state["last_attempt"] = time.time()
    try:
        n = fetch_and_cache()
    except Exception as exc:  # network, parse, disk — all non-fatal
        _state["last_error"] = f"{type(exc).__name__}: {exc}"
        print(f"[brent] refresh failed, keeping cached data: {_state['last_error']}")
        return False
    _state["last_success"] = time.time()
    _state["last_error"] = None
    print(f"[brent] cache refreshed ({n} rows)")
    return True


def _refresh_loop() -> None:
    while True:
        ok = refresh_once()
        time.sleep(REFRESH_INTERVAL_S if ok else RETRY_INTERVAL_S)


def start_background_refresh() -> None:
    """Start the daily refresh thread (idempotent). Refreshes once at startup,
    which also covers hosts whose disk is wiped on every restart."""
    global _thread
    if not enabled():
        return
    with _lock:
        if _thread is not None and _thread.is_alive():
            return
        _thread = threading.Thread(target=_refresh_loop, name="brent-refresh", daemon=True)
        _thread.start()


# --------------------------------------------------------------------------
# The risk signal
# --------------------------------------------------------------------------
def fuel_shock(today: date | None = None, path: Path | None = None) -> dict:
    """Recent Brent move, read from the local cache only (no network).

    Returns {"available": bool, ...}. When available: pct_change_30d (signed
    fraction), latest_usd_per_bbl, as_of (ISO date), age_days. When not:
    "reason" explains why (disabled / no_data / stale / insufficient_history).
    """
    if not enabled():
        return {"available": False, "reason": "disabled"}
    series = load_series(path)
    if not series:
        return {"available": False, "reason": "no_data"}
    today = today or date.today()
    latest_d, latest_v = series[-1]
    age = (today - latest_d).days
    if age > MAX_AGE_DAYS:
        return {"available": False, "reason": "stale", "as_of": latest_d.isoformat(), "age_days": age}
    cutoff = latest_d - timedelta(days=LOOKBACK_DAYS)
    base = next((v for d, v in reversed(series) if d <= cutoff), None)
    if base is None or base <= 0:
        return {"available": False, "reason": "insufficient_history", "as_of": latest_d.isoformat()}
    return {
        "available": True,
        "pct_change_30d": (latest_v - base) / base,
        "latest_usd_per_bbl": latest_v,
        "as_of": latest_d.isoformat(),
        "age_days": age,
    }


def status() -> dict:
    shock = fuel_shock()
    series = load_series()
    fmt = lambda t: datetime.fromtimestamp(t).isoformat(timespec="seconds") if t else None
    return {
        "enabled": enabled(),
        "cache_file": str(cache_path()),
        "rows": len(series),
        "signal": shock,
        "last_attempt": fmt(_state["last_attempt"]),
        "last_success": fmt(_state["last_success"]),
        "last_error": _state["last_error"],
        "max_age_days": MAX_AGE_DAYS,
        "source": source_url(),
    }
