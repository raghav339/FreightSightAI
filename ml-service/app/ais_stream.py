"""AISStream live collector for FreightSight.

AISStream is a server-side WebSocket feed. This module:
- subscribes to focused bounding boxes around FreightSight origin/destination ports
- persists PositionReport + ShipStaticData events in MySQL in production (SQLite fallback for local development)
- exposes recent route/port operational features for the route model
- reconnects with exponential backoff

API key is read only from AISSTREAM_API_KEY. Never send it to the frontend.
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
from contextlib import contextmanager
import threading
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

from app.idle_detector import Observation, detect_idle_vessel, MIN_IDLE_HOURS, PORT_RADIUS_NM

try:
    import websocket
except Exception:  
    websocket = None


_NAV_STATUS_STRING_TO_INT = {
    "underwayusingengine": 0,
    "atanchor": 1,
    "notundercommand": 2,
    "restrictedmanoeuvrability": 3,
    "restrictedmaneuverability": 3,
    "constrainedbyherdraught": 4,
    "constrainedbydraught": 4,
    "moored": 5,
    "aground": 6,
    "engagedinfishing": 7,
    "underwaysailing": 8,
    "reservedforfutureamendmentofnavigationalstatusforhscwig": 9,
    "reservedforfutureuse": 9,
    "reserved": 9,
    "powerdrivenvesseltowingastern": 11,
    "powerdrivenvesselpushingaheadortowingalongside": 12,
    "reservedforfutureuse13": 13,
    "aissart": 14,
    "aissartmobsartorepirb": 14,
    "notdefined": 15,
    "undefined": 15,
    "default": 15,
}


def _normalize_nav_status(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.isdigit():
            return int(stripped)
        key = stripped.lower().replace("_", "").replace(" ", "").replace("-", "")
        return _NAV_STATUS_STRING_TO_INT.get(key)
    return None

AIS_URL = "wss://stream.aisstream.io/v0/stream"
ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("AISSTREAM_DB", str(ROOT / "data" / "production" / "aisstream_live.sqlite3")))
PORT_INDEX = ROOT / "data" / "production" / "world_port_index_clean.csv"

PORT_COORDS = {
    "Newcastle": (-32.916667, 151.783333),
    "Hay Point": (-21.283333, 149.300000),
    "Gladstone": (-23.850000, 151.250000),
    "Norfolk": (36.850000, -76.300000),
    "Baltimore": (39.266667, -76.583333),
    "Nacala": (-14.533333, 40.666667),
    "Beira": (-19.833333, 34.833333),
    "Vostochny": (42.750000, 133.083333),
    "Murmansk": (68.983333, 33.050000),
    "Samarinda": (-0.516667, 117.116667),
    "Taboneo": (-3.683333, 114.416667),
    "Paradip": (20.266667, 86.683333),
    "Visakhapatnam": (17.686800, 83.218500),
    "Gangavaram": (17.638900, 83.215800),
    "Gopalpur": (19.250000, 84.916667),
    "Dhamra": (20.782000, 86.914000),
    "Sagar Sandheads": (21.000000, 88.250000),
    "Haldia": (22.016667, 88.083333),
    "Chennai": (13.082700, 80.270700),
    "Kamarajar": (13.330000, 80.330000),
    "Tuticorin": (8.764200, 78.134800),
}

ORIGINS = ["Newcastle","Hay Point","Gladstone","Norfolk","Baltimore","Nacala","Beira","Vostochny","Murmansk","Samarinda","Taboneo"]
DESTINATIONS = ["Paradip","Visakhapatnam","Gangavaram","Gopalpur","Dhamra","Sagar Sandheads","Haldia","Chennai","Kamarajar","Tuticorin"]
ROUTES = [(o, d) for o in ORIGINS for d in DESTINATIONS]


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _bbox(lat: float, lon: float, radius_deg: float = 0.30):
    return [[lat - radius_deg, lon - radius_deg], [lat + radius_deg, lon + radius_deg]]


def _haversine_nm(lat1, lon1, lat2, lon2):
    r_km = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2-lat1)
    dl = math.radians(lon2-lon1)
    a = math.sin(dphi/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    km = 2*r_km*math.asin(math.sqrt(a))
    return km / 1.852


class AISStreamCollector:
    def __init__(self):
        self.api_key = os.environ.get("AISSTREAM_API_KEY", "").strip()
        self.enabled = bool(self.api_key) and websocket is not None
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.last_connect_at: str | None = None
        self.last_message_at: str | None = None
        self.last_error: str | None = None
        # The currently-live websocket, tracked so stop() can force-close
        # it immediately instead of waiting on the in-flight recv() timeout
        # (see stop() for why this matters).
        self._ws: Any = None
        self.messages = 0
        self.positions = 0
        self.static_messages = 0

        # Production persistence: set AIS_DB_CLIENT=mysql and reuse the
        # existing FreightSight MYSQL_* environment variables. SQLite remains
        # available as a local-development fallback.
        configured_client = os.environ.get("AIS_DB_CLIENT", "").strip().lower()
        self.db_client = configured_client or (
            "mysql" if os.environ.get("MYSQL_HOST") else "sqlite"
        )
        if self.db_client not in ("mysql", "sqlite"):
            raise RuntimeError("AIS_DB_CLIENT must be 'mysql' or 'sqlite'")

        self.retention_days = max(1, int(os.environ.get("AIS_RETENTION_DAYS", "30")))

        if self.db_client == "mysql":
            self.mysql_host = os.environ.get("MYSQL_HOST", "").strip()
            self.mysql_port = int(os.environ.get("MYSQL_PORT", "3306"))
            self.mysql_user = os.environ.get("MYSQL_USER", "").strip()
            self.mysql_password = os.environ.get("MYSQL_PASSWORD", "")
            self.mysql_database = os.environ.get("MYSQL_DATABASE", "").strip()
            self.mysql_ssl = os.environ.get("MYSQL_SSL", "false").strip().lower() in (
                "1", "true", "yes", "on"
            )
            self.mysql_ssl_ca = os.environ.get("MYSQL_SSL_CA", "").strip() or None

            if not all((self.mysql_host, self.mysql_user, self.mysql_database)):
                raise RuntimeError(
                    "AIS MySQL persistence is enabled but MYSQL_HOST, MYSQL_USER, "
                    "and MYSQL_DATABASE are not configured."
                )
            try:
                import pymysql  # noqa: F401
            except ImportError as exc:
                raise RuntimeError(
                    "PyMySQL is required for AIS MySQL persistence. "
                    "Install ml-service/requirements.txt."
                ) from exc

        self._init_db()
        self._ensure_schema()

    @contextmanager
    def _connect_db(self):
        """Yield a connection for either MySQL or local SQLite."""
        if self.db_client == "mysql":
            import pymysql

            ssl_args = {}
            if self.mysql_ssl:
                ssl_args["ssl"] = {"ca": self.mysql_ssl_ca} if self.mysql_ssl_ca else {}

            conn = pymysql.connect(
                host=self.mysql_host,
                port=self.mysql_port,
                user=self.mysql_user,
                password=self.mysql_password,
                database=self.mysql_database,
                charset="utf8mb4",
                autocommit=True,
                connect_timeout=10,
                read_timeout=30,
                write_timeout=30,
                **ssl_args,
            )
            try:
                yield conn
                conn.commit()
            finally:
                conn.close()
        else:
            DB_PATH.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(DB_PATH, timeout=30)
            conn.execute("PRAGMA journal_mode=WAL")
            try:
                yield conn
                conn.commit()
            finally:
                conn.close()

    def _query_all(self, sql: str, params=()):
        if self.db_client == "mysql":
            with self._connect_db() as conn:
                with conn.cursor() as cur:
                    cur.execute(sql.replace("?", "%s"), params)
                    return cur.fetchall()
        with self._connect_db() as conn:
            return conn.execute(sql, params).fetchall()

    def _execute(self, sql: str, params=()):
        if self.db_client == "mysql":
            with self._connect_db() as conn:
                with conn.cursor() as cur:
                    cur.execute(sql.replace("?", "%s"), params)
        else:
            with self._connect_db() as conn:
                conn.execute(sql, params)
                conn.commit()

    def _init_db(self):
        if self.db_client == "mysql":
            self._execute("""
            CREATE TABLE IF NOT EXISTS ais_positions (
              id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
              received_at DATETIME(6) NOT NULL,
              ais_timestamp INT NULL,
              mmsi VARCHAR(20) NOT NULL,
              ship_name VARCHAR(255) NULL,
              lat DOUBLE NULL,
              lon DOUBLE NULL,
              sog DOUBLE NULL,
              cog DOUBLE NULL,
              heading DOUBLE NULL,
              nav_status INT NULL,
              port_near VARCHAR(120) NULL,
              port_distance_nm DOUBLE NULL,
              ship_type INT NULL,
              INDEX idx_ais_positions_time (received_at),
              INDEX idx_ais_positions_port (port_near, received_at),
              INDEX idx_ais_positions_mmsi (mmsi, received_at),
              INDEX idx_ais_positions_idle (port_near, sog, received_at),
              INDEX idx_ais_positions_port_distance (port_near, port_distance_nm, received_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            self._execute("""
            CREATE TABLE IF NOT EXISTS ais_static (
              mmsi VARCHAR(20) PRIMARY KEY,
              updated_at DATETIME(6) NOT NULL,
              ship_name VARCHAR(255) NULL,
              ship_type INT NULL,
              imo VARCHAR(20) NULL,
              callsign VARCHAR(32) NULL,
              destination VARCHAR(255) NULL,
              draught_m DOUBLE NULL,
              length_m DOUBLE NULL,
              beam_m DOUBLE NULL,
              INDEX idx_ais_static_updated (updated_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
        else:
            with self._connect_db() as conn:
                conn.executescript("""
                CREATE TABLE IF NOT EXISTS ais_positions (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  received_at TEXT NOT NULL,
                  ais_timestamp INTEGER,
                  mmsi TEXT,
                  ship_name TEXT,
                  lat REAL,
                  lon REAL,
                  sog REAL,
                  cog REAL,
                  heading REAL,
                  nav_status INTEGER,
                  port_near TEXT,
                  port_distance_nm REAL,
                  ship_type INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_ais_positions_time ON ais_positions(received_at);
                CREATE INDEX IF NOT EXISTS idx_ais_positions_port ON ais_positions(port_near, received_at);
                CREATE INDEX IF NOT EXISTS idx_ais_positions_mmsi ON ais_positions(mmsi, received_at);
                CREATE INDEX IF NOT EXISTS idx_ais_positions_idle ON ais_positions(port_near, sog, received_at);
                CREATE TABLE IF NOT EXISTS ais_static (
                  mmsi TEXT PRIMARY KEY,
                  updated_at TEXT NOT NULL,
                  ship_name TEXT,
                  ship_type INTEGER,
                  imo TEXT,
                  callsign TEXT,
                  destination TEXT,
                  draught_m REAL,
                  length_m REAL,
                  beam_m REAL
                );
                """)

    def _ensure_schema(self):
        if self.db_client == "mysql":
            return

        columns = {row[1] for row in self._query_all("PRAGMA table_info(ais_positions)")}
        if "port_distance_nm" not in columns:
            self._execute("ALTER TABLE ais_positions ADD COLUMN port_distance_nm REAL")
        self._execute(
            "CREATE INDEX IF NOT EXISTS idx_ais_positions_port_distance "
            "ON ais_positions(port_near, port_distance_nm, received_at)"
        )

    def _nearest_port(self, lat: float, lon: float) -> tuple[str | None, float | None]:
        """Return (port_name, distance_nm) for the closest PORT_COORDS entry.

        Distances are only meaningful near the tracked ports (we only
        subscribe to bounding boxes around them), but this is safe to call
        for any position: it just returns whichever port is closest.
        """
        nearest_name = None
        nearest_nm = None
        for name, (port_lat, port_lon) in PORT_COORDS.items():
            distance_nm = _haversine_nm(lat, lon, port_lat, port_lon)
            if nearest_nm is None or distance_nm < nearest_nm:
                nearest_name = name
                nearest_nm = distance_nm
        return nearest_name, nearest_nm

    def _save_position(self, event: dict[str, Any]):
        md = event.get("MetaData") or {}
        msg = ((event.get("Message") or {}).get("PositionReport") or {})
        lat = md.get("Latitude", msg.get("Latitude"))
        lon = md.get("Longitude", msg.get("Longitude"))
        mmsi = md.get("MMSI", msg.get("UserID"))
        if lat is None or lon is None or mmsi is None:
            return
        nearest_port, port_distance_nm = self._nearest_port(float(lat), float(lon))
        received_at = _utcnow()
        nav_status = _normalize_nav_status(msg.get("NavigationalStatus"))
        row = (
            received_at.replace(tzinfo=None) if self.db_client == "mysql" else received_at.isoformat(),
            msg.get("Timestamp"), str(mmsi), md.get("ShipName"),
            float(lat), float(lon), msg.get("Sog"), msg.get("Cog"), msg.get("TrueHeading"),
            nav_status, nearest_port, port_distance_nm, None
        )
        self._execute("""INSERT INTO ais_positions
          (received_at,ais_timestamp,mmsi,ship_name,lat,lon,sog,cog,heading,nav_status,port_near,port_distance_nm,ship_type)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", row)
        cutoff = datetime.now(timezone.utc) - timedelta(days=self.retention_days)
        cutoff_value = cutoff.replace(tzinfo=None) if self.db_client == "mysql" else cutoff.isoformat()
        self._execute("DELETE FROM ais_positions WHERE received_at < ?", (cutoff_value,))
        self.positions += 1
        self.last_message_at = _utcnow().isoformat()

    def _save_static(self, event: dict[str, Any]):
        md = event.get("MetaData") or {}
        msg_obj = event.get("Message") or {}
        msg = msg_obj.get("ShipStaticData") or msg_obj.get("StaticDataReport") or {}
        if not msg:
            return
        mmsi = md.get("MMSI") or msg.get("UserID")
        if mmsi is None:
            return
        # AISStream may expose either flat fields or nested dimension fields.
        dim = msg.get("Dimension") or {}
        length = None
        beam = None
        if all(k in dim for k in ("A", "B")):
            length = float(dim.get("A") or 0) + float(dim.get("B") or 0)
        if all(k in dim for k in ("C", "D")):
            beam = float(dim.get("C") or 0) + float(dim.get("D") or 0)
        updated_at = _utcnow()
        row = (
            str(mmsi), updated_at.replace(tzinfo=None) if self.db_client == "mysql" else updated_at.isoformat(),
            md.get("ShipName") or msg.get("Name"),
            msg.get("Type") or msg.get("ShipType"), msg.get("ImoNumber") or msg.get("IMO"),
            msg.get("CallSign") or msg.get("Callsign"), msg.get("Destination"),
            msg.get("MaximumStaticDraught") or msg.get("Draught"), length, beam,
        )
        if self.db_client == "mysql":
            self._execute("""INSERT INTO ais_static
              (mmsi,updated_at,ship_name,ship_type,imo,callsign,destination,draught_m,length_m,beam_m)
              VALUES (?,?,?,?,?,?,?,?,?,?)
              ON DUPLICATE KEY UPDATE
                updated_at=VALUES(updated_at), ship_name=VALUES(ship_name),
                ship_type=VALUES(ship_type), imo=VALUES(imo), callsign=VALUES(callsign),
                destination=VALUES(destination), draught_m=VALUES(draught_m),
                length_m=VALUES(length_m), beam_m=VALUES(beam_m)""", row)
        else:
            self._execute("""INSERT INTO ais_static
              (mmsi,updated_at,ship_name,ship_type,imo,callsign,destination,draught_m,length_m,beam_m)
              VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(mmsi) DO UPDATE SET
                updated_at=excluded.updated_at, ship_name=excluded.ship_name,
                ship_type=excluded.ship_type, imo=excluded.imo, callsign=excluded.callsign,
                destination=excluded.destination, draught_m=excluded.draught_m,
                length_m=excluded.length_m, beam_m=excluded.beam_m""", row)
        self.static_messages += 1
        self.last_message_at = _utcnow().isoformat()

    def _subscription(self):
        # One focused subscription covers all loading/discharge ports.
        boxes = [_bbox(*coords) for coords in PORT_COORDS.values()]
        return {
            "APIKey": self.api_key,
            "BoundingBoxes": boxes,
            "FilterMessageTypes": ["PositionReport", "ShipStaticData", "StaticDataReport"],
        }

    def _loop(self):
        backoff = 2
        while not self.stop_event.is_set():
            ws = None
            try:
                self.last_connect_at = _utcnow().isoformat()
                ws = websocket.create_connection(
                    AIS_URL,
                    timeout=60,
                    enable_multithread=True,
                    skip_utf8_validation=False,
                    compression="deflate",
                )
                ws.settimeout(60)
                ws.send(json.dumps(self._subscription()))
                with self.lock:
                    self._ws = ws
                backoff = 2
                while not self.stop_event.is_set():
                    raw = ws.recv()
                    if raw is None:
                        raise RuntimeError("AISStream connection closed")
                    if isinstance(raw, bytes):
                        raw = raw.decode("utf-8")
                    event = json.loads(raw)
                    self.messages += 1
                    typ = event.get("MessageType")
                    try:
                        if typ == "PositionReport":
                            self._save_position(event)
                        elif typ in ("ShipStaticData", "StaticDataReport"):
                            self._save_static(event)
                    except Exception as exc:
                        self.last_error = f"Message handling error ({typ}): {exc}"
            except Exception as exc:
                self.last_error = str(exc)
                self.stop_event.wait(min(backoff, 60))
                backoff = min(backoff * 2, 60)
            finally:
                with self.lock:
                    if self._ws is ws:
                        self._ws = None
                if ws is not None:
                    try:
                        ws.close()
                    except Exception:
                        pass

    def start(self):
        if not self.enabled:
            return False
        if self.thread and self.thread.is_alive():
            return True
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._loop, name="aisstream-collector", daemon=True)
        self.thread.start()
        return True

    def stop(self):
        self.stop_event.set()
        with self.lock:
            ws = self._ws
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass

    def db_ping(self) -> dict[str, Any]:
        """Run a trivial query against the AIS database and report round-trip time.

        Intended for an external uptime monitor (UptimeRobot, cron-job.org,
        etc.) to hit directly. Unlike /health, this guarantees a real query
        reaches the database on every check — independent of whether the
        AISStream websocket happens to be connected or quiet — which is
        what a free-tier hosted DB (e.g. Aiven) needs to see to avoid being
        auto-powered-off for inactivity.
        """
        started = time.monotonic()
        self._query_all("SELECT 1")
        elapsed_ms = round((time.monotonic() - started) * 1000, 1)
        return {
            "ok": True,
            "database": self.db_client,
            "elapsed_ms": elapsed_ms,
            "checked_at": _utcnow().isoformat(),
        }

    def status(self):
        return {
            "enabled": self.enabled,
            "api_key_configured": bool(self.api_key),
            "websocket_client_available": websocket is not None,
            "running": bool(self.thread and self.thread.is_alive()),
            "database": self.db_client,
            "db_path": str(DB_PATH) if self.db_client == "sqlite" else f"{self.mysql_host}/{self.mysql_database}",
            "last_connect_at": self.last_connect_at,
            "last_message_at": self.last_message_at,
            "last_error": self.last_error,
            "messages": self.messages,
            "position_messages": self.positions,
            "static_messages": self.static_messages,
            "ports_tracked": len(PORT_COORDS),
            "subscription_bounding_boxes": len(PORT_COORDS),
        }

    def _port_stats(self, port: str, cutoff: str):
        rows = self._query_all("""
            SELECT COUNT(*) total_msgs,
                   COUNT(DISTINCT mmsi) unique_vessels,
                   AVG(sog) avg_sog_kn,
                   AVG(CASE WHEN sog <= 3 THEN 1.0 ELSE 0.0 END) low_speed_share
            FROM ais_positions
            WHERE port_near=? AND received_at>=?
        """, (port, cutoff))
        row = rows[0] if rows else (0, 0, None, None)
        ships = self._query_all(
            "SELECT DISTINCT mmsi FROM ais_positions WHERE port_near=? AND received_at>=?",
            (port, cutoff)
        )
        stats = {
            "port": port,
            "ais_messages": int(row[0] or 0),
            "unique_vessels": int(row[1] or 0),
            "avg_sog_kn": round(float(row[2]), 2) if row[2] is not None else None,
            "low_speed_share": round(float(row[3]), 3) if row[3] is not None else None,
            "ship_sample": [str(x[0]) for x in ships[:100]],
        }
        density = min(stats["unique_vessels"] / 20.0, 1.0)
        waiting = stats["low_speed_share"] or 0.0
        stats["congestion_index"] = round(min(1.0, 0.6*density + 0.4*waiting), 3)
        return stats

    def port_congestion(self, port: str, lookback_hours: int = 24):
        """Single-port congestion snapshot (no destination pairing). Used by
        compare-origins, which already fetches the (fixed) destination's
        stats once up front and only needs the per-origin half repeated."""
        if port not in PORT_COORDS:
            raise ValueError(f"Unknown AIS port: {port}")
        cutoff_dt = datetime.now(timezone.utc)-timedelta(hours=max(1, min(168, int(lookback_hours))))
        cutoff = cutoff_dt.replace(tzinfo=None) if self.db_client == "mysql" else cutoff_dt.isoformat()
        return self._port_stats(port, cutoff)

    def route_features(self, origin: str, destination: str, lookback_hours: int = 24):
        if origin not in PORT_COORDS or destination not in PORT_COORDS:
            raise ValueError(f"Unknown AIS route ports: {origin} -> {destination}")
        cutoff_dt = datetime.now(timezone.utc)-timedelta(hours=max(1, min(168, int(lookback_hours))))
        cutoff = cutoff_dt.replace(tzinfo=None) if self.db_client == "mysql" else cutoff_dt.isoformat()
        o = self._port_stats(origin, cutoff)
        d = self._port_stats(destination, cutoff)
        return {
            "lookback_hours": int(lookback_hours),
            "origin": o,
            "destination": d,
            "route_congestion_index": round((o["congestion_index"] + d["congestion_index"]) / 2, 3),
            "source": "AISStream live AIS events persisted by FreightSight",
        }

    def idle_vessels(self, lookback_hours: int = 48, min_idle_hours: float = MIN_IDLE_HOURS,
                     port: str | None = None, limit: int = 50, cargo_only: bool = True):
        """Return AIS-derived idle vessel candidates from persisted history."""
        lookback_hours = max(4, min(168, int(lookback_hours)))
        min_idle_hours = max(1.0, min(72.0, float(min_idle_hours)))
        limit = max(1, min(200, int(limit)))
        cutoff_dt = datetime.now(timezone.utc) - timedelta(hours=lookback_hours)
        cutoff = cutoff_dt.replace(tzinfo=None) if self.db_client == "mysql" else cutoff_dt.isoformat()

        where = ["p.received_at >= ?", "p.lat IS NOT NULL", "p.lon IS NOT NULL"]
        params: list[Any] = [cutoff]
        if port:
            where.append("p.port_near = ?")
            params.append(port)

        rows = self._query_all(f"""
            SELECT p.received_at, p.mmsi, p.ship_name, p.lat, p.lon, p.sog, p.cog,
                   p.heading, p.nav_status, p.port_near, p.port_distance_nm,
                   COALESCE(p.ship_type, s.ship_type) AS effective_ship_type,
                   s.imo, s.destination
            FROM ais_positions p
            LEFT JOIN ais_static s ON s.mmsi = p.mmsi
            WHERE {' AND '.join(where)}
            ORDER BY p.mmsi, p.received_at
        """, params)

        histories: dict[str, list[Observation]] = {}
        vessel_meta: dict[str, dict[str, Any]] = {}
        for row in rows:
            (received_at, mmsi, ship_name, lat, lon, sog, cog, heading, nav_status,
             port_near, port_distance_nm, ship_type, imo, destination) = row
            try:
                ts = datetime.fromisoformat(str(received_at).replace("Z", "+00:00"))
            except ValueError:
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            try:
                observation = Observation(
                    timestamp=ts.astimezone(timezone.utc),
                    lat=float(lat), lon=float(lon),
                    sog=float(sog) if sog is not None else None,
                    cog=float(cog) if cog is not None else None,
                    heading=float(heading) if heading is not None else None,
                    nav_status=int(nav_status) if nav_status is not None else None,
                    port_near=port_near,
                    distance_to_port_nm=float(port_distance_nm) if port_distance_nm is not None else None,
                )
            except (TypeError, ValueError):
                continue
            key = str(mmsi)
            histories.setdefault(key, []).append(observation)
            vessel_meta[key] = {
                "mmsi": key, "ship_name": ship_name, "ship_type": ship_type,
                "imo": imo, "destination": destination
            }

        results = []
        for mmsi, history in histories.items():
            latest_time = history[-1].timestamp
            window_start = latest_time - timedelta(hours=min(72, lookback_hours))
            recent = [item for item in history if item.timestamp >= window_start]
            detected = detect_idle_vessel(recent, vessel=vessel_meta[mmsi])
            if not detected:
                continue
            if detected["idle_duration_hours"] < min_idle_hours:
                continue
            if cargo_only and not detected["bulk_candidate"]:
                continue
            if not detected["idle"]:
                continue
            detected["vessel_category"] = "AIS cargo/bulk candidate" if detected["bulk_candidate"] else "AIS vessel"
            results.append(detected)

        results.sort(key=lambda item: (item["idle_score"], item["idle_duration_hours"]), reverse=True)
        results = results[:limit]
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "lookback_hours": lookback_hours,
            "min_idle_hours": min_idle_hours,
            "port_filter": port,
            "vessels": results,
            "count": len(results),
            "definition": {
                "sog_threshold_kn": 0.5,
                "min_idle_hours": min_idle_hours,
                "position_stability_nm": 0.30,
                "port_radius_nm": PORT_RADIUS_NM,
                "ais_nav_status_support": ["AT_ANCHOR", "MOORED"],
                "charter_availability": "not asserted from AIS alone",
            },
            "source": "AISStream PositionReport + ShipStaticData persisted by FreightSight",
        }


collector = AISStreamCollector()