// Substitution map: the failed port in the middle of the picture, with a line
// to every candidate port. Line colour / node style shows the verdict
// (primary, backup, viable, not viable). Positions are a plain lat/lon
// projection scaled to the ports involved, so it needs no map tiles.
import { useMemo } from "react";
import { cn } from "../lib/utils.js";

const W = 640;
const H = 380;
const PAD = 48;

const ROLE = {
  primary: { stroke: "rgb(var(--c-kelp))", fill: "rgb(var(--c-kelp))", width: 2.6, dash: "" },
  backup: { stroke: "rgb(var(--c-brass))", fill: "rgb(var(--c-brass))", width: 1.8, dash: "" },
  viable: { stroke: "rgb(var(--c-ink-soft))", fill: "rgb(var(--c-ink-soft))", width: 1.1, dash: "" },
  not_viable: { stroke: "rgb(var(--c-vermilion))", fill: "none", width: 1, dash: "3 4" },
};

function project(nodes) {
  const pts = nodes.filter((n) => n.lat != null && n.lon != null);
  if (!pts.length) return {};
  const midLat = pts.reduce((a, n) => a + n.lat, 0) / pts.length;
  const k = Math.cos((midLat * Math.PI) / 180);
  const xs = pts.map((n) => n.lon * k);
  const ys = pts.map((n) => n.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 0.5);
  const scale = Math.min((W - 2 * PAD) / span, (H - 2 * PAD) / span);
  const offX = (W - (maxX - minX) * scale) / 2;
  const offY = (H - (maxY - minY) * scale) / 2;
  const out = {};
  pts.forEach((n) => {
    out[n.port] = { x: offX + (n.lon * k - minX) * scale, y: offY + (maxY - n.lat) * scale };
  });
  return out;
}

export default function SubstitutionMap({ map, selected, onSelect, className }) {
  const pos = useMemo(() => project(map?.nodes || []), [map]);
  const failed = (map?.nodes || []).find((n) => n.role === "failed");
  if (!failed || !pos[failed.port]) return null;

  // Nudge labels apart when ports sit almost on top of each other
  // (e.g. Visakhapatnam and Gangavaram are a few nm apart).
  const labelY = {};
  const placed = [];
  [...(map.nodes || [])]
    .filter((n) => pos[n.port])
    .sort((a, b) => pos[a.port].y - pos[b.port].y)
    .forEach((n) => {
      let y = pos[n.port].y + 4;
      while (placed.some((p) => Math.abs(p.y - y) < 13 && Math.abs(p.x - pos[n.port].x) < 110)) y += 13;
      placed.push({ x: pos[n.port].x, y });
      labelY[n.port] = y;
    });

  const fp = pos[failed.port];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn("w-full border border-rule/60 bg-paper/50", className)} role="img"
      aria-label={`Substitution map: alternatives if ${failed.port} becomes unavailable`}>
      {(map.edges || []).map((e) => {
        const to = pos[e.to];
        if (!to) return null;
        const r = ROLE[e.role] || ROLE.viable;
        const on = selected === e.to;
        return (
          <line key={e.to} x1={fp.x} y1={fp.y} x2={to.x} y2={to.y} stroke={r.stroke}
            strokeWidth={on ? r.width + 1.4 : r.width} strokeDasharray={r.dash} opacity={on || !selected ? 0.95 : 0.4} />
        );
      })}
      {(map.nodes || []).filter((n) => n.role !== "failed" && pos[n.port]).map((n) => {
        const r = ROLE[n.role] || ROLE.viable;
        const { x, y } = pos[n.port];
        return (
          <g key={n.port} className="cursor-pointer" onClick={() => onSelect?.(n.port)}>
            <circle cx={x} cy={y} r={9} fill={r.fill} stroke={r.stroke} strokeWidth={1.5} strokeDasharray={r.dash} opacity={n.role === "not_viable" ? 0.6 : 1} />
            {n.rank != null && <text x={x} y={y + 3.5} textAnchor="middle" fontSize="10" fontWeight="600" fill="#fff">{n.rank}</text>}
            <text x={x + 14} y={labelY[n.port]} fontSize="11" fill="rgb(var(--c-ink))" opacity={n.role === "not_viable" ? 0.55 : 1}>{n.port}</text>
          </g>
        );
      })}
      <g>
        <circle cx={fp.x} cy={fp.y} r={11} fill="rgb(var(--c-vermilion))" />
        <path d={`M${fp.x - 5} ${fp.y - 5}L${fp.x + 5} ${fp.y + 5}M${fp.x + 5} ${fp.y - 5}L${fp.x - 5} ${fp.y + 5}`} stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        <text x={fp.x + 16} y={labelY[failed.port]} fontSize="12" fontWeight="600" fill="rgb(var(--c-vermilion))">{failed.port}</text>
      </g>
      <g fontSize="10" fill="rgb(var(--c-ink))" opacity="0.75">
        {[["primary", "Primary"], ["backup", "Backup"], ["viable", "Viable"], ["not_viable", "Not viable"]].map(([k, label], i) => (
          <g key={k} transform={`translate(${12 + i * 96}, ${H - 14})`}>
            <line x1="0" y1="-3" x2="18" y2="-3" stroke={ROLE[k].stroke} strokeWidth={ROLE[k].width} strokeDasharray={ROLE[k].dash} />
            <text x="24" y="0">{label}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
