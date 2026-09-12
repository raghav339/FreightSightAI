import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { BellRing } from "lucide-react";
import api from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card.jsx";
import { Badge } from "./ui/badge.jsx";

const TYPE_LABEL = { high_risk: "High risk", price_spike: "Price spike", volatility: "Volatility" };
const TYPE_VARIANT = { high_risk: "high", price_spike: "medium", volatility: "signal" };

export default function AlertsPanel() {
  const [alerts, setAlerts] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .get("/alerts")
      .then(({ data }) => setAlerts(data))
      .catch(() => setError("Could not load alerts"));
  }, []);

  if (error) return null;
  if (!alerts.length) return null;

  return (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.05 }}>
      <Card>
        <CardHeader className="flex flex-row items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-port/10 text-port">
            <BellRing className="h-[18px] w-[18px]" />
          </span>
          <CardTitle className="text-lg">{"Recent alerts"}</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <ul className="flex flex-col divide-y divide-hull-600/60">
            {alerts.slice(0, 8).map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2.5 py-3 first:pt-0 last:pb-0 text-sm">
                <Badge variant={TYPE_VARIANT[a.alert_type] || "neutral"}>
                  {TYPE_LABEL[a.alert_type] || a.alert_type}
                </Badge>
                <span className="font-semibold text-paper-100">{a.route}</span>
                <span className="text-slate-400">{a.message}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </motion.div>
  );
}