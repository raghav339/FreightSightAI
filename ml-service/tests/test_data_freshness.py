# ================================================================
# FILE: ml-service/tests/test_data_freshness.py
# ================================================================
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.data_freshness import classify_ais_freshness

NOW = datetime(2026, 9, 13, tzinfo=timezone.utc)


class TestClassifyAisFreshness(unittest.TestCase):
    def test_live_when_ais_recent_and_query_succeeded(self):
        status = classify_ais_freshness(
            live_ais={"origin": {}, "destination": {}},
            ais_collector_last_message_at="2026-09-13T11:00:00+00:00",  # 1h old
            portwatch_latest_month="2024-10-01",
            now=NOW,
        )
        self.assertEqual(status.status, "live")
        self.assertEqual(status.source, "aisstream_live")
        self.assertEqual(status.last_update, "2026-09-13T11:00:00+00:00")

    def test_recent_when_ais_query_ok_but_last_message_a_day_old(self):
        status = classify_ais_freshness(
            live_ais={"origin": {}, "destination": {}},
            ais_collector_last_message_at="2026-09-12T00:00:00+00:00",  # 36h old
            portwatch_latest_month="2024-10-01",
            now=NOW,
        )
        self.assertEqual(status.status, "recent")
        self.assertEqual(status.source, "aisstream_live")

    def test_falls_back_to_portwatch_when_ais_collector_has_gone_quiet(self):
        # route_features() "succeeded" (live_ais present) but the collector's
        # own last_message_at is many days old — a dead feed should not be
        # trusted just because the query didn't raise.
        status = classify_ais_freshness(
            live_ais={"origin": {}, "destination": {}},
            ais_collector_last_message_at="2026-08-01T00:00:00+00:00",
            portwatch_latest_month="2024-10-01",
            now=NOW,
        )
        self.assertEqual(status.source, "portwatch_monthly")

    def test_stale_when_only_old_portwatch_data_available(self):
        # This is the real, present-day case for this project: PortWatch
        # route features stop at 2024-10-01 while "now" is 2026 — nearly
        # two years old, not a plausible "recent" fallback.
        status = classify_ais_freshness(
            live_ais=None,
            ais_collector_last_message_at=None,
            portwatch_latest_month="2024-10-01",
            now=NOW,
        )
        self.assertEqual(status.status, "stale")
        self.assertEqual(status.source, "portwatch_monthly")
        self.assertEqual(status.last_update, "2024-10-01")
        self.assertIn("fallback", status.note.lower())

    def test_recent_when_portwatch_data_is_only_a_few_weeks_old(self):
        status = classify_ais_freshness(
            live_ais=None,
            ais_collector_last_message_at=None,
            portwatch_latest_month="2026-08-15",  # ~29 days before NOW
            now=NOW,
        )
        self.assertEqual(status.status, "recent")
        self.assertEqual(status.source, "portwatch_monthly")

    def test_unavailable_when_nothing_at_all(self):
        status = classify_ais_freshness(
            live_ais=None,
            ais_collector_last_message_at=None,
            portwatch_latest_month=None,
            now=NOW,
        )
        self.assertEqual(status.status, "unavailable")
        self.assertEqual(status.source, "none")
        self.assertIsNone(status.last_update)

    def test_never_fabricates_last_update_as_now(self):
        # Regression guard: last_update must always be the data's own
        # timestamp, never a stamp of "now" pretending the data is current.
        status = classify_ais_freshness(
            live_ais=None,
            ais_collector_last_message_at=None,
            portwatch_latest_month="2024-10-01",
            now=NOW,
        )
        self.assertNotEqual(status.last_update, NOW.date().isoformat())
        self.assertEqual(status.last_update, "2024-10-01")


if __name__ == "__main__":
    unittest.main()