import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap border font-mono text-[11px] uppercase tracking-[0.17em] transition-[background-color,border-color,color,transform] duration-150 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 active:translate-y-px",
  {
    variants: {
      variant: {
        primary: "border-ink bg-ink text-paper hover:border-vermilion hover:bg-vermilion",
        outline: "border-ink/35 bg-transparent text-ink hover:border-ink hover:bg-ink/5",
        ghost: "border-transparent bg-transparent text-inksoft hover:border-rule/50 hover:text-ink",
      },
      size: {
        default: "h-11 px-6",
        sm: "h-9 px-4 text-[10px]",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

const Button = forwardRef(({ className, variant, size, as: Comp = "button", ...props }, ref) => <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />);
Button.displayName = "Button";

export { Button, buttonVariants };
