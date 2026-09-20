import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Compass, Activity, Package, Ship, ShieldAlert, FileClock } from "lucide-react";
import { Link } from "react-router-dom";
import HullLines from "../components/three/HullLines.jsx";
import Stamp from "../components/ui/Stamp.jsx";
import api from "../api/client.js";
import useNetworkStatus from "../hooks/useNetworkStatus.js";


const features = [
  { plate: "01", icon: Activity, title: "Rate Forecasting", model: "RandomForestRegressor", body: "Predicts freight rate movement from route history, lag and rolling signals, calendar features and the available market proxy." },
  { plate: "02", icon: ShieldAlert, title: "Risk Classification", model: "RandomForestClassifier", body: "Translates historical route volatility into a low, medium or high market-risk read beside each forecast." },
  { plate: "03", icon: Ship, title: "Charter Recommendation", model: "Rule ensemble", body: "Combines forecast direction with port and vessel constraints to suggest a chartering window and feasible class." },
  { plate: "04", icon: FileClock, title: "History & Alerts", model: "Voyage log", body: "Persists forecast inputs and outputs and surfaces higher-risk results for follow-up and reporting." },
];

const pipeline = [
  ["I", "Enter shipment details", "Choose commodity, loading port, destination, cargo and shipment date in the same language a chartering desk uses."],
  ["II", "Validate and route the request", "The browser posts the shipment to the Express backend, which validates it and calls the Python forecasting service."],
  ["III", "Generate the forecast", "Route-aware models produce rate, risk, feasibility and recommendation outputs from route-freight data."],
  ["IV", "Persist the voyage record", "Forecasts can be stored in the configured backend database so history and alerts can be reviewed later."],
  ["V", "Act on one defensible view", "Review the number, assumptions, constraints and caveats before fixing tonnage or a vessel."],
];

function CompassPlate() {
  return (
    <figure className="relative border border-ink/25 bg-parchment/70">
      <span className="absolute -left-px -top-px h-3 w-3 border-l border-t border-ink/70" />
      <span className="absolute -right-px -top-px h-3 w-3 border-r border-t border-ink/70" />
      <span className="absolute -bottom-px -left-px h-3 w-3 border-b border-l border-ink/70" />
      <span className="absolute -bottom-px -right-px h-3 w-3 border-b border-r border-ink/70" />

      <div className="flex items-center justify-between border-b border-rule/60 px-4 py-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.19em] text-inksoft">plate 04 — hull lines · bulk carrier</span>
        <span className="font-mono text-[9px] uppercase tracking-[0.19em] text-rule">scale 1:2400</span>
      </div>
      <div className="relative h-[320px] sm:h-[400px] lg:h-[458px]">
        <div className="chart-contour pointer-events-none absolute inset-0 opacity-50" />
        {isSlow ? (
          // Lite mode: this Three.js scene renders continuously and isn't
          // load-bearing for the pitch — skip it on a slow/offline
          // connection or a data-saver session instead of spending GPU and
          // battery on a background flourish.
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-rule">lite mode — animation skipped</span>
          </div>
        ) : (
          <HullLines className="absolute inset-0" />
        )}
        <div className="pointer-events-none absolute left-4 top-4 font-mono text-[9px] uppercase leading-relaxed tracking-[0.18em] text-inksoft">
          <div>frames 0–17</div>
          <div className="text-rule">waterline in vermilion</div>
        </div>
        <div className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 text-right font-mono text-[9px] uppercase leading-relaxed tracking-[0.18em] sm:block">
          <div className="flex items-center justify-end gap-2"><span className="h-px w-10 bg-ink/40" /><span>dwt 78 000 t</span></div>
          <div className="mt-2 flex items-center justify-end gap-2"><span className="h-px w-6 bg-ink/40" /><span className="text-inksoft">draft 14.2 m</span></div>
          <div className="mt-2 flex items-center justify-end gap-2"><span className="h-px w-14 bg-ink/40" /><span className="text-inksoft">beam 32.2 m</span></div>
        </div>
        <div className="pointer-events-none absolute bottom-5 left-6 right-6 hidden items-center gap-3 sm:flex">
          <span className="h-2 w-px bg-ink/60" /><span className="h-px flex-1 bg-ink/30" />
          <span className="font-mono text-[9px] uppercase tracking-[0.19em] text-inksoft">loa 229 m</span>
          <span className="h-px flex-1 bg-ink/30" /><span className="h-2 w-px bg-ink/60" />
        </div>
      </div>
      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-t border-rule/60 px-4 py-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.19em] text-inksoft">lat 20°15′N · lon 86°40′E — approach paradip</span>
        <span className="font-mono text-[9px] uppercase tracking-[0.19em] text-rule">move pointer to look around</span>
      </figcaption>
    </figure>
  );
}

