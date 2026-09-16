import { cn } from "../../lib/utils.js";

export function Card({ className, children, ...props }) {
  return <div className={cn("relative border border-rule/70 bg-parchment", className)} {...props}>{children}</div>;
}
export function CardHeader({ className, children, ...props }) { return <div className={cn("px-5 pt-5", className)} {...props}>{children}</div>; }
export function CardTitle({ className, children, ...props }) { return <h3 className={cn("font-display text-xl font-semibold tracking-[-0.01em] text-ink", className)} {...props}>{children}</h3>; }
export function CardContent({ className, children, ...props }) { return <div className={cn("px-5 pb-5", className)} {...props}>{children}</div>; }
