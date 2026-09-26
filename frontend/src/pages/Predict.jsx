import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import ForecastForm from "../components/ForecastForm.jsx";
import ResultCards from "../components/ResultCards.jsx";
import TrendChart from "../components/TrendChart.jsx";
import AlertsPanel from "../components/AlertsPanel.jsx";
import WhatIfPanel from "../components/WhatIfPanel.jsx";
import DecisionSimulator from "../components/DecisionSimulator.jsx";
import PortRadarNotice from "../components/PortRadarNotice.jsx";
import ErrorBoundary from "../components/ErrorBoundary.jsx";

export default function Predict() {
  const [result, setResult] = useState(null);
  const [lastRequest, setLastRequest] = useState(null);
  const [scenario, setScenario] = useState(null);

  function handleResult(data, payload) {
    setResult(data);
    setLastRequest(payload || null);
    setScenario(null);
  }

  // Stable identity so WhatIfPanel's report-upward effect doesn't re-fire
  // on every Predict render.
  const handleScenarioChange = useCallback((next) => setScenario(next), []);

  return (
    <section className="predict-page">
      <div className="predict-shell mx-auto max-w-[1240px] px-5 pb-16 pt-9 lg:px-8 lg:pt-12">
        <header className="predict-heading">
          <div>
            <div className="fs-kicker">Forecast console</div>
            <h1 className="predict-title">Plot a shipment</h1>
            <p className="predict-intro">
              Enter the route and cargo profile. The model returns a rate forecast, a market-risk read, and a recommended chartering window with the constraints that shaped it.
            </p>
          </div>
          <div className="predict-stamp">one-pager</div>
        </header>

        <div className="mt-7">
          <ForecastForm onResult={handleResult} />
        </div>

        <AnimatePresence mode="wait">
          {result && (
            <motion.div
              key={JSON.stringify(result).slice(0, 80)}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              className="mt-10"
            >
              <ErrorBoundary>
                <ResultCards result={result} />
                <div className="mt-7">
                  <PortRadarNotice origin={lastRequest?.origin_port} destination={lastRequest?.destination_port} />
                </div>
                <div className="mt-7 flex flex-col gap-6">
                  <TrendChart points={result.chart_values} />
                  <WhatIfPanel baseRequest={lastRequest} onScenarioChange={handleScenarioChange} />
                  <DecisionSimulator baseRequest={lastRequest} forecast={result} scenario={scenario} />
                  <AlertsPanel />
                </div>
              </ErrorBoundary>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
