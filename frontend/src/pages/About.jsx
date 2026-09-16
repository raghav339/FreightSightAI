import { motion } from "framer-motion";
import { ClipboardList, Server, Cpu, DatabaseZap, MonitorSmartphone } from "lucide-react";
import { Card } from "../components/ui/card.jsx";

function useSteps() {
  return [
    { icon: ClipboardList, title: "Enter shipment details", body: "Tell FreightSight the commodity, route, cargo weight, and shipment date — the same inputs a charterer would use to fix a vessel." },
    { icon: Server, title: "Request hits the ML service", body: "The backend validates the request and forwards it to a dedicated Python service running the trained forecasting models." },
    { icon: Cpu, title: "Models generate a forecast", body: "A RandomForestRegressor predicts the freight rate while a RandomForestClassifier scores market risk, both trained on historical BDRY and route data." },
    { icon: DatabaseZap, title: "Result is logged", body: "Every forecast, along with its inputs and outputs, is saved to your history so nothing risky slips by unnoticed." },
    { icon: MonitorSmartphone, title: "Review on any device", body: "See the rate forecast, risk read, and recommended chartering window on the console — the same data whether you're at a desk or on the quay." },
  ];
}

export default function About() {
  const STEPS = useSteps();
  return (
    <section className="mx-auto max-w-[1240px] px-5 py-10 lg:px-8 lg:py-14">
      <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1.5">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-signal/80">{"How it works"}</span>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-paper-50 sm:text-3xl">
          {"From shipment details to a chartering decision"}
        </h1>
      </header>

      <div className="relative flex flex-col gap-4">
        <div className="absolute bottom-6 left-[19px] top-6 hidden w-px bg-gradient-to-b from-signal/60 via-hull-500 to-transparent sm:block" />
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <motion.div
            key={title + i}
            initial={{ opacity: 0, x: -12 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.4, delay: i * 0.06, ease: [0.16, 1, 0.3, 1] }}
          >
            <Card className="flex items-start gap-4 p-5">
              <span className="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-signal/30 bg-hull-800 text-signal shadow-glow">
                <Icon className="h-4 w-4" strokeWidth={2} />
              </span>
              <div className="flex flex-col gap-1 pt-1">
                <h3 className="font-display text-[0.95rem] font-medium tracking-tight text-paper-50">{title}</h3>
                <p className="text-sm leading-relaxed text-slate-400">{body}</p>
              </div>
            </Card>
          </motion.div>
        ))}
      </div>

      <Card className="p-6 text-sm leading-relaxed text-slate-400">
        {"Built for"} <span className="font-semibold text-paper-100">SIH26006</span> — {"Smart India Hackathon 2026, focused on freight-rate forecasting for bulk cargo shipping to India's East Coast."}
      </Card>
      </div>
    </section>
  );
}