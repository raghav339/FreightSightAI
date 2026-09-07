import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowRight, TrendingUp, ShieldAlert, ShipWheel, History as HistoryIcon,
  Activity, Anchor, Navigation, Package, Radar, Waves
} from "lucide-react";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";

function useFeatures(t) {
  return [
    { icon: TrendingUp, title:"Rate Forecasting", body:"A RandomForestRegressor trained on lag, rolling-average, and calendar features predicts the freight rate (USD/ton) for your route and date.", accent:"text-signal", tag:"FORECAST" },
    { icon: ShieldAlert, title:"Risk Classification", body:"A RandomForestClassifier labels each forecast low, medium, or high risk based on historical rate volatility on that route.", accent:"text-amber", tag:"RISK" },
    { icon: ShipWheel, title:"Charter Recommendation", body:"Simple, explainable rules turn the forecast trend into a suggested chartering window and vessel type.", accent:"text-starboard", tag:"VESSEL" },
    { icon: HistoryIcon, title:"History & Alerts", body:"Every forecast is saved. High-risk routes automatically raise an alert so nothing risky slips by unnoticed.", accent:"text-port", tag:"HISTORY" },
  ];
}

const container={hidden:{},show:{transition:{staggerChildren:.08,delayChildren:.1}}};
const item={hidden:{opacity:0,y:18},show:{opacity:1,y:0,transition:{duration:.55,ease:[.16,1,.3,1]}}};

function MiniMetric({label,value,delta,icon:Icon}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-hull-600/70 bg-hull-900/70 p-4 transition-all duration-300 hover:-translate-y-1 hover:border-signal/30">
      <div className="flex items-center justify-between">
        <span className="fs-kicker">{label}</span>
        <Icon className="h-4 w-4 text-slate-600 transition-colors group-hover:text-signal" />
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <span className="fs-number text-2xl">{value}</span>
        <span className="font-mono text-[10px] text-starboard">{delta}</span>
      </div>
    </div>
  );
}

