import { Children, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
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

// Themed dropdown with the same API as a native <select> (value / onChange
// with e.target.value / required / disabled + <option> children).
//
// A native <select> popup is drawn by the OS/browser, so its background,
// width and hover colour can't be reliably themed — it comes out white and
// can be a different width from the field. This renders the list itself, at
// exactly the field's width and in the paper palette. A visually hidden
// native <select> is kept in sync purely so `required` validation and form
// semantics keep working.
export function Select({ className, children, value, defaultValue, onChange, required, disabled, name, id, ...rest }) {
  const autoId = useId();
  const listId = `${autoId}-list`;
  const wrapRef = useRef(null);
  const listRef = useRef(null);
  const [inner, setInner] = useState(defaultValue ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const options = useMemo(
    () =>
      Children.toArray(children)
        .filter((c) => c && c.props)
        .map((c) => ({
          value: String(c.props.value ?? c.props.children ?? ""),
          label: c.props.children,
          disabled: !!c.props.disabled,
        })),
    [children]
  );

  const current = String(value !== undefined ? value : inner);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === current));
  const selected = options.find((o) => o.value === current) || options[0];
  const isPlaceholder = !selected || selected.value === "";

  function commit(index) {
    const opt = options[index];
    if (!opt || opt.disabled) return;
    if (value === undefined) setInner(opt.value);
    onChange?.({ target: { value: opt.value, name }, currentTarget: { value: opt.value, name } });
    setOpen(false);
  }

  function openList() {
    if (disabled) return;
    setActive(selectedIndex);
    setOpen(true);
  }

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted option scrolled into view.
  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function onKeyDown(e) {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    const step = (dir) => {
      let i = active;
      for (let n = 0; n < options.length; n++) {
        i = (i + dir + options.length) % options.length;
        if (!options[i].disabled) break;
      }
      setActive(i);
    };
    if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); commit(active); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    else if (e.key === "Tab") setOpen(false);
    else if (e.key.length === 1) {
      // Type-ahead: jump to the next option starting with the typed letter.
      const ch = e.key.toLowerCase();
      const from = active + 1;
      const order = [...options.keys()].map((_, n) => (from + n) % options.length);
      const hit = order.find((i) => !options[i].disabled && String(options[i].label).toLowerCase().startsWith(ch));
      if (hit !== undefined) setActive(hit);
    }
  }

  return (
    <div ref={wrapRef} className="relative w-full">
      <button
        type="button"
        id={id}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={cn(
          controlClass,
          "fs-select__button flex h-9 cursor-pointer items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50",
          open && "border-vermilion",
          className
        )}
        {...rest}
      >
        <span className={cn("min-w-0 flex-1 truncate", isPlaceholder && "text-rule")}>{selected?.label ?? ""}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-rule transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto border border-rule/60 bg-paper py-1 font-mono text-[13px] text-ink shadow-[0_10px_24px_-12px_rgb(var(--c-ink)_/_0.35)]"
          // Options live inside the field's <label>; stop the label from
          // re-firing a click on the trigger button (which would reopen it).
          onClick={(e) => e.preventDefault()}
        >
          {options.map((o, i) => (
            <li
              key={`${o.value}-${i}`}
              role="option"
              aria-selected={o.value === current}
              aria-disabled={o.disabled || undefined}
              onMouseEnter={() => !o.disabled && setActive(i)}
              onClick={() => commit(i)}
              className={cn(
                "flex cursor-pointer items-start justify-between gap-2 px-3 py-2 transition-colors",
                i === active && "bg-parchment",
                o.value === current && o.value !== "" && "text-vermilion",
                o.value === "" && "text-rule",
                o.disabled && "cursor-not-allowed opacity-45"
              )}
            >
              <span className="whitespace-normal leading-snug">{o.label}</span>
              {o.value === current && o.value !== "" && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}

      {/* Hidden native control: keeps `required` validation + form semantics. */}
      <select
        aria-hidden="true"
        tabIndex={-1}
        required={required}
        name={name}
        value={current}
        onChange={() => {}}
        disabled={disabled}
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px w-full opacity-0"
      >
        {options.map((o, i) => <option key={`${o.value}-${i}`} value={o.value}>{String(o.label)}</option>)}
      </select>
    </div>
  );
}