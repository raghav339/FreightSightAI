# ================================================================
# FILE: ml-service/app/data_freshness.py
# ================================================================
"""Freshness classification for AIS/PortWatch-derived route features.

Problem this fixes: RouteModel blends three data sources of very
different ages — live AISStream events, IMF PortWatch's monthly
aggregate, and (when both of those are unavailable) the last historical
row carried forward unchanged. Previously the only signal exposed for
this was a single boolean (`ais_feature_stale`) computed by comparing the
*requested shipment date* to the training data's latest month — which
never asks the one question that actually matters: how old is this data
**right now**, in the real world? A route whose PortWatch features stop
in October 2024 was being used, silently, as if it reflected September
2026 conditions.

This module always compares the data's own timestamp against the real
wall-clock date (UTC "now" by default) — never against the shipment date
the user requested. A forecast for a future shipment date does not make
today's underlying market data any less current or any more stale; those
are two independent questions, and conflating them is exactly what let
stale data look trustworthy.

Do NOT use this module to stamp a fabricated "last_update": always pass
through the data's own true timestamp (AISStream's last_message_at, or
PortWatch's latest_route_feature_month). Reporting today's date as the
"last_update" for data that hasn't actually changed would hide the exact
problem this exists to surface.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import pandas as pd

# AIS is a near-real-time feed. A `route_features()` call that queried
# successfully is not, by itself, proof the collector is currently
# connected — a long-dead websocket can still return a stats query
# against old rows without erroring. `last_message_at` (the collector's
# own record of when it last actually heard anything) is the real
# liveness signal, and these gaps are how long ago that can have been
# for the feed to still count as LIVE vs. merely RECENT.
AIS_LIVE_MAX_GAP_HOURS = 6.0
AIS_RECENT_MAX_GAP_HOURS = 48.0

# PortWatch route features are published monthly. A month or so of
# publication lag is normal and still "recent" congestion data; anything
# older than that is a stale fallback, not current market conditions.
PORTWATCH_RECENT_MAX_AGE_DAYS = 60.0


@dataclass
class FreshnessStatus:
    status: str  # "live" | "recent" | "stale" | "unavailable"
    source: str  # "aisstream_live" | "portwatch_monthly" | "none"
    last_update: str | None  # ISO date/datetime of the ACTUAL underlying data
    age_hours: float | None
    note: str

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "source": self.source,
            "last_update": self.last_update,
            "age_hours": round(self.age_hours, 1) if self.age_hours is not None else None,
            "note": self.note,
        }


def _to_utc_timestamp(value) -> pd.Timestamp | None:
    if value is None:
        return None
    try:
        ts = pd.Timestamp(value)
    except (ValueError, TypeError):
        return None
    if pd.isna(ts):
        return None
    return ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")


def classify_ais_freshness(
    *,
    live_ais: dict | None,
    ais_collector_last_message_at: str | None,
    portwatch_latest_month: str | None,
    now: datetime | None = None,
) -> FreshnessStatus:
    """Decide LIVE / RECENT / STALE / UNAVAILABLE for a route's AIS/PortWatch
    congestion features.

    live_ais: the dict returned by AISStreamCollector.route_features(), or
        None if live AIS wasn't queried or the query failed.
    ais_collector_last_message_at: AISStreamCollector.last_message_at — the
        real timestamp of the last AIS message the collector has ever
        received, independent of the specific route/lookback window.
    portwatch_latest_month: the training metadata's latest_route_feature_month
        (e.g. "2024-10-01") — the true age of the PortWatch fallback data.
    now: wall-clock reference; defaults to real UTC now. Only overridden in
        tests — never derived from the shipment date being forecast.
    """
    now_ts = _to_utc_timestamp(now) or pd.Timestamp.now(tz="UTC")

    # 1. Live AIS: requires both a successful route_features() result AND a
    #    genuinely recent last-message timestamp from the collector itself.
    if live_ais is not None:
        last_msg = _to_utc_timestamp(ais_collector_last_message_at)
        if last_msg is not None:
            age_hours = (now_ts - last_msg).total_seconds() / 3600.0
            if age_hours <= AIS_LIVE_MAX_GAP_HOURS:
                return FreshnessStatus(
                    status="live",
                    source="aisstream_live",
                    last_update=last_msg.isoformat(),
                    age_hours=age_hours,
                    note="Live AIS vessel-activity features.",
                )
            if age_hours <= AIS_RECENT_MAX_GAP_HOURS:
                return FreshnessStatus(
                    status="recent",
                    source="aisstream_live",
                    last_update=last_msg.isoformat(),
                    age_hours=age_hours,
                    note="AIS feed reconnected recently; features reflect recent, not live-second, activity.",
                )
            # The collector has data but hasn't heard anything in a long
            # time — fall through to the PortWatch check below rather than
            # trusting a possibly-dead feed's cached query result.

    # 2. PortWatch monthly aggregate, used as a fallback.
    latest_month = _to_utc_timestamp(portwatch_latest_month)
    if latest_month is not None:
        age_days = (now_ts - latest_month).total_seconds() / 86400.0
        if age_days <= PORTWATCH_RECENT_MAX_AGE_DAYS:
            return FreshnessStatus(
                status="recent",
                source="portwatch_monthly",
                last_update=latest_month.date().isoformat(),
                age_hours=age_days * 24,
                note="Live AIS unavailable; using a recent PortWatch monthly update as fallback.",
            )
        return FreshnessStatus(
            status="stale",
            source="portwatch_monthly",
            last_update=latest_month.date().isoformat(),
            age_hours=age_days * 24,
            note="AIS/port congestion features are stale and are being used only as fallback inputs.",
        )

    # 3. Nothing at all.
    return FreshnessStatus(
        status="unavailable",
        source="none",
        last_update=None,
        age_hours=None,
        note="No live or historical AIS/port-activity data available for this route.",
    )