function LaneStrip() {
  const [lanes, setLanes] = useState([]);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    let cancelled = false;

    const loadRecentLanes = async () => {
      try {
        const { data } = await api.get("/recent-voyages", { timeout: 12000 });
        if (cancelled) return;
        const rows = Array.isArray(data?.voyages) ? data.voyages : [];
        setLanes(rows);
        setStatus(rows.length ? "ready" : "empty");
      } catch (error) {
        if (cancelled) return;
        console.warn("Could not load recent voyage tape:", error?.message || error);
        setStatus("unavailable");
      }
    };

    loadRecentLanes();
    const refresh = window.setInterval(loadRecentLanes, 60000);

    return () => {
      cancelled = true;
      window.clearInterval(refresh);
    };
  }, []);

  const rows = useMemo(() => {
    if (!lanes.length) return [];
    return [...lanes, ...lanes];
  }, [lanes]);

  const renderStatus = () => {
    if (status === "loading") return "loading recent records";
    if (status === "unavailable") return "live tape unavailable";
    if (status === "empty") return "awaiting first recorded voyage";
    return `${lanes.length} recent recorded voyage${lanes.length === 1 ? "" : "s"}`;
  };

  return (
    <section className="overflow-hidden border-b border-rule/70 bg-paper" aria-label="Recent recorded voyage tape">
      <div className="flex items-center gap-4 border-b border-rule/50 px-5 py-2 lg:px-8">
        <span className="font-mono text-[9px] uppercase tracking-[0.19em] text-rule">voyage log · live tape</span>
        <span className="h-px flex-1 bg-rule/45" />
        <span className="font-mono text-[9px] uppercase tracking-[0.19em] text-rule">{renderStatus()}</span>
        <span className="font-mono text-[9px] uppercase tracking-[0.19em] text-rule">ROUTE FREIGHT</span>
      </div>
      <div className="overflow-hidden">
        {rows.length ? (
          <div className="lane-scroll flex w-max">
            {rows.map((voyage, index) => {
              const risk = String(voyage.risk_label || "unknown").toLowerCase();
              const riskClass = risk === "high"
                ? "text-vermilion"
                : risk === "medium"
                ? "text-brass"
                : risk === "low"
                ? "text-kelp"
                : "text-inksoft";
              return (
                <div key={`${voyage.result_id ?? voyage.route}-${index}`} className="flex shrink-0 items-center gap-4 border-r border-rule/50 px-6 py-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-ink">{voyage.route}</span>
                  <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-rule">{voyage.commodity || "—"}</span>
                  <span className="font-mono text-[11px] tabular text-ink">{Number(voyage.predicted_freight_rate_usd_per_ton).toFixed(2)}</span>
                  <span className={`font-mono text-[9px] uppercase tracking-[0.17em] ${riskClass}`}>{risk}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-5 py-3 font-mono text-[9px] uppercase tracking-[0.16em] text-inksoft lg:px-8">
            No recorded forecast voyages yet. Run a forecast to populate the tape from stored results.
          </div>
        )}
      </div>
    </section>
  );
}

export default function Landing() {
  const { isSlow } = useNetworkStatus();
  return (
    <div>
      <section className="relative border-b border-rule/70">
        <div className="chart-contour pointer-events-none absolute -right-40 -top-20 hidden h-[620px] w-[620px] opacity-35 lg:block" />
        <div className="mx-auto grid max-w-[1240px] gap-10 px-5 py-12 lg:grid-cols-12 lg:gap-8 lg:px-8 lg:py-16">
          <div className="flex flex-col justify-center lg:col-span-5">
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .28 }}>
              <Stamp tone="vermilion"><Compass className="h-3 w-3" />bulk cargo · india east coast</Stamp>
            </motion.div>
            <motion.h1 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .3, delay: .05 }} className="mt-6 font-display text-[44px] font-semibold leading-[.98] tracking-[-.025em] sm:text-[58px] lg:text-[62px]">
              See the freight.
              <span className="block italic text-vermilion">Predict the move.</span>
            </motion.h1>
            <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .3, delay: .1 }} className="mt-6 max-w-[46ch] text-[15px] leading-relaxed text-inksoft">
              FreightSight forecasts freight rates on bulk cargo routes into India&apos;s East Coast, reads market risk, and recommends when to charter and which vessel class to fix — with the route, data source and feasibility assumptions kept visible.
            </motion.p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/predict" className="group inline-flex items-center gap-2.5 border border-ink bg-ink px-5 py-3 font-mono text-[11px] uppercase tracking-[0.17em] text-paper hover:border-vermilion hover:bg-vermilion">run a forecast <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" /></Link>
              <Link to="/compare" className="inline-flex items-center border border-ink/35 px-5 py-3 font-mono text-[11px] uppercase tracking-[0.17em] text-ink hover:border-ink hover:bg-ink/5">explore routes</Link>
            </div>
            <dl className="mt-12 grid max-w-xl grid-cols-3 border-t border-rule/70 pt-4">
              {[["model","Random Forest"],["trained on","Synthetic route freight rates"],["cargo","Coal · Ore · Minerals"]].map(([a,b]) => <div key={a} className="border-r border-rule/50 pr-3 last:border-0"><dt className="font-mono text-[9px] uppercase tracking-[0.18em] text-rule">{a}</dt><dd className="mt-1 font-mono text-[11px] leading-tight text-ink">{b}</dd></div>)}
            </dl>
          </div>
          <motion.div initial={{ opacity: 0, scale: .98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: .35, delay: .08 }} className="lg:col-span-7">
            <CompassPlate />
          </motion.div>
        </div>
      </section>

      <section className="border-b border-rule/70 bg-parchment">
        <div className="mx-auto grid max-w-[1240px] gap-6 px-5 py-8 lg:grid-cols-12 lg:items-end lg:gap-8 lg:px-8">
          <div className="lg:col-span-4"><span className="font-mono text-[9px] uppercase tracking-[0.18em] text-rule">coverage</span><div className="mt-2 flex items-baseline gap-3"><span className="font-display text-[56px] font-semibold leading-none tabular">11</span><span className="pb-2 font-mono text-[11px] uppercase tracking-[0.16em]">loading ports</span></div><p className="mt-1 text-[13px] text-inksoft">Australia · Indonesia · Mozambique · Russia · US</p></div>
          <div className="grid gap-y-5 sm:grid-cols-3 sm:gap-x-6 lg:col-span-8">
            {[["East-coast destinations","10","Paradip to Sagar Sandheads"],["Dataset rows","12M","Synthetic route-freight history"],["Monitoring","24/7","High-risk results raise alerts"]].map(([a,b,c]) => <div key={a} className="border-t border-rule/60 pt-3 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0"><div className="font-mono text-[9px] uppercase tracking-[0.18em] text-rule">{a}</div><div className="mt-1 font-display text-[28px] font-semibold leading-none tabular">{b}</div><p className="mt-1 text-[12px] leading-snug text-inksoft">{c}</p></div>)}
          </div>
        </div>
      </section>

      <LaneStrip />

      <section className="border-b border-rule/70">
        <div className="mx-auto max-w-[1240px] px-5 py-14 lg:px-8 lg:py-18">
          <div className="mb-7 flex items-end justify-between"><div><div className="font-mono text-[9px] uppercase tracking-[0.19em] text-rule">operations layer</div><h2 className="mt-2 font-display text-[34px] font-semibold leading-tight tracking-[-.01em] sm:text-[42px]">One view of the voyage</h2></div><Package className="hidden h-6 w-6 text-rule sm:block" /></div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {features.map(({ plate, icon: Icon, title, model, body }) => <motion.article key={plate} whileHover={{ y: -3 }} className="relative border border-rule/60 bg-parchment/70 p-5"><div className="flex items-center justify-between"><span className="font-mono text-[9px] uppercase tracking-[0.18em] text-rule">plate {plate}</span><span className="flex h-9 w-9 items-center justify-center border border-rule/50 text-vermilion"><Icon className="h-4 w-4" /></span></div><h3 className="mt-6 font-display text-[20px] font-semibold">{title}</h3><p className="mt-2 text-[13px] leading-relaxed text-inksoft">{body}</p><div className="mt-5 border-t border-rule/50 pt-3 font-mono text-[8px] uppercase tracking-[0.16em] text-rule">{model}</div></motion.article>)}
          </div>
        </div>
      </section>

      <section className="border-b border-rule/70 bg-parchment">
        <div className="mx-auto grid max-w-[1240px] gap-10 px-5 py-14 lg:grid-cols-12 lg:gap-12 lg:px-8 lg:py-18">
          <div className="lg:col-span-4"><div className="font-mono text-[9px] uppercase tracking-[0.19em] text-rule">how it works</div><h2 className="mt-2 font-display text-[34px] font-semibold leading-tight sm:text-[40px]">From shipment details to a chartering decision</h2><p className="mt-4 max-w-[40ch] text-[14px] leading-relaxed text-inksoft">Five visible steps keep the model useful without pretending the forecast is a broker quote.</p></div>
          <ol className="relative lg:col-span-8"><span className="absolute bottom-3 left-[13px] top-3 w-px bg-rule/60" aria-hidden="true" />{pipeline.map(([n,title,body],i) => <motion.li key={n} initial={{ opacity:0, x:-8 }} whileInView={{ opacity:1, x:0 }} viewport={{ once:true, margin:'-40px' }} transition={{duration:.25,delay:i*.04}} className="relative grid grid-cols-[28px_1fr] gap-x-5 pb-8 last:pb-0"><span className="relative z-10 flex h-7 w-7 items-center justify-center border border-ink/45 bg-paper font-mono text-[10px]">{n}</span><div className="pt-1"><h3 className="font-display text-[20px] font-semibold leading-snug">{title}</h3><p className="mt-1.5 max-w-[62ch] text-[14px] leading-relaxed text-inksoft">{body}</p></div></motion.li>)}</ol>
        </div>
      </section>

      <section className="relative overflow-hidden border-b border-rule/70">
        <div className="chart-hatch pointer-events-none absolute inset-y-0 right-0 w-1/3 opacity-60" />
        <div className="relative mx-auto flex max-w-[1240px] flex-col gap-6 px-5 py-14 lg:flex-row lg:items-center lg:justify-between lg:px-8"><div><span className="font-mono text-[9px] uppercase tracking-[0.19em] text-rule">next step</span><p className="mt-2 max-w-[30ch] font-display text-[30px] font-semibold leading-tight sm:text-[38px]">Plot a lane and get the rate, the risk and the window.</p></div><Link to="/predict" className="group inline-flex self-start items-center gap-2.5 border border-ink bg-ink px-5 py-3 font-mono text-[11px] uppercase tracking-[0.17em] text-paper hover:border-vermilion hover:bg-vermilion lg:self-auto">open forecast console <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" /></Link></div>
      </section>
    </div>
  );
}
