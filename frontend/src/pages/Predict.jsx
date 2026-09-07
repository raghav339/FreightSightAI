// frontend/src/pages/Predict.jsx
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import ForecastForm from "../components/ForecastForm.jsx";
import ResultCards from "../components/ResultCards.jsx";
import TrendChart from "../components/TrendChart.jsx";
import AlertsPanel from "../components/AlertsPanel.jsx";
import WhatIfPanel from "../components/WhatIfPanel.jsx";

export default function Predict() {
  const [result, setResult] = useState(null);
  const [lastRequest, setLastRequest] = useState(null);

  function handleResult(data, payload) {
    setResult(data);
    setLastRequest(payload || null);
  }

  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-1.5">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-signal/80">{"Forecast console"}</span>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-paper-50 sm:text-3xl">
          {"Shipment details"}
        </h1>
        <p className="max-w-2xl text-sm text-slate-400">
          {"Enter the route and cargo profile — the model returns a rate forecast, market risk read, and a recommended chartering window."}
        </p>
      </header>

      <ForecastForm onResult={handleResult} />

      <AnimatePresence mode="wait">
        {result && (
          <motion.div
            key={JSON.stringify(result).slice(0, 40)}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col gap-6"
          >
            <ResultCards result={result} />
            <TrendChart points={result.chart_values} />
            <WhatIfPanel baseRequest={lastRequest} />
            <AlertsPanel />
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