function DigitalTwin() {
  return (
    <div className="relative h-[390px] overflow-hidden rounded-[1.75rem] border border-hull-500/70 bg-[#070c14] shadow-glow-lg perspective-1400">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_52%_48%,rgba(34,211,196,.10),transparent_35%),linear-gradient(180deg,rgba(255,255,255,.025),transparent)]" />
      <div className="absolute inset-0 bg-grid opacity-30" />
      <div className="absolute left-1/2 top-1/2 h-[290px] w-[520px] -translate-x-1/2 -translate-y-1/2 rotate-[10deg] skew-y-[-8deg] rounded-[50%] border border-signal/10 shadow-[0_0_80px_rgba(34,211,196,.07)_inset]" />
      <div className="absolute left-1/2 top-1/2 h-[210px] w-[400px] -translate-x-1/2 -translate-y-1/2 rotate-[10deg] skew-y-[-8deg] rounded-[50%] border border-signal/10" />

      <div className="absolute left-7 top-6 flex items-center gap-2 rounded-full border border-hull-500/70 bg-hull-900/80 px-3 py-1.5 backdrop-blur-md">
        <span className="h-1.5 w-1.5 rounded-full bg-starboard fs-glow-dot" />
        <span className="font-mono text-[9px] uppercase tracking-[.2em] text-slate-400">LIVE FREIGHT DIGITAL TWIN</span>
      </div>
      <div className="absolute right-6 top-6 rounded-lg border border-hull-600/70 bg-hull-900/70 px-3 py-2 font-mono text-[9px] text-slate-500 backdrop-blur-md">
        AIS NETWORK · ONLINE
      </div>

      {/* route beams */}
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 700 390" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
            <stop stopColor="#22D3C4" stopOpacity="0"/>
            <stop offset=".48" stopColor="#7CF0E4" stopOpacity=".9"/>
            <stop offset="1" stopColor="#FFB020" stopOpacity=".08"/>
          </linearGradient>
        </defs>
        <path d="M88 292 C190 92 410 330 608 98" stroke="url(#beam)" strokeWidth="2" strokeDasharray="7 10" className="animate-dash-flow"/>
        <path d="M88 292 C190 92 410 330 608 98" stroke="#22D3C4" strokeOpacity=".12" strokeWidth="16" />
        <path d="M115 308 C240 160 405 330 575 126" stroke="#22D3C4" strokeOpacity=".10" strokeWidth="1" strokeDasharray="2 12"/>
      </svg>

      {/* ports */}
      <div className="absolute bottom-[68px] left-[9%]">
        <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-signal/50 bg-signal/10 text-signal shadow-glow">
          <Anchor className="h-5 w-5" />
          <span className="absolute inset-[-9px] rounded-full border border-signal/20 animate-pulse-ring" />
        </div>
        <div className="mt-2 font-mono text-[9px] uppercase tracking-widest text-slate-500">GLADSTONE</div>
      </div>

      <div className="absolute right-[8%] top-[24%]">
        <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-amber/50 bg-amber/10 text-amber">
          <Navigation className="h-5 w-5" />
          <span className="absolute inset-[-9px] rounded-full border border-amber/20 animate-pulse-ring" />
        </div>
        <div className="mt-2 text-right font-mono text-[9px] uppercase tracking-widest text-slate-500">VISAKHAPATNAM</div>
      </div>

      {/* 3D-ish vessel */}
      <motion.div
        animate={{ x:[-10,14,-10], y:[3,-8,3], rotate:[-2,2,-2] }}
        transition={{duration:5,repeat:Infinity,ease:"easeInOut"}}
        className="absolute left-[48%] top-[48%] preserve-3d"
      >
        <div className="relative h-11 w-20 rotate-[-8deg]">
          <div className="absolute bottom-1 left-1 h-5 w-16 skew-x-[-20deg] rounded-b-[12px] border border-slate-500/50 bg-gradient-to-b from-slate-500 to-slate-800 shadow-[8px_10px_18px_rgba(0,0,0,.55)]" />
          <div className="absolute left-6 top-1 h-5 w-9 rounded-sm border border-slate-400/30 bg-slate-700/80" />
          <div className="absolute left-9 top-[-2px] h-2 w-4 rounded-sm bg-amber/80" />
          <span className="absolute -bottom-4 left-7 h-px w-24 bg-gradient-to-r from-signal/0 via-signal/50 to-signal/0" />
        </div>
      </motion.div>

      {/* floating telemetry */}
      <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 gap-2">
        {[
          ["ETA","14:35"],
          ["RISK","LOW"],
          ["LOAD","82%"]
        ].map(([a,b])=>(
          <div key={a} className="rounded-xl border border-hull-600/70 bg-hull-900/80 px-3 py-2 backdrop-blur-md">
            <div className="font-mono text-[8px] uppercase tracking-widest text-slate-600">{a}</div>
            <div className="mt-0.5 font-mono text-[10px] font-semibold text-paper-100">{b}</div>
          </div>
        ))}
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-signal/[.035] to-transparent animate-scan" />
    </div>
  );
}

