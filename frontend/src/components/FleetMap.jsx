// Live fleet map — styled as a nautical chart to match the rest of the app
// (paper / ink / vermilion palette) instead of a raw dark-dot scatter:
//   • tinted basemap + lat/lon graticule (still reads as a chart if tiles fail)
//   • vessels drawn as hull arrows that point along their heading, colored by
//     movement, with a soft pulse on ships that are actually under way
//   • ports drawn as anchor roundels with a live vessel-count badge and name
//     labels that appear as you zoom in
//   • paper-styled popups, an in-map legend with live counts and a "live" chip
// It stays a raw observation view: nothing here is a forecast.
import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, Tooltip, Polyline, ZoomControl, ScaleControl, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export const STATUS = {
  underway: { color: "#2b6458", label: "Underway", range: ">3 kn" },
  slow: { color: "#c48a1a", label: "Slow / maneuvering", range: "0.5–3 kn" },
  stopped: { color: "#b44a2e", label: "Stopped / anchored", range: "≤0.5 kn" },
};
const FALLBACK_COLOR = "#7e6c4c";
const INK = "#1c3144";
const PAPER = "#faf5e9";

const VESSEL_PATH = "M12 2.5 L18.5 20.5 L12 16.8 L5.5 20.5 Z"; // hull arrow, points up
const DIAMOND_PATH = "M12 4 L19.5 12 L12 20 L4.5 12 Z"; // moored / no heading

function shipTypeLabel(code) {
  if (code == null) return null;
  if (code >= 70 && code <= 79) return "Cargo";
  if (code >= 80 && code <= 89) return "Tanker";
  if (code >= 60 && code <= 69) return "Passenger";
  if (code === 30) return "Fishing";
  if (code === 31 || code === 32 || code === 52) return "Tug";
  return null;
}

// AIS reports 511 for "heading not available"; fall back to course over ground.
function bearingOf(v) {
  for (const b of [v.heading, v.cog]) {
    if (typeof b === "number" && b >= 0 && b < 360) return Math.round(b);
  }
  return null;
}

