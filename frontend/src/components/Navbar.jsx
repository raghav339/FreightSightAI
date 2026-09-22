import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Menu, X, LogOut, ShieldCheck, ShieldAlert, Radio, WifiOff } from "lucide-react";
import { cn } from "../lib/utils.js";
import { useAuth } from "../context/AuthContext.jsx";
import api from "../api/client.js";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "./LanguageSwitcher.jsx";

function useBackendStatus() {
  const [status, setStatus] = useState("checking");
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        await api.get("/health", { timeout: 5000 });
        if (!cancelled) setStatus("online");
      } catch {
        if (!cancelled) setStatus("offline");
      } finally {
        inFlight.current = false;
      }
    }
    check();
    const id = setInterval(check, 15000);
    const onVisibility = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return status;
}

function CompassMark() {
  return (
    <svg viewBox="0 0 40 40" className="h-8 w-8 shrink-0" aria-hidden="true">
      <circle cx="20" cy="20" r="18.5" fill="none" stroke="currentColor" strokeWidth="1" />
      <circle cx="20" cy="20" r="13" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="1 3" />
      <path d="M20 3.5v33M3.5 20h33" stroke="currentColor" strokeWidth="0.5" />
      <path d="M20 6 24 20 20 34 16 20Z" fill="currentColor" opacity="0.9" />
      <path d="M20 6 24 20 20 20Z" fill="rgb(var(--c-vermilion))" />
    </svg>
  );
}

const links = [
  { to: "/", labelKey: "nav.home", end: true },
  { to: "/predict", labelKey: "nav.predict" },
  { to: "/coa-optimizer", labelKey: "nav.coa" },
  { to: "/compare", labelKey: "nav.compare" },
  { to: "/idle-vessel", labelKey: "nav.idle" },
  { to: "/live-fleet", labelKey: "nav.liveFleet" },
  { to: "/port-radar", labelKey: "nav.portRadar" },
  { to: "/history", labelKey: "nav.history" },
  { to: "/about", labelKey: "nav.about" },
];

export default function Navbar() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { user, isAuthenticated, isVerified, logout } = useAuth();
  const navigate = useNavigate();
  const status = useBackendStatus();

  function handleLogout() {
    logout();
    setOpen(false);
    navigate("/");
  }

  return (
    <header className="sticky top-0 z-50 border-b border-rule/70 bg-paper/95 backdrop-blur-[3px]">
      <div className="mx-auto flex min-h-[4.45rem] max-w-[1240px] items-center gap-5 px-5 lg:px-8">
        <NavLink to="/" onClick={() => setOpen(false)} className="flex shrink-0 items-center gap-2.5 text-ink">
          <CompassMark />
          <span className="flex flex-col leading-none">
            <span className="font-display text-[19px] font-semibold tracking-tight">FreightSight</span>
            <span className="mt-1 font-mono text-[8px] uppercase tracking-[0.26em] text-inksoft">{t("nav.brandSub")}</span>
          </span>
        </NavLink>

        <nav aria-label={t("nav.mainAria")} className="ml-auto hidden items-center lg:flex">
          {links.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "relative whitespace-nowrap px-3 py-2 font-mono text-[11px] uppercase tracking-[0.17em] transition-colors",
                  isActive ? "text-ink" : "text-inksoft hover:text-ink",
                )
              }
            >
              {({ isActive }) => (
                <>
                  {t(item.labelKey)}
                  <span className={cn("absolute inset-x-2 -bottom-[19px] h-px origin-left bg-vermilion transition-transform duration-200", isActive ? "scale-x-100" : "scale-x-0")} />
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 lg:ml-2">
          <LanguageSwitcher />
          <span className={cn("hidden items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.18em] sm:inline-flex", status === "online" ? "border-kelp/50 text-kelp" : status === "offline" ? "border-vermilion/50 text-vermilion" : "border-rule/60 text-rule")} title={status === "offline" ? t("nav.backendUnreachable") : undefined}>
            {status === "offline" ? <WifiOff className="h-3 w-3" /> : <Radio className={cn("h-3 w-3", status === "online" && "animate-pulse")} />}
            {status === "online" ? t("nav.consoleOnline") : status === "offline" ? t("nav.consoleOffline") : t("nav.checking")}
          </span>

          {isAuthenticated ? (
            <div className="hidden items-center gap-2 lg:flex">
              <span className={cn("flex items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.16em]", isVerified ? "border-kelp/50 text-kelp" : "border-brass/50 text-brass")} title={user?.email || undefined}>
                {isVerified ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
                {user?.name?.split(" ")[0] || t("nav.account")}
              </span>
              <button className="p-2 text-inksoft transition-colors hover:text-ink" aria-label={t("nav.signOut")} onClick={handleLogout}>
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="hidden items-center gap-2 lg:flex">
              <NavLink to="/login" className="px-2 py-2 font-mono text-[10px] uppercase tracking-[0.17em] text-inksoft hover:text-ink">{t("nav.login")}</NavLink>
              <NavLink to="/signup" className="border border-ink bg-ink px-3 py-2 font-mono text-[10px] uppercase tracking-[0.17em] text-paper hover:border-vermilion hover:bg-vermilion">{t("nav.signup")}</NavLink>
            </div>
          )}

          <button className="p-2 text-ink lg:hidden" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={t("nav.toggle")}>
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {open && (
        <nav aria-label={t("nav.mobileAria")} className="border-t border-rule/60 bg-parchment lg:hidden">
          {links.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setOpen(false)} className={({ isActive }) => cn("flex items-center justify-between border-b border-rule/40 px-5 py-3 font-mono text-[11px] uppercase tracking-[0.18em]", isActive ? "text-vermilion" : "text-inksoft") }>
              {t(item.labelKey)}
              <span className="text-rule">—</span>
            </NavLink>
          ))}
          <div className="flex items-center gap-3 px-5 py-4">
            {isAuthenticated ? (
              <button onClick={handleLogout} className="font-mono text-[10px] uppercase tracking-[0.18em] text-inksoft">{t("nav.signOut")}</button>
            ) : (
              <>
                <NavLink to="/login" onClick={() => setOpen(false)} className="font-mono text-[10px] uppercase tracking-[0.18em] text-inksoft">{t("nav.login")}</NavLink>
                <NavLink to="/signup" onClick={() => setOpen(false)} className="border border-ink bg-ink px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-paper">{t("nav.signup")}</NavLink>
              </>
            )}
          </div>
        </nav>
      )}
    </header>
  );
}
