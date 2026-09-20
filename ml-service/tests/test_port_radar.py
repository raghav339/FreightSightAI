"""Port Disruption Radar: rule tests (pure) and an end-to-end test that runs
the real SQL against a temporary SQLite AIS database seeded with simulated
history (app/ais_demo_seed.py)."""
import os
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
# Keep the module-level collector (created on import) away from the real dev DB.
os.environ.setdefault("AISSTREAM_DB", os.path.join(tempfile.mkdtemp(), "import_guard.sqlite3"))

from app import port_radar as pr  # noqa: E402


def summary(seen=10, waiting=3, moored=4, underway=3, speed=9.0, messages=400):
    return {"seen": seen, "waiting": waiting, "moored": moored, "underway": underway,
            "unknown": 0, "avg_speed_kn": speed, "messages": messages}


def baselines(n=7, **kw):
    return [summary(**kw) for _ in range(n)]


def assess(now, base=None, **kw):
    args = dict(feed_ok=True, window_hours=6, baseline_days=7)
    args.update(kw)
    return pr.assess("Paradip", now, base if base is not None else baselines(), **args)


class ClassifyTests(unittest.TestCase):
    def test_declared_at_anchor_is_waiting(self):
        self.assertEqual(pr.classify_vessel({"n": 30, "avg_sog": 0.1, "max_sog": 0.3, "avg_dist": 6, "anchor_share": 1.0}), "waiting")

    def test_stationary_outside_berth_zone_is_waiting_even_without_nav_status(self):
        self.assertEqual(pr.classify_vessel({"n": 30, "avg_sog": 0.1, "max_sog": 0.4, "avg_dist": 5.0}), "waiting")

    def test_stationary_inside_berth_zone_is_moored_not_waiting(self):
        self.assertEqual(pr.classify_vessel({"n": 30, "avg_sog": 0.0, "max_sog": 0.0, "avg_dist": 0.8}), "moored")

    def test_declared_moored_is_moored_even_if_far_from_centre(self):
        self.assertEqual(pr.classify_vessel({"n": 30, "avg_sog": 0.0, "max_sog": 0.0, "avg_dist": 9, "moored_share": 1.0}), "moored")

    def test_moving_vessel_is_underway(self):
        self.assertEqual(pr.classify_vessel({"n": 30, "avg_sog": 9.5, "max_sog": 12, "avg_dist": 10}), "underway")

    def test_single_ping_cannot_prove_a_vessel_is_stationary(self):
        self.assertEqual(pr.classify_vessel({"n": 1, "avg_sog": 0.0, "max_sog": 0.0, "avg_dist": 6}), "unknown")

    def test_fishing_and_sailing_vessels_are_ignored(self):
        self.assertEqual(pr.classify_vessel({"n": 30, "avg_sog": 0.1, "max_sog": 0.2, "avg_dist": 6, "ignore_share": 1.0}), "ignored")

    def test_speed_spike_stops_a_vessel_counting_as_stationary(self):
        self.assertEqual(pr.classify_vessel({"n": 30, "avg_sog": 0.3, "max_sog": 6.0, "avg_dist": 6}), "underway")


class SummarizeTests(unittest.TestCase):
    def test_average_speed_needs_enough_moving_vessels(self):
        two = [{"n": 5, "avg_sog": 8.0, "max_sog": 9, "avg_dist": 5}] * 2
        self.assertIsNone(pr.summarize(two)["avg_speed_kn"])
        three = two + [{"n": 5, "avg_sog": 10.0, "max_sog": 11, "avg_dist": 5}]
        self.assertAlmostEqual(pr.summarize(three)["avg_speed_kn"], 8.67, places=2)

    def test_ignored_vessels_do_not_count_as_seen_but_their_messages_do(self):
        s = pr.summarize([{"n": 9, "ignore_share": 1.0}, {"n": 4, "avg_sog": 9, "max_sog": 9, "avg_dist": 5}])
        self.assertEqual((s["seen"], s["messages"]), (1, 13))


