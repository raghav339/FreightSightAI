// Port Disruption Radar card: one port's live AIS congestion assessment.
//
// Shows the evidence rather than just a verdict: "Normal vs Now" numbers, which
// signals tripped, how much AIS data the numbers rest on, and what it means for
// a freight decision. The rules behind it are in ml-service/app/port_radar.py.
import { AlertTriangle, ArrowDown, ArrowUp, Check, Info, Minus } from "lucide-react";
import { Badge } from "./ui/badge.jsx";
import { Card, CardContent } from "./ui/card.jsx";
import { cn } from "../lib/utils.js";

export const STATUS_ORDER = ["NORMAL", "WATCH", "ELEVATED", "CRITICAL"];

export const STATUS_STYLE = {
  NORMAL: { label: "Normal", badge: "low", bar: "bg-kelp", text: "text-kelp" },
  WATCH: { label: "Watch", badge: "medium", bar: "bg-brass", text: "text-brass" },
  ELEVATED: { label: "Elevated", badge: "high", bar: "bg-vermilion/70", text: "text-vermilion" },
  CRITICAL: { label: "Critical", badge: "high", bar: "bg-vermilion", text: "text-vermilion" },
  INSUFFICIENT_DATA: { label: "Insufficient data", badge: "neutral", bar: "bg-rule", text: "text-inksoft" },
};

export function statusStyle(status) {
  return STATUS_STYLE[status] || STATUS_STYLE.INSUFFICIENT_DATA;
}

function num(v, unit) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  const text = unit === "kn" ? n.toFixed(1) : Number.isInteger(n) ? String(n) : n.toFixed(1);
  return unit === "kn" ? `${text} kn` : text;
}

function Change({ pct, flagged }) {
  if (pct === null || pct === undefined) return <span className="text-inksoft">—</span>;
  if (Math.round(pct) === 0) return <span className="inline-flex items-center gap-1 text-inksoft"><Minus className="h-3 w-3" />0%</span>;
  const Icon = pct > 0 ? ArrowUp : ArrowDown;
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", flagged ? "text-vermilion" : "text-inksoft")}>
      <Icon className="h-3 w-3" />
      {Math.abs(Math.round(pct))}%
    </span>
  );
}

const ROWS = [
  { key: "seen", label: "Vessels nearby" },
  { key: "waiting", label: "Waiting at anchor" },
  { key: "speed", label: "Avg speed, under way" },
  { key: "moored", label: "At berth" },
];

function evidenceLine(e, label) {
  const now = num(e.now, e.unit);
  const base = num(e.baseline, e.unit);
  const pct = e.change_pct === null || e.change_pct === undefined ? "" : ` (${e.change_pct > 0 ? "+" : ""}${Math.round(e.change_pct)}%)`;
  return `${label}: ${now} now against ${base} normally${pct}`;
}

