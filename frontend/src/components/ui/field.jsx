import { cn } from "../../lib/utils.js";

const controlClass = "w-full rounded-none border-0 border-b border-ink/30 bg-transparent px-0 py-2 font-mono text-[13px] text-ink placeholder:text-rule outline-none transition-colors focus:border-vermilion";

export function Field({ label, hint, error, children }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline gap-1.5 font-mono text-[9px] uppercase tracking-[0.19em] text-inksoft">
        {label}
        {hint && <span className="normal-case tracking-normal text-rule">{hint}</span>}
      </span>
      {children}
      {error && <span className="font-mono text-[10px] text-vermilion">{error}</span>}
    </label>
  );
}

export function Input({ className, ...props }) {
  return <input className={cn(controlClass, className)} {...props} />;
}

export function Select({ className, children, ...props }) {
  return <select className={cn(controlClass, "cursor-pointer appearance-none pr-6", className)} {...props}>{children}</select>;
}