const iconCache = new Map();
function vesselIcon(status, bearing) {
  const bucket = bearing == null ? "x" : Math.round(bearing / 5) * 5;
  const key = `${status}|${bucket}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const color = STATUS[status]?.color || FALLBACK_COLOR;
  const useArrow = bearing != null && status !== "stopped";
  const halo = status === "underway" ? '<i class="fs-vessel__halo"></i>' : "";
  const icon = L.divIcon({
    className: "",
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -10],
    html: `<div class="fs-vessel" style="--c:${color}">${halo}<svg viewBox="0 0 24 24" width="26" height="26" style="transform:rotate(${useArrow ? bucket : 0}deg)"><path d="${useArrow ? VESSEL_PATH : DIAMOND_PATH}" fill="${color}" stroke="${PAPER}" stroke-width="1.7" stroke-linejoin="round"/></svg></div>`,
  });
  iconCache.set(key, icon);
  return icon;
}

const portIconCache = new Map();
function portIcon(count) {
  const key = Math.min(count, 99);
  if (portIconCache.has(key)) return portIconCache.get(key);
  const badge = count > 0 ? `<b class="fs-port__count">${count > 99 ? "99+" : count}</b>` : "";
  const icon = L.divIcon({
    className: "",
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -12],
    html: `<div class="fs-port"><svg viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="12" r="10.2" fill="${PAPER}" stroke="${INK}" stroke-width="1.5"/><g transform="translate(6 5.6) scale(.5)" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><line x1="12" x2="12" y1="22" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></g></svg>${badge}</div>`,
  });
  portIconCache.set(key, icon);
  return icon;
}

// Lat/lon graticule every 10° — the "chart paper" grid. Built once.
const GRATICULE = (() => {
  const lines = [];
  for (let lat = -60; lat <= 80; lat += 10) lines.push([[lat, -180], [lat, 180]]);
  for (let lon = -180; lon <= 180; lon += 10) lines.push([[-85, lon], [85, lon]]);
  return lines;
})();

function MapSetup() {
  const map = useMap();
  useEffect(() => {
    // A blank Leaflet map is usually a 0-size container at first measure
    // (e.g. mid fade-in) — re-measure a beat after mount.
    const t1 = setTimeout(() => map.invalidateSize(), 100);
    const t2 = setTimeout(() => map.invalidateSize(), 500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [map]);
  return null;
}

function ZoomWatcher({ onZoom }) {
  const map = useMapEvents({ zoomend: () => onZoom(map.getZoom()) });
  useEffect(() => { onZoom(map.getZoom()); }, [map, onZoom]);
  return null;
}

// Frame every tracked port on first load; fly to a port when one is picked
// in the filter; frame everything again when the filter is cleared.
function MapFocus({ ports, portFilter }) {
  const map = useMap();
  const first = useRef(true);
  useEffect(() => {
    if (!ports.length) return;
    if (portFilter) {
      const p = ports.find((x) => x.name === portFilter);
      if (p) map.flyTo([p.lat, p.lon], 8, { duration: 0.9 });
      return;
    }
    map.fitBounds(L.latLngBounds(ports.map((p) => [p.lat, p.lon])), {
      padding: [40, 40],
      maxZoom: 4,
      animate: !first.current,
    });
    first.current = false;
  }, [ports, portFilter, map]);
  return null;
}

function LegendShape({ status }) {
  const color = STATUS[status].color;
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d={status === "stopped" ? DIAMOND_PATH : VESSEL_PATH} fill={color} stroke={PAPER} strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

export default function FleetMap({ ports, vessels, portFilter, generatedAt, loading }) {
  const [zoom, setZoom] = useState(3);
  const showLabels = zoom >= 5;
  // Zoomed far out, ships in a port's approach overlap the port marker into a
  // blob, so the port's count badge stands in for them; open-water ships
  // (no port nearby) always show.
  const vesselsAreClose = zoom >= 5;

  const countsByPort = useMemo(() => {
    const m = {};
    for (const v of vessels) if (v.port_near) m[v.port_near] = (m[v.port_near] || 0) + 1;
    return m;
  }, [vessels]);

  const statusCounts = useMemo(() => {
    const c = { underway: 0, slow: 0, stopped: 0 };
    for (const v of vessels) if (c[v.status] != null) c[v.status] += 1;
    return c;
  }, [vessels]);

  const updated = generatedAt ? new Date(generatedAt).toLocaleTimeString() : null;

  return (
    <div className="fleet-map h-[560px] w-full">
      <MapContainer
        center={[10, 90]}
        zoom={3}
        minZoom={2}
        maxBounds={[[-85, -200], [85, 200]]}
        maxBoundsViscosity={0.8}
        zoomControl={false}
        scrollWheelZoom
        className="h-full w-full"
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          subdomains="abc"
          maxZoom={19}
          errorTileUrl="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        />
        {zoom <= 5 && (
          <Polyline positions={GRATICULE} pathOptions={{ color: "#7e6c4c", weight: 0.7, opacity: 0.3, dashArray: "2 6", interactive: false }} />
        )}

        <ZoomControl position="topright" />
        <ScaleControl position="bottomright" imperial={false} />
        <MapSetup />
        <ZoomWatcher onZoom={setZoom} />
        <MapFocus ports={ports} portFilter={portFilter} />

        {ports.map((p) => {
          const n = countsByPort[p.name] || 0;
          return (
            <Marker key={p.name} position={[p.lat, p.lon]} icon={portIcon(n)} zIndexOffset={200}>
              <Tooltip
                key={showLabels ? "label" : "hover"}
                permanent={showLabels}
                direction="right"
                offset={[13, 0]}
                opacity={1}
                className="fs-port-label"
              >
                {showLabels ? p.name : `${p.name} · ${n} vessel${n === 1 ? "" : "s"}`}
              </Tooltip>
            </Marker>
          );
        })}

        {vessels.filter((v) => vesselsAreClose || !v.port_near).map((v) => {
          const bearing = bearingOf(v);
          const st = STATUS[v.status];
          const type = shipTypeLabel(v.ship_type);
          return (
            <Marker key={v.mmsi} position={[v.lat, v.lon]} icon={vesselIcon(v.status, bearing)} zIndexOffset={v.status === "underway" ? 400 : 300}>
              <Popup className="fs-popup" closeButton={false}>
                <div className="fs-popup__body">
                  <div className="fs-popup__name">{v.ship_name || "Unnamed vessel"}</div>
                  <div className="fs-popup__sub">MMSI {v.mmsi}{type ? ` · ${type}` : ""}</div>
                  <div className="fs-popup__status" style={{ "--c": st?.color || FALLBACK_COLOR }}>
                    <i />{st?.label || v.status}
                  </div>
                  <dl className="fs-popup__grid">
                    <dt>Speed</dt><dd>{v.sog_kn != null ? `${v.sog_kn.toFixed(1)} kn` : "unknown"}</dd>
                    <dt>Heading</dt><dd>{bearing != null ? `${String(bearing).padStart(3, "0")}°` : "—"}</dd>
                    <dt>Near</dt>
                    <dd>{v.port_near || "open water"}{v.port_distance_nm != null ? ` · ${v.port_distance_nm.toFixed(1)} nm` : ""}</dd>
                    {v.destination && (<><dt>Bound for</dt><dd>{v.destination}</dd></>)}
                  </dl>
                  {v.received_at && <div className="fs-popup__time">reported {new Date(v.received_at).toLocaleString()}</div>}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      {/* In-map overlays */}
      <div className="fleet-map__chip">
        <span className={`fleet-map__pulse ${loading ? "is-loading" : ""}`} />
        live · {updated || "waiting for data"}
      </div>

      <div className="fleet-map__legend">
        <div className="fleet-map__legend-title">chart key</div>
        <div className="fleet-map__legend-row">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="9.6" fill={PAPER} stroke={INK} strokeWidth="1.6" /><circle cx="12" cy="12" r="2.6" fill={INK} /></svg>
          <span>Tracked port</span><b>{ports.length}</b>
        </div>
        {Object.entries(STATUS).map(([key, s]) => (
          <div className="fleet-map__legend-row" key={key}>
            <LegendShape status={key} />
            <span>{s.label} <em>{s.range}</em></span><b>{statusCounts[key]}</b>
          </div>
        ))}
        <div className="fleet-map__legend-foot">{vesselsAreClose ? "Arrows point along heading · badge = vessels near port" : "Badge = vessels near port · zoom in to see each vessel"}</div>
      </div>
    </div>
  );
}
