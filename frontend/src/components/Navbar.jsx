// frontend/src/components/Navbar.jsx
import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Anchor, Menu, X, Radio, WifiOff, LogOut, ShieldCheck, ShieldAlert, GitCompare, Waypoints, History, Info, Gauge } from "lucide-react";
import { cn } from "../lib/utils.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Button } from "./ui/button.jsx";
import api from "../api/client.js";

const HEALTH_CHECK_INTERVAL_MS = 15000;
const HEALTH_CHECK_TIMEOUT_MS = 5000;

// BUGFIX: this used to be a hardcoded "Console online" badge that never
// actually checked anything — it stayed green even with the backend fully
// stopped. Poll GET /api/health on an interval (and immediately on mount /
// when the tab regains focus) and reflect the real result instead.
function useBackendStatus() {
  const [status, setStatus] = useState("checking"); // "checking" | "online" | "offline"
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        await api.get("/health", { timeout: HEALTH_CHECK_TIMEOUT_MS });
        if (!cancelled) setStatus("online");
      } catch {
        if (!cancelled) setStatus("offline");
      } finally {
        inFlight.current = false;
      }
    }

    check();
    const intervalId = setInterval(check, HEALTH_CHECK_INTERVAL_MS);

    function onVisibilityChange() {
      if (document.visibilityState === "visible") check();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return status;
}

function BackendStatusBadge() {
  const status = useBackendStatus();
  const isOnline = status === "online";
  const isOffline = status === "offline";

  return (
    <div
      className={cn(
        "hidden items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[0.62rem] uppercase tracking-widest lg:flex",
        isOnline && "border-starboard/20 bg-starboard/5 text-starboard",
        isOffline && "border-port/30 bg-port/10 text-port",
        status === "checking" && "border-hull-600 bg-hull-800/60 text-slate-500"
      )}
      title={isOffline ? "Can't reach the FreightSight backend right now." : undefined}
    >
      {isOffline ? (
        <WifiOff className="h-3 w-3" strokeWidth={2.5} />
      ) : (
        <Radio className={cn("h-3 w-3", isOnline && "animate-pulse")} strokeWidth={2.5} />
      )}
      {isOnline ? "Console online" : isOffline ? "Console offline" : "Checking…"}
    </div>
  );
}

function useNavLinks() {
  const primary = [
    { to: "/", label: "Home", end: true },
    { to: "/predict", label: "Predict", icon: Gauge },
    { to: "/coa-optimizer", label: "COA Optimizer" },
    { to: "/compare", label: "Compare", icon: GitCompare },
  ];

  const more = [
    { to: "/idle-vessel", label: "Idle Vessel", icon: Waypoints },
    { to: "/history", label: "History", icon: History },
  ];
  more.push({ to: "/about", label: "About", icon: Info });
  return { primary, more };
}

export default function Navbar() {
  const [open, setOpen] = useState(false);
  const { user, isAuthenticated, isVerified, logout } = useAuth();
  const navigate = useNavigate();
  const { primary: PRIMARY_LINKS, more: MORE_LINKS } = useNavLinks();
  const NAV_LINKS = [...PRIMARY_LINKS, ...MORE_LINKS];

  function handleLogout() {
    logout();
    setOpen(false);
    navigate("/");
  }

  return (
    <header className="sticky top-0 z-50 border-b border-hull-600/60 bg-[#050810]/80 backdrop-blur-2xl shadow-[0_12px_40px_-28px_rgba(0,0,0,.95)]">
      <div className="mx-auto flex h-[4.35rem] max-w-7xl items-center justify-between px-5 sm:px-7 lg:px-9">
        <NavLink to="/" className="group flex items-center gap-2.5 shrink-0" onClick={() => setOpen(false)}>
          <span className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-signal/25 bg-gradient-to-br from-signal/15 to-transparent text-signal shadow-[0_0_28px_rgba(34,211,196,.10)] transition-all duration-300 group-hover:-rotate-6 group-hover:border-signal/50">
            <Anchor className="h-4 w-4" strokeWidth={2.25} />
          </span>
          <span className="font-display text-[1.02rem] font-semibold tracking-tight text-paper-50">
            FreightSight<span className="text-signal">AI</span>
          </span>
        </NavLink>

        <nav className="hidden items-center gap-1 rounded-full border border-hull-600/50 bg-hull-900/45 p-1 xl:flex">
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                cn(
                  "relative flex items-center gap-1.5 rounded-full px-2.5 py-2 text-[12.5px] font-medium text-slate-400 transition-colors duration-150 hover:text-paper-50",
                  isActive && "text-hull-950"
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.span
                      layoutId="nav-active-pill"
                      className="absolute inset-0 -z-10 rounded-full bg-signal shadow-glow"
                      transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    />
                  )}
                  {link.icon && <link.icon className="h-3.5 w-3.5" strokeWidth={2.25} />}
                  {link.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <div className="hidden xl:block">
          </div>

          <BackendStatusBadge />

          {isAuthenticated ? (
            <div className="hidden items-center gap-2 xl:flex">
              <div
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[0.68rem] uppercase tracking-widest",
                  isVerified
                    ? "border-starboard/30 bg-starboard/10 text-starboard"
                    : "border-amber/30 bg-amber/10 text-amber"
                )}
                title={user?.email}
              >
                {isVerified ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
                {user?.name?.split(" ")[0] || "Account"}
              </div>
              <Button variant="ghost" size="icon" onClick={handleLogout} aria-label={"Log out"}>
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="hidden items-center gap-2 xl:flex">
              <NavLink
                to="/login"
                className="rounded-full px-4 py-2 text-sm font-medium text-slate-400 transition-colors hover:text-paper-50"
              >
                {"Log in"}
              </NavLink>
              <NavLink to="/signup">
                <Button size="sm">{"Sign up"}</Button>
              </NavLink>
            </div>
          )}

          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-hull-600 text-slate-300 xl:hidden"
            onClick={() => setOpen((o) => !o)}
            aria-label="Toggle navigation menu"
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {open && (
        <nav className="flex flex-col gap-1 border-t border-hull-700/70 bg-hull-900/95 px-5 py-3 xl:hidden">
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-400",
                  isActive && "bg-signal/10 text-signal"
                )
              }
            >
              {link.icon && <link.icon className="h-4 w-4" strokeWidth={2.25} />}
              {link.label}
            </NavLink>
          ))}

          <div className="mt-2 flex flex-col gap-2 border-t border-hull-700/70 pt-3">
            {isAuthenticated ? (
              <>
                <div
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg border px-3 py-2 font-mono text-xs uppercase tracking-widest",
                    isVerified
                      ? "border-starboard/30 bg-starboard/10 text-starboard"
                      : "border-amber/30 bg-amber/10 text-amber"
                  )}
                >
                  {isVerified ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
                  {user?.email}
                </div>
                <Button variant="outline" size="sm" onClick={handleLogout} className="justify-center">
                  <LogOut className="h-3.5 w-3.5" /> {"Log out"}
                </Button>
              </>
            ) : (
              <>
                <NavLink to="/login" onClick={() => setOpen(false)}>
                  <Button variant="outline" size="sm" className="w-full justify-center">
                    {"Log in"}
                  </Button>
                </NavLink>
                <NavLink to="/signup" onClick={() => setOpen(false)}>
                  <Button size="sm" className="w-full justify-center">
                    {"Sign up"}
                  </Button>
                </NavLink>
              </>
            )}
          </div>
        </nav>
      )}
    </header>
  );
}
