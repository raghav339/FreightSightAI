// frontend/src/components/ui/field.jsx
import { cn } from "../../lib/utils.js";

const controlClass =
  "w-full rounded-lg border border-hull-500 bg-hull-900/60 px-3.5 py-2.5 text-sm text-paper-50 placeholder:text-slate-500 transition-colors focus:outline-none focus:border-signal/60 focus:ring-2 focus:ring-signal/20";

export function Field({ label, hint, error, children }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline gap-1.5 text-xs font-medium text-slate-400">
        {label}
        {hint && <span className="text-[0.7rem] font-normal text-slate-600">{hint}</span>}
      </span>
      {children}
      {error && <span className="text-xs font-medium text-port">{error}</span>}
    </label>
  );
}

export function Input({ className, ...props }) {
  return <input className={cn(controlClass, className)} {...props} />;
}

export function Select({ className, children, ...props }) {
  return (
    <select className={cn(controlClass, "cursor-pointer appearance-none bg-no-repeat pr-9", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%2322D3C4'%3E%3Cpath fill-rule='evenodd' d='M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z' clip-rule='evenodd'/%3E%3C/svg%3E\")",
        backgroundPosition: "right 0.75rem center",
        backgroundSize: "1.1em",
      }}
      {...props}
    >
      {children}
    </select>
  );
}