// frontend/src/components/ui/badge.jsx
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold font-mono tracking-wide w-fit",
  {
    variants: {
      variant: {
        low: "bg-starboard/10 text-starboard ring-1 ring-inset ring-starboard/30",
        medium: "bg-amber/10 text-amber ring-1 ring-inset ring-amber/30",
        high: "bg-port/10 text-port ring-1 ring-inset ring-port/30",
        neutral: "bg-hull-600/50 text-slate-300 ring-1 ring-inset ring-hull-500",
        signal: "bg-signal/10 text-signal ring-1 ring-inset ring-signal/30",
      },
    },
    defaultVariants: { variant: "neutral" },
  }
);

export function Badge({ className, variant, dot = true, children, ...props }) {
  return (
    <span className={cn(badgeVariants({ variant, className }))} {...props}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}