class AssessTests(unittest.TestCase):
    def test_same_as_normal_is_normal(self):
        r = assess(summary())
        self.assertEqual(r["status"], "NORMAL")
        self.assertEqual(r["score"], 0)

    def test_doubling_of_waiting_vessels_reaches_elevated(self):
        r = assess(summary(seen=13, waiting=6))
        self.assertIn(r["status"], ("ELEVATED", "CRITICAL"))
        wait = next(e for e in r["evidence"] if e["key"] == "waiting")
        self.assertTrue(wait["flagged"])
        self.assertEqual(wait["change_pct"], 100.0)

    def test_tripled_queue_plus_slow_traffic_is_critical(self):
        r = assess(summary(seen=16, waiting=9, speed=5.0))
        self.assertEqual(r["status"], "CRITICAL")

    def test_small_wobble_is_not_a_signal(self):
        # 3 -> 4 waiting is +33% but a single vessel; must not flag.
        r = assess(summary(seen=11, waiting=4))
        self.assertEqual(r["status"], "NORMAL")

    def test_speed_drop_alone_only_raises_watch(self):
        r = assess(summary(speed=4.0))  # 9.0 -> 4.0 kn = -56%
        self.assertEqual(r["status"], "WATCH")

    def test_quiet_port_is_not_flagged_as_congested(self):
        r = assess(summary(seen=2, waiting=0, moored=1, underway=1, speed=None))
        self.assertEqual(r["status"], "NORMAL")

    def test_too_few_baseline_days_is_insufficient_not_a_guess(self):
        r = assess(summary(seen=16, waiting=9), baselines(n=2))
        self.assertEqual(r["status"], pr.INSUFFICIENT)
        self.assertIsNone(r["score"])
        self.assertIsNone(r["impact"])
        self.assertIn("2 of the last 7 days", r["insufficient_reason"])

    def test_feed_down_is_insufficient(self):
        r = assess(summary(seen=0, waiting=0, underway=0, moored=0, speed=None, messages=0), feed_ok=False)
        self.assertEqual(r["status"], pr.INSUFFICIENT)
        self.assertIn("AIS feed", r["insufficient_reason"])

    def test_sparse_coverage_is_insufficient(self):
        few = dict(seen=2, waiting=1, moored=1, underway=0, speed=None)
        r = assess(summary(**few), baselines(**few))
        self.assertEqual(r["status"], pr.INSUFFICIENT)
        self.assertIn("Too few vessels", r["insufficient_reason"])

    def test_impact_is_labelled_as_an_assumption_not_a_measurement(self):
        r = assess(summary(seen=16, waiting=9, speed=5.0))
        self.assertEqual(r["impact"]["turnaround_pressure"], "severe")
        self.assertEqual(r["impact"]["planning_assumption_days"], 2.0)
        self.assertIn("not a measured", r["impact"]["assumption_note"])

    def test_confidence_is_coverage_based_and_bounded(self):
        strong = assess(summary())["confidence"]
        weak = assess(summary(messages=10), baselines(n=3, seen=4, waiting=1))["confidence"]
        self.assertGreater(strong["score"], weak["score"])
        for c in (strong, weak):
            self.assertTrue(0 <= c["score"] <= 100)
        self.assertIn("coverage", strong["basis"])

    def test_severity_sort_puts_critical_first_and_insufficient_last(self):
        rs = [assess(summary()), assess(summary(seen=16, waiting=9, speed=5.0)), assess(summary(), baselines(n=1))]
        rs[0]["port"], rs[1]["port"], rs[2]["port"] = "A", "B", "C"
        self.assertEqual([r["port"] for r in sorted(rs, key=pr.severity_key)], ["B", "A", "C"])


