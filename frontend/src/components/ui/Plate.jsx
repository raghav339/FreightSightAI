import { cn } from "../../lib/utils.js";

export default function Plate({ children, label, aside, className = "", bodyClassName = "", corners = true }) {
  return (
    <section className={cn("relative border border-rule/70 bg-parchment", className)}>
      {corners && <>
        <span className="pointer-events-none absolute -left-px -top-px h-3 w-3 border-l border-t border-ink/60" />
        <span className="pointer-events-none absolute -right-px -top-px h-3 w-3 border-r border-t border-ink/60" />
        <span className="pointer-events-none absolute -bottom-px -left-px h-3 w-3 border-b border-l border-ink/60" />
        <span className="pointer-events-none absolute -bottom-px -right-px h-3 w-3 border-b border-r border-ink/60" />
      </>}
      {(label || aside) && (
        <header className="flex items-center justify-between gap-4 border-b border-rule/60 px-4 py-2 sm:px-5">
          <span className="font-mono text-[10px] uppercase tracking-[0.19em] text-inksoft">{label}</span>
          {aside}
        </header>
      )}
      <div className={cn("px-4 py-4 sm:px-5 sm:py-5", bodyClassName)}>{children}</div>
    </section>
  );
}
