// frontend/src/components/ui/RouteMap.jsx
// Bridge-console route map: dark basemap, AIS-style glow markers for the
// origin and destination port, and an animated dashed course line between
// them — same visual style as the landing page's RouteVisual, but
// grounded on a real map.
//
// NOTE on tiles: CARTO retired free/keyless access to basemaps.cartocdn.com
// (raster tiles now require an API key), so this uses the standard,
// keyless OpenStreetMap tile server and darkens it with a CSS filter
// (see .route-map-dark-tiles in index.css) instead of relying on a paid
// "dark matter" style. If tiles ever fail to load for another reason
// (offline, blocked domain, etc.) the map falls back to a plain dark
// background with an inline notice instead of a silent black square.
import { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  CircleMarker,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { getPortCoords } from "../../data/portCoordinates.js";
import { buildSeaRoute } from "../../data/seaRoutes.js";

function portIcon(color) {
  return L.divIcon({
    className: "",
    html: `
      <span class="relative flex h-4 w-4">
        <span class="absolute inline-flex h-full w-full animate-ping-slow rounded-full" style="background:${color}"></span>
        <span class="relative inline-flex h-4 w-4 rounded-full border-2" style="background:${color};border-color:#0F1620"></span>
      </span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

const ORIGIN_ICON = portIcon("#7CF0E4");
const DEST_ICON = portIcon("#FFB020");

// Build a maritime corridor using known sea lanes and chokepoints instead of
// drawing a straight/geometric line between the two ports.

function FitBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (points.length >= 2) {
      map.fitBounds(L.latLngBounds(points), { padding: [36, 36] });
    } else if (points.length === 1) {
      map.setView(points[0], 5);
    }
    // A common cause of a blank/black Leaflet map in React is the container
    // having size 0 (or a stale size) at the moment Leaflet first measures
    // it — e.g. it mounted while a parent was mid fade/slide-in animation.
    // Re-measuring a beat after mount (and once more after animations that
    // touch this card have had time to finish) fixes tiles that "never
    // showed up" without needing a manual window resize.
    const t1 = setTimeout(() => map.invalidateSize(), 100);
    const t2 = setTimeout(() => map.invalidateSize(), 500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, points[0]?.[0], points[0]?.[1], points[1]?.[0], points[1]?.[1]]);
  return null;
}

// Tracks whether the basemap tiles actually loaded so we can show a small
// fallback notice instead of a silent black square if every tile request
// fails (e.g. no internet access, or the tile domain is blocked).
function TileStatus({ onStatusChange }) {
  const [loadedAny, setLoadedAny] = useState(false);
  const errorCountRef = useRef(0);
  const erroredAllRef = useRef(false);

  useMapEvents({
    tileload: () => {
      if (!loadedAny) {
        setLoadedAny(true);
        onStatusChange?.("ok");
      }
    },
    tileerror: () => {
      errorCountRef.current += 1;
      // Only flag a hard failure once we've seen a handful of errors and
      // zero successful loads — a couple of individual tile 404s at map
      // edges are normal and shouldn't trigger the fallback notice.
      if (!loadedAny && errorCountRef.current > 4 && !erroredAllRef.current) {
        erroredAllRef.current = true;
        onStatusChange?.("error");
      }
    },
  });

  return null;
}

export default function RouteMap({ origin, destination, className }) {
  const [tileStatus, setTileStatus] = useState("loading"); // loading | ok | error
  const originCoords = getPortCoords(origin);
  const destCoords = getPortCoords(destination);

  if (!originCoords && !destCoords) return null;

  const endpointPoints = [originCoords, destCoords].filter(Boolean).map((p) => [p.lat, p.lng]);
  const path = originCoords && destCoords
    ? buildSeaRoute(origin, destination, originCoords, destCoords)
    : null;
  const boundsPoints = path?.length ? path : endpointPoints;

  return (
    <div className={className} style={{ position: "relative" }}>
      <MapContainer
        center={endpointPoints[0]}
        zoom={4}
        scrollWheelZoom={false}
        zoomControl={false}
        attributionControl={true}
        className="h-full w-full"
        style={{ background: "#070B12" }}
      >
        <TileLayer
          className="route-map-dark-tiles"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          subdomains="abc"
          maxZoom={19}
          // 1x1 transparent PNG — avoids the browser's broken-image icon
          // flashing over every tile that 404s while the rest load.
          errorTileUrl="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        />

        {path && (
          <>
            <Polyline
              positions={path}
              pathOptions={{
                color: "#22D3C4",
                weight: 3,
                opacity: 0.92,
                dashArray: "8 8",
                className: "route-course-line",
              }}
            />
            {path.slice(1, -1).map((point, index) => (
              <CircleMarker
                key={`waypoint-${index}`}
                center={point}
                radius={2.5}
                pathOptions={{
                  color: "#22D3C4",
                  weight: 1,
                  fillColor: "#22D3C4",
                  fillOpacity: 0.75,
                }}
              />
            ))}
          </>
        )}

        {originCoords && (
          <Marker position={[originCoords.lat, originCoords.lng]} icon={ORIGIN_ICON}>
            <Tooltip direction="top" offset={[0, -6]} opacity={1} className="route-map-tooltip">
              {origin} · load port
            </Tooltip>
          </Marker>
        )}
        {destCoords && (
          <Marker position={[destCoords.lat, destCoords.lng]} icon={DEST_ICON}>
            <Tooltip direction="top" offset={[0, -6]} opacity={1} className="route-map-tooltip">
              {destination} · discharge port
            </Tooltip>
          </Marker>
        )}

        <FitBounds points={boundsPoints} />
        <TileStatus onStatusChange={setTileStatus} />
      </MapContainer>

      {tileStatus === "error" && (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded-lg border border-amber/30 bg-hull-900/90 px-3 py-2 font-mono text-[0.68rem] text-amber backdrop-blur-sm">
          Map tiles failed to load (check network access to tile.openstreetmap.org) — maritime corridor and
          ports above are still visible.
        </div>
      )}
    </div>
  );
}

