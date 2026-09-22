import { Inbox } from "lucide-react";
import { Card } from "./ui/card.jsx";
import { Badge } from "./ui/badge.jsx";

const RISK_VARIANT = { low: "low", medium: "medium", high: "high" };

export default function HistoryTable({ rows }) {
  const columns = [
    "Date",
    "Commodity",
    "Route",
    "Mode",
    "Cargo (t)",
    "Forecast",
    "Risk",
    "Vessel",
    "Charter window",
  ];

  if (!Array.isArray(rows) || rows.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-3 p-12 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-hull-700/70 text-slate-500">
          <Inbox className="h-5 w-5" />
        </span>
        <p className="text-sm text-slate-400">{"No forecasts yet — run one from the Predict page."}</p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead>
            <tr className="bg-hull-900/60">
              {columns.map((h) => (
                <th
                  key={h}
                  className="whitespace-nowrap border-b border-hull-600/70 px-4 py-3 text-left font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-slate-500"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.result_id} className="border-b border-hull-600/50 transition-colors last:border-none hover:bg-signal/[0.04]">
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-400">
                  {new Date(r.shipment_date).toLocaleDateString("en-CA")}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-paper-100">{r.commodity}</td>
                <td className="whitespace-nowrap px-4 py-3 text-paper-100">{r.route}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-400">{r.shipment_mode}</td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-400">
                  {Number(r.cargo_weight_tons).toLocaleString()}
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs font-semibold text-signal">
                  ${Number(r.predicted_freight_rate_usd_per_ton).toFixed(2)}/t
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <Badge variant={RISK_VARIANT[r.risk_label] || "neutral"}>{r.risk_label?.toUpperCase()}</Badge>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-400">{r.recommended_vessel_type}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-400">{r.recommended_charter_window}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