class SeededDatabaseTests(unittest.TestCase):
    """The real SQL, end to end, against simulated history in a temp SQLite DB."""

    NOW = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)

    @classmethod
    def setUpClass(cls):
        from app import ais_stream, ais_demo_seed
        cls.ais_stream = ais_stream
        cls.seed = staticmethod(ais_demo_seed.seed)
        cls.tmp = tempfile.mkdtemp()

    def make_collector(self):
        path = Path(self.tmp) / f"{uuid.uuid4().hex}.sqlite3"
        with mock.patch.object(self.ais_stream, "DB_PATH", path):
            c = self.ais_stream.AISStreamCollector()
        # DB_PATH is read on every connect, so keep the patch for the collector's lifetime.
        patcher = mock.patch.object(self.ais_stream, "DB_PATH", path)
        patcher.start()
        self.addCleanup(patcher.stop)
        return c

    def seeded(self, **kw):
        c = self.make_collector()
        self.seed(c, now=self.NOW, ports=["Paradip", "Chennai"], days=8, congested=("Paradip",), **kw)
        return c

    def radar(self, c, port):
        return c.port_radar(port, now=self.NOW)

    def test_detects_the_congested_port_and_leaves_the_normal_port_alone(self):
        c = self.seeded()
        paradip, chennai = self.radar(c, "Paradip"), self.radar(c, "Chennai")
        self.assertIn(paradip["status"], ("ELEVATED", "CRITICAL"), paradip)
        wait = next(e for e in paradip["evidence"] if e["key"] == "waiting")
        self.assertGreaterEqual(wait["change_pct"], 100.0)
        self.assertGreater(wait["now"], wait["baseline"])
        self.assertEqual(chennai["status"], "NORMAL", chennai)

    def test_port_with_no_ais_data_says_insufficient_rather_than_normal(self):
        r = self.radar(self.seeded(), "Newcastle")
        self.assertEqual(r["status"], pr.INSUFFICIENT)

    def test_all_ports_endpoint_covers_every_tracked_port_most_severe_first(self):
        full = self.seeded().port_radar_all(now=self.NOW)
        self.assertEqual(len(full["ports"]), len(self.ais_stream.PORT_COORDS))
        self.assertEqual(full["ports"][0]["port"], "Paradip")
        self.assertEqual(full["ports"][-1]["status"], pr.INSUFFICIENT)
        self.assertEqual(full["baseline_windows_usable"], 7)
        self.assertEqual(full["db_client"], "sqlite")

    def test_a_feed_outage_in_the_baseline_is_excluded_not_read_as_empty_seas(self):
        c = self.seeded()
        # Wipe the whole table for the same clock window three days ago, as if ml-service had been asleep.
        end = self.NOW - timedelta(days=3)
        start = end - timedelta(hours=6)
        with c._connect_db() as conn:
            conn.execute("DELETE FROM ais_positions WHERE received_at >= ? AND received_at < ?",
                         (start.isoformat(), end.isoformat()))
            conn.commit()
        full = c.port_radar_all(now=self.NOW)
        self.assertEqual(full["baseline_windows_usable"], 6)
        chennai = next(p for p in full["ports"] if p["port"] == "Chennai")
        self.assertEqual(chennai["status"], "NORMAL")
        self.assertEqual(chennai["baseline"]["windows_used"], 6)

    def test_feed_down_now_is_reported_as_such(self):
        c = self.seeded()
        r = c.port_radar("Paradip", now=self.NOW + timedelta(days=30))
        self.assertEqual(r["status"], pr.INSUFFICIENT)
        self.assertFalse(r["feed_active_now"])

    def test_unknown_port_is_rejected(self):
        with self.assertRaises(ValueError):
            self.make_collector().port_radar("Atlantis", now=self.NOW)

    def test_seeder_refuses_to_touch_mysql(self):
        from app import ais_demo_seed
        with self.assertRaises(RuntimeError):
            ais_demo_seed.seed(SimpleNamespace(db_client="mysql"), now=self.NOW, ports=["Paradip"])


if __name__ == "__main__":
    unittest.main()