export function StatusScale({ status }) {
  const idx = STATUS_ORDER.indexOf(status);
  return (
    <div aria-label={`Port status scale, currently ${statusStyle(status).label}`}>
      <div className="flex gap-1">
        {STATUS_ORDER.map((s, i) => (
          <div key={s} className={cn("h-1.5 flex-1", statusStyle(s).bar, idx === -1 || i > idx ? "opacity-25" : "opacity-100")} />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[9px] uppercase tracking-[0.15em] text-inksoft">
        {STATUS_ORDER.map((s) => (
          <span key={s} className={cn(s === status && cn("font-semibold", statusStyle(s).text))}>{statusStyle(s).label}</span>
        ))}
      </div>
    </div>
  );
}

export default function PortRadarCard({ radar, actions = null, className = "" }) {
  if (!radar) return null;
  const st = statusStyle(radar.status);
  const insufficient = radar.status === "INSUFFICIENT_DATA";
  const evByKey = Object.fromEntries((radar.evidence || []).map((e) => [e.key, e]));
  const flagged = (radar.evidence || []).filter((e) => e.flagged);
  const base = radar.baseline || {};
  const now = radar.now || {};

  return (
    <Card className={className}>
      <CardContent className="flex flex-col gap-6 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="fs-kicker">Port disruption radar</div>
            <h3 className="mt-1 font-display text-3xl font-semibold tracking-[-0.02em] text-ink">{radar.port}</h3>
            <p className="mt-1 text-xs text-inksoft">
              Last {radar.window_hours} h of live AIS against the same hours on previous days
            </p>
          </div>
          <Badge variant={st.badge} className="text-[11px]">{st.label}</Badge>
        </div>

        {insufficient ? (
          <div className="flex items-start gap-3 border border-rule/60 bg-paper/60 p-4 text-sm text-inksoft">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium text-ink">Not enough AIS evidence to judge this port</div>
              <p className="mt-1">{radar.insufficient_reason}</p>
              <p className="mt-2 text-xs">The radar reports this rather than guessing. Nothing here should be read as "normal".</p>
            </div>
          </div>
        ) : (
          <StatusScale status={radar.status} />
        )}

        <div>
          <div className="mb-2 fs-kicker">Normal vs now</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b border-rule/60 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-inksoft">
                  <th className="py-2 pr-3 font-medium">Signal</th>
                  <th className="px-3 py-2 text-right font-medium">Normal</th>
                  <th className="px-3 py-2 text-right font-medium">Now</th>
                  <th className="py-2 pl-3 text-right font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => {
                  const e = evByKey[r.key] || {};
                  return (
                    <tr key={r.key} className="border-b border-rule/30">
                      <td className="py-2 pr-3 text-ink">{r.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-inksoft">{num(e.baseline, e.unit)}</td>
                      <td className={cn("px-3 py-2 text-right font-medium tabular-nums", e.flagged ? "text-vermilion" : "text-ink")}>{num(e.now, e.unit)}</td>
                      <td className="py-2 pl-3 text-right tabular-nums"><Change pct={e.change_pct} flagged={e.flagged} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {!insufficient && (
          <div>
            <div className="mb-2 fs-kicker">Why is {radar.port} {flagged.length ? "flagged" : "not flagged"}?</div>
            {flagged.length ? (
              <ul className="flex flex-col gap-1.5 text-sm text-ink">
                {flagged.map((e) => (
                  <li key={e.key} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-vermilion" />
                    <span>{evidenceLine(e, ROWS.find((r) => r.key === e.key)?.label || e.label)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-inksoft">No signal is meaningfully above its normal range.</p>
            )}
          </div>
        )}

        {radar.impact && (
          <div className={cn("border p-4", radar.status === "NORMAL" ? "border-rule/60 bg-paper/50" : "border-vermilion/40 bg-vermilion/5")}>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.17em] text-inksoft">
              {radar.status !== "NORMAL" && <AlertTriangle className="h-3.5 w-3.5 text-vermilion" />}
              Operational impact
            </div>
            <div className="mt-2 text-sm text-ink">
              Turnaround pressure: <strong className="font-semibold capitalize">{radar.impact.turnaround_pressure}</strong>
              {radar.impact.planning_assumption_days > 0 && (
                <> · suggested planning allowance <strong className="font-semibold">+{radar.impact.planning_assumption_days} day{radar.impact.planning_assumption_days === 1 ? "" : "s"}</strong></>
              )}
            </div>
            <p className="mt-1 text-sm text-inksoft">{radar.impact.recommendation}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-inksoft">{radar.impact.assumption_note}</p>
          </div>
        )}

        {actions && <div className="flex flex-wrap gap-3">{actions}</div>}

        <div className="flex flex-col gap-1 border-t border-rule/50 pt-3 text-[11px] leading-relaxed text-inksoft">
          <div>
            <strong className="font-medium text-ink">Data coverage: {radar.confidence?.label || "—"}</strong>
            {radar.confidence?.score != null && ` (${radar.confidence.score}/100)`} ·{" "}
            {base.windows_used ?? 0} of {base.windows_requested ?? "—"} baseline days usable · {now.messages ?? 0} AIS messages in the window
          </div>
          <div title={radar.confidence?.basis}>Coverage measures how much evidence the numbers rest on, not the chance the assessment is right.</div>
          {radar.db_client === "sqlite" && <div className="text-brass">Local development database. Figures may be simulated.</div>}
        </div>
      </CardContent>
    </Card>
  );
}
