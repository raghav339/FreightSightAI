// frontend/src/App.jsx
import { useEffect } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import Navbar from "./components/Navbar.jsx";
import WakingBanner from "./components/WakingBanner.jsx";
import Landing from "./pages/Landing.jsx";
import Predict from "./pages/Predict.jsx";
import COAOptimizer from "./pages/COAOptimizer.jsx";
import CompareOrigins from "./pages/CompareOrigins.jsx";
import IdleVesselFinder from "./pages/IdleVesselFinder.jsx";
import History from "./pages/History.jsx";
import About from "./pages/About.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";

function PageShell({ children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

export default function App() {
  const location = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }, [location.pathname]);

  return (
    <div className="relative min-h-screen overflow-x-clip bg-transparent">
      {/* FreightSight atmosphere: restrained grid + navigation-light glows */}
      <div className="pointer-events-none fixed inset-0 -z-10 bg-grid opacity-[0.16] mask-fade-b" />
      <div className="pointer-events-none fixed -top-48 left-[18%] -z-10 h-[560px] w-[560px] rounded-full bg-signal/8 blur-[150px]" />
      <div className="pointer-events-none fixed top-[35%] -right-48 -z-10 h-[520px] w-[520px] rounded-full bg-amber/5 blur-[150px]" />

      <Navbar />
      <WakingBanner />

      <main className="relative mx-auto w-full max-w-7xl px-5 pb-24 pt-8 sm:px-7 lg:px-9">
        <AnimatePresence mode="wait">
          <Routes location={location} key={location.pathname}>
            <Route path="/" element={<PageShell><Landing /></PageShell>} />
            <Route path="/predict" element={<PageShell><Predict /></PageShell>} />
            <Route path="/coa-optimizer" element={<PageShell><COAOptimizer /></PageShell>} />
            <Route path="/compare" element={<PageShell><CompareOrigins /></PageShell>} />
            <Route path="/idle-vessel" element={<PageShell><IdleVesselFinder /></PageShell>} />
            <Route path="/history" element={<PageShell><History /></PageShell>} />
            <Route path="/about" element={<PageShell><About /></PageShell>} />
            <Route path="/login" element={<PageShell><Login /></PageShell>} />
            <Route path="/signup" element={<PageShell><Signup /></PageShell>} />
          </Routes>
        </AnimatePresence>
      </main>

      <footer className="relative border-t border-hull-700/70 py-8 text-center font-mono text-[0.72rem] uppercase tracking-[0.2em] text-slate-600">
        FreightSight AI · SIH26006 · Bulk Cargo Chartering Console
      </footer>
    </div>
  );
}
