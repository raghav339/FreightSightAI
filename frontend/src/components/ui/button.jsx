import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 focus-visible:ring-offset-2 focus-visible:ring-offset-hull-900 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
  {
    variants: {
      variant: {
        primary:
          "bg-signal text-hull-950 shadow-glow hover:shadow-glow-lg hover:brightness-105 hover:-translate-y-0.5",
        outline:
          "border border-hull-500/80 bg-hull-900/40 text-paper-100 hover:-translate-y-0.5 hover:border-signal/50 hover:text-signal",
        ghost: "text-slate-300 hover:text-signal hover:bg-hull-700/60",
      },
      size: {
        default: "h-11 px-6",
        sm: "h-9 px-4 text-[0.83rem]",
        icon: "h-9 w-9 rounded-full",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
);

const Button = forwardRef(({ className, variant, size, as: Comp = "button", ...props }, ref) => {
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
});
Button.displayName = "Button";

export { Button, buttonVariants };