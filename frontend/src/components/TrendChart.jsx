import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { motion } from "framer-motion";
import { LineChart as LineChartIcon } from "lucide-react";
import api from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card.jsx";
import { isRouteBasedForecast } from "../lib/forecastType.js";

function ChartTooltip({ active, payload, label, unitLabel }) {
  if (!active || !payload?.length) return null;
  const point = payload[0];
  return (
    <div className="rounded-lg border border-hull-500 bg-hull-800/95 px-3 py-2 shadow-glow backdrop-blur-sm">
      <div className="font-mono text-[0.7rem] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-0.5 font-display text-sm font-semibold text-signal">
        {Number(point.value).toFixed(2)}
        <span className="ml-1.5 font-body text-xs font-normal text-slate-400">
          {point.payload?.isForecast ? `${unitLabel} Forecast` : unitLabel}
        </span>
      </div>
    </div>
  );
}

export default function TrendChart({
  points,
  originPort,
  destinationPort,
  forecastType,
  routeHistory,
  forecastCurve,
}) {
  const [bdryHistory, setBdryHistory] = useState([]);
  const routeMode = isRouteBasedForecast(forecastType);

  useEffect(() => {
    // The BDRY 12-month history is only needed when we're actually going
    // to render the BDRY chart — skip the fetch entirely in route mode so
    // a route-specific forecast never gets silently overwritten by BDRY
    // data landing after this request kicks off.
    if (routeMode) {
      setBdryHistory([]);
      return;
    }
    let cancelled = false;

    api
      .get("/dashboard-summary")
      .then(({ data }) => {
        if (!cancelled) {
          setBdryHistory(
            Array.isArray(data.bdry_history_12m)
              ? data.bdry_history_12m
              : []
          );
        }
      })
      .catch(() => {
        if (!cancelled) setBdryHistory([]);
      });

    return () => {
      cancelled = true;
    };
  }, [routeMode]);

  let data;
  let title;
  let unitLabel;

  if (routeMode) {
    // Route-specific history + H+1/H+2/H+3 forecast, e.g. "Newcastle →
    // Chennai" — never the BDRY series, even if BDRY history happens to
    // be available, since it isn't what this forecast is based on.
    const history = (routeHistory || []).map((p) => ({
      month: p.month,
      value: p.value,
      isForecast: false,
    }));
    const forecast = (forecastCurve || []).map((p) => ({
      month: p.horizon,
      value: p.predicted_rate,
      isForecast: true,
    }));
    data = [...history, ...forecast];
    title =
      originPort && destinationPort
        ? `${originPort} → ${destinationPort} Freight Forecast`
        : "Route Freight Forecast";
    unitLabel = "Route";
  } else {
    data = bdryHistory.length
      ? bdryHistory
      : (points || []).map((p, index, arr) => ({
          month: p.label,
          value: p.value,
          isForecast: index === arr.length - 1,
        }));
    title = "BDRY freight-rate trend — last 12 months";
    unitLabel = "BDRY";
  }

  if (!data.length) return null;

  return (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <Card>
        <CardHeader className="flex flex-row items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-signal/10 text-signal">
            <LineChartIcon className="h-[18px] w-[18px]" />
          </span>
          <CardTitle className="text-lg">{title}</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={data} margin={{ top: 10, right: 16, left: -12, bottom: 0 }}>
              <defs>
                <linearGradient id="signalLine" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#22D3C4" />
                  <stop offset="100%" stopColor="#7CF0E4" />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1B2536" strokeDasharray="3 6" vertical={false} />
              <XAxis
                dataKey="month"
                stroke="#28344A"
                tick={{ fill: "#6b7690", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}
                tickLine={false}
                axisLine={{ stroke: "#28344A" }}
              />
              <YAxis
                stroke="#28344A"
                tick={{ fill: "#6b7690", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip content={<ChartTooltip unitLabel={unitLabel} />} cursor={{ stroke: "#22D3C4", strokeWidth: 1, strokeDasharray: "4 4" }} />
              <Line
                type="monotone"
                dataKey="value"
                stroke="url(#signalLine)"
                strokeWidth={2.5}
                dot={{ r: 3, fill: "#0F1620", stroke: "#22D3C4", strokeWidth: 2 }}
                activeDot={{ r: 5, fill: "#22D3C4", stroke: "#7CF0E4", strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </motion.div>
  );
}