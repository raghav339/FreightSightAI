import { cn } from "../../lib/utils.js";

export default function Stamp({ children, tone = "ink", filled = false, className = "" }) {
  const tones = {
    ink: filled ? "bg-ink text-paper border-ink" : "border-ink/40 text-ink",
    vermilion: filled ? "bg-vermilion text-paper border-vermilion" : "border-vermilion/55 text-vermilion",
    kelp: filled ? "bg-kelp text-paper border-kelp" : "border-kelp/55 text-kelp",
    brass: filled ? "bg-brass text-paper border-brass" : "border-brass/55 text-brass",
  };
  return <span className={cn("inline-flex items-center gap-1.5 border px-2 py-[3px] font-mono text-[10px] uppercase leading-none tracking-[0.19em]", tones[tone], className)}>{children}</span>;
}
