// Vertical "event -> ... -> procurement" propagation diagram. Renders the
// `propagation` array returned by /disruption/simulate (see
// ml-service/app/disruption_engine.py::build_propagation) — the component
// itself invents no numbers, it only lays out what the engine computed.
import {
  Wind, Ban, Ship, TrendingUp, Waves, CloudRain,
  Gauge, Clock, Anchor, DollarSign, Navigation, Package, ClipboardList,
} from "lucide-react";
import { cn } from "../lib/utils.js";

const EVENT_ICON = {
  cyclone: Wind,
  port_closure: Ban,
  vessel_shortage: Ship,
  freight_spike: TrendingUp,
  congestion_surge: Waves,
  extreme_weather: CloudRain,
};

const STEP_ICON = {
  event: null, // resolved per event_type via EVENT_ICON
  productivity: Gauge,
  delay: Clock,
  waiting: Anchor,
  freight: DollarSign,
  eta: Navigation,
  stockpile: Package,
  procurement: ClipboardList,
};

export default function PropagationChain({ steps, eventType, className }) {
  if (!steps?.length) return null;
  return (
    <ol className={cn("relative flex flex-col gap-0", className)}>
      {steps.map((step, i) => {
        const Icon = step.key === "event" ? EVENT_ICON[eventType] || Wind : STEP_ICON[step.key] || Gauge;
        const isLast = i === steps.length - 1;
        const breached = step.breached === true;
        const holds = step.breached === false;
        return (
          <li key={step.key} className="relative flex gap-4 pb-6 last:pb-0">
            {!isLast && <span className="absolute left-[15px] top-8 h-[calc(100%-1.25rem)] w-px bg-rule/50" aria-hidden="true" />}
            <span
              className={cn(
                "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                breached ? "border-vermilion bg-vermilion/10 text-vermilion"
                  : holds ? "border-kelp bg-kelp/10 text-kelp"
                  : "border-ink/30 bg-paper text-ink"
              )}
            >
              <Icon className="h-4 w-4" />
            </span>
            <div className="flex-1 pt-0.5">
              <div className="font-mono text-[9px] uppercase tracking-[0.15em] text-inksoft">{step.label}</div>
              <div className={cn("mt-0.5 text-sm", breached ? "font-medium text-vermilion" : holds ? "font-medium text-kelp" : "text-ink")}>
                {step.detail}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
