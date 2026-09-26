// Calibration / Backtest — "here's how our past forecasts compared to
// actual market rates". Renders GET /api/calibration/summary, which
// reshapes the held-out test-set metrics already computed when the
// route-freight model was trained (route_freight_model.py's walk-forward
// split) into a lane-level chart: model error vs. a naive-persistence
// baseline's error, on data neither ever trained on.
import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Loader2, Info, TrendingDown } from "lucide-react";
import api from "../api/client.js";
import { Card, CardContent } from "../components/ui/card.jsx";

const INK = "rgb(28 49 68)";
const INKSOFT = "rgb(92 116 136)";
const RULE = "rgb(126 108 76)";
const VERMILION = "rgb(180 74 46)";
const KELP = "rgb(43 100 88)";

const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(d));

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const model = payload.find((p) => p.dataKey === "mae_usd_per_t");
  const naive = payload.find((p) => p.dataKey === "naive_mae_usd_per_t");
  const row = payload[0]?.payload;
  return (
    <div className="border border-rule/60 bg-paper px-3 py-2 shadow-md">
      <div className="fs-kicker">{label}</div>
      {model && <div className="mt-1 text-sm text-ink">Model MAE: <span className="tabular-nums font-semibold">${fmt(model.value)}/t</span></div>}
      {naive && <div className="text-sm text-inksoft">Naive baseline MAE: <span className="tabular-nums">${fmt(naive.value)}/t</span></div>}
      {row && <div className="mt-1 text-xs text-inksoft">{row.improvement_pct}% lower error · {row.test_rows} held-out observations</div>}
    </div>
  );
}

export default function Calibration() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get("/calibration/summary", { params: { horizon: "1", limit: 20 } })
      .then(({ data: res }) => { if (!cancelled) setData(res); })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || "Could not load the calibration summary."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const chartData = (data?.lanes || []).map((l) => ({
    lane: `${l.origin_port} → ${l.destination_port}`,
    mae_usd_per_t: l.mae_usd_per_t,
    naive_mae_usd_per_t: l.naive_mae_usd_per_t,
    improvement_pct: l.improvement_pct,
    test_rows: l.test_rows,
  }));

  return (
    <section className="mx-auto max-w-[1240px] px-5 py-10 lg:px-8">
      <div className="fs-kicker">Model validation</div>
      <h1 className="mt-1 font-display text-4xl font-semibold tracking-[-0.02em] text-ink">
        How well have our forecasts actually done?
      </h1>
      <p className="mt-2 max-w-3xl text-sm text-inksoft">
        For every lane the model was trained on, a slice of historical observations was held back and never shown to
        the model. This is the model's error on that held-back data — a genuine out-of-sample backtest — next to a
        naive baseline (predict next month = last observed rate) on the same held-back rows, so "better than random"
        has a number attached to it.
      </p>

      {loading && (
        <div className="mt-8 flex items-center gap-3 text-sm text-inksoft"><Loader2 className="h-4 w-4 animate-spin" /> Loading calibration data…</div>
      )}
      {error && <div role="alert" className="mt-8 border border-vermilion/40 bg-vermilion/5 p-3 text-sm text-vermilion">{error}</div>}

      {data?.status === "unavailable" && (
        <div className="mt-8 border border-brass/40 bg-brass/5 p-4 text-sm text-ink">{data.reason}</div>
      )}

      {data?.status === "ok" && (
        <div className="mt-8 flex flex-col gap-6">
          {data.overall && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Card><CardContent className="pt-5">
                <div className="fs-kicker">Lanes evaluated</div>
                <div className="mt-1 font-display text-2xl font-semibold text-ink">{data.overall.lanes_evaluated}</div>
              </CardContent></Card>
              <Card><CardContent className="pt-5">
                <div className="fs-kicker">Avg. held-out error</div>
                <div className="mt-1 font-display text-2xl font-semibold text-ink">${fmt(data.overall.avg_mae_usd_per_t)}/t</div>
              </CardContent></Card>
              <Card><CardContent className="pt-5">
                <div className="fs-kicker">vs. naive baseline</div>
                <div className="mt-1 flex items-center gap-1.5 font-display text-2xl font-semibold text-kelp">
                  <TrendingDown className="h-5 w-5" /> {fmt(data.overall.avg_improvement_pct, 1)}%
                </div>
              </CardContent></Card>
              <Card><CardContent className="pt-5">
                <div className="fs-kicker">Beat the baseline</div>
                <div className="mt-1 font-display text-2xl font-semibold text-ink">{data.overall.lanes_beating_naive_baseline}/{data.overall.lanes_evaluated}</div>
              </CardContent></Card>
            </div>
          )}

          <Card>
            <CardContent className="pt-5">
              <div className="fs-kicker">Held-out forecast error, {data.lanes_available} lanes (top {data.lanes.length} by test volume)</div>
              <h3 className="mt-1 font-display text-xl font-semibold text-ink">Model vs. naive baseline — $ /t mean absolute error</h3>
              <div className="mt-5">
                <ResponsiveContainer width="100%" height={Math.max(320, chartData.length * 34)}>
                  <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
                    <CartesianGrid stroke={RULE} strokeOpacity={0.18} horizontal={false} />
                    <XAxis type="number" tickFormatter={(v) => `$${v}`} tick={{ fill: INKSOFT, fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" }} axisLine={{ stroke: RULE }} tickLine={false} />
                    <YAxis type="category" dataKey="lane" width={190} tick={{ fill: INK, fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" }} axisLine={{ stroke: RULE }} tickLine={false} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: RULE, fillOpacity: 0.08 }} />
                    <Legend
                      formatter={(v) => (v === "mae_usd_per_t" ? "Model (held-out)" : "Naive baseline (held-out)")}
                      wrapperStyle={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.12em", color: INKSOFT }}
                    />
                    <Bar dataKey="naive_mae_usd_per_t" fill={RULE} fillOpacity={0.35} radius={[0, 2, 2, 0]} />
                    <Bar dataKey="mae_usd_per_t" fill={VERMILION} radius={[0, 2, 2, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <details className="border border-rule/60 bg-paper/40 p-4 text-xs text-inksoft">
            <summary className="flex cursor-pointer items-center gap-1.5"><Info className="h-3.5 w-3.5" /> How this is computed, and what it does not claim</summary>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5">
              <li>{data.note}</li>
              <li>Horizon: {data.horizon_months === 1 ? "1 month ahead" : `${data.horizon_months} months ahead`} — the forecast closest to what a near-dated shipment actually sees.</li>
              <li>Training data mode: {data.data_mode || "unknown"}. See the Predict page's provenance labels for what this means for a given forecast.</li>
              <li>This is training-time evaluation, not a live re-run against today's market — it updates only when the model is retrained.</li>
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
