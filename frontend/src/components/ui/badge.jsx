import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva("inline-flex items-center gap-1.5 border px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.17em]", {
  variants: {
    variant: {
      low: "border-kelp/45 bg-kelp/5 text-kelp",
      medium: "border-brass/45 bg-brass/5 text-brass",
      high: "border-vermilion/45 bg-vermilion/5 text-vermilion",
      neutral: "border-rule/45 bg-paper/50 text-inksoft",
      signal: "border-vermilion/45 bg-vermilion/5 text-vermilion",
    },
  },
  defaultVariants: { variant: "neutral" },
});

export function Badge({ className, variant, dot = true, children, ...props }) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props}>{dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}{children}</span>;
}
