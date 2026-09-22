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
import { useTranslation } from "react-i18next";
import { LineChart as LineChartIcon } from "lucide-react";
import api from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card.jsx";

function ChartTooltip({ active, payload, label }) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const point = payload[0];
  return (
    <div className="rounded-lg border border-hull-500 bg-hull-800/95 px-3 py-2 shadow-glow backdrop-blur-sm">
      <div className="font-mono text-[0.7rem] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-0.5 font-display text-sm font-semibold text-signal">
        {Number(point.value).toFixed(2)}
        <span className="ml-1.5 font-body text-xs font-normal text-slate-400">
          {point.payload?.isForecast ? t("trend.forecast") : t("trend.unit")}
        </span>
      </div>
    </div>
  );
}

export default function TrendChart({ points }) {
  const { t } = useTranslation();
  const [history, setHistory] = useState([]);

  useEffect(() => {
    let cancelled = false;

    api
      .get("/dashboard-summary")
      .then(({ data }) => {
        if (!cancelled) {
          setHistory(
            Array.isArray(data.route_freight_history_12m)
              ? data.route_freight_history_12m
              : []
          );
        }
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const data = history.length
    ? history
    : (points || []).map((p, index, arr) => ({
        month: p.label,
        value: p.value,
        isForecast: index === arr.length - 1,
      }));

  if (!data.length) return null;

  return (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <Card>
        <CardHeader className="flex flex-row items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-signal/10 text-signal">
            <LineChartIcon className="h-[18px] w-[18px]" />
          </span>
          <CardTitle className="text-lg">{t("trend.title")}</CardTitle>
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
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#22D3C4", strokeWidth: 1, strokeDasharray: "4 4" }} />
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