export default function Landing() {
  const FEATURES=useFeatures(t);
  return (
    <div className="flex flex-col gap-12 sm:gap-16">
      <section className="relative overflow-hidden rounded-[2rem] border border-hull-600/80 bg-hull-800/45 shadow-[0_35px_100px_-45px_rgba(0,0,0,.95)]">
        <div className="absolute inset-0 bg-grid opacity-25" />
        <div className="absolute -right-40 -top-40 h-[32rem] w-[32rem] rounded-full bg-signal/8 blur-[120px]" />
        <div className="absolute -bottom-48 left-1/3 h-[28rem] w-[28rem] rounded-full bg-amber/5 blur-[130px]" />

        <div className="relative grid gap-8 p-5 sm:p-8 lg:grid-cols-[.92fr_1.08fr] lg:gap-10 lg:p-10 xl:p-12">
          <motion.div initial="hidden" animate="show" variants={container} className="flex flex-col justify-center gap-6 lg:py-6">
            <motion.div variants={item} className="flex flex-wrap items-center gap-2">
              <Badge variant="signal" dot>{"Bulk cargo · India east coast"}</Badge>
              <span className="rounded-full border border-hull-600 bg-hull-900/70 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[.18em] text-slate-500">
                SIH26006 · EAST COAST FREIGHT
              </span>
            </motion.div>

            <motion.div variants={item}>
              <h1 className="font-display text-[2.65rem] font-semibold leading-[.98] tracking-[-.055em] text-paper-50 sm:text-5xl xl:text-[4.2rem]">
                See the freight.
                <br />
                <span className="text-gradient-signal">Predict the move.</span>
              </h1>
              <p className="mt-5 max-w-xl text-[.98rem] leading-7 text-slate-400">
                {"FreightSight AI predicts freight-rate movement on bulk cargo routes to India's East Coast, flags market risk, and recommends when to charter and which vessel class to use — built for procurement and logistics teams who need a fast, data-backed answer."}
              </p>
            </motion.div>

            <motion.div variants={item} className="flex flex-wrap gap-3">
              <Button as={Link} to="/predict" size="default" className="rounded-xl px-6">
                {"Run a forecast"} <ArrowRight className="h-4 w-4" />
              </Button>
              <Button as={Link} to="/compare" variant="outline" className="rounded-xl">
                Explore routes
              </Button>
            </motion.div>

            <motion.div variants={item} className="grid max-w-xl grid-cols-3 gap-2 border-t border-hull-600/60 pt-5">
              {[
                ["Model","Random Forest"],
                ["Signal","BDRY · 12mo"],
                ["Coverage","Coal · Ore · Minerals"]
              ].map(([a,b])=>(
                <div key={a}>
                  <div className="fs-kicker text-slate-600">{a}</div>
                  <div className="mt-1 font-mono text-xs text-paper-100">{b}</div>
                </div>
              ))}
            </motion.div>
          </motion.div>

          <motion.div
            initial={{opacity:0,scale:.97,y:10}}
            animate={{opacity:1,scale:1,y:0}}
            transition={{duration:.8,ease:[.16,1,.3,1],delay:.15}}
            className="lg:py-2"
          >
            <DigitalTwin />
          </motion.div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MiniMetric label="Freight network" value="11" delta="LOAD PORTS" icon={Anchor}/>
        <MiniMetric label="East coast" value="10" delta="DESTINATIONS" icon={Waves}/>
        <MiniMetric label="Prediction" value="12M" delta="HISTORY" icon={Activity}/>
        <MiniMetric label="Signals" value="24/7" delta="MONITORED" icon={Radar}/>
      </section>

      <motion.section initial="hidden" whileInView="show" viewport={{once:true,amount:.15}} variants={container}>
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="fs-kicker">OPERATIONS LAYER</div>
            <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight text-paper-50 sm:text-3xl">One view of the voyage</h2>
          </div>
          <Package className="hidden h-6 w-6 text-slate-700 sm:block"/>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({icon:Icon,title,body,accent,tag})=>(
            <motion.div key={title} variants={item} className="group">
              <div className="fs-panel h-full rounded-2xl p-5 transition-all duration-300 group-hover:-translate-y-1 group-hover:border-signal/30">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[9px] tracking-[.2em] text-slate-600">{tag}</span>
                  <span className={`flex h-9 w-9 items-center justify-center rounded-xl bg-hull-700/80 ${accent}`}>
                    <Icon className="h-4.5 w-4.5" strokeWidth={2}/>
                  </span>
                </div>
                <h3 className="mt-5 font-display text-base font-semibold text-paper-50">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">{body}</p>
                <div className="mt-5 h-px overflow-hidden bg-hull-600">
                  <div className="h-full w-1/3 bg-signal/50 transition-all duration-700 group-hover:w-full"/>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </motion.section>
    </div>
  );
}
