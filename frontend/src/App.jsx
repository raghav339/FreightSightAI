import { useEffect } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import Navbar from "./components/Navbar.jsx";
import StatusBanners from "./components/StatusBanners.jsx";
import Landing from "./pages/Landing.jsx";
import Predict from "./pages/Predict.jsx";
import COAOptimizer from "./pages/COAOptimizer.jsx";
import CompareOrigins from "./pages/CompareOrigins.jsx";
import IdleVesselFinder from "./pages/IdleVesselFinder.jsx";
import LiveFleetMap from "./pages/LiveFleetMap.jsx";
import PortRadar from "./pages/PortRadar.jsx";
import History from "./pages/History.jsx";
import About from "./pages/About.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";

function PageShell({ children }) {
  return <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }}>{children}</motion.div>;
}

export default function App() {
  const location = useLocation();
  useEffect(() => { window.scrollTo({ top: 0, behavior: "auto" }); }, [location.pathname]);

  return (
    <div className="paper-grain relative min-h-screen overflow-x-clip bg-paper text-ink">
      <div className="chart-grid-fine pointer-events-none fixed inset-0 z-0 opacity-70" aria-hidden="true" />
      <div className="relative z-10 flex min-h-screen flex-col">
        <Navbar />
        <StatusBanners />
        <main className="flex-1">
          <AnimatePresence mode="wait">
            <Routes location={location} key={location.pathname}>
              <Route path="/" element={<PageShell><Landing /></PageShell>} />
              <Route path="/predict" element={<PageShell><Predict /></PageShell>} />
              <Route path="/coa-optimizer" element={<PageShell><COAOptimizer /></PageShell>} />
              <Route path="/compare" element={<PageShell><CompareOrigins /></PageShell>} />
              <Route path="/idle-vessel" element={<PageShell><IdleVesselFinder /></PageShell>} />
              <Route path="/live-fleet" element={<PageShell><LiveFleetMap /></PageShell>} />
              <Route path="/port-radar" element={<PageShell><PortRadar /></PageShell>} />
              <Route path="/history" element={<PageShell><History /></PageShell>} />
              <Route path="/about" element={<PageShell><About /></PageShell>} />
              <Route path="/login" element={<PageShell><Login /></PageShell>} />
              <Route path="/signup" element={<PageShell><Signup /></PageShell>} />
            </Routes>
          </AnimatePresence>
        </main>
        <footer className="border-t border-rule/70 bg-parchment">
          <div className="mx-auto flex max-w-[1240px] flex-col gap-2 px-5 py-5 sm:flex-row sm:items-center sm:justify-between lg:px-8">
            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-rule">FreightSight AI · SIH26006 · bulk cargo chartering console</span>
            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-rule">plate series 2026 · paper stock A3</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
